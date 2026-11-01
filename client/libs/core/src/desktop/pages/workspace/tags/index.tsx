// SPDX-License-Identifier: AGPL-3.0-or-later

import { TagCatalogPage } from "@myoxus/core/modules/tag/view/catalog-page";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
} from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";

export const Component = () => {
  const t = useI18n();
  return (
    <TagCatalogPage compact={false}>
      {({ header, content }) => (
        <>
          <ViewTitle title={t["Tags"]()} />
          <ViewIcon icon="tag" />
          <ViewHeader>{header}</ViewHeader>
          <ViewBody>{content}</ViewBody>
        </>
      )}
    </TagCatalogPage>
  );
};
