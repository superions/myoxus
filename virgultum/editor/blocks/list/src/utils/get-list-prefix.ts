import {
  CheckBoxCheckSolidIcon,
  CheckBoxUnIcon,
  ToggleDownIcon,
  ToggleRightIcon,
} from "@myoxus/icons/lit";
import type { ListBlockModel } from "@virgultum/model";
import { getNumberPrefix } from "@virgultum/shared/utils";
import { html } from "lit";

const getListDepth = (model: ListBlockModel): number => {
  let depth = 0;
  let parent = model.store.getParent(model);
  while (parent?.flavour === model.flavour) {
    depth++;
    parent = model.store.getParent(parent);
  }
  return depth;
};

export function getListPrefix(
  model: ListBlockModel,
  showChildren: boolean,
  onClick: (event: MouseEvent) => void,
) {
  const depth = getListDepth(model);
  switch (model.props.type) {
    case "bulleted":
      return html`<div
        contenteditable="false"
        class="myoxus-list-block__prefix myoxus-list-block__bulleted"
        data-list-depth=${depth % 3}
        @click=${onClick}
      ></div>`;
    case "numbered":
      return html`<div
        contenteditable="false"
        class="myoxus-list-block__prefix myoxus-list-block__numbered"
        @click=${onClick}
      >
        ${model.props.order ? getNumberPrefix(model.props.order, depth) : "1."}
      </div>`;
    case "todo":
      return html`<div
        contenteditable="false"
        class=${`myoxus-list-block__prefix myoxus-list-block__todo-prefix ${model.store.readonly ? "readonly" : ""}`}
        @click=${onClick}
      >
        ${model.props.checked ? CheckBoxCheckSolidIcon() : CheckBoxUnIcon()}
      </div>`;
    case "toggle":
      return html`<div
        contenteditable="false"
        class="myoxus-list-block__prefix"
        @click=${onClick}
      >
        ${showChildren ? ToggleDownIcon() : ToggleRightIcon()}
      </div>`;
    default:
      console.error("Unknown list type", model.props.type, model);
      return null;
  }
}
