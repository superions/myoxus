import { beforeEach, describe, expect, test, vi } from "vitest";

const mkdir = vi.hoisted(() => vi.fn());

const nativePool = vi.hoisted(() => {
  const methods = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const get = (key: PropertyKey) => {
    let method = methods.get(key);
    if (!method) {
      method = vi.fn();
      methods.set(key, method);
    }
    return method;
  };
  return { get, methods };
});

function createDocStoragePoolMock() {
  return new Proxy(
    {},
    {
      get: (_target, key) => nativePool.get(key),
    },
  );
}

vi.mock("@myoxus/local-store", () => ({
  DocStoragePool: vi.fn(createDocStoragePoolMock),
}));
vi.mock("@myoxus/storage", () => ({
  parseUniversalId: () => ({ peer: "cloud", type: "workspace", id: "space" }),
}));
vi.mock("node:fs/promises", () => ({ mkdir }));
vi.mock("../../src/helper/workspace/meta", () => ({
  getSpaceDBPath: vi.fn().mockResolvedValue("/tmp/myoxus/space.db"),
}));

describe("native workspace storage handlers", () => {
  beforeEach(() => {
    mkdir.mockReset().mockResolvedValue(undefined);
    for (const method of nativePool.methods.values()) {
      method.mockReset().mockResolvedValue(undefined);
    }
  });

  test("coalesces concurrent renderer connections for the same workspace", async () => {
    let finishConnect: (() => void) | undefined;
    nativePool
      .get("connect")
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishConnect = resolve)),
      );
    const { storeHandlers } = await import("../../src/helper/storage/handlers");

    const first = storeHandlers.connect("cloud:workspace:space");
    const second = storeHandlers.connect("cloud:workspace:space");
    await vi.waitFor(() =>
      expect(nativePool.get("connect")).toHaveBeenCalledOnce(),
    );
    finishConnect?.();
    await Promise.all([first, second]);

    expect(mkdir).toHaveBeenCalledWith("/tmp/myoxus", { recursive: true });
    expect(nativePool.get("connect")).toHaveBeenCalledOnce();
    expect(nativePool.get("setSpaceId")).toHaveBeenCalledOnce();
  });

  test("validates native index lifecycle states at the helper boundary", async () => {
    const { storeHandlers } = await import("../../src/helper/storage/handlers");
    nativePool.get("ftsIndexState").mockResolvedValueOnce("rebuilding");
    await expect(
      storeHandlers.ftsIndexState("local:workspace:space"),
    ).resolves.toBe("rebuilding");

    nativePool.get("ftsIndexState").mockResolvedValueOnce("partial");
    await expect(
      storeHandlers.ftsIndexState("local:workspace:space"),
    ).rejects.toThrow("Native search index returned an invalid state: partial");
  });
});
