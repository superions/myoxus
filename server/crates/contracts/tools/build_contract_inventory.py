#!/usr/bin/env python3
"""Regenerate the canonical client GraphQL operation inventory."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def find_repo_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "package.json").exists() and (candidate / "server").exists():
            return candidate
    raise RuntimeError(f"Unable to detect repository root from {start}")


REPO_ROOT = find_repo_root(Path(__file__).resolve())
GRAPHQL_ROOT = REPO_ROOT / "client/libs/graphql/src/graphql"
OUT_FILE = REPO_ROOT / "server/crates/contracts/inventory/graphql_operations.json"
OP_RE = re.compile(
    r"^\s*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)\b",
    re.MULTILINE,
)


def repo_rel(path: Path) -> str:
    return str(path.relative_to(REPO_ROOT)).replace("\\", "/")


def build_graphql_inventory() -> dict[str, Any]:
    if not GRAPHQL_ROOT.is_dir():
        raise RuntimeError(
            f"GraphQL source root does not exist: {repo_rel(GRAPHQL_ROOT)}"
        )

    operations: list[dict[str, str]] = []
    for gql_file in sorted(GRAPHQL_ROOT.rglob("*.gql")):
        text = gql_file.read_text(encoding="utf-8")
        for match in OP_RE.finditer(text):
            operations.append(
                {
                    "operation_type": match.group(1),
                    "operation_name": match.group(2),
                }
            )

    if not operations:
        raise RuntimeError(
            f"No GraphQL operations found below {repo_rel(GRAPHQL_ROOT)}"
        )

    operations.sort(key=lambda item: (item["operation_type"], item["operation_name"]))
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_root": repo_rel(GRAPHQL_ROOT),
        "total_operations": len(operations),
        "operations": operations,
    }


def write_json(payload: dict[str, Any]) -> None:
    if OUT_FILE.exists():
        existing = json.loads(OUT_FILE.read_text(encoding="utf-8"))
        existing_timestamp = existing.get("generated_at")
        if isinstance(existing_timestamp, str):
            comparable = dict(payload)
            comparable["generated_at"] = existing_timestamp
            if existing == comparable:
                payload = comparable
    OUT_FILE.write_text(
        json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )


def main() -> None:
    payload = build_graphql_inventory()
    write_json(payload)
    print(
        "Generated contract inventory: "
        f"graphql_operations.json ({payload['total_operations']} operations)"
    )


if __name__ == "__main__":
    main()
