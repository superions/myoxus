// SPDX-License-Identifier: AGPL-3.0-or-later
import { CalloutBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
} from "@virgultum/shared/adapters";
import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
} from "@virgultum/shared/services";
import type { DeltaInsert } from "@virgultum/store";

/** Reading export keeps callout content visible; annotation hiding is independent. */
const matcher: BlockHtmlAdapterMatcher = {
  flavour: CalloutBlockSchema.model.flavour,
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === CalloutBlockSchema.model.flavour,
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (o, { walkerContext, deltaConverter, provider }) => {
      walkerContext.openNode(
        { type: "element", tagName: "aside", properties: {}, children: [] },
        "children",
      );
      if (o.node.props.type) {
        const title =
          (o.node.props.title as { delta?: DeltaInsert[] } | undefined)?.delta
            ?.map((part) => part.insert ?? "")
            .join("") ||
          (String(o.node.props.type).toLowerCase() === "note"
            ? resolveEditorMessage(
                editorMessage("com.myoxus.editor.callout.note", "Note"),
                provider?.getOptional(EditorI18nProvider) ?? undefined,
              )
            : String(o.node.props.type));
        walkerContext
          .openNode({
            type: "element",
            tagName: "p",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "strong",
                properties: {},
                children: [{ type: "text", value: title }],
              },
            ],
          })
          .closeNode();
      }
      const body = (o.node.props.text as { delta?: DeltaInsert[] } | undefined)
        ?.delta;
      if (body?.length)
        walkerContext
          .openNode({
            type: "element",
            tagName: "p",
            properties: {},
            children: deltaConverter.deltaToAST(body),
          })
          .closeNode();
    },
    leave: (_o, { walkerContext }) => {
      walkerContext.closeNode();
    },
  },
};
export const CalloutBlockHtmlAdapterExtension =
  BlockHtmlAdapterExtension(matcher);
