#!/usr/bin/env bash
# Collects runtime assets needed by the native server bundle.

set -euo pipefail

if [ $# -ne 4 ]; then
  echo "Usage: $0 <server-dir> <ops-dir> <bundle-dir> <compiled-myoxus-cli>" >&2
  exit 2
fi

server_dir="$1"
ops_dir="$2"
bundle_dir="$3"
compiled_cli="$4"
test -x "$compiled_cli"

test -d "$server_dir"
test -d "$ops_dir/systemd"
test -f "$server_dir/config/default.yaml"
test -f "$server_dir/config/local.yaml.example"
test -d "$server_dir/templates"
test -d "$server_dir/static"

mkdir -p "$bundle_dir/config" "$bundle_dir/systemd"

cp -v "$server_dir/config/default.yaml" "$bundle_dir/config/"
cp -v "$server_dir/config/local.yaml.example" "$bundle_dir/config/"
find "$server_dir/config" -maxdepth 1 -type f -name 'features.*.yaml' -print \
  | sort \
  | while IFS= read -r file; do
    cp -v "$file" "$bundle_dir/config/"
  done

rm -rf "$bundle_dir/templates" "$bundle_dir/static"
mkdir -p "$bundle_dir/templates"
# Native authoring sources have one delivery owner: the compiled Feature Bundle.
for family in "$server_dir/templates/"*; do
  case "$(basename "$family")" in
    databases|assistants|documents|features|workflows) continue ;;
  esac
  cp -a "$family" "$bundle_dir/templates/"
done
cp -a "$server_dir/static" "$bundle_dir/static"
rm -rf "$bundle_dir/static/features"
"$compiled_cli" templates feature-bundle pack \
  --root "$server_dir/templates" \
  --manifest features/base/manifest.yaml \
  --output "$bundle_dir" \
  --release-base
# The CLI uses private staging modes. Published nonsecret assets must also be
# readable when OCI ownership is root and the runtime validator uses another UID.
for feature_root in "$bundle_dir/templates/features" "$bundle_dir/static/features"; do
  find "$feature_root" -type d -exec chmod 0755 {} +
  find "$feature_root" -type f -exec chmod 0644 {} +
done
cmp -s "$bundle_dir/templates/features/release.yaml" "$bundle_dir/static/features/release.yaml"
"$compiled_cli" templates feature-bundle validate-release \
  --root "$bundle_dir/templates" \
  --release-manifest "$bundle_dir/static/features/release.yaml"

cp -v "$ops_dir/systemd/myoxus-api.service" "$bundle_dir/systemd/"
cp -v "$ops_dir/systemd/myoxus.env.example" "$bundle_dir/systemd/"

cat >"$bundle_dir/README.md" <<'EOF'
# Myoxus Native Server Bundle

This archive contains the native Myoxus server runtime payload for Linux x86-64.

## Layout

- `bin/myoxus-server` — Rust API server binary.
- `bin/myoxus-cli` — administration CLI.
- `config/default.yaml` — package-owned defaults.
- `config/local.yaml.example` — starting point for operator configuration.
- `templates/` — immutable Feature Bundle archives plus mail, PDF and HTML assets.
- `static/` — independent Feature release expectation, fonts and ICC profiles.
- `systemd/` — example service and environment files.
- `legal/` — root license, source correspondence, third-party notices,
  component provenance and the release-bound Cargo SBOM.

For production packages, copy operator-owned configuration to `/etc/myoxus`
and keep runtime data under `/var/lib/myoxus`. Do not edit `config/default.yaml`
in place.
EOF

if [ -e "$bundle_dir/config/local.yaml" ]; then
  echo "Unexpected operator-local config in bundle: $bundle_dir/config/local.yaml" >&2
  exit 1
fi

find "$bundle_dir" -maxdepth 2 -type f -print | sort
