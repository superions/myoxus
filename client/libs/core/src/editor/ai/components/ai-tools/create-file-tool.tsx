// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { DownloadIcon } from "@myoxus/icons/react";
import { useLayoutEffect, useRef, useState } from "react";

import { AIProvider } from "../../provider";
import type {
  CopilotGeneratedFile,
  StreamObject,
} from "../ai-chat-messages/type";
import { GeneratedFilesView } from "../generated-files-view";
import { toolCallCard, toolFailedCard } from "./tool-cards";

export const CREATE_FILE_TOOL_NAME = "create_file";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Derive a fresh authenticated download descriptor from a completed
 * `create_file` tool result and the owning message's current identity.
 *
 * Prefers server-projected `generatedFiles` entries (including fork-remapped
 * IDs) and derives `/api/copilot/messages/<messageId>/files/<fileId>` freshly
 * during live streaming before final history reconciliation arrives.
 */
export function resolveCreateFileDescriptor(
  rawResult: unknown,
  messageId: string | undefined,
  generatedFiles?: readonly CopilotGeneratedFile[],
): CopilotGeneratedFile | null {
  const result = record(rawResult);
  if (result.type === "error") return null;

  const fileId = nonEmptyString(result.fileId);
  const fileName = nonEmptyString(result.fileName);
  const mimeType = nonEmptyString(result.mimeType);
  const format = nonEmptyString(result.format);
  const sizeBytes = result.sizeBytes;
  if (
    !fileId ||
    !fileName ||
    !mimeType ||
    (format !== "pdf" && format !== "html") ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0
  ) {
    return null;
  }

  const restored = generatedFiles?.find((entry) => entry.id === fileId);
  if (restored) return restored;

  const ownerMessageId =
    nonEmptyString(messageId) ?? nonEmptyString(result.messageId);
  if (!ownerMessageId) return null;

  return {
    id: fileId,
    fileName,
    mimeType,
    sizeBytes,
    format,
    downloadUrl: `/api/copilot/messages/${encodeURIComponent(ownerMessageId)}/files/${encodeURIComponent(fileId)}`,
  };
}

/**
 * Collect file IDs already projected by successful `create_file` tool results
 * so `CopilotResponseActions` does not render a duplicate file row for the same file.
 */
export function collectToolCreatedFileIds(
  streamObjects?: readonly StreamObject[],
  messageId?: string,
  generatedFiles?: readonly CopilotGeneratedFile[],
): Set<string> {
  const ids = new Set<string>();
  if (!streamObjects?.length) return ids;
  for (const item of streamObjects) {
    if (item.type !== "tool-result" || item.toolName !== CREATE_FILE_TOOL_NAME)
      continue;
    const descriptor = resolveCreateFileDescriptor(
      item.result,
      messageId,
      generatedFiles,
    );
    if (descriptor) ids.add(descriptor.id);
  }
  return ids;
}

export function CreateFileToolView({
  data,
  generating,
  contained,
  messageId,
  generatedFiles,
  downloadSavedFile,
}: {
  data: Extract<StreamObject, { type: "tool-call" | "tool-result" }>;
  generating: boolean;
  contained?: boolean;
  messageId?: string;
  generatedFiles?: readonly CopilotGeneratedFile[];
  downloadSavedFile?: (
    file: CopilotGeneratedFile,
    current: () => boolean,
  ) => Promise<void>;
}) {
  const t = useI18n();
  const [downloadStatus, setDownloadStatus] = useState<
    "idle" | "pending" | "failed"
  >("idle");
  const operationRef = useRef<symbol | null>(null);
  useLayoutEffect(
    () => () => {
      operationRef.current = null;
    },
    [],
  );

  const icon = <DownloadIcon />;
  const failedCard = () =>
    toolFailedCard({
      name: t["com.myoxus.ai.tools.failed"]({
        tool: t["com.myoxus.ai.tools.create-file"](),
      }),
      icon,
      contained,
    });

  if (data.type === "tool-call") {
    return generating
      ? toolCallCard({
          name: t["com.myoxus.ai.file-export.pending"](),
          icon,
          contained,
        })
      : failedCard();
  }

  const descriptor = resolveCreateFileDescriptor(
    data.result,
    messageId,
    generatedFiles,
  );
  if (!descriptor) return failedCard();

  async function runDownload(file: CopilotGeneratedFile) {
    if (operationRef.current) return;
    const operation = Symbol();
    operationRef.current = operation;
    const current = () => operationRef.current === operation;
    setDownloadStatus("pending");
    try {
      if (downloadSavedFile) {
        await downloadSavedFile(file, current);
      } else {
        const download = AIProvider.session?.downloadGeneratedFile;
        if (!download) {
          throw new Error("Saved file transport unavailable");
        }
        await download(file);
      }
      if (current()) setDownloadStatus("idle");
    } catch {
      if (current()) setDownloadStatus("failed");
    } finally {
      if (current()) operationRef.current = null;
    }
  }

  return (
    <GeneratedFilesView
      files={[descriptor]}
      pending={downloadStatus === "pending"}
      failed={downloadStatus === "failed"}
      download={(file) => {
        void runDownload(file);
      }}
    />
  );
}
