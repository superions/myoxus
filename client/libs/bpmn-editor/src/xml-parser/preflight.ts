// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOMParser, ParseError, type Document } from "@xmldom/xmldom";

export type XmlInputErrorCode =
  | "BPMN_INVALID_UTF8"
  | "BPMN_XML_ENCODING"
  | "BPMN_UNSUPPORTED_XML_VERSION"
  | "BPMN_UNSAFE_XML"
  | "BPMN_XML_DEPTH"
  | "BPMN_XML_ATTRIBUTES"
  | "BPMN_XML_ATTRIBUTE_LENGTH"
  | "BPMN_XML_WORK"
  | "BPMN_XML_TOKENS"
  | "BPMN_RENDER_OBJECTS"
  | "BPMN_MALFORMED_XML"
  | "BPMN_PARSER_FAILURE";

/** No parser message, source fragment, filename or arbitrary cause crosses this boundary. */
export class XmlInputError extends Error {
  constructor(readonly code: XmlInputErrorCode) {
    super(code);
  }
}

// Independent structural limits: text-heavy input is not treated like thousands
// of React Flow objects. Keep calibration evidence in the architecture page;
// changing the parser/renderer requires remeasuring, not silently widening these.
export const BPMN_XML_BUDGET = Object.freeze({
  // Bounds recursive schema traversal, opaque serialization and DOM normalize.
  depth: 64,
  // DOM attribute insertion/duplicate checks grow with attributes per element.
  attributes: 128,
  // A single scalar must not turn a property control into a multi-megabyte field.
  attributeLength: 262_144,
  // Counts parser input work, not encoded file size; large text is independent
  // of diagram complexity (2.1 MB source operated through save/reopen).
  characters: 8_388_608,
  // Counts SAX element/text/comment/attribute events before DOM allocation.
  tokens: 100_000,
  // Measured upper render probe: 1,000 tasks fit in ~6.8s; DOM count alone
  // misses this cost because React Flow virtualizes its ordinary viewport.
  renderObjects: 1_000,
});

/** Fatal UTF-8, including overlong/truncated sequences. ignoreBOM retains U+FEFF
 * so TextEncoder reproduces the signature rather than silently losing it. */
export function decodeBpmnBytes(bytes: Uint8Array): string {
  const { TextDecoder } = globalThis as typeof globalThis & {
    TextDecoder: new (
      encoding: string,
      options: { fatal: boolean; ignoreBOM: boolean },
    ) => { decode(bytes: Uint8Array): string };
  };
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new XmlInputError("BPMN_INVALID_UTF8");
  }
}

type SaxAttributes = {
  length: number;
  getValue(index: number): string;
  getQName(index: number): string;
};
type Handler = {
  startElement(
    uri: string,
    local: string,
    qualified: string,
    attrs: SaxAttributes,
  ): void;
  endElement(uri: string, local: string, qualified: string): void;
  characters(value: string, start: number, length: number): void;
  comment(value: string, start: number, length: number): void;
  processingInstruction(target: string, data: string): void;
  startDTD(): void;
};
// xmldom exposes its SAX DOM-builder constructor through the documented
// domHandler option (typed unknown upstream). Delegate every ordinary operation
// to it; we neither tokenize XML nor reimplement namespace/entity processing.
const DefaultHandler = (
  new DOMParser() as unknown as {
    domHandler: new (...args: unknown[]) => Handler;
  }
).domHandler;

/** Budgeted DOM construction precedes recursive schema mapping and rendering.
 * Throw ParseError from callbacks: xmldom deliberately catches other errors and
 * may attempt recovery, which would otherwise erase our rejection reason. */
