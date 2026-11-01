// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";

type Reference = { __$$text: string };
type Choice = { value: string; label: string };

function referenceKey(
  reference: Reference,
  ordinal: number,
  namespace: string | undefined,
) {
  return `reference:${JSON.stringify([ordinal, reference.__$$text, namespace ?? ""])}`;
}

/** UI-only list intent, never XML identities. Retain a separate scope-qualified
 * slot for every existing node, including duplicate lexical or resolved names.
 * A namespace shadow must not collapse two imported references into one choice. */
export function qnameListChoices(
  definitions: BPMN20__tDefinitions,
  previous: readonly Reference[],
  targets: readonly Choice[],
) {
  const index = previous.length ? indexBpmnIds(definitions) : undefined;
  const byId = new Map(targets.map((target) => [target.value, target]));
  const rows = previous.map((reference, ordinal) => {
    const id = index!.resolveReference(reference, reference.__$$text);
    const { namespace } = index!.expandQName(reference, reference.__$$text);
    return {
      value: referenceKey(reference, ordinal, namespace),
      id,
      namespace,
      text: reference.__$$text,
      label: id
        ? (byId.get(id)?.label ?? reference.__$$text)
        : reference.__$$text,
    };
  });
  const selectedIds = new Set(rows.map((row) => row.id));
  const labels = new Map<string, number>();
  for (const entry of [
    ...rows,
    ...targets.filter((target) => !selectedIds.has(target.value)),
  ])
    labels.set(entry.label, (labels.get(entry.label) ?? 0) + 1);
  const scopes = new Map<string, Set<string | undefined>>();
  for (const row of rows) {
    const namespaces = scopes.get(row.text) ?? new Set();
    namespaces.add(row.namespace);
    scopes.set(row.text, namespaces);
  }
  const rowOptions = new Map<string, Choice[]>();
  const external: Choice[] = [];
  for (const row of rows) {
    let label = row.label;
    if ((labels.get(label) ?? 0) > 1) {
      if (label !== row.text) label += ` (${row.text})`;
      if ((scopes.get(row.text)?.size ?? 0) > 1)
        label += ` (${row.namespace ?? ""})`;
    }
    const option = { value: row.value, label };
    if (row.id && byId.has(row.id)) {
      const group = rowOptions.get(row.id) ?? [];
      group.push(option);
      rowOptions.set(row.id, group);
    } else external.push(option);
  }
  const options = targets.flatMap(
    (target) =>
      rowOptions.get(target.value) ?? [
        {
          value: `internal:${target.value}`,
          label:
            (labels.get(target.label) ?? 0) > 1
              ? `${target.label} (${target.value})`
              : target.label,
        },
      ],
  );
  return {
    options: [...options, ...external],
    selected: rows.map((row) => row.value),
  };
}

/** Concrete field owners supply eligible target IDs. Preflight all selected
 * intents before referenceFor can add bindings; retained slots return the exact
 * live node, not another node with the same QName text or resolved ID. */
export function resolveQNameList({
  definitions,
  owner,
  previous,
  selected,
  targets,
  invalid = "BPMN_INVALID_CONNECTION",
}: {
  definitions: BPMN20__tDefinitions;
  owner: object;
  previous: readonly Reference[];
  selected: readonly string[];
  targets: ReadonlySet<string>;
  invalid?: "BPMN_INVALID_CONNECTION" | "BPMN_INVALID_CALLED_INTERFACE";
}): Reference[] {
  if (!selected.length) return [];
  const index = indexBpmnIds(definitions);
  const retained = new Map<
    string,
    { reference: Reference; id: string | undefined }
  >();
  previous.forEach((reference, ordinal) => {
    const { namespace } = index.expandQName(reference, reference.__$$text),
      id = index.resolveReference(reference, reference.__$$text);
    retained.set(referenceKey(reference, ordinal, namespace), {
      reference,
      id,
    });
  });
  const checked = selected.map((value) => {
    const existing = retained.get(value);
    if (existing) {
      if (existing.id && !targets.has(existing.id)) throw new Error(invalid);
      return { reference: existing.reference };
    }
    if (!value.startsWith("internal:")) throw new Error(invalid);
    const id = value.slice("internal:".length);
    if (!id || !targets.has(id)) throw new Error(invalid);
    return { id };
  });
  return checked.map(
    (target) =>
      target.reference ?? { __$$text: index.referenceFor(owner, target.id)! },
  );
}
