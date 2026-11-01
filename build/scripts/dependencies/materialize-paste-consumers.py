#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reproduce manifest-only pastey deltas from checksum-verified published crates."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / "vendor/cargo"
PROVENANCE = ROOT / "build/dependencies/paste-consumers-source.json"
# These checksums are the published versions previously selected by Cargo.
SOURCES = {
    "biblatex": ("0.12.0", "591eba69b7c085632e22ca03606f0bbea68d53bbe26c8962e2d549af20c6a561"),
    "hayagriva": ("0.10.1", "7b6c185c5c72546d50b25b70187f01ab9a1a2fa21c4db8691e2426fa5fce805c"),
    "safer-bytes": ("0.2.0", "9814c78d534f27a438fcb57091d6deed0634b60e4e500fee28fe5990adf5ea54"),
    "simba": ("0.9.1", "c99284beb21666094ba2b75bbceda012e610f5479dfcc2d6e2426f53197ffd95"),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inventory(directory):
    files = {}
    for path in directory.rglob("*"):
        require(not path.is_symlink(), f"Unexpected snapshot symlink: {path}")
        if path.is_file():
            files[str(path.relative_to(directory))] = path.read_bytes()
    return files


def hashes(files):
    return {path: hashlib.sha256(data).hexdigest() for path, data in sorted(files.items())}


def materialize(check):
    notice = ROOT / "build/dependencies/safer-bytes-license.txt"
    require(hashlib.sha256(notice.read_bytes()).hexdigest() ==
            "7ec9745de5874fbff4529d2f2ce807edb6de634f96e1b9455a5fd10a957bfb4d",
            "Safer-bytes MIT declaration/standard terms drift")
    if not check:
        require(not PROVENANCE.exists(), "Refusing to overwrite provenance")
    provenance = {}
    for name, (version, checksum) in SOURCES.items():
        directory = DESTINATION / name
        require(not directory.is_symlink(), f"Unexpected snapshot symlink: {directory}")
        if not check:
            require(not directory.exists(), f"Refusing to overwrite {directory}")
        url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
        with urllib.request.urlopen(url, timeout=30) as response:
            archive_bytes = response.read(10 * 1024 * 1024)
        require(hashlib.sha256(archive_bytes).hexdigest() == checksum, f"{name}: archive integrity mismatch")
        files = {}
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
            for member in archive.getmembers():
                if member.isdir():
                    continue
                path = PurePosixPath(member.name)
                require(member.isfile() and path.parts[0] == f"{name}-{version}" and ".." not in path.parts,
                        f"{name}: unexpected archive member")
                relative = str(PurePosixPath(*path.parts[1:]))
                require(relative not in files and member.size <= 10 * 1024 * 1024, f"{name}: invalid file")
                files[relative] = archive.extractfile(member).read()
        upstream = hashes(files)
        text = files["Cargo.toml"].decode()
        manifest = tomllib.loads(text)
        require(manifest["package"]["name"] == name and manifest["package"]["version"] == version,
                f"{name}: package identity drift")
        require(manifest["dependencies"]["paste"].keys() == {"version"}, f"{name}: paste declaration drift")
        text, count = re.subn(r'(\[dependencies\.paste\]\n)version = "[^"\n]+"',
                             r'\1package = "pastey"\nversion = "=0.2.3"', text)
        require(count == 1, f"{name}: dependency section drift")
        files["Cargo.toml"] = text.encode()
        # Retain the publisher's standalone lock bytes as provenance, without
        # leaving an obsolete Cargo.lock beside the patched active manifest.
        if "Cargo.lock" in files:
            files["Cargo.lock.orig"] = files.pop("Cargo.lock")
        provenance[name] = {"version": version, "url": url, "sha256": checksum,
                            "upstreamFiles": upstream, "files": hashes(files)}
        if check:
            require(inventory(directory) == files, f"{name}: snapshot drift")
        else:
            for path, data in files.items():
                target = directory / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        print(f"Verified {name} {version}: {len(files)} files; only Cargo.toml aliases pastey 0.2.3")
    encoded = (json.dumps(provenance, indent=2) + "\n").encode()
    if check:
        require(PROVENANCE.read_bytes() == encoded, "provenance drift")
    else:
        PROVENANCE.parent.mkdir(parents=True, exist_ok=True)
        PROVENANCE.write_bytes(encoded)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    materialize(parser.parse_args().check)
