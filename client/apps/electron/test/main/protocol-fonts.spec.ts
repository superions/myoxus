import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/mock-userData"),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
      },
      cookies: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    },
  },
}));

vi.mock("../../src/main/logger", () => ({
  logger: { error: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  process.env.BUILD_TYPE = "stable";
  process.env.NODE_ENV = "production";
  delete process.env.DEV_SERVER_URL;
});

afterEach(() => {
  vi.doUnmock("../../src/shared/utils");
  vi.doUnmock("../../src/main/server-routing");
  vi.resetModules();
  delete process.env.BUILD_TYPE;
  delete process.env.NODE_ENV;
  delete process.env.DEV_SERVER_URL;
});

describe("Electron bundled font protocol", () => {
  it("keeps /api/fonts files on the local assets protocol", async () => {
    const { resolveBundledFontPath } = await import("../../src/main/protocol");
    expect(
      resolveBundledFontPath(
        "assets://./api/fonts/inter-vf.ttf?v=123",
        "/app/resources/web-static/api/fonts",
      ),
    ).toBe(path.join("/app/resources/web-static/api/fonts", "inter-vf.ttf"));
  });

  it("does not steal non-font API routes from the backend proxy", async () => {
    const { resolveBundledFontPath } = await import("../../src/main/protocol");
    expect(
      resolveBundledFontPath(
        "assets://./api/branding/theme.css",
        "/app/resources/web-static/api/fonts",
      ),
    ).toBeNull();
  });

  it("rejects path traversal attempts", async () => {
    const { resolveBundledFontPath } = await import("../../src/main/protocol");
    expect(
      resolveBundledFontPath(
        "assets://./api/fonts/..%2Fsecret.ttf",
        "/app/resources/web-static/api/fonts",
      ),
    ).toBeNull();
  });

  it("serves registered version-matched font requests locally without replacing server-specific bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-scoped-font-"));
    const directory = path.join(root, "web-static", "api", "fonts");
    fs.mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from("canonical packaged font");
    const file = path.join(directory, "inter-latin.woff2");
    fs.writeFileSync(file, bytes);
    const version = createHash("sha256")
      .update(bytes)
      .digest("hex")
      .slice(0, 8);
    const proxy = vi.fn(async () => new Response("server font"));
    vi.doMock("../../src/shared/utils", () => ({
      resourcesPath: root,
      isWindows: () => false,
    }));
    vi.doMock("../../src/main/server-routing", () => ({
      proxyDesktopServerRequest: proxy,
      resolveDesktopServerRequest: (url: string) => {
        const parsed = new URL(url);
        if (!parsed.pathname.startsWith("/_server/registered/"))
          throw new Error("Server proxy requires a registered server");
        return {
          target: new URL(
            parsed.pathname.slice("/_server/registered".length) + parsed.search,
            "https://server.example",
          ),
        };
      },
    }));
    try {
      const { net } = await import("electron");
      vi.mocked(net.fetch).mockClear().mockResolvedValue(new Response(bytes));
      const { handleFileRequest } = await import("../../src/main/protocol");
      const base = "assets://./_server/registered/api/fonts/";
      const response = await handleFileRequest(
        new Request(base + `inter-latin.woff2?v=${version}`),
      );
      expect(await response.text()).toBe(bytes.toString());
      expect(net.fetch).toHaveBeenCalledOnce();
      expect(net.fetch).toHaveBeenCalledWith(
        new URL(`file://${file}`).href,
        expect.anything(),
      );
      expect(proxy).not.toHaveBeenCalled();
      await handleFileRequest(
        new Request(base + "inter-latin.woff2?v=00000000"),
      );
      await handleFileRequest(new Request(base + "custom.woff2"));
      expect(proxy).toHaveBeenCalledTimes(2);
      expect(net.fetch).toHaveBeenCalledOnce();
      await expect(
        handleFileRequest(
          new Request("assets://./_server/unknown/api/fonts/inter-latin.woff2"),
        ),
      ).rejects.toThrow("registered server");
      expect(net.fetch).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("canonical file boundaries", () => {
  it("allows real children, rejects siblings and symlink escapes", async () => {
    const { isFileWithinRoot } = await import("../../src/main/protocol");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-boundary-"));
    try {
      const allowed = path.join(root, "allowed");
      const sibling = path.join(root, "allowed-sibling");
      fs.mkdirSync(allowed);
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(allowed, "valid.pdf"), "valid");
      fs.writeFileSync(path.join(sibling, "secret.pdf"), "secret");
      fs.symlinkSync(
        path.join(sibling, "secret.pdf"),
        path.join(allowed, "escape.pdf"),
      );
      expect(isFileWithinRoot(allowed, path.join(allowed, "valid.pdf"))).toBe(
        true,
      );
      expect(isFileWithinRoot(allowed, path.join(sibling, "secret.pdf"))).toBe(
        false,
      );
      expect(isFileWithinRoot(allowed, path.join(allowed, "escape.pdf"))).toBe(
        false,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    "assets://local-file/tmp/mock-userData/%2e%2e%2fsecret.pdf",
    "assets://local-file/tmp/%ZZ.pdf",
    "assets://./%2e%2e%2fsecret.js",
  ])("denies invalid request %s without fetching", async (url) => {
    const { net } = await import("electron");
    vi.mocked(net.fetch).mockClear();
    const { handleFileRequest } = await import("../../src/main/protocol");
    const response = await handleFileRequest(new Request(url));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(net.fetch).not.toHaveBeenCalled();
  });
});
