// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useRef } from "react";
import { useI18n } from "@myoxus/i18n";
import { CommentIcon } from "@myoxus/icons";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Alert,
  Button,
  ConfirmModal,
  CountIndicator,
  Group,
  IconButton,
  MyoxusTextInput,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Select,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  c4CommentText,
  c4CommentTargets,
  editC4Comment,
  type C4CommentMarker,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

export function C4CommentPopover({
  props,
  marker,
}: {
  props: C4ReactHostProps;
  marker: C4CommentMarker;
}) {
  const [opened, setOpened] = useState(false),
    button = useRef<HTMLButtonElement>(null),
    t = useI18n();
  if (props.displayOnly) return null;
  return (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <CountIndicator count={marker.count}>
          <IconButton
            ref={button}
            aria-label={`${m.visualComments()} (${new Intl.NumberFormat(t.language).format(marker.count)})`}
            onClick={() => setOpened(true)}
          >
            <CommentIcon />
          </IconButton>
        </CountIndicator>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(false))
        }
      >
        {opened ? (
          <Scrollable.Viewport autosize maxHeight="floating">
            <Accordion>
              {marker.sourceKeys.map((key) => {
                const r = props.model.sourceDocument.records.find(
                  (r) => r.sourceKey === key,
                )!;
                return (
                  <AccordionItem value={key} key={key}>
                    <AccordionControl>
                      {c4CommentText(r) || m.visualComments()} ·{" "}
                      {t["com.myoxus.editor.mermaid.c4-record-position"]({
                        call: "%%",
                        line: new Intl.NumberFormat(t.language).format(
                          r.range.line,
                        ),
                      })}
                    </AccordionControl>
                    <AccordionPanel>
                      <C4CommentForm
                        props={props}
                        sourceKey={key}
                        onClose={() => {
                          setOpened(false);
                          (button.current?.isConnected
                            ? button.current
                            : props.resolveReturnFocusTarget()
                          )?.focus();
                        }}
                      />
                    </AccordionPanel>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </Scrollable.Viewport>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
export function C4CommentForm({
  props,
  sourceKey,
  anchorKey,
  onClose,
}: {
  props: C4ReactHostProps;
  sourceKey?: string;
  anchorKey?: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    record = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey && r.kind === "comment",
    ),
    targets = c4CommentTargets(props.model, sourceKey);
  const initial = record?.anchor ?? {
    sourceKey:
      anchorKey ??
      props.model.sourceDocument.records.find((r) => r.kind === "header")!
        .sourceKey,
    position: "before" as const,
  };
  const encode = (target: { sourceKey: string; position: string }) =>
    `${target.sourceKey}:${target.position}`;
  const d = useC4Draft(
      { text: record ? c4CommentText(record) : "", target: encode(initial) },
      props,
    ),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const [confirming, setConfirming] = useState(false);
  const target =
    targets.find((target) => encode(target) === d.value.target) ?? initial;
  const value = { sourceKey, text: d.value.text, target },
    prepared = editC4Comment(props.model, value);
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (!d.commit("editC4Comment", [value]).diagnostic) close();
  };
  const positions = {
    before: m.radarCommentBefore(),
    inline: m.packetCommentInline(),
    after: m.radarCommentAfter(),
  };
  const data = targets.map((target) => {
    const r = props.model.sourceDocument.records.find(
      (r) => r.sourceKey === target.sourceKey,
    )!;
    return {
      value: encode(target),
      label: `${positions[target.position]} · ${r.callKind ?? r.raw.trim().split(/[\s:]/)[0]} · ${new Intl.NumberFormat(t.language).format(r.range.line)}`,
    };
  });
  return (
    <Stack onKeyDown={(e) => handleC4DraftKeyDown(e, writable, save, close)}>
      <Select
        label={m.architectureEndpointObject()}
        value={d.value.target}
        data={data}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          d.set("target", value);
        }}
      />
      <MyoxusTextInput
        label={m.visualComments()}
        value={d.value.text}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          d.set("text", value);
        }}
      />
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic ?? preview.diagnostic ?? prepared.diagnostic}
        </Alert>
      ) : null}
      <Group>
        {props.previewCommand ? (
          <Button
            disabled={!writable || prepared.status === "invalid"}
            onClick={() => preview.preview("editC4Comment", [value])}
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button
          disabled={!writable || prepared.status === "invalid"}
          onClick={save}
        >
          {t["Apply"]()}
        </Button>
        {sourceKey ? (
          <Button disabled={!writable} onClick={() => setConfirming(true)}>
            {t["Delete"]()}
          </Button>
        ) : null}
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
      <ConfirmModal
        open={confirming && writable}
        onOpenChange={setConfirming}
        title={t["Delete"]()}
        confirmText={t["Apply"]()}
        onConfirm={() => {
          if (sourceKey) {
            preview.clear();
            if (!d.commit("removeC4Comment", [sourceKey, true]).diagnostic)
              close();
          }
        }}
      >
        <Text>{d.value.text}</Text>
      </ConfirmModal>
    </Stack>
  );
}
