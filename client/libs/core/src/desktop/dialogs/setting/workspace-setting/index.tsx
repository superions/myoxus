import type { WorkspaceSettingTab } from "@myoxus/core/modules/dialogs/constant";
import { EmbeddingSettings } from "@myoxus/core/modules/workspace-indexer-embedding";
import { useI18n } from "@myoxus/i18n";
import {
  AiEmbeddingIcon,
  CollaborationIcon,
  ExportIcon,
  GroupingIcon,
  IntegrationsIcon,
  PageIcon,
  SaveIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import { useMemo } from "react";

import type { SettingSidebarItem } from "../types";
import { WorkspaceDocumentsSettings } from "./documents";
import { IntegrationSetting } from "./integration";
import { MembersPanel } from "./members";
import { WorkspaceOrganizationSettings } from "./organization";
import { WorkspacePdfExportSettings } from "./pdf-export";
import { WorkspaceSettingDetail } from "./preference";
import { WorkspaceSettingStorage } from "./storage";

export const WorkspaceSetting = ({
  activeTab,
  onCloseSetting,
}: {
  activeTab: WorkspaceSettingTab;
  onCloseSetting: () => void;
}) => {
  switch (activeTab) {
    case "workspace:preference":
      return <WorkspaceSettingDetail onCloseSetting={onCloseSetting} />;
    case "workspace:properties":
    case "workspace:documents":
      return <WorkspaceDocumentsSettings />;
    case "workspace:members":
      return <MembersPanel onCloseSetting={onCloseSetting} />;
    case "workspace:storage":
      return <WorkspaceSettingStorage onCloseSetting={onCloseSetting} />;
    case "workspace:integrations":
      return <IntegrationSetting />;
    case "workspace:embedding":
      return <EmbeddingSettings />;
    case "workspace:pdf-export":
      return <WorkspacePdfExportSettings />;
    case "workspace:organization":
      return <WorkspaceOrganizationSettings />;
    default:
      return null;
  }
};

export const useWorkspaceSettingList =
  (): SettingSidebarItem<WorkspaceSettingTab>[] => {
    const t = useI18n();

    const items = useMemo<SettingSidebarItem<WorkspaceSettingTab>[]>(() => {
      return [
        {
          key: "workspace:preference",
          title: t["com.myoxus.settings.workspace.preferences"](),
          icon: <SettingsIcon />,
          testId: "workspace-setting:preference",
        },
        {
          key: "workspace:documents",
          title: t["com.myoxus.settings.workspace.documents"](),
          icon: <PageIcon />,
          testId: "workspace-setting:documents",
        },
        {
          key: "workspace:members",
          title: t["Members"](),
          icon: <CollaborationIcon />,
          testId: "workspace-setting:members",
        },
        {
          key: "workspace:integrations",
          title: t["com.myoxus.integration.integrations"](),
          icon: <IntegrationsIcon />,
          testId: "workspace-setting:integrations",
        },
        {
          key: "workspace:storage",
          title: t["Storage"](),
          icon: <SaveIcon />,
          testId: "workspace-setting:storage",
        },
        {
          key: "workspace:pdf-export",
          title: t["com.myoxus.settings.workspace.pdf-export"](),
          icon: <ExportIcon />,
          testId: "workspace-setting:pdf-export",
        },
        {
          key: "workspace:embedding",
          title:
            t[
              "com.myoxus.settings.workspace.indexer-embedding.embedding.title"
            ](),
          icon: <AiEmbeddingIcon />,
          testId: "workspace-setting:embedding",
        },
        {
          key: "workspace:organization",
          title: t["com.myoxus.settings.workspace.organization.sidebar"](),
          icon: <GroupingIcon />,
          testId: "workspace-setting:organization",
        },
      ];
    }, [t]);

    return items;
  };
