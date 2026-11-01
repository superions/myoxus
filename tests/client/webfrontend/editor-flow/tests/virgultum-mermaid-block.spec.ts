// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P-VIRG-ARCH-I-04j declaration anchor.
 *
 * The Mermaid smoke scenario bodies are intentionally split into three
 * sibling specs so Playwright can shard the long first-class Mermaid checks.
 * Keep only shared declaration anchors here; executable regression coverage
 * lives in:
 *
 * - virgultum-mermaid-block-page-mermaid.spec.ts
 * - virgultum-mermaid-block-flowchart-gfx-editing.spec.ts
 * - virgultum-mermaid-block-edgeless-complex-workflow.spec.ts
 */

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const _API_ANCHOR = API;
const _GQL_ANCHOR = GQL;

const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /is not a function/i,
  /ReferenceError/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
];
const _FATAL_ERROR_PATTERNS_ANCHOR = FATAL_ERROR_PATTERNS;

const FLOWCHART_PAGE_MIN_READABLE_ZOOM = 0.5;
const FLOWCHART_PAGE_VIEWPORT_PADDING = 36;
const _FLOWCHART_PAGE_MIN_READABLE_ZOOM_ANCHOR =
  FLOWCHART_PAGE_MIN_READABLE_ZOOM;
const _FLOWCHART_PAGE_VIEWPORT_PADDING_ANCHOR = FLOWCHART_PAGE_VIEWPORT_PADDING;
