import { mermaidC4Family } from "../families/c4/family.js";
import { c4ContentRegion } from "../families/c4/content-projection.js";
import { c4ProjectionSelectionId } from "../families/c4/gfx-data.js";
import { c4NodeGfxData } from "../families/c4/object-data.js";
import {
  generateMermaidSourceFromGfxVisualModel,
  parseMermaidSourceToGfxVisualModel,
} from "../mermaid-gfx-graph-adapters.js";
import {
  prepareC4Grouping,
  groupC4Elements,
  prepareC4BatchDelete,
  deleteC4Selection,
} from "../engine/c4/index.js";
import { c4ActionCatalog } from "../families/c4/action-catalog.js";
import { changeC4Header, C4_HEADERS } from "../engine/c4/index.js";

import { mermaidGfxCommittedSource } from "../mermaid-gfx-graph-adapters.js";
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";
import * as gfxText from "@virgultum/gfx-text";
import { readTypeOwnedMermaidSourceProjection } from "../families/runtime/gfx-owner-hooks.js";
import { c4ModelToGfxVisualModel } from "../families/c4/visual-model.js";
import { readC4ProjectionModel } from "../families/c4/gfx-data.js";
import {
  ConnectorMode,
  toMermaidShapeElementProps,
  toMermaidSubgraphElementProps,
  installProjectedMermaidTestTheme,
  toMermaidConnectorElementProps,
  createMermaidVisualModelFromGfxElements,
  getMermaidVisualFrameGeometry,
} from "./mermaid-test-support.js";
import { Bound } from "@virgultum/global/gfx";

import { projectC4RelationshipElement } from "../families/c4/relationship-projection.js";
import { c4BoundaryPresentation } from "../families/c4/gfx-data.js";
import {
  setC4BoundaryCollapsed,
  projectC4BoundaryElement,
  c4BoundaryHiddenBy,
  c4BoundaryHeaderHeight,
} from "../families/c4/boundary-projection.js";
import { layoutC4Diagram } from "../families/c4/layout.js";
import {
  typeOwnedMermaidNodeElementProjection,
  typeOwnedMermaidEdgeElementProjection,
} from "../families/runtime/gfx-owner-hooks.js";
import { c4BoundaryGfxData } from "../families/c4/object-data.js";

import {
  prepareC4Delete,
  deleteC4,
  readC4RelationshipAppearance,
  prepareC4RecordReconnect,
  reconnectC4Record,
  removeC4RelationshipStyleRecord,
  confirmC4RecordMove,
  createC4Element,
  editC4ElementLabel,
  editC4ElementRecordLabel,
  c4ElementKindCatalog,
  c4ElementDeclarations,
  readC4ElementFields,
  prepareC4ElementFields,
  editC4ElementFields,
  editC4ElementArgument,
  editC4ElementAppearance,
  editC4ElementStyleArgument,
  removeC4ElementStyleRecord,
  c4ElementStyleRecords,
  c4ElementStyleArgumentEffect,
  createC4Boundary,
  readC4BoundaryFields,
  editC4BoundaryFields,
  isC4Alias,
  prepareC4AliasRename,
  renameC4Alias,
  editC4RelationshipRecord,
  prepareC4RecordMove,
  createC4Relationship,
  prepareC4DynamicOrder,
  reorderC4DynamicPair,
  prepareC4Reconnect,
  reconnectC4Relationship,
  prepareC4RelationshipNotation,
  changeC4RelationshipNotation,
  removeC4RelationshipRecord,
  generateMermaidC4SourceWithBindings,
  insertC4Record,
  writeC4Patches,
  writeC4SourcePatches,
  c4CallPatch,
  c4RecordDeletionPatches,
  parseMermaidC4Source,
  parseMermaidC4SourceWithDiagnostics,
} from "../engine/c4/index.js";
import { applyC4GfxVisualToSource } from "../families/c4/source-application.js";

import {
  createC4CommandConsumer,
  type C4CommandPort,
} from "../families/c4/command-port.js";
import { mermaidC4HostAdapter } from "../families/c4/host-adapter.js";
import { mermaidC4Runtime } from "../families/c4/runtime.js";

import {
  C4_BOUNDARY_KINDS,
  C4_RELATIONSHIP_KINDS,
} from "../engine/c4/runtime-contract.js";
import { c4ResolvedElementShape } from "../engine/c4/resolve.js";

import { projectC4ContentElement } from "../families/c4/content-projection.js";

test("creates every real C4 boundary kind in an explicit physical scope without placeholder children and edits its actual fields", () => {
  const source =
    'C4Deployment\r\nSystem_Boundary(team, "Team", $tags="KEEP") {\r\n  %% child anchor\r\n  Person(user, "User")\r\n}\r\n';
  const model = parseMermaidC4Source(source)!,
    parentKey = model.boundaries[0].resolution!.declarationKey;
  const beforeKey = model.elements[0].resolution!.declarationKey;
  for (const kind of C4_BOUNDARY_KINDS) {
    const created = createC4Boundary(model, {
      kind,
      label: kind,
      target: { parentKey, beforeKey },
    });
    expect(created.status).toBe("changed");
    expect(created.model.elements.map((e) => e.alias)).toEqual(["user"]);
    const boundary = created.model.boundaries.find(
      (b) => b.resolution!.selectionId === created.selection,
    )!;
    expect(boundary.parentId).toBe("team");
    expect(created.source).toContain(
      '  %% child anchor\r\n  Person(user, "User")',
    );
    expect(
      created.model.sourceDocument.records.find(
        (r) => r.sourceKey === boundary.resolution!.declarationKey,
      )!.scopeKeys,
    ).toEqual([parentKey]);
    const fields = readC4BoundaryFields(created.model, created.selection!);
    expect(Object.keys(fields)).not.toContain("sprite");
    expect(Object.hasOwn(fields, "type")).toBe(
      kind === "Boundary" ||
        kind.startsWith("Node") ||
        kind === "Deployment_Node",
    );
    const edited = editC4BoundaryFields(created.model, created.selection!, {
      label: "Runtime",
      ...(Object.hasOwn(fields, "descr") ? { descr: "Services" } : {}),
      tags: "LOCAL",
      link: "https://myoxus.test/runtime",
    });
    expect(edited.status).toBe("changed");
    if (Object.hasOwn(fields, "descr")) {
      const changedBoundary = edited.model.boundaries.find(
        (b) => b.resolution!.selectionId === created.selection,
      )!;
      expect(changedBoundary.description).toBe("Services");
      expect(changedBoundary.boundaryType).toBe(boundary.boundaryType);
    }
    expect(
      edited.model.boundaries.find(
        (b) => b.resolution!.selectionId === created.selection,
      )!.label,
    ).toBe("Runtime");
    expect(edited.source).toContain('$tags="KEEP"');
    expect(edited.source).toContain(
      '  %% child anchor\r\n  Person(user, "User")',
    );
    expect(
      editC4BoundaryFields(
        edited.model,
        created.selection!,
        readC4BoundaryFields(edited.model, created.selection!),
      ).source,
    ).toBe(edited.source);
    const ignoredSlot = { label: "Ignored", sprite: "person" };
    expect(
      editC4BoundaryFields(edited.model, created.selection!, ignoredSlot)
        .status,
    ).toBe("invalid");
  }
  expect(
    createC4Boundary(model, {
      kind: "Node",
      label: "X",
      alias: "team",
      target: { parentKey },
    }).status,
  ).toBe("invalid");
  expect(
    createC4Boundary(model, {
      kind: "Node",
      label: "X",
      target: { parentKey: "missing" },
    }).source,
  ).toBe(source);
  const empty = createC4Boundary(parseMermaidC4Source("C4Deployment")!, {
    kind: "Deployment_Node",
    label: "Runtime",
    target: { parentKey: null },
  }).model;
  const emptyVisual = c4ModelToGfxVisualModel({
    ...empty,
    ...layoutC4Diagram(empty),
  });
  expect(emptyVisual.nodes).toHaveLength(0);
  emptyVisual.subgraphs![0].x = 500;
  emptyVisual.subgraphs![0].y = 400;
  const frame = getMermaidVisualFrameGeometry(emptyVisual).bound,
    boundary = emptyVisual.subgraphs![0];
  expect(frame.x + frame.w).toBeGreaterThanOrEqual(boundary.x + boundary.width);
  expect(frame.y + frame.h).toBeGreaterThanOrEqual(
    boundary.y + boundary.height,
  );
});

test("C4 collapse retains materialized children and real endpoints through readback, Source edits and expand", () => {
  installProjectedMermaidTestTheme();
  const source =
    'C4Container\nBoundary(team, "Team", "TEAM") {\n  Node(runtime, "Runtime", "Linux") {\n    Container(api, "API", "Rust")\n    Container(db, "DB", "SQL")\n  }\n}\nPerson(user, "User")\nRel(user, api, "Uses")\nRel(api, db, "Reads")';
  const parsed = parseMermaidC4Source(source)!;
  const visual = c4ModelToGfxVisualModel({
    ...parsed,
    ...layoutC4Diagram(parsed),
  });
  const team = visual.subgraphs!.find((g) => g.title === "Team")!,
    runtime = visual.subgraphs!.find((g) => g.title === "Runtime")!;
  const collapsed = setC4BoundaryCollapsed(visual, team.id, true)!;
  expect(collapsed.nodes).toEqual(visual.nodes);
  expect(collapsed.subgraphs!.map((g) => [g.id, g.nodeIds])).toEqual(
    visual.subgraphs!.map((g) => [g.id, g.nodeIds]),
  );
  expect(collapsed.edges.map((e) => [e.id, e.source, e.target])).toEqual(
    visual.edges.map((e) => [e.id, e.source, e.target]),
  );
  const origin = new Bound(0, 0, 2000, 2000),
    ids = new Map(
      [...collapsed.nodes, ...collapsed.subgraphs!].map((o) => [
        o.id,
        `gfx-${o.id}`,
      ]),
    );
  const connectors = collapsed.edges.map((e, index) => ({
    ...toMermaidConnectorElementProps(
      e,
      ids,
      undefined,
      typeOwnedMermaidEdgeElementProjection(collapsed, e, index),
    ),
    id: `edge-${e.id}`,
    type: "connector",
  }));
  const elements = [
    ...collapsed.subgraphs!.map((g) => ({
      ...toMermaidSubgraphElementProps(
        g,
        origin,
        projectC4BoundaryElement(collapsed, g),
      ),
      id: ids.get(g.id)!,
      type: "shape",
    })),
    ...collapsed.nodes.map((n) => ({
      ...toMermaidShapeElementProps(
        n,
        origin,
        collapsed.direction,
        undefined,
        typeOwnedMermaidNodeElementProjection(collapsed, n),
      ),
      id: ids.get(n.id)!,
      type: "shape",
    })),
    ...connectors,
  ];
  expect(elements.find((e) => e.id === ids.get(runtime.id))!.hidden).toBe(true);
  const external = connectors[0];
  expect(external.hidden).toBe(false);
  expect(external.source).toEqual(
    expect.objectContaining({ id: ids.get(collapsed.edges[0].source) }),
  );
  expect(external.target).toEqual(
    expect.objectContaining({ id: ids.get(team.id) }),
  );
  expect(
    elements.find((e) => e.id === `edge-${collapsed.edges[1].id}`)!.hidden,
  ).toBe(true);
  const read = createMermaidVisualModelFromGfxElements({
    diagramType: "c4",
    direction: collapsed.direction,
    elements,
    ownerBound: origin,
    previousModel: collapsed,
  })!;
  expect(read.nodes.map((n) => n.id)).toEqual(collapsed.nodes.map((n) => n.id));
  expect(read.subgraphs!.map((g) => [g.id, g.nodeIds])).toEqual(
    collapsed.subgraphs!.map((g) => [g.id, g.nodeIds]),
  );
  expect(read.edges.map((e) => [e.source, e.target])).toEqual(
    collapsed.edges.map((e) => [e.source, e.target]),
  );
  expect(applyC4GfxVisualToSource(source, read).source).toBe(source);
  const afterForeign = readTypeOwnedMermaidSourceProjection(
    source + '\nPerson(other, "Other")',
    read,
  )!;
  expect(
    c4BoundaryPresentation(
      afterForeign.subgraphs!.find((g) => g.id === team.id)!.familyData,
    ).collapsed,
  ).toBe(true);
  expect(afterForeign.nodes.find((n) => n.label === "API")).toEqual(
    expect.objectContaining(visual.nodes.find((n) => n.label === "API")!),
  );
  expect(c4BoundaryHiddenBy(afterForeign, runtime.id)).toBe(team.id);
  const reloaded = JSON.parse(
    JSON.stringify(afterForeign),
  ) as typeof afterForeign;
  const expanded = setC4BoundaryCollapsed(reloaded, team.id, false)!;
  expect(expanded.subgraphs!.find((g) => g.id === team.id)).toEqual(
    expect.objectContaining({
      x: team.x,
      y: team.y,
      width: team.width,
      height: team.height,
    }),
  );
  expect(
    expanded.edges.every((e) => !e.sourceAttachment && !e.targetAttachment),
  ).toBe(true);
  expect(setC4BoundaryCollapsed(expanded, team.id, false)).toBe(expanded);
  expect(setC4BoundaryCollapsed(expanded, "missing", true)).toBeNull();
});

