import { EditorReadingSizeSelect } from "@myoxus/core/components/editor-reading-size";
import { useI18n } from "@myoxus/i18n";

import { RowLayout } from "../row.layout";

export const ReadingSizeSetting = () => {
  const t = useI18n();
  return (
    <RowLayout
      label={t["com.myoxus.settings.editorSettings.general.font-size.title"]()}
    >
      <EditorReadingSizeSelect />
    </RowLayout>
  );
};
