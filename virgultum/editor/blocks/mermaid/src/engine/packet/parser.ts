// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import { hashMermaidSource } from "../../utils.js";
import { detectMermaidDiagramType } from "../diagram-types.js";
import { readPacketConfig } from "./config.js";
import {
  validatePacketFieldRanges,
  packetMaterializationDiagnostic,
} from "./layout.js";
import type { MermaidPacketModel, MermaidPacketComment } from "./model.js";
import {
  scanPacketSource,
  reconcilePacketSource,
  packetRecordRange,
  type PacketSourceRecord,
  PACKET_FIELD_RE,
  decodePacketString,
} from "./source-document.js";

export function parseMermaidPacketSource(
  source: string,
  previous?: MermaidPacketModel,
  mapping?: ReadonlyMap<number, string>,
): MermaidPacketModel | null {
  if (detectMermaidDiagramType(source) !== "packet") return null;
  const sourceDocument = reconcilePacketSource(
    scanPacketSource(source),
    previous?.sourceDocument,
    mapping,
  );
  const configResolution = readPacketConfig(sourceDocument);
  const model: MermaidPacketModel = {
    sourceDocument,
    metadataKeys: {},
    configResolution,
    diagnostics: [],
    accessibilityDescription: "",
    accessibilityTitle: "",
    comments: [],
    diagramType: "packet",
    directives: [],
    fields: [],
    headerLine: "",
    issues: [],
    passthroughLines: [],
    preambleComments: [],
    sourceHash: hashMermaidSource(source),
    totalWidth: 0,
    title: "",
    version: 1,
  };
  const fieldLines = new Map<string, number>();
  let nextBit = 0;
  let precisionLost = false;
  for (const r of sourceDocument.records) {
    if (!r.complete) {
      model.diagnostics.push({
        code:
          r.kind === "frontmatter" || r.kind === "directive"
            ? "config"
            : "syntax",
        line: r.range.line,
        get message() {
          return messages.packetIncomplete();
        },
      });
      continue;
    }
    if (r.kind === "frontmatter" || r.kind === "directive") {
      model.directives.push(...r.raw.split(/\r\n|\r|\n/));
      continue;
    }
    if (r.kind === "blank") continue;
    if (r.kind === "comment") continue;
    if (r.kind === "header") {
      if (model.headerLine)
        model.diagnostics.push({
          code: "syntax",
          line: r.range.line,
          get message() {
            return messages.packetDuplicateHeader();
          },
        });
      model.headerLine = r.raw.trim();
      continue;
    }
    if (!model.headerLine || r.kind === "invalid") {
      model.passthroughLines.push(r.raw);
      model.diagnostics.push({
        code: "syntax",
        line: r.range.line,
        get message() {
          return messages.packetExpectedStatement();
        },
      });
      continue;
    }
    const text = r.raw.trimStart();
    if (r.kind === "title") {
      model.metadataKeys!.title = r.sourceKey;
      model.hasTitle = true;
      model.title = text.slice(5).trim();
      continue;
    }
    if (r.kind === "accessibility-title") {
      model.metadataKeys!["accessibility-title"] = r.sourceKey;
      model.hasAccessibilityTitle = true;
      model.accessibilityTitle = text.slice(text.indexOf(":") + 1).trim();
      continue;
    }
    if (r.kind === "accessibility-description") {
      model.metadataKeys!["accessibility-description"] = r.sourceKey;
      model.hasAccessibilityDescription = true;
      const opening = text.indexOf("{");
      model.accessibilityDescription =
        opening < 0 || (text.indexOf(":") >= 0 && text.indexOf(":") < opening)
          ? text.slice(text.indexOf(":") + 1).trim()
          : text.slice(opening + 1, text.lastIndexOf("}")).trim();
      continue;
    }
    const match = PACKET_FIELD_RE.exec(text);
    if (!match || (match[1] && match[3])) {
      model.diagnostics.push({
        code: "syntax",
        line: r.range.line,
        get message() {
          return messages.packetExpectedField();
        },
      });
      continue;
    }
    const startBit = match[1] ? nextBit : Number(match[2]);
    const endBit = match[1]
      ? startBit + Number(match[2]) - 1
      : match[3]
        ? Number(match[3])
        : startBit;
    const width = endBit - startBit + 1;
    if (
      precisionLost ||
      !Number.isSafeInteger(startBit) ||
      !Number.isSafeInteger(endBit + 1) ||
      !Number.isSafeInteger(width)
    ) {
      precisionLost = true;
      model.diagnostics.push({
        code: "precision",
        line: r.range.line,
        get message() {
          return messages.packetPrecision();
        },
      });
      continue;
    }
    const id = r.sourceKey;
    fieldLines.set(id, r.range.line);
    const labelStart = r.indent.length + match[0].length - match[4]!.length;
    const colon = r.raw.indexOf(":");
    const sourceForm = match[1] ? "count" : match[3] ? "range" : "single";
    const firstStart = r.indent.length + (match[1] ? 1 : 0);
    const numberEnd = r.raw.slice(0, colon).trimEnd().length;
    model.fields.push({
      id,
      sourceKey: r.sourceKey,
      sourceForm,
      statementRange: r.range,
      numberRange: packetRecordRange(r, r.indent.length, numberEnd),
      startRange: packetRecordRange(
        r,
        firstStart,
        firstStart + match[2]!.length,
      ),
      endRange: match[3]
        ? packetRecordRange(r, numberEnd - match[3].length, numberEnd)
        : undefined,
      labelRange: packetRecordRange(
        r,
        labelStart,
        labelStart + match[4]!.length,
      ),
      quote: match[4]![0] as "'" | '"',
      indent: r.indent,
      eol: r.eol,
      separator: r.raw.slice(numberEnd, labelStart),
      startBit,
      endBit,
      width: Math.max(1, width),
      label: decodePacketString(match[4]!),
      order: model.fields.length,
    });
    nextBit = endBit + 1;
  }
  attachPacketComments(model);
  const layout = validatePacketFieldRanges(model.fields);
  model.issues = layout.issues;
  for (const issue of model.issues)
    issue.line = fieldLines.get(issue.fieldIds[0]!);
  model.totalWidth = model.fields.at(-1) ? model.fields.at(-1)!.endBit + 1 : 0;
  for (const issue of configResolution.invalid)
    model.diagnostics.push({
      code: "config",
      line: issue.line,
      get message() {
        return issue.message;
      },
    });
  const config = configResolution.config;
  const materialization =
    config &&
    packetMaterializationDiagnostic(
      model.totalWidth,
      config,
      configResolution.derivedPaddingY,
    );
  if (materialization)
    model.diagnostics.push({
      code: "materialization",
      line:
        sourceDocument.records.findLast((r) => r.kind === "field")?.range
          .line ?? 1,
      get message() {
        return packetMaterializationDiagnostic(
          model.totalWidth,
          config!,
          configResolution.derivedPaddingY,
        )!;
      },
    });
  return model;
}

