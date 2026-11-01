#!/usr/bin/env python3
"""Phase-7 functional journey coverage matrix for Myoxus API tests."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[2]
TEST_DIR = ROOT / "server" / "crates" / "api" / "tests"
DEFAULT_MD = ROOT / "learnings" / "phase7_journey_matrix_cycle1.md"
DEFAULT_JSON = ROOT / "learnings" / "phase7_journey_matrix_cycle1.json"

FN_RE = re.compile(r"^\s*(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(")


@dataclass(frozen=True)
class JourneyRule:
  name: str
  min_tests: int
  required: tuple[str, ...]


JOURNEYS: tuple[JourneyRule, ...] = (
  JourneyRule(
    name="auth",
    min_tests=3,
    required=(
      "preflight_reports_registered_flag",
      "password_sign_in_sets_session_and_session_endpoint_reads_it",
      "test_graphql_current_user_profile_contract_fields",
    ),
  ),
  JourneyRule(
    name="workspace",
    min_tests=2,
    required=(
      "test_workspace_full_flow",
      "test_root_workspace_contract_compat",
    ),
  ),
  JourneyRule(
    name="sync",
    min_tests=2,
    required=(
      "test_websocket_protocol_hardening",
      "websocket_sync_updates_and_timestamps_roundtrip",
    ),
  ),
  JourneyRule(
    name="blob",
    min_tests=2,
    required=(
      "test_blob_lifecycle_with_hmac_and_status",
      "workspace_docs_history_and_comment_attachment_routes_are_functional",
    ),
  ),
  JourneyRule(
    name="comments",
    min_tests=2,
    required=(
      "graphql_comment_threads_replies_resolve_and_edit_history_flow",
      "graphql_comment_acl_rejects_outsider_create",
    ),
  ),
  JourneyRule(
    name="notifications",
    min_tests=2,
    required=(
      "graphql_notifications_list_and_read_flow",
      "graphql_mention_creates_notification_and_read_state_flow",
    ),
  ),
  JourneyRule(
    name="search",
    min_tests=1,
    required=(
      "graphql_and_rest_search_apply_acl_paging_and_sorting",
    ),
  ),
  JourneyRule(
    name="calendar",
    min_tests=2,
    required=(
      "graphql_calendar_crud_and_reminder_status_flow",
      "calendar_google_webhook_enforces_configured_token_when_enabled",
    ),
  ),
  JourneyRule(
    name="copilot",
    min_tests=3,
    required=(
      "copilot_session_lifecycle_and_messages_are_graphql_compatible",
      "copilot_contract_session_and_message_workflow_is_consistent",
      "phase6_copilot_context_embedding_and_transcription_mutations_are_functional",
    ),
  ),
)


def iter_test_files() -> Iterable[Path]:
  for path in sorted(TEST_DIR.glob("*.rs")):
    if path.is_file():
      yield path


def collect_test_functions() -> dict[str, str]:
  found: dict[str, str] = {}
  for path in iter_test_files():
    for line in path.read_text(encoding="utf-8").splitlines():
      m = FN_RE.match(line)
      if not m:
        continue
      fn_name = m.group(1)
      if fn_name.startswith("setup_") or fn_name in {"test_state", "test_state_with", "graphql", "gql", "post_graphql"}:
        continue
      found.setdefault(fn_name, str(path.relative_to(ROOT)))
  return found


def build_matrix(found: dict[str, str]) -> dict:
  journeys = []
  uncovered = []
  for rule in JOURNEYS:
    present = [name for name in rule.required if name in found]
    missing = [name for name in rule.required if name not in found]
    covered = len(present)
    status = "covered" if covered >= rule.min_tests and not missing else "undercovered"
    entry = {
      "journey": rule.name,
      "min_tests": rule.min_tests,
      "covered_tests": covered,
      "required_tests": list(rule.required),
      "present_tests": present,
      "missing_tests": missing,
      "status": status,
    }
    journeys.append(entry)
    if status != "covered":
      uncovered.append(rule.name)

  return {
    "test_files_scanned": len(list(iter_test_files())),
    "test_functions_scanned": len(found),
    "journeys": journeys,
    "undercovered_journeys": uncovered,
    "status": "ok" if not uncovered else "needs_work",
  }


def to_markdown(matrix: dict) -> str:
  lines = [
    "# Phase 7 Journey Matrix (Cycle 1)",
    "",
    f"- Test files scanned: **{matrix['test_files_scanned']}**",
    f"- Test functions scanned: **{matrix['test_functions_scanned']}**",
    f"- Overall status: **{matrix['status']}**",
    "",
    "| Journey | Min | Covered | Status | Missing |",
    "|---|---:|---:|---|---|",
  ]
  for entry in matrix["journeys"]:
    missing = ", ".join(entry["missing_tests"]) if entry["missing_tests"] else "-"
    lines.append(
      f"| {entry['journey']} | {entry['min_tests']} | {entry['covered_tests']} | {entry['status']} | {missing} |"
    )

  if matrix["undercovered_journeys"]:
    lines.extend([
      "",
      "## Undercovered Journeys",
      "",
      ", ".join(matrix["undercovered_journeys"]),
    ])

  lines.extend([
    "",
    "## Command Block",
    "",
    "```bash",
    "cd server && TEST_DATABASE_URL=postgres://myoxus_test:myoxus_test@localhost:5434/myoxus_test \\",
    "cargo test -p myoxus-api --test auth_endpoints --test graphql_auth --test graphql_workspace --test graphql_phase2_compat \\",
    "--test websocket_protocol_test --test graphql_blob_upload --test workspace_docs_rest_compat --test graphql_comments \\",
    "--test graphql_notifications --test graphql_search --test graphql_calendar --test graphql_copilot_phase5 --test graphql_phase6_compat -- --nocapture",
    "```",
  ])

  return "\n".join(lines) + "\n"


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("--write", action="store_true", help="Write markdown/json artifacts")
  parser.add_argument("--md", type=Path, default=DEFAULT_MD, help="Markdown output path")
  parser.add_argument("--json", type=Path, default=DEFAULT_JSON, help="JSON output path")
  args = parser.parse_args()

  found = collect_test_functions()
  matrix = build_matrix(found)

  print(to_markdown(matrix))

  if args.write:
    args.md.parent.mkdir(parents=True, exist_ok=True)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.md.write_text(to_markdown(matrix), encoding="utf-8")
    args.json.write_text(json.dumps(matrix, indent=2, sort_keys=True) + "\n", encoding="utf-8")

  return 0 if matrix["status"] == "ok" else 2


if __name__ == "__main__":
  raise SystemExit(main())
