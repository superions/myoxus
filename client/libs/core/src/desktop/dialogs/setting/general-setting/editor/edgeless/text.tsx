import { TextUtils } from "@virgultum/editor/blocks/surface";
import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import {
  DefaultTheme,
  FontStyle,
  FontWeightMap,
  TextAlign,
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
import { DropdownMenu, DropdownTrigger, EditorRadioGroup } from "../menu";
import { sortedFontWeightEntries, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessSnapshot } from "./snapshot";

export const TextSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { palettes, getCurrentColor } = usePalettes(
    DefaultTheme.StrokeColorShortPalettes,
    DefaultTheme.textColor,
  );

  const alignItems = useMemo<RadioItem[]>(
    () => [
      {
        value: TextAlign.Left,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.text.alignment.left"
          ](),
      },
      {
        value: TextAlign.Center,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.text.alignment.center"
          ](),
      },
      {
        value: TextAlign.Right,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.text.alignment.right"
          ](),
      },
    ],
    [t],
  );

  const { textAlign } = settings["myoxus:edgeless-text"];
  const setTextAlign = useCallback(
    (value: TextAlign) => {
      editorSetting.set("myoxus:edgeless-text", {
        textAlign: value,
      });
    },
    [editorSetting],
  );

  const colorItems = useMemo(() => {
    const { color } = settings["myoxus:edgeless-text"];
    return palettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set("myoxus:edgeless-text", { color: value });
      };
      const isSelected = isEqual(color, value);
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

  const fontFamilyItems = useMemo(() => {
    const { fontFamily } = settings["myoxus:edgeless-text"];
    return TextUtils.getFontFamilies().map((value) => {
      const name = value;
      const handler = () => {
        editorSetting.set("myoxus:edgeless-text", { fontFamily: value });
      };
      const isSelected = TextUtils.getFontFamilyName(fontFamily) === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const fontStyleItems = useMemo(() => {
    const { fontStyle } = settings["myoxus:edgeless-text"];
    return Object.entries(FontStyle).map(([name, value]) => {
      const handler = () => {
        editorSetting.set("myoxus:edgeless-text", { fontStyle: value });
      };
      const isSelected = fontStyle === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const fontWeightItems = useMemo(() => {
    const { fontWeight } = settings["myoxus:edgeless-text"];
    return sortedFontWeightEntries.map(([name, value]) => {
      const handler = () => {
        editorSetting.set("myoxus:edgeless-text", { fontWeight: value });
      };
      const isSelected = fontWeight === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const currentColor = useMemo(() => {
    const { color } = settings["myoxus:edgeless-text"];
    return getCurrentColor(color);
  }, [getCurrentColor, settings]);

  const getElements = useCallback((doc: Store) => {
    return doc.getBlocksByFlavour("myoxus:edgeless-text") || [];
  }, []);
  const title = t["com.myoxus.settings.editorSettings.edgeless.text"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-text"
    >
      <EdgelessSnapshot
        title={title}
        docName="text"
        keyName="myoxus:edgeless-text"
        getElements={getElements}
      />
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.text.color"]()}
        desc={""}
      >
        {currentColor ? (
          <DropdownMenu
            items={colorItems}
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
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-family"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={fontFamilyItems}
          trigger={
            <DropdownTrigger>
              {TextUtils.getFontFamilyName(
                settings["myoxus:edgeless-text"].fontFamily,
              )}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-style"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={fontStyleItems}
          trigger={
            <DropdownTrigger>
              {String(settings["myoxus:edgeless-text"].fontStyle)}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-weight"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={fontWeightItems}
          trigger={
            <DropdownTrigger>
              {FontWeightMap[settings["myoxus:edgeless-text"].fontWeight]}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.text.alignment"]()}
        desc={""}
      >
        <EditorRadioGroup
          items={alignItems}
          value={textAlign}
          onChange={setTextAlign}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