test("creates C4 kinds in the explicit scope and edits actual label providers without activating earlier records", () => {
  const source =
    'C4Context\r\nBoundary(team, "Team") {\r\n  %% retained anchor\r\n  System(api, "First")\r\n  System(api, "Latest")\r\n}\r\nRel(api, api, "Self")';
  let model = parseMermaidC4Source(source)!;
  const parentKey = model.boundaries[0].resolution!.sourceKeys[0];
  const api = model.elements[0],
    selection = api.resolution!.selectionId;
  const records = c4ElementDeclarations(model, selection);
  expect(records.map((r) => r.record.arguments![1].value)).toEqual([
    "First",
    "Latest",
  ]);
  expect(model.sourceDocument.source).toBe(source);
  const earlier = editC4ElementRecordLabel(
    model,
    records[0].record.sourceKey,
    "Earlier edit",
  );
  expect(earlier.source).toBe(source.replace('"First"', '"Earlier edit"'));
  expect(earlier.model.elements[0].label).toBe("Latest");
  const latest = editC4ElementLabel(earlier.model, selection, "Public API");
  expect(latest.source).toBe(
    earlier.source.replace('"Latest"', '"Public API"'),
  );
  expect(latest.model.elements[0].resolution!.selectionId).toBe(selection);
  expect(editC4ElementLabel(latest.model, selection, "Public API").status).toBe(
    "unchanged",
  );
  model = latest.model;
  for (const kind of [
    "Person",
    "System",
    "Container",
    "Component",
    "ContainerDb",
    "ContainerQueue",
  ] as const) {
    const beforeKey = records[0].record.sourceKey;
    const created = createC4Element(model, {
      kind,
      label: kind,
      target: { parentKey, beforeKey },
    });
    expect(created.status).toBe("changed");
    const node = created.model.elements.find(
      (e) => e.resolution?.selectionId === created.selection,
    )!;
    expect(node).toMatchObject({ kind, label: kind, boundaryId: "team" });
    expect(created.source).toContain(
      '%% retained anchor\r\n  System(api, "Earlier edit")',
    );
    expect(created.source.endsWith('Rel(api, api, "Self")')).toBe(true);
    const renamed = editC4ElementLabel(
      created.model,
      created.selection!,
      `${kind} renamed`,
    );
    expect(
      renamed.model.elements.find(
        (e) => e.resolution?.selectionId === created.selection,
      )?.label,
    ).toBe(`${kind} renamed`);
    model = renamed.model;
  }
  const again = createC4Element(model, {
    kind: "Person",
    label: "Another",
    target: { parentKey },
  });
  expect(again.status).toBe("changed");
  expect(
    again.model.elements.filter((e) => e.kind === "Person").map((e) => e.alias),
  ).toEqual(["person", "person2"]);
  expect(
    createC4Element(model, {
      kind: "System",
      label: "Collision",
      alias: "team",
      target: { parentKey },
    }),
  ).toMatchObject({ status: "invalid", source: model.sourceDocument.source });
  expect(c4ElementKindCatalog("C4Context").additional).toContain("Component");
});

describe("C4 DB argument contract", () => {
  test("prepares local fields, confirms Technology loss, and preserves native metadata/style priority", () => {
    const source = [
      "C4Container",
      'Container(api, "API", "Rust", "Description", $sprite="db", $tags="queue", $custom="kept") %% owner',
      'UpdateElementStyle(api, "red", "blue")',
      'Person(user, "User")',
    ].join("\r\n");
    const model = parseMermaidC4Source(source)!,
      element = model.elements[0],
      id = element.resolution!.selectionId;
    const initial = readC4ElementFields(element);
    const prepared = prepareC4ElementFields(model, id, {
      ...initial,
      kind: "Person",
      label: "Public API",
      description: "Changed",
      link: "https://example.invalid",
      shape: "queue",
    });
    expect(prepared.loss).toMatchObject([
      { field: "techn", argument: { value: "Rust" } },
    ]);
    expect(model.sourceDocument.source).toBe(source);
    expect(editC4ElementFields(model, prepared.draft!).status).toBe("invalid");
    const changed = editC4ElementFields(model, prepared.draft!, true);
    expect(changed.model.elements[0]).toMatchObject({
      kind: "Person",
      label: "Public API",
      technology: "",
      description: "Changed",
      sprite: "db",
      tags: "queue",
      link: "https://example.invalid",
    });
    expect(changed.model.elements[0].resolution!.fields).toMatchObject({
      custom: "kept",
      bgColor: "red",
      fontColor: "blue",
      shape: "queue",
    });
    expect(changed.source).toContain('UpdateElementStyle(api, "red", "blue")');
    expect(changed.source.endsWith('Person(user, "User")')).toBe(true);
    expect(changed.model.elements[0].resolution!.selectionId).toBe(id);
    expect(
      editC4ElementFields(changed.model, prepared.draft!, true).status,
    ).toBe("invalid");
    const noop = prepareC4ElementFields(
      changed.model,
      id,
      readC4ElementFields(changed.model.elements[0]),
    );
    expect(editC4ElementFields(changed.model, noop.draft!).status).toBe(
      "unchanged",
    );
    const custom = model.sourceDocument.records.find(
      (r) => r.kind === "element",
    )!;
    const unknown = editC4ElementArgument(model, id, custom.sourceKey, 6, {
      key: "other",
      value: "new metadata",
    });
    expect(unknown.model.elements[0].resolution!.fields).toMatchObject({
      other: "new metadata",
    });
    expect(unknown.model.elements[0].resolution!.fields.custom).toBeUndefined();
    expect(unknown.source).toBe(
      source.replace('$custom="kept"', '$other="new metadata"'),
    );
    expect(
      editC4ElementArgument(model, id, custom.sourceKey, 0, {
        key: "",
        value: "newId",
      }).status,
    ).toBe("invalid");
    const ghost = parseMermaidC4Source(
      'C4Container\nContainer(api,"API","Old")\nPerson(api,"Person")',
    )!;
    const ghostDraft = prepareC4ElementFields(
      ghost,
      ghost.elements[0].resolution!.selectionId,
      {
        ...readC4ElementFields(ghost.elements[0]),
        kind: "Container",
        technology: "New",
      },
    );
    expect(ghostDraft.model!.elements[0].technology).toBe("New");
  });

  test("renames the full C4 alias impact atomically or explicitly splits one declaration with retained references", () => {
    const source = [
      "C4Container",
      'UpdateElementStyle(api, "early")',
      'Boundary(team, "Team") {',
      '  Container(api, "First", "Rust") %% keep',
      '  Container(api, "Latest")',
      "}",
      'Person(user, "User")',
      'Rel(user, api, "First")',
      'Rel(user, api, "Latest")',
      'Rel(api, api, "Self")',
      'UpdateElementStyle(api, "fill")',
      'UpdateRelStyle(user, api, "text")',
      "%% tail",
    ].join("\r\n");
    const model = parseMermaidC4Source(source)!;
    const api = model.elements.find((e) => e.alias === "api")!,
      id = api.resolution!.selectionId;
    const prepared = prepareC4AliasRename(model, id, "documentApi");
    expect(prepared.draft!.impact).toHaveLength(8);
    expect(
      prepared.model!.elements.find((e) => e.alias === "documentApi")!
        .resolution!.selectionId,
    ).toBe(id);
    expect(model.sourceDocument.source).toBe(source);
    expect(renameC4Alias(model, prepared.draft!, false).source).toBe(source);
    const changed = renameC4Alias(model, prepared.draft!, true);
    expect(changed.status).toBe("changed");
    expect(changed.source).toBe(source.replaceAll(/\bapi\b/g, '"documentApi"'));
    expect(changed.model.relationships.map((e) => [e.from, e.to])).toEqual([
      ["user", "documentApi"],
      ["documentApi", "documentApi"],
    ]);
    expect(
      changed.model.relationships.map((e) => e.resolution!.selectionId),
    ).toEqual(model.relationships.map((e) => e.resolution!.selectionId));
    expect(renameC4Alias(changed.model, prepared.draft!, true).status).toBe(
      "invalid",
    );
    expect(prepareC4AliasRename(model, id, "team").draft).toBeUndefined();
    expect(prepareC4AliasRename(model, id, "global").draft).toBeUndefined();
    expect(
      renameC4Alias(model, prepareC4AliasRename(model, id, "api").draft!, true)
        .status,
    ).toBe("unchanged");
    expect(isC4Alias("api with spaces")).toBe(true);
    expect(isC4Alias(" api")).toBe(false);
    const split = prepareC4AliasRename(
      model,
      id,
      "earlierApi",
      api.resolution!.sourceKeys[0],
    );
    expect(split.draft!.impact).toHaveLength(1);
    expect(split.draft!.retainedReferences).toHaveLength(6);
    expect(split.model!.elements.find((e) => e.alias === "api")).toMatchObject({
      label: "Latest",
      resolution: { selectionId: id },
    });
    const distinct = split.model!.elements.find(
      (e) => e.alias === "earlierApi",
    )!;
    expect(distinct.label).toBe("First");
    expect(distinct.resolution!.selectionId).not.toBe(id);
    expect(renameC4Alias(model, split.draft!, true).source).toBe(
      source.replace(
        'Container(api, "First"',
        'Container("earlierApi", "First"',
      ),
    );
    const orphan = prepareC4AliasRename(
      split.model!,
      id,
      "lastApi",
      api.resolution!.sourceKeys[1],
    );
    expect(orphan.draft!.remainingKeys).toEqual([]);
    expect(orphan.draft!.retainedReferences).toHaveLength(6);
    expect(
      orphan.model!.sourceDocument.diagnostics.some(
        (d) => d.code === "c4.relationship.endpoint-missing",
      ),
    ).toBe(true);
  });

  test("separates syntax, identity, references and native rendering while retaining the local repair basis", () => {
    const open = parseMermaidC4SourceWithDiagnostics(
      'C4Container\nBoundary(team, "Team") {\n',
    );
    expect(open.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "syntax",
        code: "c4.boundary.unclosed",
        correction: "boundary-close",
        range: expect.objectContaining({ line: 2 }),
      }),
    );
    for (const terminator of ["#", ";"]) {
      const title = parseMermaidC4SourceWithDiagnostics(
        `C4Context\ntitle Visible${terminator}tail\n`,
      );
      expect(title.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "c4.title.terminator",
          correction: "title-value",
          range: expect.objectContaining({ start: 23, end: 28 }),
        }),
      );
    }
    const collision = parseMermaidC4SourceWithDiagnostics(
      'C4Context\nPerson(api, "API")\nBoundary(api, "API") {\n}\n',
    );
    expect(collision.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "identity",
        correction: "alias",
        code: "c4.boundary.alias-collision",
      }),
    );
    const cycle = parseMermaidC4SourceWithDiagnostics(
      'C4Context\nBoundary(a, "A") {\nBoundary(b, "B") {\nBoundary(a, "A again") {\n}\n}\n}\n',
    );
    expect(cycle.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "identity",
        code: "c4.boundary.parent-cycle",
      }),
    );
    const source =
      'C4Container\nContainer(api, "API", "Rust")\n%% relation owner\nRel(api, absent, "Uses")\nUpdateElementStyle(api, "", "", "", "", "", "", "Go")\n';
    const parsed = parseMermaidC4SourceWithDiagnostics(source);
    expect(parsed.syntaxValid).toBe(true);
    expect(parsed.model!.relationships[0].to).toBe("absent");
    expect(parsed.projectionRenderable).toBe(false);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "reference",
        correction: "endpoints",
        code: "c4.relationship.endpoint-missing",
      }),
    );
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        category: "native-render",
        severity: "warning",
        code: "c4.native.technology-string",
        correction: "native-adapter",
      }),
    );
    const record = parsed.document.records.find(
      (r) => r.kind === "relationship",
    )!;
    const args = record.arguments!.map((a) => ({ ...a }));
    args[1].value = "api";
    const repaired = editC4RelationshipRecord(
      parsed.model!,
      record.sourceKey,
      "Rel",
      args,
    )!;
    expect(repaired.source).toBe(
      source.replace('Rel(api, absent, "Uses")', 'Rel(api, "api", "Uses")'),
    );
    expect(
      repaired.model.sourceDocument.records.find(
        (r) => r.kind === "relationship",
      )!.sourceKey,
    ).toBe(record.sourceKey);
    const rendered = parseMermaidC4SourceWithDiagnostics(repaired.source);
    expect(rendered.projectionRenderable).toBe(true);
    expect(rendered.nativeRenderable).toBe(false);
    expect(
      rendered.diagnostics.every((d) => d.category === "native-render"),
    ).toBe(true);
  });
});

