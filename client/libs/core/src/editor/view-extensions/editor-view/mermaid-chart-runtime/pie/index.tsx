// SPDX-License-Identifier: AGPL-3.0-or-later

import { CommentIcon, PlusIcon, TableIcon } from "@myoxus/icons";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Group,
  IconButton,
  Stack,
  type DataPieChartItem,
} from "@myoxus/ui-facade";
import {
  mermaidPieRendererToken,
  type MermaidPieAppearanceDraft,
  type MermaidFamilyReactRendererRegistration,
  type MermaidPieCommand,
  type MermaidPieCommandSelection,
  type MermaidPieReactHostProps,
  type MermaidRuntimeTransactionOptions,
} from "@virgultum/block-mermaid";
import { useEffect, useRef, useState } from "react";

import { ChartEditorSurface, stopEditorEvent } from "../common";
import { MermaidPieChartSurface } from "./chart-surface";
import { MermaidPieDataEditor } from "./data-editor";
import {
  MermaidPieAccessibilityPopover,
  MermaidPieSettingsPopover,
} from "./settings-popover";

function selectedSliceId(selection: MermaidPieCommandSelection | null) {
  return selection?.kind === "slice" ? selection.id : undefined;
}

const PIE_DRAFT_SLICE_ID = "pie-slice-draft";

