// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { notify } from "@myoxus/ui-facade";
import { afterEach, describe, expect, test, vi } from "vitest";

import { notifyImportResult } from "./import";

const t = {
  "com.myoxus.import.markdown.reference-diagnostics.title": () =>
    "Diagnostic title",
  "com.myoxus.import.markdown.reference-diagnostics.message": (options: {
    unresolved: string;
    unsupported: string;
  }) => `${options.unresolved} unresolved, ${options.unsupported} unsupported`,
  "com.myoxus.import.status.success.title": () => "Import completed",
  "com.myoxus.import.status.success.message": () => "Import succeeded",
  "com.myoxus.markdown.table-diagnostics": ({ count }: { count: string }) =>
    `${count} tables retained as HTML source`,
} as never;

afterEach(() => vi.restoreAllMocks());

describe("document import result notification", () => {
  test("does not duplicate the owned Word result with generic success", () => {
    const success = vi
      .spyOn(notify, "success")
      .mockImplementation(() => "success");
    const warning = vi
      .spyOn(notify, "warning")
      .mockImplementation(() => "warning");
    notifyImportResult(t, {
      docIds: ["created"],
      docx: {
        attemptId: "attempt",
        status: "complete",
        id: "created",
        title: "Word title",
        workspaceId: "origin",
        workspaceName: "Origin",
        origin: "/origin",
        ready: true,
        warnings: [{ code: "missing_image_omitted", count: 1 }],
      },
    });
    expect(success).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });
  test("warns with the aggregate Markdown diagnostic counts", () => {
    const warning = vi
      .spyOn(notify, "warning")
      .mockImplementation(() => "warning");
    const success = vi
      .spyOn(notify, "success")
      .mockImplementation(() => "success");

    notifyImportResult(t, {
      docIds: ["source"],
      markdownDiagnostics: {
        unresolvedReferences: 2,
        unsupportedReferences: 1,
      },
    });

    expect(warning).toHaveBeenCalledWith({
      title: "Diagnostic title",
      message: "2 unresolved, 1 unsupported",
    });
    expect(success).not.toHaveBeenCalled();
  });
});
