/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createDocExplorerContext, DocExplorerContext } from "../context";
import { CardViewDoc, ListViewDoc } from "./doc-list-item";

const mounts = vi.hoisted(() => ({
  favorite: vi.fn(),
  tab: vi.fn(),
}));
const doc$ = new LiveData({ id: "page" });
const title$ = new LiveData("Persisted page");
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: (service: { name: string }) => {
    if (service.name === "DocsService")
      return {
        list: {
          doc$: () => doc$,
          primaryMode$: () => new LiveData(undefined),
          getPrimaryMode: () => undefined,
        },
      };
    if (service.name === "DocumentMetadataCacheService")
      return { watchIndexState: () => new LiveData({ phase: "unloaded" }) };
    if (service.name === "DocDisplayMetaService")
      return { title$: () => title$ };
    if (service.name === "WorkspaceService")
      return { workspace: { flavour: "cloud" } };
    throw new Error(`Unexpected row service: ${service.name}`);
  },
}));
vi.mock("@myoxus/i18n", async (original) => ({
  ...(await original<typeof import("@myoxus/i18n")>()),
  useI18n: () =>
    new Proxy(
      { t: (key: string) => key },
      {
        get: (target, key: string) => (key === "t" ? target.t : () => key),
      },
    ),
}));
vi.mock("./properties", () => ({
  ListViewProperties: () => null,
  CardViewProperties: () => null,
}));
vi.mock("./public-status-action", () => ({
  AllDocsPublicStatusAction: () => null,
}));
vi.mock("./more-menu", () => ({
  MoreMenuButton: () => null,
  MoreMenuContent: () => null,
}));
vi.mock("../../page-list/page-content-preview", () => ({
  PagePreview: (props: { fallback?: React.ReactNode }) => {
    return props.fallback;
  },
}));
vi.mock("../quick-actions.constants", () => {
  const actions = [
    {
      key: "quickFavorite",
      name: "Favorite",
      Component: () => {
        mounts.favorite();
        return <button>Favorite</button>;
      },
    },
    {
      key: "quickTab",
      name: "Open tab",
      Component: () => {
        mounts.tab();
        return <button>Open tab</button>;
      },
    },
  ];
  return { quickActions: actions, listQuickActions: actions };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test.each([ListViewDoc, CardViewDoc])(
  "%s mounts only configured actions and reacts to preference changes",
  (Row) => {
    const context = createDocExplorerContext({
      showDocIcon: false,
      showDocPreview: false,
      showDragHandle: false,
      quickFavorite: true,
      quickTab: false,
    });
    render(
      <MyoxusUIProvider>
        <DocExplorerContext.Provider value={context}>
          <Row docId="page" groupId="all" />
        </DocExplorerContext.Provider>
      </MyoxusUIProvider>,
    );
    expect(screen.getByRole("button", { name: "Favorite" }).textContent).toBe(
      "Favorite",
    );
    expect(mounts.favorite).toHaveBeenCalled();
    expect(mounts.tab).not.toHaveBeenCalled();
    act(() =>
      context.displayPreference$.next({
        ...context.displayPreference$.value,
        quickTab: true,
      }),
    );
    expect(screen.getByRole("button", { name: "Open tab" }).textContent).toBe(
      "Open tab",
    );
    expect(mounts.tab).toHaveBeenCalled();
  },
);
