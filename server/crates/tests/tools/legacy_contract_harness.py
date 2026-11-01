#!/usr/bin/env python3
"""Legacy contract harness for GraphQL, REST, cookies, and Socket.io path checks."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any
from urllib import error, parse, request


REPO_ROOT = Path(__file__).resolve().parents[5]
FIXTURES_DIR = REPO_ROOT / "servers/rust/crates/tests/fixtures"


@dataclass
class FixtureResult:
    fixture_id: str
    passed: bool
    status: int | None
    reason: str
    response_headers: dict[str, str]
    observed_cookies: list[dict[str, str]]
    elapsed_ms: int
    response_excerpt: str


def load_fixtures(path: Path) -> list[dict[str, Any]]:
    fixtures: list[dict[str, Any]] = []
    for fixture_file in sorted(path.glob("*.json")):
        fixtures.append(json.loads(fixture_file.read_text(encoding="utf-8")))
    return fixtures


def get_nested(data: dict[str, Any], dotted_path: str) -> Any:
    current: Any = data
    for part in dotted_path.split("."):
        if not isinstance(current, dict) or part not in current:
            raise KeyError(dotted_path)
        current = current[part]
    return current


def ensure_expectations(
    fixture: dict[str, Any],
    status: int,
    headers: dict[str, str],
    response_text: str,
    response_json: dict[str, Any] | None,
) -> tuple[bool, str]:
    expect = fixture.get("expect", {})

    allowed = expect.get("status_any")
    if allowed and status not in allowed:
        return False, f"status {status} not in expected {allowed}"

    ctype_contains = expect.get("content_type_contains")
    content_type = headers.get("content-type", "")
    if ctype_contains and ctype_contains not in content_type:
        return False, f"content-type '{content_type}' does not contain '{ctype_contains}'"

    body_contains = expect.get("body_contains")
    if body_contains and body_contains not in response_text:
        return False, "response body does not contain expected marker"

    body_prefix = expect.get("body_prefix")
    if body_prefix and not response_text.startswith(body_prefix):
        return False, f"response body does not start with '{body_prefix}'"

    json_paths = expect.get("json_path_exists", [])
    if json_paths:
        if response_json is None:
            return False, "expected JSON response but body is not JSON"
        for path in json_paths:
            try:
                _ = get_nested(response_json, path)
            except KeyError:
                return False, f"json path missing: {path}"

    return True, "ok"


def extract_cookies(cookie_jar: CookieJar) -> list[dict[str, str]]:
    cookies: list[dict[str, str]] = []
    for cookie in cookie_jar:
        cookies.append(
            {
                "name": cookie.name,
                "value_preview": cookie.value[:10],
                "domain": cookie.domain,
                "path": cookie.path,
            }
        )
    return cookies


def execute_http_fixture(
    fixture: dict[str, Any],
    base_url: str,
    opener: request.OpenerDirector,
    cookie_jar: CookieJar,
) -> FixtureResult:
    start = time.time()
    fixture_id = fixture["id"]
    spec = fixture["request"]

    method = spec.get("method", "GET").upper()
    path = spec.get("path", "/")
    headers = dict(spec.get("headers", {}))
    body = spec.get("json")
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.setdefault("content-type", "application/json")

    url = base_url.rstrip("/") + path
    req = request.Request(url=url, method=method, headers=headers, data=data)

    status = None
    response_headers: dict[str, str] = {}
    response_text = ""
    response_json: dict[str, Any] | None = None

    try:
        with opener.open(req, timeout=10) as resp:
            status = resp.getcode()
            response_headers = {key.lower(): value for key, value in resp.headers.items()}
            response_text = resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        status = exc.code
        response_headers = {key.lower(): value for key, value in exc.headers.items()}
        response_text = exc.read().decode("utf-8", errors="replace")
    except Exception as exc:  # pragma: no cover - operational failure
        elapsed = int((time.time() - start) * 1000)
        return FixtureResult(
            fixture_id=fixture_id,
            passed=False,
            status=None,
            reason=f"request failed: {exc}",
            response_headers=response_headers,
            observed_cookies=extract_cookies(cookie_jar),
            elapsed_ms=elapsed,
            response_excerpt=response_text[:300],
        )

    try:
        response_json = json.loads(response_text)
    except json.JSONDecodeError:
        response_json = None

    passed, reason = ensure_expectations(fixture, status, response_headers, response_text, response_json)
    elapsed = int((time.time() - start) * 1000)
    return FixtureResult(
        fixture_id=fixture_id,
        passed=passed,
        status=status,
        reason=reason,
        response_headers=response_headers,
        observed_cookies=extract_cookies(cookie_jar),
        elapsed_ms=elapsed,
        response_excerpt=response_text[:300],
    )


def execute_graphql_fixture(
    fixture: dict[str, Any],
    base_url: str,
    opener: request.OpenerDirector,
    cookie_jar: CookieJar,
) -> FixtureResult:
    spec = fixture["request"]
    gql_request = {
        "query": spec["query"],
        "variables": spec.get("variables", {}),
    }
    proxy_fixture = {
        "id": fixture["id"],
        "request": {
            "method": "POST",
            "path": spec.get("path", "/graphql"),
            "headers": spec.get("headers", {}),
            "json": gql_request,
        },
        "expect": fixture.get("expect", {}),
    }
    return execute_http_fixture(proxy_fixture, base_url, opener, cookie_jar)


def execute_socket_handshake_fixture(
    fixture: dict[str, Any],
    base_url: str,
    opener: request.OpenerDirector,
    cookie_jar: CookieJar,
) -> FixtureResult:
    start = time.time()
    fixture_id = fixture["id"]
    spec = fixture["request"]

    params = dict(spec.get("query", {}))
    if "t" not in params:
        params["t"] = str(int(time.time() * 1000))
    query = parse.urlencode(params)
    path = spec.get("path", "/socket.io/")
    url = base_url.rstrip("/") + path
    if query:
        url = f"{url}?{query}"

    req = request.Request(url=url, method="GET", headers=spec.get("headers", {}))
    status = None
    response_headers: dict[str, str] = {}
    response_text = ""

    try:
        with opener.open(req, timeout=10) as resp:
            status = resp.getcode()
            response_headers = {key.lower(): value for key, value in resp.headers.items()}
            response_text = resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as exc:
        status = exc.code
        response_headers = {key.lower(): value for key, value in exc.headers.items()}
        response_text = exc.read().decode("utf-8", errors="replace")
    except Exception as exc:  # pragma: no cover - operational failure
        elapsed = int((time.time() - start) * 1000)
        return FixtureResult(
            fixture_id=fixture_id,
            passed=False,
            status=None,
            reason=f"handshake failed: {exc}",
            response_headers=response_headers,
            observed_cookies=extract_cookies(cookie_jar),
            elapsed_ms=elapsed,
            response_excerpt=response_text[:300],
        )

    passed, reason = ensure_expectations(fixture, status, response_headers, response_text, None)
    elapsed = int((time.time() - start) * 1000)
    return FixtureResult(
        fixture_id=fixture_id,
        passed=passed,
        status=status,
        reason=reason,
        response_headers=response_headers,
        observed_cookies=extract_cookies(cookie_jar),
        elapsed_ms=elapsed,
        response_excerpt=response_text[:300],
    )


def should_skip_fixture(fixture: dict[str, Any], include_optional: bool) -> tuple[bool, str]:
    if not include_optional and not fixture.get("smoke", False):
        return True, "not part of smoke suite"

    required_env = fixture.get("requires_env", [])
    missing = [name for name in required_env if not os.getenv(name)]
    if missing:
        return True, f"missing environment variables: {missing}"

    return False, ""


def run(fixtures: list[dict[str, Any]], base_url: str, include_optional: bool) -> dict[str, Any]:
    cookie_jar = CookieJar()
    opener = request.build_opener(request.HTTPCookieProcessor(cookie_jar))

    results: list[dict[str, Any]] = []
    passed = 0
    failed = 0
    skipped = 0

    for fixture in fixtures:
        skip, reason = should_skip_fixture(fixture, include_optional=include_optional)
        if skip:
            skipped += 1
            results.append(
                {
                    "fixture_id": fixture["id"],
                    "status": "skipped",
                    "reason": reason,
                }
            )
            continue

        kind = fixture["kind"]
        if kind == "rest":
            result = execute_http_fixture(fixture, base_url, opener, cookie_jar)
        elif kind == "graphql":
            result = execute_graphql_fixture(fixture, base_url, opener, cookie_jar)
        elif kind == "socketio_handshake":
            result = execute_socket_handshake_fixture(fixture, base_url, opener, cookie_jar)
        else:
            failed += 1
            results.append(
                {
                    "fixture_id": fixture["id"],
                    "status": "failed",
                    "reason": f"unsupported fixture kind: {kind}",
                }
            )
            continue

        status_label = "passed" if result.passed else "failed"
        if result.passed:
            passed += 1
        else:
            failed += 1

        results.append(
            {
                "fixture_id": result.fixture_id,
                "kind": kind,
                "status": status_label,
                "http_status": result.status,
                "reason": result.reason,
                "elapsed_ms": result.elapsed_ms,
                "response_headers": result.response_headers,
                "observed_cookies": result.observed_cookies,
                "response_excerpt": result.response_excerpt,
            }
        )

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "base_url": base_url,
        "summary": {
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
            "total": len(fixtures),
        },
        "results": results,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:3010", help="Legacy server base URL")
    parser.add_argument("--fixtures-dir", default=str(FIXTURES_DIR), help="Fixture directory")
    parser.add_argument("--report-out", default="", help="Optional JSON report output file")
    parser.add_argument("--include-optional", action="store_true", help="Run optional fixtures")
    parser.add_argument("--validate-only", action="store_true", help="Validate fixtures but do not execute network calls")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fixtures = load_fixtures(Path(args.fixtures_dir))
    if args.validate_only:
        print(f"Validated fixture files: {len(fixtures)}")
        return 0

    report = run(fixtures=fixtures, base_url=args.base_url, include_optional=args.include_optional)
    print(json.dumps(report["summary"], indent=2))

    if args.report_out:
        out_path = Path(args.report_out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        print(f"Wrote report: {out_path}")

    return 1 if report["summary"]["failed"] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
