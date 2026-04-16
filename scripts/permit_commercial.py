"""
Pull permit data from the City of Houston Open Data portal and match to
commercial leads in Supabase.

Pipeline:
  1. Query the Houston CKAN DataStore API for sold permit records.
  2. Filter for commercial-relevant permit types: tenant improvement, TI,
     change of occupancy, change of use, certificate of occupancy,
     code violation, failed inspection, stop work order.
  3. Normalize addresses and match to commercial_leads table.
  4. Update permit_flag, permit_type, permit_status, and permit_date
     for matching commercial leads.
"""

import os
import re
from datetime import date, timedelta

import pandas as pd
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CKAN_DATASTORE_URL = "https://data.houstontx.gov/api/3/action/datastore_search"
PERMIT_RESOURCE_ID = "80b03984-0e31-41ff-937b-35b686755bf9"
CKAN_PAGE_SIZE = 32000

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "permits_commercial.csv")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# Only keep permits issued within the last N days. Code violations and stop
# work orders are most actionable while fresh — older entries are usually
# already resolved or the property has changed hands.
RECENT_PERMIT_DAYS = 365

# Commercial permit type patterns and their category labels
COMMERCIAL_PERMIT_PATTERNS = [
    (r"TENANT\s*IMPROVEMENT", "Tenant Improvement"),
    (r"\bTI\b", "Tenant Improvement"),
    (r"CHANGE\s*OF\s*OCCUPANCY", "Change of Occupancy"),
    (r"CHANGE\s*OF\s*USE", "Change of Use"),
    (r"CERTIFICATE\s*OF\s*OCCUPANCY", "Certificate of Occupancy"),
    (r"CODE\s*VIOLATION", "Code Violation"),
    (r"FAILED\s*INSPECTION", "Failed Inspection"),
    (r"STOP\s*WORK\s*ORDER", "Stop Work Order"),
]


# ---------------------------------------------------------------------------
# Address normalization
# ---------------------------------------------------------------------------

_STREET_ABBREVS = {
    "STREET": "ST", "AVENUE": "AVE", "BOULEVARD": "BLVD", "DRIVE": "DR",
    "LANE": "LN", "ROAD": "RD", "COURT": "CT", "CIRCLE": "CIR",
    "PLACE": "PL", "TRAIL": "TRL", "PARKWAY": "PKWY", "WAY": "WAY",
    "FREEWAY": "FWY", "HIGHWAY": "HWY",
}

_CITIES = [
    "HOUSTON", "BELLAIRE", "PASADENA", "DEER PARK", "BAYTOWN",
    "HUMBLE", "KATY", "TOMBALL", "CROSBY", "SPRING", "CYPRESS",
    "HUFFMAN", "WALLER", "HIGHLANDS",
]


def normalize_address(raw: str) -> str:
    """
    Produce a canonical street address for matching.

    - Upper-case, strip unit/suite/apt, collapse whitespace
    - Normalize common street-type words
    - Remove trailing city name and ZIP
    """
    if not raw or not isinstance(raw, str):
        return ""

    addr = raw.upper().strip()
    addr = addr.split(",")[0].strip()
    addr = re.sub(r"\b(UNIT|STE|SUITE|APT|#)\s*\S*", "", addr)
    addr = re.sub(r"\b\d{5}(-\d{4})?\s*$", "", addr)

    for city in _CITIES:
        addr = re.sub(rf"\b{city}\s*$", "", addr)

    for long, short in _STREET_ABBREVS.items():
        addr = re.sub(rf"\b{long}\b", short, addr)

    addr = re.sub(r"\s+", " ", addr).strip()
    return addr


def classify_permit(text: str) -> str | None:
    """
    Check if text matches any commercial permit pattern.
    Returns the category label or None.
    """
    if not isinstance(text, str):
        return None
    upper = text.upper()
    for pattern, label in COMMERCIAL_PERMIT_PATTERNS:
        if re.search(pattern, upper):
            return label
    return None


