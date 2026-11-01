// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  RecordingDestination,
  WorkbenchMeta,
} from "@myoxus/desktop-api-contract";

/** Persisted tab metadata alone is not an active workspace: login/navigation
 * can retain an old basename. Both the live route and registered server must agree. */
export function deriveRecordingDestination(
  meta:
    Pick<WorkbenchMeta, "basename" | "serverId" | "workspaceName"> | undefined,
  rendererUrl: string,
  server: { id: string; baseUrl: string } | undefined,
  savingMode: RecordingDestination["savingMode"],
): RecordingDestination | undefined {
  const match = meta?.basename.match(/^\/workspace\/([^/]+)$/);
  if (!meta || !match || meta.serverId === undefined) return;
  let actual: RegExpMatchArray | null;
  try {
    actual = new URL(rendererUrl).pathname.match(
      /^\/workspace\/([^/]+)(?:\/|$)/,
    );
  } catch {
    return;
  }
  if (actual?.[1] !== match[1]) return;
  if (meta.serverId !== null && (!server || server.id !== meta.serverId))
    return;
  return {
    workspaceId: match[1],
    workspaceName: meta.workspaceName,
    serverId: meta.serverId,
    serverBaseUrl: server?.baseUrl,
    savingMode,
  };
}
