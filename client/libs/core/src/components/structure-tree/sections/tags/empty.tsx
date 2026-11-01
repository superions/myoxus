import { useI18n } from "@myoxus/i18n";
import { TagIcon } from "@myoxus/icons/react";

import { StructureTreeEmptySection } from "../../layouts/empty-section";

export const RootEmpty = () => {
  const t = useI18n();

  return (
    <StructureTreeEmptySection
      icon={TagIcon}
      message={t["com.myoxus.rootAppSidebar.tags.empty"]()}
      messageTestId="slider-bar-tags-empty-message"
    />
  );
};
