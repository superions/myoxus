import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "@virgultum/components/icons";
import { toggleLink } from "@virgultum/inline-link";
import { type EditorHost, TextSelection } from "@virgultum/std";
import type { TemplateResult } from "lit";

import {
  isTextAttributeActive,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrike,
  toggleUnderline,
} from "./text-style.js";

export interface TextFormatConfig {
  id: string;
  name: string;
  icon: TemplateResult<1>;
  /** UI-neutral glyph for consumers outside Lit. */
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
    icon: BoldIcon,
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
    icon: ItalicIcon,
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
    icon: UnderlineIcon,
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
    icon: StrikethroughIcon,
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
    icon: CodeIcon,
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
    icon: LinkIcon,
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