describe("C4 physical source records", () => {
  test("writes structural edits through retained owners and advances bindings without rebuilding foreign Source", () => {
    const source = [
      "---",
      "config:",
      "  c4: {wrap: true}",
      "---",
      "C4Container",
      "  title Original",
      "accTitle: Accessible",
      "%% scope comment",
      'Boundary(team,"Team")',
      "{",
      '  Container(api,"Earlier","Rust")',
      "  %% provider comment",
      '  Container(api,"Latest","Rust") %% inline provider',
      "}",
      'Person(user,"User")',
      'Rel(user,api,"First")',
      'Rel(user,api,"Latest")',
      'UpdateElementStyle(api,"", "", "", "", "", "", "Go")',
      'UpdateLayoutConfig("", "3")',
    ].join("\r\n");
    let model = parseMermaidC4Source(source)!;
    const ids = model.sourceDocument.selectionBindings!.map(
      (b) => b.selectionId,
    );
    const unchanged = new Map(
      model.sourceDocument.records
        .filter(
          (r) =>
            r.kind === "frontmatter" ||
            r.kind === "comment" ||
            r.kind === "blank" ||
            r.kind === "boundary-open" ||
            r.kind === "boundary-brace" ||
            r.kind === "boundary-close" ||
            r.kind === "accessibility-title",
        )
        .map((r) => [r.sourceKey, r.raw]),
    );
    const renamed = structuredClone(model);
    renamed.elements.find((e) => e.alias === "api")!.alias = "documentApi";
    renamed.elements.find((e) => e.id === "api")!.id = "documentApi";
    renamed.relationships.forEach((r) => {
      if (r.to === "api") r.to = "documentApi";
    });
    renamed.updateStatements.find(
      (s) => s.kind === "UpdateElementStyle",
    )!.callArguments[0].value = "documentApi";
    let written = generateMermaidC4SourceWithBindings(renamed);
    expect(
      written.model.sourceDocument.selectionBindings!.map((b) => b.selectionId),
    ).toEqual(ids);
    expect(
      written.model.elements.find((e) => e.alias === "documentApi")!.resolution!
        .sourceKeys,
    ).toHaveLength(2);
    for (const [key, raw] of unchanged)
      expect(
        written.model.sourceDocument.records.find((r) => r.sourceKey === key)!
          .raw,
      ).toBe(raw);
    model = parseMermaidC4Source(written.source, written.bindings)!;
    const reparented = structuredClone(model);
    reparented.elements.find((e) => e.alias === "documentApi")!.boundaryId = "";
    written = generateMermaidC4SourceWithBindings(reparented);
    expect(
      written.model.elements.find((e) => e.alias === "documentApi")!.boundaryId,
    ).toBe("");
    expect(written.source).toContain(
      '  %% provider comment\r\n  Container("documentApi","Latest","Rust") %% inline provider',
    );
    expect(written.source).toContain(
      '  Container("documentApi","Earlier","Rust")\r\n}',
    );
    const scope = written.model.boundaries[0].resolution!.declarationKey;
    const inserted = insertC4Record(
      written.model,
      { parentKey: scope },
      '  ContainerDb(db,"Storage","SQL")',
    );
    const db = inserted.model.elements.find((e) => e.alias === "db")!;
    const removed = writeC4Patches(
      inserted.model,
      c4RecordDeletionPatches(inserted.model, db.resolution!.sourceKeys),
    );
    expect(removed.source).toBe(written.source);
    model = removed.model;
    const edited = structuredClone(model);
    edited.elements.find((e) => e.alias === "documentApi")!.kind =
      "ContainerDb";
    edited.elements.find((e) => e.alias === "documentApi")!.callArguments = [];
    edited.updateStatements.find(
      (s) => s.kind === "UpdateLayoutConfig",
    )!.callArguments[1].value = "4";
    edited.title = "";
    written = generateMermaidC4SourceWithBindings(edited);
    expect(
      written.model.elements.find((e) => e.alias === "documentApi")!.kind,
    ).toBe("ContainerDb");
    expect(written.model.layoutBoundaryInRow).toBe(4);
    expect(written.model.title).toBe("");
    expect(written.source).not.toContain("title ");
    expect(written.source).toContain(
      'Rel(user,"documentApi","First")\r\nRel(user,"documentApi","Latest")',
    );
    expect(
      written.model.elements.find((e) => e.alias === "user")!.resolution!
        .selectionId,
    ).toBe(
      ids.find(
        (id) =>
          id ===
          model.elements.find((e) => e.alias === "user")!.resolution!
            .selectionId,
      ),
    );
    const reordered = structuredClone(written.model);
    reordered.elements.find((e) => e.alias === "user")!.order = 0;
    reordered.elements.find((e) => e.alias === "documentApi")!.order = 1;
    const moved = generateMermaidC4SourceWithBindings(reordered);
    expect(moved.model.elements.map((e) => e.alias)).toEqual([
      "user",
      "documentApi",
    ]);
    expect(
      moved.model.sourceDocument
        .selectionBindings!.map((b) => b.selectionId)
        .sort(),
    ).toEqual(ids.toSorted());
    const visual = c4ModelToGfxVisualModel(moved.model);
    visual.nodes.find((n) => n.label === "Latest")!.label = "Renamed API";
    const applied = applyC4GfxVisualToSource(moved.source, visual);
    expect(mermaidGfxCommittedSource(applied.source, visual)).toBe(
      applied.source,
    );
    expect(applied.source).toContain("\r\n");
    expect(applied.source).toContain(
      'Container("documentApi","Earlier","Rust")',
    );
    const broken = parseMermaidC4SourceWithDiagnostics(
      'C4Context\nPerson($alias="p","P")\n',
    );
    const record = broken.document.records.find((r) => r.callKind)!;
    const repaired = writeC4SourcePatches(broken.document, [
      c4CallPatch(broken.document, record.sourceKey, "Person", [
        { key: "", value: "p" },
        record.arguments![1],
      ]),
    ]);
    expect(repaired.projectionRenderable).toBe(true);
    expect(repaired.document.records.find((r) => r.callKind)!.sourceKey).toBe(
      record.sourceKey,
    );
    expect(
      parseMermaidC4SourceWithDiagnostics("C4Context\ntitle \n").diagnostics,
    ).toContainEqual(
      expect.objectContaining({
        code: "c4.title.empty",
        correction: "title-value",
      }),
    );
  });
});

test("reconciles consuming GFX child bindings across a repeated declaration insertion and deletion", () => {
  installProjectedMermaidTestTheme();
  const source =
    'C4Context\nSystem(app, "First", , "db")\nSystem(app, "Second")\nPerson(user, "User")\n';
  const initial = c4ModelToGfxVisualModel(parseMermaidC4Source(source)!);
  const insertedSource = source.replace(
    'System(app, "Second")',
    'System(app, "Second")\nSystem(app, "Latest")',
  );
  const inserted = readTypeOwnedMermaidSourceProjection(
    insertedSource,
    initial,
  );
  expect(inserted.nodes.map((n) => n.id)).toEqual(
    initial.nodes.map((n) => n.id),
  );
  const deleted = readTypeOwnedMermaidSourceProjection(
    insertedSource.replace('System(app, "First", , "db")\n', ""),
    inserted,
  );
  expect(deleted.nodes.map((n) => n.id)).toEqual(
    initial.nodes.map((n) => n.id),
  );
  const parsed = readC4ProjectionModel(insertedSource, initial)!;
  expect(parsed.elements[0].label).toBe("Latest");
  const before = toMermaidShapeElementProps(
    initial.nodes[0],
    new Bound(0, 0, 800, 600),
  );
  const after = toMermaidShapeElementProps(
    deleted.nodes[0],
    new Bound(0, 0, 800, 600),
  );
  expect(after.mermaidNodeId).toBe(before.mermaidNodeId);
});