function attachPacketComments(model: MermaidPacketModel) {
  const records = model.sourceDocument.records;
  const fields = new Set(model.fields.map((f) => f.id));
  const kind = (
    record: PacketSourceRecord,
  ): MermaidPacketComment["anchorKind"] | undefined =>
    fields.has(record.sourceKey)
      ? "field"
      : record.kind === "header"
        ? "diagram"
        : [
              "title",
              "accessibility-title",
              "accessibility-description",
            ].includes(record.kind)
          ? (record.kind as MermaidPacketComment["anchorKind"])
          : undefined;
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (r.kind !== "comment") continue;
    const prior = records[i - 1];
    let owner: PacketSourceRecord | undefined;
    let position: MermaidPacketComment["position"] = "before";
    if (prior && !prior.eol && kind(prior)) {
      owner = prior;
      position = "inline";
    } else {
      let first = i,
        last = i;
      while (
        records[first - 1]?.kind === "comment" &&
        records[first - 1]?.indent === r.indent
      )
        first--;
      while (
        records[last + 1]?.kind === "comment" &&
        records[last + 1]?.indent === r.indent
      )
        last++;
      const next = records[last + 1],
        before = records[first - 1];
      if (
        next &&
        kind(next) &&
        next.indent === r.indent &&
        !(before?.kind === "header" && before.indent === r.indent)
      )
        owner = next;
      else if (
        (!next || next.kind === "blank") &&
        before &&
        kind(before) &&
        before.indent === r.indent
      ) {
        owner = before;
        position = "after";
      }
    }
    const comment: MermaidPacketComment = {
      id: r.sourceKey,
      sourceKey: r.sourceKey,
      range: r.range,
      line: r.raw,
      text: r.raw.trimStart().slice(2).trim(),
      indent: r.indent,
      anchorKind: owner ? kind(owner)! : "diagram",
      anchorId: owner?.sourceKey,
      position,
      affinity: owner && owner.kind !== "header" ? "object" : "position",
    };
    model.comments!.push(comment);
    model.passthroughLines.push(r.raw);
    if (
      r.range.start <
      (records.find((item) => item.kind === "header")?.range.start ?? 0)
    )
      model.preambleComments!.push(r.raw);
  }
}
