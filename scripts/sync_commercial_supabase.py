"""
Upsert scored commercial leads into the Supabase commercial_leads table.

Loads scored_commercial_leads.csv and upserts all rows using acct_number
as the conflict key. Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env.
"""

import os

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SCRIPTS_DIR = os.path.dirname(__file__)
INPUT_PATH = os.path.join(SCRIPTS_DIR, "scored_commercial_leads.csv")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]


def main():
    print("=== Sync Commercial Leads to Supabase ===")

    df = pd.read_csv(INPUT_PATH)
    print(f"Loaded {len(df)} commercial leads from {INPUT_PATH}")

    # Replace NaN with None for JSON serialization
    df = df.where(pd.notna(df), None)

    # Convert boolean columns
    for col in ["out_of_state_owner", "permit_flag"]:
        if col in df.columns:
            df[col] = df[col].map({True: True, False: False, "True": True, "False": False})

    # Convert numeric columns
    for col in ["year_built", "lead_score"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df[col] = df[col].apply(lambda x: int(x) if pd.notna(x) else None)

    if "appraised_value" in df.columns:
        df["appraised_value"] = pd.to_numeric(df["appraised_value"], errors="coerce")
        df["appraised_value"] = df["appraised_value"].apply(
            lambda x: float(x) if pd.notna(x) else None
        )

    records = df.to_dict(orient="records")

    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    # Upsert in batches
    batch_size = 500
    total_upserted = 0

    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        client.table("commercial_leads").upsert(
            batch, on_conflict="acct_number"
        ).execute()
        total_upserted += len(batch)
        print(f"  Upserted batch {i // batch_size + 1}: {len(batch)} rows")

    print(f"\nTotal rows upserted: {total_upserted}")

    # Print top 5 commercial leads
    result = (
        client.table("commercial_leads")
        .select("acct_number, property_address, owner_name, property_type, lead_score")
        .order("lead_score", desc=True)
        .limit(5)
        .execute()
    )

    print("\nTop 5 commercial leads by score:")
    for i, lead in enumerate(result.data, 1):
        print(
            f"  {i}. Score {lead['lead_score']}: "
            f"{lead['property_address']} ({lead['owner_name']}) [{lead['property_type']}]"
        )


if __name__ == "__main__":
    main()
