// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TemplateRepeatBinding } from "@virgultum/model";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import { html } from "lit";

import { menu } from "./menu-all";
import type { MenuOptions } from "./menu";

export const templateRepeatLabel = editorMessage(
  "com.myoxus.editor.repeat.label",
  "Repeat for",
);

/** One selection-owned menu used by text prototypes and native table rows.
 * This edits only binding metadata; collections are resolved by instantiation.
 */
export function templateRepeatMenuOptions(options: {
  i18n?: EditorI18nService;
  unit: () => { binding: unknown; texts: readonly string[]; leaf: boolean };
  canWrite: () => boolean;
  change: (binding: TemplateRepeatBinding | undefined) => void;
  onClose: () => void;
}): MenuOptions {
  const text = (message: EditorI18nMessage) =>
    resolveEditorMessage(message, options.i18n);
  const unit = options.unit();
  const hasFields = (texts: readonly string[]) =>
    texts.some((text) => /{{\s*member\.(?:name|email)\s*}}/.test(text));
  const hasField = hasFields(unit.texts);
  const supported =
    unit.binding &&
    typeof unit.binding === "object" &&
    "source" in unit.binding &&
    unit.binding.source === "workspace.members" &&
    "alias" in unit.binding &&
    unit.binding.alias === "member";
  const change = (binding: TemplateRepeatBinding | undefined) => {
    if (!options.canWrite()) return false;
    // An open menu is not a model snapshot. Revalidate the live unit before
    // attaching metadata after a collaborative text or hierarchy change.
    const current = options.unit();
    if (binding && (!current.leaf || !hasFields(current.texts))) return false;
    return options.change(binding);
  };
  return {
    i18n: options.i18n,
    title: { text: text(templateRepeatLabel) },
    testId: "template-repeat-menu",
    onClose: options.onClose,
    items: [
      menu.action({
        name: text(
          editorMessage(
            "com.myoxus.editor.repeat.members",
            "Workspace members",
          ),
        ),
        isSelected: Boolean(supported),
        disabled: !unit.leaf || !hasField,
        info: html`<div>
          ${
            !unit.leaf
              ? text(
                  editorMessage(
                    "com.myoxus.editor.repeat.leaf-required",
                    "Only a unit without nested content can repeat.",
                  ),
                )
              : text(
                  editorMessage(
                    "com.myoxus.editor.repeat.hint",
                    "Use {{nameToken}} or {{emailToken}} in this unit.",
                    {
                      nameToken: "{{member.name}}",
                      emailToken: "{{member.email}}",
                    },
                  ),
                )
          }
        </div>`,
        select: () => change({ source: "workspace.members", alias: "member" }),
      }),
      ...(unit.binding !== undefined
        ? [
            menu.action({
              name: text(
                editorMessage(
                  "com.myoxus.editor.repeat.remove",
                  "Remove repeat",
                ),
              ),
              info: supported
                ? undefined
                : html`<div>
                    ${text(editorMessage("com.myoxus.editor.repeat.invalid", "This repeat binding is invalid."))}
                  </div>`,
              select: () => change(undefined),
            }),
          ]
        : []),
    ],
  };
}
