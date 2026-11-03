// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Workspace } from "../workspace";
import type { Store } from "@virgultum/editor/store";

export const SOURCE_SYNC_TIMEOUT_MS = 30_000;

/** A server export must observe both committed root membership and leaf edits.
 * Waiting never writes an unloaded local document or creates a named version. */
export async function waitForServerDocumentSync(
  page: Store,
  workspace: Workspace,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort("export-source-sync-timeout"),
    SOURCE_SYNC_TIMEOUT_MS,
  );
  try {
    await workspace.engine.doc.waitForSynced(workspace.id, controller.signal);
    await workspace.engine.doc.waitForSynced(page.id, controller.signal);
    return true;
  } catch {
    // Do not dispatch after a failed barrier: the server cannot export edits
    // that have not reached persistence. Error payloads may contain private data.
    console.warn("file export: source synchronization did not complete", {
      workspaceId: workspace.id,
      docId: page.id,
    });
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}
