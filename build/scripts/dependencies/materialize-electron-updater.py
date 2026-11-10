#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Reproduce the bounded Electron updater dependency delta from verified npm bytes."""

import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / ".yarn/vendor/electron-updater"
PACKAGE_ARCHIVE = ROOT / ".yarn/vendor/electron-updater.tgz"
PROVENANCE = ROOT / "build/dependencies/electron-updater-source.json"
URL = "https://registry.npmjs.org/electron-updater/-/electron-updater-6.8.9.tgz"
INTEGRITY = "sha512-ZhVxM9iGONUpZGI1FxdMRgJjUFXi7AYGVa5PwKlO1tV1/4zDxQmfKpXOHVztKrd6L9rLcFjERvi1Mf2vxyTkig=="


def require(condition, message):
    if not condition:
        raise ValueError(message)


def materialize(check, archive_only=False):
    with urllib.request.urlopen(URL, timeout=30) as response:
        archive_bytes = response.read(2 * 1024 * 1024)
    digest = "sha512-" + base64.b64encode(hashlib.sha512(archive_bytes).digest()).decode()
    if digest != INTEGRITY:
        raise ValueError("Electron updater npm archive integrity mismatch")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        for member in archive.getmembers():
            if member.isdir():
                continue
            path = PurePosixPath(member.name)
            if not member.isfile() or path.parts[0] != "package" or ".." in path.parts:
                raise ValueError("Unexpected archive member")
            files[str(PurePosixPath(*path.parts[1:]))] = archive.extractfile(member).read()
    upstream_hashes = {path: hashlib.sha256(data).hexdigest() for path, data in sorted(files.items())}
    manifest = json.loads(files["package.json"])
    require(manifest["name"] == "electron-updater" and manifest["version"] == "6.8.9", "package identity mismatch")
    require(manifest["dependencies"].pop("lodash.isequal") == "^4.5.0", "runtime dependency drift")
    require(manifest["devDependencies"].pop("@types/lodash.isequal") == "4.5.5", "type dependency drift")
    manifest["private"] = True
    files["package.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    helper = files["out/DownloadedUpdateHelper.js"].decode()
    old = 'const isEqual = require("lodash.isequal");'
    require(helper.count(old) == 1, "comparator import drift")
    helper = helper.replace(old, 'const { isDeepStrictEqual: isEqual } = require("node:util");')
    # The distributed map describes the original comparator import. Do not ship
    # misleading source locations for the one patched file; retain other maps.
    helper = helper.replace("//# sourceMappingURL=DownloadedUpdateHelper.js.map", "")
    files["out/DownloadedUpdateHelper.js"] = helper.encode()
    del files["out/DownloadedUpdateHelper.js.map"]
    hashes = {path: hashlib.sha256(data).hexdigest() for path, data in sorted(files.items())}
    # Directory file: identities include platform-specific stat mode bits.
    # Fixed archive bytes give Windows and POSIX hosts the same Yarn identity.
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for path, data in sorted(files.items()):
                entry = tarfile.TarInfo("package/" + path)
                entry.size = len(data)
                entry.mode = 0o644
                entry.mtime = 0
                archive.addfile(entry, io.BytesIO(data))
    package_bytes = output.getvalue()
    provenance = {
        "upstream": {"name": "electron-updater", "version": "6.8.9", "url": URL, "integrity": INTEGRITY},
        "upstreamFiles": upstream_hashes,
        "files": hashes,
        "archive": {
            "path": ".yarn/vendor/electron-updater.tgz",
            "sha256": hashlib.sha256(package_bytes).hexdigest(),
        },
    }
    provenance_bytes = (json.dumps(provenance, indent=2) + "\n").encode()
    if check or archive_only:
        recorded = json.loads(PROVENANCE.read_bytes())
        for key in ("upstream", "upstreamFiles", "files"):
            require(recorded[key] == provenance[key], "provenance drift")
        actual = {str(path.relative_to(DESTINATION)) for path in DESTINATION.rglob("*") if path.is_file()}
        require(actual == set(files), "vendored file inventory drift")
        for path, data in files.items():
            require((DESTINATION / path).read_bytes() == data, f"source drift: {path}")
        if archive_only:
            PACKAGE_ARCHIVE.write_bytes(package_bytes)
            PROVENANCE.write_bytes(provenance_bytes)
        else:
            require(PROVENANCE.read_bytes() == provenance_bytes, "archive provenance drift")
            require(PACKAGE_ARCHIVE.read_bytes() == package_bytes, "package archive drift")
    else:
        if DESTINATION.exists() or PROVENANCE.exists():
            raise ValueError("Refusing to overwrite an existing snapshot; use --check")
        for path, data in files.items():
            target = DESTINATION / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        PROVENANCE.parent.mkdir(parents=True, exist_ok=True)
        PROVENANCE.write_bytes(provenance_bytes)
        PACKAGE_ARCHIVE.write_bytes(package_bytes)
    print(f"Verified electron-updater 6.8.9: {len(files)} files, native metadata equality, no Lodash edge")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--archive", action="store_true", help="Validate the existing snapshot and materialize only its portable package archive")
    args = parser.parse_args()
    require(not (args.check and args.archive), "Choose --check or --archive")
    materialize(args.check, args.archive)
