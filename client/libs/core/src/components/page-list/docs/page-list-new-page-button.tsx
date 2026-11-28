// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  LoadTemplateSuggestionsOptions,
  TemplateCategoryFilter,
  TemplateSuggestionSurface,
} from "@myoxus/core/modules/template-doc";
import type { HTMLAttributes, MouseEvent, PropsWithChildren } from "react";

import { NewPageButton } from "../components/new-page-button";

export const PageListNewPageButton = ({
  children,
  size,
  onCreateDoc,
  onCreatePage,
  onCreateEdgeless,
  onCreateFromTemplate,
  templateSuggestionSurface,
  templateCategoryFilter,
  templateSuggestionInput,
  ...props
}: PropsWithChildren<{
  className?: string;
  size?: "small" | "default";
  onCreateDoc: (e?: MouseEvent) => boolean | void | Promise<boolean | void>;
  onCreatePage: (e?: MouseEvent) => boolean | void | Promise<boolean | void>;
  onCreateEdgeless: (
    e?: MouseEvent,
  ) => boolean | void | Promise<boolean | void>;
  onCreateFromTemplate?: (
    templateDocId: string,
  ) => boolean | void | Promise<boolean | void>;
  templateSuggestionSurface?: TemplateSuggestionSurface;
  templateCategoryFilter?: TemplateCategoryFilter;
  templateSuggestionInput?: Omit<
    LoadTemplateSuggestionsOptions,
    "surface" | "locale" | "categoryFilter"
  >;
  disabled?: boolean;
}> &
  Omit<HTMLAttributes<HTMLDivElement>, "onClick">) => (
  <NewPageButton
    {...props}
    size={size}
    createNewDoc={onCreateDoc}
    createNewEdgeless={onCreateEdgeless}
    createNewPage={onCreatePage}
    createNewFromTemplate={onCreateFromTemplate}
    templateSuggestionSurface={templateSuggestionSurface}
    templateCategoryFilter={templateCategoryFilter}
    templateSuggestionInput={templateSuggestionInput}
  >
    {children}
  </NewPageButton>
);
