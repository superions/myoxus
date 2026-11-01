// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { resolveEditorText, EditorI18nProvider } from "../i18n-service";
import type { ToolbarAction, ToolbarActions, ToolbarControl } from "./action";
import type { ToolbarContext } from "./context";
import { combine, defaultToolbarScore } from "./resolve-actions";

export type SelectionControl =
  | Exclude<ToolbarControl, { type: "menu" | "choice" | "text" }>
  | {
      type: "menu";
      items: SelectionAction[];
      onOpen?: () => void;
      onClose?: () => void;
    }
  | {
      type: "choice";
      presentation?: "icons";
      value: string | null;
      options: readonly {
        value: string;
        label: string;
        icon?: MyoxusIconExportName;
        disabled?: boolean;
      }[];
      change: (value: string) => void;
      onOpen?: () => void;
    }
  | {
      type: "text";
      value: string;
      placeholder?: string;
      change: (value: string) => void;
      submit?: () => string | null | void;
    };
export type SelectionAction = {
  id: string;
  label: string;
  icon?: MyoxusIconExportName;
  swatch?: string;
  showLabel?: boolean;
  shortcut?: string;
  disabled: boolean;
  active?: boolean;
  variant?: "destructive";
  control?: SelectionControl;
  actions?: SelectionAction[];
  run?: (anchor: HTMLElement, event: MouseEvent) => void;
};

/** Bind this editor's commands once; the React view consumes presentation values only. */
export function presentToolbarActions(
  actions: ToolbarActions,
  context: ToolbarContext,
): SelectionAction[] {
  const i18n = context.std.getOptional(EditorI18nProvider) ?? undefined;
  const text = (value: ToolbarAction["label"]) =>
    resolveEditorText(value, i18n);
  const state = (value: ToolbarAction["active"]) =>
    typeof value === "function" ? value(context) : Boolean(value);
  const nested = (items: ToolbarActions, ordered = false) =>
    presentToolbarActions(
      ordered
        ? combine(items, context).sort(
            (a, b) =>
              (a.score ?? defaultToolbarScore) -
                (b.score ?? defaultToolbarScore) || a.id.localeCompare(b.id),
          )
        : combine(items, context),
      context,
    );
  const control = (value: ToolbarControl): SelectionControl => {
    switch (value.type) {
      case "menu":
        return { ...value, items: nested(value.items) };
      case "choice":
        return {
          ...value,
          options: value.options.map((option) => ({
            ...option,
            label: text(option.label) ?? option.value,
          })),
        };
      case "text":
        return {
          ...value,
          placeholder: text(value.placeholder),
          submit: value.submit
            ? () => {
                const error = value.submit!();
                return error ? text(error) : null;
              }
            : undefined,
        };
      case "notice":
        return {
          ...value,
          title: text(value.title) ?? "",
          message: text(value.message) ?? "",
        };
      default:
        return value;
    }
  };
  return actions.flatMap((action) => {
    const leaf = action as ToolbarAction;
    const children =
      "actions" in action ? nested(action.actions, true) : undefined;
    const value =
      typeof leaf.control === "function" ? leaf.control(context) : leaf.control;
    if (!value && !children?.length && !leaf.run && !leaf.disabled) return [];
    return [
      {
        id: action.id,
        label: text(leaf.label ?? leaf.tooltip) ?? action.id,
        icon: leaf.icon,
        swatch: leaf.swatch,
        showLabel: leaf.showLabel,
        shortcut: leaf.shortcut,
        active: action.active === undefined ? undefined : state(action.active),
        disabled: state(leaf.disabled),
        variant: leaf.variant,
        actions: children,
        control: value ? control(value) : undefined,
        run: leaf.run
          ? (anchor, event) => leaf.run!(context, anchor, event)
          : undefined,
      },
    ];
  });
}