test("confirms lexical C4 moves with real provider impact, exact trivia and advanced bindings", () => {
  const unit =
    '  %% API owner\r\n  Container(api,"First","Rust") %% API note\r\n';
  const source = `C4Container\r\nBoundary(team,"Team")\r\n{\r\n${unit}  Boundary(inner,"Inner") {\r\n  }\r\n}\r\nContainer(api,"Latest","Go")\r\nPerson(user,"User")\r\nRel(user,api,"Uses")\r\n`;
  const model = parseMermaidC4Source(source)!;
  const first = model.sourceDocument.records.find((r) => r.kind === "element")!;
  const user = model.sourceDocument.records.find(
    (r) => r.arguments?.[0]?.value === "user",
  )!;
  const team = model.sourceDocument.records.find(
    (r) => r.arguments?.[0]?.value === "team",
  )!;
  const inner = model.sourceDocument.records.find(
    (r) => r.arguments?.[0]?.value === "inner",
  )!;
  expect(
    prepareC4RecordMove(model, team.sourceKey, { parentKey: inner.sourceKey }),
  ).toBeNull();
  const draft = prepareC4RecordMove(model, first.sourceKey, {
    parentKey: null,
    beforeKey: user.sourceKey,
  })!;
  expect(draft.targetScope).toEqual([]);
  expect(draft.impact).toContainEqual(
    expect.objectContaining({
      field: "label",
      before: { text: "Latest" },
      after: { text: "First" },
    }),
  );
  expect(confirmC4RecordMove(model, draft, false)).toMatchObject({
    status: "cancelled",
    source,
  });
  expect(
    confirmC4RecordMove(parseMermaidC4Source(source + "\r\n")!, draft, true)
      .status,
  ).toBe("stale");
  const moved = confirmC4RecordMove(model, draft, true);
  expect(moved.status).toBe("changed");
  const labelImpact = draft.impact.find((i) => i.field === "label")!;
  expect(labelImpact.providers?.before).toEqual({
    call: "Container",
    line: model.sourceDocument.records.find(
      (r) => r.sourceKey === labelImpact.previousProvider,
    )!.range.line,
  });
  expect(labelImpact.providers?.after).toEqual({
    call: "Container",
    line: moved.model.sourceDocument.records.find(
      (r) => r.sourceKey === labelImpact.nextProvider,
    )!.range.line,
  });
  expect(moved.source).toBe(
    source
      .replace(unit, "")
      .replace('Person(user,"User")', unit + 'Person(user,"User")'),
  );
  for (const record of model.sourceDocument.records)
    expect(
      moved.model.sourceDocument.records.find(
        (r) => r.sourceKey === record.sourceKey,
      )?.raw,
    ).toBe(record.raw);
  expect(moved.model.elements[0].resolution!.selectionId).toBe(
    model.elements[0].resolution!.selectionId,
  );
  const reparent = prepareC4RecordMove(moved.model, first.sourceKey, {
    parentKey: team.sourceKey,
  })!;
  expect(reparent.targetScope).toEqual(["team"]);
  const restored = confirmC4RecordMove(moved.model, reparent, true);
  expect(
    restored.model.sourceDocument.records.find(
      (r) => r.sourceKey === first.sourceKey,
    )?.scopeKeys,
  ).toEqual([team.sourceKey]);
  expect(restored.model.elements[0].label).toBe("Latest");
});

test("creates all C4 relation forms on real element endpoints and selects existing pairs without invisible duplicates", () => {
  installProjectedMermaidTestTheme();
  const source =
    'C4Container\nBoundary(scope,"Scope") {\n}\nContainer(api,"API")\nContainerDb(db,"DB")\nPerson(user,"User")\n';
  const model = parseMermaidC4Source(source)!;
  for (const kind of C4_RELATIONSHIP_KINDS) {
    const value = {
      from: "api",
      to: "db",
      kind,
      label: "Uses",
      target: { parentKey: null },
    };
    const created = createC4Relationship(model, value);
    expect(created.status).toBe("changed");
    expect(created.model.relationships).toHaveLength(1);
    expect(created.model.relationships[0]).toMatchObject({
      from: "api",
      to: "db",
      kind,
      label: "Uses",
      index: kind === "RelIndex" ? "0" : null,
    });
    expect(created.source.startsWith(source)).toBe(true);
    expect(
      createC4Relationship(created.model, {
        ...value,
        kind: "BiRel",
        label: "Duplicate",
      }),
    ).toMatchObject({
      status: "unchanged",
      source: created.source,
      selection: created.selection,
    });
    const another = createC4Relationship(created.model, {
      ...value,
      to: "user",
      selectSource: true,
    });
    expect(another.model.relationships).toHaveLength(2);
    expect(another.selection).toBe(model.elements[0].resolution!.selectionId);
  }
  for (const [from, to] of [
    ["scope", "api"],
    ["api", "scope"],
    ["missing", "api"],
  ])
    expect(
      createC4Relationship(model, {
        from,
        to,
        kind: "Rel",
        label: "",
        target: { parentKey: null },
      }),
    ).toMatchObject({ status: "invalid", source });
  const self = createC4Relationship(model, {
    from: "api",
    to: "api",
    kind: "Rel",
    label: "Self",
    target: { parentKey: null },
  });
  expect(self.status).toBe("changed");
  const visual = c4ModelToGfxVisualModel(self.model),
    edge = visual.edges[0];
  expect(edge.source).toBe(edge.target);
  const props = toMermaidConnectorElementProps(
    edge,
    new Map(visual.nodes.map((n) => [n.id, n.id])),
    [0, 0, 80, 20],
  );
  expect(props).toMatchObject({
    mode: ConnectorMode.Straight,
    source: { id: edge.source },
    target: { id: edge.source },
  });
});

test("reconnects repeated C4 declarations and applied style targets together while preserving raw values, trivia and unchanged-end mutations", () => {
  const source =
    'C4Dynamic\nBoundary(scope,"Scope") {\n}\nContainer(a,"A")\nContainer(b,"B")\nContainer(c,"C")\nContainer(d,"D")\nUpdateRelStyle(a,b,$textColor="early")\nRel(a,b,"First",$tags="KEEP") %% first\nUpdateRelStyle(a,b,$offsetX="12")\nRelIndex($step="099",a,b,"Latest") %% second\nRel(c,b,"Conflict")\n';
  const model = parseMermaidC4Source(source)!,
    owner = model.relationships[0],
    id = owner.resolution!.selectionId;
  expect(prepareC4Reconnect(model, id, "c", "b").collision).toBe(
    model.relationships[1].resolution!.selectionId,
  );
  expect(prepareC4Reconnect(model, id, "a", "scope").draft).toBeUndefined();
  const prepared = prepareC4Reconnect(model, id, "a", "d");
  expect(prepared.draft!.impact.map((i) => i.call)).toEqual([
    "Rel",
    "UpdateRelStyle",
    "RelIndex",
  ]);
  expect(reconnectC4Relationship(model, prepared.draft!, false)).toMatchObject({
    status: "unchanged",
    source,
  });
  expect(
    reconnectC4Relationship(
      parseMermaidC4Source(source + "\n")!,
      prepared.draft!,
      true,
    ).status,
  ).toBe("invalid");
  const changed = reconnectC4Relationship(model, prepared.draft!, true);
  expect(changed.selection).toBe(id);
  expect(changed.source).toContain('UpdateRelStyle(a,b,$textColor="early")');
  expect(changed.source).toContain('UpdateRelStyle(a,"d",$offsetX="12")');
  expect(changed.source).toContain(
    'RelIndex($step="099",a,"d","Latest") %% second',
  );
  expect(changed.model.relationships[0]).toMatchObject({
    from: "a",
    to: "d",
    index: "099",
    dynamicStep: 1,
  });
  expect(changed.model.relationships[0].resolution!.fields.offsetX).toBe("12");
  const recordKey = owner.resolution!.declarationKey;
  const notation = prepareC4RelationshipNotation(
    changed.model,
    recordKey,
    "BiRel",
  );
  expect(notation.draft!.removedIndex).toBe("099");
  expect(
    changeC4RelationshipNotation(changed.model, notation.draft!, false).source,
  ).toBe(changed.source);
  const confirmed = changeC4RelationshipNotation(
    changed.model,
    notation.draft!,
    true,
  );
  expect(confirmed.source).toContain('BiRel(a, d, "Latest") %% second');
  expect(confirmed.model.relationships[0]).toMatchObject({
    kind: "BiRel",
    label: "Latest",
    dynamicStep: 1,
  });
  expect(
    removeC4RelationshipRecord(changed.model, recordKey, false).source,
  ).toBe(changed.source);
  const deleted = removeC4RelationshipRecord(changed.model, recordKey, true);
  expect(deleted.selection).toBe(id);
  expect(deleted.model.relationships[0]).toMatchObject({
    label: "First",
    from: "a",
    to: "d",
    index: null,
  });
  expect(deleted.source).toContain("%% second");
  const mutableSource =
    'C4Container\nContainer(a,"A")\nContainer(b,"B")\nContainer(c,"C")\nContainer(d,"D")\nRel(a,b,"First")\nUpdateRelStyle(a,b,$from="c")\nRel(c,b,"Latest")\n';
  const mutable = parseMermaidC4Source(mutableSource)!,
    mutableId = mutable.relationships[0].resolution!.selectionId;
  const moved = reconnectC4Relationship(
    mutable,
    prepareC4Reconnect(mutable, mutableId, "c", "d").draft!,
    true,
  );
  expect(moved.source).toContain('Rel(a,"d","First")');
  expect(moved.source).toContain('UpdateRelStyle(a,"d",$from="c")');
  expect(moved.source).toContain('Rel(c,"d","Latest")');
  expect(moved.model.relationships).toHaveLength(1);
  expect(moved.model.relationships[0]).toMatchObject({ from: "c", to: "d" });
});

