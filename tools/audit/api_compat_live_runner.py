#!/usr/bin/env python3
"""Run API compatibility live checks against the new server.

Input is a machine-readable matrix JSON. Checks cover REST, GraphQL schema/ops,
Socket.IO polling, and SSE compatibility contracts.
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MATRIX = ROOT / "docs/dev/server/api-compatibility-live-matrix.json"
DEFAULT_JSON_OUT = ROOT / "output/audit/api-compat-live-report.json"
DEFAULT_MD_OUT = ROOT / "output/audit/api-compat-live-report.md"

INTROSPECTION_QUERY = {
    "query": "query { __schema { queryType { fields { name } } mutationType { fields { name } } types { name fields { name } } } }"
}


@dataclass
class HttpResult:
    status: int
    body_text: str


def build_opener(insecure: bool = False) -> urllib.request.OpenerDirector:
    handlers: List[Any] = [urllib.request.HTTPCookieProcessor()]
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(*handlers)


def urljoin(base_url: str, path: str) -> str:
    if not path.startswith("/"):
        path = "/" + path
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))


def run_http(
    opener: urllib.request.OpenerDirector,
    method: str,
    url: str,
    timeout: float,
    json_body: Optional[Dict[str, Any]] = None,
    extra_headers: Optional[Dict[str, str]] = None,
    read_limit: Optional[int] = None,
) -> HttpResult:
    headers = {"Accept": "application/json"}
    data: Optional[bytes] = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)

    req = urllib.request.Request(url=url, data=data, method=method.upper(), headers=headers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            if read_limit is None:
                raw = resp.read()
            else:
                raw = resp.read(read_limit)
            text = raw.decode("utf-8", errors="replace")
            return HttpResult(status=getattr(resp, "status", 200), body_text=text)
    except urllib.error.HTTPError as e:
        raw = b""
        try:
            if read_limit is None:
                raw = e.read()
            else:
                raw = e.read(read_limit)
        except Exception:
            raw = b""
        return HttpResult(status=e.code, body_text=raw.decode("utf-8", errors="replace"))
    except urllib.error.URLError as e:
        return HttpResult(status=0, body_text=f"network error: {e}")


def try_login(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    timeout: float,
    email: Optional[str],
    password: Optional[str],
) -> Tuple[bool, Optional[int], str]:
    if not email or not password:
        return False, None, "login skipped (no credentials provided)"

    url = urljoin(base_url, "/api/auth/sign-in")
    resp = run_http(
        opener,
        "POST",
        url,
        timeout,
        json_body={"email": email, "password": password},
    )
    if resp.status == 200:
        return True, resp.status, "login successful"
    return False, resp.status, f"login failed (status={resp.status})"


def fetch_introspection(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    timeout: float,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    url = urljoin(base_url, "/graphql")
    resp = run_http(opener, "POST", url, timeout, json_body=INTROSPECTION_QUERY)
    if resp.status != 200:
        return None, f"introspection status {resp.status}"
    try:
        payload = json.loads(resp.body_text)
    except json.JSONDecodeError as exc:
        return None, f"introspection json decode error: {exc}"
    if "errors" in payload:
        return None, f"introspection returned errors: {payload['errors']}"
    return payload, None


def field_exists(
    introspection: Dict[str, Any], root: str, field: str, owner_type: Optional[str] = None
) -> bool:
    schema = introspection.get("data", {}).get("__schema", {})
    if owner_type:
        matching_types = [
            item
            for item in schema.get("types", [])
            if isinstance(item, dict) and item.get("name") == owner_type
        ]
        fields = matching_types[0].get("fields", []) if matching_types else []
    elif root == "query":
        fields = schema.get("queryType", {}).get("fields", [])
    else:
        fields = schema.get("mutationType", {}).get("fields", [])
    names = {item.get("name") for item in fields if isinstance(item, dict)}
    return field in names


def check_status(expected: List[int], actual: int) -> bool:
    return actual in expected


def body_contains_all(body: str, needles: List[str]) -> bool:
    return all(needle in body for needle in needles)


def run_check(
    check: Dict[str, Any],
    opener: urllib.request.OpenerDirector,
    base_url: str,
    timeout: float,
    introspection: Optional[Dict[str, Any]],
    introspection_error: Optional[str],
) -> Dict[str, Any]:
    protocol = check.get("protocol")
    check_id = check.get("id", "unknown")
    result: Dict[str, Any] = {
        "id": check_id,
        "protocol": protocol,
        "pass": False,
        "status": None,
        "details": "",
    }

    try:
        if protocol in {"rest", "socketio"}:
            method = check.get("method", "GET")
            path = check.get("path")
            url = urljoin(base_url, path)
            expected = check.get("expected_status_any", [200])
            headers = check.get("headers")
            json_body = check.get("json_body")
            read_limit = 4096 if protocol == "socketio" else None
            resp = run_http(opener, method, url, timeout, json_body=json_body, extra_headers=headers, read_limit=read_limit)
            result["status"] = resp.status
            if not check_status(expected, resp.status):
                result["details"] = f"unexpected status {resp.status}, expected one of {expected}"
                return result
            body_needles = check.get("expect_body_contains", [])
            if body_needles and not body_contains_all(resp.body_text, body_needles):
                result["details"] = f"body missing expected snippets {body_needles}"
                return result
            result["pass"] = True
            result["details"] = "ok"
            return result

        if protocol == "sse":
            method = check.get("method", "GET")
            path = check.get("path")
            url = urljoin(base_url, path)
            expected = check.get("expected_status_any", [200])
            headers = {"Accept": "text/event-stream"}
            resp = run_http(opener, method, url, timeout, extra_headers=headers, read_limit=8192)
            result["status"] = resp.status
            if not check_status(expected, resp.status):
                result["details"] = f"unexpected status {resp.status}, expected one of {expected}"
                return result
            status_expect = check.get("expect_body_contains_when_status", {})
            required = status_expect.get(str(resp.status), [])
            if required and not body_contains_all(resp.body_text, required):
                result["details"] = f"status {resp.status} body missing {required}"
                return result
            result["pass"] = True
            result["details"] = "ok"
            return result

        if protocol == "graphql_query":
            url = urljoin(base_url, "/graphql")
            expected = check.get("expected_status_any", [200])
            payload = {"query": check.get("query", ""), "variables": check.get("variables", {})}
            resp = run_http(opener, "POST", url, timeout, json_body=payload)
            result["status"] = resp.status
            if not check_status(expected, resp.status):
                result["details"] = f"unexpected status {resp.status}, expected one of {expected}"
                return result
            try:
                body = json.loads(resp.body_text)
            except json.JSONDecodeError as exc:
                result["details"] = f"graphql response not json: {exc}"
                return result
            if check.get("expect_no_errors", False) and "errors" in body:
                result["details"] = f"graphql returned errors: {body['errors']}"
                return result
            result["pass"] = True
            result["details"] = "ok"
            return result

        if protocol == "graphql_field":
            root = check.get("root")
            field = check.get("field")
            owner_type = check.get("owner_type")
            if introspection is None:
                result["details"] = f"introspection unavailable: {introspection_error}"
                return result
            exists = field_exists(introspection, root, field, owner_type)
            result["pass"] = bool(exists)
            owner = owner_type or root
            result["details"] = "ok" if exists else f"missing {owner} field '{field}'"
            return result

        result["details"] = f"unsupported protocol '{protocol}'"
        return result

    except Exception as exc:  # broad on purpose for robust matrix runs
        result["details"] = f"exception: {exc}"
        return result


def summarise(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "total": len(results),
        "passed": sum(1 for r in results if r.get("pass")),
        "failed": sum(1 for r in results if not r.get("pass")),
        "by_protocol": {},
    }
    by_protocol: Dict[str, Dict[str, int]] = {}
    for r in results:
        p = r.get("protocol", "unknown")
        bucket = by_protocol.setdefault(p, {"total": 0, "passed": 0, "failed": 0})
        bucket["total"] += 1
        if r.get("pass"):
            bucket["passed"] += 1
        else:
            bucket["failed"] += 1
    summary["by_protocol"] = by_protocol
    return summary


def write_markdown(report: Dict[str, Any], out: Path) -> None:
    lines: List[str] = []
    lines.append("# API Compat Live Report (New Server)")
    lines.append("")
    lines.append(f"Target: `{report['base_url']}`")
    lines.append("")
    login = report.get("login", {})
    lines.append(f"- Login attempted: `{login.get('attempted', False)}`")
    lines.append(f"- Login active: `{login.get('active', False)}`")
    lines.append(f"- Login note: `{login.get('message', '')}`")
    lines.append("")

    summary = report["summary"]
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Total checks: {summary['total']}")
    lines.append(f"- Passed: {summary['passed']}")
    lines.append(f"- Failed: {summary['failed']}")
    lines.append("")

    lines.append("## By Protocol")
    lines.append("")
    for protocol, bucket in summary["by_protocol"].items():
        lines.append(
            f"- `{protocol}`: {bucket['passed']}/{bucket['total']} passed ({bucket['failed']} failed)"
        )
    lines.append("")

    lines.append("## Failed Checks")
    lines.append("")
    failed = [r for r in report["results"] if not r.get("pass")]
    if not failed:
        lines.append("- none")
    else:
        for r in failed:
            status = r.get("status")
            lines.append(f"- [GAP] `{r['id']}` ({r['protocol']}) status={status} detail={r.get('details')}")
    lines.append("")

    lines.append("## All Checks")
    lines.append("")
    for r in report["results"]:
        tag = "PASS" if r.get("pass") else "FAIL"
        status = "-" if r.get("status") is None else str(r.get("status"))
        lines.append(f"- [{tag}] `{r['id']}` ({r['protocol']}) status={status} {r.get('details', '')}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run API compatibility matrix live checks")
    parser.add_argument("--base-url", required=True, help="Base URL of the new server, e.g. http://localhost:3001")
    parser.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON_OUT)
    parser.add_argument("--md-out", type=Path, default=DEFAULT_MD_OUT)
    parser.add_argument("--timeout", type=float, default=12.0)
    parser.add_argument("--login-email", default=None)
    parser.add_argument("--login-password", default=None)
    parser.add_argument("--insecure", action="store_true", help="Disable TLS verification for HTTPS targets")
    parser.add_argument("--allow-fail", action="store_true", help="Always exit 0 even if checks fail")
    args = parser.parse_args()

    matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
    checks = matrix.get("checks", [])

    opener = build_opener(insecure=args.insecure)
    login_active, login_status, login_message = try_login(
        opener,
        args.base_url,
        args.timeout,
        args.login_email,
        args.login_password,
    )

    introspection, introspection_error = fetch_introspection(opener, args.base_url, args.timeout)

    results: List[Dict[str, Any]] = []
    for check in checks:
        results.append(
            run_check(
                check,
                opener,
                args.base_url,
                args.timeout,
                introspection,
                introspection_error,
            )
        )

    report = {
        "base_url": args.base_url,
        "matrix_path": str(args.matrix),
        "login": {
            "attempted": bool(args.login_email and args.login_password),
            "active": login_active,
            "status": login_status,
            "message": login_message,
        },
        "introspection_error": introspection_error,
        "summary": summarise(results),
        "results": results,
    }

    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    write_markdown(report, args.md_out)

    print(f"Wrote {args.json_out}")
    print(f"Wrote {args.md_out}")
    print(f"Passed: {report['summary']['passed']} / {report['summary']['total']}")

    if args.allow_fail:
        return 0
    return 0 if report["summary"]["failed"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
