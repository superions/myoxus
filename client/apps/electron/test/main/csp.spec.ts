/**
 * P-DEPS-ELEC-A-02-T — Renderer CSP guard
 *
 * Verifies that buildRendererCsp() in protocol.ts:
 *  - INV-CSP-01: produces a strict production CSP with required directives
 *  - INV-CSP-02: never includes 'unsafe-eval' (only 'wasm-unsafe-eval' is permitted)
 *  - INV-CSP-03: sets object-src 'none' and frame-src 'none'
 *  - INV-CSP-04: in dev mode, adds devServerBase to script-src and connect-src
 *  - INV-CSP-05: dev-mode does NOT introduce 'unsafe-eval'
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    enableSandbox: vi.fn(),
    getVersion: vi.fn().mockReturnValue("1.2.3"),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})),
    getPath: vi.fn().mockReturnValue("/tmp/mock-userData"),
    setPath: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
    isReady: vi.fn().mockReturnValue(false),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("Renderer CSP — P-DEPS-ELEC-A-02-T", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.BUILD_TYPE;
    delete process.env.NODE_ENV;
    delete process.env.DEV_SERVER_URL;
  });

  async function getCsp(opts: {
    isDev?: boolean;
    devServerUrl?: string;
  }): Promise<string> {
    process.env.BUILD_TYPE = "stable";
    process.env.NODE_ENV = opts.isDev ? "development" : "production";
    if (opts.devServerUrl) {
      process.env.DEV_SERVER_URL = opts.devServerUrl;
    } else {
      delete process.env.DEV_SERVER_URL;
    }

    const { buildRendererCsp } =
      (await import("../../src/main/protocol")) as any;
    return buildRendererCsp();
  }

  it("INV-CSP-01: production CSP contains all required directives", async () => {
    const csp = await getCsp({});
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self' https: http: wss: ws:");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("INV-CSP-02: production CSP never contains unsafe-eval", async () => {
    const csp = await getCsp({});
    const directives = csp.split(";").map((d) => d.trim());
    for (const directive of directives) {
      if (directive.includes("unsafe-eval")) {
        expect(directive).toContain("wasm-unsafe-eval");
        expect(directive).not.toMatch(/'unsafe-eval'(?!.*wasm)/);
      }
    }
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("INV-CSP-03: object-src and frame-src are 'none'", async () => {
    const csp = await getCsp({});
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
  });

  it("INV-CSP-04: dev mode adds devServerBase to script-src and connect-src", async () => {
    const csp = await getCsp({
      isDev: true,
      devServerUrl: "http://localhost:8080",
    });
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    const connectSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("connect-src"));

    expect(scriptSrc).toContain("http://localhost:8080");
    expect(connectSrc).toContain("http://localhost:8080");
    expect(connectSrc).toContain("ws://localhost:8080");
  });

  it("INV-CSP-05: dev mode does not introduce 'unsafe-eval'", async () => {
    const csp = await getCsp({
      isDev: true,
      devServerUrl: "http://localhost:8080",
    });
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("'wasm-unsafe-eval'");
  });
});
