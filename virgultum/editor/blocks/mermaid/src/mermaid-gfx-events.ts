export type MermaidGfxViewportEventGateInput = {
  isButtonTarget: boolean;
  isEditableTarget: boolean;
  isNativeControl: boolean;
  isReadonly: boolean;
};

export function isMermaidGfxNativeControlTarget(target: unknown) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "edgeless-connector-handle" ||
    target.classList.contains("line-controller") ||
    target.classList.contains("handle") ||
    target.classList.contains("resize")
  );
}

export function isMermaidGfxNativeControlEventPath(path: readonly unknown[]) {
  return path.some((target) => isMermaidGfxNativeControlTarget(target));
}

export function isMermaidGfxInterfaceControlEventPath(
  path: readonly unknown[],
) {
  return path.some((target) => {
    if (!(target instanceof HTMLElement)) return false;
    // The existing Lit toolbar menu is portalled too. Its action rows are
    // divs, so tag/ARIA checks for Mantine inputs alone miss their clicks.
    if (target.tagName.toLowerCase() === "myoxus-menu") return true;
    if (
      ["button", "input", "option", "select", "textarea"].includes(
        target.tagName.toLowerCase(),
      )
    ) {
      return true;
    }
    const role = target.getAttribute("role");
    return (
      role === "button" ||
      role === "combobox" ||
      role === "listbox" ||
      role === "menu" ||
      role === "menuitem" ||
      role === "option" ||
      target.hasAttribute("data-myoxus-ui-role")
    );
  });
}

export function isMermaidGfxButtonTarget(target: unknown) {
  // Icon paths are SVG Elements; they still belong to the surrounding control.
  return Boolean(target instanceof Element && target.closest("button"));
}

export function shouldIgnoreMermaidGfxViewportClick({
  isButtonTarget,
  isEditableTarget,
  isNativeControl,
}: Pick<
  MermaidGfxViewportEventGateInput,
  "isButtonTarget" | "isEditableTarget" | "isNativeControl"
>) {
  return isNativeControl || isEditableTarget || isButtonTarget;
}

export function shouldIgnoreMermaidGfxViewportContextMenu({
  isButtonTarget,
  isEditableTarget,
  isReadonly,
}: Pick<
  MermaidGfxViewportEventGateInput,
  "isButtonTarget" | "isEditableTarget" | "isReadonly"
>) {
  return isReadonly || isEditableTarget || isButtonTarget;
}

export function shouldIgnoreMermaidGfxViewportPointerDown({
  isButtonTarget,
  isConnecting,
  isEditableTarget,
  isNativeControl,
  isReadonly,
}: MermaidGfxViewportEventGateInput & {
  isConnecting: boolean;
}) {
  return (
    isReadonly ||
    isConnecting ||
    isNativeControl ||
    isEditableTarget ||
    isButtonTarget
  );
}

export function shouldIgnoreMermaidGfxViewportDoubleClick({
  isButtonTarget,
  isEditableTarget,
  isNativeControl,
  isReadonly,
}: MermaidGfxViewportEventGateInput) {
  return isReadonly || isNativeControl || isEditableTarget || isButtonTarget;
}

export type MermaidGfxViewportSelectionIntent =
  | { kind: "clear" }
  | { kind: "edge"; edgeId: string }
  | { kind: "node"; nodeId: string }
  | { kind: "subgraph"; subgraphId: string };

export function resolveMermaidGfxViewportSelectionIntent({
  edgeId,
  headerSubgraphId,
  nodeId,
  subgraphId,
}: {
  edgeId?: string;
  headerSubgraphId?: string;
  nodeId?: string;
  subgraphId?: string;
}): MermaidGfxViewportSelectionIntent {
  // Semantic container headers stay above broad connector hit corridors.
  // Connector labels remain above ordinary node bodies where those hit zones
  // overlap, preserving direct edge-label editing.
  if (headerSubgraphId) {
    return { kind: "subgraph", subgraphId: headerSubgraphId };
  }
  if (edgeId) return { edgeId, kind: "edge" };
  if (nodeId) return { kind: "node", nodeId };
  if (subgraphId) return { kind: "subgraph", subgraphId };
  return { kind: "clear" };
}
