export function createMermaidOwnerGfxSemanticStateKey({
  diagramType,
}: {
  readonly diagramType: string;
}) {
  // Element identity already owns structural remounts. Source, layout and
  // visual-model hashes all change during ordinary direct manipulation and
  // must not recreate/refit the nested editor. Only a family change with the
  // same element ids requires a new scoped extension class.
  return diagramType;
}

export function createMermaidOwnerGfxStoreElementKey(
  elementIds: readonly string[],
  stateKey = "",
) {
  const childOrderKey = elementIds.join(",");
  return stateKey ? `${childOrderKey}|${stateKey}` : childOrderKey;
}
