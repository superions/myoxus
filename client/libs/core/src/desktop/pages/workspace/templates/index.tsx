// SPDX-License-Identifier: AGPL-3.0-or-later

import { TemplateCatalogPage } from "@myoxus/core/modules/template-doc/view/catalog-page";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";

export const Component = () => {
  const t = useI18n();
  const title = t["com.myoxus.templates.library.title"]();
  return (
    <TemplateCatalogPage>
      {({ header, content, viewportBounded }) => (
        <>
          <ViewTitle title={title} />
          <ViewIcon icon="doc" />
          <ViewHeader>{header}</ViewHeader>
          <ViewBody viewportBounded={viewportBounded}>{content}</ViewBody>
        </>
      )}
    </TemplateCatalogPage>
  );
};
