import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import { Modal } from "@myoxus/ui-facade";
import { useMemo } from "react";

import { GenericSelector } from "./generic-selector";

const TagIcon = ({ tagId }: { tagId: string }) => {
  const tagService = useService(TagService);
  const tag = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const color = useLiveData(tag?.color$);

  return (
    <span
      aria-hidden="true"
      data-myoxus-ui-role="mobile-tag-color-dot"
      style={{
        aspectRatio: "1",
        background: color,
        borderRadius: "50%",
        display: "inline-block",
        width: "0.5em",
      }}
    />
  );
};

const TagLabel = ({ tagId }: { tagId: string }) => {
  const tagService = useService(TagService);
  const tag = useLiveData(tagService.tagList.tagByTagId$(tagId));
  const name = useLiveData(tag?.value$);

  return name;
};

export const TagSelectorDialog = ({
  close,
  init,
  onBeforeConfirm,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["tag-selector"]>) => {
  const t = useI18n();
  const tagService = useService(TagService);
  const tags = useLiveData(tagService.tagList.tags$);

  const list = useMemo(() => {
    return tags.map((tag) => ({
      id: tag.id,
      icon: <TagIcon tagId={tag.id} />,
      label: <TagLabel tagId={tag.id} />,
    }));
  }, [tags]);

  return (
    <Modal
      open
      onOpenChange={() => close()}
      withoutCloseButton
      fullScreen
      contentOptions={{
        style: {
          background: cssVar("backgroundSecondaryColor"),
          padding: 0,
        },
      }}
    >
      <GenericSelector
        onBack={close}
        onConfirm={close}
        onBeforeConfirm={onBeforeConfirm}
        initial={init}
        data={list}
        typeName={t[`com.myoxus.m.selector.type-tag`]()}
      />
    </Modal>
  );
};
