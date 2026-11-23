import type { BlockModel } from "../../store/index";
import type { StaticValue } from "lit/static-html.js";

type BlockViewTag = StaticValue | string;
export type BlockViewType =
  BlockViewTag | ((model: BlockModel) => BlockViewTag);
export type WidgetViewType = StaticValue;
