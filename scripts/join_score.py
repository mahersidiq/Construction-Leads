"""
Join HCAD property data with permit data and compute lead scores.

Normalizes addresses for fuzzy matching, joins the two datasets,
and applies a 0-100 scoring rubric based on multiple lead signals.
"""

import os
import re

import pandas as pd

SCRIPTS_DIR = os.path.dirname(__file__)
HCAD_PATH = os.path.join(SCRIPTS_DIR, "hcad_filtered.csv")
PERMITS_PATH = os.path.join(SCRIPTS_DIR, "permits_filtered.csv")
OUTPUT_PATH = os.path.join(SCRIPTS_DIR, "scored_leads.csv")


def normalize_address(addr: str) -> str:
    """Normalize an address for matching: lowercase, strip unit numbers, trim."""
    if not isinstance(addr, str):
        return ""
    addr = addr.lower().strip()
    # Remove unit/suite/apt designators and their numbers
    addr = re.sub(r"\b(unit|suite|ste|apt|#)\s*\w*", "", addr)
    # Remove extra whitespace
    addr = re.sub(r"\s+", " ", addr).strip()
    return addr


def compute_score(row: pd.Series) -> int:
    """Compute lead score (0-100) based on multiple signals."""
    score = 0

    if row.get("permit_flag"):
        score += 20

    if row.get("out_of_state_owner"):
        score += 20

    year_built = row.get("year_built")
    if pd.notna(year_built) and year_built < 1990:
        score += 15

    appraised_value = row.get("appraised_value")
    if pd.notna(appraised_value) and appraised_value > 1_000_000:
        score += 15

    unit_count = row.get("unit_count")
    if pd.notna(unit_count) and unit_count > 20:
        score += 15

    permit_status = row.get("permit_status")
    if isinstance(permit_status, str) and permit_status == "Stop Work Order":
        score += 15

    return min(score, 100)


def main():
    print("=== Join and Score Leads ===")

    # Load datasets
    hcad = pd.read_csv(HCAD_PATH)
    permits = pd.read_csv(PERMITS_PATH)

    print(f"HCAD records: {len(hcad)}")
    print(f"Permit records: {len(permits)}")

    # Normalize addresses for joining
    hcad["_norm_addr"] = hcad["property_address"].apply(normalize_address)
    permits["_norm_addr"] = permits["address"].apply(normalize_address)

    # Deduplicate permits per address, keeping the most relevant status
    # Priority: Stop Work Order > Failed Inspection > Expired
    status_priority = {"Stop Work Order": 0, "Failed Inspection": 1, "Expired": 2}
    permits["_status_rank"] = permits["status"].map(status_priority).fillna(99)
    permits = permits.sort_values("_status_rank").drop_duplicates(
        subset=["_norm_addr"], keep="first"
    )

    # Left join: all HCAD properties, enriched with permit data where matched
    merged = hcad.merge(
        permits[["_norm_addr", "permit_type", "status", "issue_date"]],
        on="_norm_addr",
        how="left",
        suffixes=("", "_permit"),
    )

    # Set permit flag
    merged["permit_flag"] = merged["status"].notna()
    merged.rename(
        columns={"status": "permit_status", "issue_date": "permit_date"},
        inplace=True,
    )

    # Ensure numeric types for scoring
    merged["year_built"] = pd.to_numeric(merged["year_built"], errors="coerce")
    merged["appraised_value"] = pd.to_numeric(merged["appraised_value"], errors="coerce")
    merged["unit_count"] = pd.to_numeric(merged["unit_count"], errors="coerce")
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
            "unit_count",
            "out_of_state_owner",
            "permit_flag",
            "permit_type",
            "permit_status",
            "permit_date",
            "lead_score",
        ]
    ].copy()

    output = output.sort_values("lead_score", ascending=False).reset_index(drop=True)

    # Clean up temp columns
    output.to_csv(OUTPUT_PATH, index=False)

    print(f"\nScored leads: {len(output)}")
    print(f"Leads with permits: {output['permit_flag'].sum()}")
    print(f"Out-of-state owners: {output['out_of_state_owner'].sum()}")
    print(f"\nScore distribution:")
    print(output["lead_score"].describe().to_string())
    print(f"\nTop 10 leads:")
    print(
        output.head(10)[
            ["property_address", "lead_score", "permit_flag", "out_of_state_owner"]
        ].to_string()
    )
    print(f"\nSaved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
