"""
Pull permit data from the City of Houston Open Data API and match to
Supabase leads.

Pipeline:
  1. Fetch all distinct addresses from the leads table in Supabase.
  2. Query the Houston Socrata permit endpoint for relevant permit types
     and statuses from the last 24 months.
  3. Match permits to leads by normalized street address.
  4. Update permit_flag, permit_type, permit_status, and permit_date
     for matching leads.
"""

import os
import re
from datetime import datetime, timedelta

import pandas as pd
import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SOCRATA_ENDPOINT = "https://data.houstontx.gov/resource/3srv-977b.json"

# Permit types that signal construction activity relevant to our leads
CONSTRUCTION_PERMIT_TYPES = {
    "new construction",
    "remodel",
    "repair",
    "foundation repair",
}

# Statuses indicating real / active permit activity
ACTIVE_STATUSES = {"Active", "Complete"}

# Also keep the "problem" statuses from the original script — these are
# useful for flagging properties with stalled/troubled projects.
PROBLEM_STATUSES = {"Expired", "Failed Inspection", "Stop Work Order"}

ALL_STATUSES = ACTIVE_STATUSES | PROBLEM_STATUSES

OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "permits_filtered.csv")

# Socrata page size
PAGE_SIZE = 50000

# Supabase credentials
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")


# ---------------------------------------------------------------------------
# Address normalization
# ---------------------------------------------------------------------------

# Common street‐type abbreviations for normalization
_STREET_ABBREVS = {
    "STREET": "ST", "AVENUE": "AVE", "BOULEVARD": "BLVD", "DRIVE": "DR",
    "LANE": "LN", "ROAD": "RD", "COURT": "CT", "CIRCLE": "CIR",
    "PLACE": "PL", "TRAIL": "TRL", "PARKWAY": "PKWY", "WAY": "WAY",
    "FREEWAY": "FWY", "HIGHWAY": "HWY",
}


def normalize_address(raw: str) -> str:
    """
    Produce a canonical form of a street address for fuzzy matching.

    - Upper-case
    - Strip unit / suite / apt suffixes
    - Collapse whitespace
    - Normalize common street-type words
    - Remove city name and ZIP (just keep the street portion)
    """
    if not raw or not isinstance(raw, str):
        return ""

    addr = raw.upper().strip()

    # Remove anything after a comma (city, state, zip)
    addr = addr.split(",")[0].strip()

    # Remove unit/suite/apt
    addr = re.sub(r"\b(UNIT|STE|SUITE|APT|#)\s*\S*", "", addr)

    # Remove trailing ZIP codes (5 or 9 digit)
    addr = re.sub(r"\b\d{5}(-\d{4})?\s*$", "", addr)

    # Remove trailing city names — our leads format is
    # "700 CONGRESS ST HOUSTON 77002". After ZIP removal we may still
    # have the city.  We strip common Houston-area city names.
    _CITIES = [
        "HOUSTON", "BELLAIRE", "PASADENA", "DEER PARK", "BAYTOWN",
        "HUMBLE", "KATY", "TOMBALL", "CROSBY", "SPRING", "CYPRESS",
        "HUFFMAN", "WALLER", "HIGHLANDS",
    ]
    for city in _CITIES:
        addr = re.sub(rf"\b{city}\s*$", "", addr)

    # Normalize street types
    for long, short in _STREET_ABBREVS.items():
        addr = re.sub(rf"\b{long}\b", short, addr)

    # Collapse whitespace
    addr = re.sub(r"\s+", " ", addr).strip()

    return addr


# ---------------------------------------------------------------------------
# Socrata API helpers
# ---------------------------------------------------------------------------

