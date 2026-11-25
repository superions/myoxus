// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ReadonlySignal } from "@preact/signals-core";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { useI18n } from "@myoxus/i18n";
import { ResetIcon, WarningIcon } from "@myoxus/icons/react";
import {
  IconButton,
  Button,
  Group,
  MenuPanel,
  MyoxusText,
  Loading,
  ReferenceCard,
  Badge,
  Popover,
  PopoverTarget,
  PopoverContent,
} from "@myoxus/ui-facade";
import {
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent,
} from "react";
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import type { EditorAttachmentCardControls } from "@virgultum/editor/shared/services";
import { EditorEmbeddedUIRoot } from "../embedded-ui-root";

/** Resource state, renderer bounds and guarded commands stay with the mounted block. */
export function EditorAttachmentCard({
  controls: c,
}: {
  controls: EditorAttachmentCardControls;
}) {
  const t = useI18n();
  const [opened, setOpened] = useState(false);
  const preserveStatusKey = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.nativeEvent.isComposing)
      setOpened(false);
  };
  const preserveStatusPointer = (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    // Native buttons must not replace the image selection while its status action runs.
    if (event.target instanceof Element && event.target.closest("button"))
      event.preventDefault();
  };
  const actionLabel =
    c.action?.kind === "retry"
      ? t.Retry()
      : c.action?.kind === "reload"
        ? t["com.myoxus.editor.toolbar.reload"]()
        : t.Info();
  const runAction = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (c.statusPopover) setOpened(false);
    c.action?.run();
  };
  const FileIcon = getAttachmentFileIconRC(c.fileType);
  const card = (
    <ReferenceCard
      size="small"
      orientation={c.vertical ? "vertical" : "horizontal"}
      contained={c.inSurface}
      selected={c.selected}
      fullHeight={c.inSurface}
      title={c.title}
      metadata={c.description}
      status={
        c.citationIdentifier ? (
          <Badge tone={c.selected ? "info" : "neutral"}>
            {c.citationIdentifier}
          </Badge>
        ) : undefined
      }
      icon={
        c.loading ? (
          <Loading />
        ) : c.error ? (
          <WarningIcon />
        ) : (
          <FileIcon width="1em" height="1em" />
        )
      }
      actions={
        c.action ? (
          <IconButton
            icon={c.action.kind === "limit" ? <WarningIcon /> : <ResetIcon />}
            tooltip={actionLabel}
            onClick={runAction}
          />
        ) : undefined
      }
      data-testid="editor-attachment-card"
      aria-busy={c.loading}
    />
  );
  if (!c.statusPopover) return card;
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="top-start"
      width="min-content"
      withinPortal={false}
      returnFocus={false}
      fitViewport
    >
      <PopoverTarget>
        <IconButton
          icon={<WarningIcon />}
          aria-label={c.title}
          size="small"
          variant="danger"
          tooltip={opened ? undefined : c.title}
          onKeyDown={preserveStatusKey}
          onPointerDown={preserveStatusPointer}
          onClick={(event) => {
            event.stopPropagation();
            setOpened((value) => !value);
          }}
        />
      </PopoverTarget>
      <PopoverContent
        onPointerDown={preserveStatusPointer}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={preserveStatusKey}
      >
        <MenuPanel>
          <MyoxusText typographySlot="body-small">
            <strong>{c.title}</strong>
          </MyoxusText>
          <MyoxusText typographySlot="body-small">{c.description}</MyoxusText>
          {c.action ? (
            <Group justify="flex-end">
              <Button variant="plain" onClick={runAction}>
                {actionLabel}
              </Button>
            </Group>
          ) : null}
        </MenuPanel>
      </PopoverContent>
    </Popover>
  );
}

export function RegisteredAttachmentCard({
  state,
  portalRoot,
}: {
  state: ReadonlySignal<EditorAttachmentCardControls | null>;
  portalRoot?: HTMLElement;
}) {
  const controls = useSignalValue(state);
  if (!controls) return null;
  const view = <EditorAttachmentCard controls={controls} />;
  return controls.statusPopover && portalRoot ? (
    <EditorEmbeddedUIRoot portalRoot={portalRoot}>{view}</EditorEmbeddedUIRoot>
  ) : (
    view
  );
}
