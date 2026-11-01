import { SafeArea, useThemeColor } from "@myoxus/ui-facade";

import { AppTabs } from "../../components";
import {
  StructureTreeCollections,
  StructureTreeFavorites,
  StructureTreeOrganize,
} from "../../components/navigation";
import { HomeHeader, RecentDocs } from "../../views";

export const Component = () => {
  useThemeColor("backgroundSecondaryColor");

  return (
    <>
      <HomeHeader />
      <RecentDocs />
      <SafeArea bottom>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 32,
            padding: "0 8px 32px 8px",
          }}
        >
          <StructureTreeFavorites />
          <StructureTreeOrganize />
          <StructureTreeCollections />
        </div>
      </SafeArea>
      <AppTabs />
    </>
  );
};