def build_query_params(offset: int = 0) -> dict:
    """Build SoQL query parameters for the Socrata API."""
    cutoff = (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%dT00:00:00")

    type_list = ", ".join(f"'{t}'" for t in CONSTRUCTION_PERMIT_TYPES)
    status_list = ", ".join(f"'{s}'" for s in ALL_STATUSES)

    where_clause = (
        f"lower(permit_type) in ({type_list}) "
        f"AND status in ({status_list}) "
        f"AND issue_date >= '{cutoff}'"
    )

    return {
        "$where": where_clause,
        "$limit": PAGE_SIZE,
        "$offset": offset,
        "$order": "issue_date DESC",
    }


def fetch_permits() -> pd.DataFrame:
    """Fetch all matching permits with pagination."""
    all_records: list[dict] = []
    offset = 0

    while True:
        params = build_query_params(offset)
        print(f"Fetching permits (offset={offset}) ...")
        resp = requests.get(SOCRATA_ENDPOINT, params=params, timeout=60)
        resp.raise_for_status()
        data = resp.json()

        if not data:
            break

        all_records.extend(data)
        print(f"  Received {len(data)} records")

        if len(data) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    print(f"Total records fetched: {len(all_records)}")
    return pd.DataFrame(all_records)


def normalize_permits(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize and select relevant columns from permit data."""
    if df.empty:
        return pd.DataFrame(
            columns=["address", "address_norm", "permit_type", "status", "issue_date"]
        )

    # Detect address column
    addr_col = next(
        (c for c in ["address", "project_address", "street_address", "location"]
         if c in df.columns),
        None,
    )
    # Detect permit type column
    type_col = next(
        (c for c in ["permit_type", "type"] if c in df.columns), None
    )
    # Detect status column
    status_col = next(
        (c for c in ["status", "permit_status"] if c in df.columns), None
    )
    # Detect date column
    date_col = next(
        (c for c in ["issue_date", "permit_date", "date"] if c in df.columns), None
    )

    out = pd.DataFrame()
    out["address"] = df[addr_col].astype(str).str.strip() if addr_col else ""
    out["permit_type"] = df[type_col].astype(str).str.strip() if type_col else ""
    out["status"] = df[status_col].astype(str).str.strip() if status_col else ""
    out["issue_date"] = (
        pd.to_datetime(df[date_col], errors="coerce").dt.date if date_col else None
    )

    # Drop rows with empty addresses
    out = out[out["address"].str.len() > 0].copy()

    # Add normalized address for matching
    out["address_norm"] = out["address"].apply(normalize_address)

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


def update_matching_leads(client, matches: pd.DataFrame) -> int:
    """
    Update permit columns for leads that matched a permit.
    Returns the number of rows updated.
    """
    if matches.empty:
        return 0

    batch_size = 500
    updated = 0

    for i in range(0, len(matches), batch_size):
        batch = matches.iloc[i : i + batch_size]
        for _, row in batch.iterrows():
            client.table("leads").update({
                "permit_flag": True,
                "permit_type": row.get("permit_type", None),
                "permit_status": row.get("status", None),
                "permit_date": str(row["issue_date"]) if pd.notna(row.get("issue_date")) else None,
            }).eq("id", row["lead_id"]).execute()
            updated += 1

        print(f"  Updated batch: {updated} / {len(matches)}")

    return updated


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("City of Houston Permit Pull  +  Supabase Lead Matching")
    print("=" * 60)

    # --- Step 1: Fetch permits from Houston API ---
    df_raw = fetch_permits()
    permits = normalize_permits(df_raw)

    permits.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(permits)} permits to {OUTPUT_PATH}")

    if not permits.empty:
        print(f"\nStatus breakdown:")
        print(permits["status"].value_counts().to_string())
        print(f"\nPermit type breakdown:")
        print(permits["permit_type"].value_counts().to_string())

    # --- Step 2: Match permits to Supabase leads ---
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("\nSUPABASE_URL / SUPABASE_ANON_KEY not set — skipping lead matching.")
        return

    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    leads = fetch_lead_addresses(client)

    if leads.empty or permits.empty:
        print("\nNo data to match.")
        return

    # Keep only the most recent permit per normalized address
    permits_dedup = (
        permits.sort_values("issue_date", ascending=False)
        .drop_duplicates(subset="address_norm", keep="first")
    )

    # Inner join on normalized address
    matched = leads.merge(
        permits_dedup[["address_norm", "permit_type", "status", "issue_date"]],
        on="address_norm",
        how="inner",
    )
    matched = matched.rename(columns={"id": "lead_id"})

    print(f"\n{'=' * 40}")
    print(f"Matched {len(matched)} leads to permits")
    print(f"{'=' * 40}")

    if matched.empty:
        print("No matches found.")
        return

    # --- Step 3: Update Supabase ---
    count = update_matching_leads(client, matched)
    print(f"\nDone — updated {count} leads with permit data.")


if __name__ == "__main__":
    main()
