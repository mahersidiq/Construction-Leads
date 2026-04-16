"""
Join HCAD commercial property data with permit data and compute lead scores.

Normalizes addresses for fuzzy matching, joins the two datasets,
and applies a 0-100 scoring rubric based on commercial lead signals.
"""

import os
import re

import pandas as pd

SCRIPTS_DIR = os.path.dirname(__file__)
HCAD_PATH = os.path.join(SCRIPTS_DIR, "hcad_commercial_filtered.csv")
PERMITS_PATH = os.path.join(SCRIPTS_DIR, "permits_commercial.csv")
OUTPUT_PATH = os.path.join(SCRIPTS_DIR, "scored_commercial_leads.csv")


def normalize_address(addr: str) -> str:
    """Normalize an address for matching: lowercase, strip unit numbers, trim."""
    if not isinstance(addr, str):
        return ""
    addr = addr.lower().strip()
    addr = re.sub(r"\b(unit|suite|ste|apt|#)\s*\w*", "", addr)
    addr = re.sub(r"\s+", " ", addr).strip()
    return addr


def compute_score(row: pd.Series) -> int:
    """Compute commercial lead score (0-100) based on multiple signals."""
    score = 0

    if row.get("permit_flag"):
        score += 20

    if row.get("out_of_state_owner"):
        score += 20

    year_built = row.get("year_built")
    if pd.notna(year_built) and year_built < 1985:
        score += 15

    appraised_value = row.get("appraised_value")
    if pd.notna(appraised_value) and appraised_value > 2_000_000:
        score += 15

    property_type = row.get("property_type")
    if isinstance(property_type, str) and property_type == "hotel":
        score += 15

    permit_status = row.get("permit_status")
    if isinstance(permit_status, str) and permit_status in (
        "Stop Work Order", "Failed Inspection"
    ):
        score += 15

    return min(score, 100)


def main():
    print("=== Join and Score Commercial Leads ===")

    # Load datasets
    hcad = pd.read_csv(HCAD_PATH)
    permits = pd.read_csv(PERMITS_PATH)

    print(f"HCAD commercial records: {len(hcad)}")
    print(f"Commercial permit records: {len(permits)}")

    # Normalize addresses for joining
    hcad["_norm_addr"] = hcad["property_address"].apply(normalize_address)
    permits["_norm_addr"] = permits["address"].apply(normalize_address)

    # Deduplicate permits per address, keeping the most relevant status
    # Priority: Stop Work Order > Failed Inspection > Code Violation > others
    status_priority = {
        "Stop Work Order": 0,
        "Failed Inspection": 1,
        "Code Violation": 2,
        "Change of Occupancy": 3,
        "Change of Use": 4,
        "Tenant Improvement": 5,
        "Certificate of Occupancy": 6,
    }
    permits["_status_rank"] = (
        permits["commercial_permit_type"].map(status_priority).fillna(99)
    )
    permits = permits.sort_values("_status_rank").drop_duplicates(
        subset=["_norm_addr"], keep="first"
    )

    # Left join: all HCAD properties, enriched with permit data where matched
    merged = hcad.merge(
        permits[["_norm_addr", "commercial_permit_type"]],
        on="_norm_addr",
        how="left",
        suffixes=("", "_permit"),
    )

    # Set permit flag and status from commercial_permit_type
    merged["permit_flag"] = merged["commercial_permit_type"].notna()
    merged["permit_type"] = merged["commercial_permit_type"]
    merged["permit_status"] = merged["commercial_permit_type"]

    # Ensure numeric types for scoring
    merged["year_built"] = pd.to_numeric(merged["year_built"], errors="coerce")
    merged["appraised_value"] = pd.to_numeric(merged["appraised_value"], errors="coerce")
    merged["out_of_state_owner"] = merged["out_of_state_owner"].astype(bool)

    # Compute lead scores
    merged["lead_score"] = merged.apply(compute_score, axis=1)

    # Select output columns
    output = merged[
        [
            "acct_number",
            "property_address",
            "owner_name",
            "owner_mail_address",
            "year_built",
            "appraised_value",
            "property_type",
            "out_of_state_owner",
            "permit_flag",
            "permit_type",
            "permit_status",
            "lead_score",
        ]
    ].copy()

    output = output.sort_values("lead_score", ascending=False).reset_index(drop=True)

    output.to_csv(OUTPUT_PATH, index=False)

    print(f"\nScored commercial leads: {len(output)}")
    print(f"Leads with permits: {output['permit_flag'].sum()}")
    print(f"Out-of-state owners: {output['out_of_state_owner'].sum()}")
    print(f"Hotels: {(output['property_type'] == 'hotel').sum()}")
    print(f"\nScore distribution:")
    print(output["lead_score"].describe().to_string())
    print(f"\nTop 10 commercial leads:")
    print(
        output.head(10)[
            ["property_address", "lead_score", "property_type", "permit_flag", "out_of_state_owner"]
        ].to_string()
    )
    print(f"\nSaved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
