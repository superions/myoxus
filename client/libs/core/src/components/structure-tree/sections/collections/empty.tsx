import { useI18n } from "@myoxus/i18n";
import { ViewLayersIcon } from "@myoxus/icons/react";

import { StructureTreeEmptySection } from "../../layouts/empty-section";

export const RootEmpty = ({
  onClickCreate,
}: {
  onClickCreate?: () => void;
}) => {
  const t = useI18n();

  return (
    <StructureTreeEmptySection
      icon={ViewLayersIcon}
      message={t["com.myoxus.collections.empty.message"]()}
      messageTestId="slider-bar-collection-empty-message"
      actionText={t["com.myoxus.collections.empty.new-collection-button"]()}
      onActionClick={onClickCreate}
    />
  );
};
