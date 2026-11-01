// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/main/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import {
  DesktopStatePersistenceError,
  DesktopStateLoadError,
  PersistentJSONFileStorage,
} from "../../src/main/shared-storage/json-file";
import { readOnboardingState } from "../../src/main/windows-manager/onboarding-state";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PersistentJSONFileStorage", () => {
  test.each(["{broken", "[]"])(
    "preserves invalid deployed input %s",
    (input) => {
      const filepath = path.join(temporaryDirectory(), "global-state.json");
      fs.writeFileSync(filepath, input, { mode: 0o600 });
      expect(() => new PersistentJSONFileStorage(filepath)).toThrow(
        DesktopStateLoadError,
      );
      expect(fs.readFileSync(filepath, "utf8")).toBe(input);
      expect(fs.statSync(filepath).mode & 0o777).toBe(0o600);
    },
  );

  test("rejects unreadable state without treating it as fresh", () => {
    const filepath = path.join(temporaryDirectory(), "global-state.json");
    fs.writeFileSync(filepath, '{"kept":true}');
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(() => new PersistentJSONFileStorage(filepath)).toThrow(
      DesktopStateLoadError,
    );
    read.mockRestore();
    expect(fs.readFileSync(filepath, "utf8")).toBe('{"kept":true}');
  });

  test("atomically flushes the latest complete state and reloads it", async () => {
    const directory = temporaryDirectory();
    const filepath = path.join(directory, "global-state.json");
    const storage = new PersistentJSONFileStorage(filepath);

    storage.set("onboardingState", { completed: false });
    await storage.flush();
    storage.set("onboardingState", { completed: true });
    storage.set("nested", { values: [1, "two", false, null] });
    await storage.flush();

    expect(JSON.parse(fs.readFileSync(filepath, "utf8"))).toEqual({
      onboardingState: { completed: true },
      nested: { values: [1, "two", false, null] },
    });
    expect(fs.readdirSync(directory)).toEqual(["global-state.json"]);

    const reloaded = new PersistentJSONFileStorage(filepath);
    expect(reloaded.get("onboardingState")).toEqual({ completed: true });
  });

  test("rejects lossy values before mutating the durable state", async () => {
    const filepath = path.join(temporaryDirectory(), "global-state.json");
    const storage = new PersistentJSONFileStorage(filepath);

    expect(() => storage.set("unsupported", new Date())).toThrow(
      "desktop state values must be JSON-persistable",
    );
    expect(storage.keys()).toEqual([]);
    await storage.flush();
    expect(fs.existsSync(filepath)).toBe(false);
  });

  test("canonicalizes optional object fields without accepting undefined array entries", async () => {
    const filepath = path.join(temporaryDirectory(), "global-state.json");
    const storage = new PersistentJSONFileStorage(filepath);
    storage.set("tab", { id: "tab-1", pinned: undefined });
    expect(storage.get("tab")).toEqual({ id: "tab-1" });
    expect(() => storage.set("invalid", ["one", undefined])).toThrow(
      "desktop state arrays cannot contain undefined",
    );
    await storage.flush();
    expect(JSON.parse(fs.readFileSync(filepath, "utf8"))).toEqual({
      tab: { id: "tab-1" },
    });
  });

  test("propagates an atomic write failure and leaves no partial target", async () => {
    const directory = temporaryDirectory();
    const blockingFile = path.join(directory, "not-a-directory");
    const filepath = path.join(blockingFile, "global-state.json");
    const storage = new PersistentJSONFileStorage(filepath);

    fs.writeFileSync(blockingFile, "block");
    storage.set("onboardingState", { completed: true });
    await expect(storage.flush()).rejects.toBeInstanceOf(
      DesktopStatePersistenceError,
      DesktopStateLoadError,
    );
    expect(fs.existsSync(filepath)).toBe(false);
  });

  test("ignores contradictory legacy profile files", async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify({ onBoarding: false }),
    );
    fs.writeFileSync(
      path.join(directory, "window-state.json"),
      JSON.stringify({ isMaximized: true }),
    );

    const filepath = path.join(directory, "global-state.json");
    const fresh = new PersistentJSONFileStorage(filepath);
    expect(readOnboardingState(fresh)).toEqual({ completed: false });
    expect(fresh.keys()).toEqual([]);

    fresh.set("onboardingState", { completed: true });
    await fresh.flush();
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify({ onBoarding: true }),
    );
    const reloaded = new PersistentJSONFileStorage(filepath);
    expect(readOnboardingState(reloaded)).toEqual({ completed: true });
  });
});
