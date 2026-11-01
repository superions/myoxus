// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidSequenceModel, SequenceComment } from "../model.js";
import {
  sequenceConfigPatches,
  readSequenceConfig,
  SEQUENCE_CONFIG_FIELDS,
  type SequenceConfig,
} from "../config.js";
import { nextSequenceSourceKey } from "../source-document.js";
import {
  sequenceRecord,
  sequenceRecordEnd,
  sequenceNewRecordPatch,
  sequenceNoChange,
  writeSequencePatches,
  composeSequenceCommandResults,
  sequenceTextValue,
  type SequenceWriteOptions,
  type SequencePatch,
} from "../writer.js";
import { sequenceParticipant } from "./participant-commands.js";
import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";
import { mermaidMessages as messages } from "../../../i18n.js";
import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "../../diagram-title.js";
import { readSourceYaml, sourceYamlFieldPatch } from "../../source-yaml.js";
import { parseDocument, stringify } from "yaml";

function sequenceMetadataScopes(model: MermaidSequenceModel) {
  const scopes = readSequenceConfig(model.sourceDocument).scopes.map(
    (scope) => ({ ...scope, participant: false }),
  );
  for (const record of model.sourceDocument.records) {
    if (record.kind !== "participant" || !record.values.config) continue;
    const range = record.values.config,
      raw = model.sourceDocument.source.slice(range.start, range.end),
      start = raw.indexOf("{") + 1,
      body = raw.slice(start, raw.lastIndexOf("}")),
      multiline = /[\r\n]/.test(body),
      yaml = readSourceYaml(
        multiline ? body : raw.slice(start - 1),
        range.start + (multiline ? start : start - 1),
      );
    if (yaml) scopes.push({ record, yaml, path: [], participant: true });
  }
  return scopes;
}
/** Opaque leaves stay scoped to their original YAML owner; known fields keep
 * their typed controls. No whole-Source editor is exposed through Data. */
export function readSequenceOpaqueData(model: MermaidSequenceModel) {
  const entries: {
    recordKey: string;
    ownerId?: string;
    path: string[];
    raw: string;
  }[] = [];
  for (const { record, yaml, participant } of sequenceMetadataScopes(model)) {
    const visit = (values: Record<string, unknown>, path: string[]) => {
      for (const [name, value] of Object.entries(values)) {
        if (
          !path.length &&
          (participant
            ? ["type", "alias", "wrap"].includes(name)
            : record.kind === "frontmatter" && name === "title")
        )
          continue;
        if (
          path.at(-1) === "sequence" &&
          SEQUENCE_CONFIG_FIELDS.includes(name as keyof SequenceConfig)
        )
          continue;
        const next = [...path, name];
        if (
          !participant &&
          ["init", "initialize", "config", "sequence"].includes(name) &&
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        )
          visit(value as Record<string, unknown>, next);
        else
          entries.push({
            recordKey: record.sourceKey,
            ownerId: record.ownerId,
            path: next,
            raw: stringify(value).trimEnd(),
          });
      }
    };
    visit(yaml.values, []);
  }
  return entries;
}
export function editSequenceOpaqueData(
  model: MermaidSequenceModel,
  key: string,
  path: readonly string[],
  raw: string,
  options: SequenceWriteOptions = {},
) {
  const scope = sequenceMetadataScopes(model).find(
    (scope) => scope.record.sourceKey === key,
  );
  if (
    !scope ||
    !readSequenceOpaqueData(model).some(
      (entry) =>
        entry.recordKey === key &&
        entry.path.length === path.length &&
        entry.path.every((name, index) => name === path[index]),
    )
  )
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  try {
    const document = parseDocument(raw, { uniqueKeys: true, schema: "core" });
    if (document.errors.length)
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
    const patches = sourceYamlFieldPatch(
      scope.yaml,
      path,
      document.toJS({ maxAliasCount: 100 }),
    );
    return patches
      ? writeSequencePatches(model, patches, options)
      : sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  } catch {
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  }
}

/** The shared title authority selects native title or frontmatter. Feed its
 * minimal changed range through the same checked Sequence writer. */
