"""
Pull permit data from the City of Houston Open Data portal and match to
Supabase leads.

Pipeline:
  1. Query the Houston CKAN DataStore API for sold permit records
     (resource 80b03984-0e31-41ff-937b-35b686755bf9, ~47K records).
  2. Normalize addresses from both permits and leads.
  3. Match permits to leads by normalized street address.
  4. Update permit_flag, permit_type, permit_status, and permit_date
     for matching leads.

Note: The old Socrata endpoint (3srv-977b) was decommissioned when
Houston migrated to CKAN.  This script uses the CKAN DataStore API.

A companion Supabase Edge Function ("permit-match") can also run
this pipeline server-side by loading permit addresses into a staging
table and matching via SQL.
"""

import os
import re
from datetime import date

import pandas as pd
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Houston CKAN DataStore API — sold permits with individual address records
CKAN_DATASTORE_URL = "https://data.houstontx.gov/api/3/action/datastore_search"
PERMIT_RESOURCE_ID = "80b03984-0e31-41ff-937b-35b686755bf9"
CKAN_PAGE_SIZE = 32000

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "permits_filtered.csv")

# Supabase credentials
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")


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


def normalize_permits(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize permit data and add canonical address column."""
    if df.empty:
        return pd.DataFrame(columns=["address", "address_norm"])

    # The CKAN resource uses "Address" as the column name
    addr_col = next(
        (c for c in ["Address", "address", "project_address", "street_address"]
         if c in df.columns),
        None,
    )

    if not addr_col:
        print(f"  WARNING: No address column found. Columns: {list(df.columns)}")
        return pd.DataFrame(columns=["address", "address_norm"])

    out = pd.DataFrame()
    out["address"] = df[addr_col].astype(str).str.strip()
    out = out[out["address"].str.len() > 0].copy()
    out["address_norm"] = out["address"].apply(normalize_address)

    # Carry forward any extra useful columns
    for col in ["Receipt No", "Project No", "Applicant\nName"]:
        if col in df.columns:
            out[col] = df.loc[out.index, col]

    return out


# ---------------------------------------------------------------------------
# Supabase integration
# ---------------------------------------------------------------------------

def fetch_lead_addresses(client) -> pd.DataFrame:
    """Fetch all lead ids and addresses from Supabase."""
    print("Fetching lead addresses from Supabase ...")
    rows: list[dict] = []
    page_size = 1000
    start = 0

    while True:
        result = (
            client.table("leads")
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
    print(f"  Loaded {len(df)} leads with addresses")

    if not df.empty:
        df["address_norm"] = df["property_address"].apply(normalize_address)

    return df


def update_matching_leads(client, lead_ids: list[str]) -> int:
    """
    Set permit_flag = true for the given lead IDs.
    Returns the number of rows updated.
    """
    if not lead_ids:
        return 0

    batch_size = 500
    updated = 0

    for i in range(0, len(lead_ids), batch_size):
        batch = lead_ids[i : i + batch_size]
        for lid in batch:
            client.table("leads").update({
                "permit_flag": True,
                "permit_type": "Construction Permit",
                "permit_status": "Active",
                "permit_date": str(date.today()),
            }).eq("id", lid).execute()
            updated += 1

        print(f"  Updated batch: {updated} / {len(lead_ids)}")

    return updated


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("City of Houston Permit Pull  +  Supabase Lead Matching")
    print("=" * 60)

    # --- Step 1: Fetch permits from Houston CKAN API ---
    df_raw = fetch_permits()
    permits = normalize_permits(df_raw)

    permits.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(permits)} permits to {OUTPUT_PATH}")
    print(f"Unique normalized addresses: {permits['address_norm'].nunique()}")

    # --- Step 2: Match permits to Supabase leads ---
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("\nSUPABASE_URL / SUPABASE_ANON_KEY not set — skipping lead matching.")
        return

    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    leads = fetch_lead_addresses(client)

    if leads.empty or permits.empty:
        print("\nNo data to match.")
        return

    # Deduplicate permit addresses
    permit_addrs = set(permits["address_norm"].unique())

    # Find matching leads
    matched = leads[leads["address_norm"].isin(permit_addrs)]

    print(f"\n{'=' * 40}")
    print(f"Matched {len(matched)} leads to permits")
    print(f"{'=' * 40}")

    if matched.empty:
        print("No matches found.")
        return

    # --- Step 3: Update Supabase ---
    count = update_matching_leads(client, matched["id"].tolist())
    print(f"\nDone — updated {count} leads with permit data.")


if __name__ == "__main__":
    main()
