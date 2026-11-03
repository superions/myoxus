#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Consumer contract for one locked Feature selection and unrelated asset preservation.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
prepare="$repo/build/scripts/server/prepare-templates.sh"
cp -R "$repo/server/templates" "$fixture/authoring"
native_cli() {
  if [[ -n "${MYOXUS_TEMPLATE_VALIDATOR:-}" ]]; then
    "$MYOXUS_TEMPLATE_VALIDATOR" "$@"
  elif [[ -n "${MYOXUS_TEMPLATE_VALIDATOR_IMAGE:-}" ]]; then
    docker run --rm --user "$(id -u):$(id -g)" --entrypoint /usr/local/bin/myoxus-cli \
      -v "$fixture:$fixture:rw" "$MYOXUS_TEMPLATE_VALIDATOR_IMAGE" "$@"
  else
    echo '[FAIL] native template fixture requires an already-built validator or validator image' >&2
    exit 1
  fi
}
pack_release() {
  local output="$1"
  native_cli templates feature-bundle pack --root "$fixture/authoring" \
    --manifest features/base/manifest.yaml --output "$output" --release-base
  # Unbundled families retain the existing operator-owned policy.
  cp -R "$fixture/authoring/mail" "$output/templates/mail"
}
pack_release "$fixture/release-one"
source_dir="$fixture/release-one/templates"
release_manifest="$fixture/release-one/static/features/release.yaml"
seed() { bash "$prepare" --source-dir "$source_dir" --release-manifest "$release_manifest" --output "$fixture/current"; }
# An existing empty destination is an initial install, not an installed catalog.
mkdir "$fixture/current"
seed
[[ -f "$fixture/current/features/catalog.yaml" ]]
[[ ! -e "$fixture/current/features/release.yaml" ]]
for bundled_family in databases assistants documents; do [[ ! -e "$fixture/current/$bundled_family" ]]; done
printf '\n<!-- operator customization -->\n' >> "$fixture/current/mail/de/verify-email.html"
chmod 0640 "$fixture/current/mail/de/verify-email.html"
chmod 0700 "$fixture/current/mail/de"
mkdir "$fixture/current/custom"
mv "$fixture/current/mail/en/verify-email.html" "$fixture/current/custom/mail.html"
ln -s ../../custom/mail.html "$fixture/current/mail/en/verify-email.html"
rm "$fixture/current/mail/it/set-password.html"
node - "$fixture/current" "$fixture/snapshot.json" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[2],records={};
function visit(relative){const file=path.join(root,relative),s=fs.lstatSync(file);records[relative]={mode:s.mode,uid:s.uid,gid:s.gid};if(s.isDirectory()){for(const name of fs.readdirSync(file))visit(path.join(relative,name));}else if(s.isSymbolicLink()){records[relative].link=fs.readlinkSync(file);}else{records[relative].hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}}
visit('');fs.writeFileSync(process.argv[3],JSON.stringify(records));
NODE
mkdir -p "$source_dir/pdf/vendor/example" "$source_dir/html/public"
printf 'PDF source bytes\n' > "$source_dir/pdf/vendor/example/main.typ"
printf 'HTML source bytes\n' > "$source_dir/html/public/shell.html"
seed > "$fixture/preparation.log"
grep -Eq '\[REVIEW\].*mail/de/verify-email.html' "$fixture/preparation.log"
for file in mail/it/set-password.html pdf/vendor/example/main.typ html/public/shell.html; do
  cmp "$source_dir/$file" "$fixture/current/$file"
