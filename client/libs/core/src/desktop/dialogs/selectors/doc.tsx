import { SelectPage } from "@myoxus/core/components/page-list/docs/select-page";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { Modal } from "@myoxus/ui-facade";

export const DocSelectorDialog = ({
  close,
  init: selectedDocIds,
  multiple,
  extraFilters,
  returnFocusRef,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["doc-selector"]>) => {
  return (
    <Modal
      open
      onOpenChange={() => close()}
      withoutCloseButton
      width="lg"
      returnFocusRef={returnFocusRef}
    >
      <SelectPage
        init={selectedDocIds}
        multiple={multiple}
        extraFilters={extraFilters}
        onCancel={() => close()}
        onConfirm={(value) => close(value)}
      />
    </Modal>
  );
};
