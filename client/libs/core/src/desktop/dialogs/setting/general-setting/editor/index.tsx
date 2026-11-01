import { useI18n } from "@myoxus/i18n";

import { SettingHeader } from "../../primitives";
import { Edgeless } from "./edgeless";
import { General } from "./general";
import { Page } from "./page";

export const EditorSettings = () => {
  const t = useI18n();

  return (
    <>
      <SettingHeader
        title={t["com.myoxus.settings.editorSettings.title"]()}
        subtitle={t["com.myoxus.settings.editorSettings.subtitle"]()}
      />
      <General />
      <Page />
      <Edgeless />

      {/* // TODO(@EYHN): implement export and import
       <Preferences /> */}
    </>
  );
};