# ---------------------------------------------------------------------------
# CKAN DataStore API helpers
# ---------------------------------------------------------------------------

def fetch_permits() -> pd.DataFrame:
    """Fetch all permit records from the CKAN DataStore with pagination."""
    all_records: list[dict] = []
    offset = 0

    while True:
        print(f"Fetching permits (offset={offset}) ...")
        resp = requests.get(
            CKAN_DATASTORE_URL,
            params={
                "resource_id": PERMIT_RESOURCE_ID,
                "limit": CKAN_PAGE_SIZE,
                "offset": offset,
            },
            timeout=60,
        )
        resp.raise_for_status()
        result = resp.json().get("result", {})
        records = result.get("records", [])

        if not records:
            break

        all_records.extend(records)
        print(f"  Received {len(records)} records")

        if len(records) < CKAN_PAGE_SIZE:
            break
        offset += CKAN_PAGE_SIZE

    print(f"Total records fetched: {len(all_records)}")
    return pd.DataFrame(all_records)


def filter_commercial_permits(df: pd.DataFrame) -> pd.DataFrame:
    """Filter permits for commercial-relevant types and add category column."""
    if df.empty:
        return pd.DataFrame(columns=["address", "address_norm", "commercial_permit_type", "permit_date"])

    # Identify type/description columns to search
    type_candidates = [
        "Permit Type", "permit_type", "Type", "type",
        "Description", "description", "Project Description",
        "permit_description", "work_description",
    ]
    type_cols = [c for c in type_candidates if c in df.columns]

    if not type_cols:
        print(f"  WARNING: No type/description column found. Columns: {list(df.columns)}")
        return pd.DataFrame(columns=["address", "address_norm", "commercial_permit_type", "permit_date"])

    # Check each row for matching permit types
    categories = []
    for _, row in df.iterrows():
        category = None
        for col in type_cols:
            category = classify_permit(str(row.get(col, "")))
            if category:
                break
        categories.append(category)

    df = df.copy()
    df["commercial_permit_type"] = categories

    # Keep only rows that matched a commercial permit type
    filtered = df[df["commercial_permit_type"].notna()].copy()
    print(f"Commercial permits matched (any date): {len(filtered)}")

    # Date filter — keep only recent permits so we surface active opportunities
    date_candidates = [
        "Issue Date", "issue_date", "Issued Date", "issued_date",
        "permit_date", "Date Issued", "date_issued",
    ]
    date_col = next((c for c in date_candidates if c in filtered.columns), None)

    if date_col:
        filtered["_permit_dt"] = pd.to_datetime(filtered[date_col], errors="coerce")
        cutoff = pd.Timestamp(date.today() - timedelta(days=RECENT_PERMIT_DAYS))
        filtered = filtered[filtered["_permit_dt"] >= cutoff].copy()
        print(f"After recency filter (last {RECENT_PERMIT_DAYS} days): {len(filtered)}")
    else:
        print(f"  WARNING: No date column found — keeping all matched permits.")
        filtered["_permit_dt"] = pd.NaT

    # Identify address column
    addr_col = next(
        (c for c in ["Address", "address", "project_address", "street_address"]
         if c in filtered.columns),
        None,
    )

    if not addr_col:
        print(f"  WARNING: No address column found. Columns: {list(filtered.columns)}")
        return pd.DataFrame(columns=["address", "address_norm", "commercial_permit_type", "permit_date"])

    out = pd.DataFrame()
    out["address"] = filtered[addr_col].astype(str).str.strip()
    out = out[out["address"].str.len() > 0].copy()
    out["address_norm"] = out["address"].apply(normalize_address)
    out["commercial_permit_type"] = filtered.loc[out.index, "commercial_permit_type"].values
    out["permit_date"] = filtered.loc[out.index, "_permit_dt"].dt.strftime("%Y-%m-%d").values

    # Carry forward useful columns
    for col in ["Receipt No", "Project No", "Applicant\nName"]:
        if col in filtered.columns:
            out[col] = filtered.loc[out.index, col].values

    return out


