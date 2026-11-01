#!/usr/bin/env python3
"""Compare contract harness reports and emit an API diff summary."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def index_results(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    indexed: dict[str, dict[str, Any]] = {}
    for item in report.get("results", []):
        fixture_id = item.get("fixture_id")
        if not fixture_id:
            continue
        indexed[fixture_id] = item
    return indexed


def compare_fixture(baseline: dict[str, Any], candidate: dict[str, Any]) -> list[str]:
    deltas: list[str] = []
    if baseline.get("status") != candidate.get("status"):
        deltas.append(f"status changed: {baseline.get('status')} -> {candidate.get('status')}")

    if baseline.get("http_status") != candidate.get("http_status"):
        deltas.append(f"http_status changed: {baseline.get('http_status')} -> {candidate.get('http_status')}")

    base_excerpt = (baseline.get("response_excerpt") or "")[:200]
    cand_excerpt = (candidate.get("response_excerpt") or "")[:200]
    if base_excerpt != cand_excerpt:
        deltas.append("response_excerpt changed")

    return deltas


def build_diff(baseline: dict[str, Any], candidate: dict[str, Any]) -> dict[str, Any]:
    base_index = index_results(baseline)
    cand_index = index_results(candidate)

    all_ids = sorted(set(base_index.keys()) | set(cand_index.keys()))
    changed: list[dict[str, Any]] = []
    missing_in_candidate: list[str] = []
    new_in_candidate: list[str] = []

    for fixture_id in all_ids:
        if fixture_id not in cand_index:
            missing_in_candidate.append(fixture_id)
            continue
        if fixture_id not in base_index:
            new_in_candidate.append(fixture_id)
            continue

        delta = compare_fixture(base_index[fixture_id], cand_index[fixture_id])
        if delta:
            changed.append({"fixture_id": fixture_id, "changes": delta})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "baseline_total": len(base_index),
            "candidate_total": len(cand_index),
            "changed": len(changed),
            "missing_in_candidate": len(missing_in_candidate),
            "new_in_candidate": len(new_in_candidate),
        },
        "changed_fixtures": changed,
        "missing_in_candidate": missing_in_candidate,
        "new_in_candidate": new_in_candidate,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, help="Baseline harness JSON report")
    parser.add_argument("--candidate", required=True, help="Candidate harness JSON report")
    parser.add_argument("--out", required=True, help="Output diff JSON path")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    baseline = load_report(Path(args.baseline))
    candidate = load_report(Path(args.candidate))
    payload = build_diff(baseline, candidate)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2))
    print(f"Wrote diff report: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
