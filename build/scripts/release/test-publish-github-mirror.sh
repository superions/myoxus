#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SOURCE="$TMP/source"
PUBLIC="$TMP/public.git"

mkdir -p "$SOURCE/build/scripts/release" "$SOURCE/build/scripts/ci"
cp "$ROOT/build/scripts/release/publish-github-mirror.sh" "$SOURCE/build/scripts/release/"
cat >"$SOURCE/build/scripts/release/export-public-source.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd -P)"; revision=""; output=""
while [[ $# -gt 0 ]]; do case "$1" in --revision) revision="$2";; --output) output="$2";; esac; shift 2; done
git -C "$root" archive --format=tar "$revision" >"$output"
tar -tf "$output" | LC_ALL=C sort >"$output.manifest"
sha256sum "$output" | awk '{print $1}' >"$output.sha256"
EOF
chmod +x "$SOURCE/build/scripts/release/"*.sh
printf 'process.exit(0);\n' >"$SOURCE/build/scripts/ci/verify-public-source-export.mjs"
printf 'process.exit(0);\n' >"$SOURCE/build/scripts/ci/scan-public-source-secrets.mjs"
printf 'first public body\n' >"$SOURCE/README.md"
printf 'security route\n' >"$SOURCE/SECURITY.md"
printf '/*.md\n' >"$SOURCE/.gitignore"
git -C "$SOURCE" init -q --initial-branch=wip
git -C "$SOURCE" config user.name Fixture
git -C "$SOURCE" config user.email fixture@example.invalid
git -C "$SOURCE" add --force .
git -C "$SOURCE" commit -q -m source-one
SOURCE_ONE="$(git -C "$SOURCE" rev-parse HEAD)"

SCAFFOLD="$TMP/scaffold"
mkdir "$SCAFFOLD"; git -C "$SCAFFOLD" init -q --initial-branch=main
git -C "$SCAFFOLD" config user.name Fixture
git -C "$SCAFFOLD" config user.email fixture@example.invalid
printf 'scaffold\n' >"$SCAFFOLD/README.md"
mkdir "$SCAFFOLD/Casks"
printf 'published client cask\n' >"$SCAFFOLD/Casks/myoxus.rb"
printf 'obsolete scaffold\n' >"$SCAFFOLD/obsolete.txt"
git -C "$SCAFFOLD" add .; git -C "$SCAFFOLD" commit -q -m scaffold
SCAFFOLD_SHA="$(git -C "$SCAFFOLD" rev-parse HEAD)"
git clone -q --bare "$SCAFFOLD" "$PUBLIC"

identity() { sed -n "s/^$2=//p" "$1/candidate-identities.txt"; }
prepare() {
  "$SOURCE/build/scripts/release/publish-github-mirror.sh" prepare \
    --revision "$2" --expected-parent "$3" --workdir "$1" \
    --github-url "$PUBLIC" --github-api "file://fixture"
}
publish() {
  "$SOURCE/build/scripts/release/publish-github-mirror.sh" publish --workdir "$1" \
    --expected-source "$(identity "$1" source_revision)" \
    --expected-parent "$(identity "$1" public_parent)" \
    --expected-commit "$(identity "$1" candidate_commit)" \
    --expected-tree "$(identity "$1" candidate_tree)" \
    --expected-archive-sha256 "$(identity "$1" archive_sha256)" \
    --expected-manifest-sha256 "$(identity "$1" manifest_sha256)" \
    --expected-settings-sha256 "$(identity "$1" settings_sha256)" \
    --github-url "$PUBLIC" --github-api "file://fixture"
}

prepare "$TMP/first" "$SOURCE_ONE" "$SCAFFOLD_SHA"
FIRST="$(identity "$TMP/first" candidate_commit)"
test "$(git -C "$TMP/first/snapshot" show -s --format=%B "$FIRST")" = "Public Myoxus source snapshot"
test "$(git -C "$TMP/first/snapshot" rev-parse "$FIRST^")" = "$SCAFFOLD_SHA"
test "$(git -C "$TMP/first/snapshot" rev-list --count "$SCAFFOLD_SHA..$FIRST")" = 1
git -C "$TMP/first/snapshot" cat-file -e "$FIRST:README.md"
git -C "$TMP/first/snapshot" cat-file -e "$FIRST:SECURITY.md"
test "$(git -C "$TMP/first/snapshot" show "$FIRST:Casks/myoxus.rb")" = 'published client cask'
if git -C "$TMP/first/snapshot" cat-file -e "$FIRST:obsolete.txt" 2>/dev/null; then
  echo 'unmanaged public scaffold was retained' >&2; exit 1
fi
publish "$TMP/first"
test "$(git --git-dir="$PUBLIC" rev-parse main)" = "$FIRST"

printf 'second public body\n' >"$SOURCE/README.md"
git -C "$SOURCE" add README.md; git -C "$SOURCE" commit -q -m source-two
SOURCE_TWO="$(git -C "$SOURCE" rev-parse HEAD)"
prepare "$TMP/second" "$SOURCE_TWO" "$FIRST"
SECOND="$(identity "$TMP/second" candidate_commit)"
test "$(git -C "$TMP/second/snapshot" rev-parse "$SECOND^")" = "$FIRST"
test "$(git -C "$TMP/second/snapshot" show "$SECOND:Casks/myoxus.rb")" = 'published client cask'
publish "$TMP/second"
test "$(git --git-dir="$PUBLIC" rev-parse main)" = "$SECOND"

printf 'third public body\n' >"$SOURCE/README.md"
git -C "$SOURCE" add README.md; git -C "$SOURCE" commit -q -m source-three
prepare "$TMP/moved" "$(git -C "$SOURCE" rev-parse HEAD)" "$SECOND"
MOVER="$TMP/mover"; git clone -q "$PUBLIC" "$MOVER"
git -C "$MOVER" config user.name Fixture; git -C "$MOVER" config user.email fixture@example.invalid
printf 'remote moved\n' >"$MOVER/moved.txt"; git -C "$MOVER" add .; git -C "$MOVER" commit -q -m moved
git -C "$MOVER" push -q origin main
if publish "$TMP/moved" >"$TMP/moved.out" 2>"$TMP/moved.err"; then
  echo 'moved remote was accepted' >&2; exit 1
fi
grep -Eq 'moved|diverged' "$TMP/moved.err"

DIVERGED="$TMP/diverged"; mkdir "$DIVERGED"; git -C "$DIVERGED" init -q --initial-branch=main
git -C "$DIVERGED" config user.name Fixture; git -C "$DIVERGED" config user.email fixture@example.invalid
printf 'unrelated\n' >"$DIVERGED/unrelated"; git -C "$DIVERGED" add .; git -C "$DIVERGED" commit -q -m unrelated
git -C "$DIVERGED" push -q "$PUBLIC" HEAD:refs/heads/diverged-fixture
git --git-dir="$PUBLIC" update-ref refs/heads/main "$(git -C "$DIVERGED" rev-parse HEAD)"
if prepare "$TMP/divergent" "$(git -C "$SOURCE" rev-parse HEAD)" "$SECOND" >"$TMP/divergent.out" 2>"$TMP/divergent.err"; then
  echo 'divergent remote was accepted' >&2; exit 1
fi
grep -Eq 'moved|differs' "$TMP/divergent.err"

if rg -n 'git (init .*orphan|checkout .*orphan|push .*--force([[:space:]]|$)|push -f([[:space:]]|$))' \
  "$ROOT/build/scripts/release/publish-github-mirror.sh"; then
  echo 'unsafe history replacement path remains' >&2; exit 1
fi
printf '[PASS] GitHub mirror fast-forward fixtures\n'
