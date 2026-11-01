// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  editorMessage,
  type EditorI18nMessage,
  type MyoxusTemplateVariableGroup,
} from "@virgultum/shared/services";

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
