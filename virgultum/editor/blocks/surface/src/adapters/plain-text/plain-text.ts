import { managedSurfaceSnapshotChildren } from "../managed-elements.js";
import {
  BlockPlainTextAdapterExtension,
  type BlockPlainTextAdapterMatcher,
} from "@virgultum/shared/adapters";

import { PlainTextElementModelAdapter } from "./element-adapter/index.js";
import { ElementToPlainTextAdapterMatcherIdentifier } from "./element-adapter/type.js";

export const surfaceBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher =
  {
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

export const SurfaceBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(surfaceBlockPlainTextAdapterMatcher);

export const edgelessSurfaceBlockPlainTextAdapterMatcher: BlockPlainTextAdapterMatcher =
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
          provider.getAll(ElementToPlainTextAdapterMatcherIdentifier).values(),
        );
        const plainTextElementModelAdapter = new PlainTextElementModelAdapter(
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
            const plainText = plainTextElementModelAdapter.fromElementModel(
              element,
              { walkerContext, elements },
            );
            if (plainText) {
              context.textBuffer.content += plainText + "\n";
            }
          });
        }
      },
    },
  };

export const EdgelessSurfaceBlockPlainTextAdapterExtension =
  BlockPlainTextAdapterExtension(edgelessSurfaceBlockPlainTextAdapterMatcher);
