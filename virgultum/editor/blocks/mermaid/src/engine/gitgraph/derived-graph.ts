// SPDX-License-Identifier: AGPL-3.0-or-later
import { encodeGitGraphNativeEntities } from "./runtime-contract.js";
import DOMPurify from "dompurify";
import type {
  GitGraphSourceDocument,
  GitGraphRecord,
} from "./source-document.js";
import type {
  GitGraphCommitOccurrence,
  GitGraphDerivedGraph,
  GitGraphStatementContext,
  MermaidGitBranch,
  MermaidGitEvent,
  MermaidGitGraphModel,
  MermaidGitSourceCommitType,
} from "./model.js";
import { readGitGraphConfig } from "./config.js";
import { hashMermaidSource } from "../source-hash.js";
import type { GitGraphDiagnosticCode } from "./diagnostics.js";

export const gitGraphAttribute = (r: GitGraphRecord, name: string) =>
  r.attributes.findLast((a) => a.name === name)?.value;
/** The bound native DB sanitizes strings before ID-map and branch comparisons.
 * Raw lexemes remain in Source; sanitized text is never written back implicitly. */
export function gitGraphSanitizeNativeValue(
  value: string,
  config: Readonly<Record<string, unknown>> = {},
) {
  let text = value;
  const flowchart = config.flowchart as { htmlLabels?: unknown } | undefined,
    labels = config.htmlLabels ?? flowchart?.htmlLabels ?? true,
    html = labels !== false && labels !== "false";
  if (html) {
    const level = config.securityLevel;
    if (["antiscript", "strict", "sandbox"].includes(String(level)))
      text = DOMPurify.sanitize(text);
    else if (level !== "loose")
      text = text
        .replace(/<br\s*\/?>/gi, "#br#")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("=", "&equals;")
        .replaceAll("#br#", "<br/>");
  }
  return DOMPurify.sanitize(
    text,
    config.dompurifyConfig && typeof config.dompurifyConfig === "object"
      ? (config.dompurifyConfig as import("dompurify").Config)
      : { FORBID_TAGS: ["style"] },
  );
}
export function gitGraphRuntimeText(
  value: string,
  config: Readonly<Record<string, unknown>> = {},
) {
  return gitGraphSanitizeNativeValue(
    encodeGitGraphNativeEntities(value),
    config,
  );
}
export function gitGraphAttributeRuntimeValue(
  record: GitGraphRecord,
  name: string,
  config: Readonly<Record<string, unknown>> = {},
) {
  const a = record.attributes.findLast((a) => a.name === name);
  return a ? gitGraphSanitizeNativeValue(a.nativeValue ?? a.value, config) : "";
}
export function gitGraphReferenceRuntimeValue(
  record: GitGraphRecord,
  config: Readonly<Record<string, unknown>> = {},
) {
  return record.reference
    ? gitGraphSanitizeNativeValue(
        record.reference.nativeValue ?? record.reference.value,
        config,
      )
    : "";
}
export function deriveGitGraph(document: GitGraphSourceDocument) {
  const configRead = readGitGraphConfig(document),
    config = configRead.config,
    sanitize = (value: string) =>
      gitGraphSanitizeNativeValue(value, configRead.nativeConfig),
    attribute = (record: GitGraphRecord, name: string) =>
      gitGraphAttributeRuntimeValue(record, name, configRead.nativeConfig),
    reference = (record: GitGraphRecord) =>
      gitGraphReferenceRuntimeValue(record, configRead.nativeConfig),
    header = document.records.find((r) => r.kind === "header");
  const mainReferenceable =
    !Object.hasOwn(configRead.nativeConfig, "mainBranchName") ||
    typeof configRead.nativeConfig.mainBranchName === "string";
  // Native non-string DB keys cannot equal any parsed string Reference. Use
  // the header binding for their editor lane, reserving authored branch names.
  const declaredNames = new Set(
    document.records.filter((r) => r.kind === "branch").map(reference),
  );
  // Symbolic runtime IDs stand in for native randomness. Authored IDs or
  // references must never resolve one accidentally, including later records.
  const reservedCommitIds = new Set(
    document.records.flatMap((r) => [
      attribute(r, "id"),
      attribute(r, "parent"),
    ]),
  );
  let main = mainReferenceable
    ? config.mainBranchName
    : `${header?.sourceKey}:main`;
  while (!mainReferenceable && declaredNames.has(main)) main += ":main";
  const branches: MermaidGitBranch[] = [
      {
        id: main,
        name: config.mainBranchName,
        referenceable: mainReferenceable,
        declaredOrder: config.mainBranchOrder,
        sourceKey: header?.sourceKey,
        order: 0,
        y: 0,
      },
    ],
    heads = new Map<string, string | null>([[main, null]]),
    map = new Map<string, GitGraphCommitOccurrence>();
  const occurrences: GitGraphCommitOccurrence[] = [],
    contexts: GitGraphStatementContext[] = [],
    events: MermaidGitEvent[] = [],
    diagnostics = [
      ...document.diagnostics,
      ...configRead.diagnostics.map((d) => ({
        stage: d.stage ?? ("syntax" as const),
        severity: d.severity,
        code: d.code,
        sourceKey: d.record.sourceKey,
        range: d.record.range,
        message: d.message,
        reference: d.reference,
      })),
    ];
  let active = main,
    head: GitGraphCommitOccurrence | null = null,
    abortedAt: string | undefined;
  const context = (key: string): GitGraphStatementContext => {
    const count = occurrences.length;
    return {
      sourceKey: key,
      branch: active,
      head: head?.sourceKey ?? null,
      // Resolve only when a control needs this temporal map. Copying a full map
      // for every physical record would retain quadratic state while typing.
      get commitIds() {
        return new Map(
          occurrences.slice(0, count).map((c) => [c.runtimeId, c.sourceKey]),
        );
      },
      branchHeads: new Map(
        [...heads].map(([name, id]) => [
          name,
          id === null ? null : (map.get(id)?.sourceKey ?? null),
        ]),
      ),
    };
  };
  const error = (
    r: GitGraphRecord,
    code: GitGraphDiagnosticCode,
    reference: string,
    message: string,
  ) => {
    diagnostics.push({
      stage: "runtime",
      severity: "error",
      code,
      sourceKey: r.sourceKey,
      range: r.reference?.range ?? r.range,
      reference,
      message,
    });
    abortedAt = r.sourceKey;
  };
  const resolveParents = (ids: string[]) =>
    ids.map((id) => map.get(id)?.sourceKey ?? `unresolved:${id}`);
  const add = (
    r: GitGraphRecord,
    kind: GitGraphCommitOccurrence["kind"],
    other?: GitGraphCommitOccurrence,
    sourceId = "",
  ) => {
    const authoredId = kind !== "cherry-pick" && attribute(r, "id");
    let runtimeId = authoredId || `implicit:${r.sourceKey}`;
    while (!authoredId && reservedCommitIds.has(runtimeId))
      runtimeId += ":implicit";
    const ownTags = r.attributes
      .filter((a) => a.name === "tag")
      .map((a) =>
        kind === "merge"
          ? (a.nativeValue ?? a.value)
          : sanitize(a.nativeValue ?? a.value),
      );
    const parentReferences = head
      ? [head.runtimeId, ...(other ? [other.runtimeId] : [])]
      : [];
    const referenceable = kind !== "cherry-pick" && !!attribute(r, "id");
    const previous = map.get(runtimeId);
    if (previous) previous.shadowed = true;
    const typeOverride = gitGraphAttribute(r, "type") as
      MermaidGitSourceCommitType | undefined;
    const c: GitGraphCommitOccurrence = {
      sourceKey: r.sourceKey,
      runtimeId,
      referenceable,
      shadowed: false,
      executionParents: resolveParents(parentReferences),
      parentReferences,
      // Only Source occurrence keys identify carriers. Runtime names are confined
      // to evaluation; generated cherry output never reuses its source ID.
      id:
        referenceable && !previous
          ? runtimeId
          : referenceable
            ? r.sourceKey
            : `git-commit-${occurrences.length + 1}`,
      branchId: active,
      customType: kind === "merge" ? (typeOverride ?? null) : null,
      kind,
      order: occurrences.length,
      message:
        kind === "commit"
          ? attribute(r, "message")
          : kind === "merge"
            ? `merged branch ${other?.branchId} into ${active}`
            : `cherry-picked ${other?.message} into ${active}`,
      parents: [],
      sourceId,
      tags:
        kind !== "cherry-pick"
          ? ownTags
          : r.attributes.some((a) => a.name === "tag")
            ? ownTags.filter(Boolean)
            : [
                `cherry-pick:${other?.runtimeId}${other?.kind === "merge" ? `|parent:${attribute(r, "parent")}` : ""}`,
              ],
      type:
        kind === "merge"
          ? "MERGE"
          : kind === "cherry-pick"
            ? "CHERRY_PICK"
            : (typeOverride ?? "NORMAL"),
      typeExplicit: !!typeOverride,
      x: 0,
      y: 0,
    };
    occurrences.push(c);
    map.set(runtimeId, c);
    head = c;
    heads.set(active, runtimeId);
    return c;
  };
  if (!header)
    diagnostics.push({
      stage: "syntax",
      severity: "error",
      code: "gitgraph.header",
      sourceKey: document.records[0]?.sourceKey ?? "",
      range: document.records[0]?.range ?? { start: 0, end: 0, line: 1 },
      message: "Add a gitGraph header.",
    });
  for (const r of document.records) {
    contexts.push(context(r.sourceKey));
    if (
      !r.complete ||
      diagnostics.some((d) => d.stage === "syntax" && d.severity === "error")
    ) {
      abortedAt = r.sourceKey;
      break;
    }
    if (r.kind === "branch") {
      const name = reference(r);
      if (heads.has(name)) {
        error(
          r,
          "gitgraph.branch.duplicate",
          name,
          `Branch ${name} already exists. Choose another name or checkout the existing branch.`,
        );
        break;
      }
      const order = gitGraphAttribute(r, "order"),
        branchOrder = order === undefined ? null : Number(order);
      branches.push({
        id: name,
        name: r.reference?.value ?? "",
        declaredOrder: branchOrder,
        sourceKey: r.sourceKey,
        order: branches.length,
        y: 0,
      });
      heads.set(name, head?.runtimeId ?? null);
      events.push({
        kind: "branch",
        order: events.length,
        branchId: active,
        targetBranchId: name,
        branchOrder,
      });
      active = name;
      head = head ? (map.get(head.runtimeId) ?? null) : null;
      continue;
    }
    if (r.kind === "checkout") {
      const name = reference(r);
      if (!heads.has(name) || (!mainReferenceable && name === main)) {
        error(
          r,
          "gitgraph.branch.missing",
          name,
          `Branch ${name} does not exist at this checkout. Create it first or choose an existing branch.`,
        );
        break;
      }
      active = name;
      const id = heads.get(name);
      head = id ? (map.get(id) ?? null) : null;
      events.push({
        kind: "checkout",
        order: events.length,
        branchId: active,
        targetBranchId: active,
        keyword: r.keyword === "switch" ? "switch" : "checkout",
      });
      continue;
    }
    if (r.kind === "commit") {
      const c = add(r, "commit", undefined, gitGraphAttribute(r, "id") ?? "");
      events.push({ kind: "commit", order: events.length, commitId: c.id });
      continue;
    }
    if (r.kind === "merge") {
      const name = reference(r),
        currentId = heads.get(active),
        otherId = heads.get(name),
        current = currentId ? map.get(currentId) : undefined,
        other = otherId ? map.get(otherId) : undefined,
        customId = attribute(r, "id");
      if (
        (mainReferenceable || name !== main) &&
        ((current && other && current.branchId === name) || active === name)
      ) {
        error(
          r,
          "gitgraph.merge.self",
          name,
          "A merge cannot merge a branch into itself.",
        );
        break;
      }
      if (!current) {
        error(
          r,
          "gitgraph.merge.current-head",
          active,
          `Current branch ${active} needs a commit before merging.`,
        );
        break;
      }
      if (!heads.has(name) || (!mainReferenceable && name === main)) {
        error(
          r,
          "gitgraph.branch.missing",
          name,
          `Create branch ${name} before merging it.`,
        );
        break;
      }
      if (!other) {
        error(
          r,
          "gitgraph.merge.other-head",
          name,
          `Branch ${name} needs a commit before merging.`,
        );
        break;
      }
      if (current === other) {
        error(
          r,
          "gitgraph.merge.same-head",
          name,
          "Both branches have the same head. Add a commit before merging.",
        );
        break;
      }
      if (customId && map.has(customId)) {
        error(
          r,
          "gitgraph.merge.id-duplicate",
          customId,
          `Commit ${customId} already exists. Choose another merge ID.`,
        );
        break;
      }
      const c = add(r, "merge", other, gitGraphAttribute(r, "id") ?? "");
      events.push({
        kind: "merge",
        order: events.length,
        commitId: c.id,
        branchId: active,
        targetBranchId: name,
        customId: c.sourceId,
        tags: r.attributes.filter((a) => a.name === "tag").map((a) => a.value),
        type: c.customType,
      });
      continue;
    }
    if (r.kind === "cherry-pick") {
      const id = attribute(r, "id"),
        parent = attribute(r, "parent"),
        other = map.get(id),
        currentId = heads.get(active);
      if (!id || !other) {
        error(
          r,
          "gitgraph.cherry.source",
          id,
          "Choose a source commit with an explicit ID that exists at this statement.",
        );
        break;
      }
      if (parent && !other.parentReferences.includes(parent)) {
        error(
          r,
          "gitgraph.cherry.parent",
          parent,
          "Choose an immediate parent of the source commit.",
        );
        break;
      }
      if (other.kind === "merge" && !parent) {
        error(
          r,
          "gitgraph.cherry.merge-parent",
          id,
          "A merge source needs an explicit immediate parent.",
        );
        break;
      }
      if (other.branchId === active) {
        error(
          r,
          "gitgraph.cherry.same-branch",
          active,
          "Cherry-pick needs a source on another branch.",
        );
        break;
      }
      if (!currentId || !map.get(currentId)) {
        error(
          r,
          "gitgraph.cherry.head",
          active,
          "Add a commit on the current branch before cherry-picking.",
        );
        break;
      }
      const c = add(r, "cherry-pick", other);
      events.push({
        kind: "cherry-pick",
        order: events.length,
        commitId: c.id,
        branchId: active,
        sourceCommitId: gitGraphAttribute(r, "id") ?? "",
        parentCommitId: gitGraphAttribute(r, "parent") ?? "",
        tags: r.attributes.filter((a) => a.name === "tag").map((a) => a.value),
      });
    }
  }
  const effective = [...map.values()];
  for (const c of occurrences) {
    c.parents = c.parentReferences.map(
      (id) => map.get(id)?.id ?? `unresolved:${id}`,
    );
    if (c.shadowed)
      diagnostics.push({
        stage: "render",
        severity: "warning",
        code: "gitgraph.commit.shadowed",
        sourceKey: c.sourceKey,
        range: document.records.find((r) => r.sourceKey === c.sourceKey)!.range,
        reference: c.sourceId,
        message: `Commit ${c.sourceId} is overwritten later; its execution and Source record remain.`,
      });
  }
  const colors = new Map<string, number>();
  const visit = (root: GitGraphCommitOccurrence): boolean => {
    if (colors.get(root.sourceKey) === 2) return true;
    const stack: Array<{ commit: GitGraphCommitOccurrence; next: number }> = [
      { commit: root, next: 0 },
    ];
    colors.set(root.sourceKey, 1);
    while (stack.length) {
      const frame = stack.at(-1)!;
      if (frame.next === frame.commit.parentReferences.length) {
        colors.set(frame.commit.sourceKey, 2);
        stack.pop();
        continue;
      }
      const parent = map.get(frame.commit.parentReferences[frame.next++]!);
      if (!parent || colors.get(parent.sourceKey) === 1) return false;
      if (colors.get(parent.sourceKey) === 2) continue;
      colors.set(parent.sourceKey, 1);
      stack.push({ commit: parent, next: 0 });
    }
    return true;
  };
  for (const c of effective)
    if (!visit(c)) {
      diagnostics.push({
        stage: "render",
        severity: "error",
        code: "gitgraph.parents.cycle",
        sourceKey: c.sourceKey,
        range: document.records.find((r) => r.sourceKey === c.sourceKey)!.range,
        reference: c.sourceId,
        message:
          "The effective commit map contains an unresolved or cyclic parent. Rename the overwriting ID with reference impact.",
      });
      break;
    }
  const graph: GitGraphDerivedGraph = {
    occurrences,
    sanitization: configRead.nativeConfig,
    effectiveMap: map,
    contexts,
    finalContext: context("end"),
    diagnostics,
    abortedAt,
  };
  const directives = document.records
    .filter((r) => r.kind === "frontmatter" || r.kind === "directive")
    .flatMap((r) => r.raw.split(/\r\n|\r|\n/));
  const metadata = (kind: GitGraphRecord["kind"]) =>
    document.records.findLast((r) => r.kind === kind)?.value ?? "";
  const model: MermaidGitGraphModel = {
    accessibilityDescription: metadata("accessibility-description"),
    accessibilityTitle: metadata("accessibility-title"),
    branches,
    commits: effective,
    diagramTitle: metadata("title") || readGitGraphConfig(document).title,
    diagramType: "gitGraph",
    direction: (header?.value ?? "LR") as MermaidGitGraphModel["direction"],
    directives,
    events,
    explicitDirection: /\b(LR|TB|BT)\b/.test(header?.raw ?? ""),
    headerLine: header?.raw.trim() ?? "gitGraph",
    mainBranchName: config.mainBranchName,
    mainBranchId: main,
    mainBranchOrder: config.mainBranchOrder,
    operations: events.flatMap((e) =>
      e.kind === "commit" ? [] : [{ ...e, id: `git-operation-${e.order + 1}` }],
    ),
    sourceAnnotations: document.records
      .filter((r) => r.kind === "comment")
      .map((r) => r.raw.trim()),
    sourceHash: hashMermaidSource(document.source),
    version: 1,
    sourceDocument: document,
    derivedGraph: graph,
  };
  return { model, graph, diagnostics };
}
