"""
Local one-time ingestion script.

Run this on your machine where the HCAD downloaded files are.
It reads the extracted text files, filters, scores, and pushes to Supabase.

Usage:
    pip install pandas requests supabase python-dotenv
    python local_ingest.py <path_to_Real_acct_owner_folder> <path_to_Real_building_land_folder>

Example:
    python local_ingest.py "C:/Users/you/Downloads/Real_acct_owner" "C:/Users/you/Downloads/Real_building_land"

Set these environment variables (or create a .env file next to this script):
    SUPABASE_URL=https://iydmeyuijfrrrhpkamvu.supabase.co
    SUPABASE_ANON_KEY=your_key_here
"""

import os
import re
import sys

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

# Multifamily state class codes
MULTIFAMILY_CODES = set()
for prefix, end in [("A", 9), ("B", 4), ("F", 4)]:
    for i in range(1, end + 1):
        MULTIFAMILY_CODES.add(f"{prefix}{i}")


def extract_state(address):
    if not isinstance(address, str):
        return ""
    match = re.search(r"\b([A-Z]{2})\s+\d{5}", address.upper())
    if match:
        return match.group(1)
    return ""


def find_file(folder, name):
    """Find a file in a folder, case-insensitive, with or without .txt extension."""
    for f in os.listdir(folder):
        if f.lower() == name.lower() or f.lower() == f"{name}.txt".lower():
            return os.path.join(folder, f)
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python local_ingest.py <Real_acct_owner_folder> [Real_building_land_folder]")
        print()
        print("Example:")
        print('  python local_ingest.py "C:/Users/you/Downloads/Real_acct_owner" "C:/Users/you/Downloads/Real_building_land"')
        sys.exit(1)

    acct_folder = sys.argv[1]
    bldg_folder = sys.argv[2] if len(sys.argv) > 2 else None

    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("ERROR: Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.")
        print("You can create a .env file next to this script with:")
        print("  SUPABASE_URL=https://your-project.supabase.co")
        print("  SUPABASE_ANON_KEY=your-anon-key")
        sys.exit(1)

    # --- Load real_acct ---
    real_acct_path = find_file(acct_folder, "real_acct")
    if not real_acct_path:
        print(f"ERROR: real_acct.txt not found in {acct_folder}")
        sys.exit(1)

    print(f"Loading {real_acct_path} ...")
    real_acct = pd.read_csv(real_acct_path, sep="\t", dtype=str, low_memory=False)
    real_acct.columns = real_acct.columns.str.strip().str.lower()
    print(f"  {len(real_acct)} records")

    # --- Find key columns ---
    acct_col = next((c for c in ["acct", "account", "acct_number"] if c in real_acct.columns), real_acct.columns[0])
    class_col = next((c for c in ["state_class", "state_cd", "class_cd", "impr_state_cd"] if c in real_acct.columns), None)
    yr_col = next((c for c in ["yr_built", "year_built", "yr_impr"] if c in real_acct.columns), None)
    addr_col = next((c for c in ["site_addr", "property_address", "address", "situs"] if c in real_acct.columns), None)
    val_col = next((c for c in ["tot_appr_val", "appraised_value", "total_appraised_value", "appr_val"] if c in real_acct.columns), None)

    print(f"  Account col: {acct_col}, Class col: {class_col}, Year col: {yr_col}")

    # --- Filter multifamily ---
    if class_col:
        real_acct["_class"] = real_acct[class_col].astype(str).str.strip().str.upper()
        filtered = real_acct[real_acct["_class"].isin(MULTIFAMILY_CODES)].copy()
        print(f"  Multifamily: {len(filtered)}")
    else:
        print("  WARNING: No state class column found, using all records")
        filtered = real_acct.copy()

    # --- Filter year built ---
    if yr_col:
        filtered[yr_col] = pd.to_numeric(filtered[yr_col], errors="coerce")
        filtered = filtered[(filtered[yr_col] >= 1980) & (filtered[yr_col] <= 2005)]
        print(f"  After year filter (1980-2005): {len(filtered)}")

    # --- Load owners ---
    owners_path = find_file(acct_folder, "owners")
    if owners_path:
        print(f"Loading {owners_path} ...")
        owners = pd.read_csv(owners_path, sep="\t", dtype=str, low_memory=False)
        owners.columns = owners.columns.str.strip().str.lower()

        owner_acct_col = next((c for c in ["acct", "account", "acct_number"] if c in owners.columns), owners.columns[0])
        name_col = next((c for c in ["owner_name", "name", "owner"] if c in owners.columns), None)
        mail_col = next((c for c in ["mail_addr", "mailing_address", "mail_address", "tnt_mail_adr"] if c in owners.columns), None)
        mail_state_col = next((c for c in ["mail_state", "state", "mail_st"] if c in owners.columns), None)

        merge_cols = [owner_acct_col]
        if name_col: merge_cols.append(name_col)
        if mail_col: merge_cols.append(mail_col)
        if mail_state_col: merge_cols.append(mail_state_col)

        owners_sub = owners[merge_cols].drop_duplicates(subset=[owner_acct_col])
        if owner_acct_col != acct_col:
            owners_sub = owners_sub.rename(columns={owner_acct_col: acct_col})

        filtered = filtered.merge(owners_sub, on=acct_col, how="left")
        print(f"  After owner join: {len(filtered)}")
    else:
        print("  WARNING: owners file not found, skipping owner data")
        name_col = None
        mail_col = None
        mail_state_col = None

    # --- Load building data for unit counts ---
    unit_count_col = None
    if bldg_folder:
        bldg_path = find_file(bldg_folder, "building_res")
        if bldg_path:
            print(f"Loading {bldg_path} ...")
            bldg = pd.read_csv(bldg_path, sep="\t", dtype=str, low_memory=False)
            bldg.columns = bldg.columns.str.strip().str.lower()

            bldg_acct = next((c for c in ["acct", "account"] if c in bldg.columns), bldg.columns[0])
            unit_col = next((c for c in ["units", "unit_count", "nbr_units", "no_of_units"] if c in bldg.columns), None)

            if unit_col:
                bldg[unit_col] = pd.to_numeric(bldg[unit_col], errors="coerce")
                units = bldg.groupby(bldg_acct)[unit_col].sum().reset_index()
                units.columns = [acct_col, "unit_count"]
                filtered = filtered.merge(units, on=acct_col, how="left")
                unit_count_col = "unit_count"
                print(f"  Merged unit counts")

    # --- Flag out-of-state owners ---
    if mail_state_col and mail_state_col in filtered.columns:
        filtered["out_of_state_owner"] = filtered[mail_state_col].astype(str).str.strip().str.upper() != "TX"
    elif mail_col and mail_col in filtered.columns:
        filtered["out_of_state_owner"] = filtered[mail_col].apply(
            lambda x: extract_state(x) not in ("", "TX")
        )
    else:
        filtered["out_of_state_owner"] = False

    # --- Build output ---
    output = pd.DataFrame()
    output["acct_number"] = filtered[acct_col].astype(str).str.strip()
    output["property_address"] = filtered[addr_col].astype(str).str.strip() if addr_col else ""
    output["owner_name"] = filtered[name_col].astype(str).str.strip() if name_col else ""
    output["owner_mail_address"] = filtered[mail_col].astype(str).str.strip() if mail_col else ""
    output["year_built"] = pd.to_numeric(filtered.get(yr_col, pd.Series(dtype="float")), errors="coerce")
    output["appraised_value"] = pd.to_numeric(filtered[val_col], errors="coerce") if val_col else None
    output["unit_count"] = pd.to_numeric(filtered.get(unit_count_col or "unit_count", pd.Series(dtype="float")), errors="coerce")
    output["out_of_state_owner"] = filtered["out_of_state_owner"]
    output["permit_flag"] = False
    output["lead_score"] = 0

    # --- Score ---
    def score(row):
        s = 0
        if row.get("out_of_state_owner"): s += 20
        if pd.notna(row.get("year_built")) and row["year_built"] < 1990: s += 15
        if pd.notna(row.get("appraised_value")) and row["appraised_value"] > 1_000_000: s += 15
        if pd.notna(row.get("unit_count")) and row["unit_count"] > 20: s += 15
        return min(s, 100)

    output["lead_score"] = output.apply(score, axis=1)
    output = output.sort_values("lead_score", ascending=False).reset_index(drop=True)

    print(f"\n=== Results ===")
    print(f"Total leads: {len(output)}")
    print(f"Out-of-state owners: {output['out_of_state_owner'].sum()}")
    print(f"Score distribution:\n{output['lead_score'].describe()}")

    # --- Upsert to Supabase ---
    print(f"\nUploading to Supabase ...")
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    # Clean data for JSON
    output = output.where(pd.notna(output), None)
    for col in ["year_built", "unit_count", "lead_score"]:
        output[col] = output[col].apply(lambda x: int(x) if pd.notna(x) else None)
    if "appraised_value" in output.columns:
        output["appraised_value"] = output["appraised_value"].apply(lambda x: float(x) if pd.notna(x) else None)

    records = output.to_dict(orient="records")
    batch_size = 500
    total = 0

    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        client.table("leads").upsert(batch, on_conflict="acct_number").execute()
        total += len(batch)
        print(f"  Upserted {total}/{len(records)}")

    print(f"\nDone! {total} leads synced to Supabase.")

    # Top 10
    result = client.table("leads").select("property_address, owner_name, lead_score").order("lead_score", desc=True).limit(10).execute()
    print(f"\nTop 10 leads:")
    for i, lead in enumerate(result.data, 1):
        print(f"  {i}. Score {lead['lead_score']}: {lead['property_address']} ({lead['owner_name']})")


if __name__ == "__main__":
    main()
