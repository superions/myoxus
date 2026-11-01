// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Stack,
  Group,
  NumberInput,
  MyoxusTextInput,
  Alert,
  ConfirmModal,
  MyoxusText,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  isBlockPadding,
  type BlockReactHostProps,
} from "@virgultum/block-mermaid";
import {
  useBlockDraft,
  useBlockCommandPreview,
  handleBlockDraftKeyDown,
} from "./drafts";
export function BlockPaddingForm({ props }: { props: BlockReactHostProps }) {
  const t = useI18n(),
    d = useBlockDraft({ padding: props.config.padding }, props),
    preview = useBlockCommandPreview(props),
    [confirm, setConfirm] = useState(false);
  return (
    <Stack>
      <NumberInput
        label={m.architecturePadding()}
        value={d.value.padding}
        min={0}
        clampBehavior="none"
        disabled={props.readonly}
        onChange={(v) => d.set("padding", typeof v === "number" ? v : NaN)}
      />
      <Group>
        <Button
          disabled={props.readonly || !isBlockPadding(d.value.padding)}
          onClick={() => {
            preview.preview("setBlockPadding", [d.value.padding]);
            setConfirm(true);
          }}
        >
          {t["Save"]()}
        </Button>
        <Button
          disabled={props.readonly}
          onClick={() => preview.preview("setBlockPadding", [d.value.padding])}
        >
          {m.sequencePreview()}
        </Button>
      </Group>
      <Button onClick={() => preview.clear()}>{m.cancel()}</Button>
      <ConfirmModal
        open={confirm}
        onOpenChange={(v) => {
          setConfirm(v);
          if (!v) preview.clear();
        }}
        title={m.architecturePadding()}
        confirmText={t["Save"]()}
        onConfirm={() => {
          preview.clear();
          if (!d.commit("setBlockPadding", [d.value.padding]).diagnostic) {
            setConfirm(false);
            props.onParentIntent(null);
          }
        }}
      >
        <Stack>
          <MyoxusText>{m.blockGridHelp()}</MyoxusText>
          {[
            m.chartRoot(),
            ...props.model.groups.map(
              (g) => g.label || (g.explicitId ? g.id : m.blockGroup()),
            ),
          ].map((label, index) => (
            <MyoxusText key={index}>{label}</MyoxusText>
          ))}
        </Stack>
      </ConfirmModal>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
    </Stack>
  );
}
export function BlockDiagramTitleForm({
  props,
  onClose,
}: {
  props: BlockReactHostProps;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useBlockDraft({ title: props.visualModel.diagramTitle ?? "" }, props),
    save = () => {
      if (!d.commit("editBlockDiagramTitle", [d.value.title]).diagnostic)
        onClose();
    };
  return (
    <Stack
      onKeyDown={(e) =>
        handleBlockDraftKeyDown(e, props.readonly, save, onClose)
      }
    >
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.titlePlaceholder()}
        value={d.value.title}
        disabled={props.readonly}
        onChange={(v) => d.set("title", v)}
      />
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <Group>
        <Button disabled={props.readonly} onClick={save}>
          {t["Save"]()}
        </Button>
        <Button onClick={onClose}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
