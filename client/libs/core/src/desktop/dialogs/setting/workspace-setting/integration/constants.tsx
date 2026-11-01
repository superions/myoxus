import { IntegrationTypeIcon } from "@myoxus/core/modules/integration";
import type { I18nString } from "@myoxus/i18n";
import { GithubIcon, McpIcon } from "@myoxus/icons/react";
import type { ReactNode } from "react";

import { GitSyncSettingPanel } from "./git-sync/setting-panel";
import { McpServerSettingPanel } from "./mcp-server/setting-panel";
import { ReadwiseSettingPanel } from "./readwise/setting-panel";

type IntegrationDefinition = {
  id: string;
  name: I18nString;
  desc: I18nString;
  icon: ReactNode;
  cloud?: boolean;
} & (
  | {
      setting: ReactNode;
    }
  | {
      link: string;
    }
);

const INTEGRATION_LIST = [
  {
    id: "readwise" as const,
    name: "com.myoxus.integration.readwise.name",
    desc: "com.myoxus.integration.readwise.desc",
    icon: <IntegrationTypeIcon type="readwise" />,
    setting: <ReadwiseSettingPanel />,
  },
  {
    id: "git-sync" as const,
    name: "com.myoxus.integration.git-sync.name",
    desc: "com.myoxus.integration.git-sync.desc",
    icon: <GithubIcon />,
    setting: <GitSyncSettingPanel />,
  },
  {
    id: "mcp-server" as const,
    name: "com.myoxus.integration.mcp-server.name",
    desc: "com.myoxus.integration.mcp-server.desc",
    icon: <McpIcon aria-hidden="true" />,
    setting: <McpServerSettingPanel />,
    cloud: true,
  },
] satisfies (IntegrationDefinition | false)[];

type IntegrationId = Exclude<
  Extract<(typeof INTEGRATION_LIST)[number], {}>,
  false
>["id"];

export type IntegrationItem = Exclude<IntegrationDefinition, "id"> & {
  id: IntegrationId;
};

export function getAllowedIntegrationList(isCloudWorkspace: boolean) {
  return INTEGRATION_LIST.filter((item) => {
    if (!item) return false;
    const requiredCloud = "cloud" in item && item.cloud;
    if (requiredCloud && !isCloudWorkspace) return false;
    return true;
  }) as IntegrationItem[];
}
