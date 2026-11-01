import { useWorkspaceTagCommands } from "@myoxus/core/components/tags";
import { StructureTreeStateService } from "@myoxus/core/modules/structure-tree";
import { TagService } from "@myoxus/core/modules/tag";
import { useI18n } from "@myoxus/i18n";
import { AddTagIcon } from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  Alert,
  Button,
  Loading,
  StructureTreeActionButton,
  usePromptModal,
} from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import { CollapsibleSection } from "../../layouts/collapsible-section";
import { StructureTreeTagNode } from "../../nodes/tag";
import { StructureTreeRoot } from "../../tree";
import { RootEmpty } from "./empty";

export const StructureTreeTags = () => {
  const { tagService, structureTreeStateService } = useServices({
    TagService,
    StructureTreeStateService,
  });
  const path = useMemo(() => ["tags"], []);
  const tagMetas = useLiveData(tagService.tagList.tagMetas$);
  const catalogState = useLiveData(tagService.tagList.catalogState$);
  const activeTagIds = useMemo(
    () => tagMetas.filter((tag) => !tag.archived).map((tag) => tag.id),
    [tagMetas],
  );
  const commands = useWorkspaceTagCommands();

  const t = useI18n();
  const { openPromptModal } = usePromptModal();

  const handleCreateNewTag = useCallback(
    async (name: string) => {
      await commands.createTag(name, tagService.randomTagColor());
      track.$.navigationPanel.organize.createOrganizeItem({ type: "tag" });
      structureTreeStateService.setCollapsed(path, false);
    },
    [commands, structureTreeStateService, path, tagService],
  );

  const handleOpenCreateModal = useCallback(() => {
    if (catalogState.status !== "ready") return;
    openPromptModal({
      title: t["com.myoxus.rootAppSidebar.tags.new-tag"](),
      inputOptions: {
        "aria-label": t["com.myoxus.rootAppSidebar.tags.new-tag"](),
        placeholder: t["com.myoxus.tags.create-tag.placeholder"](),
      },
      confirmText: t["Create"](),
      cancelText: t["Cancel"](),
      onConfirm: handleCreateNewTag,
    });
  }, [catalogState.status, handleCreateNewTag, openPromptModal, t]);

  return (
    <CollapsibleSection
      path={path}
      testId="structure-tree-tags"
      headerDropTarget
      title={t["com.myoxus.rootAppSidebar.tags"]()}
      actions={
        <StructureTreeActionButton
          data-testid="structure-tree-bar-add-tag-button"
          disabled={catalogState.status !== "ready"}
          onClick={handleOpenCreateModal}
          tooltip={t[
            "com.myoxus.rootAppSidebar.explorer.tag-section-add-tooltip"
          ]()}
        >
          <AddTagIcon />
        </StructureTreeActionButton>
      }
    >
      {catalogState.status === "loading" && activeTagIds.length === 0 ? (
        <Loading data-testid="structure-tree-tags-loading" />
      ) : null}
      {catalogState.status === "error" ? (
        <Alert
          data-testid="structure-tree-tags-error"
          title={t["com.myoxus.tags.catalog.load-failed"]()}
        >
          <Button
            variant="secondary"
            onClick={() => {
              void tagService.tagList.retryCatalog().catch(() => undefined);
            }}
          >
            {t["Retry"]()}
          </Button>
        </Alert>
      ) : null}
      <StructureTreeRoot placeholder={<RootEmpty />}>
        {activeTagIds.map((tagId) => (
          <StructureTreeTagNode
            key={tagId}
            tagId={tagId}
            reorderable={false}
            location={{
              at: "structure-tree:tags:list",
            }}
            parentPath={path}
          />
        ))}
      </StructureTreeRoot>
    </CollapsibleSection>
  );
};
