// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  MyoxusTextInput,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  prepareC4AliasRename,
  type C4ReactHostProps,
} from "@virgultum/block-mermaid";
import {
  handleC4DraftKeyDown,
  isolateC4PortalledMouseDown,
  handleC4PopoverKeyDown,
  useC4Draft,
  useC4CommandPreview,
} from "./drafts";

/** The selected-record variant explicitly splits a declaration instead of partially renaming a group. */
export function C4AliasControl({
  props,
  selectionId,
  recordKey,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  recordKey?: string;
}) {
  const [opened, setOpened] = useState(false);
  const owner = [...props.model.elements, ...props.model.boundaries].find(
    (e) => e.resolution?.selectionId === selectionId,
  );
  return owner ? (
    <Popover
      closeOnEscape={false}
      fitViewport
      trapFocus
      opened={opened}
      onChange={setOpened}
    >
      <PopoverTarget>
        <Button onClick={() => setOpened(true)}>
          {m.erAlias()}: {owner.alias}
        </Button>
      </PopoverTarget>
      <PopoverContent
        data-myoxus-editor-keyboard-owner="c4"
        onMouseDown={isolateC4PortalledMouseDown}
        onKeyDown={(event) =>
          handleC4PopoverKeyDown(event, () => setOpened(false))
        }
      >
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <C4AliasForm
              key={`${selectionId}:${recordKey ?? "group"}`}
              props={props}
              selectionId={selectionId}
              recordKey={recordKey}
              alias={owner.alias}
              onClose={() => {
                setOpened(false);
                props.resolveReturnFocusTarget()?.focus();
              }}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  ) : null;
}
function C4AliasForm({
  props,
  selectionId,
  recordKey,
  alias,
  onClose,
}: {
  props: C4ReactHostProps;
  selectionId: string;
  recordKey?: string;
  alias: string;
  onClose: () => void;
}) {
  const t = useI18n(),
    d = useC4Draft({ alias }, props),
    preview = useC4CommandPreview(props),
    writable = !props.readonly && !props.displayOnly;
  const prepared = prepareC4AliasRename(
    props.model,
    selectionId,
    d.value.alias,
    recordKey,
  );
  const close = () => {
    preview.clear();
    onClose();
  };
  const save = () => {
    preview.clear();
    if (!prepared.draft) return;
    const result = d.commit("renameC4Alias", [prepared.draft, true]);
    if (!result.diagnostic) close();
  };
  const objects = prepared.model
    ? [...prepared.model.elements, ...prepared.model.boundaries].filter(
        (e) => e.alias === alias || e.alias === d.value.alias,
      )
    : [];
  return (
    <Stack
      onKeyDown={(event) => handleC4DraftKeyDown(event, writable, save, close)}
    >
      <Text>
        {t[
          recordKey
            ? "com.myoxus.editor.mermaid.c4-alias-record-impact"
            : "com.myoxus.editor.mermaid.c4-alias-group-impact"
        ]()}
      </Text>
      <MyoxusTextInput
        autoFocus
        data-autofocus
        label={m.erAlias()}
        value={d.value.alias}
        disabled={!writable}
        onChange={(value) => {
          preview.clear();
          d.set("alias", value);
        }}
      />
      {prepared.diagnostic || d.diagnostic || preview.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {prepared.diagnostic ?? d.diagnostic ?? preview.diagnostic}
        </Alert>
      ) : null}
      {prepared.draft ? (
        <Stack>
          {recordKey &&
          d.value.alias !== alias &&
          !prepared.draft.remainingKeys.length &&
          prepared.draft.retainedReferences.length ? (
            <Alert color="myoxusWarning">
              {t["com.myoxus.editor.mermaid.c4-alias-orphan-references"]()}
            </Alert>
          ) : null}
          {prepared.draft.impact.map((impact) => (
            <Stack key={impact.sourceKey}>
              <Text>
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: impact.call,
                  line: new Intl.NumberFormat(t.language).format(impact.line),
                })}
              </Text>
              <Text>
                {impact.fields.join(", ")}: {alias} → {d.value.alias}
              </Text>
              <Text>
                {t["com.myoxus.editor.mermaid.c4-record-effects"]({
                  fields: impact.effectiveFields.join(", "),
                })}
              </Text>
            </Stack>
          ))}
          {prepared.draft.retainedReferences.map((impact) => (
            <Stack key={impact.sourceKey}>
              <Text>
                {t["com.myoxus.editor.mermaid.c4-record-position"]({
                  call: impact.call,
                  line: new Intl.NumberFormat(t.language).format(impact.line),
                })}
              </Text>
              <Text>
                {impact.fields.join(", ")}: {alias} → {alias}
              </Text>
            </Stack>
          ))}
          {objects.map((object) => (
            <Stack key={object.resolution!.selectionId}>
              <Text>
                {object.alias} · {object.kind} · {object.label}
              </Text>
              <Text>
                {m.chartParent()}:{" "}
                {"boundaryId" in object
                  ? object.boundaryId || m.chartRoot()
                  : object.parentId || m.chartRoot()}
              </Text>
              <Text>
                {t["com.myoxus.editor.mermaid.c4-records"]({
                  count: new Intl.NumberFormat(t.language).format(
                    object.resolution!.sourceKeys.length,
                  ),
                })}
              </Text>
            </Stack>
          ))}
        </Stack>
      ) : null}
      <Group>
        {props.previewCommand && prepared.draft ? (
          <Button
            disabled={!writable}
            onClick={() =>
              preview.preview("renameC4Alias", [prepared.draft!, true])
            }
          >
            {m.sequencePreview()}
          </Button>
        ) : null}
        <Button disabled={!writable || !prepared.draft} onClick={save}>
          {t["Apply"]()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
