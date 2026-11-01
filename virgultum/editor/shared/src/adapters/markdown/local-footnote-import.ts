// SPDX-License-Identifier: AGPL-3.0-or-later
import { FootNoteSchema, footnotePlacement } from "@virgultum/model";
import {
  Text,
  fromJSON,
  type BlockSnapshot,
  type SliceSnapshot,
  type Store,
  type Transformer,
} from "@virgultum/store";
import { citationDefinition, normalizeFootnoteLabel } from "./footnotes.js";

/** Fresh definition IDs are already final before a paste can merge its first paragraph. */
export const LOCAL_FOOTNOTE_IMPORTED_IDS = "localFootnoteImportedIds";

function liveLabelOwners(doc: Store) {
  const owners = new Map<string, Set<string | undefined>>();
  const claim = (label: string, id?: string) => {
    const normalized = normalizeFootnoteLabel(label);
    const existing = owners.get(normalized) ?? new Set<string | undefined>();
    existing.add(id);
    owners.set(normalized, existing);
  };
  const inspect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    const record = value as Record<string, unknown>;
    const footnote = (
      record.attributes as
        { footnote?: { label?: unknown; definitionId?: string } } | undefined
    )?.footnote;
    if (typeof footnote?.label === "string")
      claim(footnote.label, footnote.definitionId);
    Object.values(record).forEach(inspect);
  };
  const visit = (model: NonNullable<Store["root"]>) => {
    const props = model.props as Record<string, unknown>;
    if (model.flavour === "myoxus:footnote-definition")
      claim(String(props.label), model.id);
    if (typeof props.footnoteIdentifier === "string")
      claim(props.footnoteIdentifier);
    const texts = [
      model.text,
      props.title,
      ...Object.values(
        (props.cells ?? {}) as Record<string, { text?: Text }>,
      ).map((cell) => cell.text),
    ];
    for (const text of texts) if (text instanceof Text) inspect(text.toDelta());
    model.children.forEach(visit);
  };
  if (doc.root) visit(doc.root);
  return owners;
}

export function prepareLocalFootnoteImport(
  snapshot: SliceSnapshot,
  doc: Store,
  job: Transformer,
) {
  job.adapterConfigs.delete(LOCAL_FOOTNOTE_IMPORTED_IDS);
  const definitions = new Map<string, BlockSnapshot>();
  const labels = new Set<string>();
  const markers: { label: string; definitionId: string }[] = [];
  const citations = new Set<string>();
  const nodeIds = new Set<string>();
  let duplicateId = false;
  const inspectValue = (value: unknown, insideDefinition: boolean) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) inspectValue(child, insideDefinition);
      return;
    }
    const record = value as Record<string, unknown>;
    const raw = (record.attributes as { footnote?: unknown } | undefined)
      ?.footnote;
    if (raw !== undefined && raw !== null) {
      const parsed = FootNoteSchema.safeParse(raw);
      if (!parsed.success) {
        const label = (raw as { label?: unknown })?.label;
        throw new Error(
          `Invalid native footnote metadata: ${typeof label === "string" ? label : ""}`,
        );
      }
      if (insideDefinition)
        throw new Error(`Nested footnote reference: ${parsed.data.label}`);
      if (parsed.data.definitionId !== undefined)
        markers.push(raw as { label: string; definitionId: string });
      else {
        citationDefinition({
          type: "footnoteDefinition",
          identifier: parsed.data.label,
          label: parsed.data.label,
          children: [
            {
              type: "paragraph",
              children: [
                { type: "text", value: JSON.stringify(parsed.data.reference) },
              ],
            },
          ],
        });
        citations.add(normalizeFootnoteLabel(parsed.data.label));
      }
    }
    for (const child of Object.values(record))
      inspectValue(child, insideDefinition);
  };
  const inspect = (
    node: BlockSnapshot,
    insideDefinition = false,
    parent?: BlockSnapshot,
  ) => {
    duplicateId ||= nodeIds.has(node.id);
    nodeIds.add(node.id);
    const definition = node.flavour === "myoxus:footnote-definition";
    if (definition) {
      if (!footnotePlacement(node.props.placement))
        throw new Error("Invalid native footnote placement");
      const label =
        typeof node.props.label === "string" ? node.props.label : "";
      const normalized = normalizeFootnoteLabel(label);
      if (
        !normalized ||
        labels.has(normalized) ||
        definitions.has(node.id) ||
        insideDefinition ||
        (parent && parent.flavour !== "myoxus:note")
      )
        throw new Error(`Conflicting footnote definition: ${label}`);
      definitions.set(node.id, node);
      labels.add(normalized);
    }
    insideDefinition ||= definition;
    if (insideDefinition) {
      // Reuse the registered normal child constraints before any live insertion.
      doc.schema.validate(
        node.flavour,
        definition ? "myoxus:note" : parent?.flavour,
        node.children.map((child) => child.flavour),
      );
    }
    inspectValue(node.props, insideDefinition);
    for (const child of node.children) inspect(child, insideDefinition, node);
  };
  for (const node of snapshot.content) inspect(node);
  for (const marker of markers) {
    const definition = definitions.get(marker.definitionId);
    if (
      !definition ||
      normalizeFootnoteLabel(String(definition.props.label)) !==
        normalizeFootnoteLabel(marker.label)
    )
      throw new Error(`Unresolved footnote definition: ${marker.label}`);
  }
  if (!definitions.size) return;
  if (duplicateId) throw new Error("Conflicting local footnote block identity");
  // Deserialize with the normal pure text/boxed codec before selection changes
  // or asset materialization. Image transformers themselves can write blobs.
  const validateProps = (node: BlockSnapshot) => {
    fromJSON(node.props);
    node.children.forEach(validateProps);
  };
  snapshot.content.forEach(validateProps);
  for (const label of labels)
    if (citations.has(label))
      throw new Error(`Conflicting footnote definition: ${label}`);

  const occupied = new Set([...citations, ...liveLabelOwners(doc).keys()]);

  const importedIds: string[] = [];
  const replacements = new Map<
    string,
    { definitionId: string; label: string }
  >();
  for (const [original, definition] of definitions) {
    const sourceLabel = String(definition.props.label);
    let label = sourceLabel;
    let suffix = 2;
    while (
      occupied.has(normalizeFootnoteLabel(label)) ||
      (label !== sourceLabel && labels.has(normalizeFootnoteLabel(label)))
    )
      label = `${sourceLabel}-${suffix++}`;
    occupied.add(normalizeFootnoteLabel(label));
    const id = doc.workspace.idGenerator();
    if (nodeIds.has(id) || doc.hasBlock(id) || importedIds.includes(id))
      throw new Error("Footnote block identity allocation collided");
    definition.id = id;
    definition.props.label = label;
    importedIds.push(id);
    replacements.set(original, { definitionId: id, label });
  }
  for (const marker of markers)
    Object.assign(marker, replacements.get(marker.definitionId));
  job.adapterConfigs.set(
    LOCAL_FOOTNOTE_IMPORTED_IDS,
    JSON.stringify(importedIds),
  );
  // Preparation and ordinary insertion can yield. A competing local label
  // must be diagnosed rather than publishing an ambiguous parent document.
  return () => {
    const current = liveLabelOwners(doc);
    for (const definition of definitions.values())
      if (
        [
          ...(current.get(
            normalizeFootnoteLabel(String(definition.props.label)),
          ) ?? []),
        ].some((id) => id !== definition.id)
      )
        throw new Error(
          `Footnote label changed before insertion: ${definition.props.label}`,
        );
  };
}