export function MermaidPieRuntime({
  props,
}: {
  readonly props: MermaidPieReactHostProps;
}) {
  const [selectedId, setSelectedId] = useState<string>();
  const [selectionEditorOpen, setSelectionEditorOpen] = useState(false);
  const [draft, setDraft] = useState<DataPieChartItem | null>(null);
  const [focusSelectedId, setFocusSelectedId] = useState<string>();
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const [dataEditorOpen, setDataEditorOpen] = useState(false);
  const [appearancePreview, setAppearancePreview] =
    useState<MermaidPieAppearanceDraft | null>(null);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string>();
  const sourceHashRef = useRef(props.model.sourceHash);
  const ownCommitPendingRef = useRef(false);
  useEffect(() => {
    if (sourceHashRef.current === props.model.sourceHash) return;
    sourceHashRef.current = props.model.sourceHash;
    if (ownCommitPendingRef.current) {
      ownCommitPendingRef.current = false;
      return;
    }
    if (
      !draft &&
      !selectionEditorOpen &&
      !appearancePreview &&
      !dataEditorOpen
    ) {
      return;
    }
    setDraft(null);
    setSelectionEditorOpen(false);
    setAppearancePreview(null);
    setDraftNotice(props.labels.sourceChanged);
  }, [
    appearancePreview,
    dataEditorOpen,
    draft,
    props.labels.sourceChanged,
    props.model.sourceHash,
    selectionEditorOpen,
  ]);
  useEffect(() => {
    if (!props.readonly) return;
    setSelectedId(undefined);
    setSelectionEditorOpen(false);
    setDraft(null);
    setAppearancePreview(null);
    setDataEditorOpen(false);
    setCommentsVisible(false);
  }, [props.readonly]);
  const dispatch = (
    command: MermaidPieCommand,
    options?: MermaidRuntimeTransactionOptions,
  ) => {
    const selection = props.onCommand(command, options);
    if (selection) {
      ownCommitPendingRef.current = true;
      setDraftNotice(undefined);
    }
    if (selection?.kind === "slice") setSelectedId(selection.id);
    else if (selection && command.type === "slice.delete") {
      setSelectedId(undefined);
    }
    return selection;
  };
  const selectSlice = (sliceId: string) => {
    if (draft && sliceId !== draft.id) setDraft(null);
    setSelectedId(sliceId);
    setSelectionEditorOpen(true);
  };
  const selectDataSlice = (sliceId: string) => {
    if (draft) setDraft(null);
    setSelectedId(sliceId);
    setSelectionEditorOpen(false);
  };
  const startDraft = () => {
    setDraftNotice(undefined);
    const nextDraft = {
      id: PIE_DRAFT_SLICE_ID,
      label: props.newSliceLabel,
      value: 1,
    };
    setDraft(nextDraft);
    setSelectedId(nextDraft.id);
    setSelectionEditorOpen(true);
  };
  const closeSelectionEditor = () => {
    if (draft) {
      setDraft(null);
      setSelectedId(undefined);
    }
    setSelectionEditorOpen(false);
  };
  const draftDiagnosis = draft
    ? props.validateSliceDraft(draft.label, draft.value)
    : null;
  const draftValid = Boolean(draft && draftDiagnosis === null);
  const applyDraft = () => {
    if (!draft || !draftValid) return;
    const selection = dispatch({
      label: draft.label,
      type: "slice.add",
      value: draft.value,
    });
    if (selection?.kind !== "slice") return;
    setDraft(null);
    setSelectionEditorOpen(false);
    setFocusSelectedId(selection.id);
    setFocusRequestKey((current) => current + 1);
  };
  const reorder = (sliceId: string, beforeSliceId?: string) =>
    dispatch({ beforeSliceId, sliceId, type: "slice.reorder" });
  const deleteSlice = (sliceId: string) => {
    if (sliceId === PIE_DRAFT_SLICE_ID) {
      closeSelectionEditor();
      return;
    }
    const selection = dispatch({
      sliceId,
      type: "slice.delete",
    });
    if (!selection) return;
    setSelectionEditorOpen(false);
    setFocusSelectedId(selectedSliceId(selection));
    setFocusRequestKey((current) => current + 1);
    if (selection.kind === "diagram") setDataEditorOpen(false);
  };
  const deleteSelection = () => {
    if (selectedId) deleteSlice(selectedId);
  };
  const toggleDataEditor = () => {
    if (dataEditorOpen) {
      setDataEditorOpen(false);
      if (selectedId) {
        setFocusSelectedId(selectedId);
        setFocusRequestKey((current) => current + 1);
      }
      return;
    }
    if (draft) {
      setDraft(null);
      setSelectedId(undefined);
    }
    setSelectionEditorOpen(false);
    setDataEditorOpen(true);
  };
  const applyAppearance = (next: MermaidPieAppearanceDraft) => {
    const unchanged =
      next.showData === props.model.showData &&
      next.options.donutHole === props.model.options.donutHole &&
      next.options.highlightSlice === props.model.options.highlightSlice &&
      next.options.legendPosition === props.model.options.legendPosition &&
      next.options.textPosition === props.model.options.textPosition;
    if (unchanged) {
      setAppearancePreview(null);
      return true;
    }
    const applied = Boolean(
      dispatch({
        options: next.options,
        showData: next.showData,
        type: "diagram.appearance",
      }),
    );
    if (applied) setAppearancePreview(null);
    return applied;
  };
  const applyAccessibility = (title: string, description: string) => {
    const unchanged =
      title.trim().replace(/\s+/g, " ") === props.model.accessibilityTitle &&
      description.trim() === props.model.accessibilityDescription;
    if (unchanged) return true;
    return Boolean(
      dispatch({
        description,
        title,
        type: "diagram.accessibility-settings",
      }),
    );
  };
  return (
    <div
      data-testid="mermaid-pie-view"
      onClick={props.embedded ? undefined : stopEditorEvent}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        const editable =
          target.matches("input, textarea, select") || target.isContentEditable;
        if (
          !props.readonly &&
          !editable &&
          selectedId &&
          (event.key === "Delete" || event.key === "Backspace")
        ) {
          event.preventDefault();
          deleteSelection();
        }
        if (!props.embedded) stopEditorEvent(event);
      }}
      onMouseDown={props.embedded ? undefined : stopEditorEvent}
      onPointerDown={props.embedded ? undefined : stopEditorEvent}
    >
      <ChartEditorSurface
        actionTarget={props.actionTarget}
        context={null}
        contextOpened={false}
        contextTitle={props.labels.inspector}
        embedded={props.embedded}
        onCloseContext={() => {
          setSelectedId(undefined);
          setSelectionEditorOpen(false);
        }}
        pageViewport={props.pageViewport}
        selectedId={selectedId}
        selectionAction={{
          disabled: props.readonly,
          label: props.labels.delete,
          onSelect: deleteSelection,
          register: props.onSelectionActionChange,
        }}
        toolbar={
          props.readonly || props.items.length === 0 ? null : (
            <Group gap="xs" role="group" wrap="nowrap">
              <IconButton
                aria-label={props.labels.add}
                icon={<PlusIcon />}
                onClick={startDraft}
                tooltip={props.labels.add}
              />
              <IconButton
                aria-label={props.labels.data}
                aria-pressed={dataEditorOpen}
                icon={<TableIcon />}
                onClick={toggleDataEditor}
                tooltip={props.labels.data}
                variant={dataEditorOpen ? "solid" : "plain"}
              />
              <IconButton
                aria-label={props.labels.comments}
                aria-pressed={commentsVisible}
                icon={<CommentIcon />}
                onClick={() => setCommentsVisible((visible) => !visible)}
                tooltip={props.labels.comments}
                variant={commentsVisible ? "solid" : "plain"}
              />
              <MermaidPieSettingsPopover
                onApply={applyAppearance}
                onPreview={setAppearancePreview}
                onStale={() => setDraftNotice(props.labels.sourceChanged)}
                props={props}
              />
              <MermaidPieAccessibilityPopover
                onApply={applyAccessibility}
                onStale={() => setDraftNotice(props.labels.sourceChanged)}
                props={props}
              />
            </Group>
          )
        }
        workareaLabel={props.labels.chart}
      >
        <Stack gap="md">
          {draftNotice ? (
            <Alert color="myoxusWarning" role="status" variant="light">
              {draftNotice}
            </Alert>
          ) : null}
          <MermaidPieChartSurface
            appearance={appearancePreview}
            commentsVisible={commentsVisible && !props.readonly}
            draft={draft}
            draftDiagnosis={draftDiagnosis}
            draftValid={draftValid}
            focusRequestKey={focusRequestKey}
            focusSelectedId={focusSelectedId}
            onAdd={startDraft}
            onDraftApply={applyDraft}
            onDraftChange={(label, value) =>
              setDraft((current) =>
                current ? { ...current, label, value } : current,
              )
            }
            onDraftInvalidated={() =>
              setDraftNotice(props.labels.sourceChanged)
            }
            onRename={(sliceId, label) =>
              Boolean(dispatch({ label, sliceId, type: "slice.rename" }))
            }
            onReorder={reorder}
            onSelect={selectSlice}
            onSelectionClose={closeSelectionEditor}
            onValueApply={(sliceId, value) =>
              dispatch({ sliceId, type: "slice.value", value })
            }
            props={props}
            selectionEditorOpen={selectionEditorOpen}
            selectedId={selectedId}
          />
          {dataEditorOpen && !props.readonly && props.items.length > 0 ? (
            <MermaidPieDataEditor
              onAdd={startDraft}
              onDelete={deleteSlice}
              onLabelChange={(sliceId, label) =>
                Boolean(dispatch({ label, sliceId, type: "slice.rename" }))
              }
              onReorder={reorder}
              onSelect={selectDataSlice}
              onValueChange={(sliceId, value) =>
                Boolean(dispatch({ sliceId, type: "slice.value", value }))
              }
              props={props}
              selectedId={selectedId}
            />
          ) : null}
        </Stack>
      </ChartEditorSurface>
    </div>
  );
}

export function createMermaidPieRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidPieReactHostProps> {
  return {
    token: mermaidPieRendererToken,
    render: (props) => reactToLit(<MermaidPieRuntime props={props} />, true),
  };
}
