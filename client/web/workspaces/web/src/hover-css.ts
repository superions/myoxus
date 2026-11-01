// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web re-export for the shared runtime hover derivation used by Web and
// Electron. The implementation lives in @myoxus/theme so runtime loaders do not
// fork hover-token semantics per app.

export { appendHoverVariables, findBlockContent } from "@myoxus/theme";
