import type { Workspace } from "@myoxus/core/modules/workspace";
import { I18n } from "@myoxus/i18n";

/** Wait for local writes and their server acknowledgement, not merely loading. */
export async function waitForDocumentVersionSync(
  workspace: Workspace,
  docId: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    await workspace.engine.doc.waitForSynced(workspace.id, controller.signal);
    await workspace.engine.doc.waitForSynced(docId, controller.signal);
  } catch (cause) {
    throw new Error(I18n.t("com.myoxus.common.document-sync-required"), {
      cause,
    });
  } finally {
    clearTimeout(timeout);
  }
}
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
