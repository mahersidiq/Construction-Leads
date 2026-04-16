"""
Download and filter HCAD bulk property data for commercial leads.

Downloads real_acct and owner files from HCAD, filters for commercial
properties (state class F1) with hotel/hospitality keywords, built 1970-2010,
joins owner info, and flags out-of-state owners.
"""

import io
import os
import re
import zipfile

import pandas as pd
import requests

HCAD_BASE_URL = "https://pdata.hcad.org/download"
REAL_ACCT_FILE = "Real_acct_owner/real_acct.txt"
OWNER_FILE = "Real_acct_owner/owner.txt"

# Try multiple years in case the latest isn't available yet
YEARS_TO_TRY = ["2025", "2024", "2023"]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://hcad.org/pdata/pdata-property-downloads.html",
}

# Commercial state class code
COMMERCIAL_CODES = {"F1"}

# Hotel/hospitality keywords for sub-filtering within F1
HOTEL_KEYWORDS = [
    "HOTEL", "MOTEL", "INN", "LODGE", "SUITES", "EXTENDED STAY", "HOSPITALITY",
]

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "hcad_commercial_filtered.csv")


def download_and_extract(base_name: str, target_filename: str) -> pd.DataFrame:
    """Download a zip file from HCAD and extract a specific tab-delimited file."""
    resp = None
    for year in YEARS_TO_TRY:
        url = f"{HCAD_BASE_URL}/{year}/{base_name}"
        print(f"Trying {url} ...")
        try:
            resp = requests.get(url, headers=HEADERS, timeout=300)
            if resp.status_code == 200 and len(resp.content) > 1000:
                print(f"  Success ({len(resp.content)} bytes)")
                break
            print(f"  Got status {resp.status_code} or too small, trying next year...")
            resp = None
        except requests.RequestException as e:
            print(f"  Failed: {e}")
            resp = None

    if resp is None:
        raise RuntimeError(
            f"Could not download {base_name} from any year. "
            "HCAD may be blocking automated downloads. "
            "Download manually from https://hcad.org/pdata/pdata-property-downloads.html "
            "and place the extracted files in the scripts/ directory."
        )

    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        names = zf.namelist()
        match = [n for n in names if n.endswith(target_filename) or n == target_filename]
        if not match:
            # Try matching just the basename
            basename = os.path.basename(target_filename)
            match = [n for n in names if os.path.basename(n) == basename]
        if not match:
            raise FileNotFoundError(
                f"{target_filename} not found in zip. Available: {names}"
            )
        with zf.open(match[0]) as f:
            df = pd.read_csv(f, sep="\t", dtype=str, low_memory=False)
    return df


def load_real_acct() -> pd.DataFrame:
    """Download and parse the real_acct file."""
    df = download_and_extract("Real_acct_owner.zip", "real_acct.txt")
    df.columns = df.columns.str.strip().str.lower()
    return df


def load_owner() -> pd.DataFrame:
    """Download and parse the owner file."""
    df = download_and_extract("Real_acct_owner.zip", "owner.txt")
    df.columns = df.columns.str.strip().str.lower()
    return df


def extract_state_from_address(address: str) -> str:
    """Extract state abbreviation from a mailing address string."""
    if not isinstance(address, str):
        return ""
    match = re.search(r"\b([A-Z]{2})\s+\d{5}", address.upper())
    if match:
        return match.group(1)
    parts = address.strip().split()
    for part in reversed(parts):
        cleaned = re.sub(r"[^A-Za-z]", "", part)
        if len(cleaned) == 2:
            return cleaned.upper()
    return ""


def matches_hotel_keywords(text: str) -> bool:
    """Check if text contains any hotel/hospitality keyword (case-insensitive)."""
    if not isinstance(text, str):
        return False
    upper = text.upper()
    return any(kw in upper for kw in HOTEL_KEYWORDS)


