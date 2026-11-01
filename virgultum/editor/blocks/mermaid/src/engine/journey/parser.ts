// SPDX-License-Identifier: AGPL-3.0-or-later

import { hashMermaidSource } from "../../utils.js";
import { detectMermaidDiagramType } from "../diagram-types.js";
import { readJourneyConfig } from "./config.js";
import type { MermaidJourneyModel, MermaidJourneySection } from "./model.js";
import {
  scanJourneySource,
  reconcileJourneySource,
  type JourneyRange,
  type JourneySourceRecord,
} from "./source-document.js";
function range(r: JourneySourceRecord, a: number, b: number): JourneyRange {
  return {
    start: r.range.start + a,
    end: r.range.start + b,
    line: r.range.line + r.raw.slice(0, a).split(/\r\n|\r|\n/).length - 1,
  };
}
function valueRange(r: JourneySourceRecord, a: number, b: number) {
  const s = r.raw.slice(a, b);
  return range(
    r,
    a + (s.length - s.trimStart().length),
    b - (s.length - s.trimEnd().length),
  );
}
/** The native lexer consumes the first colon as task boundary, then DB uses Number
 * and only the second colon field for actors. Further tail fields remain raw source. */
export function parseMermaidJourneySource(
  source: string,
  previous?: MermaidJourneyModel,
  mapping?: ReadonlyMap<number, string>,
): MermaidJourneyModel | null {
  if (detectMermaidDiagramType(source) !== "journey") return null;
  const sourceDocument = reconcileJourneySource(
    scanJourneySource(source),
    previous?.sourceDocument,
    mapping,
  );
  const m: MermaidJourneyModel = {
    diagramType: "journey",
    version: 1,
    sourceHash: hashMermaidSource(source),
    sourceDocument,
    headerId: "",
    sections: [],
    steps: [],
    comments: [],
    title: "",
    accessibilityTitle: "",
    accessibilityDescription: "",
    diagnostics: [],
    ambiguous: false,
  };
  let current: MermaidJourneySection | undefined;
  const diagnostic = (
    r: JourneySourceRecord,
    code: MermaidJourneyModel["diagnostics"][number]["code"],
  ) => m.diagnostics.push({ code, range: r.range, anchorId: r.sourceKey });
  for (const r of sourceDocument.records) {
    if (!r.complete) {
      m.ambiguous = true;
      diagnostic(
        r,
        r.kind === "accessibility-description" ? "accessibility" : "config",
      );
      continue;
    }
    if (["frontmatter", "directive", "blank", "comment"].includes(r.kind))
      continue;
    const text = r.raw.trimStart();
    if (r.kind === "header") {
      if (m.headerId || !/^journey(?:\s*(?:[%#].*)?)?$/i.test(text)) {
        m.ambiguous = true;
        diagnostic(r, "header");
      }
      m.headerId = r.sourceKey;
      continue;
    }
    if (!m.headerId) continue;
    const hash = r.raw.indexOf("#");
    const end = hash < 0 ? r.raw.length : hash;
    if (r.kind === "title") {
      if (/[;]/.test(r.raw.slice(0, end))) {
        diagnostic(r, "syntax");
        continue;
      }
      m.title = text
        .slice(6, hash < 0 ? undefined : hash - r.indent.length)
        .trim();
    } else if (r.kind === "accessibility-title")
      m.accessibilityTitle = text.slice(text.indexOf(":") + 1).trim();
    else if (r.kind === "accessibility-description") {
      const opening = r.raw.indexOf("{");
      m.accessibilityDescription =
        opening >= 0
          ? r.raw.slice(opening + 1, r.raw.indexOf("}", opening)).trim()
          : text.slice(text.indexOf(":") + 1).trim();
    } else if (r.kind === "section") {
      const start = r.indent.length + 8;
      const raw = r.raw.slice(start, end);
      if (/[;:]/.test(raw) || !raw) {
        diagnostic(r, "syntax");
        continue;
      }
      const v = valueRange(r, start, end);
      current = {
        id: r.sourceKey,
        sourceKey: r.sourceKey,
        order: m.sections.length,
        title: raw.trim(),
        labelRange: v,
        indent: r.indent,
        implicit: false,
        writable: true,
      };
      m.sections.push(current);
    } else if (r.kind === "step") {
      const colon = r.raw.indexOf(":");
      const label = r.raw.slice(r.indent.length, colon);
      const data = r.raw.slice(colon + 1, end);
      const second = data.indexOf(":");
      const scoreRaw = second < 0 ? data : data.slice(0, second);
      const actorStart = second < 0 ? -1 : colon + 2 + second;
      const third = actorStart < 0 ? -1 : r.raw.indexOf(":", actorStart);
      const actorEnd = third < 0 ? end : third;
      if (!label.trim() || /[;#]/.test(label) || !data || /[;]/.test(data)) {
        diagnostic(r, "syntax");
        continue;
      }
      if (!current) {
        current = {
          id: `${m.headerId}:initial`,
          sourceKey: `${m.headerId}:initial`,
          order: 0,
          title: "",
          implicit: true,
          indent: r.indent,
          writable: true,
        };
        m.sections.push(current);
      }
      const score = Number(scoreRaw);
      const actorLexeme =
        actorStart < 0 ? undefined : r.raw.slice(actorStart, actorEnd);
      const actors =
        actorLexeme === undefined
          ? []
          : actorLexeme.split(",").map((a) => a.trim());
      m.steps.push({
        id: r.sourceKey,
        sourceKey: r.sourceKey,
        label: label.trim(),
        order: m.steps.filter((s) => s.sectionId === current!.id).length,
        score,
        scoreLexeme: scoreRaw,
        actors,
        actorLexeme,
        tail: third < 0 ? "" : r.raw.slice(third, end),
        sectionId: current.id,
        indent: r.indent,
        labelRange: valueRange(r, r.indent.length, colon),
        scoreRange: valueRange(r, colon + 1, second < 0 ? end : actorStart - 1),
        actorsRange:
          actorStart < 0 ? undefined : range(r, actorStart, actorEnd),
        // Command patch coordinates are document-absolute, including actorless steps.
        actorsInsertion: r.range.start + (second < 0 ? end : actorStart - 1),
        writable: true,
      });
      if (!Number.isFinite(score)) diagnostic(r, "score");
      else if (score < 1 || score > 5) diagnostic(r, "score-range");
      if (actors.some((a) => !a)) diagnostic(r, "actor-slot");
    } else {
      diagnostic(r, "syntax");
      continue;
    }
    // Accessibility values own '#'/percent text; native lexer does not parse inline comments there.
    if (
      hash >= 0 &&
      !["accessibility-title", "accessibility-description"].includes(r.kind)
    )
      m.comments.push({
        id: `${r.sourceKey}:inline`,
        text: r.raw.slice(hash + 1).trim(),
        line: r.raw.slice(hash),
        range: range(r, hash, r.raw.length),
        indent: r.indent,
        anchorId: r.sourceKey,
        affinity: "object",
        inline: true,
      });
  }
  for (let i = 0; i < sourceDocument.records.length; i++) {
    const r = sourceDocument.records[i]!;
    if (r.kind !== "comment") continue;
    let n = i + 1;
    while (
      sourceDocument.records[n]?.kind === "comment" &&
      sourceDocument.records[n]?.indent === r.indent
    )
      n++;
    let first = i;
    while (
      sourceDocument.records[first - 1]?.kind === "comment" &&
      sourceDocument.records[first - 1]?.indent === r.indent
    )
      first--;
    const following = sourceDocument.records[n];
    const prior = sourceDocument.records[first - 1];
    const owner =
      following &&
      [...m.sections, ...m.steps].find((o) => o.id === following.sourceKey);
    const attached = Boolean(
      owner &&
      following!.indent === r.indent &&
      !(prior?.kind === "header" && prior.indent === r.indent),
    );
    m.comments.push({
      id: r.sourceKey,
      text: r.raw.trim().replace(/^(?:%%?|#)\s?/, ""),
      line: r.raw,
      range: r.range,
      indent: r.indent,
      anchorId: attached ? owner!.id : null,
      affinity: attached ? "object" : "position",
    });
  }
  const config = readJourneyConfig(sourceDocument);
  for (const id of config.invalid) {
    const r = sourceDocument.records.find((r) => r.sourceKey === id)!;
    diagnostic(r, "config");
    m.ambiguous = true;
  }
  if (!m.headerId) return null;
  if (m.ambiguous && previous && !previous.ambiguous)
    return {
      ...previous,
      sourceDocument,
      sourceHash: m.sourceHash,
      diagnostics: m.diagnostics,
      ambiguous: true,
      staleProjection: true,
    };
  return m;
}
