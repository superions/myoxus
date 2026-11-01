// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-24 — shared Row activity renderer tests.
//
// The renderer resolves every stored event type through the
// `com.myoxus.database.activity.*` i18n namespace, never translates the
// stored column, and never owns data fetching or polling.
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  render as renderComponent,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DatabaseActivityList,
  type DatabaseActivityListProps,
  ROW_ACTIVITY_I18N_KEYS,
} from "./row-activity";

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      { language: "en" },
      {
        get: (target, key) => {
          if (key === "language") return target.language;
          return (vars?: Record<string, string>) => {
            if (!vars) return String(key);
            return `${String(key)}|${Object.entries(vars)
              .map(([name, value]) => `${name}=${value}`)
              .join(",")}`;
          };
        },
      },
    ),
}));

vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@myoxus/core/components/hooks/myoxus/use-user-preferences")
    >()),
    useRegionalFormatters: () => ({
      formatDateTime: (value: string) => value,
    }),
  }),
);

function render(element: ReactElement) {
  return renderComponent(<MyoxusUIProvider>{element}</MyoxusUIProvider>);
}

afterEach(cleanup);

const ENTRIES = [
  {
    id: "evt-1",
    eventType: "row.created",
    actorUserId: "u-1",
    actorDisplayName: "Alice",
    payload: null,
    createdAt: "2026-07-07T10:00:00Z",
  },
  {
    id: "evt-2",
    eventType: "cell.changed",
    actorUserId: null,
    actorDisplayName: null,
    payload: { fieldName: "Status" },
    createdAt: "2026-07-07T11:00:00Z",
  },
  {
    id: "evt-3",
    eventType: "row.content_document_attached",
    actorUserId: "u-2",
    actorDisplayName: "Bob",
    payload: { documentId: "doc-1" },
    createdAt: "2026-07-07T12:00:00Z",
  },
];

function renderActivityList(props: Partial<DatabaseActivityListProps> = {}) {
  return render(
    <DatabaseActivityList
      emptyDescription="No recorded activity"
      emptyTitle="No activity"
      entries={ENTRIES}
      label="Row activity"
      loading={false}
      resolveEventTypeLabel={(eventType) =>
        ROW_ACTIVITY_I18N_KEYS[
          eventType as keyof typeof ROW_ACTIVITY_I18N_KEYS
        ] ?? null
      }
      testIdPrefix="database-row-activity"
      {...props}
    />,
  );
}

describe("DatabaseActivityList", () => {
  test("renders entries in reverse chronological order through i18n keys", () => {
    renderActivityList();

    const messages = screen.getAllByTestId("database-row-activity-message");
    expect(messages).toHaveLength(3);
    // Last entry comes first because the drawer sorts by createdAt desc.
    expect(messages[0].textContent).toContain(
      "com.myoxus.database.activity.content_document_attached",
    );
    expect(messages[1].textContent).toContain(
      "com.myoxus.database.activity.cell_changed",
    );
    expect(messages[2].textContent).toContain(
      "com.myoxus.database.activity.created",
    );
    expect(messages[2].textContent).toContain("actor=Alice");
    expect(document.body.textContent).not.toContain("u-1");
    expect(document.body.textContent).not.toContain("row.created");
  });

  test("renders historical status events without an empty value placeholder", () => {
    renderActivityList({
      entries: [
        {
          id: "evt-status",
          eventType: "row.status_changed",
          actorUserId: "u-1",
          actorDisplayName: "Alice",
          payload: { fieldName: "Status" },
          createdAt: "2026-07-07T10:00:00Z",
        },
      ],
    });

    expect(
      screen.getByTestId("database-row-activity-message").textContent,
    ).toContain(
      "com.myoxus.database.activity.cell_changed|actor=Alice,field=Status",
    );
  });

  test("renders the empty state when no entries exist", () => {
    renderActivityList({ entries: [], resolveEventTypeLabel: () => null });

    expect(screen.getByTestId("database-row-activity-empty")).not.toBeNull();
  });

  test("renders the loading overlay while loading", () => {
    renderActivityList({
      entries: [],
      loading: true,
      resolveEventTypeLabel: () => null,
    });

    expect(
      document.querySelector('[data-myoxus-ui-role="settings-loader"]'),
    ).not.toBeNull();
  });

  test("falls back to the system actor when the entry has no actor", () => {
    renderActivityList({
      entries: [
        {
          id: "evt-1",
          eventType: "row.updated",
          actorUserId: null,
          actorDisplayName: null,
          payload: null,
          createdAt: "2026-07-07T10:00:00Z",
        },
      ],
    });

    const message = screen.getByTestId("database-row-activity-message");
    expect(message.textContent).toContain(
      "com.myoxus.database.activity.updated",
    );
    expect(message.textContent).toContain("actor=");
  });
});
