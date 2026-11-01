import {
  PenIcon,
  PresentationIcon,
  MindmapIcon,
  ImageIcon,
  CodeIcon,
} from "@myoxus/icons/lit";

export { AIStarIconWithAnimation } from "@virgultum/editor/components/icons";

const AI_ACTION_ICON_SIZE =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";
export const AIPenIconWithAnimation = PenIcon({
  width: AI_ACTION_ICON_SIZE,
  height: AI_ACTION_ICON_SIZE,
});
export const AIPresentationIconWithAnimation = PresentationIcon({
  width: AI_ACTION_ICON_SIZE,
  height: AI_ACTION_ICON_SIZE,
});
export const AIMindMapIconWithAnimation = MindmapIcon({
  width: AI_ACTION_ICON_SIZE,
  height: AI_ACTION_ICON_SIZE,
});
export const AIImageIconWithAnimation = ImageIcon({
  width: AI_ACTION_ICON_SIZE,
  height: AI_ACTION_ICON_SIZE,
});
export const MakeItRealIconWithAnimation = CodeIcon({
  width: AI_ACTION_ICON_SIZE,
  height: AI_ACTION_ICON_SIZE,
});