done
seed >/dev/null
node - "$fixture/current" "$fixture/snapshot.json" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
for(const [relative,expected] of Object.entries(JSON.parse(fs.readFileSync(process.argv[3])))){const file=path.join(process.argv[2],relative),s=fs.lstatSync(file);const actual={mode:s.mode,uid:s.uid,gid:s.gid};if(s.isSymbolicLink())actual.link=fs.readlinkSync(file);else if(s.isFile())actual.hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');assert.deepEqual(actual,expected,`operator input changed: ${relative}`);}
NODE
# Forward native sources remain native. Only this isolated fixture gains versions;
# its current exports advance while retained sources keep their original links.
node --input-type=module - "$fixture/authoring" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import YAML from 'yaml';
const root=process.argv[2],manifestPath=path.join(root,'features/base/manifest.yaml');
const manifest=YAML.parse(fs.readFileSync(manifestPath,'utf8'));
const retainedLinks=structuredClone(manifest.links);
for(const [family,collection,id] of [['databases','templates','myoxus.database.blank'],['assistants','packages','myoxus.assistant.project.simple_project']]){
  const catalogPath=path.join(root,family,'catalog.yaml'),catalog=YAML.parse(fs.readFileSync(catalogPath,'utf8'));
  const entry=catalog[collection].find(entry=>entry.id===id),old=entry.definitions.find(ref=>ref.version===entry.current);
  const versions=entry.definitions.map(ref=>{
    assert.match(ref.version,/^\d+\.\d+\.\d+$/,'forward fixture requires stable native versions');
    return ref.version.split('.').map(Number);
  }).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
  const [major,minor,patch]=versions.at(-1),next=`${major}.${minor}.${patch+1}`;
  const source=YAML.parseDocument(fs.readFileSync(path.join(root,family,old.path),'utf8'));
  const previous=entry.current;source.set('version',next);
  if(family==='databases')source.set('supported_predecessors',[previous]);else source.get('name').set('en','Fixture forward package');
  const relative=`${id}/${next}.yaml`,bytes=source.toString();
  fs.writeFileSync(path.join(root,family,relative),bytes,{flag:'wx'});entry.current=next;
  entry.definitions.push({...old,version:next,path:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  fs.writeFileSync(catalogPath,YAML.stringify(catalog));
  const replace=value=>{if(Array.isArray(value))value.forEach(replace);else if(value&&typeof value==='object'){if(value.component===family&&value.export===`${id}@${previous}`)value.export=`${id}@${next}`;Object.values(value).forEach(replace);}};
  // Self-bindings, document and artwork links belong to each immutable source.
  // Clone only this source's outgoing links; never move retained obligations.
  const nextLinks=manifest.links.filter(link=>link.from.component===family&&link.from.export===`${id}@${previous}`).map(link=>structuredClone(link));
  nextLinks.forEach(replace);manifest.links.push(...nextLinks);
  for(const item of manifest.exports)replace(item.source);
}
assert.deepEqual(manifest.links.slice(0,retainedLinks.length),retainedLinks,'retained source links changed');
manifest.version='1.1.0';fs.writeFileSync(manifestPath,YAML.stringify(manifest));
NODE
pack_release "$fixture/release-two"
source_dir="$fixture/release-two/templates"
release_manifest="$fixture/release-two/static/features/release.yaml"
cp "$fixture/current/features/catalog.yaml" "$fixture/catalog-before.yaml"
next_archive="$source_dir/features/myoxus.features.base/1.1.0.myoxus.zip"
mv "$next_archive" "$fixture/next.zip"
if seed > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] catalog promoted with missing immutable archive' >&2; exit 1
fi
cmp "$fixture/catalog-before.yaml" "$fixture/current/features/catalog.yaml"
mv "$fixture/next.zip" "$next_archive"
# Re-pin only the enclosing fixture delivery, preserving regular ZIP inventory.
# Missing/tampered native updates and changed immutable history must fail native
# preparation before it can replace the installed pointer.
for update_case in missing tampered history; do
  cp -R "$fixture/release-two" "$fixture/update-$update_case"
  node --input-type=module - "$fixture/update-$update_case" "$update_case" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readZip,writeZip} from './build/scripts/zip-archive.mjs';
import YAML from 'yaml';
const root=process.argv[2],mode=process.argv[3],catalogPath=path.join(root,'templates/features/catalog.yaml');
const catalog=YAML.parse(fs.readFileSync(catalogPath,'utf8'));
const archivePath=path.join(root,'templates/features',catalog.base.id,`${catalog.base.version}.myoxus.zip`);
const archive=await readZip(fs.readFileSync(archivePath));
const text=name=>archive.get(name).data.toString('utf8');
const put=(name,bytes)=>archive.set(name,{data:Buffer.from(bytes),directory:false});
const manifest=YAML.parse(text('manifest.yaml'));
const component=manifest.components.find(component=>component.kind==='databaseCatalog');
const nativeCatalog=YAML.parse(text(component.path));
const entry=nativeCatalog.templates.find(entry=>entry.updates?.length);
if(!entry)throw new Error('actual release has no native Update fixture');
const update=entry.updates[0],prefix=component.path.slice(0,component.path.lastIndexOf('/')+1),updatePath=prefix+update.path;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
if(mode==='missing'){
  archive.delete(updatePath);delete manifest.files[updatePath];
}else{
  const bytes=text(updatePath)+'\n';
  put(updatePath,bytes);manifest.files[updatePath]=hash(bytes);
  if(mode==='history'){
    update.sha256=hash(bytes);
    const catalogBytes=YAML.stringify(nativeCatalog);
    put(component.path,catalogBytes);
    manifest.files[component.path]=hash(catalogBytes);component.sha256=hash(catalogBytes);
  }
}
put('manifest.yaml',YAML.stringify(manifest));
const bytes=await writeZip(archive);
fs.writeFileSync(archivePath,bytes);catalog.base.sha256=hash(bytes);
fs.writeFileSync(catalogPath,YAML.stringify(catalog));
const descriptor=YAML.stringify({formatVersion:1,base:catalog.base});
fs.writeFileSync(path.join(root,'static/features/release.yaml'),descriptor);
fs.writeFileSync(path.join(root,'templates/features/release.yaml'),descriptor);
NODE
  source_dir="$fixture/update-$update_case/templates"
  release_manifest="$fixture/update-$update_case/static/features/release.yaml"
  if seed > "$fixture/update-$update_case.log" 2>&1; then
    echo "[FAIL] catalog promoted with $update_case native Update" >&2; exit 1
  fi
  case "$update_case" in
    missing) grep -Eq 'updates/.*declared native file missing' "$fixture/update-$update_case.log" ;;
    tampered) grep -Eq 'updates/.*SHA-256 mismatch' "$fixture/update-$update_case.log" ;;
    history) grep -Fq 'current provider dropped native update history' "$fixture/update-$update_case.log" ;;
  esac
  cmp "$fixture/catalog-before.yaml" "$fixture/current/features/catalog.yaml"
