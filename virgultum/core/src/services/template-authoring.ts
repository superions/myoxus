// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { TemplateRepeatBinding } from "../models/index";
import type { SelectionAction } from "./toolbar-service/presentation";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nMessage,
  type EditorI18nService,
} from "./i18n-service";
import type { MyoxusTemplateVariableGroup } from "./host/types";

export const templateRepeatLabel = editorMessage(
  "com.myoxus.editor.repeat.label",
  "Repeat for",
);
export const templateVariableLabel = editorMessage(
  "com.myoxus.editor.template-variable.insert",
  "Insert variable",
);

export const templateVariableGroupOrder: readonly MyoxusTemplateVariableGroup[] =
  ["document", "workspace", "date", "context", "actor"];

export const templateVariableGroupMessages = {
  document: editorMessage(
    "com.myoxus.editor.template-variable.group.document",
    "Document",
  ),
  workspace: editorMessage(
    "com.myoxus.editor.template-variable.group.workspace",
    "Workspace",
  ),
  date: editorMessage("Date", "Date"),
  context: editorMessage(
    "com.myoxus.editor.template-variable.group.context",
    "Context",
  ),
  actor: editorMessage(
    "com.myoxus.editor.template-variable.group.actor",
    "Actor",
  ),
} satisfies Record<MyoxusTemplateVariableGroup, EditorI18nMessage>;

/** Both native menu producers retain live identity, authorization and metadata writes. */
export type EditorTemplateRepeatPickerControls = {
  i18n?: EditorI18nService;
  unit: () => { binding: unknown; texts: readonly string[]; leaf: boolean };
  canWrite: () => boolean;
  change: (binding: TemplateRepeatBinding | undefined) => void;
};

/** Shared semantic entries; the existing native toolbar/table menu owns the session. */
export function templateRepeatActions(
  options: EditorTemplateRepeatPickerControls,
) {
  const text = (message: Parameters<typeof resolveEditorMessage>[0]) =>
    resolveEditorMessage(message, options.i18n);
  const unit = options.unit();
  const hasFields = (texts: readonly string[]) =>
    texts.some((text) => /{{\s*member\.(?:name|email)\s*}}/.test(text));
  const supported =
    unit.binding &&
    typeof unit.binding === "object" &&
    "source" in unit.binding &&
    unit.binding.source === "workspace.members" &&
    "alias" in unit.binding &&
    unit.binding.alias === "member";
  const change = (binding: TemplateRepeatBinding | undefined) => {
    if (!options.canWrite()) return;
    // An open menu is not a model snapshot. Revalidate the caller's live unit
    // after collaborative text or hierarchy changes; the native menu owns closure.
    const current = options.unit();
    if (binding && (!current.leaf || !hasFields(current.texts))) return;
    options.change(binding);
  };
  const label = text(templateRepeatLabel);
  return [
    {
      id: "template-repeat-hint",
      label,
      disabled: false,
      control: {
        type: "notice",
        tone: "warning",
        title: "",
        message: [
          text(
            !unit.leaf
              ? editorMessage(
                  "com.myoxus.editor.repeat.leaf-required",
                  "Only a unit without nested content can repeat.",
                )
              : editorMessage(
                  "com.myoxus.editor.repeat.hint",
                  "Use {{nameToken}} or {{emailToken}} in this unit.",
                  {
                    nameToken: "{{member.name}}",
                    emailToken: "{{member.email}}",
                  },
                ),
          ),
          unit.binding !== undefined && !supported
            ? text(
                editorMessage(
                  "com.myoxus.editor.repeat.invalid",
                  "This repeat binding is invalid.",
                ),
              )
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      },
    },
    {
      id: "template-repeat-members",
      label: text(
        editorMessage("com.myoxus.editor.repeat.members", "Workspace members"),
      ),
      active: Boolean(supported),
      disabled: !unit.leaf || !hasFields(unit.texts),
      run: () => change({ source: "workspace.members", alias: "member" }),
    },
    ...(unit.binding !== undefined
      ? [
          {
            id: "template-repeat-remove",
            label: text(
              editorMessage("com.myoxus.editor.repeat.remove", "Remove repeat"),
            ),
            disabled: false,
            run: () => change(undefined),
          },
        ]
      : []),
  ] satisfies SelectionAction[];
}
