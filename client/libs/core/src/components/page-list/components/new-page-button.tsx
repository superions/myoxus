// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  LoadTemplateSuggestionsOptions,
  TemplateCategoryFilter,
  TemplateSuggestionSurface,
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

type CreateAction = (
  event?: MouseEvent,
) => boolean | void | Promise<boolean | void>;
type CreateTemplateAction = (
  templateDocId: string,
) => boolean | void | Promise<boolean | void>;

export type NewPageButtonProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onClick"
> & {
  createNewDoc: CreateAction;
  createNewPage: CreateAction;
  createNewEdgeless: CreateAction;
  createNewFromTemplate?: CreateTemplateAction;
  templateSuggestionSurface?: TemplateSuggestionSurface;
  templateCategoryFilter?: TemplateCategoryFilter;
  templateSuggestionInput?: Omit<
    LoadTemplateSuggestionsOptions,
    "surface" | "locale" | "categoryFilter"
  >;
  size?: "small" | "default";
  disabled?: boolean;
};

const POPUP_ICON_SIZE =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";

export const CreateNewPagePopup = ({
  createNewPage,
  createNewEdgeless,
  createNewFromTemplate,
  templateSuggestionSurface,
  templateCategoryFilter,
  templateSuggestionInput,
}: NewPageButtonProps) => {
  const t = useI18n();

  return (
    <MenuPanel data-testid="new-page-menu">
      <BlockCard
        title={t["com.myoxus.new.page-mode"]()}
        desc={t["com.myoxus.write_with_a_blank_page"]()}
        right={<PageIcon width={POPUP_ICON_SIZE} height={POPUP_ICON_SIZE} />}
        onClick={createNewPage}
        onAuxClick={createNewPage}
        data-testid="new-page-button-in-all-page"
      />
      <BlockCard
        title={t["com.myoxus.new_edgeless"]()}
        desc={t["com.myoxus.draw_with_a_blank_whiteboard"]()}
        right={
          <EdgelessIcon width={POPUP_ICON_SIZE} height={POPUP_ICON_SIZE} />
        }
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

  const handleNewDoc = useCallback<CreateAction>(
    async (event) => {
      if ((await createNewDoc(event)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc();
    },
    [createNewDoc],
  );

  const handleNewPage = useCallback<CreateAction>(
    async (event) => {
      if ((await createNewPage(event)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc({ mode: "page" });
    },
    [createNewPage],
  );

  const handleNewEdgeless = useCallback<CreateAction>(
    async (event) => {
      if ((await createNewEdgeless(event)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc({ mode: "edgeless" });
    },
    [createNewEdgeless],
  );

  const handleNewFromTemplate = useCallback<CreateTemplateAction>(
    async (templateDocId) => {
      if ((await createNewFromTemplate?.(templateDocId)) === false) return;
      setOpen(false);
      track.allDocs.header.actions.createDoc();
    },
    [createNewFromTemplate],
  );

  const handleInteractOutside = useCallback(() => setOpen(false), []);

  return (
    <SplitMenuButton
      {...rootProps}
      actionIcon={<PlusIcon />}
      label={children}
      menuItems={
        <CreateNewPagePopup
          createNewDoc={handleNewDoc}
          createNewPage={handleNewPage}
          createNewEdgeless={handleNewEdgeless}
          createNewFromTemplate={
            createNewFromTemplate ? handleNewFromTemplate : undefined
          }
          templateSuggestionSurface={templateSuggestionSurface}
          templateCategoryFilter={templateCategoryFilter}
          templateSuggestionInput={templateSuggestionInput}
        />
      }
      menuRootOptions={{ open, onOpenChange: setOpen }}
      menuContentOptions={{
        align: "end",
        panelPadding: "comfortable",
        hideWhenDetached: true,
        onInteractOutside: handleInteractOutside,
      }}
      actionTestId="new-page-button-trigger"
      menuTestId="new-page-button-menu-trigger"
      onActionAuxClick={handleNewPage}
      onClick={handleNewDoc}
      fluid={false}
      variant="secondary"
    />
  );
};
