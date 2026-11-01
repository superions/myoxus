// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { useEffect, useId, useRef, useState } from "react";
import {
  SubNodeIcon,
  SiblingNodeIcon,
  CollapseIcon,
  ExpandIcon,
} from "@myoxus/icons";
import { Box, IconButton } from "@myoxus/ui-facade";
import {
  mindmapHandleHover,
  mermaidMessages as m,
  type MindmapReactHostProps,
} from "@virgultum/block-mermaid";

/** Passive hover/focus follows the actual consuming viewport's bounds. Native
 * Mantine buttons own the hit surface; their small glyphs remain separate. */
export function MindmapNodeHandles({
  props,
}: {
  props: MindmapReactHostProps;
}) {
  const t = useI18n();
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const scope = useId();
  const enabled = !props.readonly && !props.displayOnly;
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    if (!enabled) return;
    const move = (event: PointerEvent) => {
      const button =
        event.target instanceof Element &&
        event.target.closest<HTMLElement>("[data-mindmap-handle-key]");
      if (button) {
        setHovered(
          button.dataset.mindmapHandleScope === scope
            ? (button.dataset.mindmapHandleKey ?? null)
            : null,
        );
        return;
      }
      setHovered((previous) =>
        mindmapHandleHover(
          current.current.nodeHandles ?? [],
          event.clientX,
          event.clientY,
          previous,
        ),
      );
    };
    const focus = (event: FocusEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      const handle = element?.closest<HTMLElement>("[data-mindmap-handle-key]");
      const proxy = element?.closest<HTMLElement>("[data-mermaid-edit-key]");
      const viewport = current.current
        .resolveReturnFocusTarget()
        ?.closest(".myoxus-mermaid-gfx-viewport");
      // A copied diagram can retain occurrence keys. DOM focus belongs to
      // this consuming viewport/handle, never another owner's equal key.
      setFocused(
        handle?.dataset.mindmapHandleScope === scope
          ? (handle.dataset.mindmapHandleKey ?? null)
          : proxy && viewport && viewport.contains(proxy)
            ? (proxy.dataset.mermaidEditKey ?? null)
            : null,
      );
    };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("focusin", focus);
    };
  }, [scope, enabled]);
  if (props.readonly || props.displayOnly || props.draftActive || props.intent)
    return null;
  const key = focused ?? hovered ?? props.selectedKey;
  const plan = props.nodeHandles?.find((node) => node.key === key);
  return (
    plan?.actions.map((action) => (
      <Box
        key={`${plan.key}:${action.id}`}
        pos={props.markersInClientSpace ? "fixed" : "absolute"}
        style={{
          left: action.point.left,
          top: action.point.top,
          transform: "translate(-50%, -50%)",
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <IconButton
          data-mindmap-handle-key={plan.key}
          data-mindmap-handle-scope={scope}
          aria-label={
            action.kind === "toggle-collapse"
              ? props.projection.collapsed?.has(plan.key)
                ? t.Expand()
                : t.Collapse()
              : action.kind === "add-child"
                ? m.addChild()
                : m.addSibling()
          }
          onClick={() =>
            props.onIntent({
              type: action.kind,
              key: plan.key,
              side: action.side,
            })
          }
        >
          {action.kind === "toggle-collapse" ? (
            props.projection.collapsed?.has(plan.key) ? (
              <ExpandIcon />
            ) : (
              <CollapseIcon />
            )
          ) : action.kind === "add-child" ? (
            <SubNodeIcon />
          ) : (
            <SiblingNodeIcon />
          )}
        </IconButton>
      </Box>
    )) ?? null
  );
}
