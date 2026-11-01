import { ListBlockSchema } from "@virgultum/model";
import {
  BlockHtmlAdapterExtension,
  type BlockHtmlAdapterMatcher,
  HastUtils,
} from "@virgultum/shared/adapters";
import { type DeltaInsert, nanoid } from "@virgultum/store";
import type { Element } from "hast";

type HtmlListType = "bulleted" | "numbered" | "todo";

const getHtmlListType = (type: unknown): HtmlListType => {
  if (type === "numbered" || type === "todo") {
    return type;
  }
  return "bulleted";
};

const getListTagName = (type: HtmlListType) =>
  type === "numbered" ? "ol" : "ul";

const isListElementForType = (node: Element, type: HtmlListType) =>
  node.tagName === getListTagName(type) &&
  Array.isArray(node.properties.className) &&
  node.properties.className.includes(`${type}-list`);

const isCheckedTodoItem = (node: Element, firstElementChild?: Element) => {
  if (
    firstElementChild &&
    Array.isArray(firstElementChild.properties.className) &&
    firstElementChild.properties.className.includes("checkbox-on")
  ) {
    return true;
  }
  const checkbox = HastUtils.querySelector(node, "input");
  return (
    checkbox?.properties.type === "checkbox" &&
    checkbox.properties.checked !== undefined &&
    checkbox.properties.checked !== false
  );
};

export const listBlockHtmlAdapterMatcher: BlockHtmlAdapterMatcher = {
  flavour: ListBlockSchema.model.flavour,
  toMatch: (o) => HastUtils.isElement(o.node) && o.node.tagName === "li",
  fromMatch: (o) => o.node.flavour === ListBlockSchema.model.flavour,
  toBlockSnapshot: {
    enter: (o, context) => {
      if (!HastUtils.isElement(o.node)) {
        return;
      }

      const parentList = o.parent?.node as Element;
      let listType = "bulleted";
      if (parentList.tagName === "ol") {
        listType = "numbered";
      } else if (Array.isArray(parentList.properties?.className)) {
        if (
          parentList.properties.className.includes("to-do-list") ||
          parentList.properties.className.includes("todo-list")
        ) {
          listType = "todo";
        } else if (parentList.properties.className.includes("toggle")) {
          listType = "toggle";
        } else if (parentList.properties.className.includes("bulleted-list")) {
          listType = "bulleted";
        }
      }

      const listNumber =
        typeof parentList.properties.start === "number"
          ? parentList.properties.start + parentList.children.indexOf(o.node)
          : null;
      const firstElementChild = HastUtils.getElementChildren(o.node)[0];
      o.node = HastUtils.flatNodes(
        o.node,
        (tagName) => tagName === "div" || tagName === "p",
      ) as Element;

      const { walkerContext, deltaConverter } = context;
      walkerContext.openNode(
        {
          type: "block",
          id: nanoid(),
          flavour: "myoxus:list",
          props: {
            type: listType,
            text: {
              "$virgultum:internal:text$": true,
              delta:
                listType !== "toggle"
                  ? deltaConverter.astToDelta(
                      HastUtils.getInlineOnlyElementAST(o.node),
                    )
                  : deltaConverter.astToDelta(
                      HastUtils.querySelector(o.node, "summary") ?? o.node,
                    ),
            },
            checked:
              listType === "todo"
                ? isCheckedTodoItem(o.node, firstElementChild)
                : false,
            collapsed:
              listType === "toggle"
                ? firstElementChild &&
                  firstElementChild.tagName === "details" &&
                  firstElementChild.properties.open === undefined
                : false,
            order: listNumber,
          },
          children: [],
        },
        "children",
      );
    },
    leave: (_, context) => {
      const { walkerContext } = context;
      walkerContext.closeNode();
    },
  },
  fromBlockSnapshot: {
    enter: (o, context) => {
      const text = (o.node.props.text ?? { delta: [] }) as {
        delta: DeltaInsert[];
      };
      const { deltaConverter, walkerContext } = context;
      const currentTNode = walkerContext.currentNode();
      const type = getHtmlListType(o.node.props.type);
      let liChildren = deltaConverter.deltaToAST(text.delta);
      if (type === "todo") {
        liChildren = [
          {
            type: "element",
            tagName: "label",
            properties: {
              className: ["todo-list-label"],
            },
            children: [
              {
                type: "element",
                tagName: "input",
                properties: {
                  type: "checkbox",
                  checked: o.node.props.checked as boolean,
                  disabled: true,
                },
                children: [],
              },
              ...liChildren,
            ],
          },
        ];
      }
      // check if the list is of the same type
      if (
        walkerContext.getNodeContext("myoxus:list:parent") === o.parent &&
        currentTNode.type === "element" &&
        isListElementForType(currentTNode, type)
      ) {
        // if true, add the list item to the list
      } else {
        // if false, create a new list
        walkerContext.openNode(
          {
            type: "element",
            tagName: getListTagName(type),
            properties: {
              className: [`${type}-list`],
              ...(type === "numbered" &&
              typeof o.node.props.order === "number" &&
              o.node.props.order !== 1
                ? { start: o.node.props.order }
                : {}),
            },
            children: [],
          },
          "children",
        );
        walkerContext.setNodeContext("myoxus:list:parent", o.parent);
      }

      walkerContext.openNode(
        {
          type: "element",
          tagName: "li",
          properties: {
            className: ["myoxus-list-block-container"],
          },
          children: liChildren,
        },
        "children",
      );
    },
    leave: (o, context) => {
      const { walkerContext } = context;
      const currentTNode = walkerContext.currentNode() as Element;
      const previousTNode = walkerContext.previousNode() as Element;
      const type = getHtmlListType(o.node.props.type);
      if (
        walkerContext.getPreviousNodeContext("myoxus:list:parent") ===
          o.parent &&
        currentTNode.tagName === "li" &&
        isListElementForType(previousTNode, type)
      ) {
        walkerContext.closeNode();
        if (
          o.next?.flavour !== "myoxus:list" ||
          o.next.props.type !== o.node.props.type ||
          (type === "numbered" &&
            typeof o.next.props.order === "number" &&
            o.next.props.order !==
              Number(previousTNode.properties.start ?? 1) +
                previousTNode.children.length)
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

export const ListBlockHtmlAdapterExtension = BlockHtmlAdapterExtension(
  listBlockHtmlAdapterMatcher,
);
