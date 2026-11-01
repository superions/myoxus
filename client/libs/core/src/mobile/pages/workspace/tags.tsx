// SPDX-License-Identifier: AGPL-3.0-or-later

import { TagCatalogPage } from "@myoxus/core/modules/tag/view/catalog-page";
import { useThemeColor } from "@myoxus/ui-facade";

import { Page } from "../../components/page";

export const Component = () => {
  useThemeColor("backgroundSecondaryColor");
  return (
    <TagCatalogPage compact>
      {({ header, content }) => (
        <Page header={header} tab>
          {content}
        </Page>
      )}
    </TagCatalogPage>
  );
};
