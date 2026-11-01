// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { UserFriendlyError } from "@myoxus/error";
import { Framework, LiveData, MemoryMemento } from "@myoxus/infra";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Server } from "../../server/entities/server";
import { WorkspaceServerService } from "../../server/services/workspace-server";
import { GlobalState } from "../../storage";
import { WorkspaceService } from "../../workspace";
import { GuardService } from "../services/guard";
import { GuardStore } from "./guard";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, isElectron: true });
});
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function setup(
  state = new MemoryMemento(),
  options: {
    server?: string;
    origin?: string;
    account?: string;
    workspace?: string;
  } = {},
) {
  const account$ = new LiveData<{ id: string } | null>({
    id: options.account ?? "account-a",
  });
  const gql = vi.fn(async () => ({
    workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: true } } },
  }));
  const server = {
    id: options.server ?? "server-a",
    baseUrl: options.origin ?? "https://first.example",
    account$,
    gql,
  } as unknown as Server;
  const server$ = new LiveData(server);
  const framework = new Framework();
  framework
    .impl(GlobalState, state)
    .service(WorkspaceService, {
      workspace: {
        id: options.workspace ?? "workspace-a",
        flavour: server.id,
        openOptions: {},
      },
    } as WorkspaceService)
    .service(WorkspaceServerService, {
      server$,
      get server() {
        return server$.value;
      },
    } as WorkspaceServerService)
    .store(GuardStore, [WorkspaceService, WorkspaceServerService, GlobalState])
    .service(GuardService, [GuardStore, WorkspaceService]);
  const provider = framework.provider();
  const store = provider.get(GuardStore);
  const guard = provider.get(GuardService);
  const read$ = guard.can$("Doc_Read", "doc-a");
  const subscription = read$.subscribe();
  const dispose = () => {
    subscription.unsubscribe();
    guard.dispose();
    store.dispose();
  };
  cleanups.push(dispose);
  return { store, guard, read$, account$, gql, state, dispose };
}

function failure(name: "NETWORK_ERROR" | "ACCESS_DENIED") {
  return new UserFriendlyError({
    name,
    type: name,
    code: name,
    status: name === "NETWORK_ERROR" ? 504 : 403,
    message: name,
  });
}

test("the consuming guard restores confirmed rights after restart, retains them offline, and applies reconnect revocation", async () => {
  const first = setup();
  expect(first.read$.value).toBeUndefined();
  await first.store.getDocPermissions("doc-a");
  expect(first.read$.value).toBe(true);
  first.dispose();
  const restarted = setup(first.state);
  expect(restarted.read$.value).toBe(true);
  expect(restarted.guard.can$("Doc_Read", "unknown-doc").value).toBeUndefined();
  restarted.gql.mockRejectedValueOnce(failure("NETWORK_ERROR"));
  await expect(restarted.guard.can("Doc_Update", "doc-a")).resolves.toBe(true);
  expect(restarted.read$.value).toBe(true);
  restarted.gql.mockResolvedValueOnce({
    workspace: { doc: { permissions: { Doc_Read: false, Doc_Update: false } } },
  });
  await restarted.store.getDocPermissions("doc-a");
  expect(restarted.read$.value).toBe(false);
  restarted.dispose();
  expect(setup(first.state).read$.value).toBe(false);
});

test("server, origin, account, workspace and document boundaries never reuse a different owner's grant", async () => {
  const original = setup();
  await original.store.getDocPermissions("doc-a");
  for (const options of [
    { server: "server-b" },
    { origin: "https://second.example" },
    { account: "account-b" },
    { workspace: "workspace-b" },
  ]) {
    expect(setup(original.state, options).read$.value).toBeUndefined();
  }
  expect(original.guard.can$("Doc_Read", "doc-b").value).toBeUndefined();
  original.account$.next(null);
  expect(original.read$.value).toBeUndefined();
  original.account$.next({ id: "account-a" });
  expect(original.read$.value).toBeUndefined();
});

test("an old account response cannot restore a grant even after logout and login as the same account", async () => {
  const owner = setup();
  let resolve!: (value: Awaited<ReturnType<typeof owner.gql>>) => void;
  owner.gql.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = owner.store.getDocPermissions("doc-a");
  owner.account$.next(null);
  owner.account$.next({ id: "account-a" });
  resolve({
    workspace: { doc: { permissions: { Doc_Read: true, Doc_Update: true } } },
  });
  await expect(pending).rejects.toThrow("account changed");
  expect(owner.read$.value).toBeUndefined();
  expect(owner.state.keys()).toEqual([]);
});

test("server denial closes the cached editor rather than falling back to a previous grant", async () => {
  const owner = setup();
  await owner.store.getDocPermissions("doc-a");
  owner.gql.mockRejectedValueOnce(failure("ACCESS_DENIED"));
  await expect(owner.guard.can("Doc_Read", "doc-a")).rejects.toThrow(
    "ACCESS_DENIED",
  );
  expect(owner.read$.value).toBe(false);
  expect(owner.guard.can$("Doc_Update", "doc-a").value).toBe(false);
});

test("Browser Web does not restore or persist desktop grants and still loads server permissions", async () => {
  const desktop = setup();
  await desktop.store.getDocPermissions("doc-a");
  desktop.dispose();
  vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, isElectron: false });
  const web = setup(desktop.state);
  expect(web.read$.value).toBeUndefined();
  web.gql.mockRejectedValueOnce(failure("NETWORK_ERROR"));
  await expect(web.guard.can("Doc_Read", "doc-a")).rejects.toThrow(
    "NETWORK_ERROR",
  );
  expect(web.read$.value).toBeUndefined();
  await expect(web.guard.can("Doc_Read", "doc-a")).resolves.toBe(true);
  expect(web.read$.value).toBe(true);
  expect(web.state.keys()).toHaveLength(1);
});

test("Browser Web reuses actor-filtered list permissions without a per-row request", () => {
  vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, isElectron: false });
  const web = setup();
  const publish$ = web.guard.can$("Doc_Publish", "doc-a");
  const subscription = publish$.subscribe();
  web.guard.primeIndexedDocPermissions([
    { docId: "internal-a", externalId: "doc-a", canPublish: true },
  ]);

  expect(publish$.value).toBe(true);
  web.guard.revalidateDocPermissionIfMissing("Doc_Publish", "doc-a");
  expect(web.gql).not.toHaveBeenCalled();

  web.guard.primeIndexedDocPermissions([
    { docId: "internal-a", externalId: "doc-a", canPublish: false },
  ]);
  expect(publish$.value).toBe(false);

  web.guard.primeIndexedDocPermissions([]);
  expect(publish$.value).toBeUndefined();

  subscription.unsubscribe();
});
