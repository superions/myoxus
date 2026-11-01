#!/usr/bin/env bash
# Proves that Oxlint is the single JavaScript/TypeScript lint owner.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

node <<'NODE'
const { existsSync, readFileSync } = require('node:fs');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const config = JSON.parse(readFileSync('.oxlintrc.json', 'utf8'));
const dependencies = Object.assign(
  {},
  packageJson.dependencies,
  packageJson.devDependencies,
  packageJson.peerDependencies,
  packageJson.optionalDependencies,
);

const forbidden = [
  '@eslint/js',
  '@smarttools/eslint-plugin-rxjs',
  '@typescript-eslint/parser',
  'eslint',
  'eslint-config-prettier',
  'eslint-import-resolver-typescript',
  'eslint-plugin-import-x',
  'eslint-plugin-oxlint',
  'eslint-plugin-simple-import-sort',
  'eslint-plugin-unicorn',
  'typescript-eslint',
];
for (const name of forbidden) {
  if (Object.hasOwn(dependencies, name)) {
    fail(`Removed ESLint owner is still declared: ${name}`);
  }
}

for (const name of [
  'oxlint',
  'oxlint-tsgolint',
  'eslint-plugin-react-hooks',
]) {
  if (!Object.hasOwn(dependencies, name)) {
    fail(`Required Oxlint owner is not declared: ${name}`);
  }
}

if (existsSync('eslint.config.mjs')) {
  fail('eslint.config.mjs must not coexist with the Oxlint owner.');
}

const pluginMap = new Map(
  (config.jsPlugins ?? []).map(plugin => [plugin.name, plugin.specifier]),
);
if (pluginMap.get('react-hooks-js') !== 'eslint-plugin-react-hooks') {
  fail('The React compiler rules must be loaded through the react-hooks-js alias.');
}

function severity(rule) {
  const value = config.rules?.[rule];
  return Array.isArray(value) ? value[0] : value;
}

const requiredRules = new Map([
  ['react/rules-of-hooks', 'error'],
  ['react/exhaustive-deps', 'warn'],
  ['react-hooks-js/purity', 'error'],
  ['react-hooks-js/set-state-in-render', 'error'],
]);
for (const [rule, expected] of requiredRules) {
  if (severity(rule) !== expected) {
    fail(`Expected ${rule} to be ${expected}, received ${String(severity(rule))}.`);
  }
}

for (const pattern of config.ignorePatterns ?? []) {
  if (/^(?:packages|blocksuite)\//.test(pattern)) {
    fail(`Oxlint still contains a removed-tree phantom scope: ${pattern}`);
  }
}
NODE

mkdir -p .tmp
tmpdir="$(mktemp -d .tmp/oxlint-config-health.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT

cat >"$tmpdir/clean-component.tsx" <<'TSX'
export function CleanComponent({ items }: { items: string[] }) {
  return <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>;
}
TSX

cat >"$tmpdir/missing-key.tsx" <<'TSX'
export function MissingKey({ items }: { items: string[] }) {
  return <ul>{items.map(item => <li>{item}</li>)}</ul>;
}
TSX

cat >"$tmpdir/invalid-hook.tsx" <<'TSX'
import { useState } from 'react';
export function InvalidHook({ enabled }: { enabled: boolean }) {
  if (enabled) useState(false);
  return null;
}
TSX

cat >"$tmpdir/impure-component.tsx" <<'TSX'
export function ImpureComponent() {
  return <time>{Date.now()}</time>;
}
TSX

cat >"$tmpdir/floating-promise.ts" <<'TS'
async function operation(): Promise<void> {}
operation();
TS

cat >"$tmpdir/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "target": "ES2024"
  },
  "include": ["*.ts", "*.tsx"]
}
JSON

expect_failure() {
  local rule="$1"
  local file="$2"
  local output="$tmpdir/$(basename "$file").out"
  shift 2

  if yarn exec oxlint "$@" "$file" >"$output" 2>&1; then
    echo "Expected Oxlint to reject $file with $rule." >&2
    exit 1
  fi
  if ! grep -Fq "$rule" "$output"; then
    echo "Expected $file to report $rule." >&2
    cat "$output" >&2
    exit 1
  fi
}

yarn exec oxlint --deny-warnings --silent "$tmpdir/clean-component.tsx"
expect_failure 'jsx-key' "$tmpdir/missing-key.tsx" --deny-warnings
expect_failure 'rules-of-hooks' "$tmpdir/invalid-hook.tsx" --deny-warnings
expect_failure 'purity' "$tmpdir/impure-component.tsx" --deny-warnings
expect_failure 'no-floating-promises' "$tmpdir/floating-promise.ts" \
  --type-aware -A all -D typescript/no-floating-promises

node build/scripts/ci/run-oxlint-type-aware.mjs --self-test
node build/scripts/ci/verify-workspace-dependency-boundaries.mjs --self-test

echo "Oxlint config health verified."
