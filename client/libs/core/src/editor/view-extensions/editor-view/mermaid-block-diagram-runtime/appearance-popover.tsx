// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Stack,
  Group,
  Button,
  Select,
  MultiSelect,
  MyoxusTextInput,
  MyoxusText,
  Alert,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  ConfirmModal,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type BlockReactHostProps,
  type MermaidBlockDiagramModel,
} from "@virgultum/block-mermaid";
import { useBlockDraft } from "./drafts";
import { BlockPaddingForm } from "./diagram-settings";
type Statement = MermaidBlockDiagramModel["styleStatements"][number];
export function BlockAppearanceForm({
  props,
  objectId,
}: {
  props: BlockReactHostProps;
  objectId?: string;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Stack>
      {!objectId ? <BlockPaddingForm props={props} /> : null}
      <Accordion>
        {props.model.styleStatements
          .filter(
            (s) =>
              s.kind === "classDef" ||
              !objectId ||
              s.targets.split(/,\s*/).includes(objectId),
          )
          .map((s) => (
            <AccordionItem key={s.sourceKey} value={s.sourceKey}>
              <AccordionControl>
                {s.kind} · {s.targets}
              </AccordionControl>
              <AccordionPanel>
                <BlockStyleForm props={props} statement={s} />
              </AccordionPanel>
            </AccordionItem>
          ))}
      </Accordion>
      {adding ? (
        <BlockStyleForm
          props={props}
          objectId={objectId}
          onClose={() => setAdding(false)}
        />
      ) : (
        <Button disabled={props.readonly} onClick={() => setAdding(true)}>
          {m.visualAppearance()}
        </Button>
      )}
    </Stack>
  );
}
function BlockStyleForm({
  props,
  statement,
  objectId,
  onClose,
}: {
  props: BlockReactHostProps;
  statement?: Statement;
  objectId?: string;
  onClose?: () => void;
}) {
  const t = useI18n(),
    d = useBlockDraft(
      {
        kind: statement?.kind ?? (objectId ? "style" : "classDef"),
        targets: statement?.targets ?? objectId ?? "",
        value: statement?.value ?? "",
      },
      props,
    ),
    [deleting, setDeleting] = useState(false),
    classes = [
      ...new Set(
        props.model.styleStatements
          .filter((s) => s.kind === "classDef")
          .map((s) => s.targets),
      ),
    ],
    v = d.value;
  const save = () => {
    if (
      !d.commit("editBlockMetadata", [{ ...v, key: statement?.sourceKey }])
        .diagnostic
    ) {
      onClose?.();
      // Sibling statement drafts still refer to the pre-commit Source. Finish
      // the owning interaction before projecting the updated appearance.
      props.onParentIntent(null);
      props.onEditIntent(null);
    }
  };
  return (
    <Stack>
      {!statement ? (
        <Select
          label={m.treemapType()}
          value={v.kind}
          disabled={props.readonly}
          data={[
            { value: "classDef", label: m.treemapClassDefinition() },
            { value: "class", label: m.treemapClasses() },
            { value: "style", label: m.quadrantInlineStyle() },
          ]}
          onChange={(kind) => d.set("kind", kind as typeof v.kind)}
        />
      ) : null}
      {v.kind === "classDef" ? (
        <MyoxusTextInput
          label={m.treemapClassName()}
          value={v.targets}
          disabled={props.readonly}
          onChange={(v) => d.set("targets", v)}
        />
      ) : v.kind === "class" ? (
        <MultiSelect
          label={m.architectureEndpointObject()}
          data={[
            ...props.model.nodes,
            ...props.model.groups.filter((g) => g.explicitId),
          ].map((n) => ({ value: n.id, label: String(n.label || n.id) }))}
          value={v.targets.split(/,\s*/).filter(Boolean)}
          disabled={props.readonly}
          onChange={(v) => d.set("targets", v.join(","))}
        />
      ) : (
        <Select
          label={m.architectureEndpointObject()}
          data={[
            ...props.model.nodes,
            ...props.model.groups.filter((g) => g.explicitId),
          ].map((n) => ({ value: n.id, label: String(n.label || n.id) }))}
          value={v.targets}
          disabled={props.readonly}
          onChange={(v) => d.set("targets", v)}
        />
      )}{" "}
      {v.kind === "class" ? (
        <Select
          label={m.treemapClassName()}
          data={[...new Set([...classes, v.value].filter(Boolean))].map(
            (value) => ({ value, label: value }),
          )}
          value={v.value}
          disabled={props.readonly}
          onChange={(v) => d.set("value", v)}
        />
      ) : (
        <MyoxusTextInput
          label={m.property()}
          value={v.value}
          disabled={props.readonly}
          onChange={(v) => d.set("value", v)}
        />
      )}
      <Group>
        <Button
          disabled={props.readonly || !v.targets || !v.value}
          onClick={save}
        >
          {t["Save"]()}
        </Button>
        {onClose ? <Button onClick={onClose}>{m.cancel()}</Button> : null}
        {statement ? (
          <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
            {m.visualDelete()}
          </Button>
        ) : null}
      </Group>
      {d.diagnostic ? (
        <Alert color="myoxusError" role="alert">
          {d.diagnostic}
        </Alert>
      ) : null}
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (
            !d.commit("editBlockMetadata", [
              { ...v, key: statement?.sourceKey, delete: true },
            ]).diagnostic
          ) {
            setDeleting(false);
            onClose?.();
            props.onParentIntent(null);
            props.onEditIntent(null);
          }
        }}
      >
        <Stack>
          <MyoxusText>
            {statement?.targets} · {statement?.value}
          </MyoxusText>
          {v.kind === "classDef"
            ? props.model.styleStatements
                .filter((s) => s.kind === "class" && s.value === v.targets)
                .map((s) => (
                  <MyoxusText key={s.sourceKey}>{s.targets}</MyoxusText>
                ))
            : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
