#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Publish an admitted Feature selection; preserve unrelated operator-owned assets.
set -euo pipefail

SOURCE_DIR=""
SERVER_IMAGE=""
OUTPUT=""
OWNER=""
RELEASE_MANIFEST=""
OPTIONAL_CATALOG=""
VALIDATOR="${MYOXUS_TEMPLATE_VALIDATOR:-}"
VALIDATOR_IMAGE="${MYOXUS_TEMPLATE_VALIDATOR_IMAGE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir) SOURCE_DIR="${2:?Missing source directory}"; shift 2 ;;
    --server-image) SERVER_IMAGE="${2:?Missing server image}"; shift 2 ;;
    --output) OUTPUT="${2:?Missing output directory}"; shift 2 ;;
    --validator) VALIDATOR="${2:?Missing validator executable}"; shift 2 ;;
    --validator-image) VALIDATOR_IMAGE="${2:?Missing validator image}"; shift 2 ;;
    --release-manifest) RELEASE_MANIFEST="${2:?Missing release manifest}"; shift 2 ;;
    --optional-catalog) OPTIONAL_CATALOG="${2:?Missing optional catalog}"; shift 2 ;;
    --owner) OWNER="${2:?Missing numeric owner UID:GID}"; shift 2 ;;
    *) echo "[FAIL] unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [[ "$OUTPUT" != /* || ( -z "$SOURCE_DIR" && -z "$SERVER_IMAGE" ) || ( -n "$SOURCE_DIR" && -n "$SERVER_IMAGE" ) ]]; then
  echo "[FAIL] provide an absolute --output and exactly one of --source-dir or --server-image" >&2
  exit 1
fi
if [[ -n "$OWNER" && ! "$OWNER" =~ ^[0-9]+:[0-9]+$ ]]; then
  echo "[FAIL] --owner must be numeric UID:GID" >&2
  exit 1
