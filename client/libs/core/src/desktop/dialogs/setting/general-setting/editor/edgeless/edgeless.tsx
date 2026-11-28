// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";

import { SettingsSection } from "../../../primitives";
import { ConnectorSettings } from "./connector";
import { FrameSettings } from "./frame";
import { GeneralEdgelessSetting } from "./general";
import { MindMapSettings } from "./mind-map";
import { NoteSettings } from "./note";
import { PenSettings } from "./pen";
import { ShapeSettings } from "./shape";
import { TextSettings } from "./text";

export function Edgeless() {
  const t = useI18n();

  return (
    <>
      <SettingsSection
        title={t["com.myoxus.settings.editorSettings.edgeless"]()}
        testId="editor-settings-section-edgeless-general"
      >
        <GeneralEdgelessSetting />
      </SettingsSection>
      <NoteSettings />
      <TextSettings />
      <ShapeSettings />
      <FrameSettings />
      <ConnectorSettings />
      <PenSettings />
      <MindMapSettings />
    </>
  );
}
