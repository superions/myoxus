// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  type DatabaseDocumentReferenceFieldsFragment,
  DatabaseDocumentReferenceKind,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const demandFixture = vi.hoisted(() => {
  const releaseBacklinks = vi.fn();
  const releaseLinks = vi.fn();
  const acquireBacklinks = vi.fn(() => releaseBacklinks);
  const acquireLinks = vi.fn(() => releaseLinks);
  return {
    acquireBacklinks,
    acquireLinks,
    releaseBacklinks,
    releaseLinks,
    service: {
      backlinks: {
        backlinks$: { value: [{ docId: "source-1" }] },
        databaseReferences$: { value: [{ rowId: "row-1" }] },
        isLoaded$: { value: true },
        acquireLoadDemand: acquireBacklinks,
      },
      links: {
        links$: { value: [{ rawDocId: "one" }, { rawDocId: "two" }] },
        isLoaded$: { value: true },
        acquireLoadDemand: acquireLinks,
      },
    },
  };
});

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useLiveData: (data: { value: unknown }) => data.value,
    useServices: () => ({ docLinksService: demandFixture.service }),
  };
});

vi.mock("@myoxus/core/modules/workbench", () => ({
  WorkbenchLink: ({
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: { pathname: string; search: string };
  }) => <a href={`${to.pathname}${to.search}`} {...props} />,
}));

vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { createDatabaseTestI18nModule } =
    await import("../../modules/database/test-i18n-mock");
  return { ...actual, ...createDatabaseTestI18nModule() };
});

import {
  DatabaseBacklinkReferences,
  useDocumentLinkCounts,
} from "./document-links-content";

afterEach(cleanup);

beforeEach(() => {
  demandFixture.acquireBacklinks.mockClear();
  demandFixture.acquireLinks.mockClear();
  demandFixture.releaseBacklinks.mockClear();
  demandFixture.releaseLinks.mockClear();
});

function reference(
  input: Partial<DatabaseDocumentReferenceFieldsFragment>,
): DatabaseDocumentReferenceFieldsFragment {
  return {
    databaseId: "database-1",
    databaseTitle: "Release roadmap",
    fieldId: null,
    fieldName: null,
    targetWorkspaceId: null,
    rawTargetDocId: "document-1",
    referenceKind: DatabaseDocumentReferenceKind.RowContentDocument,
    refreshedAt: "2026-07-15T12:00:00Z",
    rowId: "row-1",
    rowTitle: "Validate onboarding flow",
    targetDocId: "document-1",
    ...input,
  };
}

describe("Database document backlinks", () => {
  test("keeps Task source and Row content links distinct for the same Row and document", () => {
    const errors = vi.spyOn(console, "error");
    try {
      const source = reference({
        referenceKind: DatabaseDocumentReferenceKind.TaskSource,
      });
      const content = reference({});
      const view = render(
        <MyoxusUIProvider>
          <DatabaseBacklinkReferences references={[source, content]} />
        </MyoxusUIProvider>,
      );
      const links = screen.getAllByRole("link", { name: source.rowTitle });
      expect(links).toHaveLength(2);
      expect(
        links.map((link) => ({
          text: link.textContent,
          href: link.getAttribute("href"),
        })),
      ).toEqual([
        {
          text: `${source.rowTitle}${source.databaseTitle}Source`,
          href: "/databases/database-1?rowId=row-1",
        },
        {
          text: `${content.rowTitle}${content.databaseTitle}Page content`,
          href: "/databases/database-1?rowId=row-1",
        },
      ]);
      expect(screen.queryByText("Database cell reference")).toBeNull();
      view.rerender(
        <MyoxusUIProvider>
          <DatabaseBacklinkReferences references={[content, source]} />
        </MyoxusUIProvider>,
      );
      expect(
        screen
          .getAllByRole("link", { name: source.rowTitle })
          .map((link) => link.textContent),
      ).toEqual([
        `${content.rowTitle}${content.databaseTitle}Page content`,
        `${source.rowTitle}${source.databaseTitle}Source`,
      ]);
      expect(
        errors.mock.calls.some((args) =>
          args.some(
            (value) => typeof value === "string" && value.includes("same key"),
          ),
        ),
      ).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
  test("renders Row content and DocumentLink contexts as Row deep links", () => {
    render(
      <MyoxusUIProvider>
        <DatabaseBacklinkReferences
          references={[
            reference({}),
            reference({
              fieldId: "field-1",
              fieldName: "Specification",
              referenceKind: DatabaseDocumentReferenceKind.DocumentLinkField,
              rowId: "row-2",
              rowTitle: "Review release specification",
            }),
          ]}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Databases")).toBeTruthy();
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(screen.getByText("Database cell reference")).toBeTruthy();
    expect(screen.getByText("Specification")).toBeTruthy();
    expect(
      screen
        .getByTestId("document-links-database-reference-row-1")
        .getAttribute("href"),
    ).toBe("/databases/database-1?rowId=row-1");
    expect(
      screen
        .getByTestId("document-links-database-reference-row-2")
        .getAttribute("href"),
    ).toBe("/databases/database-1?rowId=row-2");
  });
});

describe("Document link count demand", () => {
  test("keeps a closed consumer idle and shares one acquisition while visible", () => {
    const view = renderHook(
      ({ enabled }: { enabled: boolean }) => useDocumentLinkCounts(enabled),
      { initialProps: { enabled: false } },
    );

    expect(demandFixture.acquireBacklinks).not.toHaveBeenCalled();
    expect(demandFixture.acquireLinks).not.toHaveBeenCalled();
    expect(view.result.current.totalCount).toBeUndefined();

    view.rerender({ enabled: true });
    expect(demandFixture.acquireBacklinks).toHaveBeenCalledOnce();
    expect(demandFixture.acquireLinks).toHaveBeenCalledOnce();
    expect(view.result.current.backlinkCount).toBe(2);
    expect(view.result.current.outgoingCount).toBe(2);
    expect(view.result.current.totalCount).toBe(4);

    view.rerender({ enabled: true });
    expect(demandFixture.acquireBacklinks).toHaveBeenCalledOnce();
    expect(demandFixture.acquireLinks).toHaveBeenCalledOnce();

    view.unmount();
    expect(demandFixture.releaseBacklinks).toHaveBeenCalledOnce();
    expect(demandFixture.releaseLinks).toHaveBeenCalledOnce();
  });
});
