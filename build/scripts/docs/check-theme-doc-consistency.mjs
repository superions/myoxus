#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Guards P-THEME-HOVER-SHARED-03: enforces that the hover CSS variable
// contract is byte-consistent across the two authoritative documents.
//
//   1. docs/dev/branding/theme/hover-state-architecture.md  §Token Surface  (source of truth)
//   2. docs/dev/branding/theme/guardrails.md                §4 Contrast guardrails (Hover state)
//
// Source of truth is the §Token Surface section of hover-state-architecture.md
// (scoped from "## Token Surface" to the next "## " heading). The guardrail
// document carries the same set of --myoxus-*-hover-* variables.
//
// Invariant (INV-THEME-HOVER-01): every --myoxus-*-hover-* variable named in
// any of the three files must appear in all three. No orphans, no drift.
//
// Exits 1 on drift, 0 on success. Usage: `yarn lint:docs:theme` or direct
// `node build/scripts/docs/check-theme-doc-consistency.mjs`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const DOCS = {
  architecture: "docs/dev/branding/theme/hover-state-architecture.md",
  guardrails: "docs/dev/branding/theme/guardrails.md",
};

const HOVER_VAR_REGEX = /--myoxus-[a-z]+(?:-[a-z]+)*-hover-(?:bg|fg)\b/g;

function readDoc(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

function extractHoverVars(body) {
  return new Set(body.match(HOVER_VAR_REGEX) ?? []);
}

function extractTokenSurfaceVars(architectureBody) {
  const match = architectureBody.match(/^## Token Surface\b[\s\S]*?(?=^## )/m);
  if (!match) {
    console.error(
      "[check-theme-doc-consistency] cannot locate §Token Surface in architecture doc",
    );
    process.exit(1);
  }
  const vars = extractHoverVars(match[0]);
  if (vars.size === 0) {
    console.error(
      "[check-theme-doc-consistency] §Token Surface lists no --myoxus-*-hover-* variables",
    );
    process.exit(1);
  }
  return vars;
}

const docBodies = Object.fromEntries(
  Object.entries(DOCS).map(([key, path]) => [key, readDoc(path)]),
);

const expected = extractTokenSurfaceVars(docBodies.architecture);
const actual = Object.fromEntries(
  Object.entries(docBodies).map(([key, body]) => [key, extractHoverVars(body)]),
);

const findings = [];

for (const [key, vars] of Object.entries(actual)) {
  const missing = [...expected].filter((v) => !vars.has(v));
  const extra = [...vars].filter((v) => !expected.has(v));
  if (missing.length > 0) {
    findings.push(
      `${DOCS[key]}: missing ${missing.length} var(s) from §Token Surface: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    findings.push(
      `${DOCS[key]}: declares ${extra.length} var(s) absent from architecture §Token Surface: ${extra.join(", ")}`,
    );
  }
}

if (findings.length > 0) {
  console.error("[check-theme-doc-consistency] drift detected:");
  for (const f of findings) {
    console.error(`  - ${f}`);
  }
  console.error(
    "\nSee todo/theming-hover-state.md §SHARED-03 for the invariant.",
  );
  process.exit(1);
}

console.log(
  `[check-theme-doc-consistency] OK — all ${expected.size} hover variables from architecture §Token Surface present in ${Object.keys(DOCS).length - 1} downstream docs.`,
);
