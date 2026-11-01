import { ListBlockSchema } from "@virgultum/model";
import {
  AdapterTextUtils,
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
  type MarkdownAST,
  withMarkdownAnchor,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid } from "@virgultum/store";
import type { List } from "mdast";

const LIST_MDAST_TYPE = new Set(["list", "listItem"]);
const isListMDASTType = (node: MarkdownAST) => LIST_MDAST_TYPE.has(node.type);

export const listBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: ListBlockSchema.model.flavour,
  toMatch: (o) => isListMDASTType(o.node),
  fromMatch: (o) => o.node.flavour === ListBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext, deltaConverter } = context;
      if (o.node.type === "listItem") {
        const parentList = o.parent?.node as List;
        const listNumber = parentList.start
          ? parentList.start + parentList.children.indexOf(o.node)
          : null;
        walkerContext.openNode(
          {
            type: "block",
            id: nanoid(),
            flavour: "myoxus:list",
            props: {
              type:
                o.node.checked !== null
                  ? "todo"
                  : parentList.ordered
                    ? "numbered"
                    : "bulleted",
              text: {
                "$virgultum:internal:text$": true,
                delta:
                  o.node.children[0] && o.node.children[0].type === "paragraph"
                    ? deltaConverter.astToDelta(o.node.children[0])
                    : [],
              },
              checked: o.node.checked ?? false,
              collapsed: false,
              order: listNumber,
              markdownAnchor: o.node.data?.markdownAnchor,
            },
            children: [],
          },
          "children",
        );
        if (o.node.children[0] && o.node.children[0].type === "paragraph") {
          walkerContext.skipChildren(1);
        }
      }
    },
    leave: (o, context) => {
      const { walkerContext } = context;
      if (o.node.type === "listItem") {
        walkerContext.closeNode();
      }
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const { walkerContext, deltaConverter } = context;
      const text = (o.node.props.text ?? { delta: [] }) as {
        delta: DeltaInsert[];
      };
      const currentTNode = walkerContext.currentNode();
      const isNumbered = o.node.props.type === "numbered";
      const order =
        isNumbered && typeof o.node.props.order === "number"
          ? o.node.props.order
          : null;
      const continuesNumbering =
        currentTNode.type !== "list" ||
        !isNumbered ||
        order === null ||
        order === (currentTNode.start ?? 1) + currentTNode.children.length;
      // check if the list is of the same type
      if (
        walkerContext.getNodeContext("myoxus:list:parent") === o.parent &&
        currentTNode.type === "list" &&
        currentTNode.ordered === isNumbered &&
        continuesNumbering &&
        AdapterTextUtils.isNullish(currentTNode.children[0].checked) ===
          AdapterTextUtils.isNullish(
            o.node.props.type === "todo"
              ? (o.node.props.checked as boolean)
              : undefined,
          )
      ) {
        // if true, add the list item to the list
      } else {
        // if false, create a new list
        walkerContext
          .openNode(
            {
              type: "list",
              ordered: isNumbered,
              start: order ?? undefined,
              spread: false,
              children: [],
            },
            "children",
          )
          .setNodeContext("myoxus:list:parent", o.parent);
      }
      walkerContext
        .openNode(
          {
            type: "listItem",
            checked:
              o.node.props.type === "todo"
                ? (o.node.props.checked as boolean)
                : undefined,
            spread: false,
            children: [],
          },
          "children",
        )
        .openNode(
          {
            type: "paragraph",
            children: withMarkdownAnchor(
              deltaConverter.deltaToAST(text.delta),
              o.node.props.markdownAnchor,
            ),
          },
          "children",
        )
        .closeNode();
    },
    leave: (o, context) => {
      const { walkerContext } = context;
      const currentTNode = walkerContext.currentNode();
      const previousTNode = walkerContext.previousNode();
      if (
        walkerContext.getPreviousNodeContext("myoxus:list:parent") ===
          o.parent &&
        currentTNode.type === "listItem" &&
        previousTNode?.type === "list" &&
        previousTNode.ordered === (o.node.props.type === "numbered") &&
        AdapterTextUtils.isNullish(currentTNode.checked) ===
          AdapterTextUtils.isNullish(
            o.node.props.type === "todo"
              ? (o.node.props.checked as boolean)
              : undefined,
          )
      ) {
        walkerContext.closeNode();
        const currentOrder =
          typeof o.node.props.order === "number" ? o.node.props.order : null;
        const nextOrder =
          o.next && typeof o.next.props.order === "number"
            ? o.next.props.order
            : null;
        const nextContinuesNumbering =
          o.node.props.type !== "numbered" ||
          currentOrder === null ||
          nextOrder === null ||
          nextOrder === currentOrder + 1;
        if (
          o.next?.flavour !== "myoxus:list" ||
          o.next.props.type !== o.node.props.type ||
          !nextContinuesNumbering
        ) {
          // If the next node is not a list or different type of list, close the list
          walkerContext.closeNode();
        }
      } else {
        walkerContext.closeNode().closeNode();
      }
    },
  },
};

export const ListBlockMarkdownAdapterExtension = BlockMarkdownAdapterExtension(
  listBlockMarkdownAdapterMatcher,
);
