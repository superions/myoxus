import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  BulletedListIcon,
  CheckBoxIcon,
  CodeBlockIcon,
  DividerIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
  NumberedListIcon,
  QuoteIcon,
  TextIcon,
} from "@virgultum/components/icons";
import type { TemplateResult } from "lit";

/**
 * Text primitive entries used in slash menu and format bar,
 * which are also used for registering hotkeys for converting block flavours.
 */
export interface TextConversionConfig {
  flavour: string;
  type?: string;
  name: string;
  description?: string;
  hotkey: string[] | null;
  icon: TemplateResult<1>;
  /** UI-neutral glyph for consumers outside Lit. */
  iconName: MyoxusIconExportName;
  searchAlias?: string[];
}

export const textConversionConfigs: TextConversionConfig[] = [
  {
    flavour: "myoxus:paragraph",
    type: "text",
    name: "Text",
    description: "Start typing with plain text.",
    hotkey: [`Mod-Alt-0`, `Mod-Shift-0`],
    icon: TextIcon,
    iconName: "TextIcon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h1",
    name: "Heading 1",
    description: "Headings in the largest font.",
    hotkey: [`Mod-Alt-1`, `Mod-Shift-1`],
    icon: Heading1Icon,
    iconName: "Heading1Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h2",
    name: "Heading 2",
    description: "Headings in the 2nd font size.",
    hotkey: [`Mod-Alt-2`, `Mod-Shift-2`],
    icon: Heading2Icon,
    iconName: "Heading2Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h3",
    name: "Heading 3",
    description: "Headings in the 3rd font size.",
    hotkey: [`Mod-Alt-3`, `Mod-Shift-3`],
    icon: Heading3Icon,
    iconName: "Heading3Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h4",
    name: "Heading 4",
    description: "Headings in the 4th font size.",
    hotkey: [`Mod-Alt-4`, `Mod-Shift-4`],
    icon: Heading4Icon,
    iconName: "Heading4Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h5",
    name: "Heading 5",
    description: "Headings in the 5th font size.",
    hotkey: [`Mod-Alt-5`, `Mod-Shift-5`],
    icon: Heading5Icon,
    iconName: "Heading5Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h6",
    name: "Heading 6",
    description: "Headings in the 6th font size.",
    hotkey: [`Mod-Alt-6`, `Mod-Shift-6`],
    icon: Heading6Icon,
    iconName: "Heading6Icon",
  },
  {
    flavour: "myoxus:list",
    type: "bulleted",
    name: "Bulleted List",
    description: "Create a bulleted list.",
    hotkey: [`Mod-Alt-8`, `Mod-Shift-8`],
    icon: BulletedListIcon,
    iconName: "BulletedListIcon",
  },
  {
    flavour: "myoxus:list",
    type: "numbered",
    name: "Numbered List",
    description: "Create a numbered list.",
    hotkey: [`Mod-Alt-9`, `Mod-Shift-9`],
    icon: NumberedListIcon,
    iconName: "NumberedListIcon",
  },
  {
    flavour: "myoxus:list",
    type: "todo",
    name: "To-do List",
    description: "Add tasks to a to-do list.",
    searchAlias: ["checkbox"],
    hotkey: null,
    icon: CheckBoxIcon,
    iconName: "CheckBoxCheckLinearIcon",
  },
  {
    flavour: "myoxus:code",
    type: undefined,
    name: "Code Block",
    description: "Code snippet with formatting.",
    hotkey: [`Mod-Alt-c`],
    icon: CodeBlockIcon,
    iconName: "CodeBlockIcon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "quote",
    name: "Quote",
    description: "Add a blockquote for emphasis.",
    hotkey: null,
    icon: QuoteIcon,
    iconName: "QuoteIcon",
  },
  {
    flavour: "myoxus:divider",
    type: "divider",
    name: "Divider",
    description: "Visually separate content.",
    hotkey: [`Mod-Alt-d`, `Mod-Shift-d`],
    icon: DividerIcon,
    iconName: "DividerIcon",
  },
];
