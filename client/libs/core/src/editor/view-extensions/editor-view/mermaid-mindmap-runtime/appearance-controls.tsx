// SPDX-License-Identifier: AGPL-3.0-or-later
import { handleMindmapSelectKeyDown } from "./drafts";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  ColorSwatch,
  Group,
  MyoxusSelect,
  MyoxusText,
  NumberInput,
  Checkbox,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  mindmapAppearanceChoices,
  MindmapStrokeStyle,
  type MindmapNodeAppearance,
} from "@virgultum/block-mermaid";

/** The same existing palette/stroke roles edit a node or its incoming branch.
 * Unset fields inherit the selected native design; reset removes the override. */
export function MindmapAppearanceControls({
  value,
  onChange,
  branch = false,
}: {
  value: MindmapNodeAppearance | null;
  onChange: (value: MindmapNodeAppearance | null) => void;
  branch?: boolean;
}) {
  const t = useI18n(),
    choices = mindmapAppearanceChoices(),
    style = value ?? {};
  const set = <K extends keyof MindmapNodeAppearance>(
    key: K,
    next: MindmapNodeAppearance[K],
  ) => {
    const updated = { ...style };
    if (next === undefined) delete updated[key];
    else updated[key] = next;
    onChange(Object.keys(updated).length ? updated : null);
  };
  const color = (key: "color" | "fillColor" | "strokeColor", label: string) => (
    <MyoxusSelect
      label={label}
      comboboxProps={{ withinPortal: false }}
      value={
        key === "fillColor" && style.filled === false
          ? "transparent"
          : (style[key] ?? "")
      }
      data={[
        { value: "", label: m.optionDefault() },
        ...(key === "fillColor"
          ? [
              {
                value: "transparent",
                label:
                  t[
                    "com.myoxus.settings.editorSettings.edgeless.palette.transparent"
                  ](),
              },
            ]
          : []),
        ...choices.palette,
      ]}
      renderOption={({ option }) => (
        <Group>
          <ColorSwatch
            color={
              choices.palette.find((entry) => entry.value === option.value)
                ?.color
            }
          />
          <MyoxusText>{option.label}</MyoxusText>
        </Group>
      )}
      onChange={(next) => {
        if (key === "fillColor") {
          const updated = { ...style };
          if (next === "transparent") updated.filled = false;
          else if (next) {
            updated.filled = true;
            updated.fillColor = next;
          } else {
            delete updated.filled;
            delete updated.fillColor;
          }
          onChange(Object.keys(updated).length ? updated : null);
        } else set(key, next || undefined);
      }}
      onKeyDown={handleMindmapSelectKeyDown}
    />
  );
  return (
    <Stack>
      {color("strokeColor", m.quadrantStrokeColor())}
      <NumberInput
        label={m.quadrantStrokeWidth()}
        min={0}
        value={style.strokeWidth ?? ""}
        onChange={(next) =>
          set("strokeWidth", next === "" ? undefined : Number(next))
        }
      />
      <MyoxusSelect
        onKeyDown={handleMindmapSelectKeyDown}
        label={t["com.myoxus.editor.toolbar.stroke-style"]()}
        comboboxProps={{ withinPortal: false }}
        value={style.strokeStyle ?? ""}
        data={[
          { value: "", label: m.optionDefault() },
          {
            value: MindmapStrokeStyle.Solid,
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.note.border.solid"
              ](),
          },
          {
            value: MindmapStrokeStyle.Dash,
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.note.border.dash"
              ](),
          },
          {
            value: MindmapStrokeStyle.None,
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.note.border.none"
              ](),
          },
        ]}
        onChange={(next) =>
          set(
            "strokeStyle",
            [
              MindmapStrokeStyle.Solid,
              MindmapStrokeStyle.Dash,
              MindmapStrokeStyle.None,
            ].find((style) => style === next),
          )
        }
      />
      {!branch ? (
        <>
          {color("fillColor", m.quadrantFillColor())}
          {color("color", t["com.myoxus.editor.toolbar.text-color"]())}
          <MyoxusSelect
            onKeyDown={handleMindmapSelectKeyDown}
            label={t[
              "com.myoxus.settings.editorSettings.edgeless.text.font-family"
            ]()}
            comboboxProps={{ withinPortal: false }}
            value={style.fontFamily ?? ""}
            data={[
              { value: "", label: m.optionDefault() },
              ...choices.fonts,
              ...(style.fontFamily &&
              !choices.fonts.some((font) => font.value === style.fontFamily)
                ? [{ value: style.fontFamily, label: style.fontFamily }]
                : []),
            ]}
            onChange={(next) => set("fontFamily", next || undefined)}
          />
          <NumberInput
            label={m.architectureFontSize()}
            min={1}
            value={style.fontSize ?? ""}
            onChange={(next) =>
              set("fontSize", next === "" ? undefined : Number(next))
            }
          />
          <Checkbox
            label={t.Bold()}
            checked={
              style.fontWeight === "bold" || Number(style.fontWeight) >= 600
            }
            indeterminate={style.fontWeight === undefined}
            onChange={(event) =>
              set("fontWeight", event.currentTarget.checked ? "700" : "400")
            }
          />
          <Checkbox
            label={t["com.myoxus.editor.keyboard.italic"]()}
            checked={style.fontStyle === "italic"}
            indeterminate={style.fontStyle === undefined}
            onChange={(event) =>
              set(
                "fontStyle",
                event.currentTarget.checked ? "italic" : "normal",
              )
            }
          />
          <Checkbox
            label={t["com.myoxus.editor.keyboard.underline"]()}
            checked={style.textDecoration === "underline"}
            indeterminate={style.textDecoration === undefined}
            onChange={(event) =>
              set(
                "textDecoration",
                event.currentTarget.checked ? "underline" : "none",
              )
            }
          />
        </>
      ) : null}
      <Button variant="secondary" onClick={() => onChange(null)}>
        {m.optionDefault()}
      </Button>
    </Stack>
  );
}
