#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"

usage() {
  cat <<'EOF'
Usage:
  build/scripts/release/export-public-source.sh --revision <full-sha-or-tag> --output <archive>

Exports a deterministic source archive from the exact Git object identified
by --revision. The archive is built from `git archive` (clean object tree),
not from the working tree, and respects .gitattributes export-ignore.

The output archive is followed by a sidecar <archive>.sha256 containing
the SHA-256 of the archive and a <archive>.manifest containing the
deterministic file listing with per-entry SHA-256 hashes.
EOF
}

REVISION=""
OUTPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --revision)
      REVISION="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$REVISION" ]]; then
  echo "--revision is required" >&2
  usage >&2
  exit 2
fi

if [[ -z "$OUTPUT" ]]; then
  echo "--output is required" >&2
  usage >&2
  exit 2
fi

cd "$REPO_ROOT"

# Resolve revision to a full SHA. `git rev-parse` accepts both tags and
# short SHAs; for a curated export we want the unambiguous object.
RESOLVED_SHA="$(git rev-parse --verify "${REVISION}^{commit}" 2>/dev/null || git rev-parse --verify "$REVISION")"

if [[ -z "$RESOLVED_SHA" ]]; then
  echo "Revision '$REVISION' does not resolve to a commit" >&2
  exit 1
fi

# Verify the revision is reachable and that the working tree is not in the
# middle of an export of unrelated objects.
if ! git cat-file -e "${RESOLVED_SHA}^{commit}" 2>/dev/null; then
  echo "Revision '$REVISION' resolves to '$RESOLVED_SHA' but the commit object is not present" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
ARCHIVE="$OUTPUT"
MANIFEST="${OUTPUT}.manifest"
SHA_FILE="${OUTPUT}.sha256"
EXPORT_WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$EXPORT_WORK_DIR"' EXIT
PUBLIC_CARGO_MANIFEST="$EXPORT_WORK_DIR/Cargo.toml"

# The private root workspace also owns a mobile-only Rust crate that is outside
# the first public source scope. Materialize the public root manifest from the
# exact commit object so exported Electron-native crates do not retain a hidden
# dependency on excluded Mobile source.
git show "${RESOLVED_SHA}:Cargo.toml" > "$PUBLIC_CARGO_MANIFEST"
node --input-type=module - "$PUBLIC_CARGO_MANIFEST" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
const source = readFileSync(path, "utf8");
const publicSource = source
  .replace('  "./client/apps/mobile-native",\n', "")
  .replace(
    /\n  # Android UniFFI binding generation requires exported symbols\.\n  \[profile\.release\.package\.myoxus_mobile_native\]\n  strip = "none"\n/,
    "\n",
  );
if (publicSource === source || publicSource.includes("client/apps/mobile-native")) {
  throw new Error("root Cargo.toml public-scope transform did not remove Mobile ownership");
}
writeFileSync(path, publicSource);
NODE

# Build the archive from the clean object tree. Attributes are resolved from
# that same commit so uncommitted worktree changes cannot alter an export of a
# previously reviewed revision.
COMMIT_TIMESTAMP="$(git show -s --format=%ct "$RESOLVED_SHA")"
git archive --format=tar --prefix="" --mtime="@$COMMIT_TIMESTAMP" \
  --add-file="$PUBLIC_CARGO_MANIFEST" "$RESOLVED_SHA" > "$ARCHIVE"

# Hash the archive's regular files directly. Consumers still verify/extract
# the real archive; manifest generation does not need another full source tree.
"${MYOXUS_EXPORT_PYTHON:-python3}" - "$ARCHIVE" "$MANIFEST" "$RESOLVED_SHA" <<'PY'
import hashlib
import sys
import tarfile

archive, manifest, revision = sys.argv[1:]
hashes = {}
with tarfile.open(archive, "r|") as source:
    for entry in source:
        if not entry.isfile():
            continue
        digest = hashlib.sha256()
        with source.extractfile(entry) as content:
            while chunk := content.read(1024 * 1024):
                digest.update(chunk)
        hashes[entry.name] = digest.hexdigest()

with open(manifest, "w", encoding="utf-8", errors="surrogateescape") as output:
    output.write(f"# myoxus public-source export manifest\n# revision: {revision}\n#\n")
    for name in sorted(hashes, key=lambda value: value.encode("utf-8", "surrogateescape")):
        output.write(f"{hashes[name]}  {name}\n")
PY

ARCHIVE_SHA="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
echo "$ARCHIVE_SHA" > "$SHA_FILE"

echo "exported revision $RESOLVED_SHA to $ARCHIVE"
echo "manifest: $MANIFEST"
echo "sha256: $ARCHIVE_SHA"
