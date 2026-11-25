import {
  EdgelessIcon,
  FrameIcon,
  GroupIcon,
  WorkflowIcon,
} from "@myoxus/icons/native";
import { isFrameBlock } from "../frame/index";
import { GroupElementModel, MermaidBlockModel } from "@virgultum/core/models";
import { type GfxModel } from "@virgultum/core/runtime/gfx";

export const TYPE_ICON_MAP: {
  [key: string]: {
    name: string;
    icon: string;
  };
} = {
  "myoxus:mermaid": { name: "Mermaid", icon: WorkflowIcon },
  "myoxus:frame": {
    name: "Frame",
    icon: FrameIcon,
  },
  group: {
    name: "Group",
    icon: GroupIcon,
  },
  edgeless: {
    name: "Edgeless content",
    icon: EdgelessIcon,
  },
};

export const getReferenceModelTitle = (model: GfxModel) => {
  if (model instanceof MermaidBlockModel) return model.props.title.toString();
  if (model instanceof GroupElementModel) {
    return model.title.toString();
  }
  if (isFrameBlock(model)) {
    return model.props.title.toString();
  }
  return null;
};