# ---------------------------------------------------------------------------
# Supabase integration
# ---------------------------------------------------------------------------

def fetch_commercial_lead_addresses(client) -> pd.DataFrame:
    """Fetch all commercial lead ids and addresses from Supabase."""
    print("Fetching commercial lead addresses from Supabase ...")
    rows: list[dict] = []
    page_size = 1000
    start = 0

    while True:
        result = (
            client.table("commercial_leads")
            .select("id, property_address")
            .filter("property_address", "neq", "")
            .range(start, start + page_size - 1)
            .execute()
        )
        if not result.data:
            break
        rows.extend(result.data)
        if len(result.data) < page_size:
            break
        start += page_size

    df = pd.DataFrame(rows)
    print(f"  Loaded {len(df)} commercial leads with addresses")

    if not df.empty:
        df["address_norm"] = df["property_address"].apply(normalize_address)

    return df


def update_matching_commercial_leads(client, matches: list[dict]) -> int:
    """
    Set permit_flag = true for the given commercial lead matches.
    Each match dict has: id, commercial_permit_type, permit_date.
    Returns the number of rows updated.
    """
    if not matches:
        return 0

    batch_size = 500
    updated = 0

    for i in range(0, len(matches), batch_size):
        batch = matches[i : i + batch_size]
        for m in batch:
            client.table("commercial_leads").update({
                "permit_flag": True,
                "permit_type": m["commercial_permit_type"],
                "permit_status": m["commercial_permit_type"],
                "permit_date": m.get("permit_date") or str(date.today()),
            }).eq("id", m["id"]).execute()
            updated += 1

        print(f"  Updated batch: {updated} / {len(matches)}")

    return updated


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("City of Houston Permit Pull — Commercial Leads")
    print("=" * 60)

    # --- Step 1: Fetch permits from Houston CKAN API ---
    df_raw = fetch_permits()
    permits = filter_commercial_permits(df_raw)

    permits.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(permits)} commercial permits to {OUTPUT_PATH}")
    if not permits.empty:
        print(f"Unique normalized addresses: {permits['address_norm'].nunique()}")
        print(f"Permit type breakdown:")
        print(permits["commercial_permit_type"].value_counts().to_string())

    # --- Step 2: Match permits to Supabase commercial leads ---
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("\nSUPABASE_URL / SUPABASE_ANON_KEY not set — skipping lead matching.")
        return

    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    leads = fetch_commercial_lead_addresses(client)

    if leads.empty or permits.empty:
        print("\nNo data to match.")
        return

    # Deduplicate permit addresses — keep the most recent permit per address
    permits_sorted = permits.sort_values("permit_date", ascending=False, na_position="last")
    permit_lookup = permits_sorted.drop_duplicates(subset=["address_norm"]).set_index("address_norm")

    # Find matching leads
    matched = leads[leads["address_norm"].isin(permit_lookup.index)].copy()

    print(f"\n{'=' * 40}")
    print(f"Matched {len(matched)} commercial leads to recent permits")
    print(f"{'=' * 40}")

    if matched.empty:
        print("No matches found.")
        return

    # Build match list with permit type and date info
    match_list = []
    for _, row in matched.iterrows():
        permit_row = permit_lookup.loc[row["address_norm"]]
        if isinstance(permit_row, pd.DataFrame):
            permit_row = permit_row.iloc[0]
        match_list.append({
            "id": row["id"],
            "commercial_permit_type": permit_row["commercial_permit_type"],
            "permit_date": permit_row.get("permit_date"),
        })

    # --- Step 3: Update Supabase ---
    count = update_matching_commercial_leads(client, match_list)
    print(f"\nDone — updated {count} commercial leads with permit data.")


if __name__ == "__main__":
    main()
