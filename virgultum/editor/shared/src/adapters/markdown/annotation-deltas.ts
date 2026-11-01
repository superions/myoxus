// SPDX-License-Identifier: AGPL-3.0-or-later
import { AnnotationSchema, getAnnotationRanges } from "@virgultum/model";
import {
  nanoid,
  type BlockSnapshot,
  type DeltaInsert,
  type DeltaOperation,
} from "@virgultum/store";
import type { MyoxusTextAttributes } from "../../types";
import {
  escapeAnnotationDelimiters,
  serializeAnnotationBody,
} from "./annotation-syntax";
import {
  findAnnotationSyntaxSpans,
  hasPendingAnnotationSyntax,
} from "./remark-plugins/remark-annotation";

type Delta = DeltaInsert<MyoxusTextAttributes>;

export function hasPendingAnnotationInput(
  deltas: DeltaOperation[],
  endIndex = Infinity,
): boolean {
  let eligible = "";
  let offset = 0;
  for (const delta of deltas) {
    if (offset >= endIndex) break;
    if (typeof delta.insert !== "string") {
      eligible = "";
      offset += delta.retain ?? 0;
      continue;
    }
    const insert = delta.insert.slice(0, endIndex - offset);
    offset += insert.length;
    const attrs = delta.attributes;
    if (
      attrs?.code ||
      attrs?.reference ||
      attrs?.latex ||
      attrs?.footnote ||
      attrs?.annotation
    )
      eligible = "";
    else eligible += insert;
  }
  return eligible.includes("%%") && hasPendingAnnotationSyntax(eligible);
}

/** HTML already owns the structure; only eligible whole paragraphs become blocks. */
export function normalizeHtmlAnnotationBlocks(
  root: BlockSnapshot,
): BlockSnapshot {
  root.children = root.children.flatMap((child) => {
    normalizeHtmlAnnotationBlocks(child);
    if (child.flavour !== "myoxus:paragraph" || child.props.type !== "text")
      return [child];
    const text = child.props.text as { delta: Delta[] } | undefined;
    if (!text) return [child];
    const value = text.delta.map((delta) => delta.insert).join("");
    const ranges = getAnnotationRanges(text.delta);
    const empty =
      value.trim() === "%%%%" &&
      text.delta.every((delta) => !delta.attributes?.code);
    if (
      !empty &&
      !(
        ranges.length === 1 &&
        !value.slice(0, ranges[0].index).trim() &&
        !value.slice(ranges[0].index + ranges[0].length).trim()
      )
    )
      return [child];
    return [
      {
        ...child,
        flavour: "myoxus:annotation",
        props: {
          text: {
            "$virgultum:internal:text$": true,
            delta: empty ? [] : [{ insert: ranges[0].body }],
          },
        },
        children: [],
      },
      ...child.children,
    ];
  });
  return root;
}

function sliceDeltas(deltas: Delta[], start: number, end: number): Delta[] {
  let offset = 0;
  return deltas.flatMap((delta) => {
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, delta.insert.length);
    offset += delta.insert.length;
    return to > from
      ? [{ ...delta, insert: delta.insert.slice(from, to) }]
      : [];
  });
}

/** Recognize across formatting deltas, never across an existing code/embed boundary. */
export function recognizeAnnotationDeltas(deltas: Delta[]): Delta[] {
  const output: Delta[] = [];
  let eligible: Delta[] = [];
  const flush = () => {
    const text = eligible.map((delta) => delta.insert).join("");
    let offset = 0;
    for (const span of findAnnotationSyntaxSpans(text)) {
      output.push(...sliceDeltas(eligible, offset, span.index));
      if (span.body)
        output.push({
          insert: span.body,
          attributes: { annotation: { id: nanoid() } },
        });
      else
        output.push(
          ...sliceDeltas(eligible, span.index, span.index + span.length),
        );
      offset = span.index + span.length;
    }
    output.push(...sliceDeltas(eligible, offset, text.length));
    eligible = [];
  };
  for (const delta of deltas) {
    const attrs = delta.attributes;
    if (
      attrs?.code ||
      attrs?.reference ||
      attrs?.latex ||
      attrs?.footnote ||
      AnnotationSchema.safeParse(attrs?.annotation).success
    ) {
      flush();
      output.push(delta);
    } else eligible.push(delta);
  }
  flush();
  return output;
}

/** Editable plain-text copy shares logical identity grouping with Markdown. */
export function serializeAnnotationDeltas(
  deltas: Delta[],
  escapeLiteralDelimiters = true,
): string {
  let text = "";
  let id: string | undefined;
  let body = "";
  let ordinary = "";
  const flushOrdinary = () => {
    text += escapeLiteralDelimiters
      ? escapeAnnotationDelimiters(ordinary)
      : ordinary;
    ordinary = "";
  };
  const flush = () => {
    if (id) text += serializeAnnotationBody(body);
    id = undefined;
    body = "";
  };
  for (const delta of deltas) {
    const annotation = AnnotationSchema.safeParse(delta.attributes?.annotation);
    if (annotation.success) {
      flushOrdinary();
      if (id !== annotation.data.id) flush();
      id = annotation.data.id;
      body += delta.insert;
    } else {
      flush();
      if (delta.attributes?.code) {
        flushOrdinary();
        text += delta.insert;
      } else ordinary += delta.insert;
    }
  }
  flush();
  flushOrdinary();
  return text;
}

/** Code destinations keep delimiter syntax literal, not hidden native markers. */
export function annotationsToLiteralSnapshot(
  snapshot: BlockSnapshot,
  inlineCode: boolean,
): void {
  const text = snapshot.props.text as { delta: Delta[] } | undefined;
  if (snapshot.flavour === "myoxus:annotation" && text) {
    snapshot.flavour = "myoxus:paragraph";
    snapshot.props = {
      type: "text",
      text: {
        "$virgultum:internal:text$": true,
        delta: [
          {
            insert: serializeAnnotationBody(
              text.delta.map((delta) => delta.insert).join(""),
            ),
            ...(inlineCode ? { attributes: { code: true } } : {}),
          },
        ],
      },
    };
  } else if (text) {
    const literal = serializeAnnotationDeltas(text.delta, false);
    text.delta = literal
      ? [
          {
            insert: literal,
            ...(inlineCode ? { attributes: { code: true } } : {}),
          },
        ]
      : [];
  }
  snapshot.children.forEach((child) =>
    annotationsToLiteralSnapshot(child, inlineCode),
  );
}
