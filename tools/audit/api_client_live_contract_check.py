#!/usr/bin/env python3
"""Validate runtime client GraphQL operations against the live server schema.

Source of operations:
- client/libs/graphql/src/graphql/index.ts

This checker focuses on schema/contract validation errors and filters out
expected runtime/auth/variable-value errors.
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

ROOT = Path(__file__).resolve().parents[2]
INDEX_TS = ROOT / "client/libs/graphql/src/graphql/index.ts"
DEFAULT_JSON = ROOT / "output/audit/api-client-live-contract-report.json"
DEFAULT_MD = ROOT / "output/audit/api-client-live-contract-report.md"


EXTRACT_PATTERN = re.compile(
    r"id:\s*'([^']+)'[^\n]*\n\s*op:\s*'([^']+)'[^\n]*\n\s*query:\s*`([\s\S]*?)`",
    re.M,
)

IGNORE_PATTERNS = [
    re.compile(r"Variable '\$[A-Za-z0-9_]+' of required type .+ was not provided"),
    re.compile(r"Variable [A-Za-z0-9_]+ is not defined\.?"),
    re.compile(r"Variable '\$[A-Za-z0-9_]+' is never used"),
    re.compile(r"Operation name required in request\.?"),
    re.compile(r"Unknown fragment: "),
    re.compile(r"document does not contain an operation"),
    re.compile(r"expected EOI or executable_definition"),
]

IGNORE_SUBSTRINGS = [
    "authentication required",
    "unauthorized",
    "forbidden",
    "permission denied",
    "invalid workspace id",
    "invalid user id",
    "invalid id",
    "not found",
]

SCHEMA_ERROR_MARKERS = [
    "Unknown type",
    "Unknown field",
    "Unknown argument",
    "Invalid default value for argument",
    "must not have a selection since type",
    "is required but not provided",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def classify_op(op_id: str, op_name: str) -> str:
    key = f"{op_id} {op_name}".lower()
    if any(t in key for t in ("subscription", "invoice", "license", "checkout", "billing", "prices")):
        return "INTENTIONAL_SCOPE"
    if any(t in key for t in ("copilot", "embedding")):
        return "PARTIAL_OR_DRIFT"
    return "COMPAT_GAP"


def extract_ops() -> List[Tuple[str, str, str]]:
    txt = INDEX_TS.read_text(encoding="utf-8", errors="ignore")
    return [(m.group(1), m.group(2), m.group(3)) for m in EXTRACT_PATTERN.finditer(txt)]


def post_graphql(base_url: str, query: str, variables: Dict[str, Any]) -> Dict[str, Any]:
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/graphql",
        data=body,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def keep_message(msg: str) -> bool:
    for pattern in IGNORE_PATTERNS:
        if pattern.search(msg):
            return False
    low = msg.lower()
    for item in IGNORE_SUBSTRINGS:
        if item in low:
            return False
    return any(marker in msg for marker in SCHEMA_ERROR_MARKERS)


def run(base_url: str) -> Dict[str, Any]:
    ops = extract_ops()
    issues: List[Dict[str, Any]] = []
    checked = 0

    for op_id, op_name, query in ops:
        checked += 1
        try:
            resp = post_graphql(base_url, query, {})
        except urllib.error.URLError as exc:
            issues.append(
                {
                    "id": op_id,
                    "op": op_name,
                    "classification": "NETWORK",
                    "messages": [f"network error: {exc}"],
                }
            )
            continue

        raw_errors = resp.get("errors") or []
        msgs: List[str] = []
        for err in raw_errors:
            msg = (err.get("message") or "").strip()
            if keep_message(msg):
                msgs.append(msg)
        if not msgs:
            continue

        dedup: List[str] = []
        for msg in msgs:
            if msg not in dedup:
                dedup.append(msg)

        issues.append(
            {
                "id": op_id,
                "op": op_name,
                "classification": classify_op(op_id, op_name),
                "messages": dedup,
            }
        )

    by_class: Dict[str, int] = {}
    for issue in issues:
        cls = issue["classification"]
        by_class[cls] = by_class.get(cls, 0) + 1

    return {
        "generated_at": now_iso(),
        "target": base_url,
        "source": str(INDEX_TS),
        "checked_operations": checked,
        "issue_count": len(issues),
        "issues_by_classification": by_class,
        "issues": issues,
    }


def write_markdown(report: Dict[str, Any], out: Path) -> None:
    lines: List[str] = []
    lines.append("# API Client Live Contract Report")
    lines.append("")
    lines.append(f"Generated at: `{report['generated_at']}`")
    lines.append(f"Target: `{report['target']}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Checked operations: `{report['checked_operations']}`")
    lines.append(f"- Operations with schema issues: `{report['issue_count']}`")
    for cls, count in sorted(report["issues_by_classification"].items()):
        lines.append(f"- `{cls}`: {count}")
    lines.append("")
    lines.append("## Issues")
    lines.append("")
    if not report["issues"]:
        lines.append("- none")
    else:
        for issue in report["issues"]:
            lines.append(f"- `{issue['id']}` (`{issue['op']}`) [{issue['classification']}]")
            for msg in issue["messages"]:
                lines.append(f"  - {msg}")
    lines.append("")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate client GraphQL operations against live schema")
    parser.add_argument("--base-url", required=True, help="Server base URL, e.g. http://192.168.30.10:3010")
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--md-out", type=Path, default=DEFAULT_MD)
    parser.add_argument("--fail-on-issues", action="store_true")
    args = parser.parse_args()

    report = run(args.base_url)
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    write_markdown(report, args.md_out)

    print(f"Wrote {args.json_out}")
    print(f"Wrote {args.md_out}")
    print(f"Issues: {report['issue_count']} / {report['checked_operations']}")

    if args.fail_on_issues and report["issue_count"] > 0:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
