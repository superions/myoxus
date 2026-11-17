import type { ListBlockModel } from "@virgultum/core/models";
import { render } from "lit";
import { expect, test } from "vitest";

import { getListPrefix } from "../../../../content/src/blocks/list/utils/get-list-prefix";

test("bulleted lists use a native CSS marker instead of an icon", async () => {
  const model = {
    flavour: "myoxus:list",
    props: { type: "bulleted" },
    store: {
      getParent: () => null,
    },
  } as unknown as ListBlockModel;
  const container = document.createElement("div");

  render(
    getListPrefix(model, true, () => undefined),
    container,
  );
  await Promise.resolve();

  const prefix = container.querySelector(".myoxus-list-block__bulleted");
  expect(prefix).not.toBeNull();
  expect(prefix?.getAttribute("data-list-depth")).toBe("0");
  expect(prefix?.querySelector("svg")).toBeNull();
});
