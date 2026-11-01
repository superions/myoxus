import { EditorService } from "@myoxus/core/modules/editor";
import { PresentationIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { IconButton } from "@myoxus/ui-facade";

export const DetailPageHeaderPresentButton = () => {
  const editorService = useService(EditorService);

  return (
    <IconButton
      style={{ flexShrink: 0 }}
      size="24"
      onClick={() => editorService.editor.togglePresentation()}
    >
      <PresentationIcon />
    </IconButton>
  );
};
