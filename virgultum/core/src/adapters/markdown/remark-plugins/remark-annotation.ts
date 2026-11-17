// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Literal, Nodes, Root, Text } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Options as ToMarkdownExtension } from "mdast-util-to-markdown";
import type {
  Code,
  Construct,
  Extension,
  State,
  Tokenizer,
} from "micromark-util-types";
import type { Plugin } from "unified";
import { serializeAnnotationBody } from "../annotation-syntax";
import {
  prepareAnnotationSource,
  type PreparedAnnotationSource,
} from "../annotation-source";

export interface AnnotationInlineNode extends Literal {
  type: "myoxusAnnotation";
  value: string;
}
export interface AnnotationBlockNode extends Literal {
  type: "myoxusAnnotationBlock";
  value: string;
}
declare module "mdast" {
  interface PhrasingContentMap {
    myoxusAnnotation: AnnotationInlineNode;
  }
  interface BlockContentMap {
    myoxusAnnotationBlock: AnnotationBlockNode;
  }
  interface RootContentMap {
    myoxusAnnotation: AnnotationInlineNode;
    myoxusAnnotationBlock: AnnotationBlockNode;
  }
}
declare module "micromark-util-types" {
  interface TokenTypeMap {
    myoxusAnnotation: "myoxusAnnotation";
    myoxusAnnotationBlock: "myoxusAnnotationBlock";
    myoxusAnnotationData: "myoxusAnnotationData";
  }
}

const lineEnding = (code: Code) => code === -3 || code === -4 || code === -5;

function tokenizer(
  block: boolean,
  prepared: () => PreparedAnnotationSource,
): Tokenizer {
  return function (effects, ok, nok) {
    const type = block ? "myoxusAnnotationBlock" : "myoxusAnnotation";
    const interrupt = this.interrupt;
    const startOffset = this.now().offset;
    return start;
    function start(code: Code): State | undefined {
      if (block && interrupt) return nok(code);
      if (code !== 37) return nok(code);
      if (!prepared().bodies.has(startOffset)) return nok(code);
      effects.enter(type);
      effects.enter("myoxusAnnotationData");
      effects.consume(code);
      return second;
    }
    function second(code: Code): State | undefined {
      if (code !== 37) return nok(code);
      effects.consume(code);
      return body;
    }
    function body(code: Code): State | undefined {
      if (code === null) return nok(code);
      if (code === 37) {
        effects.consume(code);
        return closing;
      }
      effects.consume(code);
      return body;
    }
    function closing(code: Code): State | undefined {
      if (code !== 37) {
        return body(code);
      }
      effects.consume(code);
      effects.exit("myoxusAnnotationData");
      effects.exit(type);
      return block
        ? effects.check(
            { partial: true, tokenize: standaloneEnd },
            consumeTrailing,
            nok,
          )
        : ok;
    }
    function consumeTrailing(code: Code): State | undefined {
      // Flow constructs must finish at EOL/EOF, not leave verified padding for
      // the enclosing tokenizer. Padding remains outside the annotation token.
      if (code === 32 || code === -2 || code === -1) {
        effects.enter("whitespace");
        effects.consume(code);
        effects.exit("whitespace");
        return consumeTrailing;
      }
      return ok(code);
    }
    function standaloneEnd(
      checkEffects: Parameters<Tokenizer>[0],
      yes: State,
      no: State,
    ): State {
      return trailing;
      function trailing(code: Code): State | undefined {
        if (code === 32 || code === -2 || code === -1) {
          checkEffects.enter("whitespace");
          checkEffects.consume(code);
          checkEffects.exit("whitespace");
          return trailing;
        }
        if (code === null) return yes(code);
        if (!lineEnding(code)) return no(code);
        checkEffects.enter("lineEnding");
        checkEffects.consume(code);
        checkEffects.exit("lineEnding");
        return nextLine;
      }
      function nextLine(code: Code): State | undefined {
        if (code === 32 || code === -2 || code === -1) {
          checkEffects.enter("whitespace");
          checkEffects.consume(code);
          checkEffects.exit("whitespace");
          return nextLine;
        }
        return code === null || lineEnding(code) ? yes(code) : no(code);
      }
    }
  };
}

