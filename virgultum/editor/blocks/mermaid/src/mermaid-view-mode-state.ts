import type {
  MermaidDisplayMode,
  MermaidViewMode,
} from "./mermaid-block-constants.js";
import type { MermaidShellMode } from "./families/runtime/shell-contract.js";

export function resolveMermaidShellMode({
  displayMode,
  viewMode,
}: {
  displayMode: MermaidDisplayMode;
  viewMode: MermaidViewMode;
}): MermaidShellMode {
  return displayMode === "display" ? "view" : viewMode;
}

export type MermaidShellModeTransition = {
  activateKeyboardTarget: boolean;
  clearPendingVisualInsert: boolean;
  clearVisualSelection: boolean;
  displayMode: MermaidDisplayMode;
  mode: MermaidShellMode;
  scheduleProjectionOwnerSourceSync: boolean;
  viewMode: MermaidViewMode;
  writeDisplayMode: boolean;
};

export function resolveMermaidShellModeTransition({
  currentDisplayMode,
  currentViewMode,
  isConnected,
  isReadonly,
  nextMode,
}: {
  currentDisplayMode: MermaidDisplayMode;
  currentViewMode: MermaidViewMode;
  isConnected: boolean;
  isReadonly: boolean;
  nextMode: MermaidShellMode;
}): MermaidShellModeTransition | null {
  if (isReadonly) return null;

  const currentMode = resolveMermaidShellMode({
    displayMode: currentDisplayMode,
    viewMode: currentViewMode,
  });
  const displayMode = nextMode === "view" ? "display" : "edit";
  const viewMode = nextMode === "view" ? currentViewMode : nextMode;
  const mode = resolveMermaidShellMode({ displayMode, viewMode });

  return {
    activateKeyboardTarget: isConnected && mode === "visual",
    clearPendingVisualInsert: mode !== "visual",
    // View hides mutation chrome, but the non-persisted semantic selection is
    // retained so returning to Visual does not discard a completed selection.
    clearVisualSelection: false,
    displayMode,
    mode,
    scheduleProjectionOwnerSourceSync:
      isConnected && currentMode === "visual" && mode !== "visual",
    viewMode,
    writeDisplayMode: currentDisplayMode !== displayMode,
  };
}
