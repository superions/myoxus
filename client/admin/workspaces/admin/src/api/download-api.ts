// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { adminFetch } from "../fetch-utils";

function adminApiPath(path: string): string {
  const env = (globalThis as { environment?: { subPath?: string } })
    .environment;
  const rawSubPath = typeof env?.subPath === "string" ? env.subPath : "";
  const subPath = rawSubPath.endsWith("/")
    ? rawSubPath.slice(0, -1)
    : rawSubPath;
  return `${subPath}${path}`;
}

export function fetchTemplateRevisionExport(
  revisionId: string,
): Promise<Response> {
  return adminFetch(
    adminApiPath(
      `/api/admin/templates/export/${encodeURIComponent(revisionId)}`,
    ),
    {
      admin: {
        channel: "download",
        operationName: "templateRevisionExport",
      },
    },
  );
}

export type WorkspaceTemplateSourceSelection = {
  docId: string;
};

export type WorkspaceTemplateSourceExportRequest = {
  workspaceId: string;
  source: WorkspaceTemplateSourceSelection;
  metadata: {
    templateId: string;
    version: string;
    title: string;
    locale: string;
    description?: string | null;
    category?: string | null;
    tags?: string[];
    titlePolicy?: "template" | "template-date" | "date" | null;
  };
  localizedSources?: {
    locale: string;
    source: WorkspaceTemplateSourceSelection;
  }[];
};

/** Download the current server-captured sources through the authenticated binary route. */
export function fetchWorkspaceTemplateSourceExport(
  request: WorkspaceTemplateSourceExportRequest,
  signal?: AbortSignal,
): Promise<Response> {
  return adminFetch(
    adminApiPath("/api/admin/templates/workspace-source/export"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
      admin: {
        channel: "download",
        operationName: "workspaceTemplateSourceExport",
      },
    },
  );
}
