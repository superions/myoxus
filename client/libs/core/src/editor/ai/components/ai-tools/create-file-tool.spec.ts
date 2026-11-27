// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { describe, expect, test } from "vitest";

import type {
  CopilotGeneratedFile,
  StreamObject,
} from "../ai-chat-messages/type";
import {
  collectToolCreatedFileIds,
  CREATE_FILE_TOOL_NAME,
  resolveCreateFileDescriptor,
} from "./create-file-tool";

describe("create_file tool projection", () => {
  const validResult = {
    fileId: "file-1",
    messageId: "msg-orig",
    fileName: "Summary.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4200,
    format: "pdf",
  };

  test("derives a fresh authenticated download URL from current message ID during live streaming", () => {
    const live = resolveCreateFileDescriptor(validResult, "", []);
    expect(live).toEqual({
      id: "file-1",
      fileName: "Summary.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4200,
      format: "pdf",
      downloadUrl: "/api/copilot/messages/msg-orig/files/file-1",
    });

    const reconciled = resolveCreateFileDescriptor(validResult, "msg-fork", []);
    expect(reconciled?.downloadUrl).toBe(
      "/api/copilot/messages/msg-fork/files/file-1",
    );
  });

  test("prefers server-projected generatedFiles entry after reload or fork remapping", () => {
    const restored: CopilotGeneratedFile[] = [
      {
        id: "file-fork-1",
        fileName: "Summary.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4200,
        format: "pdf",
        downloadUrl: "/api/copilot/messages/msg-fork/files/file-fork-1",
      },
    ];
    const resolved = resolveCreateFileDescriptor(
      { ...validResult, fileId: "file-fork-1", messageId: "msg-fork" },
      "msg-fork",
      restored,
    );
    expect(resolved).toBe(restored[0]);
  });

  test("rejects error, malformed, or unsupported results without producing a download", () => {
    expect(
      resolveCreateFileDescriptor(
        { type: "error", name: "File creation canceled" },
        "msg-1",
      ),
    ).toBeNull();
    expect(
      resolveCreateFileDescriptor({ ...validResult, format: "docx" }, "msg-1"),
    ).toBeNull();
    expect(
      resolveCreateFileDescriptor({ ...validResult, messageId: "" }, ""),
    ).toBeNull();
  });

  test("deduplicates only successful create_file results against message generatedFiles", () => {
    const streamObjects: StreamObject[] = [
      {
        type: "tool-result",
        toolCallId: "call-bad",
        toolName: CREATE_FILE_TOOL_NAME,
        args: { title: "Bad", format: "pdf", markdown: "x" },
        result: { type: "error", name: "Unsupported content" },
      },
      {
        type: "tool-result",
        toolCallId: "call-ok",
        toolName: CREATE_FILE_TOOL_NAME,
        args: { title: "Summary", format: "pdf", markdown: "# Summary" },
        result: validResult,
      },
    ];
    const ids = collectToolCreatedFileIds(streamObjects, "msg-orig");
    expect([...ids]).toEqual(["file-1"]);
  });
});
