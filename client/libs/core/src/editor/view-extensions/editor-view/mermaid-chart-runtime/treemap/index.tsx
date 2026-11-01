// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CommentIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PlusIcon,
  TableIcon,
  TagIcon,
} from "@myoxus/icons";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Button,
  Group,
  IconButton,
  Modal,
  MyoxusNumberInput,
  MyoxusSegmentedControl,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  mermaidTreemapRendererToken,
  type MermaidFamilyReactRendererRegistration,
  type MermaidTreemapReactHostProps,
  type TreemapCommand,
  type TreemapConfig,
  type TreemapSelection,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";

import { ChartEditorSurface, stopEditorEvent } from "../common";
import { TreemapAccessibility } from "./accessibility";
import { TreemapAppearance } from "./appearance";
import { TreemapBreadcrumbs } from "./breadcrumbs";
import { TreemapChartSurface, type TreemapRepairAnchor } from "./chart-surface";
import { TreemapClasses } from "./classes";
import { TreemapComments } from "./comments";
import { TreemapDataEditor } from "./data-editor";
import { TreemapDeleteDialog } from "./delete-dialog";
import { TreemapLabelEditor } from "./label-editor";
import { TreemapMoveOverlay } from "./move-overlay";
import { TreemapValuePopover } from "./value-popover";

type AddDraft = {
  readonly parentId: string | null;
  readonly fixedType?: "section" | "leaf";
};

function TreemapRepairDraft({
  anchor,
  onApply,
  onCancel,
}: {
  readonly anchor: TreemapRepairAnchor;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onCancel: () => void;
}) {
  const { recordId, recordRaw, recordStart } = anchor;
  const recovered = /^(?:[ \t]*)(?:"([^"]*)"|'([^']*)')/.exec(recordRaw);
  const [nodeType, setNodeType] = useState<"section" | "leaf">(
    recovered && /[:,]/.test(recordRaw.slice(recovered[0].length))
      ? "leaf"
      : "section",
  );
  const [label, setLabel] = useState(recovered?.[1] ?? recovered?.[2] ?? "");
  const [value, setValue] = useState<string | number>("");
  const validValue =
    nodeType === "section" ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
  const validLabel =
    Boolean(label.trim()) && !(label.includes('"') && label.includes("'"));
  return (
    <Stack>
      <MyoxusSegmentedControl
        aria-label={messages.treemapType()}
        data={[
          { label: messages.treemapSection(), value: "section" },
          { label: messages.treemapLeaf(), value: "leaf" },
        ]}
        value={nodeType}
        onChange={(next) => setNodeType(next as "section" | "leaf")}
      />
      <MyoxusTextInput
        autoFocus
        label={messages.selectedNodeLabel()}
        value={label}
        onChange={setLabel}
      />
      {nodeType === "leaf" ? (
        <MyoxusNumberInput
          min={0}
          label={messages.value()}
          value={value}
          onChange={setValue}
        />
      ) : null}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          color="myoxusError"
          variant="plain"
          onClick={() =>
            onApply({
              type: "node.delete-record",
              recordId,
              recordRaw,
              recordStart,
              confirmed: true,
            })
          }
        >
          {messages.visualDelete()}
        </Button>
        <Button
          disabled={!validLabel || !validValue}
          onClick={() =>
            onApply({
              type: "node.repair-record",
              recordId,
              recordRaw,
              recordStart,
              nodeType,
              label,
              value: typeof value === "number" ? value : undefined,
            })
          }
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}

