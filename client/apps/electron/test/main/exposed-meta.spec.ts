import {
  mainEventChannelManifest,
  mainHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";
import { describe, expect, test } from "vitest";

import {
  createExposedMeta,
  parseExposedMeta,
} from "../../src/shared/exposed-meta";

describe("desktop IPC exposed metadata", () => {
  test("accepts metadata generated from the exact runtime manifest", () => {
    const metadata = createExposedMeta(
      mainHandlerChannelManifest,
      mainEventChannelManifest,
    );

    expect(
      parseExposedMeta(
        metadata,
        mainHandlerChannelManifest,
        mainEventChannelManifest,
        "main exposed metadata",
      ),
    ).toEqual(metadata);
  });

  test("rejects missing, additional, and malformed runtime channels", () => {
    const missing = createExposedMeta(
      {
        ...mainHandlerChannelManifest,
        ui: {
          ...mainHandlerChannelManifest.ui,
        },
      },
      mainEventChannelManifest,
    );
    const ui = missing.handlers.find(([namespace]) => namespace === "ui");
    expect(ui).toBeDefined();
    const withoutMoveTab = {
      ...missing,
      handlers: missing.handlers.map(([namespace, channels]) =>
        namespace === "ui"
          ? [namespace, channels.filter((channel) => channel !== "moveTab")]
          : [namespace, channels],
      ),
    };

    expect(() =>
      parseExposedMeta(
        withoutMoveTab,
        mainHandlerChannelManifest,
        mainEventChannelManifest,
        "main exposed metadata",
      ),
    ).toThrow(/does not match/);

    expect(() =>
      parseExposedMeta(
        {
          ...missing,
          events: [...missing.events, ["invented", ["event"]]],
        },
        mainHandlerChannelManifest,
        mainEventChannelManifest,
        "main exposed metadata",
      ),
    ).toThrow(/does not match/);

    expect(() =>
      parseExposedMeta(
        { handlers: "invalid", events: [] },
        mainHandlerChannelManifest,
        mainEventChannelManifest,
        "main exposed metadata",
      ),
    ).toThrow(/invalid shape/);
  });
});
