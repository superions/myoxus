// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  MindmapDesign as MindmapStyle,
  MindmapLayoutType as LayoutType,
} from "@virgultum/block-mermaid";
import { useCallback, useMemo } from "react";

import {
  MenuItem,
  type RadioItem,
  SettingsRow,
  SettingsSection,
} from "../../../primitives";
import { DropdownMenu, DropdownTrigger, EditorRadioGroup } from "../menu";
import { EdgelessStylePreview } from "./preview";

const MINDMAP_STYLE_OPTIONS = [
  { value: MindmapStyle.ONE, name: "1" },
  { value: MindmapStyle.TWO, name: "2" },
  { value: MindmapStyle.THREE, name: "3" },
  { value: MindmapStyle.FOUR, name: "4" },
] as const;

export const MindMapSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { layoutType, style } = settings.mindmap;

  const setLayoutType = useCallback(
    (value: LayoutType) => {
      editorSetting.set("mindmap", { layoutType: value });
    },
    [editorSetting],
  );

  const layoutTypeItems = useMemo<RadioItem[]>(
    () => [
      {
        value: LayoutType.LEFT as unknown as string,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.mind-map.layout.left"
          ](),
      },
      {
        value: LayoutType.BALANCE as unknown as string,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.mind-map.layout.radial"
          ](),
      },
      {
        value: LayoutType.RIGHT as unknown as string,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.mind-map.layout.right"
          ](),
      },
    ],
    [t],
  );

  const styleItems = useMemo(
    () =>
      MINDMAP_STYLE_OPTIONS.map(({ name, value }) => (
        <MenuItem
          key={name}
          onSelect={() => {
            editorSetting.set("mindmap", { style: value });
          }}
          selected={style === value}
        >
          {name}
        </MenuItem>
      )),
    [editorSetting, style],
  );

  const currentLayoutLabel =
    layoutTypeItems.find(
      (item) => item.value === (layoutType as unknown as string),
    )?.label ?? String(layoutType);
  const title = t["com.myoxus.settings.editorSettings.edgeless.mind-map"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-mind-map"
    >
      <EdgelessStylePreview
        sampleTitle={t[
          "com.myoxus.settings.editorSettings.edgeless.preview.mindmap.title"
        ]()}
        items={[
          {
            label: t["com.myoxus.settings.editorSettings.edgeless.style"](),
            value: String(style),
          },
          {
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.mind-map.layout"
              ](),
            value: currentLayoutLabel,
          },
        ]}
      />
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.style"]()}
        desc=""
      >
        <DropdownMenu
          items={styleItems}
          trigger={<DropdownTrigger>{String(style)}</DropdownTrigger>}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.mind-map.layout"
        ]()}
        desc=""
      >
        <EditorRadioGroup
          items={layoutTypeItems}
          value={layoutType}
          onChange={setLayoutType}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
