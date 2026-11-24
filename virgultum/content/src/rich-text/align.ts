import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { TextAlign } from "@virgultum/core/models";

export interface TextAlignConfig {
  textAlign: TextAlign;
  name: string;
  hotkey: string[] | null;
  iconName: MyoxusIconExportName;
}

export const textAlignConfigs: TextAlignConfig[] = [
  {
    textAlign: TextAlign.Left,
    name: "Align left",
    hotkey: [`Mod-Shift-L`],
    iconName: "TextAlignLeftIcon",
  },
  {
    textAlign: TextAlign.Center,
    name: "Align center",
    hotkey: [`Mod-Shift-E`],
    iconName: "TextAlignCenterIcon",
  },
  {
    textAlign: TextAlign.Right,
    name: "Align right",
    hotkey: [`Mod-Shift-R`],
    iconName: "TextAlignRightIcon",
  },
];
