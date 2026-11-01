import { useI18n } from "@myoxus/i18n";
import { SaveIcon } from "@myoxus/icons/react";
import { Button, MyoxusText, usePromptModal } from "@myoxus/ui-facade";
import { useCallback } from "react";

interface SaveAsCollectionButtonProps {
  onConfirm: (collectionName: string) => void;
}

export const SaveAsCollectionButton = ({
  onConfirm,
}: SaveAsCollectionButtonProps) => {
  const t = useI18n();
  const { openPromptModal } = usePromptModal();
  const handleClick = useCallback(() => {
    openPromptModal({
      title: t["com.myoxus.editCollection.saveCollection"](),
      label: t["com.myoxus.editCollectionName.name"](),
      inputOptions: {
        placeholder: t["com.myoxus.editCollectionName.name.placeholder"](),
      },
      children: (
        <MyoxusText tone="secondary" typographySlot="body-small">
          {t["com.myoxus.editCollectionName.createTips"]()}
        </MyoxusText>
      ),
      confirmText: t["com.myoxus.editCollection.save"](),
      cancelText: t["com.myoxus.editCollection.button.cancel"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      onConfirm(name) {
        onConfirm(name);
      },
    });
  }, [openPromptModal, t, onConfirm]);
  return (
    <Button
      onClick={handleClick}
      data-testid="save-as-collection"
      prefix={<SaveIcon />}
    >
      {t["com.myoxus.editCollection.saveCollection"]()}
    </Button>
  );
};
