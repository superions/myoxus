import {
  type LoadTemplateSuggestionsOptions,
  type TemplateCategoryFilter,
  type TemplateSuggestionSurface,
} from "@myoxus/core/modules/template-doc";
import { TemplateListMenuContentScrollable } from "@myoxus/core/modules/template-doc/view/template-list-menu";
import { useI18n } from "@myoxus/i18n";
import { EdgelessIcon, PageIcon, PlusIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import {
  BlockCard,
  MenuPanel,
  MenuSeparator,
  SplitMenuButton,
} from "@myoxus/ui-facade";
import {
  type HTMLAttributes,
  type MouseEvent,
  type PropsWithChildren,
  useCallback,
  useState,
} from "react";

type NewPageButtonProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onClick"
> & {
  createNewDoc: (e?: MouseEvent) => boolean | void | Promise<boolean | void>;
  createNewPage: (e?: MouseEvent) => boolean | void | Promise<boolean | void>;
  createNewEdgeless: (
    e?: MouseEvent,
  ) => boolean | void | Promise<boolean | void>;
  createNewFromTemplate?: (
    templateDocId: string,
  ) => boolean | void | Promise<boolean | void>;
  templateSuggestionSurface?: TemplateSuggestionSurface;
  templateCategoryFilter?: TemplateCategoryFilter;
  templateSuggestionInput?: Omit<
    LoadTemplateSuggestionsOptions,
    "surface" | "locale" | "categoryFilter"
  >;
  size?: "small" | "default";
  disabled?: boolean;
};

export const CreateNewPagePopup = ({
  createNewPage,
  createNewEdgeless,
  createNewFromTemplate,
  templateSuggestionSurface,
  templateCategoryFilter,
  templateSuggestionInput,
}: NewPageButtonProps) => {
  const t = useI18n();
  const iconSize =
    "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";
  return (
    <MenuPanel data-testid="new-page-menu">
      <BlockCard
        title={t["com.myoxus.new.page-mode"]()}
        desc={t["com.myoxus.write_with_a_blank_page"]()}
        right={<PageIcon width={iconSize} height={iconSize} />}
        onClick={createNewPage}
        onAuxClick={createNewPage}
        data-testid="new-page-button-in-all-page"
      />
      <BlockCard
        title={t["com.myoxus.new_edgeless"]()}
        desc={t["com.myoxus.draw_with_a_blank_whiteboard"]()}
        right={<EdgelessIcon width={iconSize} height={iconSize} />}
        onClick={createNewEdgeless}
        onAuxClick={createNewEdgeless}
        data-testid="new-edgeless-button-in-all-page"
      />
      {createNewFromTemplate && templateSuggestionSurface ? (
        <>
          <MenuSeparator />
          <TemplateListMenuContentScrollable
            onSelect={createNewFromTemplate}
            categoryFilter={templateCategoryFilter}
            suggestionSurface={templateSuggestionSurface}
            suggestionInput={templateSuggestionInput}
          />
        </>
      ) : null}
    </MenuPanel>
  );
};

export const NewPageButton = ({
  createNewDoc,
  createNewPage,
  createNewEdgeless,
  createNewFromTemplate,
  templateSuggestionSurface,
  templateCategoryFilter,
  templateSuggestionInput,
  children,
  size: _size,
  ...rootProps
}: PropsWithChildren<NewPageButtonProps>) => {
  const [open, setOpen] = useState(false);

  const handleCreateNewDoc: NewPageButtonProps["createNewDoc"] = useCallback(
    async (e) => {
      if ((await createNewDoc(e)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc();
    },
    [createNewDoc],
  );

  const handleCreateNewPage: NewPageButtonProps["createNewPage"] = useCallback(
    async (e) => {
      if ((await createNewPage(e)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc({ mode: "page" });
    },
    [createNewPage],
  );

  const handleCreateNewEdgeless: NewPageButtonProps["createNewEdgeless"] =
    useCallback(
      async (e) => {
        if ((await createNewEdgeless(e)) === false) return;
        setOpen(false);
        track.allDocs.header.actions.createDoc({
          mode: "edgeless",
        });
      },
      [createNewEdgeless],
    );
  const handleCreateNewFromTemplate: NonNullable<
    NewPageButtonProps["createNewFromTemplate"]
  > = useCallback(
    async (templateDocId) => {
      if ((await createNewFromTemplate?.(templateDocId)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc();
    },
    [createNewFromTemplate],
  );

  return (
    <SplitMenuButton
      {...rootProps}
      actionIcon={<PlusIcon />}
      label={children}
      menuItems={
        <CreateNewPagePopup
          createNewDoc={handleCreateNewDoc}
          createNewPage={handleCreateNewPage}
          createNewEdgeless={handleCreateNewEdgeless}
          createNewFromTemplate={
            createNewFromTemplate ? handleCreateNewFromTemplate : undefined
          }
          templateSuggestionSurface={templateSuggestionSurface}
          templateCategoryFilter={templateCategoryFilter}
          templateSuggestionInput={templateSuggestionInput}
        />
      }
      menuRootOptions={{
        open,
        onOpenChange: setOpen,
      }}
      menuContentOptions={{
        align: "end",
        panelPadding: "comfortable",
        hideWhenDetached: true,
        onInteractOutside: useCallback(() => {
          setOpen(false);
        }, []),
      }}
      actionTestId="new-page-button-trigger"
      menuTestId="new-page-button-menu-trigger"
      onActionAuxClick={handleCreateNewPage}
      onClick={handleCreateNewDoc}
      fluid={false}
      variant="secondary"
    />
  );
};
