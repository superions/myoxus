#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Validate Cargo declarations and security-PR fixes before compilation (Python 3.11+)."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib
import urllib.request


ROOT = Path(__file__).resolve().parents[3]


def metadata(manifest, *, resolve=False):
    command = ["cargo", "metadata", "--locked", "--format-version", "1",
               "--manifest-path", str(manifest)]
    if not resolve:
        command.append("--no-deps")
    result = subprocess.run(command, cwd=ROOT, check=True, capture_output=True,
                            text=True, timeout=180)
    return json.loads(result.stdout)


def inherited_names(document):
    # Target-specific and build/dev dependencies count as real consumers too.
    names = set()
    for section in (document, *document.get("target", {}).values()):
        for kind in ("dependencies", "dev-dependencies", "build-dependencies"):
            names.update(name for name, value in section.get(kind, {}).items()
                         if isinstance(value, dict) and value.get("workspace") is True)
    return names


def inspect_workspace(manifest):
    document = tomllib.loads(manifest.read_text())
    graph = metadata(manifest)
    members = set(graph["workspace_members"])
    used = set()
    for package in graph["packages"]:
        if package["id"] in members:
            used.update(inherited_names(tomllib.loads(Path(package["manifest_path"]).read_text())))
    declared = set(document.get("workspace", {}).get("dependencies", {}))
    return sorted(declared - used)


def osv(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("https://api.osv.dev/v1/" + path, data=data,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def security_advisories(event):
    pull = event.get("pull_request", {})
    branch = pull.get("head", {}).get("ref", "")
    title = pull.get("title", "")
    labels = {label["name"] for label in pull.get("labels", [])}
    if not branch.startswith("renovate/") or ("[security]" not in title.lower() and "security" not in labels):
        return []
    identifiers = sorted(set(re.findall(r"\b(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|RUSTSEC-\d{4}-\d{4})\b",
                                       pull.get("body", ""))))
    if not identifiers:
        raise ValueError("Security PR contains no advisory identifiers")
    return [osv("vulns/" + identifier) for identifier in identifiers]


def verify_security_targets(manifests, advisories):
    expected = set()
    names = set()
    for advisory in advisories:
        if advisory.get("withdrawn"):
            continue
        expected.update([advisory["id"], *advisory.get("aliases", [])])
        names.update(entry["package"]["name"] for entry in advisory.get("affected", [])
                     if entry.get("package", {}).get("ecosystem") == "crates.io")
    if not names:
        return [], []
    packages = set()
    for manifest in manifests:
        graph = metadata(manifest, resolve=True)
        if not isinstance(graph.get("resolve"), dict):
            raise ValueError("Cargo did not return a resolved dependency graph")
        reachable = {node["id"] for node in graph["resolve"]["nodes"]}
        for package in graph["packages"]:
            if (package["id"] in reachable and package["name"] in names
                    and (package.get("source") or "").startswith("registry+")):
                packages.add((package["name"], package["version"]))
    packages = sorted(packages)
    findings = []
    for start in range(0, len(packages), 100):
        batch = packages[start:start + 100]
        result = osv("querybatch", {"queries": [
            {"package": {"name": name, "ecosystem": "crates.io"}, "version": version}
            for name, version in batch]})
        rows = result.get("results")
        if not isinstance(rows, list) or len(rows) != len(batch):
            raise ValueError("Invalid OSV batch response")
        for (name, version), row in zip(batch, rows):
            if row.get("next_page_token"):
                raise ValueError("Incomplete OSV response; security fix cannot be established")
            for vulnerability in row.get("vulns", []):
                if vulnerability["id"] in expected:
                    findings.append(f"{name}@{version} still affected by {vulnerability['id']}")
    return packages, findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-file", default=os.environ.get("GITHUB_EVENT_PATH"))
    parser.add_argument("--report", default="output/ci/cargo-source-policy.json")
    args = parser.parse_args()
    report = Path(args.report)
    # A failed API/metadata operation must not leave a prior green report.
    report.unlink(missing_ok=True)
    manifests = [ROOT / "Cargo.toml", ROOT / "server/Cargo.toml"]
    findings = []
    for manifest in manifests:
        unused = inspect_workspace(manifest)
        findings.extend(f"{manifest.relative_to(ROOT)}: unused workspace dependency {name}" for name in unused)
    # Reject dead catalog entries before doing any network-backed resolution.
    packages = []
    if not findings:
        event = json.loads(Path(args.event_file).read_text()) if args.event_file else {}
        advisories = security_advisories(event)
        packages, findings = verify_security_targets(manifests, advisories)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"packages": packages, "findings": findings}, indent=2) + "\n")
    for finding in findings:
        print(finding, file=sys.stderr)
    if findings:
        return 1
    print("Cargo dependency declarations and security-PR targets are valid.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Cargo dependency source validation failed: {error}", file=sys.stderr)
        sys.exit(1)
