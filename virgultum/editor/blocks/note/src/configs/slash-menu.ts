import {
  formatBlockCommand,
  type TextFormatConfig,
  textFormatConfigs,
} from "@virgultum/inline-preset";
import {
  type TextAlignConfig,
  textAlignConfigs,
  type TextConversionConfig,
  textConversionConfigs,
} from "@virgultum/rich-text";
import {
  getSelectedModelsCommand,
  getTextSelectionCommand,
} from "@virgultum/shared/commands";
import { isInsideBlockByFlavour } from "@virgultum/shared/utils";
import { BlockSelection } from "@virgultum/std";
import {
  type SlashMenuActionItem,
  type SlashMenuConfig,
  SlashMenuConfigExtension,
  type SlashMenuItem,
} from "@virgultum/widget-slash-menu";

import { updateBlockAlign, updateBlockType } from "../commands";
import {
  editorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import type { SlashMenuGroup } from "@virgultum/widget-slash-menu";

let basicIndex = 0;
const basicGroup = (itemOrder: number): SlashMenuGroup => ({
  id: "basic",
  label: editorMessage("com.myoxus.editor.group.basic", "Basic"),
  order: 0,
  itemOrder,
});
const listGroup = (itemOrder: number): SlashMenuGroup => ({
  id: "list",
  label: editorMessage("com.myoxus.editor.group.list", "List"),
  order: 1,
  itemOrder,
});
const alignGroup = (itemOrder: number): SlashMenuGroup => ({
  id: "align",
  label: editorMessage("com.myoxus.editor.group.align", "Align"),
  order: 2,
  itemOrder,
});
const styleGroup = (itemOrder: number): SlashMenuGroup => ({
  id: "style",
  label: editorMessage("com.myoxus.editor.group.style", "Style"),
  order: 2,
  itemOrder,
});

const conversionMessages: Record<
  string,
  {
    label: EditorI18nMessage;
    description: EditorI18nMessage;
    alias?: EditorI18nMessage;
  }
> = {
  Text: {
    label: editorMessage("Text", "Text"),
    description: editorMessage(
      "com.myoxus.editor.slash.text-description",
      "Start typing with plain text.",
    ),
  },
  "Heading 1": {
    label: editorMessage("Heading", "Heading {{number}}", { number: 1 }),
    description: editorMessage(
      "com.myoxus.editor.slash.heading-description",
      "Headings in the {{number}} font size.",
      { number: "largest" },
    ),
  },
  "Heading 2": {
    label: editorMessage("Heading", "Heading {{number}}", { number: 2 }),
    description: editorMessage(
      "com.myoxus.editor.slash.heading-description",
      "Headings in the {{number}} font size.",
      { number: "2nd" },
    ),
  },
  "Heading 3": {
    label: editorMessage("Heading", "Heading {{number}}", { number: 3 }),
    description: editorMessage(
      "com.myoxus.editor.slash.heading-description",
      "Headings in the {{number}} font size.",
      { number: "3rd" },
    ),
  },
  "Heading 4": {
    label: editorMessage("Heading", "Heading {{number}}", { number: 4 }),
    description: editorMessage(
      "com.myoxus.editor.slash.heading-description",
      "Headings in the {{number}} font size.",
      { number: "4th" },
    ),
  },
  "Heading 5": {
    label: editorMessage("Heading", "Heading {{number}}", { number: 5 }),
    description: editorMessage(
      "com.myoxus.editor.slash.heading-description",
      "Headings in the {{number}} font size.",
      { number: "5th" },
    ),
  },
  "Heading 6": {
    label: editorMessage("Heading", "Heading {{number}}", { number: 6 }),
    description: editorMessage(
      "com.myoxus.editor.slash.heading-description",
      "Headings in the {{number}} font size.",
      { number: "6th" },
    ),
  },
  "Bulleted List": {
    label: editorMessage(
      "com.myoxus.editor.slash.bulleted-list",
      "Bulleted List",
    ),
    description: editorMessage(
      "com.myoxus.editor.slash.bulleted-list-description",
      "Create a bulleted list.",
    ),
  },
  "Numbered List": {
    label: editorMessage(
      "com.myoxus.editor.slash.numbered-list",
      "Numbered List",
    ),
    description: editorMessage(
      "com.myoxus.editor.slash.numbered-list-description",
      "Create a numbered list.",
    ),
  },
  "To-do List": {
    label: editorMessage("com.myoxus.editor.slash.todo-list", "To-do List"),
    description: editorMessage(
      "com.myoxus.editor.slash.todo-list-description",
      "Add tasks to a to-do list.",
    ),
    alias: editorMessage("com.myoxus.editor.slash.todo-alias", "checkbox"),
  },
  "Code Block": {
    label: editorMessage("com.myoxus.editor.slash.code-block", "Code Block"),
    description: editorMessage(
      "com.myoxus.editor.slash.code-block-description",
      "Code snippet with formatting.",
    ),
  },
  Quote: {
    label: editorMessage("com.myoxus.editor.keyboard.quote", "Quote"),
    description: editorMessage(
      "com.myoxus.editor.slash.quote-description",
      "Add a blockquote for emphasis.",
    ),
  },
  Divider: {
    label: editorMessage("Divider", "Divider"),
    description: editorMessage(
      "com.myoxus.editor.slash.divider-description",
      "Visually separate content.",
    ),
  },
};

const alignMessages: Record<string, EditorI18nMessage> = {
  "Align left": editorMessage(
    "com.myoxus.keyboardShortcuts.alignLeft",
    "Align left",
  ),
  "Align center": editorMessage(
    "com.myoxus.keyboardShortcuts.alignCenter",
    "Align center",
  ),
  "Align right": editorMessage(
    "com.myoxus.keyboardShortcuts.alignRight",
    "Align right",
  ),
};

const formatMessages: Record<string, EditorI18nMessage> = {
  Bold: editorMessage("Bold", "Bold"),
  Italic: editorMessage("com.myoxus.editor.keyboard.italic", "Italic"),
  Underline: editorMessage("com.myoxus.editor.keyboard.underline", "Underline"),
  Strikethrough: editorMessage(
    "com.myoxus.keyboardShortcuts.strikethrough",
    "Strikethrough",
  ),
};

function createConversionItem(
  config: TextConversionConfig,
  group?: SlashMenuItem["group"],
): SlashMenuActionItem {
  const { name, iconName, flavour, type } = config;
  const messages = conversionMessages[name];
  if (!messages)
    throw new Error(`Missing i18n contract for note slash item: ${name}`);
  const id =
    flavour === "myoxus:divider"
      ? "block-divider-insert"
      : type
        ? `block-${flavour.split(":")[1]}-${type}`
        : "block-code-insert";
  return {
    id,
    label: messages.label,
    group,
    description: messages.description,
    icon: iconName,
    searchAlias: messages.alias ? [messages.alias] : undefined,
    tooltip: { caption: messages.label, shortcut: config.hotkey?.join(" / ") },
    when: ({ model }) => model.store.schema.flavourSchemaMap.has(flavour),
    action: ({ std }) => {
      std.command.exec(updateBlockType, {
        flavour,
        props: { type },
      });
    },
  };
}

function createAlignItem(
  config: TextAlignConfig,
  group?: SlashMenuItem["group"],
): SlashMenuActionItem {
  const { textAlign, name, iconName } = config;
  const label = alignMessages[name];
  if (!label)
    throw new Error(`Missing i18n contract for note align item: ${name}`);
  return {
    id: `block-align-${textAlign.toLowerCase()}`,
    label,
    group,
    icon: iconName,
    action: ({ std }) => {
      std.command
        .chain()
        .pipe(getTextSelectionCommand)
        .pipe(getSelectedModelsCommand, { types: ["text"] })
        .pipe(updateBlockAlign, { textAlign })
        .run();
    },
  };
}

function createTextFormatItem(
  config: TextFormatConfig,
  group?: SlashMenuItem["group"],
): SlashMenuActionItem {
  const { name, iconName, id, action } = config;
  const label = formatMessages[name];
  if (!label)
    throw new Error(`Missing i18n contract for note format item: ${name}`);
  return {
    id: `inline-format-${id}`,
    label,
    icon: iconName,
    group,
    tooltip: { caption: label, shortcut: config.hotkey },
    action: ({ std, model }) => {
      const { host } = std;

      if (model.text?.length !== 0) {
        std.command.exec(formatBlockCommand, {
          blockSelections: [
            std.selection.create(BlockSelection, {
              blockId: model.id,
            }),
          ],
          styles: { [id]: true },
        });
      } else {
        // like format bar when the line is empty
        action(host);
      }
    },
  };
}

const noteSlashMenuConfig: SlashMenuConfig = {
  items: [
    ...textConversionConfigs
      .filter((i) => i.type && ["h1", "h2", "h3", "text"].includes(i.type))
      .map((config) => createConversionItem(config, basicGroup(basicIndex++))),
    {
      id: "block-paragraph-other-headings",
      label: editorMessage(
        "com.myoxus.editor.slash.other-headings",
        "Other Headings",
      ),
      icon: "HeadingsIcon",
      group: basicGroup(basicIndex++),
      subMenu: textConversionConfigs
        .filter((i) => i.type && ["h4", "h5", "h6"].includes(i.type))
        .map((config) => createConversionItem(config)),
    },
    ...textConversionConfigs
      .filter((i) => i.flavour === "myoxus:code")
      .map((config) => createConversionItem(config, basicGroup(basicIndex++))),

    ...textConversionConfigs
      .filter((i) => i.type && ["divider", "quote"].includes(i.type))
      .map(
        (config) =>
          ({
            ...createConversionItem(config, basicGroup(basicIndex++)),
            when: ({ model }) =>
              model.store.schema.flavourSchemaMap.has(config.flavour) &&
              !isInsideBlockByFlavour(
                model.store,
                model,
                "myoxus:edgeless-text",
              ),
          }) satisfies SlashMenuActionItem,
      ),

    ...textConversionConfigs
      .filter((i) => i.flavour === "myoxus:list")
      .map((config, index) => createConversionItem(config, listGroup(index))),

    ...textAlignConfigs.map((config, index) =>
      createAlignItem(config, alignGroup(index)),
    ),

    ...textFormatConfigs
      .filter((i) => !["Code", "Link"].includes(i.name))
      .map((config, index) => createTextFormatItem(config, styleGroup(index))),
  ],
};

export const NoteSlashMenuConfigExtension = SlashMenuConfigExtension(
  "myoxus:note",
  noteSlashMenuConfig,
);