fi
fail() { echo "[FAIL] $*" >&2; exit 1; }
command -v flock >/dev/null || fail "template publication requires flock (util-linux)"
if [[ -n "$RELEASE_MANIFEST" ]]; then
  [[ "$RELEASE_MANIFEST" = /* ]] || RELEASE_MANIFEST="$PWD/$RELEASE_MANIFEST"
  [[ -f "$RELEASE_MANIFEST" && ! -L "$RELEASE_MANIFEST" ]] || fail "release manifest must be a regular file"
fi
if [[ -n "$OPTIONAL_CATALOG" ]]; then
  [[ "$OPTIONAL_CATALOG" = /* ]] || OPTIONAL_CATALOG="$PWD/$OPTIONAL_CATALOG"
  [[ -f "$OPTIONAL_CATALOG" && ! -L "$OPTIONAL_CATALOG" ]] || fail "optional catalog must be a regular file"
fi
EXTRACT_ROOT=""
CONTAINER=""
STAGING=""
cleanup() {
  if [[ -n "$CONTAINER" ]]; then docker rm "$CONTAINER" >/dev/null; fi
  if [[ -n "$EXTRACT_ROOT" ]]; then rm -rf "$EXTRACT_ROOT"; fi
  if [[ -n "$STAGING" ]]; then rm -rf "$STAGING"; fi
}
trap cleanup EXIT
if [[ -n "$SERVER_IMAGE" ]]; then
  EXTRACT_ROOT="$(mktemp -d)"
  # Extract this release's complete defaults without executing its entrypoint.
  CONTAINER="$(docker create "$SERVER_IMAGE" /__myoxus_template_extraction_only__)"
  docker cp "$CONTAINER:/opt/myoxus/templates/." "$EXTRACT_ROOT/"
  chmod 0755 "$EXTRACT_ROOT"
  SOURCE_DIR="$EXTRACT_ROOT"
fi
SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd -P)"
for directory in mail mail/assets features; do
  [[ -d "$SOURCE_DIR/$directory" ]] || fail "missing template directory: $SOURCE_DIR/$directory"
done
[[ -f "$SOURCE_DIR/features/catalog.yaml" ]] || fail "missing features/catalog.yaml"
[[ -f "$SOURCE_DIR/mail/_layout.html" ]] || fail "missing mail layout: $SOURCE_DIR/mail/_layout.html"
for language in en de fr es it; do
  [[ -d "$SOURCE_DIR/mail/$language" && -f "$SOURCE_DIR/mail/$language/_copy.json" ]] || fail "missing mail language layout: $SOURCE_DIR/mail/$language"
done
[[ -z "$(find "$SOURCE_DIR" -type l -print -quit)" ]] || fail "release defaults must not contain symlinks: $SOURCE_DIR"
[[ "$OUTPUT" != "$SOURCE_DIR" && "$OUTPUT" != "$SOURCE_DIR/"* && "$SOURCE_DIR" != "$OUTPUT/"* ]] || fail "source and output roots must not overlap"
umask 022
if [[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]]; then
  mkdir -p "$OUTPUT"
  [[ -z "$OWNER" ]] || chown "$OWNER" "$OUTPUT"
fi
[[ -d "$OUTPUT" ]] || fail "template root is not a directory: $OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd -P)"
[[ "$OUTPUT" != "$SOURCE_DIR" && "$OUTPUT" != "$SOURCE_DIR/"* && "$SOURCE_DIR" != "$OUTPUT/"* ]] || fail "source and output roots must not overlap"
STAGING="$(mktemp -d "$OUTPUT/.template-seed.XXXXXX")"

# Resolve existing file links without following a write through a directory link.
# Operator file links are retained only when their target is inside this root.
check_file() {
  local path="$1" link count=0 parent resolved
  [[ -f "$path" && -r "$path" ]] || fail "template file is missing or unreadable: $path"
  while [[ -L "$path" ]]; do
    count=$((count + 1))
    [[ "$count" -le 40 ]] || fail "template symlink cycle: $path"
    link="$(readlink "$path")"
    if [[ "$link" = /* ]]; then path="$link"; else path="$(dirname "$path")/$link"; fi
  done
  parent="$(cd "$(dirname "$path")" && pwd -P)"
  resolved="$parent/$(basename "$path")"
  [[ "$resolved" = "$OUTPUT/"* ]] || fail "template file escapes root: $resolved"
}

publish() {
  local source="$1" relative="$2" target parent part directory staged
  local -a parts
  target="$OUTPUT/$relative"
  parent="$(dirname "$relative")"
  directory="$OUTPUT"
  # Check every parent, including grandparents of nested version and vendor files.
  IFS=/ read -r -a parts <<< "$parent"
  for part in "${parts[@]}"; do
    [[ "$part" != . ]] || continue
    directory="$directory/$part"
    [[ ! -L "$directory" ]] || fail "template parent is a symlink: $directory"
    if [[ ! -e "$directory" ]]; then
      mkdir "$directory"
      [[ -z "$OWNER" ]] || chown "$OWNER" "$directory"
    fi
    [[ -d "$directory" ]] || fail "template parent is not a directory: $directory"
  done
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$relative" == features/* && -L "$target" ]]; then
      fail "immutable catalog input must not be a symlink: $relative"
    fi
    check_file "$target"
    if ! cmp -s "$source" "$target"; then
      if [[ "$relative" == features/* ]]; then
        fail "immutable catalog input differs: $relative"
      fi
      echo "[REVIEW] existing default differs; preserved: $relative"
    fi
    return
  fi
  mkdir -p "$STAGING/$parent"
  staged="$STAGING/$relative"
  cp "$source" "$staged"
  chmod 0644 "$staged"
  [[ -z "$OWNER" ]] || chown "$OWNER" "$staged"
  # Hard-link publication refuses to replace a concurrently created target.
  if ! link "$staged" "$target"; then
    [[ -e "$target" || -L "$target" ]] || exit 1
  fi
  check_file "$target"
  if [[ "$relative" == features/* ]]; then
    [[ ! -L "$target" ]] || fail "immutable catalog input publication raced with a symlink: $relative"
    cmp -s "$source" "$target" || fail "immutable catalog input publication raced: $relative"
  fi
}
# The lock covers capture, native admission and the sole pointer publication.
[[ ! -L "$OUTPUT/.template-publication.lock" ]] || fail "publication lock must not be a symlink"
[[ ! -e "$OUTPUT/.template-publication.lock" || -f "$OUTPUT/.template-publication.lock" ]] || fail "publication lock must be a regular file"
exec {publication_lock}>"$OUTPUT/.template-publication.lock"
[[ -z "$OWNER" ]] || chown "$OWNER" "$OUTPUT/.template-publication.lock"
flock -x "$publication_lock"
PREPARED="$STAGING/prepared"
mkdir "$PREPARED"
[[ -z "$OWNER" ]] || chown "$OWNER" "$PREPARED"
validate_source_set() {
  local root_args=(--root "$SOURCE_DIR" --prepared-root "$PREPARED") mount_args=()
  if [[ -e "$OUTPUT/features/catalog.yaml" || -L "$OUTPUT/features/catalog.yaml" ]]; then
    root_args+=(--against-root "$OUTPUT")
  fi
  [[ -z "$RELEASE_MANIFEST" ]] || root_args+=(--release-manifest "$RELEASE_MANIFEST")
  [[ -z "$OPTIONAL_CATALOG" ]] || root_args+=(--optional-catalog "$OPTIONAL_CATALOG")
  if [[ -n "$VALIDATOR" ]]; then
    "$VALIDATOR" templates validate-source-set "${root_args[@]}"
  elif [[ -n "${VALIDATOR_IMAGE:-$SERVER_IMAGE}" ]]; then
    root_args=(--root /template-source-set --prepared-root /template-prepared)
    if [[ -e "$OUTPUT/features/catalog.yaml" || -L "$OUTPUT/features/catalog.yaml" ]]; then
      root_args+=(--against-root /template-installed)
      mount_args+=(-v "$OUTPUT:/template-installed:ro")
    fi
    if [[ -n "$RELEASE_MANIFEST" ]]; then
      root_args+=(--release-manifest /template-release.yaml)
      mount_args+=(-v "$RELEASE_MANIFEST:/template-release.yaml:ro")
    fi
    if [[ -n "$OPTIONAL_CATALOG" ]]; then
      root_args+=(--optional-catalog /template-optional.yaml)
      mount_args+=(-v "$OPTIONAL_CATALOG:/template-optional.yaml:ro")
    fi
    docker run --rm --user "${OWNER:-$(id -u):$(id -g)}" --entrypoint /usr/local/bin/myoxus-cli \
      -v "$SOURCE_DIR:/template-source-set:ro" -v "$PREPARED:/template-prepared:rw" \
      "${mount_args[@]}" "${VALIDATOR_IMAGE:-$SERVER_IMAGE}" \
      templates validate-source-set "${root_args[@]}"
  else
    fail "source-set validation requires --validator or --validator-image (or --server-image)"
  fi
}
validate_source_set
[[ -f "$PREPARED/features/catalog.yaml" && ! -L "$PREPARED/features/catalog.yaml" ]] || fail "missing prepared Feature catalog"
[[ -z "$(find "$PREPARED" -type l -print -quit)" ]] || fail "prepared output contains symlinks"
# Native capture owns each archive's pinned definitions, Updates and endpoint
# closure. Publish those admitted bytes without rediscovering loose sources.
# Auxiliary release metadata is not another mutable pointer in this root.
while IFS= read -r -d '' source; do
  relative="${source#"$PREPARED/"}"
  publish "$source" "$relative"
done < <(find "$PREPARED/features" -type f -name '*.myoxus.zip' -print0)
# Other native template families retain their operator-owned file policy.
while IFS= read -r -d '' source; do
  relative="${source#"$SOURCE_DIR/"}"
  case "$relative" in databases/*|assistants/*|documents/*|features/*|workflows/*) continue ;; esac
  publish "$source" "$relative"
done < <(find "$SOURCE_DIR" -type f -print0)
[[ ! -L "$OUTPUT/features/catalog.yaml" ]] || fail "Feature catalog must not be a symlink"
[[ ! -e "$OUTPUT/features/catalog.yaml" || -f "$OUTPUT/features/catalog.yaml" ]] || fail "Feature catalog must be a regular file"
chmod 0644 "$PREPARED/features/catalog.yaml"
[[ -z "$OWNER" ]] || chown "$OWNER" "$PREPARED/features/catalog.yaml"
# This destination-filesystem rename is the one activation boundary. A failure
# before it preserves the old selection; after it, retry reads the active set.
mv -f "$PREPARED/features/catalog.yaml" "$OUTPUT/features/catalog.yaml"
# The Feature root contains exactly this selection. Obsolete wrappers and loose
# authoring metadata have no runtime consumer after the activation boundary.
while IFS= read -r -d '' target; do
  relative="${target#"$OUTPUT/"}"
  [[ "$relative" != features/catalog.yaml && ! -f "$PREPARED/$relative" ]] || continue
  rm -- "$target"
done < <(find "$OUTPUT/features" \( -type f -o -type l \) -print0)
find "$OUTPUT/features" -mindepth 1 -depth -type d -empty -delete
echo "[PASS] Exact Feature selection activated; unrelated template families preserved: $OUTPUT/features/catalog.yaml"
