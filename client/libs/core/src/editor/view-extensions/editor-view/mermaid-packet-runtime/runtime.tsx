// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Button,
  Group,
  Menu,
  MenuItem,
  MyoxusText,
  PacketBitGrid,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Stack,
  type PacketFragment,
  type PacketGeometryIntent,
} from "@myoxus/ui-facade";
import {
  layoutPacket,
  packetSourceDiagnostic,
  mermaidPacketActions,
  mermaidPacketRendererToken,
  mermaidMessages as messages,
  type MermaidFamilyReactRendererRegistration,
  type MermaidPacketReactHostProps,
  type PacketCommentAnchor,
} from "@virgultum/block-mermaid";
import { isTouchPadPinchEvent } from "@virgultum/shared/utils";
import { useEffect, useRef, type ReactNode } from "react";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import {
  MermaidEditorWorkbench,
  useMermaidSelectionAction,
} from "../mermaid-editor-workbench";
import { usePacketDraftSession, packetGeometryCommand } from "./drafts";
import { PacketFieldPopover, PacketDraftAction } from "./field-popover";
import { PacketCommentMarker } from "./comments-popover";
import { PacketAppearancePopover } from "./appearance-popover";
import { PacketAccessibilityPopover } from "./accessibility-popover";
import { PacketDataPopover } from "./data-popover";
import { usePacketSelection } from "./selection";
/** One structured body serves Page and the existing embedded Note. All durable
 * writes are command results from the Family's exact-source history port. */
