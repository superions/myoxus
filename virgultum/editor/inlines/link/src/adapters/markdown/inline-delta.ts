import { InlineDeltaToMarkdownAdapterExtension } from "@virgultum/shared/adapters";
import type { PhrasingContent } from "mdast";

export const linkDeltaToMarkdownAdapterMatcher =
  InlineDeltaToMarkdownAdapterExtension({
    name: "link",
    match: (delta) => !!delta.attributes?.link,
    toAST: (delta, context) => {
      const mdast: PhrasingContent = {
        type: "text",
        value: delta.insert,
      };
      const link = delta.attributes?.link;
      if (!link) {
        return mdast;
      }
      // Parentheses in a destination would be emitted as `\(` / `\)`. The
      // LaTeX preprocessor intentionally recognizes that spelling, so keep
      // links byte-stable by using the equivalent URI encoding instead.
      const stableLink = link.replaceAll("(", "%28").replaceAll(")", "%29");

      const { current: currentMdast } = context;
      if ("value" in currentMdast) {
        if (currentMdast.value === "") {
          return { type: "text", value: stableLink };
        }
        if (mdast.value !== link) {
          return {
            type: "link",
            url: stableLink,
            children: [currentMdast],
          };
        }
      }
      return mdast;
    },
  });
