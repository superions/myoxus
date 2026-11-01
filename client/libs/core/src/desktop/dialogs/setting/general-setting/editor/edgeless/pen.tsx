import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import { getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import { DefaultTheme } from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import { isEqual } from "lodash-es";
import { useCallback, useMemo } from "react";

import { MenuItem, SettingsRow, SettingsSection } from "../../../primitives";
import { DropdownMenu, DropdownTrigger, EditorSlider } from "../menu";
import { usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessSnapshot } from "./snapshot";

export const PenSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { palettes, getCurrentColor } = usePalettes(
    DefaultTheme.StrokeColorShortPalettes,
    DefaultTheme.black,
  );

  const currentColor = useMemo(() => {
    return getCurrentColor(settings.brush.color);
  }, [getCurrentColor, settings.brush.color]);

  const colorItems = useMemo(() => {
    const { color } = settings.brush;
    return palettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set("brush", { color: value });
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
  }, [editorSetting, settings.brush, palettes]);

  const borderThickness = settings.brush.lineWidth;
  const setBorderThickness = useCallback(
    (value: number[]) => {
      editorSetting.set("brush", {
        lineWidth: value[0],
      });
    },
    [editorSetting],
  );

  const getElements = useCallback((doc: Store) => {
    const surface = getSurfaceBlock(doc);
    return surface?.getElementsByType("brush") || [];
  }, []);
  const title = t["com.myoxus.settings.editorSettings.edgeless.pen"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-pen"
    >
      <EdgelessSnapshot
        title={title}
        docName="pen"
        keyName="brush"
        getElements={getElements}
      />
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.pen.color"]()}
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
        name={t["com.myoxus.settings.editorSettings.edgeless.pen.thickness"]()}
        desc={""}
      >
        <EditorSlider
          value={[borderThickness]}
          onValueChange={setBorderThickness}
          min={2}
          max={12}
          step={2}
          nodes={[2, 4, 6, 8, 10, 12]}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
