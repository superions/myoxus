import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { ChevronRightIcon, ExternalLinkIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import {
  NavigationLink,
  SettingsControlList,
  SettingsPage,
  SettingsSection,
  ThemeIcon,
} from "../../primitives";
import { SubPageProvider, useSubPageIsland } from "../../sub-page";
import { getAllowedIntegrationList, type IntegrationItem } from "./constants";

export const IntegrationSetting = () => {
  const t = useI18n();
  const [opened, setOpened] = useState<string | null>(null);
  const workspaceService = useService(WorkspaceService);
  const isCloudWorkspace = workspaceService.workspace.flavour !== "local";

  const integrationList = useMemo(
    () => getAllowedIntegrationList(isCloudWorkspace),
    [isCloudWorkspace],
  );
  const openedItem = useMemo(
    () =>
      integrationList.find(
        (item): item is IntegrationItem & { setting: ReactNode } =>
          item.id === opened && "setting" in item && Boolean(item.setting),
      ),
    [integrationList, opened],
  );
  const handleIntegrationClick = useCallback((item: IntegrationItem) => {
    if ("setting" in item && item.setting) {
      setOpened(item.id);
    }
  }, []);

  return (
    <SettingsPage
      title={t["com.myoxus.integration.integrations"]()}
      subtitle={
        <>
          {t["com.myoxus.integration.setting.description"]()}
          {/* <br /> */}
          {/* <a>{t['Learn how to develop a integration for Myoxus']()}</a> */}
        </>
      }
    >
      <SettingsSection data-testid="workspace-integrations-panel">
        <SettingsControlList data-myoxus-ui-role="workspace-integrations-list">
          {integrationList.map((item) => {
            const title =
              typeof item.name === "string"
                ? t[item.name]()
                : t[item.name.i18nKey]();
            const description =
              typeof item.desc === "string"
                ? t[item.desc]()
                : t[item.desc.i18nKey]();
            const external = "link" in item;
            return (
              <NavigationLink
                key={item.id}
                component={external ? "a" : "button"}
                type={external ? undefined : "button"}
                href={external ? item.link : undefined}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
                label={title}
                description={description}
                leftSection={
                  <ThemeIcon variant="light" color="myoxus" size="lg">
                    {item.icon}
                  </ThemeIcon>
                }
                rightSection={
                  external ? <ExternalLinkIcon /> : <ChevronRightIcon />
                }
                onClick={
                  external ? undefined : () => handleIntegrationClick(item)
                }
                data-testid={`workspace-integration-card:${item.id}`}
                data-myoxus-ui-role="workspace-integration-link"
              />
            );
          })}
        </SettingsControlList>
      </SettingsSection>
      {openedItem ? (
        <IntegrationSettingPage open onClose={() => setOpened(null)}>
          {openedItem.setting}
        </IntegrationSettingPage>
      ) : null}
    </SettingsPage>
  );
};

const IntegrationSettingPage = ({
  children,
  open,
  onClose,
}: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) => {
  const t = useI18n();
  const island = useSubPageIsland();

  if (!island) {
    return null;
  }

  return (
    <SubPageProvider
      backText={t["com.myoxus.integration.integrations"]()}
      island={island}
      open={open}
      onClose={onClose}
    >
      {children}
    </SubPageProvider>
  );
};
