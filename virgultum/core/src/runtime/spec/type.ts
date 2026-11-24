import type { BlockModel } from "../../store/index";

export type BlockViewType = string | ((model: BlockModel) => string);