test("replays mutable native aliases and keeps the actual owners through rename and metadata edits", () => {
  const source = [
    "C4Container",
    'Container(api, "First", "Rust", "", $alias="other")',
    'Container(api, "Second", "Go")',
    'Person(user, "User")',
    'UpdateElementStyle(other, $alias="renamed")',
    'UpdateElementStyle(other, $tags="ignored")',
    'UpdateElementStyle(renamed, $tags="visible")',
    'Rel(api, user, "First", "", "", $from="renamed")',
    'Rel(api, user, "Second")',
    'UpdateRelStyle(renamed, user, $to="api")',
  ].join("\r\n");
  const model = parseMermaidC4Source(source)!;
  expect(model.elements.map((e) => e.alias)).toEqual([
    "renamed",
    "api",
    "user",
  ]);
  expect(model.elements[0]).toMatchObject({
    label: "First",
    technology: "Rust",
    tags: "visible",
  });
  expect(model.occurrences[4].applied).toBe(false);
  expect(model.occurrences[3].selectionId).toBe(
    model.elements[0].resolution!.selectionId,
  );
  expect(model.relationships.map((r) => [r.from, r.to])).toEqual([
    ["renamed", "api"],
    ["api", "user"],
  ]);
  const id = model.elements[0].resolution!.selectionId;
  const renamed = prepareC4AliasRename(model, id, "documentApi");
  expect(renamed.draft).toBeDefined();
  const next = renameC4Alias(model, renamed.draft!, true);
  expect(next.source).toBe(
    source
      .replace(
        'Container(api, "First", "Rust", "", $alias="other")',
        'Container("documentApi", "First", "Rust", "", $alias="documentApi")',
      )
      .replace(
        'UpdateElementStyle(other, $alias="renamed")',
        'UpdateElementStyle("documentApi", $alias="documentApi")',
      )
      .replace(
        'UpdateElementStyle(renamed, $tags="visible")',
        'UpdateElementStyle("documentApi", $tags="visible")',
      )
      .replace('$from="renamed"', '$from="documentApi"')
      .replace(
        "UpdateRelStyle(renamed, user",
        'UpdateRelStyle("documentApi", user',
      ),
  );
  expect(next.model.elements[0].resolution!.selectionId).toBe(id);
  expect(next.model.elements[1].resolution!.selectionId).toBe(
    model.elements[1].resolution!.selectionId,
  );
  expect(
    next.model.relationships.map((r) => r.resolution!.selectionId),
  ).toEqual(model.relationships.map((r) => r.resolution!.selectionId));
  const draft = structuredClone(model);
  draft.elements[0].alias = "documentApi";
  draft.elements[0].id = "documentApi";
  draft.relationships[0].from = "documentApi";
  const written = generateMermaidC4SourceWithBindings(draft);
  expect(written.model.elements.map((e) => e.alias)).toEqual([
    "documentApi",
    "api",
    "user",
  ]);
  expect(written.model.relationships.map((r) => [r.from, r.to])).toEqual([
    ["documentApi", "api"],
    ["api", "user"],
  ]);
  expect(written.source).toContain(
    'Rel(api, user, "First", "", "", $from="documentApi")',
  );
  const fields = prepareC4ElementFields(model, id, {
    ...readC4ElementFields(model.elements[0]),
    link: "https://example.invalid",
  });
  expect(fields.model!.elements[0].link).toBe("https://example.invalid");
  expect(fields.model!.sourceDocument.source).toContain(
    'UpdateElementStyle(renamed, $link="https://example.invalid")',
  );
  const record = model.sourceDocument.records.find(
    (r) => r.callKind === "Container",
  )!;
  const argument = editC4ElementArgument(model, id, record.sourceKey, 4, {
    key: "alias",
    value: "changed",
  });
  expect(argument.status).toBe("changed");
  expect(argument.model.elements[0].alias).toBe("changed");
  for (const key of [
    "invalid=key",
    'label="Injected")\nPerson(extra,"Extra")\nUpdateElementStyle(renamed,$shape',
  ]) {
    expect(
      editC4ElementArgument(model, id, record.sourceKey, 4, {
        key,
        value: "db",
      }),
    ).toMatchObject({ status: "invalid", source: model.sourceDocument.source });
  }
  const unusualKey = 'metadata (custom),\nquoted"key';
  const unknown = editC4ElementArgument(model, id, record.sourceKey, 3, {
    key: unusualKey,
    value: "retained",
  });
  expect(unknown.status).toBe("changed");
  expect(unknown.model.elements[0].resolution!.fields[unusualKey]).toEqual({
    text: "retained",
  });
  expect(unknown.model.elements).toHaveLength(model.elements.length);
});

test("reorders Dynamic by moving its first declaration and complete pair units with deterministic steps and retained raw indexes", () => {
  const source =
    'C4Dynamic\r\nPerson(a,"A")\r\nPerson(b,"B")\r\nPerson(c,"C")\r\n%% first pair\r\nRelIndex("099",a,b,"first", "HTTP", "", "", "KEEP") %% inline\r\nRel(b,c,"second")\r\nUpdateRelStyle(a,b,$textColor="red")\r\n%% repeated\r\nRel(a,b,"last")\r\n';
  const model = parseMermaidC4Source(source)!,
    pair = model.relationships[0],
    id = pair.resolution!.selectionId;
  const prepared = prepareC4DynamicOrder(model, id, null);
  expect(prepared.draft!.records.filter((r) => r.firstOccurrence)).toHaveLength(
    1,
  );
  expect(prepared.draft!.records.map((r) => r.call)).toEqual([
    "%% first pair",
    "RelIndex",
    "%% inline",
    "UpdateRelStyle",
    "%% repeated",
    "Rel",
  ]);
  expect(prepared.draft!.steps.map((s) => [s.before, s.after])).toEqual([
    [2, 1],
    [1, 2],
  ]);
  const moved = reorderC4DynamicPair(model, prepared.draft!, true);
  expect(moved.status).toBe("changed");
  expect(
    moved.model.relationships.map((r) => [r.from, r.to, r.dynamicStep]),
  ).toEqual([
    ["b", "c", 1],
    ["a", "b", 2],
  ]);
  expect(moved.model.relationships[1]).toMatchObject({
    label: "last",
    tags: "KEEP",
  });
  expect(moved.source).toContain(
    '%% first pair\r\nRelIndex("099",a,b,"first", "HTTP", "", "", "KEEP") %% inline',
  );
  expect(moved.model.relationships[1].resolution!.selectionId).toBe(id);
  expect(moved.reflowScopes).toBeUndefined();
  expect(moved.model.elements.map((e) => e.resolution!.selectionId)).toEqual(
    model.elements.map((e) => e.resolution!.selectionId),
  );
  expect(reorderC4DynamicPair(model, prepared.draft!, false).source).toBe(
    source,
  );
  expect(reorderC4DynamicPair(moved.model, prepared.draft!, true).source).toBe(
    moved.source,
  );
  expect(
    prepareC4DynamicOrder(moved.model, id, null).model!.sourceDocument.source,
  ).toBe(moved.source);
  const restored = parseMermaidC4SourceWithDiagnostics(source, {
    previous: moved.model.sourceDocument,
  }).model!;
  expect(restored.relationships.map((r) => r.dynamicStep)).toEqual([1, 2]);
  expect(restored.relationships[0].resolution!.selectionId).toBe(id);
});

test("C4 appearance edits the real provider, keeps early updates local, and deleting one style reveals prior shape and colour providers", () => {
  const source =
    'C4Container\nUpdateElementStyle(api,$bgColor="early")\nContainerDb(api,"API","Rust", "", "", "queue")\nUpdateElementStyle(api,$bgColor="red",$shape="person") %% earlier\nUpdateElementStyle(api,$shape="cylinder",$bgColor="blue",$legendText="retained") %% selected\n';
  const model = parseMermaidC4Source(source)!,
    id = model.elements[0].resolution!.selectionId;
  const records = c4ElementStyleRecords(model, id);
  expect(records).toHaveLength(3);
  expect(c4ElementStyleArgumentEffect(model, records[0].sourceKey, 1)).toBe(
    "stored",
  );
  expect(c4ElementStyleArgumentEffect(model, records[2].sourceKey, 3)).toBe(
    "stored",
  );
  const edited = editC4ElementAppearance(model, id, { bgColor: "green" });
  expect(edited.source).toBe(
    source.replace('$bgColor="blue"', '$bgColor="green"'),
  );
  const cleared = editC4ElementAppearance(edited.model, id, { shape: "" });
  expect(c4ResolvedElementShape(cleared.model.elements[0])).toBe("h-cyl");
  const deleted = removeC4ElementStyleRecord(
    edited.model,
    id,
    records[2].sourceKey,
    true,
  );
  expect(c4ResolvedElementShape(deleted.model.elements[0])).toBe("person");
  expect(deleted.model.elements[0].resolution!.fields.bgColor).toBe("red");
  expect(deleted.source).toContain(
    'UpdateElementStyle(api,$bgColor="red",$shape="person") %% earlier',
  );
  expect(deleted.source).toContain("%% selected");
  expect(deleted.model.elements[0].resolution!.selectionId).toBe(id);
  expect(
    removeC4ElementStyleRecord(model, id, records[2].sourceKey, false).source,
  ).toBe(source);
  const appended = editC4ElementAppearance(
    model,
    id,
    { bgColor: "green" },
    "append",
  );
  expect(appended.source).toContain(source.trimEnd());
  expect(appended.model.elements[0].resolution!.fields.bgColor).toBe("green");
  const early = editC4ElementStyleArgument(model, id, records[0].sourceKey, 1, {
    key: "bgColor",
    value: "changed early",
  });
  expect(early.model.elements[0].resolution!.fields.bgColor).toBe("blue");
  expect(early.source).toBe(source.replace('"early"', '"changed early"'));
  const boundary = parseMermaidC4Source(
    'C4Deployment\nBoundary(scope,"Scope") {\n}\nUpdateElementStyle(scope,$shape="person",$sprite="icon")',
  )!;
  const style = c4ElementStyleRecords(
    boundary,
    boundary.boundaries[0].resolution!.selectionId,
  )[0];
  expect(c4ElementStyleArgumentEffect(boundary, style.sourceKey, 1)).toBe(
    "stored",
  );
  expect(c4ElementStyleArgumentEffect(boundary, style.sourceKey, 2)).toBe(
    "spacing",
  );
});

