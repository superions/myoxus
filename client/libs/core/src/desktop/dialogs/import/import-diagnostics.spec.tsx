// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.markdown.math-diagnostics": ({ count }: { count: string }) =>
      `${count} source-preserved formulas`,
    "com.myoxus.import.status.success.title": () => "Import completed",
    "com.myoxus.import.status.success.message": () => "Import succeeded",
    "com.myoxus.import.markdown.reference-diagnostics.message": (options: {
      unresolved: string;
      unsupported: string;
    }) =>
      `${options.unresolved} unresolved, ${options.unsupported} unsupported`,
    Complete: () => "Complete",
    "com.myoxus.markdown.table-diagnostics": ({ count }: { count: string }) =>
      `${count} tables retained as HTML source`,
    "com.myoxus.markdown.annotation-diagnostics.message": (options: {
      unsupported: string;
      normalized: string;
    }) =>
      `${options.unsupported} unsupported annotations, ${options.normalized} normalized annotations`,
  }),
}));

import { SuccessStatus } from ".";

afterEach(cleanup);

describe("Markdown import result diagnostics", () => {
  test("unsupported HTML tables remain visibly diagnosed", () => {
    render(
      <MyoxusUIProvider>
        <SuccessStatus
          onComplete={() => {}}
          result={{
            docIds: ["table"],
            markdownDiagnostics: {
              unresolvedReferences: 0,
              unsupportedReferences: 0,
              unsupportedTables: 1,
            },
          }}
        />
      </MyoxusUIProvider>,
    );
    expect(
      screen.getByText("1 tables retained as HTML source").textContent,
    ).toBe("1 tables retained as HTML source");
    expect(screen.queryByText("0 unresolved, 0 unsupported")).toBeNull();
  });
  test("formula loss is visible without unrelated reference or annotation warnings", () => {
    render(
      <MyoxusUIProvider>
        <SuccessStatus
          onComplete={() => {}}
          result={{
            docIds: ["math"],
            markdownDiagnostics: {
              unresolvedReferences: 0,
              unsupportedReferences: 0,
              unsupportedMath: 2,
            },
          }}
        />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("2 source-preserved formulas").textContent).toBe(
      "2 source-preserved formulas",
    );
    expect(screen.queryByText("0 unresolved, 0 unsupported")).toBeNull();
  });
  test("reports annotation loss and normalization without an unrelated reference warning", () => {
    render(
      <MyoxusUIProvider>
        <SuccessStatus
          onComplete={() => {}}
          result={{
            docIds: ["annotations"],
            markdownDiagnostics: {
              unresolvedReferences: 0,
              unsupportedReferences: 0,
              unsupportedAnnotations: 2,
              normalizedAnnotations: 1,
            },
          }}
        />
      </MyoxusUIProvider>,
    );
    expect(
      screen.getByText("2 unsupported annotations, 1 normalized annotations"),
    ).toHaveProperty(
      "textContent",
      "2 unsupported annotations, 1 normalized annotations",
    );
    expect(screen.queryByText("0 unresolved, 0 unsupported")).toBeNull();
  });

  test("does not render a stale warning for a clean retry", () => {
    const view = render(
      <MyoxusUIProvider>
        <SuccessStatus
          onComplete={() => {}}
          result={{
            docIds: ["source"],
            markdownDiagnostics: {
              unresolvedReferences: 2,
              unsupportedReferences: 1,
            },
          }}
        />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("2 unresolved, 1 unsupported").textContent).toBe(
      "2 unresolved, 1 unsupported",
    );

    view.rerender(
      <MyoxusUIProvider>
        <SuccessStatus
          onComplete={() => {}}
          result={{
            docIds: ["clean"],
            markdownDiagnostics: {
              unresolvedReferences: 0,
              unsupportedReferences: 0,
            },
          }}
        />
      </MyoxusUIProvider>,
    );
    expect(screen.queryByText("2 unresolved, 1 unsupported")).toBeNull();
  });
});
