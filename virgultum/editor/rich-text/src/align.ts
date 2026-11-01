import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
} from "@myoxus/icons/lit";
import { TextAlign } from "@virgultum/model";
import type { TemplateResult } from "lit";

export interface TextAlignConfig {
  textAlign: TextAlign;
  name: string;
  hotkey: string[] | null;
  icon: TemplateResult<1>;
  /** UI-neutral glyph for consumers outside Lit. */
  iconName: MyoxusIconExportName;
}

export const textAlignConfigs: TextAlignConfig[] = [
  {
    textAlign: TextAlign.Left,
    name: "Align left",
    hotkey: [`Mod-Shift-L`],
    icon: TextAlignLeftIcon(),
    iconName: "TextAlignLeftIcon",
  },
  {
    textAlign: TextAlign.Center,
    name: "Align center",
    hotkey: [`Mod-Shift-E`],
    icon: TextAlignCenterIcon(),
    iconName: "TextAlignCenterIcon",
  },
  {
    textAlign: TextAlign.Right,
    name: "Align right",
    hotkey: [`Mod-Shift-R`],
    icon: TextAlignRightIcon(),
    iconName: "TextAlignRightIcon",
  },
];
