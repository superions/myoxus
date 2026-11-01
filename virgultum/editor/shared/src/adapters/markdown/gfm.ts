/*
MIT License

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

mdast-util-gfm-autolink-literal is from markdown only.
*/
// Keep the writer data augmentation available to every parser consumer.
import type {} from "remark-stringify";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import {
  gfmFootnoteFromMarkdown,
  gfmFootnoteToMarkdown,
} from "mdast-util-gfm-footnote";
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from "mdast-util-gfm-task-list-item";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { combineExtensions } from "micromark-util-combine-extensions";
import type { Processor } from "unified";

export function gfm(
  rejectMissingFootnotes = false,
  allowMissingFootnotes = false,
  withoutAutolinks = false,
) {
  const footnotes = gfmFootnote();
  const call = footnotes.text?.[91];
  if (
    (rejectMissingFootnotes || allowMissingFootnotes) &&
    call &&
    !Array.isArray(call)
  ) {
    const tokenize = call.tokenize;
    call.tokenize = function (effects, ok, nok) {
      const known = this.parser.gfmFootnotes ?? (this.parser.gfmFootnotes = []);
      // The existing tokenizer owns escaped/code boundaries and labels. Only
      // change its undefined-reference fallback to a pre-write diagnostic.
      this.parser.gfmFootnotes = new Proxy(known, {
        get(target, property, receiver) {
          if (property === "includes")
            return (label: string) => {
              if (!target.includes(label) && rejectMissingFootnotes)
                throw new Error(`Missing footnote definition: ${label}`);
              return true;
            };
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        return tokenize.call(this, effects, ok, nok);
      } finally {
        this.parser.gfmFootnotes = known;
      }
    };
  }
  return combineExtensions([
    ...(withoutAutolinks ? [] : [gfmAutolinkLiteral()]),
    gfmStrikethrough(),
    gfmTable(),
    gfmTaskListItem(),
    footnotes,
  ]);
}

function gfmFromMarkdown(deferAutolinks: boolean) {
  const autolinks = gfmAutolinkLiteralFromMarkdown();
  if (deferAutolinks) delete autolinks.transforms;
  return [
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
    autolinks,
    gfmFootnoteFromMarkdown(),
  ];
}

function gfmToMarkdown() {
  return {
    extensions: [
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(),
      gfmTaskListItemToMarkdown(),
      gfmFootnoteToMarkdown(),
    ],
  };
}

export function remarkGfm(
  this: Processor,
  options?: {
    deferAutolinks?: boolean;
    rejectMissingFootnotes?: boolean;
    allowMissingFootnotes?: boolean;
    withoutAutolinks?: boolean;
  },
) {
  // oxlint-disable-next-line typescript/no-this-alias
  const self = this;
  const data = self.data();

  const micromarkExtensions =
    data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions =
    data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);
  const toMarkdownExtensions =
    data.toMarkdownExtensions || (data.toMarkdownExtensions = []);

  micromarkExtensions.push(
    gfm(
      options?.rejectMissingFootnotes,
      options?.allowMissingFootnotes,
      options?.withoutAutolinks,
    ),
  );
  fromMarkdownExtensions.push(
    gfmFromMarkdown(options?.deferAutolinks ?? false),
  );
  toMarkdownExtensions.push(gfmToMarkdown());
}

/** Run the existing GFM postpass after native source constructs claim their
 * spans. Its find/replace otherwise removes positions and splits wiki URLs. */
export function remarkGfmAutolinks() {
  const transforms = gfmAutolinkLiteralFromMarkdown().transforms ?? [];
  return (tree: Parameters<(typeof transforms)[number]>[0]) => {
    for (const transform of transforms) tree = transform(tree) ?? tree;
    return tree;
  };
}
