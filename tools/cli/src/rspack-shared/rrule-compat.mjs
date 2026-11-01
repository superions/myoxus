// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "rrule/dist/esm/index.js";

import * as rrule from "rrule/dist/esm/index.js";

// Mantine Schedule guards CommonJS and ESM rrule builds via `rruleAll.default`.
// Rspack's strict export analysis rejects that optional access when the package
// is resolved to rrule's named-export-only ESM entry, so the HTML targets alias
// the bare `rrule` specifier here while preserving every named export.
export default rrule;
