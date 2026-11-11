#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
cd "$repo_root"
test "${GITHUB_REPOSITORY:?}" = myoxus/myoxus
test "${BUILD_TYPE:?}" = stable
test "$(df -Pk . | awk 'NR==2 {print $4}')" -gt 12582912
revision="${REVIEWED_SOURCE_REVISION:?}"
number="${REVIEWED_PACKAGING_RUN:?}"
version="${MYOXUS_RELEASE_VERSION:?}"
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$number" =~ ^[0-9]+$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$(git show "$revision:client/apps/electron/package.json" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')" = "$version"
test ! -e dist/release-macos
test ! -e dist/reviewed-macos
node build/scripts/ci/fetch-reviewed-macos-artifacts.mjs "$number" "$revision" "$version" dist/reviewed-macos
yarn install --immutable --mode=skip-build
mkdir -p dist/release-macos/macos dist/release-macos/sbom
printf '{}\n' > dist/reviewed-macos/signatures.json
for arch in arm64 x64; do
  bash build/scripts/ci/verify-macos-packaging-artifacts.sh "dist/reviewed-macos/$arch" "$arch" --ad-hoc
  cp "dist/reviewed-macos/$arch/"* dist/release-macos/macos/
done
node --input-type=module <<'JS'
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const evidence = {};
for (const name of fs.readdirSync('dist/release-macos/macos')) evidence[name] = {
  status:'ad-hoc',verifier:'codesign',sha256:createHash('sha256').update(fs.readFileSync(`dist/release-macos/macos/${name}`)).digest('hex')
};
fs.writeFileSync('dist/reviewed-macos/signatures.json',JSON.stringify(evidence));
JS
# The SBOM graph must come from the executable's source, not the promotion code.
mkdir dist/reviewed-macos/source
git archive "$revision" | tar -x -C dist/reviewed-macos/source
source_root="$PWD/dist/reviewed-macos/source"
sbom="$PWD/dist/release-macos/sbom/myoxus-desktop-$version.cdx.json"
source_epoch="$(git show -s --format=%ct "$revision")"
(
  cd "$source_root"
  node build/scripts/ci/verify-electron-updater-source.mjs --prepare
  yarn install --immutable --mode=skip-build
  bash build/scripts/release/generate-sbom.sh --typescript-only --output "$sbom" \
    --git-revision "$revision" --component-version "$version" --source-date-epoch "$source_epoch"
)
SOURCE_DATE_EPOCH="$source_epoch" node build/scripts/ci/write-desktop-release-metadata.mjs \
  --release-dir dist/release-macos --version "$version" --channel stable --scope macos \
  --source-commit "$revision" --source-repository myoxus/myoxus \
  --builder-id "https://git.blume29.de/myoxus/myoxus/actions/runs/$number" --run-id "$number" \
  --sbom "$sbom" --signature-evidence dist/reviewed-macos/signatures.json
# Publish original packaged notices separately as well as inside the applications.
unzip -p "dist/release-macos/macos/myoxus-$version-stable-macos-arm64.zip" Myoxus.app/Contents/Resources/app.asar > dist/reviewed-macos/app.asar
node --input-type=module <<'JS'
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
const require = createRequire(path.resolve('client/apps/electron/package.json'));
const asar = require('@electron/asar');
const archive = 'dist/reviewed-macos/app.asar';
const root = 'dist/reviewed-macos/legal';
fs.mkdirSync(root);
const names = asar.listPackage(archive).filter(p => p === '/THIRD_PARTY_NOTICES.md' || p.startsWith('/THIRD_PARTY_LICENSES/'));
if (!names.includes('/THIRD_PARTY_NOTICES.md')) throw new Error('Packaged legal notices are missing');
for (const name of names) {
  if (asar.statFile(archive,name).files) continue;
  if (name.split('/').includes('..')) throw new Error('Noncanonical notice path');
  const target = path.join(root,name.slice(1));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,asar.extractFile(archive,name));
}
JS
cp "$source_root/LICENSE" dist/reviewed-macos/legal/LICENSE
tar -czf dist/release-macos/legal-notices.tar.gz -C dist/reviewed-macos/legal .
GITHUB_SHA="$revision" bash build/scripts/ci/write-release-summary.sh dist/release-macos
cat >> dist/release-macos/RELEASE.md <<EOF

## macOS $version

Reuses unchanged DMG/ZIP bytes from packaging run $number at $revision.
Both architectures: archive, relocated native closure and ad-hoc signature verified again.
No Apple Developer ID or notarization. Updates are managed externally by Homebrew.
x64 native unit tests passed in the producer. ARM64 CI runtime tests were not run.
EOF
printf '\n## Original producer receipt\n\n```json\n' >> dist/release-macos/RELEASE.md
cat dist/reviewed-macos/producer-receipt.json >> dist/release-macos/RELEASE.md
printf '```\n' >> dist/release-macos/RELEASE.md
bash build/scripts/ci/write-artifact-manifest.sh dist/release-macos
bash build/scripts/ci/write-sha256sums.sh dist/release-macos
bash build/scripts/ci/verify-release-artifacts.sh dist/release-macos --require-publishable
