"""
Pull and filter permit data from the City of Houston Open Data API.

Queries the Socrata endpoint for building, electrical, plumbing, and
mechanical permits with problem statuses from the last 24 months.
"""

import os
from datetime import datetime, timedelta

import pandas as pd
import requests

SOCRATA_ENDPOINT = "https://data.houstontx.gov/resource/3srv-977b.json"
PERMIT_TYPES = {"building", "electrical", "plumbing", "mechanical"}
PROBLEM_STATUSES = {"Expired", "Failed Inspection", "Stop Work Order"}
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "permits_filtered.csv")

# Socrata API page size limit
PAGE_SIZE = 50000


def build_query_params(offset: int = 0) -> dict:
    """Build SoQL query parameters for the Socrata API."""
    cutoff = (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%dT00:00:00")
    type_list = ", ".join(f"'{t}'" for t in PERMIT_TYPES)
    status_list = ", ".join(f"'{s}'" for s in PROBLEM_STATUSES)

    where_clause = (
        f"lower(permit_type) in ({', '.join(f\"'{t}'\" for t in PERMIT_TYPES)}) "
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
    all_records = []
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
        return pd.DataFrame(columns=["address", "permit_type", "status", "issue_date"])

    # Find address column
    addr_col = None
    for candidate in ["address", "project_address", "street_address", "location"]:
        if candidate in df.columns:
            addr_col = candidate
            break

    # Find permit type column
    type_col = None
    for candidate in ["permit_type", "type"]:
        if candidate in df.columns:
            type_col = candidate
            break

    # Find status column
    status_col = None
    for candidate in ["status", "permit_status"]:
        if candidate in df.columns:
            status_col = candidate
            break

    # Find date column
    date_col = None
    for candidate in ["issue_date", "permit_date", "date"]:
        if candidate in df.columns:
            date_col = candidate
            break

    output = pd.DataFrame()
    output["address"] = df[addr_col].astype(str).str.strip() if addr_col else ""
    output["permit_type"] = df[type_col].astype(str).str.strip() if type_col else ""
    output["status"] = df[status_col].astype(str).str.strip() if status_col else ""
    output["issue_date"] = pd.to_datetime(
        df[date_col], errors="coerce"
    ).dt.date if date_col else None

    # Drop rows with empty addresses
    output = output[output["address"].str.len() > 0]

    return output


def main():
    print("=== City of Houston Permit Pull ===")

    df = fetch_permits()
    permits = normalize_permits(df)

    permits.to_csv(OUTPUT_PATH, index=False)
    print(f"\nSaved {len(permits)} permits to {OUTPUT_PATH}")

    if not permits.empty:
        print(f"\nStatus breakdown:")
        print(permits["status"].value_counts().to_string())
        print(f"\nPermit type breakdown:")
        print(permits["permit_type"].value_counts().to_string())


if __name__ == "__main__":
    main()
