import { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
import { SmileSolidIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  DocumentIconTitleSlot,
  IconEditor,
  IconEditorTriggerFrame,
  IconRenderer,
} from "@myoxus/ui-facade";

export const DocIconPicker = ({
  docId,
  readonly,
}: {
  docId: string;
  readonly?: boolean;
}) => {
  const explorerIconService = useService(ExplorerIconService);

  const icon = useLiveData(explorerIconService.icon$("doc", docId));

  const isPlaceholder = !icon?.icon;

  if (readonly) {
    return isPlaceholder ? null : (
      <DocumentIconTitleSlot hasIcon>
        <IconEditorTriggerFrame
          iconType={icon?.icon?.type}
          variant="document-title"
        >
          <IconRenderer data={icon.icon} />
        </IconEditorTriggerFrame>
      </DocumentIconTitleSlot>
    );
  }

  return (
    <DocumentIconTitleSlot hasIcon={!isPlaceholder}>
      <IconEditor
        icon={icon?.icon}
        onIconChange={(data) => {
          explorerIconService.setIcon({
            where: "doc",
            id: docId,
            icon: data,
          });
        }}
        closeAfterSelect={true}
        triggerVariant={
          isPlaceholder ? "document-title-placeholder" : "document-title"
        }
        iconPlaceholder={<SmileSolidIcon aria-hidden />}
      />
    </DocumentIconTitleSlot>
  );
};
