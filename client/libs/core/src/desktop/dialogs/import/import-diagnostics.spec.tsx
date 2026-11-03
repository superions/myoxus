// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    language: "en",
    "com.myoxus.conversion.limited": () => "Completed with limitations",
    "com.myoxus.conversion.best-effort": () =>
      "Unsupported Word content may be omitted.",
    "com.myoxus.conversion.details": () => "Conversion details",
    "com.myoxus.conversion.feature.tables": () => "Tables",
    "com.myoxus.conversion.feature.images": () => "Images and diagrams",
    "com.myoxus.conversion.feature.notes": () => "Notes",
    "com.myoxus.conversion.feature.files": () => "Files and external content",
    "com.myoxus.conversion.normalized": ({ count }: { count: string }) =>
      `${count} recognized normalizations`,
    "com.myoxus.conversion.omitted": ({ count }: { count: string }) =>
      `${count} recognized omissions`,
    "com.myoxus.database.document_link.open": () => "Open document",
    "com.myoxus.import.word.unknown-title": () => "Import outcome unknown",
    "com.myoxus.import.word.unknown": () =>
      "The document may already exist. Check workspace contents before importing again.",
    "All content": () => "All content",
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
import { DocxImportStatus } from "./docx-result";

afterEach(cleanup);

test("Word completion exposes grouped observed loss, while unknown creation offers inspection rather than retry", () => {
  const inspect = vi.fn();
  const open = vi.fn();
  const select = vi.fn();
  const context = {
    attemptId: "attempt",
    workspaceId: "origin",
    workspaceName: "Origin workspace",
    origin: "/origin",
    filename: "source.docx",
  };
  const view = render(
    <MyoxusUIProvider>
      <DocxImportStatus
        attempt={{
          ...context,
          status: "complete",
          id: "created",
          title: "Word title",
          ready: true,
          warnings: [
            { code: "merged_cells_normalized", count: 2 },
            { code: "missing_image_omitted", count: 1 },
            { code: "note_numbering_normalized", count: 3 },
            { code: "media_reference_normalized", count: 4 },
            { code: "external_widget_omitted", count: 5 },
          ],
        }}
        onOpen={open}
        onInspect={inspect}
        onSelect={select}
      />
    </MyoxusUIProvider>,
  );
  expect(screen.getByText("Completed with limitations").textContent).toBe(
    "Completed with limitations",
  );
  expect(
    screen.getByText("Unsupported Word content may be omitted.").textContent,
  ).toBe("Unsupported Word content may be omitted.");
  fireEvent.click(screen.getByRole("button", { name: "Conversion details" }));
  expect(screen.getByText("2 recognized normalizations").textContent).toBe(
    "2 recognized normalizations",
  );
  expect(screen.getByText("1 recognized omissions").textContent).toBe(
    "1 recognized omissions",
  );
  expect(screen.getByText("Notes").textContent).toBe("Notes");
  expect(screen.getByText("3 recognized normalizations").textContent).toBe(
    "3 recognized normalizations",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open document" }));
  const files = screen.getByText("Files and external content").parentElement;
  expect(files?.textContent).toContain("4 recognized normalizations");
  expect(files?.textContent).toContain("5 recognized omissions");
  expect(open).toHaveBeenCalledTimes(1);
  view.rerender(
    <MyoxusUIProvider>
      <DocxImportStatus
        attempt={{ ...context, status: "error", reason: "unknown" }}
        onOpen={open}
        onInspect={inspect}
        onSelect={select}
      />
    </MyoxusUIProvider>,
  );
  expect(screen.getByText("Import outcome unknown").textContent).toBe(
    "Import outcome unknown",
  );
  expect(screen.queryByRole("button", { name: "Open document" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All content" }));
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(select).not.toHaveBeenCalled();
});

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