export function parseBoundedXml(source: string): Document {
  let rejection: XmlInputErrorCode | undefined;
  const reject = (code: XmlInputErrorCode): never => {
    rejection = code;
    throw new ParseError(code);
  };
  // Bound raw scanning as well as decoded events: one huge token/comment must
  // not bypass the event budget before xmldom calls its handler.
  if (source.length > BPMN_XML_BUDGET.characters)
    throw new XmlInputError("BPMN_XML_WORK");
  const rawCharacters = (value: string) =>
    value.isWellFormed() &&
    // oxlint-disable-next-line no-control-regex -- Enforce the XML 1.0 Char production, including decoded character references.
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value);
  const xmlCharacters = rawCharacters;
  if (!rawCharacters(source)) throw new XmlInputError("BPMN_MALFORMED_XML");
  let depth = 0,
    tokens = 0,
    objects = 0;
  const token = (count = 1) => {
    if ((tokens += count) > BPMN_XML_BUDGET.tokens) reject("BPMN_XML_TOKENS");
  };
  class BoundedHandler extends DefaultHandler {
    override startElement(
      uri: string,
      local: string,
      qualified: string,
      attrs: SaxAttributes,
    ) {
      if (++depth > BPMN_XML_BUDGET.depth) reject("BPMN_XML_DEPTH");
      if (attrs.length > BPMN_XML_BUDGET.attributes)
        reject("BPMN_XML_ATTRIBUTES");
      token(1 + attrs.length);
      for (let index = 0; index < attrs.length; index++) {
        if (!xmlCharacters(attrs.getValue(index))) reject("BPMN_MALFORMED_XML");
        if (
          attrs.getValue(index).length > BPMN_XML_BUDGET.attributeLength ||
          attrs.getQName(index).length > BPMN_XML_BUDGET.attributeLength
        )
          reject("BPMN_XML_ATTRIBUTE_LENGTH");
      }
      // DI objects are exactly the renderer's visible ownership, including
      // external labels; non-graphical definitions are not charged as shapes.
      if (
        uri === "http://www.omg.org/spec/BPMN/20100524/DI" &&
        (local === "BPMNShape" || local === "BPMNEdge" || local === "BPMNLabel")
      ) {
        if (++objects > BPMN_XML_BUDGET.renderObjects)
          reject("BPMN_RENDER_OBJECTS");
      }
      super.startElement(uri, local, qualified, attrs);
    }
    override endElement(uri: string, local: string, qualified: string) {
      token();
      depth--;
      super.endElement(uri, local, qualified);
    }
    override characters(value: string, start: number, length: number) {
      token();
      // XML character references are decoded by xmldom before this callback.
      // Its grammar checks syntax, but not every XML 1.0 character range.
      if (!xmlCharacters(value.slice(start, start + length)))
        reject("BPMN_MALFORMED_XML");
      super.characters(value, start, length);
    }
    override comment(value: string, start: number, length: number) {
      token();
      super.comment(value, start, length);
    }
    override startDTD(): never {
      return reject("BPMN_UNSAFE_XML");
    }
    override processingInstruction(target: string, data: string) {
      token();
      if (target === "xml") {
        // The existing XML parser already validated declaration grammar. Only
        // extract its declared encoding, never parse BPMN semantics with regex.
        const encoding = /\bencoding\s*=\s*(["'])([^"']+)\1/.exec(data)?.[2];
        if (encoding && encoding.toLowerCase() !== "utf-8")
          reject("BPMN_XML_ENCODING");
        const version = /\bversion\s*=\s*(["'])([^"']+)\1/.exec(data)?.[2];
        // The retained writer emits XML 1.0. XML 1.1-only characters and opaque
        // subtrees cannot be promised a lossless edit through that writer.
        if (version && version !== "1.0")
          reject("BPMN_UNSUPPORTED_XML_VERSION");
      }
      super.processingInstruction(target, data);
    }
  }
  try {
    const document = new DOMParser({
      domHandler: BoundedHandler,
      onError: (level, message) => {
        // A literal U+FFFD can be valid UTF-8. Fatal byte decoding, not this
        // xmldom heuristic, owns encoding rejection. All syntax warnings fail.
        if (
          level === "warning" &&
          message ===
            "Unicode replacement character detected, source encoding issues?"
        )
          return;
        reject("BPMN_MALFORMED_XML");
      },
      // NEL/LS are not newlines in XML 1.0. Normalize only this parser's
      // working copy, not the canonical source retained for exact download.
      normalizeLineEndings: (value) => value.replace(/\r\n?/g, "\n"),
    }).parseFromString(
      source.startsWith("\uFEFF") ? source.slice(1) : source,
      "application/xml",
    );
    if (!document.documentElement) reject("BPMN_MALFORMED_XML");
    return document;
  } catch (error) {
    throw new XmlInputError(
      rejection ??
        (error instanceof ParseError
          ? "BPMN_MALFORMED_XML"
          : "BPMN_PARSER_FAILURE"),
    );
  }
}
