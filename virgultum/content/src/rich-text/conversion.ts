import type { MyoxusIconExportName } from "@myoxus/icons/names";

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
    iconName: "TextIcon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h1",
    name: "Heading 1",
    description: "Headings in the largest font.",
    hotkey: [`Mod-Alt-1`, `Mod-Shift-1`],
    iconName: "Heading1Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h2",
    name: "Heading 2",
    description: "Headings in the 2nd font size.",
    hotkey: [`Mod-Alt-2`, `Mod-Shift-2`],
    iconName: "Heading2Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h3",
    name: "Heading 3",
    description: "Headings in the 3rd font size.",
    hotkey: [`Mod-Alt-3`, `Mod-Shift-3`],
    iconName: "Heading3Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h4",
    name: "Heading 4",
    description: "Headings in the 4th font size.",
    hotkey: [`Mod-Alt-4`, `Mod-Shift-4`],
    iconName: "Heading4Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h5",
    name: "Heading 5",
    description: "Headings in the 5th font size.",
    hotkey: [`Mod-Alt-5`, `Mod-Shift-5`],
    iconName: "Heading5Icon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "h6",
    name: "Heading 6",
    description: "Headings in the 6th font size.",
    hotkey: [`Mod-Alt-6`, `Mod-Shift-6`],
    iconName: "Heading6Icon",
  },
  {
    flavour: "myoxus:list",
    type: "bulleted",
    name: "Bulleted List",
    description: "Create a bulleted list.",
    hotkey: [`Mod-Alt-8`, `Mod-Shift-8`],
    iconName: "BulletedListIcon",
  },
  {
    flavour: "myoxus:list",
    type: "numbered",
    name: "Numbered List",
    description: "Create a numbered list.",
    hotkey: [`Mod-Alt-9`, `Mod-Shift-9`],
    iconName: "NumberedListIcon",
  },
  {
    flavour: "myoxus:list",
    type: "todo",
    name: "To-do List",
    description: "Add tasks to a to-do list.",
    searchAlias: ["checkbox"],
    hotkey: null,
    iconName: "CheckBoxCheckLinearIcon",
  },
  {
    flavour: "myoxus:code",
    type: undefined,
    name: "Code Block",
    description: "Code snippet with formatting.",
    hotkey: [`Mod-Alt-c`],
    iconName: "CodeBlockIcon",
  },
  {
    flavour: "myoxus:paragraph",
    type: "quote",
    name: "Quote",
    description: "Add a blockquote for emphasis.",
    hotkey: null,
    iconName: "QuoteIcon",
  },
  {
    flavour: "myoxus:divider",
    type: "divider",
    name: "Divider",
    description: "Visually separate content.",
    hotkey: [`Mod-Alt-d`, `Mod-Shift-d`],
    iconName: "DividerIcon",
  },
];
