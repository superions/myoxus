// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as m } from "../../../i18n.js";
import type {
  MermaidC4Argument,
  MermaidC4Element,
  MermaidC4Model,
} from "../model.js";
import { c4ResolvedText, c4ResolvedElementShape } from "../resolve.js";
import { C4_CALLS, isC4ElementKind } from "../runtime-contract.js";
import { remapC4ElementArguments } from "../kind-arguments.js";
import { c4CallPatch, insertC4StyleUpdate } from "../record-writer.js";
import { C4WriteError, writeC4Patches } from "../patches.js";
import { c4CommandResult, c4NoChange } from "./model.js";

export type C4ElementFields = {
  kind: string;
  label: string;
  technology: string;
  description: string;
  sprite: string;
  tags: string;
  link: string;
  shape: string;
};
export type C4ElementFieldDraft = Readonly<{
  basis: string;
  selectionId: string;
  values: Readonly<C4ElementFields>;
}>;
export type C4ElementFieldPreparation = {
  draft?: C4ElementFieldDraft;
  model?: MermaidC4Model;
  diagnostic?: string;
  loss: readonly {
    field: string;
    index: number;
    argument: MermaidC4Argument;
  }[];
  argumentImpact: readonly { field: string; from: number; to: number }[];
};
export const C4_ELEMENT_FIELD_KEYS = {
  label: "label",
  technology: "techn",
  description: "descr",
  sprite: "sprite",
  tags: "tags",
  link: "link",
  shape: "shape",
} as const;
export function readC4ElementFields(
  element: MermaidC4Element,
): C4ElementFields {
  return {
    kind: element.kind,
    label: element.label,
    technology: element.technology,
    description: element.description,
    sprite: element.sprite,
    tags: element.tags,
    link: element.link,
    shape: c4ResolvedText(element.resolution!, "shape"),
  };
}
export function c4ElementBody(element: MermaidC4Element) {
  return c4ResolvedElementShape(element);
}