test("partial C4 reconnect requires a style choice and preserves its actual effect on either chosen pair", () => {
  const source =
    'C4Dynamic\r\nPerson(web,"Web")\r\nPerson(api,"API")\r\nPerson(next,"Next")\r\nRel(web,api,"first")\r\n%% pair style\r\nUpdateRelStyle(web,api,$lineColor="blue",$offsetX="12.7px") %% style note\r\nRel(web,api,"last")\r\n';
  const model = parseMermaidC4Source(source)!;
  const records = model.sourceDocument.records.filter(
      (r) => r.kind === "relationship",
    ),
    style = model.sourceDocument.records.find(
      (r) => r.kind === "relationship-update",
    )!;
  for (const record of records) {
    expect(
      prepareC4RecordReconnect(model, record.sourceKey, "web", "next", null)
        .needsPolicy,
    ).toBe(true);
    for (const policy of ["keep", "transfer"] as const) {
      const prepared = prepareC4RecordReconnect(
        model,
        record.sourceKey,
        "web",
        "next",
        policy,
      );
      expect(prepared.draft).toBeDefined();
      expect(prepared.impact).toHaveLength(2);
      const result = reconnectC4Record(model, prepared.draft!, true);
      const chosen = result.model.relationships.find(
        (r) => r.to === (policy === "keep" ? "api" : "next"),
      )!;
      const other = result.model.relationships.find((r) => r !== chosen)!;
      expect(
        readC4RelationshipAppearance(
          result.model,
          chosen.resolution!.selectionId,
        ),
      ).toMatchObject({ lineColor: "blue", offsetX: 12 });
      expect(
        readC4RelationshipAppearance(
          result.model,
          other.resolution!.selectionId,
        ),
      ).toMatchObject({ lineColor: "", offsetX: 0 });
      expect(result.source).toContain(
        "%% pair style\r\nUpdateRelStyle(web," +
          (policy === "keep" ? "api" : '"next"') +
          ',$lineColor="blue",$offsetX="12.7px") %% style note',
      );
      expect(
        result.model.occurrences.find((o) => o.sourceKey === style.sourceKey)
          ?.applied,
      ).toBe(true);
      expect(reconnectC4Record(model, prepared.draft!, false).source).toBe(
        source,
      );
      expect(
        reconnectC4Record(result.model, prepared.draft!, true).source,
      ).toBe(result.source);
      expect(
        parseMermaidC4Source(result.source)!.relationships.find(
          (r) => r.to === chosen.to,
        )!.resolution!.fields.lineColor,
      ).toBe("blue");
      const removed = removeC4RelationshipStyleRecord(
        result.model,
        chosen.resolution!.selectionId,
        style.sourceKey,
        true,
      );
      expect(removed.source).toContain("%% pair style");
      expect(removed.source).toContain("%% style note");
      expect(
        readC4RelationshipAppearance(
          removed.model,
          chosen.resolution!.selectionId,
        ).lineColor,
      ).toBe("");
    }
  }
});

test("C4 typed delete distinguishes a declaration's remaining providers from complete alias/reference deletion", () => {
  const source =
    'C4Container\nBoundary(platform,"Platform") {\n%% first API\nContainer(api,"First","Rust") %% first note\n%% last API\nContainer(api,"Last","TS")\n}\nPerson(user,"User")\nRel(user,api,"Uses")\nUpdateElementStyle(api,$descr="Description")\nUpdateRelStyle(user,api,$lineColor="navy")';
  const model = parseMermaidC4Source(source)!,
    api = model.elements.find((e) => e.alias === "api")!,
    last = api.resolution!.sourceKeys.at(-1)!;
  const single = prepareC4Delete(model, {
    selectionId: api.resolution!.selectionId,
    recordKey: last,
  });
  expect(single.draft).toBeDefined();
  expect(
    single.result!.model.elements.find((e) => e.alias === "api")?.label,
  ).toBe("First");
  expect(
    single.result!.model.elements.find((e) => e.alias === "api")?.description,
  ).toBe("Description");
  expect(single.result!.model.relationships).toHaveLength(1);
  expect(
    single.draft!.impact.some(
      (i) =>
        i.field === "label" && i.nextProvider === api.resolution!.sourceKeys[0],
    ),
  ).toBe(true);
  const complete = prepareC4Delete(model, {
    selectionId: api.resolution!.selectionId,
  });
  expect(complete.draft).toBeDefined();
  const deleted = deleteC4(model, complete.draft!, true);
  expect(deleted.model.elements.map((e) => e.alias)).toEqual(["user"]);
  expect(deleted.model.relationships).toHaveLength(0);
  expect(
    deleted.model.occurrences.some(
      (o) => o.kind === "UpdateElementStyle" || o.kind === "UpdateRelStyle",
    ),
  ).toBe(false);
  expect(deleted.source).not.toContain("API");
  expect(deleted.source).not.toContain("note");
  expect(deleted.selection).toBe(model.boundaries[0].resolution!.selectionId);
  expect(parseMermaidC4Source(deleted.source)).not.toBeNull();
});

test("C4 boundary deletion adopts bound child records/comments or explicitly removes child aliases and references", () => {
  const source =
    'C4Container\r\nBoundary(target,"Target") {\r\n}\r\n%% platform owner\r\nBoundary(platform,"Platform") { %% header\r\n%% API owner\r\nContainer(api,"API","Rust") %% API note\r\nBoundary(nested,"Nested") {\r\nContainerDb(db,"DB","SQL")\r\n}\r\n%% closing scope\r\n}\r\nPerson(user,"User")\r\nRel(user,api,"Uses")\r\nUpdateElementStyle(api,$parentBoundary="platform",$descr="Keep")';
  const model = parseMermaidC4Source(source)!,
    platform = model.boundaries.find((b) => b.alias === "platform")!,
    parent = model.boundaries.find((b) => b.alias === "target")!,
    api = model.elements.find((e) => e.alias === "api")!;
  const prepare = prepareC4Delete(model, {
    selectionId: platform.resolution!.selectionId,
    children: {
      strategy: "adopt",
      parentKey: parent.resolution!.declarationKey,
    },
  });
  expect(prepare.draft).toBeDefined();
  const adopted = deleteC4(model, prepare.draft!, true);
  expect(adopted.model.boundaries.map((b) => b.alias)).toEqual([
    "target",
    "nested",
  ]);
  expect(
    adopted.model.elements.find((e) => e.alias === "api")?.boundaryId,
  ).toBe("target");
  expect(
    adopted.model.elements.find((e) => e.alias === "api")?.description,
  ).toBe("Keep");
  expect(adopted.model.elements.find((e) => e.alias === "db")?.boundaryId).toBe(
    "nested",
  );
  const oldComments = model.sourceDocument.records.filter(
    (r) =>
      r.kind === "comment" &&
      r.anchor?.sourceKey === api.resolution!.declarationKey,
  );
  expect(
    adopted.model.sourceDocument.records
      .filter((r) => oldComments.some((c) => c.sourceKey === r.sourceKey))
      .map((r) => r.anchor?.sourceKey),
  ).toEqual(oldComments.map(() => api.resolution!.declarationKey));
  expect(adopted.selection).toBe(parent.resolution!.selectionId);
  expect(adopted.source).not.toContain("platform");
  expect(adopted.source).not.toContain("closing scope");
  expect(adopted.source).toContain(
    'Container(api,"API","Rust") %% API note\r\n',
  );
  expect(
    prepareC4Delete(model, { selectionId: platform.resolution!.selectionId })
      .diagnostic,
  ).toBeTruthy();
  expect(
    prepareC4Delete(model, {
      selectionId: platform.resolution!.selectionId,
      children: {
        strategy: "adopt",
        parentKey: model.boundaries.find((b) => b.alias === "nested")!
          .resolution!.declarationKey,
      },
    }).diagnostic,
  ).toBeTruthy();
  const all = prepareC4Delete(model, {
    selectionId: platform.resolution!.selectionId,
    children: { strategy: "delete" },
  });
  expect(all.result!.model.boundaries.map((b) => b.alias)).toEqual(["target"]);
  expect(all.result!.model.elements.map((e) => e.alias)).toEqual(["user"]);
  expect(all.result!.model.relationships).toHaveLength(0);
  expect(all.draft!.removed.some((r) => r.call === "UpdateElementStyle")).toBe(
    true,
  );
});

test("the prepared C4 host previews without replacing the committed basis and applies through one guarded Source/GFX port", () => {
  installProjectedMermaidTestTheme();
  expect(mermaidC4Runtime.hostAdapter).toBe(mermaidC4HostAdapter);
  const original = 'C4Context\r\n  Person(user,"User") %% KEEP\r\n';
  let source = original,
    readonly = false;
  let visual = mermaidC4Runtime.parseSourceToGfxVisualModel(source, "c4")!;
  Object.assign(visual.nodes[0], { x: 991, y: 421, width: 300, height: 240 });
  const key = visual.nodes[0].id;
  const commits: Parameters<C4CommandPort["applyVisualModel"]>[] = [];
  const previews: (typeof visual)[] = [],
    selections: string[] = [];
  let disposed = 0;
  const consumer = createC4CommandConsumer({
    getSource: () => source,
    getReadonly: () => readonly,
    getVisualModel: () => visual,
    applyVisualModel: (next, options) => {
      commits.push([next, options]);
      source = options!.sourceWrite!.source;
      visual = next;
      return { applied: true };
    },
    previewVisualModel: (candidate) => {
      previews.push(candidate);
      return () => {
        disposed++;
      };
    },
    selectAfterProjection: (item) => selections.push(item.editKey),
  });
  const preview = consumer.previewCommand(
    "editC4ElementLabel",
    [key, "New label"],
    source,
  );
  expect(preview.feedback.diagnostic).toBeUndefined();
  expect(previews[0].nodes[0]).toMatchObject({
    id: key,
    label: "New label",
    x: 991,
    y: 421,
    width: 300,
    height: 240,
  });
  expect(source).toBe(original);
  expect(commits).toHaveLength(0);
  preview.dispose();
  expect(disposed).toBe(1);
  const result = consumer.onCommand(
    "editC4ElementLabel",
    [key, "New label"],
    source,
  );
  expect(result.changed).toBe(true);
  expect(source).toBe(original.replace('"User"', '"New label"'));
  expect(commits).toHaveLength(1);
  expect(commits[0][1]).toEqual({
    preserveSourceBytes: true,
    sourceWrite: { baseSource: original, source },
  });
  expect(selections).toEqual([key]);
  expect(
    consumer.onCommand("editC4ElementLabel", [key, "New label"], source)
      .changed,
  ).toBe(false);
  expect(
    consumer.onCommand("editC4ElementLabel", [key, "Stale"], original)
      .diagnostic,
  ).toBeTruthy();
  readonly = true;
  expect(
    consumer.previewCommand("editC4ElementLabel", [key, "Readonly"], source)
      .feedback.diagnostic,
  ).toBeTruthy();
  expect(
    consumer.onCommand("editC4ElementLabel", [key, "Readonly"], source)
      .diagnostic,
  ).toBeTruthy();
  expect(commits).toHaveLength(1);
  expect(previews).toHaveLength(1);
});

test("C4 commands retain all surviving live geometry when object counts change and pack only an explicit layout request", () => {
  installProjectedMermaidTestTheme();
  let source = 'C4Context\nBoundary(team,"Team") {\nPerson(user,"User")\n}';
  let visual = mermaidC4Runtime.parseSourceToGfxVisualModel(source, "c4")!;
  const nodeKey = visual.nodes[0].id,
    groupKey = visual.subgraphs![0].id;
  Object.assign(visual.nodes[0], { x: 1300, y: 1400, width: 240, height: 200 });
  Object.assign(visual.subgraphs![0], {
    x: 1100,
    y: 1200,
    width: 700,
    height: 600,
  });
  const consumer = createC4CommandConsumer({
    getSource: () => source,
    getReadonly: () => false,
    getVisualModel: () => visual,
    applyVisualModel: (next, options) => {
      source = options!.sourceWrite!.source;
      visual = next;
      return { applied: true };
    },
    selectAfterProjection: () => undefined,
  });
  expect(
    consumer.onCommand(
      "createC4Element",
      [{ kind: "Person", label: "Second", target: { parentKey: null } }],
      source,
    ).changed,
  ).toBe(true);
  expect(visual.nodes.find((n) => n.id === nodeKey)).toMatchObject({
    x: 1300,
    y: 1400,
    width: 240,
    height: 200,
  });
  expect(visual.subgraphs!.find((g) => g.id === groupKey)).toMatchObject({
    x: 1100,
    y: 1200,
    width: 700,
    height: 600,
  });
  expect(
    consumer.onCommand("editC4LayoutRows", [{ shapes: 2 }], source).changed,
  ).toBe(true);
  expect(visual.nodes.find((n) => n.id === nodeKey)).toMatchObject({
    width: 240,
    height: 200,
  });
  expect(visual.subgraphs!.find((g) => g.id === groupKey)!.x).not.toBe(1100);
});

