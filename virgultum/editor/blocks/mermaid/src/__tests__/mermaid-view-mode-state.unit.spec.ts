import { describe, expect, test } from "vitest";

import {
  resolveMermaidShellMode,
  resolveMermaidShellModeTransition,
} from "../mermaid-view-mode-state.js";

describe("Mermaid shell mode state", () => {
  test("resolves the persisted display state and internal editor state once", () => {
    expect(
      resolveMermaidShellMode({ displayMode: "display", viewMode: "source" }),
    ).toBe("view");
    expect(
      resolveMermaidShellMode({ displayMode: "edit", viewMode: "visual" }),
    ).toBe("visual");
    expect(
      resolveMermaidShellMode({ displayMode: "edit", viewMode: "source" }),
    ).toBe("source");
  });

  test("uses one transition for view, visual and source", () => {
    expect(
      resolveMermaidShellModeTransition({
        currentDisplayMode: "edit",
        currentViewMode: "visual",
        isConnected: true,
        isReadonly: false,
        nextMode: "view",
      }),
    ).toEqual({
      activateKeyboardTarget: false,
      clearPendingVisualInsert: true,
      clearVisualSelection: false,
      displayMode: "display",
      mode: "view",
      scheduleProjectionOwnerSourceSync: true,
      viewMode: "visual",
      writeDisplayMode: true,
    });
    expect(
      resolveMermaidShellModeTransition({
        currentDisplayMode: "display",
        currentViewMode: "visual",
        isConnected: true,
        isReadonly: false,
        nextMode: "source",
      }),
    ).toEqual({
      activateKeyboardTarget: false,
      clearPendingVisualInsert: true,
      clearVisualSelection: false,
      displayMode: "edit",
      mode: "source",
      scheduleProjectionOwnerSourceSync: false,
      viewMode: "source",
      writeDisplayMode: true,
    });
    expect(
      resolveMermaidShellModeTransition({
        currentDisplayMode: "edit",
        currentViewMode: "source",
        isConnected: true,
        isReadonly: false,
        nextMode: "visual",
      }),
    ).toMatchObject({
      activateKeyboardTarget: true,
      mode: "visual",
      scheduleProjectionOwnerSourceSync: false,
      viewMode: "visual",
    });
  });

  test("does not mutate persisted mode in readonly", () => {
    expect(
      resolveMermaidShellModeTransition({
        currentDisplayMode: "display",
        currentViewMode: "visual",
        isConnected: true,
        isReadonly: true,
        nextMode: "source",
      }),
    ).toBeNull();
  });
});
