#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import process from "node:process";

const endpoint = process.env.MYOXUS_MCP_URL;
const token = process.env.MYOXUS_MCP_TOKEN;
const importWorkspaceId = process.env.MYOXUS_MCP_IMPORT_WORKSPACE_ID;
const clientName =
  process.env.MYOXUS_MCP_CLIENT_NAME ?? "generic-streamable-http-smoke";
const expectUnauthorized = process.argv.includes("--expect-unauthorized");

if (!endpoint || !token || (!expectUnauthorized && !importWorkspaceId)) {
  throw new Error(
    "MYOXUS_MCP_URL, MYOXUS_MCP_TOKEN and MYOXUS_MCP_IMPORT_WORKSPACE_ID are required",
  );
}

let requestId = 0;

async function rpc(method, params = {}, notification = false) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(notification ? {} : { id: ++requestId }),
      method,
      params,
    }),
  });

  if (expectUnauthorized) {
    if (response.status !== 401) {
      throw new Error(
        `revoked key returned HTTP ${response.status}, expected 401`,
      );
    }
    return null;
  }

  if (notification) {
    if (response.status !== 202 || (await response.text()) !== "") {
      throw new Error(
        `notification returned HTTP ${response.status} with a body`,
      );
    }
    return null;
  }
  if (!response.ok) {
    throw new Error(`MCP request ${method} returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.jsonrpc !== "2.0" || body.id !== requestId) {
    throw new Error(`${method} returned an invalid JSON-RPC envelope`);
  }
  return body;
}

if (expectUnauthorized) {
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: clientName, version: "1" },
  });
  process.stdout.write(`${JSON.stringify({ revokedKeyRejected: true })}\n`);
  process.exit(0);
}

const initialized = await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: clientName, version: "1" },
});
const negotiatedProtocol = initialized.result?.protocolVersion;
const instructions = initialized.result?.instructions;
if (negotiatedProtocol !== "2025-11-25" || typeof instructions !== "string") {
  throw new Error(
    "initialize did not negotiate the verified protocol and instructions",
  );
}
await rpc("notifications/initialized", {}, true);

const tools = [];
let cursor;
do {
  const listed = await rpc("tools/list", cursor ? { cursor } : {});
  const page = listed.result?.tools;
  if (!Array.isArray(page) || page.length === 0) {
    throw new Error("tools/list returned an empty or invalid page");
  }
  tools.push(...page);
  cursor = listed.result?.nextCursor;
} while (cursor);

const names = tools.map((tool) => tool.name);
if (new Set(names).size !== names.length) {
  throw new Error("tools/list pagination returned duplicate tools");
}
for (const tool of tools) {
  if (
    tool.inputSchema?.type !== "object" ||
    tool.outputSchema?.type !== "object" ||
    typeof tool.annotations?.readOnlyHint !== "boolean" ||
    typeof tool.annotations?.destructiveHint !== "boolean" ||
    typeof tool.annotations?.idempotentHint !== "boolean" ||
    tool.annotations?.openWorldHint !== false
  ) {
    throw new Error(`tool ${tool.name} has an incomplete public contract`);
  }
}

const read = await rpc("tools/call", {
  name: "list_workspaces",
  arguments: { limit: 1 },
});
const structured = read.result?.structuredContent;
const text = read.result?.content?.[0]?.text;
if (
  !structured ||
  JSON.stringify(JSON.parse(text)) !== JSON.stringify(structured)
) {
  throw new Error("tools/call text and structured results differ");
}

async function callTool(name, arguments_) {
  const response = await rpc("tools/call", { name, arguments: arguments_ });
  if (response.error || response.result?.isError) {
    throw new Error(
      `${name} failed: ${JSON.stringify(response.error ?? response.result?.structuredContent)}`,
    );
  }
  return response.result.structuredContent;
}

const workspaceId = importWorkspaceId;
const importFolderName = `MCP import smoke ${crypto.randomUUID()}`;
let importFolderId;
let importEntryId;
let importedExternalId;
let importEntryDeleted = false;
let importedDocumentDeleted = false;
let importFolderDeleted = false;
try {
  const ensured = await callTool("folder_path_ensure", {
    workspace_id: importWorkspaceId,
    path: [importFolderName],
    idempotency_key: `mcp-runtime-import-folder-${crypto.randomUUID()}`,
  });
  importFolderId = ensured.folderId;
  const imported = await callTool("document_import", {
    workspace_id: importWorkspaceId,
    title: "MCP isolated document import smoke",
    content_markdown: "# Imported through MCP\n\nIsolated runtime fixture.",
    folder_id: importFolderId,
    idempotency_key: `mcp-runtime-document-import-${crypto.randomUUID()}`,
  });
  importEntryId = imported.entryId;
  importedExternalId = imported.externalId;
  if (
    imported.folderId !== importFolderId ||
    imported.inputMode !== "markdown" ||
    !importEntryId ||
    !importedExternalId ||
    imported.docId ||
    imported.doc_id
  ) {
    throw new Error("document_import returned an invalid bounded result");
  }
  const importedReadback = await callTool("read_doc", {
    workspace_id: importWorkspaceId,
    external_id: importedExternalId,
    representation: "structured",
    limit: 20,
  });
  if (importedReadback.document?.externalId !== importedExternalId) {
    throw new Error(
      "document_import readback did not preserve external identity",
    );
  }
  const pages = await callTool("list_pages", {
    workspace_id: workspaceId,
    limit: 20,
  });
  const importedPage = pages.pages?.find(
    (page) => page.externalId === importedExternalId,
  );
  if (!importedPage || importedPage.docId || importedPage.doc_id) {
    throw new Error(
      "list_pages did not return the imported explicit externalId",
    );
  }
  const metadata = await callTool("doc_metadata_get", {
    workspace_id: workspaceId,
    external_id: importedExternalId,
  });
  if (
    metadata.documentMetadata?.externalId !== importedExternalId ||
    metadata.documentMetadata?.docId ||
    metadata.documentMetadata?.doc_id
  ) {
    throw new Error(
      "doc_metadata_get did not preserve the imported external document key",
    );
  }
} finally {
  try {
    if (importEntryId) {
      await callTool("folder_entry_delete", {
        workspace_id: importWorkspaceId,
        entry_id: importEntryId,
        idempotency_key: `mcp-runtime-import-entry-cleanup-${crypto.randomUUID()}`,
      });
      importEntryDeleted = true;
    }
  } finally {
    try {
      if (importedExternalId) {
        await callTool("delete_page", {
          workspace_id: importWorkspaceId,
          external_id: importedExternalId,
          idempotency_key: `mcp-runtime-import-document-cleanup-${crypto.randomUUID()}`,
        });
        importedDocumentDeleted = true;
      }
    } finally {
      if (importFolderId) {
        await callTool("folder_delete", {
          workspace_id: importWorkspaceId,
          folder_id: importFolderId,
          idempotency_key: `mcp-runtime-import-folder-cleanup-${crypto.randomUUID()}`,
        });
        importFolderDeleted = true;
      }
    }
  }
}
const writeKey = `mcp-runtime-create-${crypto.randomUUID()}`;
const start = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
start.setUTCHours(10, 0, 0, 0);
const end = new Date(start.getTime() + 30 * 60 * 1000);
const createArguments = {
  workspace_id: workspaceId,
  title: "MCP runtime compatibility smoke",
  starts_at: start.toISOString(),
  ends_at: end.toISOString(),
  idempotency_key: writeKey,
};
let eventId;
let deleted = false;
try {
  const created = await callTool("calendar_event_create", createArguments);
  eventId = created.id;
  const replay = await callTool("calendar_event_create", createArguments);
  if (JSON.stringify(replay) !== JSON.stringify(created)) {
    throw new Error(
      "idempotent calendar create did not replay the original result",
    );
  }
  const conflict = await rpc("tools/call", {
    name: "calendar_event_create",
    arguments: { ...createArguments, title: "changed replay payload" },
  });
  if (
    conflict.result?.isError !== true ||
    conflict.result?.structuredContent?.code !== "CONFLICT"
  ) {
    throw new Error(
      "changed idempotency payload did not return a typed conflict",
    );
  }
  const deleteArguments = {
    workspace_id: workspaceId,
    event_id: eventId,
    idempotency_key: `mcp-runtime-delete-${crypto.randomUUID()}`,
  };
  const deletion = await callTool("calendar_event_delete", deleteArguments);
  const deleteReplay = await callTool("calendar_event_delete", deleteArguments);
  if (
    deletion.deleted !== true ||
    JSON.stringify(deleteReplay) !== JSON.stringify(deletion)
  ) {
    throw new Error("calendar delete did not complete and replay exactly");
  }
  deleted = true;
} finally {
  if (eventId && !deleted) {
    await callTool("calendar_event_delete", {
      workspace_id: workspaceId,
      event_id: eventId,
      idempotency_key: `mcp-runtime-cleanup-${crypto.randomUUID()}`,
    });
  }
}

const typedFailure = await rpc("tools/call", {
  name: "list_pages",
  arguments: {},
});
if (
  typedFailure.result?.isError !== true ||
  typedFailure.result?.structuredContent?.code !== "INVALID_ARGUMENT"
) {
  throw new Error(
    "known-tool validation was not returned as a typed tool error",
  );
}

const unknown = await rpc("tools/call", {
  name: "myoxus_unknown_compatibility_probe",
  arguments: {},
});
if (unknown.error?.code !== -32601 || unknown.result !== undefined) {
  throw new Error("unknown tool was not returned as JSON-RPC method-not-found");
}

process.stdout.write(
  `${JSON.stringify({
    clientName,
    negotiatedProtocol,
    server: initialized.result.serverInfo,
    instructions: true,
    toolCount: tools.length,
    structuredResults: true,
    documentImport:
      importEntryDeleted && importedDocumentDeleted && importFolderDeleted,
    idempotentWrite: true,
    conflictResult: true,
    destructiveCleanup: true,
    typedToolErrors: true,
    protocolErrors: true,
  })}\n`,
);
