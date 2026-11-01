import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";

const fixture = vi.hoisted(() => {
  // The Electron owner shares a module cache. Authority must read this fixture's
  // storage, never a previously loaded launcher's mock registry.
  vi.resetModules();
  return {
    records: new Map<string, unknown>(),
    partitions: new Map<string, any>(),
  };
});
vi.mock("../../src/main/shared-storage/storage", () => ({
  globalStateStorage: { get: (key: string) => fixture.records.get(key) },
}));
vi.mock("electron", () => ({
  session: {
    fromPartition: (key: string) => {
      if (!fixture.partitions.has(key))
        fixture.partitions.set(key, {
          fetch: vi.fn(async () => new Response("ok")),
          cookies: {
            set: vi.fn(),
            remove: vi.fn(),
            get: vi.fn(async () => []),
          },
        });
      return fixture.partitions.get(key);
    },
  },
}));

import {
  desktopServerSession,
  desktopSocketServer,
  proxyDesktopServerRequest,
  registeredDesktopServer,
  resolveDesktopServerRequest,
} from "../../src/main/server-routing";
import { validateRedirectProxyUrl } from "../../src/main/security/redirect-proxy";

const servers = [
  { id: "alpha", baseUrl: "http://127.0.0.1:3101" },
  { id: "beta", baseUrl: "http://127.0.0.1:3102" },
];
beforeEach(() => {
  fixture.records.clear();
  fixture.partitions.clear();
  fixture.records.set("serverList", servers);
  servers.forEach((server, index) =>
    fixture.records.set(`serverConfig:${server.id}`, {
      type: index ? "Cloud" : "Standalone",
      serverName: server.id,
      features: [],
      oauthProviders: [],
      credentialsRequirement: { password: { minLength: 8, maxLength: 64 } },
    }),
  );
});

