// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidRequirementModel } from "./model.js";
import { REQUIREMENT_CSS_ID_LIST } from "./runtime-contract.js";

const ids = (source: string) =>
  [...source.matchAll(/"([^"]+)"|(\w+)/g)].map((match) => match[1] ?? match[2]);

/** Replay the pinned DB's append-only style calls in statement order. Defining
 * a class updates its current users; creating a later default-class node does
 * not retroactively copy that class. Missing style targets stop that list. */
export function applyRequirementOrderedStyles(model: MermaidRequirementModel) {
  type Node =
    (typeof model.requirements)[number] | (typeof model.elements)[number];
  const requirements = new Map<string, Node>(),
    elements = new Map<string, Node>(),
    classes = new Map<string, string[]>();
  const all = () => [...requirements.values(), ...elements.values()];
  const node = (alias: string) =>
    requirements.get(alias) ?? elements.get(alias);
  const assign = (targets: readonly string[], names: readonly string[]) => {
    for (const alias of targets) {
      const target = node(alias);
      if (!target) continue;
      for (const name of names) {
        target.classes!.push(name);
        target.cssStyles!.push(...(classes.get(name) ?? []));
      }
    }
  };
  const document = model.sourceDocument;
  if (!document) return;
  const records = new Map(
    document.records.map((record) => [record.sourceKey, record]),
  );
  for (const record of document.records) {
    if (record.kind === "object-close") {
      const open = record.blockKey ? records.get(record.blockKey) : undefined;
      if (!open?.ownerId) continue;
      const targets = open.namespace === "element" ? elements : requirements;
      if (!targets.has(open.ownerId)) {
        const target = (
          open.namespace === "element" ? model.elements : model.requirements
        ).find((node) => node.sourceKey === open.sourceKey);
        if (target) {
          target.classes = ["default"];
          target.cssStyles = [];
          targets.set(open.ownerId, target);
        }
      }
      if (open.values.classes)
        assign(
          [open.ownerId],
          ids(
            document.source.slice(
              open.values.classes.start,
              open.values.classes.end,
            ),
          ),
        );
    } else if (record.kind === "style-definition") {
      const definition = new RegExp(
        `^\\s*classDef\\s+(${REQUIREMENT_CSS_ID_LIST})\\s+(.+)$`,
        "i",
      ).exec(record.raw);
      if (!definition) continue;
      const declarations = definition[2].split(",");
      for (const name of ids(definition[1])) {
        classes.set(name, [...(classes.get(name) ?? []), ...declarations]);
        for (const target of all())
          if (target.classes!.includes(name))
            target.cssStyles!.push(...declarations);
      }
    } else if (record.kind === "style") {
      const end = record.references.at(-1)?.range.end;
      if (end === undefined) continue;
      const declarations = document.source
        .slice(end, record.range.end)
        .trim()
        .split(",");
      for (const { id } of record.references) {
        const target = node(id);
        if (!target) break;
        target.cssStyles!.push(...declarations);
      }
    } else if (
      record.kind === "style-assignment" ||
      record.kind === "inline-class"
    ) {
      const end = record.references.at(-1)?.range.end;
      if (end === undefined) continue;
      const names =
        record.kind === "inline-class"
          ? record.raw.slice(record.raw.indexOf(":::") + 3)
          : document.source.slice(end, record.range.end);
      assign(
        record.references.map((ref) => ref.id),
        ids(names),
      );
    }
  }
}
