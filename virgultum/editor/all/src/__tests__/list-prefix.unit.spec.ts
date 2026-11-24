import type { ListBlockModel } from "@virgultum/core/models";
import { expect, test } from "vitest";

import { updateListPrefix } from "../../../../content/src/blocks/list/utils/get-list-prefix";

test("bulleted lists use a native CSS marker instead of an icon", () => {
  const model = {
    flavour: "myoxus:list",
    props: { type$: { value: "bulleted" } },
    store: {
      getParent: () => null,
    },
  } as unknown as ListBlockModel;
  const prefix = document.createElement("div");
  updateListPrefix(prefix, model, true);
  expect(prefix.classList.contains("myoxus-list-block__bulleted")).toBe(true);
  expect(prefix?.getAttribute("data-list-depth")).toBe("0");
  expect(prefix?.querySelector("svg")).toBeNull();
});
