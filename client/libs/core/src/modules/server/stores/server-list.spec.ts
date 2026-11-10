// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { ServerDeploymentType } from "@myoxus/graphql";
import { Framework, MemoryMemento } from "@myoxus/infra";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GlobalStateService } from "../../storage/services/global";
import { BUILD_IN_SERVERS } from "../constant";
import { ServersService } from "../services/servers";
import { ServerConfigStore } from "./server-config";
import { ServerListStore } from "./server-list";

const native = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@myoxus/desktop-api-contract/bridge", () => ({
  getDesktopBridge: () => ({
    apis: { sharedStorage: { mutateServerRegistry: native.mutate } },
  }),
}));

const originalBuiltIns = [...BUILD_IN_SERVERS];
beforeEach(() => {
  BUILD_IN_SERVERS.splice(0);
});
afterEach(() => {
  vi.unstubAllGlobals();
  BUILD_IN_SERVERS.splice(0, BUILD_IN_SERVERS.length, ...originalBuiltIns);
});

function setup(state = new MemoryMemento()) {
  const fetchServerConfig = vi.fn(async () => ({
    name: "Configured server",
    deploymentType: ServerDeploymentType.Cloud,
    features: [],
    oauthProviders: [],
    credentialsRequirement: { password: { minLength: 8, maxLength: 128 } },
  }));
  const framework = new Framework();
  framework
    .service(GlobalStateService, {
      globalState: state,
    } as unknown as GlobalStateService)
    .store(ServerListStore, [GlobalStateService])
    .store(ServerConfigStore, {
      fetchServerConfig,
    } as unknown as ServerConfigStore)
    .service(ServersService, [ServerListStore, ServerConfigStore]);
  const provider = framework.provider();
  return {
    state,
    fetchServerConfig,
    store: provider.get(ServerListStore),
    servers: provider.get(ServersService),
  };
}

describe("configured desktop server identity", () => {
  test("native publication waits for the Main-owned registry mutation", async () => {
    vi.stubGlobal("BUILD_CONFIG", { ...BUILD_CONFIG, isElectron: true });
    const { state, store } = setup();
    const ack = Promise.withResolvers<void>();
    const server = { id: "native", baseUrl: "http://127.0.0.1:3101" };
    const config = {
      serverName: "Native",
      type: ServerDeploymentType.Standalone,
      features: [],
      oauthProviders: [],
      credentialsRequirement: { password: { minLength: 8, maxLength: 128 } },
    };
    native.mutate.mockImplementationOnce(async () => {
      await ack.promise;
      state.set(`serverConfig:${server.id}`, config);
      state.set("serverList", [server]);
      state.set("selectedServerId", server.id);
    });
    const pending = store.addServer(server, config);
    try {
      await vi.waitFor(() =>
        expect(native.mutate).toHaveBeenCalledWith({
          type: "add",
          server,
          config,
        }),
      );
      expect(store.getServerList()).toEqual([]);
      ack.resolve();
      await pending;
      expect(store.getServerList()).toEqual([server]);
    } finally {
      ack.resolve();
      await pending;
    }
  });
  test("empty startup and failed handshake do not persist a server", async () => {
    const { store, servers, fetchServerConfig } = setup();
    const selected: (string | undefined)[] = [];
    const sub = store
      .watchSelectedServerId()
      .subscribe((id) => selected.push(id));
    expect(store.getServerList()).toEqual([]);
    expect(selected.at(-1)).toBeUndefined();
    fetchServerConfig.mockRejectedValueOnce(new Error("Handshake failed"));
    await expect(
      servers.addServerByBaseUrl("https://first.example"),
    ).rejects.toThrow("Handshake failed");
    expect(store.getServerList()).toEqual([]);
    sub.unsubscribe();
  });

  test("normalizes, persists both deployment types, restores selection and rejects removed owners", async () => {
    const { store, servers, state, fetchServerConfig } = setup();
    await servers.addServerByBaseUrl("https://FIRST.example:443/");
    const first = store.getServerList()[0];
    expect(fetchServerConfig).toHaveBeenCalledWith("https://first.example");
    expect(store.getServerConfig(first.id)?.type).toBe(
      ServerDeploymentType.Cloud,
    );
    fetchServerConfig.mockResolvedValueOnce({
      ...(await fetchServerConfig()),
      deploymentType: ServerDeploymentType.Standalone,
    });
    await servers.addServerByBaseUrl("http://localhost:3001/");
    const second = store.getServerList()[1];
    expect(store.getServerConfig(second.id)?.type).toBe(
      ServerDeploymentType.Standalone,
    );
    store.selectServer(first.id);
    const restarted = setup(state);
    const selected: (string | undefined)[] = [];
    const sub = restarted.store
      .watchSelectedServerId()
      .subscribe((id) => selected.push(id));
    expect(selected.at(-1)).toBe(first.id);
    restarted.store.selectServer(second.id);
    expect(selected.at(-1)).toBe(second.id);
    await restarted.store.removeServer(second.id);
    expect(selected.at(-1)).toBe(first.id);
    expect(() => restarted.store.selectServer(second.id)).toThrow(
      "unregistered",
    );
    await restarted.store.removeServer(first.id);
    expect(selected.at(-1)).toBeUndefined();
    sub.unsubscribe();
  });

  test("invalid origins and records without a successful handshake never become authorities", async () => {
    const { state, store, servers, fetchServerConfig } = setup();
    for (const url of [
      "file:///tmp",
      "https://user:secret@host.example",
      "https://host.example/?token=secret",
    ]) {
      await expect(servers.addServerByBaseUrl(url)).rejects.toThrow(
        "Invalid server origin",
      );
    }
    expect(fetchServerConfig).not.toHaveBeenCalled();
    state.set("serverList", [
      { id: "unvalidated", baseUrl: "https://host.example" },
    ]);
    expect(store.getServerList()).toEqual([]);
    expect(state.get("serverList")).toHaveLength(1);
  });
});
