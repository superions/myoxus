import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { toggleLink } from "../../link/index";
import { type EditorHost, TextSelection } from "@virgultum/core/runtime";

import {
  isTextAttributeActive,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
} from "./text-style";

export interface TextFormatConfig {
  id: string;
  name: string;
  iconName: MyoxusIconExportName;
  hotkey?: string;
  activeWhen: (host: EditorHost) => boolean;
  action: (host: EditorHost) => void;
  textChecker?: (host: EditorHost) => boolean;
}

export const textFormatConfigs: TextFormatConfig[] = [
  {
    id: "bold",
    name: "Bold",
    iconName: "BoldIcon",
    hotkey: "Mod-b",
    activeWhen: (host) => {
      const [result] = host.std.command
        .chain()
        .pipe(isTextAttributeActive, { key: "bold" })
        .run();
      return result;
    },
    action: (host) => {
      host.std.command.chain().pipe(toggleBold).run();
    },
  },
  {
    id: "italic",
    name: "Italic",
    iconName: "ItalicIcon",
    hotkey: "Mod-i",
    activeWhen: (host) => {
      const [result] = host.std.command
        .chain()
        .pipe(isTextAttributeActive, { key: "italic" })
        .run();
      return result;
    },
    action: (host) => {
      host.std.command.chain().pipe(toggleItalic).run();
    },
  },
  {
    id: "underline",
    name: "Underline",
    iconName: "UnderLineIcon",
    hotkey: "Mod-u",
    activeWhen: (host) => {
      const [result] = host.std.command
        .chain()
        .pipe(isTextAttributeActive, { key: "underline" })
        .run();
      return result;
    },
    action: (host) => {
      host.std.command.chain().pipe(toggleUnderline).run();
    },
  },
  {
    id: "strike",
    name: "Strikethrough",
    iconName: "StrikeThroughIcon",
    hotkey: "Mod-shift-s",
    activeWhen: (host) => {
      const [result] = host.std.command
        .chain()
        .pipe(isTextAttributeActive, { key: "strike" })
        .run();
      return result;
    },
    action: (host) => {
      host.std.command.chain().pipe(toggleStrike).run();
    },
  },
  {
    id: "code",
    name: "Code",
    iconName: "CodeIcon",
    hotkey: "Mod-e",
    activeWhen: (host) => {
      const [result] = host.std.command
        .chain()
        .pipe(isTextAttributeActive, { key: "code" })
        .run();
      return result;
    },
    action: (host) => {
      host.std.command.chain().pipe(toggleCode).run();
    },
  },
  {
    id: "link",
    name: "Link",
    iconName: "LinkIcon",
    hotkey: "Mod-k",
    activeWhen: (host) => {
      const [result] = host.std.command
        .chain()
        .pipe(isTextAttributeActive, { key: "link" })
        .run();
      return result;
    },
    action: (host) => {
      host.std.command.chain().pipe(toggleLink).run();
    },
    // should check text length
    textChecker: (host) => {
      const textSelection = host.std.selection.find(TextSelection);
      if (!textSelection || textSelection.isCollapsed()) return false;

      return Boolean(
        textSelection.from.length + (textSelection.to?.length ?? 0),
      );
    },
  },
];
