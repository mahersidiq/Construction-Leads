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
# Also try loading .env from scripts/ folder
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")

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
    for f in os.listdir(folder):
        base = os.path.splitext(f)[0].lower()
        if base == name.lower() or f.lower() == name.lower():
            return os.path.join(folder, f)
    return None


def safe_col(df, col_name):
    """Get a column as stripped string series, or empty strings if missing."""
    if col_name and col_name in df.columns:
        return df[col_name].fillna("").astype(str).str.strip()
    return pd.Series([""] * len(df), index=df.index)


def build_address(df, cols):
    """Combine multiple columns into one address string."""
    existing = [c for c in cols if c in df.columns]
    if not existing:
        return pd.Series([""] * len(df), index=df.index)
    result = df[existing[0]].fillna("").astype(str).str.strip()
    for c in existing[1:]:
        part = df[c].fillna("").astype(str).str.strip()
        result = result + " " + part
    return result.str.strip().str.replace(r"\s+", " ", regex=True)


def main():
    if len(sys.argv) < 2:
        print("Usage: python local_ingest.py <Real_acct_owner_folder> [Real_building_land_folder]")
        sys.exit(1)

    acct_folder = sys.argv[1]
    bldg_folder = sys.argv[2] if len(sys.argv) > 2 else None

    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("ERROR: Set SUPABASE_URL and SUPABASE_ANON_KEY env vars or .env file")
        sys.exit(1)

    # ===== LOAD real_acct =====
    real_acct_path = find_file(acct_folder, "real_acct")
    if not real_acct_path:
        print(f"ERROR: real_acct not found in {acct_folder}")
        print(f"Files: {os.listdir(acct_folder)}")
        sys.exit(1)

    print(f"Loading {real_acct_path} ...")
    ra = pd.read_csv(real_acct_path, sep="\t", dtype=str, low_memory=False)
    ra.columns = ra.columns.str.strip().str.lower()
    print(f"  {len(ra)} records")
    print(f"  COLUMNS: {list(ra.columns)}")

    # ===== IDENTIFY COLUMNS =====
    # Account number
    acct_col = "acct" if "acct" in ra.columns else ra.columns[0]

    # State class for filtering
    class_col = None
    for c in ra.columns:
        if "state_class" in c or c == "state_cd":
            class_col = c
            break

    # Year built
    yr_col = None
    for c in ra.columns:
        if c in ("yr_impr", "yr_built", "year_built"):
            yr_col = c
            break

    # Appraised value
    val_col = None
    for c in ra.columns:
        if c in ("tot_appr_val", "tot_mkt_val", "total_appraised_value", "appr_val"):
            val_col = c
            break

    # Site address: try site_addr_1 first, then build from parts
    has_site_addr_1 = "site_addr_1" in ra.columns

    # Mailing address columns (in real_acct itself)
    has_mail_state = "mail_state" in ra.columns

    print(f"\n  Matched columns:")
    print(f"    Account: {acct_col}")
    print(f"    State class: {class_col}")
    print(f"    Year built: {yr_col}")
    print(f"    Appraised value: {val_col}")
    print(f"    Has site_addr_1: {has_site_addr_1}")
    print(f"    Has mail_state: {has_mail_state}")

    # ===== FILTER =====
    filtered = ra
    if class_col:
        filtered = filtered[
            filtered[class_col].fillna("").str.strip().str.upper().isin(MULTIFAMILY_CODES)
        ].copy()
        print(f"\n  Multifamily: {len(filtered)}")

    if yr_col:
        filtered[yr_col] = pd.to_numeric(filtered[yr_col], errors="coerce")
        filtered = filtered[(filtered[yr_col] >= 1980) & (filtered[yr_col] <= 2005)].copy()
        print(f"  After year filter: {len(filtered)}")

    if len(filtered) == 0:
        print("ERROR: No matching properties found!")
        sys.exit(1)

    # ===== BUILD PROPERTY ADDRESS =====
    if has_site_addr_1:
        addr_cols = [c for c in ["site_addr_1", "site_addr_2", "site_addr_3"] if c in filtered.columns]
        filtered["_property_address"] = build_address(filtered, addr_cols)
    else:
        # Build from street components
        street_cols = [c for c in ["str_pfx", "str_num", "str_name", "str_sfx", "str_sfx_dir"] if c in filtered.columns]
        if street_cols:
            filtered["_property_address"] = build_address(filtered, street_cols)
        else:
            # Last resort: find any column with "addr" or "site" or "str" in the name
            addr_like = [c for c in filtered.columns if any(x in c for x in ["addr", "site", "street", "location"])]
            print(f"  Fallback address columns: {addr_like}")
            if addr_like:
                filtered["_property_address"] = build_address(filtered, addr_like[:3])
            else:
                filtered["_property_address"] = ""

    # ===== BUILD MAILING ADDRESS (from real_acct) =====
    mail_parts = [c for c in ["mail_addr_1", "mail_addr_2", "mail_city", "mail_state", "mail_zip"] if c in filtered.columns]
    if mail_parts:
        filtered["_mail_address"] = build_address(filtered, mail_parts)
    else:
        filtered["_mail_address"] = ""

    # ===== LOAD OWNERS =====
    owners_path = find_file(acct_folder, "owners")
    name_col = None

    if owners_path:
        print(f"\nLoading {owners_path} ...")
        owners = pd.read_csv(owners_path, sep="\t", dtype=str, low_memory=False)
        owners.columns = owners.columns.str.strip().str.lower()
        print(f"  {len(owners)} records")
        print(f"  COLUMNS: {list(owners.columns)}")

        # Find owner name column
        for c in owners.columns:
            if c in ("owner_name", "own_name", "name", "owner", "owner_nm", "own_nm"):
                name_col = c
                break
        # Fallback: any column with "name" in it
        if not name_col:
            for c in owners.columns:
                if "name" in c or "owner" in c:
                    name_col = c
                    break

        owner_acct = "acct" if "acct" in owners.columns else owners.columns[0]

        print(f"  Owner name col: {name_col}")
        print(f"  Owner acct col: {owner_acct}")

        if name_col:
            owner_sub = owners[[owner_acct, name_col]].drop_duplicates(subset=[owner_acct])
            if owner_acct != acct_col:
                owner_sub = owner_sub.rename(columns={owner_acct: acct_col})
            filtered = filtered.merge(owner_sub, on=acct_col, how="left")

        # If mail address not found in real_acct, try owners file
        if not mail_parts:
            owner_mail_parts = [c for c in ["mail_addr_1", "mail_addr_2", "mail_city", "mail_state", "mail_zip"] if c in owners.columns]
            if owner_mail_parts:
                mail_sub = owners[[owner_acct] + owner_mail_parts].drop_duplicates(subset=[owner_acct])
                if owner_acct != acct_col:
                    mail_sub = mail_sub.rename(columns={owner_acct: acct_col})
                filtered = filtered.merge(mail_sub, on=acct_col, how="left")
                filtered["_mail_address"] = build_address(filtered, owner_mail_parts)
                has_mail_state = "mail_state" in filtered.columns

    # ===== FLAG OUT-OF-STATE =====
    if has_mail_state and "mail_state" in filtered.columns:
        ms = filtered["mail_state"].fillna("").astype(str).str.strip().str.upper()
        filtered["_out_of_state"] = (ms != "") & (ms != "TX")
    elif len(filtered["_mail_address"].iloc[0] if len(filtered) > 0 else "") > 0:
        filtered["_out_of_state"] = filtered["_mail_address"].apply(
            lambda x: extract_state(x) not in ("", "TX")
        )
    else:
        filtered["_out_of_state"] = False

    # ===== PRINT SAMPLE =====
    if len(filtered) > 0:
        s = filtered.iloc[0]
        print(f"\n  SAMPLE RECORD:")
        print(f"    Account: {s.get(acct_col, '?')}")
        print(f"    Address: {s.get('_property_address', '?')}")
        print(f"    Mail: {s.get('_mail_address', '?')}")
        print(f"    Owner: {s.get(name_col, '?') if name_col else '?'}")
        print(f"    Year: {s.get(yr_col, '?') if yr_col else '?'}")
        print(f"    Value: {s.get(val_col, '?') if val_col else '?'}")
        print(f"    Out-of-state: {s.get('_out_of_state', '?')}")

    # ===== BUILD OUTPUT =====
    output = pd.DataFrame()
    output["acct_number"] = filtered[acct_col].astype(str).str.strip()
    output["property_address"] = filtered["_property_address"]
    output["owner_name"] = safe_col(filtered, name_col)
    output["owner_mail_address"] = filtered["_mail_address"]
    output["year_built"] = pd.to_numeric(filtered.get(yr_col), errors="coerce") if yr_col else None
    output["appraised_value"] = pd.to_numeric(filtered.get(val_col), errors="coerce") if val_col else None
    output["unit_count"] = None
    output["out_of_state_owner"] = filtered["_out_of_state"]
    output["permit_flag"] = False
    output["lead_score"] = 0

    # ===== LOAD BUILDING DATA =====
    if bldg_folder:
        bldg_path = find_file(bldg_folder, "building_res")
        if bldg_path:
            print(f"\nLoading {bldg_path} ...")
            bldg = pd.read_csv(bldg_path, sep="\t", dtype=str, low_memory=False)
            bldg.columns = bldg.columns.str.strip().str.lower()
            print(f"  COLUMNS: {list(bldg.columns)}")

            bldg_acct = "acct" if "acct" in bldg.columns else bldg.columns[0]
            unit_col = None
            for c in bldg.columns:
                if c in ("units", "unit_count", "nbr_units", "no_of_units", "living_units", "num_units"):
                    unit_col = c
                    break

            if unit_col:
                bldg[unit_col] = pd.to_numeric(bldg[unit_col], errors="coerce")
                units = bldg.groupby(bldg_acct)[unit_col].sum().reset_index()
                units.columns = ["acct_number", "unit_count"]
                units["acct_number"] = units["acct_number"].astype(str).str.strip()
                output = output.drop(columns=["unit_count"]).merge(units, on="acct_number", how="left")
                print(f"  Merged unit counts from: {unit_col}")

    # ===== SCORE =====
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

    print(f"\n{'='*50}")
    print(f"RESULTS:")
    print(f"  Total leads: {len(output)}")
    print(f"  With address: {(output['property_address'].str.len() > 0).sum()}")
    print(f"  With owner: {(output['owner_name'].str.len() > 0).sum()}")
    print(f"  With mail addr: {(output['owner_mail_address'].str.len() > 0).sum()}")
    print(f"  Out-of-state: {output['out_of_state_owner'].sum()}")
    print(f"{'='*50}")

    print(f"\nTop 5:")
    for _, row in output.head(5).iterrows():
        print(f"  {row['property_address']} | {row['owner_name']} | {row['owner_mail_address']} | Score: {row['lead_score']}")

    # ===== UPSERT TO SUPABASE =====
    print(f"\nUploading {len(output)} leads to Supabase ...")
    client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)

    output = output.where(pd.notna(output), None)
    for col in ["year_built", "unit_count", "lead_score"]:
        if col in output.columns:
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
        print(f"  {total}/{len(records)}")

    print(f"\nDone! {total} leads synced.")


if __name__ == "__main__":
    main()
