import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import {
  createEnumMap,
  DefaultTheme,
  NoteShadow,
  NoteShadowMap,
  StrokeStyle,
} from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import { isEqual } from "lodash-es";
import { useCallback, useMemo } from "react";

import {
  MenuItem,
  type RadioItem,
  SettingsRow,
  SettingsSection,
} from "../../../primitives";
import {
  DropdownMenu,
  DropdownTrigger,
  EditorRadioGroup,
  EditorSlider,
} from "../menu";
import { usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessSnapshot } from "./snapshot";

enum CornerSize {
  None = 0,
  Small = 8,
  Medium = 16,
  Large = 24,
  Huge = 32,
}

const CornerSizeMap = createEnumMap(CornerSize);

const CORNER_SIZE = [
  { name: "None", value: CornerSize.None },
  { name: "Small", value: CornerSize.Small },
  { name: "Medium", value: CornerSize.Medium },
  { name: "Large", value: CornerSize.Large },
  { name: "Huge", value: CornerSize.Huge },
] as const;

export const NoteSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { palettes, getCurrentColor } = usePalettes(
    DefaultTheme.NoteBackgroundColorPalettes,
    DefaultTheme.noteBackgrounColor,
  );

  const borderStyleItems = useMemo<RadioItem[]>(
    () => [
      {
        value: StrokeStyle.Solid,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.note.border.solid"](),
      },
      {
        value: StrokeStyle.Dash,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.note.border.dash"](),
      },
      {
        value: StrokeStyle.None,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.note.border.none"](),
      },
    ],
    [t],
  );

  const { borderStyle } = settings["myoxus:note"].edgeless.style;
  const setBorderStyle = useCallback(
    (value: StrokeStyle) => {
      editorSetting.set("myoxus:note", {
        edgeless: {
          style: {
            borderStyle: value,
          },
        },
      });
    },
    [editorSetting],
  );

  const { borderSize } = settings["myoxus:note"].edgeless.style;
  const setBorderSize = useCallback(
    (value: number[]) => {
      editorSetting.set("myoxus:note", {
        edgeless: {
          style: {
            borderSize: value[0],
          },
        },
      });
    },
    [editorSetting],
  );

  const backgroundItems = useMemo(() => {
    const { background } = settings["myoxus:note"];
    return palettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set("myoxus:note", { background: value });
      };
      const isSelected = isEqual(background, value);
      return (
        <MenuItem
          key={key}
          onSelect={handler}
          selected={isSelected}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      );
    });
  }, [editorSetting, settings, palettes]);

  const cornerItems = useMemo(() => {
    const { borderRadius } = settings["myoxus:note"].edgeless.style;
    return CORNER_SIZE.map(({ name, value }) => {
      const handler = () => {
        editorSetting.set("myoxus:note", {
          edgeless: {
            style: {
              borderRadius: value,
            },
          },
        });
      };
      const isSelected = borderRadius === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const shadowItems = useMemo(() => {
    const { shadowType } = settings["myoxus:note"].edgeless.style;
    return Object.entries(NoteShadow).map(([name, value]) => {
      const handler = () => {
        editorSetting.set("myoxus:note", {
          edgeless: {
            style: {
              shadowType: value,
            },
          },
        });
      };
      const isSelected = shadowType === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const currentColor = useMemo(() => {
    const { background } = settings["myoxus:note"];
    return getCurrentColor(background);
  }, [getCurrentColor, settings]);

  const getElements = useCallback((doc: Store) => {
    return doc.getBlocksByFlavour("myoxus:note") || [];
  }, []);
  const title = t["com.myoxus.settings.editorSettings.edgeless.note"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-note"
    >
      <EdgelessSnapshot
        title={title}
        docName="note"
        keyName="myoxus:note"
        getElements={getElements}
        previewSize="note"
      />
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.note.background"
        ]()}
        desc={""}
      >
        {currentColor ? (
          <DropdownMenu
            items={backgroundItems}
            trigger={
              <DropdownTrigger
                prefix={<Point color={currentColor.resolvedValue} />}
              >
                {currentColor.label}
              </DropdownTrigger>
            }
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.note.corners"]()}
        desc={""}
      >
        <DropdownMenu
          items={cornerItems}
          trigger={
            <DropdownTrigger>
              {
                CornerSizeMap[
                  settings["myoxus:note"].edgeless.style
                    .borderRadius as CornerSize
                ]
              }
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.note.shadow"]()}
        desc={""}
      >
        <DropdownMenu
          items={shadowItems}
          trigger={
            <DropdownTrigger>
              {NoteShadowMap[settings["myoxus:note"].edgeless.style.shadowType]}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.note.border"]()}
        desc={""}
      >
        <EditorRadioGroup
          items={borderStyleItems}
          value={borderStyle}
          onChange={setBorderStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.note.border-thickness"
        ]()}
        desc={""}
      >
        <EditorSlider
          value={[borderSize]}
          onValueChange={setBorderSize}
          min={2}
          max={12}
          step={2}
          nodes={[2, 4, 6, 8, 10, 12]}
          disabled={borderStyle === StrokeStyle.None}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