test("C4 packs renderer-measured content with native width, padding, rows and spacing while excluding metadata", () => {
  installProjectedMermaidTestTheme();
  const metrics = vi
    .spyOn(gfxText, "measureTextInDOM")
    .mockImplementation((_family, size) => ({
      lineHeight: size * 1.2,
      lineGap: 0,
    }));
  try {
    const create = (description: string, metadata = "") => {
      const source = `---
config:
  c4:
    width: 240
    c4ShapePadding: 16
    c4ShapeMargin: 17
    diagramMarginX: 21
    diagramMarginY: 13
    nextLinePaddingX: 9
---
C4Container
Boundary(team,"Team") {
Container(a,"API","Rust","${description}"${metadata})
Container(b,"Client","React")
Container(c,"Worker","Rust")
}
UpdateLayoutConfig("2","1")
`;
      const parsed = parseMermaidC4Source(source)!;
      return c4ModelToGfxVisualModel({ ...parsed, ...layoutC4Diagram(parsed) });
    };
    const short = create("Short"),
      rich = create(
        "A long description with complete content and wrapping. ".repeat(30),
      );
    expect(short.subgraphs![0]).toMatchObject({ x: 21, y: 13 });
    const [a, b, c] = short.nodes;
    expect(a.width).toBe(240);
    expect(b.x - a.x - a.width).toBe(34);
    expect(c.x - a.x).toBe(9);
    expect(c.y - a.y - Math.max(a.height, b.height)).toBe(34);
    expect(rich.nodes[0].height).toBeGreaterThan(a.height * 2);
    expect(rich.nodes[2].y).toBeGreaterThan(c.y);
    const region = rich.nodes[0].details!.map((d) =>
      projectC4ContentElement(rich, rich.nodes[0], d),
    );
    expect(
      region.every(
        (p) =>
          p.relativeBound!.y + p.relativeBound!.height <= rich.nodes[0].height,
      ),
    ).toBe(true);
    expect(region[3].text.replaceAll(/\s/g, "")).toBe(
      "A long description with complete content and wrapping. "
        .repeat(30)
        .replaceAll(/\s/g, ""),
    );
    const tagged = create(
      "Short",
      ',$tags="' +
        "IGNORED ".repeat(80) +
        '",$link="https://example.invalid/metadata"',
    );
    expect(tagged.nodes.map((n) => [n.width, n.height, n.x, n.y])).toEqual(
      short.nodes.map((n) => [n.width, n.height, n.x, n.y]),
    );
  } finally {
    metrics.mockRestore();
  }
});

test("C4 reserves the actual Boundary sprite area and protects measured headers and routes without drawing a sprite", () => {
  installProjectedMermaidTestTheme();
  const metrics = vi
    .spyOn(gfxText, "measureTextInDOM")
    .mockImplementation((_family, size) => ({
      lineHeight: size * 1.2,
      lineGap: 0,
    }));
  try {
    const source = `C4Deployment
Node(host,"Host","Linux","Description","IGNORED") {
Container(a,"API","Rust")
Container(b,"DB","SQL")
}
Rel(a,b,"Uses")
`;
    const parsed = parseMermaidC4Source(source)!;
    const plain = c4ModelToGfxVisualModel({
      ...parsed,
      ...layoutC4Diagram(parsed),
    });
    const styledModel = parseMermaidC4Source(
      source + 'UpdateElementStyle(host,$sprite="unknown")\n',
    )!;
    const sprite = c4ModelToGfxVisualModel({
      ...styledModel,
      ...layoutC4Diagram(styledModel),
    });
    const group = sprite.subgraphs![0];
    expect(
      c4BoundaryHeaderHeight(group) -
        c4BoundaryHeaderHeight(plain.subgraphs![0]),
    ).toBe(48);
    expect(sprite.nodes[0].y - plain.nodes[0].y).toBe(48);
    const header = projectC4BoundaryElement(sprite, group);
    expect(header).toMatchObject({
      strokeStyle: "solid",
      strokeWidth: 1,
      filled: false,
    });
    expect(
      header.padding![0] -
        projectC4BoundaryElement(plain, plain.subgraphs![0]).padding![0],
    ).toBe(48);
    expect(header.text).not.toMatch(/IGNORED|unknown/);
    const edge = projectC4RelationshipElement(sprite, sprite.edges[0]);
    expect(edge.endpointScale).toBe(0.4);
    expect(edge.routingObstacleRegions![group.id][3]).toBe(
      c4BoundaryHeaderHeight(group),
    );
    expect(edge.labelObstacleKeys).toEqual(sprite.nodes.map((n) => n.id));
    expect(
      mermaidC4Runtime.gfxHooks!.hooks.minimumReadableZoom!(sprite, 0.5),
    ).toBe(1);
    const repeated = parseMermaidC4Source(
      source + 'Boundary(host,"Repeated") {\n}\n',
    )!;
    const repeatedVisual = c4ModelToGfxVisualModel({
      ...repeated,
      ...layoutC4Diagram(repeated),
    });
    // Replacing the declaration spelling does not clear native nodeType.
    expect(
      projectC4BoundaryElement(repeatedVisual, repeatedVisual.subgraphs![0])
        .strokeStyle,
    ).toBe("solid");
    const boundaryModel = parseMermaidC4Source(
      'C4Context\nBoundary(team,"Team") {\n}\n',
    )!;
    const boundaryVisual = c4ModelToGfxVisualModel({
      ...boundaryModel,
      ...layoutC4Diagram(boundaryModel),
    });
    expect(
      projectC4BoundaryElement(boundaryVisual, boundaryVisual.subgraphs![0]),
    ).toMatchObject({ strokeStyle: "dash", filled: false });
  } finally {
    metrics.mockRestore();
  }
});

test("C4 measures changed content at its retained manual width and consumes an explicit native width edit", () => {
  installProjectedMermaidTestTheme();
  const metrics = vi
    .spyOn(gfxText, "measureTextInDOM")
    .mockImplementation((_family, size) => ({
      lineHeight: size * 1.2,
      lineGap: 0,
    }));
  try {
    let source = 'C4Container\nContainer(api,"API","Rust")\n';
    let visual = mermaidC4Runtime.parseSourceToGfxVisualModel(source, "c4")!;
    Object.assign(visual.nodes[0], { x: 821, y: 432, width: 150, height: 100 });
    const consumer = createC4CommandConsumer({
      getSource: () => source,
      getReadonly: () => false,
      getVisualModel: () => visual,
      applyVisualModel: (next, options) => {
        visual = next;
        source = options!.sourceWrite!.source;
        return { applied: true };
      },
      selectAfterProjection: () => {},
    });
    expect(
      consumer.onCommand(
        "editC4ElementLabel",
        [visual.nodes[0].id, "Long API label with wrapping ".repeat(12)],
        source,
      ).changed,
    ).toBe(true);
    expect(visual.nodes[0]).toMatchObject({ x: 821, y: 432, width: 150 });
    for (const detail of visual.nodes[0].details!) {
      const p = projectC4ContentElement(visual, visual.nodes[0], detail);
      expect(p.relativeBound!.y + p.relativeBound!.height).toBeLessThanOrEqual(
        visual.nodes[0].height,
      );
    }
    expect(
      consumer.onCommand("editC4Configuration", [{ width: 280 }], source)
        .changed,
    ).toBe(true);
    expect(visual.nodes[0].width).toBe(280);
  } finally {
    metrics.mockRestore();
  }
});

test("C4 header preview and apply retain physical records and bindings while showing Dynamic effects", () => {
  installProjectedMermaidTestTheme();
  const original =
    '  C4Container %% KEEP\r\nBoundary(team,"Team") {\r\nContainer(api,"API","Rust") %% owner\r\n}\r\nPerson(user,"User")\r\nRel(user,api,"Uses")';
  let source = original,
    visual = mermaidC4Runtime.parseSourceToGfxVisualModel(source, "c4")!;
  const initial = readC4ProjectionModel(source, visual)!,
    keys = initial.sourceDocument.records.map((r) => r.sourceKey);
  const commits = vi.fn((next, options) => {
    visual = next;
    source = options.sourceWrite.source;
    return { applied: true };
  });
  const previews: (typeof visual)[] = [];
  const consumer = createC4CommandConsumer({
    getSource: () => source,
    getReadonly: () => false,
    getVisualModel: () => visual,
    applyVisualModel: commits,
    previewVisualModel: (next) => {
      previews.push(next);
      return () => {};
    },
    selectAfterProjection: () => {},
  });
  const preview = consumer.previewCommand(
    "changeC4Header",
    ["C4Dynamic"],
    source,
  );
  expect(previews[0].edges[0].displayLabel).toBe("1: Uses");
  expect(source).toBe(original);
  expect(commits).not.toHaveBeenCalled();
  preview.dispose();
  expect(
    consumer.onCommand("changeC4Header", ["C4Dynamic"], source).changed,
  ).toBe(true);
  expect(source).toBe(original.replace("C4Container", "C4Dynamic"));
  expect(
    readC4ProjectionModel(source, visual)!.sourceDocument.records.map(
      (r) => r.sourceKey,
    ),
  ).toEqual(keys);
  let current = readC4ProjectionModel(source, visual)!;
  for (const header of C4_HEADERS) {
    const next = changeC4Header(current, header);
    expect(next.model.elements.map((e) => e.alias)).toEqual(
      initial.elements.map((e) => e.alias),
    );
    expect(next.model.boundaries.map((b) => b.alias)).toEqual(
      initial.boundaries.map((b) => b.alias),
    );
    expect(next.model.relationships.map((r) => [r.from, r.to])).toEqual(
      initial.relationships.map((r) => [r.from, r.to]),
    );
    current = next.model;
  }
  const catalog = c4ActionCatalog({
    model: current,
    readonly: false,
    displayOnly: false,
  });
  expect(catalog.map((a) => a.intent)).toEqual([
    "header",
    "addElement",
    "emptyBoundary",
    "relation",
    "comments",
    "more",
  ]);
  expect(
    c4ActionCatalog({ model: current, readonly: true, displayOnly: false }),
  ).toEqual([]);
  expect(
    c4ActionCatalog({ model: current, readonly: false, displayOnly: true }),
  ).toEqual([]);
});

