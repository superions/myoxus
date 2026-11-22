// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import type {
  EditorSelectionControls,
  SelectionAction,
} from "@virgultum/core/services";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import type { PageInteraction } from "./page-interaction";
import { isMyoxusLabelTone } from "@virgultum/core/styles/text";

export function PageFormatting({
  controller,
  rect,
  dismiss,
  changed,
}: {
  controller: PageInteraction;
  rect: DOMRect;
  dismiss: () => void;
  changed: () => void;
}) {
  const t = useI18n();
  const tone = controller.labelTone();
  const alignment = controller.alignment();
  const eyebrow = controller.eyebrowState();
  const run = (key: string, value?: string | null) => () => {
    controller.format(key, value);
    changed();
  };
  const primary: SelectionAction[] = (
    [
      ["bold", "BoldIcon", t["Bold"]()],
      ["italic", "ItalicIcon", t["com.myoxus.keyboardShortcuts.italic"]()],
      [
        "underline",
        "UnderLineIcon",
        t["com.myoxus.keyboardShortcuts.underline"](),
      ],
      [
        "strike",
        "StrikeThroughIcon",
        t["com.myoxus.keyboardShortcuts.strikethrough"](),
      ],
      ["code", "CodeIcon", t["com.myoxus.editor.keyboard.code"]()],
    ] as const
  ).map(([id, icon, label]) => ({
    id,
    icon,
    label,
    disabled: false,
    active: controller.markActive(id),
    run: run(id),
  }));
  primary.push(
    {
      id: "color",
      icon: "TextColorIcon",
      label: t["com.myoxus.editor.toolbar.text-color"](),
      disabled: false,
      control: {
        type: "menu",
        items: [
          {
            id: "default",
            label: t["com.myoxus.editor.keyboard.default-color"](),
            disabled: false,
            run: run("color", null),
          },
          ...(
            [
              "red",
              "orange",
              "yellow",
              "green",
              "teal",
              "blue",
              "purple",
              "grey",
            ] as const
          ).map((name) => ({
            id: name,
            swatch: `var(--myoxus-text-highlight-foreground-${name})`,
            label: t[`com.myoxus.editor.table.color.${name}`](),
            disabled: false,
            run: run(
              "color",
              `var(--myoxus-text-highlight-foreground-${name})`,
            ),
          })),
        ],
      },
    },
    {
      id: "background",
      icon: "HighLightLinearIcon",
      label: t["com.myoxus.editor.toolbar.text-marker"](),
      disabled: false,
      control: {
        type: "menu",
        items: [
          {
            id: "default",
            disabled: false,
            label: t["com.myoxus.editor.toolbar.remove-text-marker"](),
            run: run("background", null),
          },
          ...(["yellow", "green", "pink", "orange", "blue"] as const).map(
            (name) => ({
              id: name,
              disabled: false,
              label: t[`com.myoxus.editor.text-marker.${name}`](),
              swatch: `var(--myoxus-sem-text-marker-${name})`,
              run: run("background", `var(--myoxus-sem-text-marker-${name})`),
            }),
          ),
        ],
      },
    },
  );
  const advanced = (
    id: string,
    label: string,
    icon: SelectionAction["icon"],
  ): SelectionAction => ({
    id,
    label,
    icon,
    disabled: false,
    run: () => controller.relinquish({ kind: "selection", control: id }),
  });
  const formats = primary.splice(0, 5);
  formats.push(
    advanced("link", t["com.myoxus.editor.keyboard.link"](), "LinkIcon"),
  );
  primary.unshift(
    advanced(
      "a.conversions",
      t["com.myoxus.editor.toolbar.conversions"](),
      "TextIcon",
    ),
    {
      id: "b.align",
      label: t["com.myoxus.editor.toolbar.alignment"](),
      disabled: !alignment,
      control: {
        type: "choice",
        presentation: "icons",
        value: alignment ?? null,
        options: [
          {
            value: "left",
            icon: "TextAlignLeftIcon",
            label: t["com.myoxus.editor.toolbar.align-left"](),
          },
          {
            value: "center",
            icon: "TextAlignCenterIcon",
            label: t["com.myoxus.editor.toolbar.align-center"](),
          },
          {
            value: "right",
            icon: "TextAlignRightIcon",
            label: t["com.myoxus.editor.toolbar.align-right"](),
          },
        ],
        change: (value) => {
          controller.align(value);
          changed();
        },
      },
    },
    { id: "b.inline-text", label: "", disabled: false, actions: formats },
  );
  if (eyebrow !== undefined)
    primary.push({
      id: "b.eyebrow",
      icon: "TextTypeIcon",
      label: t["com.myoxus.editor.paragraph.eyebrow"](),
      disabled: false,
      active: eyebrow,
      run: () => {
        controller.toggleEyebrow();
        changed();
      },
    });
  primary.push(
    {
      id: "c.label-tone",
      label: `${t["com.myoxus.editor.label-tone.label"]()}: ${t[`com.myoxus.editor.label-tone.${isMyoxusLabelTone(tone) || tone === "mixed" ? tone : "clear"}`]()}`,
      icon: "TagsIcon",
      active: isMyoxusLabelTone(tone),
      disabled: false,
      control: {
        type: "menu",
        onClose: () => controller.restore(),
        items: (
          [
            "neutral",
            "info",
            "positive",
            "warning",
            "danger",
            "accent",
            "clear",
          ] as const
        ).map((value) => ({
          id: value,
          label: t[`com.myoxus.editor.label-tone.${value}`](),
          disabled: false,
          active: (tone ?? "clear") === value,
          run: run("labelTone", value === "clear" ? null : value),
        })),
      },
    },
    advanced(
      "d.template-variable",
      t["com.myoxus.editor.field.document-fields"](),
      "TextTypeIcon",
    ),
    advanced(
      "f.convert-to-linked-doc",
      t["com.myoxus.editor.toolbar.create-linked-doc"](),
      "LinkedPageIcon",
    ),
    advanced(
      "g.comment",
      t["com.myoxus.editor.toolbar.comment"](),
      "CommentIcon",
    ),
  );
  const snapshot = {
    open: true,
    key: "page",
    placement: "top" as const,
    primary,
    more: [],
  };
  const controls: EditorSelectionControls = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    dismiss,
    activate: () => controller.restore(),
    setFloating: () => {},
    setAnchor: (el) => {
      if (el)
        Object.assign(el.style, {
          pointerEvents: "none",
          position: "fixed",
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
    },
  };
  return (
    <EditorSelectionToolbar
      controls={controls}
      openMore={() =>
        controller.relinquish({ kind: "selection", control: "selection-more" })
      }
    />
  );
}
