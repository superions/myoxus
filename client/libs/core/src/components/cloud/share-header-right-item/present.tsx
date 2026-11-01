import { EditorService } from "@myoxus/core/modules/editor";
import { useI18n } from "@myoxus/i18n";
import { PresentationIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { Button } from "@myoxus/ui-facade";

export const PresentButton = () => {
  const t = useI18n();
  const editorService = useService(EditorService);
  const isPresent = useLiveData(editorService.editor.isPresenting$);

  return (
    <Button
      prefix={<PresentationIcon />}
      variant="primary"
      onClick={() => editorService.editor.togglePresentation()}
      disabled={isPresent}
    >
      {t["com.myoxus.share-page.header.present"]()}
    </Button>
  );
};
