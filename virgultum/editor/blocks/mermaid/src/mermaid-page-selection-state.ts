// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidPageSelectionTool = "box" | "pointer";

export type MermaidPageSelectionState = {
  readonly gestureRevision: number;
  readonly gestureActive: boolean;
  readonly tool: MermaidPageSelectionTool;
};

export type MermaidPageSelectionTransition =
  | { readonly type: "begin-gesture" }
  | { readonly type: "end-gesture" }
  | { readonly tool: MermaidPageSelectionTool; readonly type: "tool" };

export function createMermaidPageSelectionState(): MermaidPageSelectionState {
  return {
    gestureActive: false,
    gestureRevision: 0,
    tool: "pointer",
  };
}

export function transitionMermaidPageSelectionState(
  state: MermaidPageSelectionState,
  transition: MermaidPageSelectionTransition,
): MermaidPageSelectionState {
  if (transition.type === "tool") {
    if (state.tool === transition.tool && !state.gestureActive) {
      return state;
    }
    return {
      ...state,
      gestureActive: false,
      gestureRevision: state.gestureRevision + Number(state.gestureActive),
      tool: transition.tool,
    };
  }
  if (transition.type === "begin-gesture") {
    if (state.gestureActive) return state;
    return {
      ...state,
      gestureActive: true,
      gestureRevision: state.gestureRevision + 1,
    };
  }
  if (!state.gestureActive) return state;
  return {
    ...state,
    gestureActive: false,
    gestureRevision: state.gestureRevision + 1,
  };
}
