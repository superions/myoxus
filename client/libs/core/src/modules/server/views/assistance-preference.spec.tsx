// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { AssistanceMode, AssistanceSource } from "@myoxus/graphql";
import { Framework, MemoryMemento } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Subject } from "rxjs";
import { afterEach, expect, test, vi } from "vitest";
import { AuthService } from "../services/auth";
import { ServerService } from "../services/server";
import { UserPreferencesService } from "../services/user-preferences";
import { PreferenceStoreStub } from "../services/user-preferences.test-fixtures";

import { UserPreferencesStore } from "../stores/user-preferences";
import {
  AssistancePreference,
  LocalAssistancePreference,
} from "./assistance-preference";

vi.mock("@myoxus/i18n", async () =>
  (
    await import("../../database/test-i18n-mock")
  ).createDatabaseTestI18nModule(),
);
afterEach(cleanup);

async function setup() {
  const store = new PreferenceStoreStub();
  const accounts = new Subject<{ id: string } | null>();
  const framework = new Framework();
  framework
    .store(UserPreferencesStore, store as unknown as UserPreferencesStore)
    .service(AuthService, {
      session: { account$: accounts },
    } as unknown as AuthService)
    .service(ServerService, {
      server: { id: "server-a" },
    } as unknown as ServerService)
    .service(UserPreferencesService, [
      UserPreferencesStore,
      AuthService,
      ServerService,
    ]);
  const service = framework.provider().get(UserPreferencesService);
  accounts.next({ id: "user-a" });
  await vi.waitFor(() =>
    expect(service.confirmedPreferences$.value).toBeDefined(),
  );
  return { service, store, accounts };
}

test("a failed selection preserves the confirmed inherited mode and never queues the optimistic choice", async () => {
  const { service, store } = await setup();
  try {
    store.assistance = {
      mode: AssistanceMode.Guided,
      source: AssistanceSource.Workspace,
      userDefaultExplicit: true,
      interactiveMode: AssistanceMode.Guided,
    };
    store.failPatches = true;
    render(
      <MyoxusUIProvider env="test">
        <AssistancePreference
          service={service}
          workspaceId="workspace-a"
          projectId="project-a"
        />
      </MyoxusUIProvider>,
    );
    const user = userEvent.setup();
    const select = await screen.findByRole("combobox", {
      name: "Personal assistance",
    });
    await waitFor(() => expect(select.getAttribute("disabled")).toBeNull());
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Automatic" }));
    await screen.findByText(
      "Could not confirm this setting. Your confirmed mode remains active.",
    );
    expect(select).toHaveProperty("value", "Use inherited setting");
    expect(screen.getByText("Confirmed mode: Guided")).toBeDefined();
    expect(store.getCached("server-a", "user-a")?.pendingPatch).toEqual({});
    expect(store.patchCalls).toEqual([
      {
        projectAssistanceOverrides: [
          {
            workspaceId: "workspace-a",
            projectId: "project-a",
            mode: AssistanceMode.Automatic,
          },
        ],
      },
    ]);
  } finally {
    service.dispose();
  }
});

test("a failed native local mode flush keeps the watched confirmed choice and displays its error", async () => {
  const state = new MemoryMemento();
  const flush = Promise.withResolvers<void>();
  const persist = vi.fn(() => flush.promise);
  Object.assign(state, { setConfirmed: persist });
  render(
    <MyoxusUIProvider env="test">
      <LocalAssistancePreference state={state} workspaceId="local-a" />
    </MyoxusUIProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("combobox", { name: "Personal assistance" }),
  );
  await user.click(await screen.findByRole("option", { name: "Automatic" }));
  await waitFor(() => expect(persist).toHaveBeenCalledOnce());
  expect(
    screen.getByRole("combobox", { name: "Personal assistance" }),
  ).toHaveProperty("value", "Manual");
  await act(async () => {
    flush.reject(new Error("flush failed"));
  });
  await screen.findByText(
    "Could not confirm this setting. Your confirmed mode remains active.",
  );
  expect(
    screen.getByRole("combobox", { name: "Personal assistance" }),
  ).toHaveProperty("value", "Manual");
});