def main():
    print("=== HCAD Commercial Data Download and Filter ===")

    # Load data files
    real_acct = load_real_acct()
    owner = load_owner()

    print(f"Real acct records: {len(real_acct)}")
    print(f"Owner records: {len(owner)}")

    # Identify the account number column
    acct_col = None
    for candidate in ["acct", "account", "acct_number", "account_number"]:
        if candidate in real_acct.columns:
            acct_col = candidate
            break
    if acct_col is None:
        acct_col = real_acct.columns[0]
    print(f"Using account column: {acct_col}")

    # Identify state class code column
    class_col = None
    for candidate in ["state_class", "state_cd", "class_cd", "impr_state_cd"]:
        if candidate in real_acct.columns:
            class_col = candidate
            break

    # Filter F1 commercial properties
    if class_col:
        real_acct["_class_upper"] = real_acct[class_col].astype(str).str.strip().str.upper()
        filtered = real_acct[real_acct["_class_upper"].isin(COMMERCIAL_CODES)].copy()
        filtered.drop(columns=["_class_upper"], inplace=True)
        print(f"F1 commercial properties (state class filter): {len(filtered)}")
    else:
        print("WARNING: Could not find state class column. Using all records.")
        filtered = real_acct.copy()

    # Sub-filter: look for hotel/hospitality keywords in description/name columns
    desc_candidates = [
        "description", "desc", "property_description", "impr_desc",
        "bld_name", "building_name", "name", "acct_name",
    ]
    desc_cols = [c for c in desc_candidates if c in filtered.columns]

    if desc_cols:
        mask = pd.Series(False, index=filtered.index)
        for col in desc_cols:
            mask = mask | filtered[col].apply(matches_hotel_keywords)
        filtered = filtered[mask].copy()
        print(f"After hotel/hospitality keyword filter: {len(filtered)}")
    else:
        print("WARNING: No description/name columns found for keyword filtering.")

    # Filter by year built (1970-2010)
    yr_col = None
    for candidate in ["yr_built", "year_built", "yr_impr"]:
        if candidate in filtered.columns:
            yr_col = candidate
            break

    if yr_col:
        filtered[yr_col] = pd.to_numeric(filtered[yr_col], errors="coerce")
        filtered = filtered[(filtered[yr_col] >= 1970) & (filtered[yr_col] <= 2010)]
        print(f"After year_built filter (1970-2010): {len(filtered)}")
    else:
        print("WARNING: Could not find year_built column.")

    # Join with owner file
    owner_acct_col = None
    for candidate in ["acct", "account", "acct_number", "account_number"]:
        if candidate in owner.columns:
            owner_acct_col = candidate
            break
    if owner_acct_col is None:
        owner_acct_col = owner.columns[0]

    # Identify owner name and mailing address columns
    name_col = None
    for candidate in ["owner_name", "name", "owner"]:
        if candidate in owner.columns:
            name_col = candidate
            break

    mail_col = None
    for candidate in ["mail_addr", "mailing_address", "mail_address", "tnt_mail_adr"]:
        if candidate in owner.columns:
            mail_col = candidate
            break

    # Build owner subset for merge
    owner_cols = [owner_acct_col]
    if name_col:
        owner_cols.append(name_col)
    if mail_col:
        owner_cols.append(mail_col)

    # Also check for separate state column in owner data
    mail_state_col = None
    for candidate in ["mail_state", "state", "mail_st"]:
        if candidate in owner.columns:
            mail_state_col = candidate
            break
    if mail_state_col:
        owner_cols.append(mail_state_col)

    owner_sub = owner[owner_cols].drop_duplicates(subset=[owner_acct_col])
    if owner_acct_col != acct_col:
        owner_sub = owner_sub.rename(columns={owner_acct_col: acct_col})

    merged = filtered.merge(owner_sub, on=acct_col, how="left")
    print(f"After owner join: {len(merged)}")

    # Flag out-of-state owners
    if mail_state_col and mail_state_col in merged.columns:
        merged["out_of_state_owner"] = (
            merged[mail_state_col].astype(str).str.strip().str.upper() != "TX"
        )
    elif mail_col and mail_col in merged.columns:
        merged["_state"] = merged[mail_col].apply(extract_state_from_address)
        merged["out_of_state_owner"] = (merged["_state"] != "") & (merged["_state"] != "TX")
        merged.drop(columns=["_state"], inplace=True)
    else:
        merged["out_of_state_owner"] = False

    # Identify address column
    addr_col = None
    for candidate in ["site_addr", "property_address", "address", "situs"]:
        if candidate in merged.columns:
            addr_col = candidate
            break

    # Identify appraised value column
    val_col = None
    for candidate in ["tot_appr_val", "appraised_value", "total_appraised_value", "appr_val"]:
        if candidate in merged.columns:
            val_col = candidate
            break

    # Determine property_type based on description columns
    def classify_property_type(row):
        for col in desc_cols:
            if col in row.index and matches_hotel_keywords(str(row[col])):
                return "hotel"
        return "commercial"

    # Build output DataFrame
    output = pd.DataFrame()
    output["acct_number"] = merged[acct_col].astype(str).str.strip()
    output["property_address"] = merged[addr_col].astype(str).str.strip() if addr_col else ""
    output["owner_name"] = merged[name_col].astype(str).str.strip() if name_col else ""
    output["owner_mail_address"] = merged[mail_col].astype(str).str.strip() if mail_col else ""
    output["year_built"] = pd.to_numeric(merged.get(yr_col, pd.Series(dtype="float")), errors="coerce")
    if val_col:
        output["appraised_value"] = pd.to_numeric(merged[val_col], errors="coerce")
    else:
        output["appraised_value"] = None
    output["out_of_state_owner"] = merged["out_of_state_owner"]

    # Classify property type
    if desc_cols:
        output["property_type"] = merged.apply(classify_property_type, axis=1)
    else:
        output["property_type"] = "commercial"

    output.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(output)} filtered commercial records to {OUTPUT_PATH}")
    print(f"Out-of-state owners: {output['out_of_state_owner'].sum()}")
    print(f"Hotels: {(output['property_type'] == 'hotel').sum()}")
    print(f"Other commercial: {(output['property_type'] == 'commercial').sum()}")


if __name__ == "__main__":
    main()