const syntax = (prepared: () => PreparedAnnotationSource): Extension => ({
  flow: {
    37: {
      name: "myoxusAnnotationBlock",
      concrete: true,
      tokenize: tokenizer(true, prepared),
    } satisfies Construct,
  },
  text: {
    37: {
      name: "myoxusAnnotation",
      tokenize: tokenizer(false, prepared),
    } satisfies Construct,
  },
});
const fromMarkdown = (
  prepared: () => PreparedAnnotationSource,
): FromMarkdownExtension => ({
  enter: {
    myoxusAnnotation(token) {
      this.enter({ type: "myoxusAnnotation", value: "" }, token);
    },
    myoxusAnnotationBlock(token) {
      this.enter({ type: "myoxusAnnotationBlock", value: "" }, token);
    },
  },
  exit: {
    myoxusAnnotation(token) {
      const node = this.stack[this.stack.length - 1] as
        AnnotationInlineNode | Text;
      const body = prepared().bodies.get(token.start.offset)!.body;
      // Consume a complete empty pair as literal text, so overlapping '%' runs
      // cannot accidentally become a different nonempty annotation.
      node.type = body ? "myoxusAnnotation" : "text";
      node.value = body || "%%%%";
      this.exit(token);
    },
    myoxusAnnotationBlock(token) {
      const node = this.stack[this.stack.length - 1] as AnnotationBlockNode;
      node.value = prepared().bodies.get(token.start.offset)!.body;
      this.exit(token);
    },
  },
});
const toMarkdown: ToMarkdownExtension = {
  unsafe: [{ character: "%", inConstruct: "phrasing" }],
  handlers: {
    myoxusAnnotation(node) {
      return serializeAnnotationBody((node as AnnotationInlineNode).value);
    },
    myoxusAnnotationBlock(node) {
      return serializeAnnotationBody((node as AnnotationBlockNode).value);
    },
  },
};

/** Capture literal bodies at tokenization, before emphasis/links/block parsing. */
export const remarkAnnotation: Plugin<[], Root> = function () {
  let prepared: PreparedAnnotationSource = {
    source: "",
    bodies: new Map(),
    pending: new Set(),
    protectedRanges: [],
    unsupportedRanges: [],
  };
  const parse = this.parser;
  if (parse)
    this.parser = (source, file) => {
      prepared = prepareAnnotationSource(source);
      return parse(prepared.source, file);
    };
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax(() => prepared));
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown(() => prepared));
  (data.toMarkdownExtensions ??= []).push(toMarkdown);
};

export function hasPendingAnnotationSyntax(source: string): boolean {
  return prepareAnnotationSource(source).pending.size > 0;
}

export type AnnotationSyntaxSpan = {
  index: number;
  length: number;
  body: string;
  standalone: boolean;
};

/** The same registered tokenizer supplies input/HTML recognition, not a regex parser. */
export function findAnnotationSyntaxSpans(
  source: string,
): AnnotationSyntaxSpan[] {
  if (!source.includes("%%")) return [];
  const processor = unified().use(remarkParse).use(remarkAnnotation);
  const tree = processor.runSync(processor.parse(source));
  const spans: AnnotationSyntaxSpan[] = [];
  const collect = (node: Nodes) => {
    if (
      node.type === "myoxusAnnotation" ||
      node.type === "myoxusAnnotationBlock"
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        spans.push({
          index: start,
          length: end - start,
          body: node.value,
          standalone: node.type === "myoxusAnnotationBlock",
        });
    } else if ("children" in node) node.children.forEach(collect);
  };
  collect(tree);
  return spans;
}
