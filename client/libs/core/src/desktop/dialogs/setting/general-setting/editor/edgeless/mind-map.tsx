import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import { MermaidBlockModel } from "@virgultum/editor/model";
import {
  MindmapLayoutType as LayoutType,
  MindmapDesign as MindmapStyle,
  applyMermaidVisualModelCommand,
  getMermaidBlockSource,
  getMermaidVisualModel,
  projectMindmapTree,
  readMindmapProjectionModel,
} from "@virgultum/block-mermaid";
import type { EditorHost } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { useCallback, useMemo } from "react";

import {
  MenuItem,
  type RadioItem,
  SettingsRow,
  SettingsSection,
} from "../../../primitives";
import { DropdownMenu, DropdownTrigger, EditorRadioGroup } from "../menu";
import { EdgelessSnapshot } from "./snapshot";

const MINDMAP_STYLES = [
  {
    value: MindmapStyle.ONE,
    name: "1",
  },
  {
    value: MindmapStyle.TWO,
    name: "2",
  },
  {
    value: MindmapStyle.THREE,
    name: "3",
  },
  {
    value: MindmapStyle.FOUR,
    name: "4",
  },
];

export const MindMapSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);

  const { layoutType } = settings.mindmap;
  const setLayoutType = useCallback(
    (value: LayoutType) => {
      editorSetting.set("mindmap", {
        layoutType: value,
      });
    },
    [editorSetting],
  );
  const layoutTypeItems = useMemo<RadioItem[]>(
    () => [
      {
        value: LayoutType.LEFT as any,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.mind-map.layout.left"
          ](),
      },
      {
        value: LayoutType.BALANCE as any,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.mind-map.layout.radial"
          ](),
      },
      {
        value: LayoutType.RIGHT as any,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.mind-map.layout.right"
          ](),
      },
    ],
    [t],
  );

  const styleItems = useMemo(() => {
    const { style } = settings.mindmap;
    return MINDMAP_STYLES.map(({ name, value }) => {
      const handler = () => {
        editorSetting.set("mindmap", { style: value });
      };
      const isSelected = style === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const getElements = useCallback(
    (doc: Store) => doc.getBlocksByFlavour("myoxus:mermaid"),
    [],
  );
  const applySettings = useCallback(
    (doc: Store, host: EditorHost) => {
      const owner = doc.getBlocksByFlavour("myoxus:mermaid")[0]?.model;
      if (!(owner instanceof MermaidBlockModel)) return;
      const source = getMermaidBlockSource(owner.props);
      const model = readMindmapProjectionModel(
        source,
        getMermaidVisualModel(owner) ?? undefined,
      );
      if (!model) return;
      const values = editorSetting.get("mindmap");
      host.std.command.exec(applyMermaidVisualModelCommand, {
        model: owner,
        sourceWrite: { baseSource: source, source },
        visualModel: projectMindmapTree(model, {
          layout: values.layoutType,
          design: values.style,
        }),
      });
      return owner.elementBound.clone();
    },
    [editorSetting],
  );
  const title = t["com.myoxus.settings.editorSettings.edgeless.mind-map"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-mind-map"
    >
      <EdgelessSnapshot
        title={title}
        docName="mindmap"
        keyName={"mindmap" as any}
        getElements={getElements}
        applySettings={applySettings}
        previewSize="mindmap"
      />
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.style"]()}
        desc={""}
      >
        <DropdownMenu
          items={styleItems}
          trigger={
            <DropdownTrigger>{String(settings.mindmap.style)}</DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.mind-map.layout"
        ]()}
        desc={""}
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
