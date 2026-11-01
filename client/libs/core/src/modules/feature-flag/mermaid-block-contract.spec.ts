import { describe, expect, test } from "vitest";

import { MYOXUS_FLAGS } from "./constant";

describe("Mermaid feature flag contract", () => {
  test("exposes enable_mermaid_block to Core and Virgultum", () => {
    const flag = MYOXUS_FLAGS.enable_mermaid_block;

    expect(flag).toMatchObject({
      category: "virgultum",
      bsFlag: "enable_mermaid_block",
      configurable: false,
      defaultState: true,
      displayName:
        "com.myoxus.settings.workspace.experimental-features.enable-mermaid-block.name",
      description:
        "com.myoxus.settings.workspace.experimental-features.enable-mermaid-block.description",
      hide: true,
    });
  });
});
