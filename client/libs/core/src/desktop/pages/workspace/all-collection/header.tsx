import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import {
  IconButton,
  WorkbenchHeaderTitle,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";

export const AllCollectionHeader = ({
  onCreateCollection,
}: {
  onCreateCollection?: () => void;
}) => {
  const t = useI18n();

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="all-collections-header-frame"
      title={<WorkbenchHeaderTitle>{t["Collections"]()}</WorkbenchHeaderTitle>}
      right={
        onCreateCollection ? (
          <IconButton
            icon={<PlusIcon />}
            aria-label={t[
              "com.myoxus.collections.empty.new-collection-button"
            ]()}
            tooltip={t["com.myoxus.collections.empty.new-collection-button"]()}
            onClick={onCreateCollection}
            data-testid="create-collection-header-button"
          />
        ) : null
      }
    />
  );
};
