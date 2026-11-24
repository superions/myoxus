import "./test-block.js";

import type { ExtensionType } from "../../store/index";

import { BlockViewExtension } from "../extension/index.js";
import type { HeadingBlockModel } from "./test-schema.js";

export const testSpecs: ExtensionType[] = [
  BlockViewExtension("test:page", "test-root-block"),

  BlockViewExtension("test:note", "test-note-block"),

  BlockViewExtension("test:heading", (model) => {
    const h = (model as HeadingBlockModel).props.type$.value;

    if (h === "h1") {
      return "test-h1-block";
    }

    return "test-h2-block";
  }),

  BlockViewExtension("test:surface", "test-surface-block"),

  BlockViewExtension("test:gfx-block", "test-gfx-block"),
];
