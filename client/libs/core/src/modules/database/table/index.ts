// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public contract for the server-backed Database Table view.
//
// Public entry point for the active Table view helpers. Every export
// here is a plain serialisable shape; none of these names extend or
// depend on any Virgultum data-view preset module and none import
// the legacy adapter module.

export { DatabaseTableView } from "./database-table-view";
