// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { ChevronRightIcon, ExternalLinkIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { type ReactNode, useMemo, useState } from "react";

import {
  NavigationLink,
  SettingsControlList,
  SettingsPage,
  SettingsSection,
  ThemeIcon,
} from "../../primitives";
import { SubPageProvider } from "../../sub-page";
import { getAllowedIntegrationList, type IntegrationItem } from "./constants";

export const IntegrationSetting = () => {
  const t = useI18n();
  const [activeId, setActiveId] = useState<string | null>(null);
  const isCloudWorkspace =
    useService(WorkspaceService).workspace.flavour !== "local";

  const integrations = useMemo(
    () => getAllowedIntegrationList(isCloudWorkspace),
    [isCloudWorkspace],
  );

  const activeItem = useMemo(
    () =>
      integrations.find(
        (item): item is IntegrationItem & { setting: ReactNode } =>
          item.id === activeId && "setting" in item && Boolean(item.setting),
      ),
    [activeId, integrations],
  );

  return (
    <SettingsPage
      title={t["com.myoxus.integration.integrations"]()}
      subtitle={t["com.myoxus.integration.setting.description"]()}
    >
      <SettingsSection data-testid="workspace-integrations-panel">
        <SettingsControlList data-myoxus-ui-role="workspace-integrations-list">
          {integrations.map((item) => {
            const label =
              typeof item.name === "string"
                ? t[item.name]()
                : t[item.name.i18nKey]();
            const description =
              typeof item.desc === "string"
                ? t[item.desc]()
                : t[item.desc.i18nKey]();
            const externalLink =
              "link" in item && typeof item.link === "string"
                ? item.link
                : undefined;
            const isExternal = Boolean(externalLink);

            return (
              <NavigationLink
                key={item.id}
                component={isExternal ? "a" : "button"}
                type={isExternal ? undefined : "button"}
                href={externalLink}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noreferrer" : undefined}
                label={label}
                description={description}
                leftSection={
                  <ThemeIcon variant="light" color="myoxus" size="lg">
                    {item.icon}
                  </ThemeIcon>
                }
                rightSection={
                  isExternal ? <ExternalLinkIcon /> : <ChevronRightIcon />
                }
                onClick={isExternal ? undefined : () => setActiveId(item.id)}
                data-testid={`workspace-integration-card:${item.id}`}
                data-myoxus-ui-role="workspace-integration-link"
              />
            );
          })}
        </SettingsControlList>
      </SettingsSection>

      {activeItem ? (
        <SubPageProvider
          backText={t["com.myoxus.integration.integrations"]()}
          open
          onClose={() => setActiveId(null)}
        >
          {activeItem.setting}
        </SubPageProvider>
      ) : null}
    </SettingsPage>
  );
};
