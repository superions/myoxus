// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  IconButton,
  Button,
  Group,
  MyoxusTextInput,
  JourneyMap,
  Select,
  Menu,
  MenuItem,
  Popover,
  PopoverTarget,
  PopoverContent,
  Stack,
  Scrollable,
  type JourneyMapSelection,
} from "@myoxus/ui-facade";
import {
  mermaidJourneyRendererToken,
  mermaidMessages as messages,
  readJourneyConfig,
  type MermaidFamilyReactRendererRegistration,
  type MermaidJourneyReactHostProps,
  type JourneyCommand,
  type MermaidJourneyModel,
  type MermaidJourneyStep,
  type MermaidJourneySection,
} from "@virgultum/block-mermaid";
import { CommentIcon } from "@myoxus/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import {
  MermaidEditorWorkbench,
  useMermaidSelectionAction,
} from "../mermaid-editor-workbench";
import {
  createJourneyDraft,
  journeyDraftCommand,
  type JourneyDraft,
  type JourneyRenameDraft,
} from "./drafts";
import { projectJourneyMap } from "./projection";
import { JourneyStepPopover, type JourneyStepFormDraft } from "./step-popover";
import {
  JourneyCommentsPopover,
  type JourneyCommentFormDraft,
} from "./comments-popover";
import { JourneySectionDeleteDialog } from "./section-delete-dialog";
import { JourneyConfigPopover } from "./config-popover";
import { journeySelectionExists, nextJourneySelection } from "./selection";

