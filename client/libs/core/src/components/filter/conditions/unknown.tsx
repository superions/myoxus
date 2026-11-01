import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { WarningIcon } from "@myoxus/icons/react";
import { useEffect } from "react";

import { Condition } from "./condition";

export const UnknownFilterCondition = ({
  filter,
  isDraft,
  onDraftCompleted,
}: {
  filter: FilterParams;
  isDraft?: boolean;
  onDraftCompleted?: () => void;
}) => {
  useEffect(() => {
    if (isDraft) {
      // should not reach here
      onDraftCompleted?.();
    }
  }, [isDraft, onDraftCompleted]);

  return (
    <Condition
      filter={filter}
      icon={<WarningIcon />}
      name="Unknown"
      tone="danger"
    />
  );
};