/** Kind/body and receiving-slot impact are computed before confirmation; this writes no store/history. */
export function prepareC4ElementFields(
  model: MermaidC4Model,
  selectionId: string,
  values: Readonly<C4ElementFields>,
): C4ElementFieldPreparation {
  const reject = (): C4ElementFieldPreparation => ({
    diagnostic: m.classPatchRejected(),
    loss: [],
    argumentImpact: [],
  });
  const element = model.elements.find(
    (e) => e.resolution?.selectionId === selectionId,
  );
  if (!element?.resolution || !isC4ElementKind(values.kind)) return reject();
  const declaration = model.sourceDocument.records.find(
    (r) => r.sourceKey === element.resolution!.declarationKey,
  )!;
  let basis = model;
  let loss: C4ElementFieldPreparation["loss"] = [],
    argumentImpact: C4ElementFieldPreparation["argumentImpact"] = [];
  try {
    if (element.kind !== values.kind) {
      const remapped = remapC4ElementArguments(
        element.kind,
        values.kind,
        declaration.arguments!,
      );
      loss = remapped.lost;
      argumentImpact = C4_CALLS[element.kind].slots.flatMap((field, from) => {
        const to = C4_CALLS[values.kind].slots.indexOf(field);
        return declaration.arguments![from] && to !== from
          ? [{ field, from, to }]
          : [];
      });
      const technology = C4_CALLS[values.kind].slots.indexOf("techn");
      if (technology >= 0 && !C4_CALLS[element.kind].slots.includes("techn")) {
        while (remapped.arguments.length <= technology)
          remapped.arguments.push({ key: "", value: "" });
        remapped.arguments[technology] = { key: "", value: element.technology };
      }
      basis = writeC4Patches(model, [
        c4CallPatch(
          model,
          declaration.sourceKey,
          values.kind,
          remapped.arguments,
        ),
      ]).model;
    }
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject();
  }
  // A kind change can replace an earlier provider. Resolve its advanced bindings before field edits.
  const resolved = basis.elements.find(
    (e) => e.resolution?.selectionId === selectionId,
  )!;
  const records = basis.sourceDocument.records;
  const calls = new Map<string, { kind: string; args: MermaidC4Argument[] }>();
  const edit = (key: string) => {
    const existing = calls.get(key);
    if (existing) return existing;
    const record = records.find((r) => r.sourceKey === key);
    if (!record?.arguments || !record.callKind)
      throw new C4WriteError("C4 field provider was lost");
    const call = {
      kind: record.callKind,
      args: record.arguments.map((a) => ({ ...a })),
    };
    calls.set(key, call);
    return call;
  };
  const initial = readC4ElementFields(element);
  const inserted: MermaidC4Argument[] = [];
  try {
    for (const property of Object.keys(
      C4_ELEMENT_FIELD_KEYS,
    ) as (keyof typeof C4_ELEMENT_FIELD_KEYS)[]) {
      if (values[property] === initial[property]) continue;
      const field = C4_ELEMENT_FIELD_KEYS[property],
        provider = resolved.resolution!.providers[field];
      if (
        property === "technology" &&
        !C4_CALLS[values.kind].slots.includes("techn")
      ) {
        // This kind has no Technology slot. Its surviving earlier/update provider is shown in the preview.
        if (values[property] !== "") return reject();
        continue;
      }
      if (
        provider?.argumentIndex === undefined ||
        provider.form === "omitted"
      ) {
        inserted.push({ key: field, value: values[property] });
        continue;
      }
      const call = edit(provider.sourceKey);
      const index = provider.argumentIndex;
      if (index < 0) return reject();
      while (call.args.length <= index) call.args.push({ key: "", value: "" });
      call.args[index] = { ...call.args[index], value: values[property] };
    }
    const patches = [...calls].flatMap(([key, call]) => {
      const record = records.find((r) => r.sourceKey === key)!;
      return record.callKind === call.kind &&
        JSON.stringify(record.arguments) === JSON.stringify(call.args)
        ? []
        : [c4CallPatch(basis, key, call.kind, call.args)];
    });
    let next = patches.length
      ? writeC4Patches(basis, patches)
      : { source: basis.sourceDocument.source, model: basis };
    if (inserted.length)
      next = insertC4StyleUpdate(next.model, "UpdateElementStyle", [
        { key: "", value: element.alias },
        ...inserted,
      ]);
    return {
      draft: {
        basis: model.sourceDocument.source,
        selectionId,
        values: { ...values },
      },
      model: next.model,
      loss,
      argumentImpact,
    };
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return reject();
  }
}
export function editC4ElementFields(
  model: MermaidC4Model,
  draft: C4ElementFieldDraft,
  confirmedLoss = false,
) {
  if (draft.basis !== model.sourceDocument.source)
    return c4NoChange(model, m.chartSourceChanged());
  const prepared = prepareC4ElementFields(
    model,
    draft.selectionId,
    draft.values,
  );
  if (!prepared.model || (prepared.loss.length && !confirmedLoss))
    return c4NoChange(model, prepared.diagnostic ?? m.classPatchRejected());
  return c4CommandResult(
    model,
    { source: prepared.model.sourceDocument.source, model: prepared.model },
    draft.selectionId,
  );
}
/** Local named arguments retain their physical receiving slot and report real effects after reparse. */
function editC4ObjectArgument(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  index: number,
  argument: MermaidC4Argument,
  boundary: boolean,
) {
  const element = (boundary ? model.boundaries : model.elements).find(
      (e) => e.resolution?.selectionId === selectionId,
    ),
    record = model.sourceDocument.records.find(
      (r) => r.sourceKey === sourceKey,
    );
  if (
    !element ||
    !record?.arguments ||
    !record.callKind ||
    !model.occurrences.some(
      (o) => o.sourceKey === sourceKey && o.selectionId === selectionId,
    ) ||
    ![boundary ? "boundary-open" : "element", "element-update"].includes(
      record.kind,
    ) ||
    index < (record.kind === "element" ? 2 : 1) ||
    !Number.isInteger(index) ||
    index >= record.arguments.length
  )
    return c4NoChange(model, m.classPatchRejected());
  const args = record.arguments.map((a) => ({ ...a }));
  if (JSON.stringify(args[index]) === JSON.stringify(argument))
    return c4NoChange(model);
  args[index] = { ...argument };
  try {
    return c4CommandResult(
      model,
      writeC4Patches(model, [
        c4CallPatch(model, sourceKey, record.callKind, args),
      ]),
      selectionId,
    );
  } catch (error) {
    if (!(error instanceof C4WriteError)) throw error;
    return c4NoChange(model, m.classPatchRejected());
  }
}

/** Physical fields share the checked writer; alias identity remains with Rename. */
export function editC4ElementArgument(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  index: number,
  argument: MermaidC4Argument,
) {
  return editC4ObjectArgument(
    model,
    selectionId,
    sourceKey,
    index,
    argument,
    false,
  );
}
export function editC4BoundaryArgument(
  model: MermaidC4Model,
  selectionId: string,
  sourceKey: string,
  index: number,
  argument: MermaidC4Argument,
) {
  return editC4ObjectArgument(
    model,
    selectionId,
    sourceKey,
    index,
    argument,
    true,
  );
}