/** Core only coordinates local interaction and the neutral map. The family owns every source write. */
export function MermaidJourneyRuntime({
  props,
}: {
  props: MermaidJourneyReactHostProps;
}) {
  const t = useI18n();
  const numberFormat = new Intl.NumberFormat(t.language);
  const diagnosticCause = (
    code: MermaidJourneyModel["diagnostics"][number]["code"],
  ) =>
    ({
      header: messages.journeyInvalidHeader,
      syntax: messages.journeyInvalidValue,
      score: messages.journeyInvalidScore,
      "score-range": messages.journeyScoreRange,
      "actor-slot": messages.journeyActorSlot,
      config: messages.journeyInvalidConfig,
      accessibility: messages.journeyIncompleteAccessibility,
    })
      [code]()
      .replace(/\.$/, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState(props.selection);
  const [draft, setDraft] = useState<JourneyDraft>();
  const [renameDraft, setRenameDraft] = useState<JourneyRenameDraft>();
  const [editRequest, setEditRequest] = useState<{
    id: string;
    kind: "step" | "section";
    requestId: number;
  }>();
  const [focusRequest, setFocusRequest] = useState<{
    requestId: number;
    revealOnly?: boolean;
    selection?: JourneyMapSelection;
    target?: "map" | "add-section-empty";
  }>();
  const [overlay, setOverlay] = useState<{
    id: string | null;
    kind: "metadata" | "data" | "comments" | "position-comments";
  }>();
  const [addTargetOpened, setAddTargetOpened] = useState(false);
  const [addTarget, setAddTarget] = useState<string>();
  const objectSnapshotRef = useRef<
    MermaidJourneyStep | MermaidJourneySection | undefined
  >(undefined);
  const stepFormRef = useRef<JourneyStepFormDraft | undefined>(undefined);
  const commentFormRef = useRef<JourneyCommentFormDraft | undefined>(undefined);
  const handoffDraftRef = useRef(false);
  const [options, setOptions] = useState<
    "appearance" | "accessibility" | "actors" | "data" | "more"
  >();
  const [deleting, setDeleting] = useState<string>();
  const [commentsVisible, setCommentsVisible] = useState(true);
  const [preview, setPreview] = useState<MermaidJourneyModel>();
  const [highlight, setHighlight] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const basisRef = useRef(props.model.sourceDocument.source);
  const interactionRef = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const source = props.model.sourceDocument.source;
  const readonly = props.readonly || props.displayOnly || props.model.ambiguous;
  const renameConflict = Boolean(
    renameDraft &&
    !readonly &&
    (renameDraft.conflicted ||
      ![...props.model.sections, ...props.model.steps].some(
        (node) => node.id === renameDraft.id,
      )),
  );
  const orphanedOverlay = Boolean(
    overlay?.id &&
    !readonly &&
    (overlay.kind === "position-comments"
      ? !props.model.comments.some((comment) => comment.id === overlay.id)
      : ![...props.model.sections, ...props.model.steps].some(
          (node) => node.id === overlay.id,
        )) &&
    (objectSnapshotRef.current || commentFormRef.current),
  );
  useEffect(() => {
    setSelection(props.selection);
  }, [props.selection]);
  useEffect(() => {
    if (props.replayed) {
      objectSnapshotRef.current = undefined;
      stepFormRef.current = undefined;
      commentFormRef.current = undefined;
      setDraft(undefined);
      setRenameDraft(undefined);
      setAddTargetOpened(false);
      setEditRequest(undefined);
      setDeleting(undefined);
      setOptions(undefined);
      setOverlay(undefined);
      setPreview(undefined);
      setFocusRequest({
        requestId: ++sequence.current,
        selection: props.selection,
        target: props.selection
          ? undefined
          : props.model.sections.length
            ? "map"
            : "add-section-empty",
      });
    }
  }, [props.replayed, source, props.selection]);
  useEffect(() => {
    const objects = [...props.model.sections, ...props.model.steps];
    if (
      (interactionRef.current &&
        interactionRef.current !== draft?.key &&
        !objects.some((node) => node.id === interactionRef.current)) ||
      (draft &&
        [draft.sectionId, draft.afterId].some(
          (id) => id && !objects.some((node) => node.id === id),
        ))
    ) {
      interactionRef.current = undefined;
      setEditRequest(undefined);
      setNotice(messages.ganttDiagnosticConflict());
    }
    if (
      overlay?.id &&
      overlay.kind !== "position-comments" &&
      overlay.id !== draft?.key &&
      ![...props.model.sections, ...props.model.steps].some(
        (node) => node.id === overlay.id,
      )
    ) {
      setPreview(undefined);
      setNotice(messages.ganttDiagnosticConflict());
    }
  }, [readonly, props.model, overlay, draft]);
  useEffect(() => {
    if (readonly) {
      // Cancel on rights loss, then allow subsequent read-only exploration.
      // Model or overlay changes must not close a reader's newly opened form.
      setOverlay(undefined);
      setOptions(undefined);
      setPreview(undefined);
      setAddTargetOpened(false);
      objectSnapshotRef.current = undefined;
      stepFormRef.current = undefined;
      commentFormRef.current = undefined;
      setDraft(undefined);
      setRenameDraft(undefined);
      setDeleting(undefined);
      setEditRequest(undefined);
    }
  }, [readonly]);
  const select = (value: JourneyMapSelection | undefined) => {
    setSelection(value);
    props.onSelectionChange(value);
  };
  const focus = (value: JourneyMapSelection | undefined) =>
    setFocusRequest({
      requestId: ++sequence.current,
      ...(value
        ? { selection: value }
        : {
            target: props.model.sections.length ? "map" : "add-section-empty",
          }),
    });
  const apply = (
    command: JourneyCommand | readonly JourneyCommand[],
    basis = source,
  ) => {
    const result = props.onCommand(command, basis);
    interactionRef.current = undefined;
    if (result.changed || result.reason === "no-change") {
      setNotice(undefined);
      if (result.selection) {
        const selected =
          result.selection.kind === "step"
            ? { stepId: result.selection.id }
            : { sectionId: result.selection.id };
        select(selected);
        focus(selected);
      }
      setPreview(undefined);
      return true;
    }
    setNotice(
      result.reason === "conflict"
        ? messages.ganttDiagnosticConflict()
        : result.reason === "invalid"
          ? messages.journeyInvalidValue()
          : messages.ganttCommandRejected(),
    );
    return false;
  };
  const cancel = () => {
    objectSnapshotRef.current = undefined;
    stepFormRef.current = undefined;
    commentFormRef.current = undefined;
    setDraft(undefined);
    setRenameDraft(undefined);
    setNotice(undefined);
    setEditRequest(undefined);
    setOverlay(undefined);
    setOptions(undefined);
    setPreview(undefined);
    setAddTargetOpened(false);
    focus(
      journeySelectionExists(props.model, selection) ? selection : undefined,
    );
  };
  const add = (kind: "step" | "section", sectionId?: string) => {
    if (readonly) return;
    const next = createJourneyDraft(
      kind,
      source,
      sectionId,
      kind === "section" ? selection?.sectionId : undefined,
    );
    setOverlay(undefined);
    setDraft(next);
    setEditRequest({ kind, id: next.key, requestId: ++sequence.current });
  };
  const rename = (id: string, label: string) => {
    if (draft?.key === id) {
      if (apply(journeyDraftCommand(draft, label), draft.source)) {
        setDraft(undefined);
        setEditRequest(undefined);
      }
      return;
    }
    if (
      apply(
        { type: "rename", id, label },
        renameDraft?.id === id ? renameDraft.source : basisRef.current,
      )
    )
      setRenameDraft(undefined);
    else
      setRenameDraft((current) =>
        current ? { ...current, label, conflicted: true } : current,
      );
  };
  const remove = (id: string) => {
    if (props.model.sections.some((section) => section.id === id)) {
      setDeleting(id);
      return;
    }
    const next = nextJourneySelection(props.model, id);
    if (apply({ type: "delete", id })) {
      select(next);
      focus(next);
    }
  };
  useMermaidSelectionAction({
    disabled: readonly,
    label: messages.visualDelete(),
    onSelect: () => {
      const id = selection?.stepId ?? selection?.sectionId;
      if (id) remove(id);
    },
    register: props.onSelectionActionChange,
    selectionKey: journeySelectionExists(props.model, selection)
      ? (selection?.stepId ?? selection?.sectionId)
      : null,
  });
  const open = (
    id: string,
    kind: "metadata" | "data" | "comments" = "metadata",
  ) => {
    setNotice(undefined);
    objectSnapshotRef.current = [
      ...props.model.sections,
      ...props.model.steps,
    ].find((node) => node.id === id);
    stepFormRef.current = undefined;
    commentFormRef.current = undefined;
    const selected =
      (draft?.key === id && draft.kind === "step") ||
      props.model.steps.some((step) => step.id === id)
        ? { stepId: id }
        : { sectionId: id };
    select(selected);
    setFocusRequest({
      requestId: ++sequence.current,
      selection: selected,
      revealOnly: true,
    });
    if (draft?.key === id) {
      handoffDraftRef.current = true;
      setOverlay({ id, kind });
      return;
    }
    setPreview(undefined);
    setOverlay({ id, kind });
    setOptions(undefined);
  };
  const frame = (node: { id: string }, content: ReactNode) => (
    <Popover
      opened={overlay?.id === node.id}
      onChange={(opened) => {
        if (!opened) cancel();
      }}
      fitViewport
      returnFocus={false}
      trapFocus
      withArrow
      position="top"
    >
      <PopoverTarget>{content}</PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="journey-object">
        <Scrollable.Viewport autosize maxHeight="floating">
          {overlay?.id === node.id ? (
            overlay.kind === "comments" ? (
              <JourneyCommentsPopover
                props={props}
                anchorId={node.id}
                onFormDraft={(value) => {
                  commentFormRef.current = value;
                }}
                onClose={cancel}
              />
            ) : (
              <JourneyStepPopover
                props={props}
                node={[...props.model.sections, ...props.model.steps].find(
                  (n) => n.id === node.id,
                )}
                draft={draft?.key === node.id ? draft : undefined}
                onDraftPreview={(label, score, actors) =>
                  setDraft((current) =>
                    current ? { ...current, label, score, actors } : current,
                  )
                }
                onDraftApply={(label, score, actors) => {
                  if (
                    draft &&
                    apply(
                      journeyDraftCommand({ ...draft, score, actors }, label),
                      draft.source,
                    )
                  ) {
                    // Apply focuses the persisted key; closing a creation form must
                    // not replace that request with its removed local draft key.
                    objectSnapshotRef.current = undefined;
                    stepFormRef.current = undefined;
                    setDraft(undefined);
                    setEditRequest(undefined);
                    setOverlay(undefined);
                    setPreview(undefined);
                  }
                }}
                data={overlay.kind === "data"}
                onFormDraft={(value) => {
                  stepFormRef.current = value;
                }}
                onClose={cancel}
                onPreview={setPreview}
              />
            )
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const marker = (id: string | null, compact = false) => {
    const count = props.model.comments.filter(
      (comment) => comment.anchorId === id && comment.affinity === "object",
    ).length;
    if (!commentsVisible || (!count && readonly)) return null;
    const label = `${messages.visualComments()}: ${count}`;
    const onClick = () => {
      if (id) open(id, "comments");
      else {
        objectSnapshotRef.current = undefined;
        stepFormRef.current = undefined;
        commentFormRef.current = undefined;
        setPreview(undefined);
        setOverlay({ id: null, kind: "comments" });
      }
    };
    return count && !compact ? (
      <Button
        variant="plain"
        aria-label={label}
        prefix={<CommentIcon />}
        onClick={onClick}
      >
        {count}
      </Button>
    ) : (
      <IconButton aria-label={label} tooltip={label} onClick={onClick}>
        <CommentIcon />
      </IconButton>
    );
  };
  const positionMarker = (comment: (typeof props.model.comments)[number]) => (
    <Popover
      key={comment.id}
      opened={
        overlay?.id === comment.id && overlay.kind === "position-comments"
      }
      onChange={(opened) => {
        if (!opened) setOverlay(undefined);
      }}
      fitViewport
      returnFocus
      trapFocus
      withArrow
    >
      <PopoverTarget>
        <IconButton
          aria-label={`${messages.visualComments()}: ${comment.text}`}
          tooltip={comment.text}
          onClick={() => {
            objectSnapshotRef.current = undefined;
            stepFormRef.current = undefined;
            commentFormRef.current = undefined;
            setPreview(undefined);
            setOverlay({ id: comment.id, kind: "position-comments" });
          }}
        >
          <CommentIcon />
        </IconButton>
      </PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="journey-position-comment">
        <Scrollable.Viewport autosize maxHeight="floating">
          {overlay?.id === comment.id ? (
            <JourneyCommentsPopover
              props={props}
              anchorId={null}
              commentId={comment.id}
              onFormDraft={(value) => {
                commentFormRef.current = value;
              }}
              onClose={() => setOverlay(undefined)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const followingObject = (offset: number) =>
    [...props.model.sections, ...props.model.steps]
      .flatMap((node) => {
        const record = props.model.sourceDocument.records.find(
          (record) => record.sourceKey === node.id,
        );
        return record ? [{ node, start: record.range.start }] : [];
      })
      .filter((item) => item.start > offset)
      .sort((a, b) => a.start - b.start)[0]?.node.id;
  const mapPosition = (offset: number) =>
    ![...props.model.sections, ...props.model.steps].some((node) => {
      const record = props.model.sourceDocument.records.find(
        (record) => record.sourceKey === node.id,
      );
      return record && record.range.start < offset;
    });
  const positioned = (id?: string) => {
    if (!commentsVisible) return null;
    const comments = props.model.comments.filter(
      (comment) =>
        comment.affinity === "position" &&
        (mapPosition(comment.range.start)
          ? id === "map"
          : followingObject(comment.range.end) === id),
    );
    return comments.length ? <>{comments.map(positionMarker)}</> : null;
  };
  const config = readJourneyConfig(props.model.sourceDocument).effective;
  const rendered = preview ?? props.model;
  const sections = projectJourneyMap(rendered, readonly, draft).map(
    (section) => {
      const node = props.model.sections.find((n) => n.id === section.id);
      return {
        ...section,
        actions: node ? (
          <Group wrap="nowrap">
            {marker(node.id, true)}
            {positioned(node.id)}
          </Group>
        ) : undefined,
        frame: node ? (content: ReactNode) => frame(node, content) : undefined,
        steps: section.steps.map((step) => {
          const node = props.model.steps.find((n) => n.id === step.id);
          return {
            ...step,
            highlighted: highlight ? step.actors.includes(highlight) : false,
            precedingContent: positioned(step.id),
            frame: node
              ? (content: ReactNode) => frame(node, content)
              : draft?.key === step.id
                ? (content: ReactNode) => frame({ id: step.id }, content)
                : undefined,
            actions: node ? marker(node.id) : undefined,
            diagnostic: node
              ? rendered.diagnostics
                  .filter((e) => e.anchorId === node.id)
                  .map((e) =>
                    e.code === "score-range"
                      ? messages.journeyScoreRange()
                      : messages.journeyDiagnostic(
                          diagnosticCause(e.code),
                          e.range.start,
                          e.range.end,
                          e.range.line,
                        ),
                  )
                  .join(" ")
              : undefined,
          };
        }),
      };
    },
  );
  const optionsTrigger = (
    kind: "appearance" | "accessibility" | "actors" | "data",
    label: string,
  ) => (
    <Popover
      key={kind}
      opened={options === kind}
      onChange={(opened) => {
        if (!opened) setOptions(undefined);
      }}
      fitViewport
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <Button
          variant="plain"
          onClick={() => {
            if (
              kind === "data" &&
              (selection?.stepId || selection?.sectionId)
            ) {
              open((selection.stepId ?? selection.sectionId)!, "data");
              return;
            }
            setOptions(options === kind ? undefined : kind);
            setOverlay(undefined);
          }}
        >
          {label}
        </Button>
      </PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="journey-options">
        <Scrollable.Viewport autosize maxHeight="floating">
          {options === kind ? (
            <JourneyConfigPopover
              props={props}
              kind={kind}
              highlight={highlight}
              onHighlight={setHighlight}
              onOpenStep={(id) => {
                setOptions(undefined);
                open(id);
              }}
              onClose={() => setOptions(undefined)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const toolbar = props.displayOnly ? null : (
    <Group wrap="nowrap">
      {!readonly && !props.model.ambiguous ? (
        <Button onClick={() => add("section")}>
          {messages.journeyAddSection()}
        </Button>
      ) : null}
      {!readonly && props.model.sections.length > 0 ? (
        <Popover
          opened={addTargetOpened}
          onChange={setAddTargetOpened}
          fitViewport
          returnFocus
          trapFocus
        >
          <PopoverTarget>
            <Button
              variant="plain"
              onClick={() => {
                const id =
                  selection?.sectionId ??
                  props.model.steps.find((s) => s.id === selection?.stepId)
                    ?.sectionId;
                if (id) add("step", id);
                else if (props.model.sections.length === 1)
                  add("step", props.model.sections[0]!.id);
                else setAddTargetOpened(true);
              }}
            >
              {messages.journeyAddStep()}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            <Stack>
              <Select
                label={messages.journeySection()}
                value={addTarget}
                onChange={setAddTarget}
                data={props.model.sections
                  .filter((s) => s.writable)
                  .map((s) => ({
                    value: s.id,
                    label: s.title || messages.journeyUnnamed(),
                  }))}
              />
              <Button
                disabled={!addTarget}
                onClick={() => {
                  if (addTarget) add("step", addTarget);
                  setAddTargetOpened(false);
                }}
              >
                {messages.journeyAddStep()}
              </Button>
            </Stack>
          </PopoverContent>
        </Popover>
      ) : null}
      {optionsTrigger("actors", messages.journeyActors())}
      <Button
        variant="plain"
        aria-pressed={commentsVisible}
        onClick={() => setCommentsVisible(!commentsVisible)}
      >
        {messages.visualComments()}
      </Button>
      {optionsTrigger("appearance", messages.visualAppearance())}
      {optionsTrigger("accessibility", messages.visualAccessibility())}
      {optionsTrigger("data", messages.treemapData())}
      <Menu
        items={
          <>
            {props.onExportMmd ? (
              <MenuItem onSelect={props.onExportMmd}>
                {messages.mmdExport()}
              </MenuItem>
            ) : null}
            {!readonly && (selection?.stepId || selection?.sectionId) ? (
              <MenuItem
                onSelect={() => {
                  basisRef.current = source;
                  setEditRequest({
                    kind: selection.stepId ? "step" : "section",
                    id: (selection.stepId ?? selection.sectionId)!,
                    requestId: ++sequence.current,
                  });
                }}
              >
                {messages.selectedNodeLabel()}
              </MenuItem>
            ) : null}
          </>
        }
        title={messages.visualMoreActions()}
      >
        <Button variant="plain">{messages.visualMoreActions()}</Button>
      </Menu>
    </Group>
  );
  return (
    <div
      ref={rootRef}
      data-myoxus-editor-keyboard-owner="journey"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          (draft || renameDraft || overlay || options)
        ) {
          event.preventDefault();
          event.stopPropagation();
          props.onConsumeEscape(event.nativeEvent);
          cancel();
        }
      }}
    >
      <MermaidEditorWorkbench
        actionTarget={
          props.embedded ? props.headerActionTarget : props.actionTarget
        }
        pageViewport={props.embedded ? undefined : props.pageViewport}
        isolateEvents={!props.embedded}
        workareaLabel={messages.visualEditorLabel()}
        toolbar={props.embedded ? null : toolbar}
      >
        <Stack>
          {props.embedded && toolbar ? (
            <MermaidEmbeddedActions
              actions={toolbar}
              label={messages.visualEditorLabel()}
              placement="inline"
            />
          ) : null}
          {notice && !renameConflict && !orphanedOverlay ? (
            <Alert>
              {notice}
              {draft ? (
                <Button variant="plain" onClick={cancel}>
                  {messages.cancel()}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          {renameDraft && renameConflict ? (
            <Alert>
              {messages.ganttDiagnosticConflict()}
              <MyoxusTextInput
                label={
                  renameDraft.kind === "step"
                    ? messages.journeyStep()
                    : messages.journeySection()
                }
                value={renameDraft.label}
                onChange={(label) => setRenameDraft({ ...renameDraft, label })}
              />
              <Group>
                <Button variant="plain" onClick={cancel}>
                  {messages.cancel()}
                </Button>
                <Button
                  onClick={() => rename(renameDraft.id, renameDraft.label)}
                >
                  {messages.architectureApply()}
                </Button>
              </Group>
            </Alert>
          ) : null}
          {overlay?.id && orphanedOverlay ? (
            <Alert>
              {messages.ganttDiagnosticConflict()}
              <Popover
                opened
                returnFocus
                trapFocus
                fitViewport
                onChange={(opened) => {
                  if (!opened) cancel();
                }}
              >
                <PopoverTarget>
                  <Button variant="plain">{messages.displayEdit()}</Button>
                </PopoverTarget>
                <PopoverContent data-myoxus-editor-keyboard-owner="journey-object">
                  <Scrollable.Viewport autosize maxHeight="floating">
                    {overlay.kind === "comments" ||
                    overlay.kind === "position-comments" ? (
                      <JourneyCommentsPopover
                        props={props}
                        anchorId={
                          overlay.kind === "comments" ? overlay.id : null
                        }
                        commentId={
                          overlay.kind === "position-comments"
                            ? overlay.id
                            : undefined
                        }
                        initialForm={commentFormRef.current}
                        onFormDraft={(value) => {
                          commentFormRef.current = value;
                        }}
                        onClose={cancel}
                      />
                    ) : (
                      <JourneyStepPopover
                        props={props}
                        node={objectSnapshotRef.current}
                        initialForm={stepFormRef.current}
                        onFormDraft={(value) => {
                          stepFormRef.current = value;
                        }}
                        data={overlay.kind === "data"}
                        onPreview={setPreview}
                        onClose={cancel}
                      />
                    )}
                  </Scrollable.Viewport>
                </PopoverContent>
              </Popover>
              <Button variant="plain" onClick={cancel}>
                {messages.cancel()}
              </Button>
            </Alert>
          ) : null}
          {props.model.diagnostics
            .filter(
              (error) =>
                !["score-range", "actor-slot", "score"].includes(error.code),
            )
            .map((error) => (
              <Alert key={`${error.anchorId}:${error.code}`}>
                {messages.journeyDiagnostic(
                  diagnosticCause(error.code),
                  error.range.start,
                  error.range.end,
                  error.range.line,
                )}
              </Alert>
            ))}
          {props.model.ambiguous ? (
            <Alert>
              {props.model.staleProjection
                ? messages.journeyLastValid()
                : messages.ganttAmbiguousSource()}
              {!props.embedded ? (
                <Button variant="plain" onClick={props.onOpenSource}>
                  {messages.modeSource()}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          <Group>
            <Popover
              opened={overlay?.id === null}
              onChange={(opened) => {
                if (!opened) setOverlay(undefined);
              }}
              fitViewport
              returnFocus
              trapFocus
            >
              <PopoverTarget>
                <Group>{marker(null)}</Group>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {overlay?.id === null ? (
                    <JourneyCommentsPopover
                      props={props}
                      anchorId={null}
                      onClose={() => setOverlay(undefined)}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
            {positioned("map")}
          </Group>
          <JourneyMap
            scrollOwner={props.embedded ? "self" : "parent"}
            aria-label={messages.visualEditorLabel()}
            data-testid="mermaid-journey-map"
            sections={sections}
            stepWidth={Number(config.width) + Number(config.taskMargin)}
            selection={selection}
            readonly={readonly}
            editRequest={editRequest}
            focusRequest={focusRequest}
            addSection={{ enabled: !props.model.ambiguous && !sections.length }}

            onAddSection={() => add("section")}
            onAddStep={(id) => add("step", id)}
            onSelectStep={(id) => select({ stepId: id })}
            onSelectSection={(id) => select({ sectionId: id })}
            onOpenStep={(id) => open(id)}
            onOpenSection={(id) => open(id)}
            onEditInput={(_kind, id, label) => {
              if (draft?.key === id) setDraft({ ...draft, label });
              else
                setRenameDraft((current) =>
                  current?.id === id ? { ...current, label } : current,
                );
            }}
            onRenameStep={rename}
            onRenameSection={rename}
            onInteractionStart={(kind, id, intent) => {
              interactionRef.current = id;
              basisRef.current = source;
              if (intent === "rename" && draft?.key !== id) {
                const node = [
                  ...props.model.sections,
                  ...props.model.steps,
                ].find((node) => node.id === id);
                if (node)
                  setRenameDraft({
                    id,
                    kind,
                    source,
                    label: "label" in node ? node.label : node.title,
                  });
              }
            }}
            onEditEnd={(_kind, id, outcome) => {
              interactionRef.current = undefined;
              if (handoffDraftRef.current) {
                handoffDraftRef.current = false;
                return;
              }
              if (
                outcome === "cancel" &&
                [...props.model.sections, ...props.model.steps].some(
                  (node) => node.id === id,
                )
              )
                setRenameDraft(undefined);
              if (outcome === "cancel" && draft?.key === id) {
                setDraft(undefined);
                focus(selection);
              }
            }}
            onMoveStep={(move) => {
              return apply(
                {
                  type: "move-step",
                  id: move.stepId,
                  sectionId: move.toSectionId,
                  targetId: move.targetStepId,
                  edge: move.edge,
                },
                basisRef.current,
              );
            }}
            onMoveSection={(move) => {
              return apply(
                {
                  type: "move-section",
                  id: move.sectionId,
                  targetId: move.targetSectionId,
                  edge: move.edge,
                },
                basisRef.current,
              );
            }}
            onDeleteStep={remove}
            onDeleteSection={remove}
            labels={{
              score: (value) =>
                `${messages.journeyScore()}: ${numberFormat.format(value)} (${value < 3 ? messages.journeyScoreNegative() : value > 3 ? t["com.myoxus.editor.label-tone.positive"]() : t["com.myoxus.editor.label-tone.neutral"]()})`,
              scoreAxis: messages.journeyScore(),
              moveTarget: messages.journeyMoveTarget,
              scoreValue: (value) =>
                Number.isFinite(value) ? numberFormat.format(value) : "?",
              actions: t["com.myoxus.actions"](),
              unnamedSection: messages.journeyUnnamed(),
              addStep: (label) => `${messages.journeyAddStep()}: ${label}`,
              addSection: messages.journeyAddSection(),
              stepCount: (count) =>
                `${messages.journeyStep()}: ${numberFormat.format(count)}`,
              deleteStep: (label) => `${messages.visualDelete()}: ${label}`,
              deleteSection: (label) => `${messages.visualDelete()}: ${label}`,
              dragStep: (label) => `${messages.journeyMoveStep()}: ${label}`,
              dragSection: (label) =>
                `${messages.journeyMoveSection()}: ${label}`,
              emptySection: messages.journeyEmptySection(),
              openStep: (label) =>
                `${t["com.myoxus.workspace-pages.action.open"]()}: ${label}`,
              movedStep: (label, from, to) =>
                `${messages.journeyMoved()}: ${label}, ${from}, ${to}`,
              movedSection: (label, target) =>
                `${messages.journeyMoved()}: ${label}, ${target}`,
            }}
          />
          {positioned()}
        </Stack>
      </MermaidEditorWorkbench>
      {deleting ? (
        <JourneySectionDeleteDialog
          key={deleting}
          props={props}
          id={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            const next = nextJourneySelection(props.model, deleting);
            select(next);
            focus(next);
          }}
        />
      ) : null}
    </div>
  );
}
export function createMermaidJourneyRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidJourneyReactHostProps> {
  return {
    token: mermaidJourneyRendererToken,
    render: (props) =>
      reactToLit(<MermaidJourneyRuntime props={props} />, true),
  };
}