done
source_dir="$fixture/release-two/templates"
release_manifest="$fixture/release-two/static/features/release.yaml"
# A later unrelated publication failure cannot activate the new Feature pointer.
rm "$fixture/current/mail/en/verify-email.html"
ln -s "$source_dir/mail/en/verify-email.html" "$fixture/current/mail/en/verify-email.html"
if seed > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] catalog activated before unrelated family publication completed' >&2; exit 1
fi
cmp "$fixture/catalog-before.yaml" "$fixture/current/features/catalog.yaml"
rm "$fixture/current/mail/en/verify-email.html"
ln -s ../../custom/mail.html "$fixture/current/mail/en/verify-email.html"
# A publisher can lose acknowledgement after the sole activation rename. Its
# nonzero exit must leave a valid new selection, and a normal retry converges.
mkdir "$fixture/after-rename-bin"
cat > "$fixture/after-rename-bin/mv" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
"$MYOXUS_TEST_RENAME_TOOL" "$@"
if [[ "${!#}" == */features/catalog.yaml ]]; then
  echo 'injected failure after Feature catalog rename' >&2
  exit 73
fi
SH
chmod +x "$fixture/after-rename-bin/mv"
if MYOXUS_TEST_RENAME_TOOL="$(command -v mv)" PATH="$fixture/after-rename-bin:$PATH" \
  seed > "$fixture/after-rename.log" 2>&1; then
  echo '[FAIL] injected post-activation failure was not observed' >&2; exit 1
else
  rename_status=$?
fi
[[ "$rename_status" == 73 ]]
grep -q 'injected failure after Feature catalog rename' "$fixture/after-rename.log"
if cmp -s "$fixture/catalog-before.yaml" "$fixture/current/features/catalog.yaml"; then
  echo '[FAIL] post-rename failure did not expose the new active selection' >&2; exit 1
fi
native_cli templates feature-bundle validate-release --root "$fixture/current" \
  --release-manifest "$release_manifest"