export function editSequenceDiagramTitle(
  model: MermaidSequenceModel,
  title: string,
  options: SequenceWriteOptions = {},
) {
  const source = model.sourceDocument.source,
    next = writeMermaidDiagramTitle({
      source,
      diagramType: model.diagramType,
      title: title.trim(),
    });
  if (!title.trim() || next === null)
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  let start = 0,
    end = source.length,
    nextEnd = next.length;
  while (start < end && start < nextEnd && source[start] === next[start])
    start++;
  while (
    end > start &&
    nextEnd > start &&
    source[end - 1] === next[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  return writeSequencePatches(
    model,
    [{ range: { start, end }, value: next.slice(start, nextEnd) }],
    options,
  );
}
export function readSequenceDiagramTitle(model: MermaidSequenceModel) {
  return resolveMermaidDiagramTitle({
    source: model.sourceDocument.source,
    diagramType: model.diagramType,
  }).value;
}
export type SequenceCommentAnchor = Pick<
  SequenceComment,
  "anchorKind" | "anchorId" | "position"
>;
function commentAnchorRecord(
  model: MermaidSequenceModel,
  anchor: SequenceCommentAnchor,
) {
  if (anchor.anchorKind === "diagram")
    return model.sourceDocument.records.find((r) => r.kind === "header");
  if (anchor.anchorKind === "participant") {
    const p = sequenceParticipant(model, anchor.anchorId ?? "");
    return p
      ? p.declarationKeys[0]
        ? sequenceRecord(model, p.declarationKeys[0])
        : model.sourceDocument.records.find((r) =>
            r.references.some((ref) => ref.id === p.id),
          )
      : undefined;
  }
  if (anchor.anchorKind === "activation") {
    const activation = model.activations.find((a) => a.id === anchor.anchorId);
    return activation
      ? sequenceRecord(model, activation.messageId ?? activation.id)
      : undefined;
  }
  if (anchor.anchorKind === "branch") {
    const fragment = model.controls.find((c) =>
      c.branches.some((b) => b.id === anchor.anchorId),
    );
    const branch = fragment?.branches.find((b) => b.id === anchor.anchorId);
    return branch
      ? sequenceRecord(
          model,
          branch.kind === "primary" ? fragment!.id : branch.id,
        )
      : undefined;
  }
  return sequenceRecord(model, anchor.anchorId ?? "");
}
function commentPatch(
  model: MermaidSequenceModel,
  anchor: SequenceCommentAnchor,
  text: string,
  key: string,
) {
  const record = commentAnchorRecord(model, anchor);
  if (!record) return null;
  const owningInline = anchor.position !== "before";
  if (owningInline)
    return {
      range: { start: record.range.end, end: record.range.end },
      value: `${record.raw.trimEnd().endsWith(";") ? "" : ";"} %% ${text}`,
      identities: [[record.raw.trimEnd().endsWith(";") ? 0 : 1, key] as const],
    };
  const offset =
    anchor.anchorKind === "diagram"
      ? sequenceRecordEnd(record)
      : record.range.start;
  return sequenceNewRecordPatch(
    model,
    offset,
    `${record.indent}%% ${text}${anchor.anchorKind === "diagram" ? model.sourceDocument.newline : ""}`,
    key,
  );
}
export function addSequenceComment(
  model: MermaidSequenceModel,
  anchor: SequenceCommentAnchor,
  text: string,
  options: SequenceWriteOptions = {},
) {
  if (!text.trim() || /[\r\n]/.test(text) || text.trim().startsWith("{"))
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  const key = nextSequenceSourceKey(),
    patch = commentPatch(model, anchor, text, key);
  if (!patch)
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  const result = writeSequencePatches(model, [patch], {
    ...options,
    commentAnchors: new Map([[key, anchor]]),
    selection: key,
    focus: key,
  });
  return checkedCommentAnchor(model, result, key, anchor);
}
function checkedCommentAnchor(
  model: MermaidSequenceModel,
  result: import("../writer.js").SequenceCommandResult,
  key: string,
  anchor: SequenceCommentAnchor,
) {
  const comment = result.model.commentRecords.find((c) => c.id === key);
  return result.status !== "rejected" &&
    (!comment ||
      comment.anchorKind !== anchor.anchorKind ||
      comment.anchorId !== anchor.anchorId)
    ? sequenceNoChange(model, "invalid", messages.sequenceScopeConflict())
    : result;
}
export function reanchorSequenceComment(
  model: MermaidSequenceModel,
  key: string,
  anchor: SequenceCommentAnchor,
  options: SequenceWriteOptions = {},
) {
  const comment = model.commentRecords.find((c) => c.id === key);
  if (!comment)
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  const deleted = deleteSequenceComment(model, key);
  if (deleted.status === "rejected") return deleted;
  const patch = commentPatch(deleted.model, anchor, comment.text, key);
  if (!patch)
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  const result = writeSequencePatches(deleted.model, [patch], {
    commentAnchors: new Map([[key, anchor]]),
    selection: key,
    focus: key,
  });
  return checkedCommentAnchor(
    model,
    composeSequenceCommandResults(model, result, {
      ...options,
      commentTransfers: new Set([key]),
    }),
    key,
    anchor,
  );
}

export function editSequenceComment(
  model: MermaidSequenceModel,
  key: string,
  text: string,
  options: SequenceWriteOptions = {},
) {
  const record = sequenceRecord(model, key);
  if (
    !record ||
    record.kind !== "comment" ||
    /[\r\n]/.test(text) ||
    text.trim().startsWith("{")
  )
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  const range = record.values.text ?? {
    start:
      record.range.start +
      record.indent.length +
      (/^(?:%+|#)\s?/.exec(record.raw.trimStart())?.[0].length ?? 0),
    end: record.range.end,
  };
  return writeSequencePatches(model, [{ range, value: text }], options);
}
export function deleteSequenceComment(
  model: MermaidSequenceModel,
  key: string,
  options: SequenceWriteOptions = {},
) {
  const record = sequenceRecord(model, key);
  if (!record || record.kind !== "comment")
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  return writeSequencePatches(
    model,
    [
      {
        range: {
          start: record.range.start,
          end: model.sourceDocument.records.some(
            (r) =>
              r !== record &&
              r.range.line === record.range.line &&
              r.range.end <= record.range.start,
          )
            ? record.range.end
            : sequenceRecordEnd(record),
        },
        value: "",
      },
    ],
    { ...options, removed: new Set([key]) },
  );
}

export function editSequenceAppearance(
  model: MermaidSequenceModel,
  config: Partial<SequenceConfig>,
  options: SequenceWriteOptions = {},
) {
  const patches = sequenceConfigPatches(model.sourceDocument, config);
  return patches
    ? writeSequencePatches(model, patches, options)
    : sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
}
export function editSequenceAccessibility(
  model: MermaidSequenceModel,
  value: { title?: string; description?: string },
  options: SequenceWriteOptions = {},
) {
  const patches: SequencePatch[] = [];
  for (const [field, kind, command] of [
    ["title", "accessibility-title", "accTitle"],
    ["description", "accessibility-description", "accDescr"],
  ] as const) {
    const text = value[field];
    if (
      text === undefined ||
      text ===
        (field === "title"
          ? model.accessibilityTitle
          : model.accessibilityDescription)
    )
      continue;
    if (field === "description" && /[{}]/.test(text))
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
    const record = model.sourceDocument.records.findLast(
        (r) => r.kind === kind,
      ),
      header = model.sourceDocument.records.find((r) => r.kind === "header")!;
    const line =
      field === "description" && /[\r\n]/.test(text)
        ? `${command} {${text}}`
        : `${command}: ${sequenceTextValue(text)}`;
    if (record)
      patches.push({
        range: { start: record.range.start, end: record.range.end },
        value: record.indent + line,
        identities: [[0, record.sourceKey]],
      });
    else
      patches.push(
        sequenceNewRecordPatch(
          model,
          sequenceRecordEnd(header),
          `  ${line}`,
          nextSequenceSourceKey(),
        ),
      );
  }
  return writeSequencePatches(model, patches, options);
}
export function editSequenceAutonumber(
  model: MermaidSequenceModel,
  value: { enabled: boolean; start: number; step: number },
  key?: string,
  options: SequenceWriteOptions = {},
) {
  if (
    ![value.start, value.step].every(
      (n) => Number.isFinite(n) && n >= 0 && n === Math.round(n * 100) / 100,
    )
  )
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  const record = key
    ? sequenceRecord(model, key)
    : model.sourceDocument.records.findLast((r) => r.kind === "autonumber");
  if (key && record?.kind !== "autonumber")
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  const text = value.enabled
    ? `autonumber ${value.start} ${value.step}`
    : "autonumber off";
  const records =
    !key && !value.enabled
      ? model.sourceDocument.records.filter((r) => r.kind === "autonumber")
      : record
        ? [record]
        : [];
  const patches: SequencePatch[] = records.length
    ? records.map((record) => ({
        range: { start: record.range.start, end: record.range.end },
        value: record.indent + text,
        identities: [[0, record.sourceKey]],
      }))
    : [
        sequenceNewRecordPatch(
          model,
          sequenceRecordEnd(
            model.sourceDocument.records.find((r) => r.kind === "header")!,
          ),
          `  ${text}`,
          nextSequenceSourceKey(),
        ),
      ];
  // Explicit Off owns the diagram's native numbering flag as well. Otherwise
  // showSequenceNumbers would continue numbering despite an off statement.
  if (
    !value.enabled &&
    !key &&
    readSequenceConfig(model.sourceDocument).config.showSequenceNumbers
  )
    patches.push(
      ...sequenceConfigPatches(model.sourceDocument, {
        showSequenceNumbers: false,
      })!,
    );
  return writeSequencePatches(model, patches, options);
}
export function editSequenceLink(
  model: MermaidSequenceModel,
  participantKey: string,
  value: {
    label: string;
    url: string;
    recordId?: string;
    previousLabel?: string;
  },
  options: SequenceWriteOptions = {},
) {
  const p = sequenceParticipant(model, participantKey),
    url = value.url.trim() ? normalizeUrl(value.url.trim()) : "";
  if (!p)
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  if (url && (!isValidUrl(url, "https://myoxus.local") || !value.label.trim()))
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  const record = value.recordId
    ? sequenceRecord(model, value.recordId)
    : model.sourceDocument.records.findLast(
        (r) =>
          r.kind === "link" &&
          r.ownerId === p.id &&
          r.values.label &&
          model.sourceDocument.source.slice(
            r.values.label.start,
            r.values.label.end,
          ) === (value.previousLabel ?? value.label),
      );
  if (record && (record.kind !== "link" || record.ownerId !== p.id))
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  if (record && record.values.payload) {
    let links: unknown;
    try {
      links = JSON.parse(
        model.sourceDocument.source.slice(
          record.values.payload.start,
          record.values.payload.end,
        ),
      );
    } catch {
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
    }
    if (!links || typeof links !== "object" || Array.isArray(links))
      return sequenceNoChange(
        model,
        "invalid",
        messages.sequencePatchRejected(),
      );
    const next = { ...links } as Record<string, unknown>;
    delete next[value.previousLabel ?? value.label];
    if (url) next[value.label] = url;
    return writeSequencePatches(
      model,
      [{ range: record.values.payload, value: JSON.stringify(next) }],
      { ...options, selection: p.sourceKey },
    );
  }
  if (!url)
    return record
      ? writeSequencePatches(
          model,
          [
            {
              range: {
                start: record.range.start,
                end: sequenceRecordEnd(record),
              },
              value: "",
            },
          ],
          {
            ...options,
            removed: new Set([record.sourceKey]),
            selection: p.sourceKey,
          },
        )
      : sequenceNoChange(model);
  const text = `link ${p.id}: ${sequenceTextValue(value.label)} @ ${sequenceTextValue(url)}`;
  const declaration = p.declarationKeys[0]
    ? sequenceRecord(model, p.declarationKeys[0])
    : undefined;
  return writeSequencePatches(
    model,
    record
      ? [
          {
            range: { start: record.range.start, end: record.range.end },
            value: record.indent + text,
            identities: [[0, record.sourceKey]],
          },
        ]
      : [
          sequenceNewRecordPatch(
            model,
            declaration
              ? sequenceRecordEnd(declaration)
              : model.sourceDocument.source.length,
            `  ${text}`,
            nextSequenceSourceKey(),
          ),
        ],
    { ...options, selection: p.sourceKey },
  );
}
export function editSequenceData(
  model: MermaidSequenceModel,
  key: string,
  value: unknown,
  options: SequenceWriteOptions = {},
) {
  const record = sequenceRecord(model, key);
  if (
    !record ||
    !["properties", "details", "link"].includes(record.kind) ||
    !record.values.payload
  )
    return sequenceNoChange(model, "invalid", messages.sequenceMissingObject());
  if (
    (record.kind === "details" && typeof value !== "string") ||
    (record.kind !== "details" &&
      (!value || typeof value !== "object" || Array.isArray(value)))
  )
    return sequenceNoChange(model, "invalid", messages.sequencePatchRejected());
  const payload =
    typeof value === "string"
      ? sequenceTextValue(value)
      : JSON.stringify(value);
  return writeSequencePatches(
    model,
    [{ range: record.values.payload, value: payload }],
    options,
  );
}
