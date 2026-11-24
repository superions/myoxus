import {
  CheckBoxCheckSolidIcon,
  CheckBoxUnIcon,
  ToggleDownIcon,
  ToggleRightIcon,
} from "@myoxus/icons/native";
import type { ListBlockModel } from "@virgultum/core/models";
import { getNumberPrefix } from "@virgultum/core/utils";

const getListDepth = (model: ListBlockModel): number => {
  let depth = 0;
  let parent = model.store.getParent(model);
  while (parent?.flavour === model.flavour) {
    depth++;
    parent = model.store.getParent(parent);
  }
  return depth;
};

export function updateListPrefix(
  prefix: HTMLElement,
  model: ListBlockModel,
  expanded: boolean,
) {
  const type = model.props.type$.value;
  prefix.className = "myoxus-list-block__prefix";
  prefix.contentEditable = "false";
  delete prefix.dataset.listDepth;
  if (type === "bulleted") {
    prefix.classList.add("myoxus-list-block__bulleted");
    prefix.dataset.listDepth = String(getListDepth(model) % 3);
    prefix.replaceChildren();
  } else if (type === "numbered") {
    prefix.classList.add("myoxus-list-block__numbered");
    prefix.textContent = model.props.order$.value
      ? getNumberPrefix(model.props.order$.value, getListDepth(model))
      : "1.";
  } else if (type === "todo" || type === "toggle") {
    const svg =
      type === "todo"
        ? model.props.checked$.value
          ? CheckBoxCheckSolidIcon
          : CheckBoxUnIcon
        : expanded
          ? ToggleDownIcon
          : ToggleRightIcon;
    if (type === "todo") {
      prefix.classList.add("myoxus-list-block__todo-prefix");
      prefix.classList.toggle("readonly", model.store.readonly);
    }
    // Only generated, package-owned SVG literals enter this node.
    prefix.innerHTML = svg;
  } else {
    prefix.replaceChildren();
    prefix.className = "";
  }
}
