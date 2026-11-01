import { managedSurfaceSnapshotChildren } from "../managed-elements.js";
import {
  BlockMarkdownAdapterExtension,
  type BlockMarkdownAdapterMatcher,
} from "@virgultum/shared/adapters";

import { MarkdownElementModelAdapter } from "./element-adapter/index.js";
import { ElementToMarkdownAdapterMatcherIdentifier } from "./element-adapter/type.js";

export const surfaceBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher = {
  flavour: "myoxus:surface",
  toMatch: () => false,
  fromMatch: (o) => o.node.flavour === "myoxus:surface",
  toBlockSnapshot: {},
  fromBlockSnapshot: {
    enter: (_, context) => {
      context.walkerContext.skipAllChildren();
    },
  },
};

export const SurfaceBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(surfaceBlockMarkdownAdapterMatcher);

export const edgelessSurfaceBlockMarkdownAdapterMatcher: BlockMarkdownAdapterMatcher =
  {
    flavour: "myoxus:surface",
    toMatch: () => false,
    fromMatch: (o) => o.node.flavour === "myoxus:surface",
    toBlockSnapshot: {},
    fromBlockSnapshot: {
      enter: (o, context) => {
        const { walkerContext, provider } = context;
        if (!provider) {
          context.walkerContext.skipAllChildren();
          return;
        }

        const elementModelMatchers = Array.from(
          provider.getAll(ElementToMarkdownAdapterMatcherIdentifier).values(),
        );
        const markdownElementModelAdapter = new MarkdownElementModelAdapter(
          elementModelMatchers,
        );
        if ("elements" in o.node.props) {
          const elements = o.node.props.elements as Record<
            string,
            Record<string, unknown>
          >;
          const managed = managedSurfaceSnapshotChildren(o);
          Object.entries(
            o.node.props.elements as Record<string, Record<string, unknown>>,
          ).forEach(([id, element]) => {
            if (managed.has(id)) return;
            const markdownAST = markdownElementModelAdapter.fromElementModel(
              element,
              { walkerContext, elements },
            );
            if (markdownAST) {
              walkerContext.openNode(markdownAST, "children").closeNode();
            }
          });
        }
      },
    },
  };

export const EdgelessSurfaceBlockMarkdownAdapterExtension =
  BlockMarkdownAdapterExtension(edgelessSurfaceBlockMarkdownAdapterMatcher);