cp "$fixture/current/features/catalog.yaml" "$fixture/catalog-after-lost-ack.yaml"
seed > "$fixture/preparation.log"
cmp "$fixture/catalog-after-lost-ack.yaml" "$fixture/current/features/catalog.yaml"
cp "$fixture/current/features/catalog.yaml" "$fixture/catalog-newer.yaml"
cmp "$next_archive" "$fixture/current/features/myoxus.features.base/1.1.0.myoxus.zip"
# Replay refuses a downgrade without replacing the now-active pointer.
source_dir="$fixture/release-one/templates"
release_manifest="$fixture/release-one/static/features/release.yaml"
if seed > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] preparation silently downgraded the installed Feature base' >&2; exit 1
fi
grep -q 'downgrade' "$fixture/rejection.log"
cmp "$fixture/catalog-newer.yaml" "$fixture/current/features/catalog.yaml"
source_dir="$fixture/release-two/templates"
release_manifest="$fixture/release-two/static/features/release.yaml"
printf tampered >> "$fixture/current/features/myoxus.features.base/1.1.0.myoxus.zip"
if seed > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] different installed immutable bytes accepted' >&2; exit 1
fi
cmp "$fixture/catalog-newer.yaml" "$fixture/current/features/catalog.yaml"
cp "$next_archive" "$fixture/current/features/myoxus.features.base/1.1.0.myoxus.zip"
# Both locked equal publishers converge on the same complete selection.
seed > "$fixture/concurrent-one.log" 2>&1 &
publisher_one=$!
seed > "$fixture/concurrent-two.log" 2>&1 &
publisher_two=$!
wait "$publisher_one"
wait "$publisher_two"
cmp "$fixture/catalog-newer.yaml" "$fixture/current/features/catalog.yaml"
# Nested directory links and escaping file links must never redirect publication.
mkdir "$fixture/escape" "$fixture/symlink"
mkdir -p "$fixture/symlink/features"
ln -s "$fixture/escape" "$fixture/symlink/features/myoxus.features.base"
if bash "$prepare" --source-dir "$source_dir" --release-manifest "$release_manifest" --output "$fixture/symlink" > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] symlinked grandparent was accepted' >&2; exit 1
fi
[[ -z "$(find "$fixture/escape" -type f -print -quit)" ]]
mkdir -p "$fixture/linked-file/mail/en"
ln -s "$source_dir/mail/en/verify-email.html" "$fixture/linked-file/mail/en/verify-email.html"
if bash "$prepare" --source-dir "$source_dir" --release-manifest "$release_manifest" --output "$fixture/linked-file" > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] escaping file link was accepted' >&2; exit 1
fi
[[ -L "$fixture/linked-file/mail/en/verify-email.html" ]]
# Publication must also reject a directory link created after the initial check.
mkdir "$fixture/bin"
cat > "$fixture/bin/link" <<'SH'
#!/usr/bin/env bash
if [[ "$2" = */mail/en/verify-email.html ]]; then
  ln -s "$MYOXUS_TEST_LINK_ESCAPE" "$2"
fi
exec "$MYOXUS_TEST_LINK_TOOL" "$@"
SH
chmod +x "$fixture/bin/link"
if MYOXUS_TEST_LINK_TOOL="$(command -v link)" MYOXUS_TEST_LINK_ESCAPE="$fixture/escape" \
  PATH="$fixture/bin:$PATH" bash "$prepare" --source-dir "$source_dir" --release-manifest "$release_manifest" --output "$fixture/concurrent" > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] concurrent destination link was accepted' >&2; exit 1
fi
[[ -L "$fixture/concurrent/mail/en/verify-email.html" ]]
[[ -z "$(find "$fixture/escape" -type f -print -quit)" ]]
if bash "$prepare" --source-dir "$source_dir" --release-manifest "$release_manifest" --output "$source_dir/output" > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] overlapping source/output was accepted' >&2; exit 1
fi
[[ ! -e "$source_dir/output" ]]
ln -s "$fixture/escape" "$source_dir/foreign"
if bash "$prepare" --source-dir "$source_dir" --release-manifest "$release_manifest" --output "$fixture/rejected-source" > "$fixture/rejection.log" 2>&1; then
  echo '[FAIL] release source symlink was accepted' >&2; exit 1
fi
[[ ! -e "$fixture/rejected-source" ]]
echo '[PASS] Feature pointer, immutable dependencies, operator assets and locked publication'