function TreemapAddDraft({
  draft,
  onApply,
  onCancel,
  props,
}: {
  readonly draft: AddDraft;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const [nodeType, setNodeType] = useState<"section" | "leaf">(
    draft.fixedType ?? "section",
  );
  const [label, setLabel] = useState("");
  const [value, setValue] = useState<string | number>("");
  const parent = props.model.nodes.find((node) => node.id === draft.parentId);
  const validValue =
    nodeType === "section" ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0);
  const validLabel =
    Boolean(label.trim()) && !(label.includes('"') && label.includes("'"));
  return (
    <Stack>
      <MyoxusText typographySlot="body-small">
        {messages.treemapParent()}: {parent?.label ?? messages.treemapRoot()}
      </MyoxusText>
      {!draft.fixedType ? (
        <MyoxusSegmentedControl
          aria-label={messages.treemapType()}
          data={[
            { label: messages.treemapSection(), value: "section" },
            { label: messages.treemapLeaf(), value: "leaf" },
          ]}
          value={nodeType}
          onChange={(next) => setNodeType(next as "section" | "leaf")}
        />
      ) : null}
      <MyoxusTextInput
        autoFocus
        label={messages.selectedNodeLabel()}
        value={label}
        onChange={setLabel}
      />
      {nodeType === "leaf" ? (
        <MyoxusNumberInput
          min={0}
          label={messages.value()}
          value={value}
          onChange={setValue}
        />
      ) : null}
      <MyoxusText typographySlot="caption">
        {`${parent?.indent ?? ""}${parent ? "  " : ""}"${label}"${nodeType === "leaf" && validValue ? `: ${value}` : ""}`}
      </MyoxusText>
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={!validLabel || !validValue}
          onClick={() =>
            onApply({
              type: "node.add",
              parentId: draft.parentId,
              nodeType,
              label,
              value: typeof value === "number" ? value : undefined,
            })
          }
        >
          {messages.architectureApply()}
        </Button>
      </Group>
    </Stack>
  );
}

