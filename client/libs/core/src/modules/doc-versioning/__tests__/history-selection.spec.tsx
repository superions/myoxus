/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { EditorService } from "@myoxus/core/modules/editor";
import { GraphQLService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import type { DocumentVersion } from "../types";
import type { HistorySelection } from "../history-selection";

const fixture = vi.hoisted(() => ({
  services: new Map<unknown, unknown>(),
  synchronize: vi.fn(async () => undefined),
  prepared: [] as unknown[],
  previewError: undefined as Error | undefined,
  invalid: false,
  permissions: new Map<string, boolean>(),
}));
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useLiveData: (value: { value: unknown }) => value.value,
  useService: (token: unknown) => {
    if (!fixture.services.has(token))
      throw new Error("Unexpected selection service");
    return fixture.services.get(token);
  },
}));
vi.mock("@myoxus/core/components/guard", () => ({
  useGuard: (action: string) => fixture.permissions.get(action) ?? true,
}));
vi.mock("@myoxus/i18n", async (original) => {
  const actual = await original<typeof import("@myoxus/i18n")>();
  const { readFileSync } = await import("node:fs");
  const en = JSON.parse(
    readFileSync("client/libs/i18n/src/resources/en.json", "utf8"),
  ) as Record<string, string>;
  const translate = (key: string, args?: Record<string, unknown>) =>
    (en[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) =>
      String(args?.[name] ?? ""),
    );
  const t = new Proxy(
    { language: "en", t: translate },
    {
      get: (target, key: string) =>
        key in target
          ? target[key as keyof typeof target]
          : (args?: Record<string, unknown>) => translate(key, args),
    },
  );
  return { ...actual, useI18n: () => t };
});
vi.mock("../document-sync", () => ({
  waitForDocumentVersionSync: fixture.synchronize,
}));
vi.mock("@myoxus/core/editor/virgultum/doc-editor", () => ({
  VirgultumEditor: () => <div>Exact readonly preview</div>,
}));
vi.mock("@myoxus/core/editor/virgultum/mode-switch", () => ({
  PureEditorModeSwitch: () => null,
}));
vi.mock("../history-preview", async (original) => {
  const actual = await original<typeof import("../history-preview")>();
  return {
    ...actual,
    useRestorePage: (...args: Parameters<typeof actual.useRestorePage>) => {
      const state = actual.useRestorePage(...args);
      return {
        ...state,
        prepare: async (target: Parameters<typeof state.prepare>[0]) => {
          const prepared = await state.prepare(target);
          fixture.prepared.push(prepared);
          return prepared;
        },
      };
    },
    useSnapshotPage: () => ({
      page: {
        root: { props: { title: "History selection" } },
        getBlocksByFlavour: () => [],
      },
      error: fixture.previewError,
      retry: vi.fn(),
    }),
  };
});

import { HistoryView } from "@myoxus/core/desktop/pages/workspace/detail-page/history-view";
import { DocService } from "@myoxus/core/modules/doc";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { useState, type PropsWithChildren } from "react";
vi.mock("@myoxus/core/components/hooks/use-document-view-context", () => ({
  useDocumentViewContext: () => undefined,
}));
vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async () => {
    const regional = await import("@myoxus/core/modules/i18n/regional-format");
    const preferences = {
      locale: "en",
      timezone: "Europe/Berlin",
      dateFormat: "year-month-day",
      timeFormat: "24-hour",
    } as const;
    return {
      useRegionalFormatters: () => ({
        formatDateTime: (date: string) =>
          regional.formatRegionalDateTime(date, preferences),
        formatDate: (date: string) =>
          regional.formatRegionalDate(date, preferences),
        formatTime: (date: string) =>
          regional.formatRegionalTime(date, preferences),
      }),
    };
  },
);
vi.mock("@myoxus/core/modules/workbench", async (original) => ({
  ...(await original<typeof import("@myoxus/core/modules/workbench")>()),
  useIsActiveView: () => true,
  ViewHeader: ({ children }: PropsWithChildren) => <header>{children}</header>,
  ViewBody: ({ children }: PropsWithChildren) => <main>{children}</main>,
  ViewTitle: () => null,
}));
let selected: HistorySelection | undefined;
vi.mock("../history-navigation", () => ({
  useHistoryNavigation: () => {
    const [selection, select] = useState(selected);
    return {
      state: {
        open: true,
        invalid: fixture.invalid,
        selection,
        mode: "preview",
      },
      select,
      close: vi.fn(),
      setMode: vi.fn(),
    };
  },
}));