describe("registered desktop transport and redirect authority", () => {
  it("normalizes server-provided dot segments before adding the owner ID", () => {
    const route = desktopServerRequestUrl(
      "alpha",
      "/api/../../../_server/beta/graphql",
    );
    expect(resolveDesktopServerRequest(route).server.id).toBe("alpha");
    expect(resolveDesktopServerRequest(route).target.origin).toBe(
      servers[0].baseUrl,
    );
  });
  it("preserves owner, path, query, method and body while separating same-host cookie partitions", async () => {
    const alpha = desktopServerSession(servers[0]);
    const beta = desktopServerSession(servers[1]);
    expect(alpha).not.toBe(beta);
    alpha.cookies.get.mockResolvedValue([
      { name: "myoxus_csrf_token", value: "alpha-csrf" },
    ]);
    beta.cookies.get.mockResolvedValue([
      { name: "myoxus_csrf_token", value: "beta-csrf" },
    ]);
    alpha.fetch.mockImplementationOnce(
      async (url: string, init: RequestInit) => {
        expect(url).toBe(`${servers[0].baseUrl}/graphql?operation=change`);
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("cookie")).toBeNull();
        expect(new Headers(init.headers).get("x-myoxus-csrf-token")).toBe(
          "alpha-csrf",
        );
        expect(await new Response(init.body).text()).toBe('{"id":"owned"}');
        return new Response("alpha", {
          headers: {
            "set-cookie": "session=alpha; Path=/; Max-Age=3600; HttpOnly",
          },
        });
      },
    );
    const response = await proxyDesktopServerRequest(
      new Request(
        desktopServerRequestUrl("alpha", "/graphql?operation=change"),
        {
          method: "POST",
          headers: {
            cookie: "session=foreign",
            "x-myoxus-csrf-token": "foreign-csrf",
          },
          body: '{"id":"owned"}',
        },
      ),
    );
    expect(await response.text()).toBe("alpha");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(alpha.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${servers[0].baseUrl}/graphql?operation=change`,
        value: "alpha",
      }),
    );
    await proxyDesktopServerRequest(
      new Request(desktopServerRequestUrl("beta", "/api/me")),
    );
    expect(beta.fetch).toHaveBeenCalledOnce();
    expect(
      new Headers(beta.fetch.mock.calls[0][1].headers).has(
        "x-myoxus-csrf-token",
      ),
    ).toBe(false);
    expect(beta.cookies.set).not.toHaveBeenCalled();
    expect(
      desktopSocketServer(
        `${servers[1].baseUrl}/socket.io/?myoxusServerId=beta`,
      ),
    ).toEqual(servers[1]);
    expect(() =>
      desktopSocketServer(
        `${servers[1].baseUrl}/socket.io/?myoxusServerId=alpha`,
      ),
    ).toThrow();
    expect(
      desktopSocketServer(`${servers[1].baseUrl}/socket.io/`),
    ).toBeUndefined();
  });

  it("rejects raw URLs, removed/unvalidated IDs, cross-origin paths and remote HTTP without sending", async () => {
    fixture.records.set("serverConfig:beta", { type: "Cloud" });
    for (const url of [
      "assets://./api/me",
      "assets://./graphql",
      "assets://./_server/missing/graphql",
      "assets://./_server/beta/graphql",
      "assets://./_server/alpha//other.example/graphql",
    ]) {
      expect((await proxyDesktopServerRequest(new Request(url))).status).toBe(
        403,
      );
    }
    expect(fixture.partitions.size).toBe(0);
    fixture.records.set("serverList", [
      { id: "alpha", baseUrl: "http://remote.example" },
    ]);
    expect(registeredDesktopServer("alpha")).toBeUndefined();
    expect(() =>
      resolveDesktopServerRequest("assets://./_server/alpha/graphql"),
    ).toThrow();
    fixture.records.set("serverList", []);
    expect(
      (
        await proxyDesktopServerRequest(
          new Request("assets://./_server/alpha/graphql"),
        )
      ).status,
    ).toBe(403);
    expect(fixture.partitions.size).toBe(0);
  });

  it("follows same-owner redirects and rejects cross-owner or removed-owner redirects", async () => {
    const alpha = desktopServerSession(servers[0]);
    alpha.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 303,
        headers: { location: "/api/me?after=login" },
      }),
    );
    const result = await proxyDesktopServerRequest(
      new Request(desktopServerRequestUrl("alpha", "/api/login"), {
        method: "POST",
        body: "login",
      }),
    );
    expect(result.status).toBe(200);
    expect(alpha.fetch).toHaveBeenLastCalledWith(
      `${servers[0].baseUrl}/api/me?after=login`,
      expect.objectContaining({ method: "GET", body: undefined }),
    );
    alpha.fetch.mockClear();
    alpha.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 307,
        headers: { location: `${servers[1].baseUrl}/api/me` },
      }),
    );
    expect(
      (
        await proxyDesktopServerRequest(
          new Request(desktopServerRequestUrl("alpha", "/api/me")),
        )
      ).status,
    ).toBe(403);
    expect(alpha.fetch).toHaveBeenCalledOnce();
    alpha.fetch.mockImplementationOnce(async () => {
      fixture.records.set("serverList", [servers[1]]);
      return new Response(null, {
        status: 302,
        headers: { location: "/api/next" },
      });
    });
    await expect(
      proxyDesktopServerRequest(
        new Request(desktopServerRequestUrl("alpha", "/api/me")),
      ),
    ).rejects.toThrow("Server was removed");
  });

  it("opens redirect targets only for their registered owner, regardless of release channel", () => {
    for (const channel of ["stable", "beta", "internal"]) {
      vi.stubEnv("BUILD_TYPE", channel);
      const route = desktopServerRequestUrl(
        "alpha",
        `/redirect-proxy?redirect_uri=${encodeURIComponent(servers[0].baseUrl + "/auth")}`,
      );
      expect(validateRedirectProxyUrl(route)).toEqual({
        allow: true,
        redirectTarget: `${servers[0].baseUrl}/auth`,
      });
      expect(
        validateRedirectProxyUrl(
          route.replace("/_server/alpha/", "/_server/beta/"),
        ).allow,
      ).toBe(false);
      expect(
        validateRedirectProxyUrl(route.replace("/_server/alpha/", "/")).allow,
      ).toBe(false);
    }
    vi.unstubAllEnvs();
  });
});
