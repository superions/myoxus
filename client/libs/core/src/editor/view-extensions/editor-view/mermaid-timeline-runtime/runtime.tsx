// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  TimelineView,
  Button,
  Group,
  Stack,
  Select,
  NumberInput,
  Modal,
  Popover,
  PopoverTarget,
  PopoverContent,
  MenuItem,
  IconButton,
} from "@myoxus/ui-facade";
import {
  mermaidTimelineRendererToken,
  mermaidMessages as messages,
  type MermaidFamilyReactRendererRegistration,
  type MermaidTimelineReactHostProps,
  TIMELINE_UNSECTIONED_ID,
  type TimelineAnchor,
} from "@virgultum/block-mermaid";
import {
  CommentIcon,
  PaletteIcon,
  MoreHorizontalIcon,
} from "@myoxus/icons/react";
import { useState, useId, useEffect } from "react";
import { isTouchPadPinchEvent } from "@virgultum/shared/utils";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { MermaidEditorWorkbench } from "../mermaid-editor-workbench";
import { TimelineDeleteDialog } from "./delete-dialog";
import { TimelineComments } from "./comments";
import { TimelineAppearancePopover } from "./appearance-popover";
import { TimelineAccessibilityPopover } from "./accessibility-popover";
import { useTimelineInteraction } from "./interaction";
import { projectTimelineView, projectTimelineDraft } from "./projection";

