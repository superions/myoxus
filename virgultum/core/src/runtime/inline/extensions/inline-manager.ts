import {
  createIdentifier,
  type ServiceIdentifier,
} from "../../../primitives/di/index";
import {
  type BaseTextAttributes,
  baseTextAttributes,
  type DeltaInsert,
  type ExtensionType,
} from "../../../store/index";
import { z } from "zod";

import { StdIdentifier } from "../../identifier.js";
import type { BlockStdScope } from "../../scope/index.js";
import type { AttributeRenderer } from "../types.js";
import { getDefaultAttributeRenderer } from "../utils/attribute-renderer.js";
import { MarkdownMatcherIdentifier } from "./markdown-matcher.js";
import type { InlineMarkdownMatch, InlineSpecs } from "./type.js";

export class InlineManager<TextAttributes extends BaseTextAttributes> {
  embedChecker = (delta: DeltaInsert<TextAttributes>) => {
    for (const spec of this.specs) {
      if (spec.embed && spec.match(delta)) {
        return typeof spec.embed === "function" ? spec.embed(delta) : true;
      }
    }
    return false;
  };

  getRenderer = (): AttributeRenderer<TextAttributes> => {
    const defaultRenderer = getDefaultAttributeRenderer<TextAttributes>();

    const leaves = this.specs.filter((spec) => !spec.wrapper).reverse();
    const wrappers = this.specs.filter((spec) => spec.wrapper);
    const renderer: AttributeRenderer<TextAttributes> = (props, parent) => {
      // Build the outermost matching wrapper first; selection and caret remain
      // attached to the leaf while the same attribute roles are active.
      for (const spec of wrappers) {
        if (spec.match(props.delta)) parent = spec.renderer(props, parent);
      }
      const leaf = leaves.find((spec) => spec.match(props.delta));
      return (leaf?.renderer ?? defaultRenderer)(props, parent);
    };
    return renderer;
  };

  getSchema = (): z.ZodType<TextAttributes> => {
    const schema = this.specs.reduce<z.ZodSchema>((acc, cur) => {
      return z.intersection(acc, cur.schema);
    }, baseTextAttributes);
    // The registered inline specs collectively own this editor's attribute type.
    return schema as z.ZodType<TextAttributes>;
  };

  get markdownMatches(): InlineMarkdownMatch<TextAttributes>[] {
    if (!this.enableMarkdown) {
      return [];
    }
    const matches = Array.from(
      this.std.provider.getAll(MarkdownMatcherIdentifier).values(),
    );
    return matches as InlineMarkdownMatch<TextAttributes>[];
  }

  readonly specs: Array<InlineSpecs<TextAttributes>>;

  constructor(
    readonly std: BlockStdScope,
    readonly enableMarkdown: boolean,
    ...specs: Array<InlineSpecs<TextAttributes>>
  ) {
    this.specs = specs;
  }
}

export type InlineManagerExtensionConfig<
  TextAttributes extends BaseTextAttributes,
> = {
  id: string;
  enableMarkdown?: boolean;
  specs: ServiceIdentifier<InlineSpecs<TextAttributes>>[];
};

const InlineManagerIdentifier = createIdentifier<unknown>(
  "MyoxusInlineManager",
);

export function InlineManagerExtension<
  TextAttributes extends BaseTextAttributes,
>({
  id,
  enableMarkdown = true,
  specs,
}: InlineManagerExtensionConfig<TextAttributes>): ExtensionType & {
  identifier: ServiceIdentifier<InlineManager<TextAttributes>>;
} {
  const identifier = InlineManagerIdentifier<InlineManager<TextAttributes>>(id);
  return {
    setup: (di) => {
      di.addImpl(identifier, (provider) => {
        return new InlineManager(
          provider.get(StdIdentifier),
          enableMarkdown,
          ...specs.map((spec) => provider.get(spec)),
        );
      });
    },
    identifier,
  };
}
