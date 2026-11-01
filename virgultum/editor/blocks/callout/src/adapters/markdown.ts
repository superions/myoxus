// SPDX-License-Identifier: MIT
import { CalloutBlockSchema, calloutPresentation } from "@virgultum/model";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  CALLOUT_MARKDOWN_EXPORT_OPTIONS_KEY,
  CalloutExportStyle,
  calloutMarkdownExportOptionsSchema,
  DEFAULT_ADMONITION_TYPE,
  getCalloutEmoji,
  isCalloutNode,
  withMarkdownAnchor,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid } from "@virgultum/store";

const textSnapshot = (value: string) => ({
  "$virgultum:internal:text$": true,
  delta: value ? [{ insert: value }] : [],
});
const textValue = (value: unknown): string => {
  const delta = (value as { delta?: DeltaInsert[] } | undefined)?.delta;
  return (
    delta
      ?.map((part) => (typeof part.insert === "string" ? part.insert : ""))
      .join("") ?? ""
  );
};
const exportOptions = (configs: Map<string, unknown>) => {
  const parsed = calloutMarkdownExportOptionsSchema.safeParse(
    configs.get(CALLOUT_MARKDOWN_EXPORT_OPTIONS_KEY),
  );
  return parsed.success ? parsed.data : { style: CalloutExportStyle.GFM };
};
export const calloutBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: CalloutBlockSchema.model.flavour,
  toMatch: (o) => isCalloutNode(o.node),
  fromMatch: (o) => o.node.flavour === CalloutBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, { walkerContext, deltaConverter }) => {
      if (!isCalloutNode(o.node)) return;
      const type = o.node.data?.calloutType;
      walkerContext.openNode(
        {
          type: "block",
          id: nanoid(),
          flavour: CalloutBlockSchema.model.flavour,
          props: {
            markdownAnchor: o.node.data?.markdownAnchor,
            icon: {
              type: "emoji",
              unicode: type
                ? calloutPresentation(type).icon
                : getCalloutEmoji(o.node),
            },
            text:
              type && o.node.children[0]?.type === "paragraph"
                ? {
                    "$virgultum:internal:text$": true,
                    delta: deltaConverter.astToDelta(o.node.children[0]),
                  }
                : textSnapshot(""),
            ...(type
              ? {
                  type,
                  backgroundColorName: calloutPresentation(type).background,
                  title: textSnapshot(o.node.data?.calloutTitle ?? ""),
                  foldable: o.node.data?.calloutFoldable,
                  defaultOpen: o.node.data?.calloutDefaultOpen,
                }
              : {}),
          },
          children: [],
        },
        "children",
      );
      if (type && o.node.children[0]?.type === "paragraph")
        walkerContext.skipChildren(1);
    },
    leave: (o, { walkerContext }) => {
      if (isCalloutNode(o.node)) walkerContext.closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: (o, { walkerContext, deltaConverter, configs }) => {
      const options = exportOptions(configs);
      const semantic =
        typeof o.node.props.type === "string" && !!o.node.props.type;
      // Legacy appearance/icon fields are not a semantic type or a title.
      const title = semantic ? textValue(o.node.props.title) : "";
      const icon = o.node.props.icon as
        { type?: string; unicode?: string } | undefined;
      const header = semantic
        ? `[!${o.node.props.type}]${o.node.props.foldable ? (o.node.props.defaultOpen === false ? "-" : "+") : ""}${title ? ` ${title}` : ""}`
        : `[!${icon?.type === "emoji" ? (icon.unicode ?? "") : ""}]`;
      const admonitions =
        !semantic && options.style === CalloutExportStyle.Admonitions;
      if (!admonitions)
        walkerContext.openNode(
          { type: "blockquote", children: [] },
          "children",
        );
      walkerContext
        .openNode({
          type: "paragraph",
          children: [
            {
              type: "myoxusCalloutHeader",
              value: admonitions
                ? `::: ${options.admonitionType ?? DEFAULT_ADMONITION_TYPE}`
                : header,
            },
          ],
        })
        .closeNode();
      const own = o.node.props.text as { delta?: DeltaInsert[] } | undefined;
      if (own?.delta?.length || o.node.props.markdownAnchor !== undefined)
        walkerContext
          .openNode(
            {
              type: "paragraph",
              children: withMarkdownAnchor(
                deltaConverter.deltaToAST(own?.delta ?? [], 0),
                o.node.props.markdownAnchor,
              ),
            },
            "children",
          )
          .closeNode();
    },
    leave: (o, { walkerContext, configs }) => {
      const options = exportOptions(configs);
      if (
        !o.node.props.type &&
        options.style === CalloutExportStyle.Admonitions
      ) {
        walkerContext
          .openNode({
            type: "paragraph",
            children: [{ type: "myoxusCalloutHeader", value: ":::" }],
          })
          .closeNode();
      } else walkerContext.closeNode();
    },
  },
};
export const CalloutBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(calloutBlockMarkdownAdapterMatcher);