const snapshotId = "9007199254740993";
const captureTime = "2020-02-03T04:05:06.123456+00:00";
function version(id: string): DocumentVersion {
  return {
    id,
    docId: "canonical-doc",
    workspaceId: "workspace",
    docHistoryId: snapshotId,
    versionNo: null,
    label: id,
    description: null,
    createdBy: "user",
    createdAt: "2026-10-11T12:00:00Z",
    isPinned: false,
    isProtected: false,
    policyId: null,
    contentHash: null,
    event: "manual",
    kind: "manual",
  };
}
const history = (id: string) => ({
  id: "document-key",
  snapshotId: id,
  cursor: `${captureTime}|${id}`,
  timestamp: id === snapshotId ? captureTime : "2026-10-11T13:00:00Z",
  origin: "manual",
  editor: null,
});
let histories = [history("901")];
let versions = [version("reference-a"), version("reference-b")];
let available = true;
let gql: ReturnType<typeof vi.fn>;
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
beforeEach(() => {
  // happy-dom lacks FontFaceSet; native Mantine autosize observes its events.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: new EventTarget(),
  });
  histories = [history("901")];
  versions = [version("reference-a"), version("reference-b")];
  available = true;
  fixture.services.clear();
  fixture.synchronize.mockClear();
  fixture.prepared.length = 0;
  fixture.previewError = undefined;
  fixture.invalid = false;
  fixture.permissions.clear();
  gql = vi.fn(async ({ query, variables }) => {
    switch (query.op) {
      case "listHistory":
        return { workspace: { histories } };
      case "documentVersioningOverview":
        return {
          documentVersions: versions,
          documentMetadata: { docId: "canonical-doc" },
        };
      case "historyMetadata":
        return {
          workspace: {
            history: available ? history(variables.snapshotId) : null,
          },
        };
      case "documentHistoryRevision":
        return { documentHistoryRevision: "9007199254740999" };
      default:
        throw new Error(`Unexpected selection operation ${query.op}`);
    }
  });
  fixture.services.set(GraphQLService, { gql });
  fixture.services.set(WorkspaceService, {
    workspace: {
      id: "workspace",
      docCollection: {
        id: "workspace",
        getDoc: () => ({ spaceDoc: { guid: "document-key" } }),
      },
    },
  });
  fixture.services.set(DocService, {
    doc: { id: "document-key", meta$: { map: () => ({ value: false }) } },
  });
  fixture.services.set(DocDisplayMetaService, {
    title$: () => ({ value: "Current document" }),
  });
  fixture.services.set(WorkspaceDialogService, { open: vi.fn() });
  fixture.services.set(EditorService, {
    editor: { mode$: { value: "page" }, editorContainer$: { value: null } },
  });
  fixture.services.set(DocumentMetadataCacheService, {
    hydrateMetadata: vi.fn(async () => undefined),
  });
});
afterEach(() => {
  cleanup();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

function manager(initialSelection?: HistorySelection) {
  selected = initialSelection;
  const surface = () => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MyoxusUIProvider env="test">
        <HistoryView />
      </MyoxusUIProvider>
    </SWRConfig>
  );
  const rendered = render(surface());
  return { ...rendered, refresh: () => rendered.rerender(surface()) };
}
function restoreButton() {
  return screen.getByRole("button", { name: "Restore" });
}
async function selectReference(id: string) {
  const selector = screen.getByRole("combobox", { name: "Document versions" });
  fireEvent.focus(selector);
  fireEvent.click(selector);
  fireEvent.click(await screen.findByRole("option", { name: id }));
}
function metadataTime() {
  return document
    .querySelector('[data-myoxus-ui-role="page-history-preview-header"]')
    ?.getAttribute("data-capture-time");
}

describe("history manager selection consumer", () => {
  test("malformed URL intent is unavailable without a silent initial selection or an inert retry", async () => {
    fixture.invalid = true;
    manager();
    await screen.findByTestId("version-history-item");
    const unavailable = screen.getByTestId("history-unavailable");
    expect(
      within(unavailable).queryByRole("button", { name: "Retry" }),
    ).toBeNull();
    expect(screen.queryByTestId("history-restore-selected")).toBeNull();
    expect(screen.getByTestId("history-back-to-document")).toBeDefined();
  });

  test("a failed preview refresh disables an already-prepared confirmation without a write", async () => {
    const view = manager({ snapshotId, versionId: "reference-a" });
    await waitFor(() =>
      expect(restoreButton()).toHaveProperty("disabled", false),
    );
    fireEvent.click(restoreButton());
    const confirmation = await screen.findByTestId(
      "confirm-restore-history-button",
    );
    expect(confirmation).toHaveProperty("disabled", false);
    fixture.previewError = new Error("Preview access denied");
    view.refresh();
    expect(confirmation).toHaveProperty("disabled", true);
    fireEvent.click(confirmation);
    expect(fixture.prepared).toHaveLength(1);
    expect(
      gql.mock.calls.some(([request]) =>
        ["recoverDoc", "restoreDocumentVersion"].includes(request.query.op),
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });

  test("out-of-page references retain exact capture time; clearing and cancel never restore or recapture", async () => {
    manager();
    await waitFor(() =>
      expect(screen.getByTestId("history-named-version-select")).toBeDefined(),
    );
    await selectReference("reference-a");
    await waitFor(() => expect(metadataTime()).toBe(captureTime));
    expect(
      document.querySelector(`[data-snapshot-id="${snapshotId}"]`),
    ).toBeNull();
    await selectReference("reference-b");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Document versions" }),
      ).toHaveProperty("value", "reference-b"),
    );
    await waitFor(() =>
      expect(restoreButton()).toHaveProperty("disabled", false),
    );
    fireEvent.click(restoreButton());
    const confirmation = await screen.findByTestId(
      "confirm-restore-history-modal",
    );
    expect(confirmation.textContent).toContain("2020-02-03, 05:05");
    expect(fixture.prepared.at(-1)).toEqual({
      target: { versionId: "reference-b" },
      expectedRevision: "9007199254740999",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    await waitFor(() =>
      expect(restoreButton()).toHaveProperty("disabled", false),
    );
    fireEvent.click(restoreButton());
    await screen.findByTestId("confirm-restore-history-modal");
    expect(fixture.synchronize).toHaveBeenCalledTimes(2);
    expect(fixture.prepared.at(-1)).toEqual({
      target: { snapshotId },
      expectedRevision: "9007199254740999",
    });
    expect(gql).toHaveBeenCalledWith({
      query: expect.objectContaining({ op: "historyMetadata" }),
      variables: {
        workspaceId: "workspace",
        pageDocId: "document-key",
        snapshotId,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      gql.mock.calls.every(([request]) =>
        [
          "listHistory",
          "documentVersioningOverview",
          "historyMetadata",
          "documentHistoryRevision",
        ].includes(request.query.op),
      ),
    ).toBe(true);
    expect(metadataTime()).toBe(captureTime);
  });

  test("newest and ordinary timeline clicks do not infer a named target from either reference", async () => {
    histories = [history(snapshotId)];
    manager();
    await waitFor(() =>
      expect(restoreButton()).toHaveProperty("disabled", false),
    );
    expect(
      screen.getByRole("combobox", { name: "Document versions" }),
    ).toHaveProperty("value", "");
    await selectReference("reference-a");
    fireEvent.click(screen.getByTestId("version-history-item"));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Document versions" }),
      ).toHaveProperty("value", ""),
    );
    fireEvent.click(restoreButton());
    await screen.findByTestId("confirm-restore-history-modal");
    expect(fixture.prepared.at(-1)).toEqual({
      target: { snapshotId },
      expectedRevision: "9007199254740999",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      gql.mock.calls.some(([request]) => request.query.op === "recoverDoc"),
    ).toBe(false);
  });

  test.each([{ update: false, restore: true, settings: false }])(
    "keeps mixed command permissions distinct: $update/$restore/$settings",
    async ({ update, restore, settings }) => {
      fixture.permissions.set("Doc_Update", update);
      fixture.permissions.set("Doc_Restore", restore);
      fixture.permissions.set("Workspace_Settings_Update", settings);
      manager({ snapshotId });
      await waitFor(() =>
        expect(
          screen
            .getByTestId("history-restore-selected")
            .hasAttribute("disabled"),
        ).toBe(!restore),
      );
      expect(
        screen
          .getByTestId("history-save-current-state")
          .hasAttribute("disabled"),
      ).toBe(!update);
      expect(!!screen.queryByTestId("history-automation-settings")).toBe(
        settings,
      );
      expect(!!screen.queryByText(/Saving and naming require/)).toBe(!update);
      if (!restore) {
        fireEvent.click(screen.getByTestId("history-restore-selected"));
        expect(
          screen.queryByTestId("confirm-restore-history-modal"),
        ).toBeNull();
      }
      expect(
        gql.mock.calls.some(([request]) =>
          [
            "recoverDoc",
            "restoreDocumentVersion",
            "captureDocumentHistory",
          ].includes(request.query.op),
        ),
      ).toBe(false);
    },
  );

  test.each([
    { cause: "expired snapshot", available: false, versionId: "reference-a" },
  ])("a $cause keeps its ID and disables restore", async (scenario) => {
    available = scenario.available;
    manager({ snapshotId, versionId: scenario.versionId });
    await waitFor(() =>
      expect(
        gql.mock.calls.some(
          ([request]) => request.query.op === "historyMetadata",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeDefined(),
    );
    expect(restoreButton()).toHaveProperty("disabled", true);
    expect(
      gql.mock.calls
        .filter(([request]) => request.query.op === "historyMetadata")
        .every(([request]) => request.variables.snapshotId === snapshotId),
    ).toBe(true);
    expect(
      gql.mock.calls.some(
        ([request]) => request.query.op === "documentHistoryRevision",
      ),
    ).toBe(false);
  });
});
