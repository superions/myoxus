import {
  createIdentifier,
  type ServiceIdentifier,
  type ServiceProvider,
} from "@virgultum/global/di";
import { nanoid, type ExtensionType } from "@virgultum/store";

import {
  type AdapterPreprocessor,
  PreprocessorManager,
  type PreprocessLevel,
} from "../types/preprocessor";
import type { Markdown } from "./type";
import { prepareAnnotationSource } from "./annotation-source";

export type MarkdownAdapterPreprocessor = AdapterPreprocessor<Markdown>;

const MarkdownPreprocessorIdentifier =
  createIdentifier<MarkdownAdapterPreprocessor>("MarkdownPreprocessor");

export const MarkdownPreprocessorExtension = (
  preprocessor: MarkdownAdapterPreprocessor,
): ExtensionType & {
  identifier: ServiceIdentifier<MarkdownAdapterPreprocessor>;
} => {
  const identifier = MarkdownPreprocessorIdentifier(preprocessor.name);
  return {
    setup: (di) => {
      di.addImpl(identifier, () => preprocessor);
    },
    identifier,
  };
};

export class MarkdownPreprocessorManager extends PreprocessorManager<
  Markdown,
  MarkdownAdapterPreprocessor
> {
  override process(level: PreprocessLevel, content: Markdown): Markdown {
    if (!content.includes("%%")) return super.process(level, content);
    const spans = prepareAnnotationSource(content).bodies;
    if (!spans.size) return super.process(level, content);
    const protectedBodies: string[] = [];
    let prefix: string;
    do {
      prefix = `MYOXUSANNOTATION${nanoid().replaceAll("-", "X").replaceAll("_", "Y")}`;
    } while (content.includes(prefix));
    let offset = 0;
    let source = "";
    // Legacy LaTeX/URL preprocessors run before the Markdown extension. Their
    // rewrites must never execute inside literal bodies; tokens are private to
    // this call and restored before any parser or snapshot sees the content.
    for (const [start, { end }] of spans) {
      const key = `${prefix}${protectedBodies.length}END`;
      source += content.slice(offset, start + 2) + key;
      protectedBodies.push(content.slice(start + 2, end - 2));
      offset = end - 2;
    }
    source += content.slice(offset);
    const seen = new Set<number>();
    const result = super
      .process(level, source)
      .replace(
        new RegExp(`${prefix}(\\d+)END`, "g"),
        (_token, value: string) => {
          const index = Number(value);
          if (index >= protectedBodies.length || seen.has(index))
            throw new Error(
              "Markdown preprocessing duplicated a literal annotation span",
            );
          seen.add(index);
          return protectedBodies[index];
        },
      );
    if (seen.size !== protectedBodies.length)
      throw new Error(
        "Markdown preprocessing did not preserve a literal annotation span",
      );
    return result;
  }

  constructor(provider: ServiceProvider) {
    super(provider, MarkdownPreprocessorIdentifier);
  }
}
