// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMindmapDraftBasis, handleMindmapSelectKeyDown } from "./drafts";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { MindmapLayoutType as LayoutType } from "@virgultum/block-mermaid";
import {
  Alert,
  Button,
  Group,
  MyoxusSelect,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  mindmapMoveAtAnchor,
  mindmapMoveChoices,
  mindmapMoveImpact,
  type MindmapReactHostProps,
} from "@virgultum/block-mermaid";

/** Explicit Source anchors share the pointer command; preview and Cancel stay local. */
export function MindmapMoveForm({
  props,
  nodeKey,
  onClose,
}: {
  props: MindmapReactHostProps;
  nodeKey: string;
  onClose: () => void;
}) {
  const t = useI18n();
  const node = props.model.nodes.find((n) => n.sourceKey === nodeKey);
  const originalParent = props.model.nodes.find((n) => n.id === node?.parentId);
  const [parentKey, setParent] = useState(originalParent?.sourceKey ?? "");
  const siblings = props.model.nodes.filter(
    (n) => n.parentId === node?.parentId,
  );
  const next = siblings[siblings.findIndex((n) => n.sourceKey === nodeKey) + 1];
  const [anchorKey, setAnchor] = useState(next?.sourceKey ?? "");
  const [position, setPosition] = useState<"before" | "after">("before");
  const [side, setSide] = useState<
    LayoutType.LEFT | LayoutType.RIGHT | undefined
  >();
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const basis = useMindmapDraftBasis(props, onClose);
  const preview = useRef<(() => void) | null>(null);
  const parent = props.model.nodes.find((n) => n.sourceKey === parentKey);
  const choices = mindmapMoveChoices(props.model, nodeKey, parentKey);
  const disabled = props.readonly || props.displayOnly;
  const dispose = () => {
    preview.current?.();
    preview.current = null;
  };
  useEffect(() => () => preview.current?.(), []);
  const command = (
    patch: {
      parent?: string;
      anchor?: string;
      position?: "before" | "after";
      side?: LayoutType.LEFT | LayoutType.RIGHT | null;
    } = {},
  ) => {
    const targetParent = patch.parent ?? parentKey;
    const action = mindmapMoveAtAnchor(
      props.model,
      nodeKey,
      targetParent,
      (patch.anchor ?? anchorKey) || undefined,
      patch.position ?? position,
    );
    const chosenSide = patch.side === null ? undefined : (patch.side ?? side);
    return action
      ? {
          ...action,
          ...(chosenSide !== undefined &&
          props.model.nodes.find((n) => n.sourceKey === targetParent)?.root
            ? { side: chosenSide, balanced: true }
            : {}),
        }
      : null;
  };
  const show = (patch: Parameters<typeof command>[0]) => {
    dispose();
    setDiagnostic(null);
    const action = command(patch);
    if (action) preview.current = props.onPreview?.(action, basis) ?? null;
  };
  const action = command();
  const impact = action && mindmapMoveImpact(props.model, action);
  const visibleSide =
    props.projection.layout === LayoutType.BALANCE
      ? originalParent?.root
        ? props.projection.rootSides?.get(nodeKey)
        : undefined
      : (props.projection.layout ?? LayoutType.RIGHT);
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dispose();
        onClose();
      }}
    >
      <MyoxusSelect
        label={m.chartParent()}
        comboboxProps={{ withinPortal: false }}
        onKeyDown={handleMindmapSelectKeyDown}
        disabled={disabled}
        value={parentKey}
        data={choices.parents}
        onChange={(value) => {
          setParent(value);
          setAnchor("");
          show({ parent: value, anchor: "" });
        }}
      />
      <MyoxusSelect
        label={m.mindmapMoveAnchor()}
        comboboxProps={{ withinPortal: false }}
        onKeyDown={handleMindmapSelectKeyDown}
        disabled={disabled}
        value={anchorKey}
        data={[{ value: "", label: m.mindmapMoveEnd() }, ...choices.anchors]}
        onChange={(value) => {
          setAnchor(value);
          show({ anchor: value });
        }}
      />
      <MyoxusSelect
        label={m.sequencePosition()}
        comboboxProps={{ withinPortal: false }}
        onKeyDown={handleMindmapSelectKeyDown}
        disabled={disabled || !anchorKey}
        value={position}
        data={[
          { value: "before", label: m.sequenceBefore() },
          { value: "after", label: m.sequenceAfter() },
        ]}
        onChange={(value) => {
          if (value !== "before" && value !== "after") return;
          setPosition(value);
          show({ position: value });
        }}
      />
      {parent?.root ? (
        <MyoxusSelect
          label={m.mindmapBranchSide()}
          description={m.mindmapBranchSideHelp()}
          comboboxProps={{ withinPortal: false }}
          onKeyDown={handleMindmapSelectKeyDown}
          disabled={disabled}
          value={side === undefined ? "keep" : String(side)}
          data={[
            {
              value: "keep",
              label: `${m.mindmapBranchKeep()}${visibleSide === undefined ? "" : ` · ${visibleSide === LayoutType.LEFT ? m.visualMoveLeft() : m.visualMoveRight()}`}`,
            },
            { value: String(LayoutType.LEFT), label: m.visualMoveLeft() },
            { value: String(LayoutType.RIGHT), label: m.visualMoveRight() },
          ]}
          onChange={(value) => {
            if (value === "keep") {
              setSide(undefined);
              show({ side: null });
              return;
            }
            if (
              value !== String(LayoutType.LEFT) &&
              value !== String(LayoutType.RIGHT)
            )
              return;
            const chosen =
              value === String(LayoutType.LEFT)
                ? LayoutType.LEFT
                : LayoutType.RIGHT;
            setSide(chosen);
            show({ side: chosen });
          }}
        />
      ) : null}
      {impact ? (
        <MyoxusText>
          {m.mindmapMoveImpact(
            impact.nodes,
            impact.comments,
            impact.decorations,
            impact.parent,
          )}
        </MyoxusText>
      ) : null}
      {diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={disabled || !action}
          onClick={() => {
            if (!action || disabled) return;
            dispose();
            const result = props.onCommand(action, basis);
            if (result.diagnostic) setDiagnostic(result.diagnostic);
            else onClose();
          }}
        >
          {t.Apply()}
        </Button>
        <Button
          onClick={() => {
            dispose();
            onClose();
          }}
        >
          {t.Cancel()}
        </Button>
      </Group>
    </Stack>
  );
}
