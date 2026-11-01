// SPDX-License-Identifier: AGPL-3.0-or-later

import { notify } from "@myoxus/ui-facade";
import { describe, expect, test, vi } from "vitest";

import { NotificationServiceImpl } from "./notification-service";

vi.mock("@myoxus/i18n", () => ({
  I18n: {
    "com.myoxus.markdown.endnote-diagnostics": ({ count }: { count: string }) =>
      `${count} endnotes normalize to standard Markdown footnotes`,
    "com.myoxus.markdown.math-diagnostics": ({ count }: { count: string }) =>
      `${count} source-preserved formulas`,
    "com.myoxus.markdown.annotation-diagnostics.title": () =>
      "Annotation fidelity",
    "com.myoxus.markdown.annotation-diagnostics.message": (options: {
      unsupported: string;
      normalized: string;
    }) =>
      `${options.unsupported} unsupported annotations, ${options.normalized} normalized annotations`,
    "com.myoxus.import.markdown.reference-diagnostics.title": () =>
      "Diagnostic title",
    "com.myoxus.import.markdown.reference-diagnostics.message": (options: {
      unresolved: string;
      unsupported: string;
    }) =>
      `${options.unresolved} unresolved, ${options.unsupported} unsupported`,
  },
}));

describe("editor transient-notification facade contract (P-NOTIF-08/09)", () => {
  test("formula-only loss reaches the existing Mantine notification bridge", () => {
    const warning = vi
      .spyOn(notify, "warning")
      .mockImplementation(() => "warning");
    try {
      new NotificationServiceImpl(
        vi.fn(),
        vi.fn(),
      ).notifyMarkdownImportDiagnostics({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
        unsupportedMath: 2,
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith({
        message: "2 source-preserved formulas",
      });
    } finally {
      warning.mockRestore();
    }
  });
  test("endnote placement loss reaches the existing copy/export warning bridge", () => {
    const warning = vi
      .spyOn(notify, "warning")
      .mockImplementation(() => "warning");
    try {
      new NotificationServiceImpl(
        vi.fn(),
        vi.fn(),
      ).notifyMarkdownImportDiagnostics({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
        normalizedEndnotes: 2,
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith({
        message: "2 endnotes normalize to standard Markdown footnotes",
      });
    } finally {
      warning.mockRestore();
    }
  });
  test("annotation-only diagnostics reach the existing warning bridge and clean conversions do not warn", () => {
    const warning = vi
      .spyOn(notify, "warning")
      .mockImplementation(() => "warning");
    try {
      const service = new NotificationServiceImpl(vi.fn(), vi.fn());
      service.notifyMarkdownImportDiagnostics({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
        unsupportedAnnotations: 1,
        normalizedAnnotations: 2,
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith({
        title: "Annotation fidelity",
        message: "1 unsupported annotations, 2 normalized annotations",
      });
      service.notifyMarkdownImportDiagnostics({
        unresolvedReferences: 0,
        unsupportedReferences: 0,
      });
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  test("Markdown import diagnostics reach the localized warning UI", () => {
    const warning = vi
      .spyOn(notify, "warning")
      .mockImplementation(() => "warning");
    const service = new NotificationServiceImpl(vi.fn(), vi.fn());

    service.notifyMarkdownImportDiagnostics({
      unresolvedReferences: 2,
      unsupportedReferences: 1,
    });

    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith({
      title: "Diagnostic title",
      message: "2 unresolved, 1 unsupported",
    });
    warning.mockRestore();
  });
});
