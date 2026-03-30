"""
Download and filter HCAD bulk property data for multifamily leads.

Downloads real_acct and owner files from HCAD, filters for multifamily
properties built 1980-2005, joins owner info, and flags out-of-state owners.
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
BUILDING_RES_FILE = "building_res.txt"
DOWNLOAD_URL = f"{HCAD_BASE_URL}/2024/Real_acct_owner.zip"
BUILDING_RES_URL = f"{HCAD_BASE_URL}/2024/building_res.zip"

# Multifamily state class codes
MULTIFAMILY_CODES = set()
for prefix, end in [("A", 9), ("B", 4), ("F", 4)]:
    for i in range(1, end + 1):
        MULTIFAMILY_CODES.add(f"{prefix}{i}")

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "hcad_filtered.csv")


def download_and_extract(url: str, target_filename: str) -> pd.DataFrame:
    """Download a zip file from HCAD and extract a specific tab-delimited file."""
    print(f"Downloading {url} ...")
    resp = requests.get(url, timeout=300)
    resp.raise_for_status()

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
    df = download_and_extract(DOWNLOAD_URL, "real_acct.txt")
    # Normalize column names
    df.columns = df.columns.str.strip().str.lower()
    return df


def load_owner() -> pd.DataFrame:
    """Download and parse the owner file."""
    df = download_and_extract(DOWNLOAD_URL, "owner.txt")
    df.columns = df.columns.str.strip().str.lower()
    return df


def load_building_res() -> pd.DataFrame:
    """Download and parse the building_res file for unit counts."""
    df = download_and_extract(BUILDING_RES_URL, "building_res.txt")
    df.columns = df.columns.str.strip().str.lower()
    return df


def extract_state_from_address(address: str) -> str:
    """Extract state abbreviation from a mailing address string."""
    if not isinstance(address, str):
        return ""
    # Match 2-letter state code before a zip code pattern
    match = re.search(r"\b([A-Z]{2})\s+\d{5}", address.upper())
    if match:
        return match.group(1)
    # Fallback: last two-letter word that looks like a state
    parts = address.strip().split()
    for part in reversed(parts):
        cleaned = re.sub(r"[^A-Za-z]", "", part)
        if len(cleaned) == 2:
            return cleaned.upper()
    return ""


def main():
    print("=== HCAD Data Download and Filter ===")

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
        # Use the first column as account number
        acct_col = real_acct.columns[0]
    print(f"Using account column: {acct_col}")

    # Identify state class code column
    class_col = None
    for candidate in ["state_class", "state_cd", "class_cd", "impr_state_cd"]:
        if candidate in real_acct.columns:
            class_col = candidate
            break

    # Filter multifamily properties
    if class_col:
        real_acct["_class_upper"] = real_acct[class_col].astype(str).str.strip().str.upper()
        filtered = real_acct[real_acct["_class_upper"].isin(MULTIFAMILY_CODES)].copy()
        filtered.drop(columns=["_class_upper"], inplace=True)
        print(f"Multifamily properties (state class filter): {len(filtered)}")
    else:
        print("WARNING: Could not find state class column. Using all records.")
        filtered = real_acct.copy()

    # Filter by year built (1980-2005)
    yr_col = None
    for candidate in ["yr_built", "year_built", "yr_impr"]:
        if candidate in filtered.columns:
            yr_col = candidate
            break

    if yr_col:
        filtered[yr_col] = pd.to_numeric(filtered[yr_col], errors="coerce")
        filtered = filtered[(filtered[yr_col] >= 1980) & (filtered[yr_col] <= 2005)]
        print(f"After year_built filter (1980-2005): {len(filtered)}")
    else:
        print("WARNING: Could not find year_built column.")

    # Try to load building_res for unit counts
    try:
        building_res = load_building_res()
        unit_col = None
        for candidate in ["units", "unit_count", "nbr_units", "no_of_units"]:
            if candidate in building_res.columns:
                unit_col = candidate
                break

        if unit_col:
            bldg_acct_col = None
            for candidate in ["acct", "account", "acct_number", "account_number"]:
                if candidate in building_res.columns:
                    bldg_acct_col = candidate
                    break
            if bldg_acct_col is None:
                bldg_acct_col = building_res.columns[0]

            building_res[unit_col] = pd.to_numeric(building_res[unit_col], errors="coerce")
            unit_counts = (
                building_res.groupby(bldg_acct_col)[unit_col].sum().reset_index()
            )
            unit_counts.columns = [acct_col, "unit_count"]
            filtered = filtered.merge(unit_counts, on=acct_col, how="left")
        else:
            filtered["unit_count"] = None
    except Exception as e:
        print(f"WARNING: Could not load building_res for unit counts: {e}")
        filtered["unit_count"] = None

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
    output["unit_count"] = pd.to_numeric(merged.get("unit_count", pd.Series(dtype="float")), errors="coerce")
    output["out_of_state_owner"] = merged["out_of_state_owner"]

    output.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(output)} filtered records to {OUTPUT_PATH}")
    print(f"Out-of-state owners: {output['out_of_state_owner'].sum()}")


if __name__ == "__main__":
    main()