/** Thin Core consumer: local interaction and neutral projection only. */
export function MermaidTimelineRuntime({
  props,
}: {
  readonly props: MermaidTimelineReactHostProps;
}) {
  const interaction = useTimelineInteraction(props);
  useEffect(() => {
    const root = interaction.rootRef.current;
    if (!props.embedded || !root) return;
    // Native inner scrolling must reach the browser before the Edgeless root
    // consumes wheel for camera pan. Pinch/modifier zoom still belongs to it.
    const wheel = (event: WheelEvent) => {
      if (!isTouchPadPinchEvent(event)) event.stopPropagation();
    };
    root.addEventListener("wheel", wheel, { passive: true });
    return () => root.removeEventListener("wheel", wheel);
  }, [interaction.rootRef, props.embedded]);
  const [density, setDensity] = useState(40);
  const [fitWidth, setFitWidth] = useState(false);
  const [commentsVisible, setCommentsVisible] = useState(
    props.initialCommentsOpen,
  );
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentAnchor, setCommentAnchor] = useState<TimelineAnchor>();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearanceOptionsPortalId = useId();
  const accessibilityOptionsPortalId = useId();
  const [moreOpen, setMoreOpen] = useState<"menu" | "accessibility">();
  const projection = projectTimelineView(
    props.model,
    interaction.selection,
    props.readonly,
  );
  const draft = interaction.draft;
  const creating = draft && draft.kind !== "rename";
  const sections = projectTimelineDraft(
    projection.sections,
    draft,
    interaction.move?.intent.object.kind === "period",
  );
  const draftTargets =
    draft?.kind === "period-add"
      ? [
          {
            value: TIMELINE_UNSECTIONED_ID,
            label: messages.timelineUnsectioned(),
          },
          ...props.model.sections
            .filter((s) => !s.implicit)
            .map((s) => ({ value: s.id, label: s.label })),
        ]
      : props.model.periods.map((p) => ({ value: p.id, label: p.label }));
  const slotCount =
    draft?.kind === "section-add"
      ? props.model.sections.filter((s) => !s.implicit).length + 1
      : draft?.kind === "period-add"
        ? props.model.periods.filter((p) => p.sectionId === draft.targetId)
            .length + 1
        : props.model.events.filter((e) => e.periodId === draft?.targetId)
            .length + 1;
  const toolbar = props.displayOnly ? null : (
    <Group>
      {!props.readonly && props.model.headerId ? (
        <>
          <Button onClick={interaction.addSection}>
            {messages.ganttAddSection()}
          </Button>
          <Button onClick={() => interaction.add("period")}>
            {messages.timelineAddPeriod()}
          </Button>
          {props.model.periods.length ? (
            <Button onClick={() => interaction.add("event")}>
              {messages.timelineAddEvent()}
            </Button>
          ) : null}
        </>
      ) : null}
      <Popover
        fitViewport
        returnFocus
        trapFocus
        opened={commentsOpen}
        onChange={setCommentsOpen}
      >
        <PopoverTarget>
          <IconButton
            aria-label={messages.visualComments()}
            tooltip={messages.visualComments()}
            aria-pressed={commentsVisible}
            onClick={() => {
              const next = !commentsVisible;
              setCommentsOpen(next);
              setCommentsVisible(next);
              setCommentAnchor(undefined);
              props.onCommentsOpenChange(next);
            }}
          >
            <CommentIcon />
          </IconButton>
        </PopoverTarget>
        <PopoverContent data-myoxus-editor-keyboard-owner="timeline-comments">
          {commentsOpen ? (
            <TimelineComments
              props={props}
              onClose={() => setCommentsOpen(false)}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      <Popover
        fitViewport
        returnFocus
        trapFocus
        opened={appearanceOpen}
        onChange={setAppearanceOpen}
      >
        <PopoverTarget>
          <IconButton
            aria-label={messages.visualAppearance()}
            tooltip={messages.visualAppearance()}
            onClick={() => {
              setAppearanceOpen(!appearanceOpen);
              setCommentsOpen(false);
              setCommentAnchor(undefined);
            }}
          >
            <PaletteIcon />
          </IconButton>
        </PopoverTarget>
        <PopoverContent
          id={appearanceOptionsPortalId}
          data-myoxus-editor-keyboard-owner="timeline-appearance"
        >
          {appearanceOpen ? (
            <TimelineAppearancePopover
              props={props}
              optionsPortalTarget={`#${CSS.escape(appearanceOptionsPortalId)}`}
              onClose={() => setAppearanceOpen(false)}
            />
          ) : null}
        </PopoverContent>
      </Popover>
      <Popover
        fitViewport
        returnFocus
        trapFocus
        opened={Boolean(moreOpen)}
        onChange={(open) => {
          if (!open) setMoreOpen(undefined);
        }}
      >
        <PopoverTarget>
          <IconButton
            aria-label={messages.visualMoreActions()}
            tooltip={messages.visualMoreActions()}
            onClick={() => {
              setMoreOpen(moreOpen ? undefined : "menu");
              setAppearanceOpen(false);
              setCommentsOpen(false);
              setCommentAnchor(undefined);
            }}
          >
            <MoreHorizontalIcon />
          </IconButton>
        </PopoverTarget>
        <PopoverContent
          id={accessibilityOptionsPortalId}
          data-myoxus-editor-keyboard-owner="timeline-more"
        >
          {moreOpen === "menu" ? (
            <MenuItem onSelect={() => setMoreOpen("accessibility")}>
              {messages.architectureAccessibility()}
            </MenuItem>
          ) : moreOpen === "accessibility" ? (
            <TimelineAccessibilityPopover
              props={props}
              onClose={() => setMoreOpen(undefined)}
              optionsPortalTarget={`#${CSS.escape(accessibilityOptionsPortalId)}`}
            />
          ) : null}
        </PopoverContent>
      </Popover>
    </Group>
  );
  return (
    <div
      ref={interaction.rootRef}
      data-myoxus-editor-keyboard-owner="timeline"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (draft || interaction.move)) {
          event.preventDefault();
          event.stopPropagation();
          props.onConsumeEscape(event.nativeEvent);
          interaction.cancel();
        }
      }}
    >
      <MermaidEditorWorkbench
        actionTarget={props.actionTarget}
        isolateEvents={!props.embedded}
        pageViewport={props.embedded ? undefined : props.pageViewport}
        workareaLabel={messages.visualEditorLabel()}
        toolbar={props.embedded ? null : toolbar}
        embeddedActions={
          props.embedded && toolbar ? (
            <MermaidEmbeddedActions
              actions={toolbar}
              label={messages.visualEditorLabel()}
              placement="inline"
            />
          ) : null
        }
      >
        <Stack>
          <Group>
            <NumberInput
              label={messages.timelineDensity()}
              value={density}
              min={8}
              max={120}
              onChange={(value) => {
                if (typeof value === "number") {
                  setDensity(value);
                  setFitWidth(false);
                }
              }}
            />
            <Button variant="plain" onClick={() => setFitWidth(true)}>
              {messages.ganttFitToWidth()}
            </Button>
          </Group>
          {creating ? (
            <Group>
              {draft.kind !== "section-add" ? (
                <Select
                  label={
                    draft.kind === "period-add"
                      ? messages.ganttSection()
                      : messages.timelinePeriod()
                  }
                  value={draft.targetId ?? null}
                  comboboxProps={{ withinPortal: false }}
                  data={draftTargets}
                  onChange={(value) =>
                    interaction.setDraft((d) =>
                      d ? { ...d, targetId: value, order: null } : undefined,
                    )
                  }
                />
              ) : null}
              <Select
                label={messages.timelineInsertPosition()}
                value={draft.order === null ? null : String(draft.order)}
                disabled={draft.kind !== "section-add" && !draft.targetId}
                comboboxProps={{ withinPortal: false }}
                data={Array.from({ length: slotCount }, (_, i) => ({
                  value: String(i),
                  label: messages.timelineSlot(i + 1, slotCount),
                }))}
                onChange={(value) =>
                  interaction.setDraft((d) =>
                    d
                      ? { ...d, order: value === null ? null : Number(value) }
                      : undefined,
                  )
                }
              />
              <Button variant="plain" onClick={interaction.cancel}>
                {messages.cancel()}
              </Button>
            </Group>
          ) : null}
          {interaction.notice ||
          interaction.preview?.reason === "conflict" ||
          interaction.movePreview?.reason === "conflict" ? (
            <Alert>
              {interaction.notice ?? messages.ganttDiagnosticConflict()}
              <Group>
                <Button onClick={interaction.reloadDraft}>
                  {messages.visualRetry()}
                </Button>
                <Button variant="plain" onClick={interaction.cancel}>
                  {messages.cancel()}
                </Button>
              </Group>
            </Alert>
          ) : null}
          {sections.length ? (
            <TimelineView
              {...projection}
              sections={sections}
              onSelect={interaction.select}
              density={density}
              fitWidth={fitWidth}
              comments={
                commentsVisible
                  ? {
                      counts: Object.fromEntries(
                        [
                          ...props.model.sections,
                          ...props.model.periods,
                          ...props.model.events,
                        ].map((item) => [
                          item.id,
                          props.model.comments.filter(
                            (c) => c.anchor.id === item.id,
                          ).length,
                        ]),
                      ),
                      label: messages.visualComments(),
                      targetId: commentAnchor?.id ?? undefined,
                      onOpen: (object) => {
                        setCommentsOpen(false);
                        setCommentAnchor(object);
                      },
                      onClose: () => setCommentAnchor(undefined),
                      content: commentAnchor ? (
                        <TimelineComments
                          key={commentAnchor.id}
                          props={props}
                          anchor={commentAnchor}
                          onClose={() => setCommentAnchor(undefined)}
                        />
                      ) : null,
                    }
                  : undefined
              }
              moveDraft={interaction.move?.intent}
              movePreview={
                interaction.move
                  ? {
                      valid:
                        Boolean(interaction.movePreview?.changed) ||
                        interaction.movePreview?.reason === "no-change",
                      label: [
                        ...props.model.sections,
                        ...props.model.periods,
                        ...props.model.events,
                      ].find(
                        (item) =>
                          item.id === interaction.move?.intent.object.id,
                      )?.label,
                      message:
                        interaction.movePreview &&
                        !interaction.movePreview.changed &&
                        interaction.movePreview.reason !== "no-change"
                          ? messages.ganttCommandRejected()
                          : undefined,
                    }
                  : undefined
              }
              labels={{
                label: messages.timelineLabel(),
                addPeriod: messages.timelineAddPeriod(),
                addEvent: messages.timelineAddEvent(),
                delete: messages.visualDelete(),
                more: messages.visualMoreActions(),
                apply: messages.architectureApply(),
                cancel: messages.cancel(),
                move: messages.ganttMoveContent(),
                moveHint: messages.timelineMoveHint(),
                slot: messages.timelineSlot,
              }}
              labelDraft={
                draft
                  ? {
                      object: draft.object,
                      label: draft.label,
                      valid:
                        Boolean(interaction.preview?.changed) ||
                        interaction.preview?.reason === "no-change",
                      message:
                        interaction.preview &&
                        !interaction.preview.changed &&
                        interaction.preview.reason !== "no-change"
                          ? messages.ganttCommandRejected()
                          : undefined,
                    }
                  : undefined
              }
              onCreate={(kind, targetId) => interaction.add(kind, targetId)}
              onDelete={interaction.requestDelete}
              onRename={interaction.rename}
              onLabelChange={interaction.changeLabel}
              onDraftApply={interaction.confirm}
              onDraftCancel={interaction.cancel}
              onMovePreview={interaction.movePreviewIntent}
              onMoveApply={interaction.moveApply}
            />
          ) : props.model.diagnostics.length ? (
            <Stack>
              {projection.diagnostics.map((item) => (
                <Alert key={item.id}>{item.message}</Alert>
              ))}
            </Stack>
          ) : (
            <Alert>{messages.timelineEmpty()}</Alert>
          )}
        </Stack>
      </MermaidEditorWorkbench>
      <Modal
        open={Boolean(interaction.deleting)}
        onOpenChange={(open) => {
          if (!open) interaction.closeDelete();
        }}
        title={messages.ganttDeleteImpact()}
      >
        {interaction.deleting ? (
          <TimelineDeleteDialog
            key={interaction.deleting.id}
            props={props}
            target={interaction.deleting}
            onClose={interaction.closeDelete}
            onApplied={interaction.deleteApplied}
          />
        ) : null}
      </Modal>
    </div>
  );
}
export function createMermaidTimelineRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidTimelineReactHostProps> {
  return {
    token: mermaidTimelineRendererToken,
    render: (props) =>
      reactToLit(<MermaidTimelineRuntime props={props} />, true),
  };
}
