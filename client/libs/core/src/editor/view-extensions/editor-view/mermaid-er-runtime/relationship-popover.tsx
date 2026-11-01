// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmModal,
  Group,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  createErCardinalityPreviewMarker,
  type ErReactHostProps,
  type MermaidErRelationship,
  type ErCardinality,
} from "@virgultum/block-mermaid";
import { changedErFields, handleErDraftKeyDown, useErDraft } from "./drafts";
const cardinalities: { value: ErCardinality; label: () => string }[] = [
  { value: "exactly-one", label: m.erExactlyOne },
  { value: "zero-or-one", label: m.erZeroOrOne },
  { value: "one-or-many", label: m.erOneOrMany },
  { value: "zero-or-many", label: m.erZeroOrMany },
  { value: "mermaid-parent", label: m.erParentBadge },
];
/** This is the connector's own marker primitive, not a second ER renderer. */
function ErMarkerPreview({
  cardinality,
  start,
}: {
  cardinality: ErCardinality;
  start: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null),
    id = useId().replaceAll(":", "");
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const marker = createErCardinalityPreviewMarker(id, cardinality, start);
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.append(marker);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", "M 18 20 L 90 20");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    line.setAttribute(start ? "marker-start" : "marker-end", `url(#${id})`);
    svg.replaceChildren(defs, line);
  }, [cardinality, start, id]);
  return cardinality === "mermaid-parent" ? (
    <Badge>{m.erParentBadge()}</Badge>
  ) : (
    <svg
      ref={ref}
      viewBox="0 0 108 40"
      width="108"
      height="40"
      role="img"
      aria-label={cardinalities.find((c) => c.value === cardinality)!.label()}
    />
  );
}
export function ErRelationshipForm({
  props,
  relation,
  onClose,
}: {
  props: ErReactHostProps;
  relation?: MermaidErRelationship;
  onClose: () => void;
}) {
  const t = useI18n(),
    ends = [...props.model.entities, ...props.model.subgraphs],
    initial = {
      from:
        relation?.from ??
        ends.find((n) => n.sourceKey === props.selectedKeys[0])?.id ??
        ends[0]?.id ??
        "",
      to:
        relation?.to ??
        ends.find((n) => n.sourceKey === props.selectedKeys[1])?.id ??
        ends[1]?.id ??
        ends[0]?.id ??
        "",
      cardinalityA: relation?.cardinalityA ?? ("exactly-one" as ErCardinality),
      cardinalityB: relation?.cardinalityB ?? ("zero-or-many" as ErCardinality),
      identification: relation?.identification ?? ("--" as "--" | ".."),
      label: relation?.label ?? "",
    },
    d = useErDraft(initial, props),
    v = d.value;
  const [deleting, setDeleting] = useState(false);
  const save = () => {
    const r = relation
      ? d.commit("editErRelationship", [
          relation.sourceKey,
          changedErFields(initial, v),
        ])
      : d.commit("addErRelationship", [v]);
    if (!r.diagnostic) onClose();
  };
  return (
    <Stack
      onKeyDown={(event) =>
        handleErDraftKeyDown(event, props.readonly, save, onClose)
      }
    >
      <Select
        autoFocus
        label={m.classFirstEnd()}
        data={ends.map((n) => ({ value: n.id, label: `${n.label} · ${n.id}` }))}
        value={v.from}
        disabled={props.readonly}
        onChange={(value) => d.set("from", value)}
      />
      <Group>
        <Select
          label={`${m.classFirstEnd()} · ${m.classCardinality()}`}
          data={cardinalities.map((c) => ({
            value: c.value,
            label: c.label(),
          }))}
          value={v.cardinalityA}
          disabled={props.readonly}
          onChange={(value) => d.set("cardinalityA", value as ErCardinality)}
        />
        <ErMarkerPreview cardinality={v.cardinalityA} start />
      </Group>
      <Select
        label={m.classSecondEnd()}
        data={ends.map((n) => ({ value: n.id, label: `${n.label} · ${n.id}` }))}
        value={v.to}
        disabled={props.readonly}
        onChange={(value) => d.set("to", value)}
      />
      <Group>
        <Select
          label={`${m.classSecondEnd()} · ${m.classCardinality()}`}
          data={cardinalities.map((c) => ({
            value: c.value,
            label: c.label(),
          }))}
          value={v.cardinalityB}
          disabled={props.readonly}
          onChange={(value) => d.set("cardinalityB", value as ErCardinality)}
        />
        <ErMarkerPreview cardinality={v.cardinalityB} start={false} />
      </Group>
      <Checkbox
        label={m.erIdentifying()}
        checked={v.identification === "--"}
        disabled={props.readonly}
        onChange={(event) =>
          d.set("identification", event.currentTarget.checked ? "--" : "..")
        }
      />
      <MyoxusTextInput
        label={m.timelineLabel()}
        value={v.label}
        disabled={props.readonly}
        onChange={(value) => d.set("label", value)}
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
        {relation ? (
          <>
            <Button
              disabled={props.readonly}
              onClick={() => {
                const r = d.commit("reverseErRelationship", [
                  relation.sourceKey,
                ]);
                if (!r.diagnostic) onClose();
              }}
            >
              {m.erReverse()}
            </Button>
            <Button disabled={props.readonly} onClick={() => setDeleting(true)}>
              {m.visualDelete()}
            </Button>
          </>
        ) : null}
      </Group>
      <ConfirmModal
        open={deleting}
        onOpenChange={setDeleting}
        title={m.visualDelete()}
        confirmText={m.visualDelete()}
        onConfirm={() => {
          if (!relation) return;
          const r = d.commit("deleteErRelationship", [relation.sourceKey]);
          if (!r.diagnostic) {
            setDeleting(false);
            onClose();
          }
        }}
      >
        <Stack>
          {relation
            ? props
                .getImpact({ kind: "relation", key: relation.sourceKey })
                .records.map((r) => (
                  <MyoxusText key={r.id}>{r.label}</MyoxusText>
                ))
            : null}
        </Stack>
      </ConfirmModal>
    </Stack>
  );
}
