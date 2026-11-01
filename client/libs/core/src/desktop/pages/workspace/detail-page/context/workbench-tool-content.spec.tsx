/**
 * @vitest-environment happy-dom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import dayjs, { type Dayjs } from "dayjs";
import type { ComponentProps, PropsWithChildren } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const journalState = vi.hoisted(() => ({
  selectedDate: {
    format: () => "2026-07-18",
  } as unknown as Dayjs,
  view: "month" as const,
  readonly: false,
  calendarLoading: true,
  calendarError: null,
  allJournalDates: new Set<string>(),
  calendarCursor: {
    format: () => "2026-07-18",
  } as unknown as Dayjs,
  eventDates: new Set<string>(),
  isJournal: false,
  showWeekNumbers: true,
  eventCountForDate: () => 0,
  eventDateColor: () => null,
  onCalendarCursorChange: vi.fn(),
  onDateSelect: vi.fn(),
  onViewChange: vi.fn(),
  refreshCalendar: vi.fn(async () => undefined),
}));

vi.mock("@myoxus/core/components/guard", () => ({
  useGuard: () => true,
}));

vi.mock("@myoxus/core/modules/server", () => ({
  GraphQLService: class GraphQLService {},
}));

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class WorkspaceService {},
}));

vi.mock("@myoxus/core/modules/workbench", () => ({
  useIsActiveView: () => true,
}));

vi.mock("@myoxus/core/modules/document-metadata", () => ({
  DocumentMetadataCacheService: class DocumentMetadataCacheService {},
  DocumentMetadataEditorView: ({ docId }: { docId: string }) => (
    <div data-testid="metadata-body">metadata:{docId}</div>
  ),
}));

vi.mock("@myoxus/core/modules/doc-versioning/versions-sidebar", () => ({
  DocumentVersionsSidebar: ({ docId }: { docId: string }) => (
    <div data-testid="versions-body">versions:{docId}</div>
  ),
}));

vi.mock("@myoxus/core/modules/pdf-export/history-panel", () => ({
  PdfExportHistoryPanel: ({ docId }: { docId: string }) => (
    <div data-testid="pdf-exports-body">pdf-exports:{docId}</div>
  ),
}));

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  const metadata = new actual.LiveData(null);
  return {
    ...actual,
    useService: () => ({ cache: true, watchModel: () => metadata }),
  };
});

vi.mock("../sidecards/outline", () => ({
  EditorOutlinePanel: () => <div data-testid="outline-body">outline</div>,
}));

vi.mock("./document-organization-context", () => ({
  DocumentOrganizationContext: ({ docId }: { docId: string }) => (
    <div data-testid="organization-body">organization:{docId}</div>
  ),
}));

vi.mock("../sidecards/journal/tool-state", () => ({
  useJournalToolState: () => journalState,
}));

vi.mock("../sidecards/journal/event-sections", () => ({
  EventSections: ({ selectedDate }: { selectedDate: Dayjs }) => (
    <div data-testid="agenda-rows">
      agenda:{selectedDate.format("YYYY-MM-DD")}
    </div>
  ),
}));

vi.mock("../sidecards/journal/activity-list", () => ({
  JournalActivityList: ({ date }: { date: Dayjs }) => (
    <div data-testid="activity-rows">changes:{date.format("YYYY-MM-DD")}</div>
  ),
}));

vi.mock("../sidecards/journal/sidebar-footer", () => ({
  JournalSidebarFooter: () => <div data-testid="calendar-footer">footer</div>,
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      { language: "en" },
      {
        get(target, property) {
          if (property === "language") return target.language;
          return () => String(property);
        },
      },
    ),
}));

import { JournalActivityToolBody } from "../sidecards/journal/activity-tool";
import { JournalAgendaToolBody } from "../sidecards/journal/agenda-tool";
import { JournalCalendarToolBody } from "../sidecards/journal/calendar-tool";
import {
  DocumentInfoToolBody,
  DocumentOutlineToolBody,
  DocumentPdfExportsToolBody,
  DocumentToolContentProvider,
  DocumentVersionsToolBody,
} from "./document-context-overview";

function TestProviders({ children }: PropsWithChildren) {
  return <MyoxusUIProvider>{children}</MyoxusUIProvider>;
}

function DocumentProvider({ children }: PropsWithChildren) {
  const props: ComponentProps<typeof DocumentToolContentProvider> = {
    docId: "doc-1",
    docTitle: "Document",
    editor: null,
    workspaceId: "workspace-1",
    children,
  };
  return <DocumentToolContentProvider {...props} />;
}

afterEach(() => {
  cleanup();
  journalState.selectedDate = dayjs("2026-07-18");
});

describe("Workbench tool content ownership", () => {
  test.each([
    [
      DocumentOutlineToolBody,
      "outline-body",
      [
        "organization-body",
        "metadata-body",
        "versions-body",
        "pdf-exports-body",
      ],
    ],
    [
      DocumentInfoToolBody,
      "organization-body",
      ["outline-body", "versions-body", "pdf-exports-body"],
    ],
    [
      DocumentVersionsToolBody,
      "versions-body",
      [
        "outline-body",
        "organization-body",
        "metadata-body",
        "pdf-exports-body",
      ],
    ],
    [
      DocumentPdfExportsToolBody,
      "pdf-exports-body",
      ["outline-body", "organization-body", "metadata-body", "versions-body"],
    ],
  ] as const)(
    "renders one document sidecard body without a combined presenter",
    (Body, expected, excluded) => {
      render(
        <TestProviders>
          <DocumentProvider>
            <Body />
          </DocumentProvider>
        </TestProviders>,
      );

      expect(screen.getByTestId(expected)).toBeTruthy();
      for (const testId of excluded) {
        expect(screen.queryByTestId(testId)).toBeNull();
      }
    },
  );

  test("keeps calendar, agenda and changes rows in their owning Journal bodies", () => {
    const bodies = [
      [
        JournalCalendarToolBody,
        "calendar-footer",
        ["agenda-rows", "activity-rows"],
      ],
      [
        JournalAgendaToolBody,
        "agenda-rows",
        ["calendar-footer", "activity-rows"],
      ],
      [
        JournalActivityToolBody,
        "activity-rows",
        ["calendar-footer", "agenda-rows"],
      ],
    ] as const;

    for (const [Body, expected, excluded] of bodies) {
      const view = render(
        <TestProviders>
          <Body />
        </TestProviders>,
      );
      expect(screen.getByTestId(expected)).toBeTruthy();
      for (const testId of excluded) {
        expect(screen.queryByTestId(testId)).toBeNull();
      }
      view.unmount();
    }
  });

  test("agenda and activity consume the same selected Journal date", () => {
    const view = render(
      <TestProviders>
        <JournalAgendaToolBody />
        <JournalActivityToolBody />
      </TestProviders>,
    );
    expect(screen.getByTestId("agenda-rows").textContent).toContain(
      "2026-07-18",
    );
    expect(screen.getByTestId("activity-rows").textContent).toContain(
      "2026-07-18",
    );

    journalState.selectedDate = dayjs("2026-07-19");
    view.rerender(
      <TestProviders>
        <JournalAgendaToolBody />
        <JournalActivityToolBody />
      </TestProviders>,
    );
    expect(screen.getByTestId("agenda-rows").textContent).toContain(
      "2026-07-19",
    );
    expect(screen.getByTestId("activity-rows").textContent).toContain(
      "2026-07-19",
    );
  });
});