function TreemapConversion({
  id,
  onApply,
  onCancel,
  props,
}: {
  readonly id: string;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onCancel: () => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const node = props.model.nodes.find((candidate) => candidate.id === id);
  const [childLabel, setChildLabel] = useState("");
  const [value, setValue] = useState<string | number>("");
  if (!node) return null;
  const section = node.value === null;
  return (
    <Stack>
      {section ? (
        <MyoxusNumberInput
          autoFocus
          min={0}
          label={messages.value()}
          value={value}
          onChange={setValue}
        />
      ) : (
        <MyoxusTextInput
          autoFocus
          label={messages.treemapChildLabel()}
          value={childLabel}
          onChange={setChildLabel}
        />
      )}
      <Group justify="flex-end">
        <Button variant="plain" onClick={onCancel}>
          {messages.cancel()}
        </Button>
        <Button
          disabled={section ? typeof value !== "number" : !childLabel.trim()}
          onClick={() =>
            section
              ? typeof value === "number" &&
                onApply({ type: "node.convert-to-leaf", id, value })
              : onApply({ type: "node.convert-to-section", id, childLabel })
          }
        >
          {section
            ? messages.treemapConvertLeaf()
            : messages.treemapConvertSection()}
        </Button>
      </Group>
    </Stack>
  );
}

export function MermaidTreemapRuntime({
  props,
}: {
  readonly props: MermaidTreemapReactHostProps;
}) {
  const source = props.model.sourceDocument.source;
  const [selection, setSelection] = useState<TreemapSelection>(props.selection);
  const [editing, setEditing] = useState<{
    id: string;
    field: "label" | "value";
  }>();
  const [adding, setAdding] = useState<AddDraft>();
  const [moving, setMoving] = useState<string>();
  const [converting, setConverting] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [repairing, setRepairing] = useState<TreemapRepairAnchor>();
  const [dataOpen, setDataOpen] = useState(props.initialDataOpen);
  const [popover, setPopover] = useState<
    "classes" | "comments" | "appearance" | "more"
  >();
  const [previewConfig, setPreviewConfig] = useState<TreemapConfig>();
  const [notice, setNotice] = useState<string>();
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  useEffect(() => {
    setEditing(undefined);
    setAdding(undefined);
    setMoving(undefined);
    setConverting(undefined);
    setDeleting(undefined);
    setRepairing(undefined);
    setPreviewConfig(undefined);
  }, [source, props.displayOnly, props.readonly]);
  useEffect(() => {
    setSelection(props.selection);
  }, [props.selection]);
  const select = (next: TreemapSelection) => {
    if (editing && (next?.kind !== "node" || next.id !== editing.id))
      setEditing(undefined);
    setSelection(next);
    props.onSelectionChange(next);
  };
  const togglePopover = (
    next: "classes" | "comments" | "appearance" | "more",
  ) => {
    setEditing(undefined);
    setPopover(popover === next ? undefined : next);
  };
  const apply = (command: TreemapCommand | readonly TreemapCommand[]) => {
    const result = props.onCommand(command);
    if (!result.changed) {
      if (result.diagnosis !== "no-change") setNotice(result.diagnosis);
      return false;
    }
    setNotice(undefined);
    select(result.selection);
    setEditing(undefined);
    setAdding(undefined);
    setMoving(undefined);
    setConverting(undefined);
    setDeleting(undefined);
    setRepairing(undefined);
    setPreviewConfig(undefined);
    setFocusRequestKey((value) => value + 1);
    return true;
  };
  const visibleSelection = props.displayOnly ? null : selection;
  const selectedNode =
    visibleSelection?.kind === "node"
      ? props.model.nodes.find((node) => node.id === visibleSelection.id)
      : undefined;
  const requestDeleteFor = (id: string) => {
    const node = props.model.nodes.find((candidate) => candidate.id === id);
    if (!node || props.readonly) return;
    select({ kind: "node", id });
    const preview = props.onPreviewCommand({
      type: "node.delete",
      id,
    });
    if (node.value === null || preview.diagnosis === "confirmation-required")
      setDeleting(id);
    else apply({ type: "node.delete", id });
  };
  const requestDelete = () => selectedNode && requestDeleteFor(selectedNode.id);
  const canAddChild = selectedNode?.value === null && selectedNode.renderable;
  const toolbar = props.displayOnly ? null : (
    <Group wrap="nowrap">
      {!props.readonly ? (
        <>
          <Button
            disabled={!canAddChild}
            prefix={<PlusIcon />}
            onClick={() => {
              setEditing(undefined);
              if (selectedNode)
                setAdding({
                  parentId: selectedNode.id,
                  fixedType: "section",
                });
            }}
          >
            {messages.treemapAddSection()}
          </Button>
          <Button
            disabled={!canAddChild}
            prefix={<PlusIcon />}
            onClick={() => {
              setEditing(undefined);
              if (selectedNode)
                setAdding({ parentId: selectedNode.id, fixedType: "leaf" });
            }}
          >
            {messages.treemapAddLeaf()}
          </Button>
        </>
      ) : null}
      <IconButton
        icon={<TableIcon />}
        aria-label={messages.treemapData()}
        tooltip={messages.treemapData()}
        aria-pressed={dataOpen}
        onClick={() => {
          setEditing(undefined);
          setDataOpen(!dataOpen);
          props.onDataOpenChange(!dataOpen);
        }}
      />
      <Popover
        opened={popover === "classes"}
        onChange={(opened) => setPopover(opened ? "classes" : undefined)}
        fitViewport
      >
        <PopoverTarget>
          <IconButton
            icon={<TagIcon />}
            aria-label={messages.treemapClasses()}
            tooltip={messages.treemapClasses()}
            onClick={() => togglePopover("classes")}
          />
        </PopoverTarget>
        <PopoverContent>
          <Scrollable.Viewport autosize maxHeight="floating">
            <TreemapClasses
              nodeId={selectedNode?.id}
              onApply={apply}
              onOpenComments={(id) => {
                select({ kind: "class-def", id });
                setPopover("comments");
              }}
              props={props}
            />
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
      <Popover
        opened={popover === "comments"}
        onChange={(opened) => setPopover(opened ? "comments" : undefined)}
        fitViewport
      >
        <PopoverTarget>
          <IconButton
            icon={<CommentIcon />}
            aria-label={messages.visualComments()}
            tooltip={messages.visualComments()}
            onClick={() => togglePopover("comments")}
          />
        </PopoverTarget>
        <PopoverContent>
          <Scrollable.Viewport autosize maxHeight="floating">
            <TreemapComments
              onApply={apply}
              onSelect={select}
              props={props}
              selection={selection}
            />
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
      {!props.readonly ? (
        <Popover
          opened={popover === "appearance"}
          onChange={(opened) => setPopover(opened ? "appearance" : undefined)}
          fitViewport
        >
          <PopoverTarget>
            <IconButton
              icon={<PaletteIcon />}
              aria-label={messages.visualAppearance()}
              tooltip={messages.visualAppearance()}
              onClick={() => togglePopover("appearance")}
            />
          </PopoverTarget>
          <PopoverContent>
            <Scrollable.Viewport autosize maxHeight="floating">
              <TreemapAppearance
                onApply={apply}
                onPreview={setPreviewConfig}
                props={props}
              />
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
      ) : null}
      {!props.readonly ? (
        <Popover
          opened={popover === "more"}
          onChange={(opened) => setPopover(opened ? "more" : undefined)}
          fitViewport
        >
          <PopoverTarget>
            <IconButton
              icon={<MoreHorizontalIcon />}
              aria-label={messages.visualMoreActions()}
              tooltip={messages.visualMoreActions()}
              onClick={() => togglePopover("more")}
            />
          </PopoverTarget>
          <PopoverContent>
            <Stack>
              {selectedNode ? (
                <>
                  <Button
                    variant="plain"
                    onClick={() => {
                      setEditing(undefined);
                      setMoving(selectedNode.id);
                      setPopover(undefined);
                    }}
                  >
                    {messages.treemapMove()}
                  </Button>
                  <Button
                    variant="plain"
                    onClick={() => {
                      setEditing(undefined);
                      setConverting(selectedNode.id);
                      setPopover(undefined);
                    }}
                  >
                    {selectedNode.value === null
                      ? messages.treemapConvertLeaf()
                      : messages.treemapConvertSection()}
                  </Button>
                </>
              ) : null}
              <TreemapAccessibility
                onApply={apply}
                onCancel={() => setPopover(undefined)}
                props={props}
              />
            </Stack>
          </PopoverContent>
        </Popover>
      ) : null}
    </Group>
  );
  const displayedProps = previewConfig
    ? { ...props, model: { ...props.model, config: previewConfig } }
    : props;
  const directEditor =
    editing?.field === "value" ? (
      <TreemapValuePopover
        id={editing.id}
        onApply={apply}
        onCancel={() => setEditing(undefined)}
        props={props}
      />
    ) : editing ? (
      <TreemapLabelEditor
        id={editing.id}
        onApply={apply}
        onCancel={() => setEditing(undefined)}
        props={props}
      />
    ) : undefined;
  return (
    <div
      data-testid="mermaid-treemap-view"
      onPointerDown={props.embedded ? undefined : stopEditorEvent}
      onKeyDown={(event) => {
        const target = event.target;
        const editingField =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement;
        if (
          !editingField &&
          (event.key === "Delete" || event.key === "Backspace")
        ) {
          event.preventDefault();
          requestDelete();
        }
        if (!editingField && event.key === "Escape" && editing) {
          event.preventDefault();
          setEditing(undefined);
          setFocusRequestKey((value) => value + 1);
        }
        if (!props.embedded) stopEditorEvent(event);
      }}
    >
      <ChartEditorSurface
        actionTarget={props.actionTarget}
        embedded={props.embedded}
        pageViewport={props.pageViewport}
        context={
          !props.displayOnly && dataOpen ? (
            <TreemapDataEditor
              onApply={apply}
              onAdd={(parentId, type) =>
                setAdding({ parentId, fixedType: type })
              }
              onClass={(id) => {
                select({ kind: "node", id });
                setPopover("classes");
              }}
              onDelete={requestDeleteFor}
              onEdit={(id, field) => {
                select({ kind: "node", id });
                setEditing({ id, field });
              }}
              onMove={setMoving}
              onRepairRecord={setRepairing}
              onSelect={select}
              props={props}
              selection={visibleSelection}
            />
          ) : null
        }
        contextOpened={!props.displayOnly && dataOpen}
        contextTitle={messages.treemapData()}
        onCloseContext={() => {
          setDataOpen(false);
          props.onDataOpenChange(false);
        }}
        selectedId={visibleSelection?.id}
        toolbar={toolbar}
        workareaLabel={messages.visualEditorLabel()}
        selectionAction={{
          disabled: props.readonly || !selectedNode,
          label: messages.visualDelete(),
          onSelect: requestDelete,
          register: props.onSelectionActionChange,
          selectionKey: visibleSelection
            ? `${visibleSelection.kind}:${visibleSelection.id}`
            : undefined,
        }}
      >
        {notice ? <Alert role="status">{notice}</Alert> : null}
        {!props.displayOnly ? (
          <TreemapBreadcrumbs
            model={props.model}
            nodeId={selectedNode?.id}
            onSelect={(id) => select({ kind: "node", id })}
          />
        ) : null}
        <TreemapChartSurface
          commentsVisible={!props.displayOnly && popover === "comments"}
          editor={props.displayOnly ? undefined : directEditor}
          editorNodeId={props.displayOnly ? undefined : editing?.id}
          focusRequestKey={focusRequestKey}
          interactive={!props.displayOnly}
          onAddRoot={() => setAdding({ parentId: null })}
          onEdit={(id, field) => {
            select({ kind: "node", id });
            setEditing({ id, field });
          }}
          onOpenComment={(id) => {
            select({ kind: "node", id });
            setPopover("comments");
          }}
          onOpenClass={(id) => {
            select({ kind: "node", id });
            setPopover("classes");
          }}
          onOpenDiagramComment={() => {
            select(null);
            setPopover("comments");
          }}
          onReparent={(id, parentId) =>
            apply({ type: "hierarchy.reparent", id, parentId })
          }
          onRepairRecord={setRepairing}
          onSelect={select}
          props={displayedProps}
          selection={visibleSelection}
        />
        <Modal
          open={Boolean(repairing)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setRepairing(undefined)}
          title={messages.displayEdit()}
        >
          {repairing ? (
            <TreemapRepairDraft
              anchor={repairing}
              onApply={apply}
              onCancel={() => setRepairing(undefined)}
            />
          ) : null}
        </Modal>
        <Modal
          open={Boolean(adding)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setAdding(undefined)}
          title={
            adding?.parentId === null
              ? messages.treemapRootCreate()
              : adding?.fixedType === "leaf"
                ? messages.treemapAddLeaf()
                : messages.treemapAddSection()
          }
        >
          {adding ? (
            <TreemapAddDraft
              draft={adding}
              onApply={apply}
              onCancel={() => setAdding(undefined)}
              props={props}
            />
          ) : null}
        </Modal>
        <Modal
          open={Boolean(moving)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setMoving(undefined)}
          title={messages.treemapMove()}
        >
          {moving ? (
            <TreemapMoveOverlay
              id={moving}
              onApply={apply}
              onCancel={() => setMoving(undefined)}
              props={props}
            />
          ) : null}
        </Modal>
        <Modal
          open={Boolean(converting)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setConverting(undefined)}
          title={
            selectedNode?.value === null
              ? messages.treemapConvertLeaf()
              : messages.treemapConvertSection()
          }
        >
          {converting ? (
            <TreemapConversion
              id={converting}
              onApply={apply}
              onCancel={() => setConverting(undefined)}
              props={props}
            />
          ) : null}
        </Modal>
        <Modal
          open={Boolean(deleting)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => !opened && setDeleting(undefined)}
          title={messages.visualDelete()}
        >
          {deleting ? (
            <TreemapDeleteDialog
              id={deleting}
              onApply={apply}
              onCancel={() => setDeleting(undefined)}
              props={props}
            />
          ) : null}
        </Modal>
      </ChartEditorSurface>
    </div>
  );
}

export function createMermaidTreemapRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidTreemapReactHostProps> {
  return {
    token: mermaidTreemapRendererToken,
    render: (props) =>
      reactToLit(<MermaidTreemapRuntime props={props} />, true),
  };
}
