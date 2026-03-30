"""
Local one-time ingestion script.

Run this on your machine where the HCAD downloaded files are.
It reads the extracted text files, filters, scores, and pushes to Supabase.

Usage:
    pip install pandas requests supabase python-dotenv
    python local_ingest.py <path_to_Real_acct_owner_folder> [path_to_Real_building_land_folder]

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
        base = os.path.splitext(f)[0].lower()
        if base == name.lower() or f.lower() == name.lower():
            return os.path.join(folder, f)
    return None


def find_col(columns, candidates):
    """Find the first matching column name from candidates."""
    for c in candidates:
        if c in columns:
            return c
    # Also try partial matching
    for c in candidates:
        for col in columns:
            if c in col:
                return col
    return None


def combine_cols(df, candidates, sep=" "):
    """Combine multiple columns into one string, skipping NaN."""
    parts = []
    for c in candidates:
        if c in df.columns:
            parts.append(df[c].fillna("").astype(str).str.strip())
    if not parts:
        return pd.Series([""] * len(df), index=df.index)
    result = parts[0]
    for p in parts[1:]:
        result = result + sep + p
    return result.str.strip()


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
        print(f"ERROR: real_acct file not found in {acct_folder}")
        print(f"Files in folder: {os.listdir(acct_folder)}")
        sys.exit(1)

    print(f"Loading {real_acct_path} ...")
    real_acct = pd.read_csv(real_acct_path, sep="\t", dtype=str, low_memory=False)
    real_acct.columns = real_acct.columns.str.strip().str.lower()
    print(f"  {len(real_acct)} records")
    print(f"  ALL COLUMNS: {list(real_acct.columns)}")

    # --- Find key columns (expanded for HCAD naming) ---
    acct_col = find_col(real_acct.columns, ["acct", "account", "acct_number"])
    if not acct_col:
        acct_col = real_acct.columns[0]

    class_col = find_col(real_acct.columns, [
        "state_class", "state_cd", "class_cd", "impr_state_cd",
        "state_class_cd", "imprv_state_cd",
    ])

    yr_col = find_col(real_acct.columns, [
        "yr_built", "year_built", "yr_impr", "impr_yr_built",
        "actual_yr_built", "yr_built_1",
    ])

    val_col = find_col(real_acct.columns, [
        "tot_appr_val", "appraised_value", "total_appraised_value",
        "appr_val", "tot_mkt_val", "total_market_value",
    ])

    # Address: HCAD splits into site_addr_1, site_addr_2, site_addr_3
    addr_candidates_single = [
        "site_addr", "property_address", "address", "situs",
        "site_addr_1", "str_addr", "street_address", "loc_addr",
    ]
    addr_col = find_col(real_acct.columns, addr_candidates_single)

    # Check for split address columns
    addr_parts = [c for c in real_acct.columns if "site_addr" in c or "str_addr" in c or "situs" in c]

    print(f"  Account: {acct_col}")
    print(f"  Class: {class_col}")
    print(f"  Year: {yr_col}")
    print(f"  Address: {addr_col} (all addr cols: {addr_parts})")
    print(f"  Value: {val_col}")

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

    # --- Build property address from available columns ---
    if len(addr_parts) > 1:
        # Combine split address columns
        filtered["_full_addr"] = combine_cols(filtered, sorted(addr_parts))
        print(f"  Combined address from columns: {sorted(addr_parts)}")
    elif addr_col:
        filtered["_full_addr"] = filtered[addr_col].fillna("").astype(str).str.strip()
    else:
        filtered["_full_addr"] = ""
        print("  WARNING: No address column found!")

    # Print sample to verify
    if len(filtered) > 0:
        sample = filtered.iloc[0]
        print(f"\n  SAMPLE ROW:")
        for c in filtered.columns:
            val = sample.get(c, "")
            if val and str(val).strip() and str(val) != "nan":
                print(f"    {c}: {val}")

    # --- Load owners ---
    owners_path = find_file(acct_folder, "owners")
    name_col = None
    mail_state_col = None
    has_owners = False

    if owners_path:
        print(f"\nLoading {owners_path} ...")
        owners = pd.read_csv(owners_path, sep="\t", dtype=str, low_memory=False)
        owners.columns = owners.columns.str.strip().str.lower()
        print(f"  {len(owners)} records")
        print(f"  ALL COLUMNS: {list(owners.columns)}")

        owner_acct_col = find_col(owners.columns, ["acct", "account", "acct_number"])
        if not owner_acct_col:
            owner_acct_col = owners.columns[0]

        name_col = find_col(owners.columns, [
            "owner_name", "own_name", "name", "owner",
            "owner_nm", "ownername", "own_nm",
        ])

        # HCAD splits mailing address into multiple columns
        mail_addr_parts = [c for c in owners.columns if "mail" in c and ("addr" in c or "adr" in c)]
        mail_city_col = find_col(owners.columns, ["mail_city", "mailcity"])
        mail_state_col = find_col(owners.columns, ["mail_state", "mailstate", "mail_st"])
        mail_zip_col = find_col(owners.columns, ["mail_zip", "mailzip", "mail_zip_cd"])

        # Single mail address column
        mail_single_col = find_col(owners.columns, [
            "mail_addr", "mailing_address", "mail_address", "tnt_mail_adr",
            "mail_addr_1",
        ])

        print(f"  Owner name: {name_col}")
        print(f"  Mail addr parts: {mail_addr_parts}")
        print(f"  Mail city: {mail_city_col}, state: {mail_state_col}, zip: {mail_zip_col}")

        # Build full mailing address
        mail_components = []
        if mail_addr_parts:
            mail_components.extend(sorted(mail_addr_parts))
        elif mail_single_col:
            mail_components.append(mail_single_col)
        if mail_city_col:
            mail_components.append(mail_city_col)
        if mail_state_col:
            mail_components.append(mail_state_col)
        if mail_zip_col:
            mail_components.append(mail_zip_col)

        merge_cols = [owner_acct_col]
        if name_col:
            merge_cols.append(name_col)

        # Build full mail address column
        if mail_components:
            owners["_full_mail"] = combine_cols(owners, mail_components, " ")
            merge_cols.append("_full_mail")

        if mail_state_col:
            merge_cols.append(mail_state_col)

        # Print sample owner
        if len(owners) > 0:
            sample = owners.iloc[0]
            print(f"\n  SAMPLE OWNER ROW:")
            for c in owners.columns:
                val = sample.get(c, "")
                if val and str(val).strip() and str(val) != "nan":
                    print(f"    {c}: {val}")

        owners_sub = owners[merge_cols].drop_duplicates(subset=[owner_acct_col])
        if owner_acct_col != acct_col:
            owners_sub = owners_sub.rename(columns={owner_acct_col: acct_col})

        filtered = filtered.merge(owners_sub, on=acct_col, how="left")
        has_owners = True
        print(f"  After owner join: {len(filtered)}")
    else:
        print("  WARNING: owners file not found, skipping owner data")

    # --- Load building data for unit counts ---
    unit_count_col = None
    if bldg_folder:
        bldg_path = find_file(bldg_folder, "building_res")
        if bldg_path:
            print(f"\nLoading {bldg_path} ...")
            bldg = pd.read_csv(bldg_path, sep="\t", dtype=str, low_memory=False)
            bldg.columns = bldg.columns.str.strip().str.lower()
            print(f"  ALL COLUMNS: {list(bldg.columns)}")

            bldg_acct = find_col(bldg.columns, ["acct", "account"])
            if not bldg_acct:
                bldg_acct = bldg.columns[0]

            unit_col = find_col(bldg.columns, [
                "units", "unit_count", "nbr_units", "no_of_units",
                "living_units", "num_units",
            ])

            if unit_col:
                bldg[unit_col] = pd.to_numeric(bldg[unit_col], errors="coerce")
                units = bldg.groupby(bldg_acct)[unit_col].sum().reset_index()
                units.columns = [acct_col, "unit_count"]
                filtered = filtered.merge(units, on=acct_col, how="left")
                unit_count_col = "unit_count"
                print(f"  Merged unit counts from column: {unit_col}")
            else:
                print(f"  WARNING: No unit count column found")

    # --- Flag out-of-state owners ---
    if has_owners and mail_state_col and mail_state_col in filtered.columns:
        filtered["out_of_state_owner"] = (
            filtered[mail_state_col].fillna("").astype(str).str.strip().str.upper().apply(
                lambda x: x != "" and x != "TX"
            )
        )
    elif has_owners and "_full_mail" in filtered.columns:
        filtered["out_of_state_owner"] = filtered["_full_mail"].apply(
            lambda x: extract_state(x) not in ("", "TX")
        )
    else:
        filtered["out_of_state_owner"] = False

    # --- Build output ---
    output = pd.DataFrame()
    output["acct_number"] = filtered[acct_col].astype(str).str.strip()
    output["property_address"] = filtered["_full_addr"].astype(str).str.strip()
    output["owner_name"] = filtered[name_col].fillna("").astype(str).str.strip() if (has_owners and name_col) else ""
    output["owner_mail_address"] = filtered["_full_mail"].fillna("").astype(str).str.strip() if (has_owners and "_full_mail" in filtered.columns) else ""
    output["year_built"] = pd.to_numeric(filtered.get(yr_col, pd.Series(dtype="float")), errors="coerce")
    output["appraised_value"] = pd.to_numeric(filtered[val_col], errors="coerce") if val_col else None
    output["unit_count"] = pd.to_numeric(filtered.get(unit_count_col or "_dummy_", pd.Series(dtype="float")), errors="coerce")
    output["out_of_state_owner"] = filtered["out_of_state_owner"]
    output["permit_flag"] = False
    output["lead_score"] = 0

    # --- Score ---
    def score(row):
        s = 0
        if row.get("out_of_state_owner"):
            s += 20
        if pd.notna(row.get("year_built")) and row["year_built"] < 1990:
            s += 15
        if pd.notna(row.get("appraised_value")) and row["appraised_value"] > 1_000_000:
            s += 15
        if pd.notna(row.get("unit_count")) and row["unit_count"] > 20:
            s += 15
        return min(s, 100)

    output["lead_score"] = output.apply(score, axis=1)
    output = output.sort_values("lead_score", ascending=False).reset_index(drop=True)

    print(f"\n=== Results ===")
    print(f"Total leads: {len(output)}")
    print(f"With address: {(output['property_address'].str.len() > 0).sum()}")
    print(f"With owner name: {(output['owner_name'].str.len() > 0).sum()}")
    print(f"With mail address: {(output['owner_mail_address'].str.len() > 0).sum()}")
    print(f"Out-of-state owners: {output['out_of_state_owner'].sum()}")
    print(f"Score distribution:\n{output['lead_score'].describe()}")

    print(f"\nTop 5 sample rows:")
    for i, row in output.head(5).iterrows():
        print(f"  {row['property_address']} | {row['owner_name']} | {row['owner_mail_address']} | Score: {row['lead_score']}")

    # --- Upsert to Supabase ---
    print(f"\nUploading to Supabase ...")
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    # Clean data for JSON
    output = output.where(pd.notna(output), None)
    for col in ["year_built", "unit_count", "lead_score"]:
        output[col] = output[col].apply(lambda x: int(x) if pd.notna(x) else None)
    if "appraised_value" in output.columns:
        output["appraised_value"] = output["appraised_value"].apply(
            lambda x: float(x) if pd.notna(x) else None
        )

    records = output.to_dict(orient="records")
    batch_size = 500
    total = 0

    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        client.table("leads").upsert(batch, on_conflict="acct_number").execute()
        total += len(batch)
        print(f"  Upserted {total}/{len(records)}")

    print(f"\nDone! {total} leads synced to Supabase.")

    # Top 10
    result = (
        client.table("leads")
        .select("property_address, owner_name, owner_mail_address, lead_score")
        .order("lead_score", desc=True)
        .limit(10)
        .execute()
    )
    print(f"\nTop 10 leads from Supabase:")
    for i, lead in enumerate(result.data, 1):
        print(
            f"  {i}. Score {lead['lead_score']}: "
            f"{lead['property_address']} | {lead['owner_name']} | {lead['owner_mail_address']}"
        )


if __name__ == "__main__":
    main()