test("C4 groups the complete Source selection once while retaining live geometry, identities and directed ends", () => {
  installProjectedMermaidTestTheme();
  let source =
    'C4Container\n%% early update\nUpdateElementStyle(a, "red")\n%% A owner\nContainer(a,"A","Rust") %% inline\nContainer(near,"Nearby","Rust")\nContainer(b,"B","Rust")\nRel(a,b,"Uses")\n';
  const original = source;
  let visual = mermaidC4Runtime.parseSourceToGfxVisualModel(source, "c4")!;
  visual.nodes.forEach((node, i) => {
    node.x = 700 + i * 350;
    node.y = 480 + i * 50;
  });
  const before = visual.nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
  }));
  const model = readC4ProjectionModel(source, visual)!;
  const ids = [
    model.elements.find((e) => e.alias === "a")!,
    model.elements.find((e) => e.alias === "b")!,
  ].map((e) => e.resolution!.selectionId);
  const prepared = prepareC4Grouping(model, ids, {
    kind: "Container_Boundary",
    label: "Services",
  });
  expect(prepared.diagnostic).toBeUndefined();
  expect(prepared.draft!.objects.map((o) => o.alias)).toEqual(["a", "b"]);
  expect(prepared.draft!.records.map((r) => r.call)).toContain(
    "UpdateElementStyle",
  );
  expect(groupC4Elements(model, prepared.draft!, false).source).toBe(original);
  const apply = vi.fn((next, options) => {
    visual = next;
    source = options.sourceWrite.source;
    return { applied: true };
  });
  const consumer = createC4CommandConsumer({
    getSource: () => source,
    getReadonly: () => false,
    getVisualModel: () => visual,
    applyVisualModel: apply,
    selectAfterProjection: () => {},
  });
  expect(
    consumer.onCommand("groupC4Elements", [prepared.draft!, true], original)
      .changed,
  ).toBe(true);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(
    visual.nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
    })),
  ).toEqual(expect.arrayContaining(before));
  const boundary = visual.subgraphs![0];
  expect(boundary.nodeIds).toEqual(ids);
  for (const id of ids) {
    const n = visual.nodes.find((n) => n.id === id)!;
    expect(boundary.x).toBeLessThan(n.x);
    expect(boundary.y).toBeLessThan(n.y);
    expect(boundary.x + boundary.width).toBeGreaterThan(n.x + n.width);
    expect(boundary.y + boundary.height).toBeGreaterThan(n.y + n.height);
  }
  const after = readC4ProjectionModel(source, visual)!;
  expect(after.relationships.map((r) => [r.from, r.to])).toEqual([["a", "b"]]);
  expect(after.elements.find((e) => e.alias === "near")!.boundaryId).toBe("");
  expect(
    after.occurrences.find((o) => o.kind === "UpdateElementStyle")!.applied,
  ).toBe(false);
  expect(after.elements.map((e) => e.resolution!.selectionId).sort()).toEqual(
    model.elements.map((e) => e.resolution!.selectionId).sort(),
  );
  expect(source).toContain('%% A owner\nContainer(a,"A","Rust") %% inline');
  expect(groupC4Elements(after, prepared.draft!, true).status).toBe("invalid");
  expect(
    readC4ProjectionModel(original, visual)!.elements.map((e) => e.alias),
  ).toEqual(["a", "near", "b"]);
});

test("C4 atomic batch deletion consumes exactly selected owners and previews complete adoption impact", () => {
  const original =
    'C4Container\nBoundary(team,"Team") {\nContainer(a,"A","Rust")\n}\nContainer(b,"B","Rust")\nContainer(keep,"Keep","Rust")\nRel(a,b,"Uses")\n';
  const model = parseMermaidC4Source(original)!;
  const target = (alias: string) => ({
    selectionId: model.elements.find((e) => e.alias === alias)!.resolution!
      .selectionId,
  });
  const prepared = prepareC4BatchDelete(model, [target("a"), target("b")]);
  expect(prepared.diagnostic).toBeUndefined();
  expect(prepared.result!.model.elements.map((e) => e.alias)).toEqual(["keep"]);
  expect(prepared.result!.model.relationships).toEqual([]);
  expect(prepared.result!.model.boundaries.map((b) => b.alias)).toEqual([
    "team",
  ]);
  expect(deleteC4Selection(model, prepared.draft!, false).source).toBe(
    original,
  );
  expect(
    prepareC4BatchDelete(model, [target("a"), { selectionId: "missing" }])
      .draft,
  ).toBeUndefined();
  const adopt = prepareC4BatchDelete(model, [
    {
      selectionId: model.boundaries[0].resolution!.selectionId,
      children: { strategy: "adopt", parentKey: null },
    },
    target("b"),
  ]);
  expect(
    adopt.result!.model.elements.map((e) => [e.alias, e.boundaryId]),
  ).toEqual([
    ["keep", ""],
    ["a", ""],
  ]);
  expect(adopt.draft!.moved.map((r) => r.call)).toContain("Container");
  expect(adopt.draft!.moved[0]).toMatchObject({
    beforeScope: ["team"],
    afterScope: [],
  });
});

test("registered C4 parsing, measured content and nested membership preserve Source semantics", () => {
  installProjectedMermaidTestTheme();
  const c4 = mermaidC4Family.parseSource(
    'C4Context\n  Person(user, "User")\n  System(myoxus, "Myoxus", "Docs")\n  Rel(user, myoxus, "Uses")\n',
    "c4",
  );
  const c4State = mermaidC4Family.toVisualModel(c4);
  expect(c4State.kind).toBe("editable");
  if (c4State.kind !== "editable") return;
  expect(c4State.visualModel.diagramType).toBe("c4");
  if (c4State.visualModel.diagramType !== "c4") return;
  expect(c4State.visualModel.elements.map(({ kind }) => kind)).toEqual([
    "Person",
    "System",
  ]);
  expect(c4State.visualModel.relationships[0]?.label).toBe("Uses");
  const c4Gfx = parseMermaidSourceToGfxVisualModel(
    'C4Context\n  Person(user, "User")\n  System(myoxus, "Myoxus", "Docs")\n  Rel(user, myoxus, "Uses")\n',
  );
  const [userElement, systemElement] = c4Gfx.model!.nodes;
  expect(systemElement.x).toBeGreaterThanOrEqual(
    userElement.x + userElement.width,
  );
  expect(c4Gfx.model?.edges[0]).toMatchObject({
    connectorMode: "straight",
    labelPlacement: "top",
    sourcePosition: [1, 0.5],
    targetPosition: [0, 0.5],
  });
  const c4DatabaseGfx = parseMermaidSourceToGfxVisualModel(
    'C4Context\n  ContainerDb(app, "Workspace App", "Workspace", "Postgres")\n',
  );
  expect(c4NodeGfxData(c4DatabaseGfx.model!.nodes[0])).toMatchObject({
    kind: "ContainerDb",
  });
  expect(c4DatabaseGfx.model!.nodes[0]).toMatchObject({
    label: "Workspace App",
    shape: "database",
  });
  const database = c4DatabaseGfx.model!.nodes[0];
  const contentRegion = c4ContentRegion(database);
  const content = database.details!.map((detail) =>
    projectC4ContentElement(c4DatabaseGfx.model!, database, detail),
  );
  expect(content).toHaveLength(4);
  expect(contentRegion.height).toBeGreaterThanOrEqual(0);
  for (const carrier of content) {
    expect(carrier.relativeBound!.y).toBeGreaterThanOrEqual(contentRegion.y);
    expect(
      carrier.relativeBound!.y + carrier.relativeBound!.height,
    ).toBeLessThanOrEqual(contentRegion.y + contentRegion.height);
  }
  const c4BoundarySource = [
    "C4Container",
    '  System_Boundary(apps, "Workspace") {',
    '    Container(app, "App", "Web UI")',
    '    ContainerDb(db, "Database", "Workspace data", "Postgres")',
    "  }",
    '  Rel(app, db, "Reads", "SQL")',
  ].join("\n");
  const c4BoundaryGfx = parseMermaidSourceToGfxVisualModel(c4BoundarySource);
  expect(c4BoundaryGfx.model?.subgraphs?.[0]).toMatchObject({
    id: c4ProjectionSelectionId(c4BoundaryGfx.model!, "boundary", "apps"),
    nodeIds: [
      c4ProjectionSelectionId(c4BoundaryGfx.model!, "element", "app"),
      c4ProjectionSelectionId(c4BoundaryGfx.model!, "element", "db"),
    ],
  });
  expect(c4BoundaryGfx.model?.subgraphs?.[0]?.title).toContain("Workspace");
  expect(
    c4BoundaryGfx.model
      ? generateMermaidSourceFromGfxVisualModel(
          c4BoundarySource,
          c4BoundaryGfx.model,
        )
      : "",
  ).toContain('System_Boundary(apps, "Workspace") {');
  const nestedC4BoundarySource = [
    "C4Container",
    '  System_Boundary(workspace, "Workspace") {',
    '    Container_Boundary(frontend, "Frontend") {',
    '      Container(app, "App", "Web UI")',
    "    }",
    '    ContainerDb(db, "Database", "Workspace data", "Postgres")',
    "  }",
  ].join("\n");
  const nestedC4BoundaryGfx = parseMermaidSourceToGfxVisualModel(
    nestedC4BoundarySource,
  );
  const workspaceBoundary = nestedC4BoundaryGfx.model?.subgraphs?.find(
    ({ id }) =>
      id ===
      c4ProjectionSelectionId(
        nestedC4BoundaryGfx.model!,
        "boundary",
        "workspace",
      ),
  );
  const frontendBoundary = nestedC4BoundaryGfx.model?.subgraphs?.find(
    ({ id }) =>
      id ===
      c4ProjectionSelectionId(
        nestedC4BoundaryGfx.model!,
        "boundary",
        "frontend",
      ),
  );
  expect(workspaceBoundary).toMatchObject({
    id: c4ProjectionSelectionId(
      nestedC4BoundaryGfx.model!,
      "boundary",
      "workspace",
    ),
  });
  expect(workspaceBoundary?.title).toContain("Workspace");
  expect(frontendBoundary).toMatchObject({
    id: c4ProjectionSelectionId(
      nestedC4BoundaryGfx.model!,
      "boundary",
      "frontend",
    ),
    nodeIds: [
      c4ProjectionSelectionId(nestedC4BoundaryGfx.model!, "element", "app"),
    ],
  });
  expect(c4BoundaryGfxData(frontendBoundary!)).toMatchObject({
    boundaryKind: "Container_Boundary",
  });
  expect(frontendBoundary?.title).toContain("Frontend");
  expect(frontendBoundary?.x).toBeGreaterThanOrEqual(
    workspaceBoundary?.x ?? Number.POSITIVE_INFINITY,
  );
  expect(
    nestedC4BoundaryGfx.model
      ? generateMermaidSourceFromGfxVisualModel(
          nestedC4BoundarySource,
          nestedC4BoundaryGfx.model,
        )
      : "",
  ).toContain('Container_Boundary(frontend, "Frontend") {');
});
