import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import { DefaultTheme } from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import { isEqual } from "lodash-es";
import { useCallback, useMemo } from "react";

import { MenuItem, SettingsRow, SettingsSection } from "../../../primitives";
import { DropdownMenu, DropdownTrigger } from "../menu";
import { usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessSnapshot } from "./snapshot";

export const FrameSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { palettes, getCurrentColor } = usePalettes(
    [
      { key: "Transparent", value: DefaultTheme.transparent },
      ...DefaultTheme.FillColorShortPalettes,
    ],
    DefaultTheme.transparent,
  );

  const { background } = settings["myoxus:frame"];
  const currentColor = useMemo(() => {
    return getCurrentColor(background);
  }, [getCurrentColor, background]);

  const colorItems = useMemo(() => {
    return palettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set("myoxus:frame", { background: value });
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
  }, [editorSetting, background, palettes]);

  const getElements = useCallback((doc: Store) => {
    return doc.getBlocksByFlavour("myoxus:frame") || [];
  }, []);
  const title = t["com.myoxus.settings.editorSettings.edgeless.frame"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-frame"
    >
      <EdgelessSnapshot
        title={title}
        docName="frame"
        keyName="myoxus:frame"
        getElements={getElements}
      />
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.frame.background"
        ]()}
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
    </SettingsSection>
  );
};
