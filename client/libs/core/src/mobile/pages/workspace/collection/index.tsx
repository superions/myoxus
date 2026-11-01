import { useThemeColor } from "@myoxus/ui-facade";

import { AppTabs } from "../../../components";
import { AllDocsHeader, CollectionList } from "../../../views";

export const Component = () => {
  useThemeColor("backgroundSecondaryColor");
  return (
    <>
      <AllDocsHeader />
      <AppTabs />
      <CollectionList />
    </>
  );
};