export function MermaidPacketRuntime({
  props,
}: {
  props: MermaidPacketReactHostProps;
}) {
  const t = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const selectionState = usePacketSelection(props);
  const { selection, selectionRow, focusRequest, select } = selectionState;
  const {
    draft,
    overlay,
    setOverlay,
    commentAnchor,
    setCommentAnchor,
    geometryActive,
    setGeometryActive,
    commentsVisible,
    setCommentsVisible,
    previewModel,
    setPreviewModel,
    notice,
    setNotice,
    geometryBasis,
    source,
    gestureSession,
    geometryWritable,
    focusCurrent,
    selected,
    busy,
    cancel,
    applied,
    open,
    setDraft,
  } = usePacketDraftSession(props, selectionState);
  useEffect(() => {
    const root = rootRef.current;
    if (!props.embedded || !root) return;
    const wheel = (event: WheelEvent) => {
      if (!isTouchPadPinchEvent(event)) event.stopPropagation();
    };
    root.addEventListener("wheel", wheel, { passive: true });
    return () => root.removeEventListener("wheel", wheel);
  }, [props.embedded]);
  const remove = (key: string) => {
    select(key);
    open("delete", key);
  };
  useMermaidSelectionAction({
    disabled: !geometryWritable || busy,
    label: messages.visualDelete(),
    onSelect: () => {
      if (selection) remove(selection);
    },
    register: props.onSelectionActionChange,
    selectionKey: selected?.id ?? null,
  });
  const fieldFrame = (fragment: PacketFragment, content: ReactNode) => (
    <PacketFieldPopover
      props={props}
      fragment={fragment}
      content={content}
      draft={draft}
      onClose={cancel}
      onApply={applied}
    />
  );
  const marker = (
    anchor: PacketCommentAnchor,
    row?: number,
    commentKey?: string,
  ) => (
    <PacketCommentMarker
      key={commentKey ?? anchor.anchorId ?? anchor.anchorKind}
      props={props}
      target={{ anchor, row, commentKey }}
      active={commentAnchor}
      visible={commentsVisible}
      writable={geometryWritable}
      selectedFieldId={selection}
      disabled={geometryActive || Boolean(draft || overlay)}
      onOpen={(target) => {
        setDraft(undefined);
        setOverlay(undefined);
        setCommentAnchor(target);
      }}
      onClose={cancel}
    />
  );
  const moreAction = mermaidPacketActions.find(
    (action) => action.placement === "menu",
  )!;
  const actions = props.displayOnly ? null : (
    <Group wrap="nowrap">
      {mermaidPacketActions
        .filter((action) => action.placement === "primary")
        .map((action) => {
          if (action.commandId === "packet.comments")
            return (
              <Button
                key={action.id}
                variant="plain"
                disabled={busy}
                aria-pressed={commentsVisible}
                onClick={() => setCommentsVisible(!commentsVisible)}
              >
                {action.label}
              </Button>
            );
          const kind =
            action.commandId === "packet.add"
              ? "add"
              : action.commandId === "packet.split"
                ? "split"
                : "merge";
          return (
            <PacketDraftAction
              key={action.id}
              props={props}
              kind={kind}
              label={action.label}
              disabled={
                !geometryWritable ||
                (busy && draft?.kind !== kind) ||
                (kind === "split" && (!selected || selected.width < 2)) ||
                (kind === "merge" &&
                  (!selected || props.model.fields.length < 2))
              }
              draft={draft}
              onOpen={open}
              onClose={cancel}
              onApply={applied}
            />
          );
        })}
      <Popover
        opened={Boolean(overlay)}
        onChange={(opened) => {
          if (!opened && overlay) cancel();
        }}
        fitViewport
        returnFocus={false}
        trapFocus
      >
        <PopoverTarget>
          <Group wrap="nowrap">
            <Menu
              title={moreAction.label}
              items={
                <>
                  {mermaidPacketActions
                    .filter((action) => action.placement === "overflow")
                    .map((action) => {
                      if (action.commandId === "packet.export")
                        return props.onExportMmd ? (
                          <MenuItem
                            key={action.id}
                            onSelect={props.onExportMmd}
                          >
                            {action.label}
                          </MenuItem>
                        ) : null;
                      if (
                        action.commandId === "packet.rename" ||
                        action.commandId === "packet.delete"
                      )
                        return selected ? (
                          <MenuItem
                            key={action.id}
                            disabled={!geometryWritable || busy}
                            onSelect={() =>
                              open(
                                action.commandId === "packet.rename"
                                  ? "field"
                                  : "delete",
                              )
                            }
                          >
                            {action.label}
                          </MenuItem>
                        ) : null;
                      const kind =
                        action.commandId === "packet.appearance"
                          ? "appearance"
                          : action.commandId === "packet.accessibility"
                            ? "accessibility"
                            : "data";
                      return (
                        <MenuItem
                          key={action.id}
                          disabled={busy}
                          onSelect={() => setOverlay(kind)}
                        >
                          {action.label}
                        </MenuItem>
                      );
                    })}
                </>
              }
            >
              <Button variant="plain" disabled={busy}>
                {moreAction.label}
              </Button>
            </Menu>
          </Group>
        </PopoverTarget>
        <PopoverContent data-myoxus-editor-keyboard-owner="packet-options">
          <Scrollable.Viewport autosize maxHeight="floating">
            {overlay === "appearance" ? (
              <PacketAppearancePopover
                props={props}
                onClose={cancel}
                onPreview={setPreviewModel}
                onApply={applied}
              />
            ) : overlay === "accessibility" ? (
              <PacketAccessibilityPopover
                props={props}
                onClose={cancel}
                onPreview={setPreviewModel}
                onApply={applied}
              />
            ) : overlay === "data" ? (
              <PacketDataPopover props={props} onClose={cancel} />
            ) : null}
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
    </Group>
  );
  const displayModel = previewModel ?? props.projectionModel ?? props.model;
  const layout = layoutPacket(displayModel);
  const config = layout.config;
  const diagnosis = packetSourceDiagnostic(props.model) ?? layout.diagnostic;
  return (
    <div
      ref={rootRef}
      data-myoxus-editor-keyboard-owner="packet"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          (draft || overlay || commentAnchor || geometryBasis.current)
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
        workareaLabel={messages.packetBitLayout()}
        toolbar={props.embedded ? null : actions}
      >
        <Stack>
          {props.embedded && actions ? (
            <MermaidEmbeddedActions
              actions={actions}
              label={messages.packetBitLayout()}
              placement="inline"
            />
          ) : null}
          {notice ? <Alert>{notice}</Alert> : null}
          {diagnosis ? (
            <Alert>
              {diagnosis}
              {props.projectionModel ? (
                <MyoxusText>{messages.packetLastValid()}</MyoxusText>
              ) : null}
            </Alert>
          ) : null}
          <PacketBitGrid
            aria-label={
              displayModel.accessibilityTitle || messages.packetBitLayout()
            }
            aria-description={displayModel.accessibilityDescription}
            rows={layout.rows}
            bitsPerRow={config?.bitsPerRow ?? 0}
            bitWidth={config?.bitWidth ?? 0}
            rowHeight={config?.rowHeight ?? 0}
            showBits={config?.showBits ?? false}
            paddingX={config?.paddingX ?? 0}
            paddingY={layout.derivedPaddingY ?? 0}
            totalWidth={layout.totalWidth}
            gestureSession={gestureSession}
            fieldOrder={displayModel.fields.map((field) => field.id)}
            readonly={
              !geometryWritable || Boolean(draft || overlay || commentAnchor)
            }
            displayOnly={props.displayOnly}
            selectedFieldId={selection}
            focusRequest={focusRequest}
            scrollOwner={props.embedded ? "self" : "parent"}
            labels={{
              bit: (value) => new Intl.NumberFormat(t.language).format(value),
              field: (label, start, end, continued) => {
                const number = new Intl.NumberFormat(t.language);
                const describe = continued
                  ? messages.packetFieldContinuationLabel
                  : messages.packetFieldLabel;
                return describe(
                  label,
                  number.format(start),
                  number.format(end),
                  number.format(end - start + 1),
                );
              },
              totalWidth: (value) =>
                messages.packetTotalWidth(
                  new Intl.NumberFormat(t.language).format(value),
                ),
              boundary: (bit, label) =>
                messages.packetBoundaryLabel(
                  label,
                  new Intl.NumberFormat(t.language).format(bit),
                ),
              reorderTarget: (index) =>
                `${messages.timelineInsertPosition()}: ${new Intl.NumberFormat(t.language).format(index)}`,
            }}
            onSelectField={(key, target) => {
              selectionRow.current = {
                fieldKey: key,
                row: Number(target.dataset.packetFragmentRow),
              };
              select(key);
            }}
            onOpenField={(fragment) =>
              open("field", fragment.fieldId, fragment.row)
            }
            onDeleteField={(key) => {
              if (geometryWritable) remove(key);
            }}
            frameField={fieldFrame}
            markers={
              <>
                {marker({
                  anchorKind: "diagram",
                  anchorId: props.model.sourceDocument.records.find(
                    (record) => record.kind === "header",
                  )?.sourceKey,
                  position: "before",
                })}
                {marker({ anchorKind: "diagram", position: "before" })}
                {props.model.sourceDocument.records
                  .filter(
                    (record) =>
                      record.kind === "title" ||
                      record.kind === "accessibility-title" ||
                      record.kind === "accessibility-description",
                  )
                  .map((record) =>
                    marker({
                      anchorKind:
                        record.kind as PacketCommentAnchor["anchorKind"],
                      anchorId: record.sourceKey,
                      position: "before",
                    }),
                  )}
              </>
            }
            fieldMarker={(fragment) =>
              marker(
                {
                  anchorKind: "field",
                  anchorId: fragment.fieldId,
                  position: "before",
                },
                fragment.row,
              )
            }
            empty={
              !props.model.fields.length && geometryWritable ? (
                <Button onClick={() => open("add")}>
                  {messages.packetAddField()}
                </Button>
              ) : undefined
            }
            onGeometryStart={() => {
              setGeometryActive(true);
              setCommentAnchor(undefined);
              geometryBasis.current = source;
              setDraft(undefined);
              setOverlay(undefined);
              setPreviewModel(undefined);
            }}
            onGeometryPreview={(intent: PacketGeometryIntent) => {
              if (geometryBasis.current === undefined) return;
              const result = props.onPreviewCommand(
                packetGeometryCommand(intent),
                geometryBasis.current,
              );
              if (result.changed || result.reason === "no-change") {
                setPreviewModel(result.model);
                setNotice(undefined);
              } else
                setNotice(result.diagnostic ?? messages.ganttCommandRejected());
            }}
            onGeometryConfirm={(intent: PacketGeometryIntent) => {
              if (geometryBasis.current === undefined) return;
              const result = props.onCommand(
                packetGeometryCommand(intent),
                geometryBasis.current,
              );
              applied(result);
              setPreviewModel(undefined);
              geometryBasis.current = undefined;
              setGeometryActive(false);
            }}
            onGeometryCancel={(escape) => {
              setGeometryActive(false);
              if (escape) props.onConsumeEscape(escape);
              focusCurrent();
              setNotice(undefined);
              setPreviewModel(undefined);
              geometryBasis.current = undefined;
            }}
          />
        </Stack>
      </MermaidEditorWorkbench>
    </div>
  );
}
export function createMermaidPacketRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidPacketReactHostProps> {
  return {
    token: mermaidPacketRendererToken,
    render: (props) => reactToLit(<MermaidPacketRuntime props={props} />, true),
  };
}
