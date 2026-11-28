// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceTagsInlineEditor } from "@myoxus/core/components/tags";
import {
  IntegrationService,
  IntegrationTypeIcon,
} from "@myoxus/core/modules/integration";
import type { ReadwiseConfig } from "@myoxus/core/modules/integration/type";
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import {
  Button,
  PlaceholderText,
  SettingsField,
  Stack,
  SurfaceList,
} from "../../../primitives";
import {
  IntegrationSettingHeader,
  IntegrationSettingItem,
  IntegrationSettingTextRadioGroup,
  type IntegrationSettingTextRadioGroupItem,
  IntegrationSettingToggle,
} from "../setting";
import { ReadwiseConnectButton } from "./connect";
import { ReadwiseDisconnectButton } from "./connected";
import { ImportDialog } from "./import-dialog";
import { readwiseTrack } from "./track";

function ReadwiseHeader({ action }: { action?: ReactNode }) {
  const t = useI18n();
  return (
    <IntegrationSettingHeader
      icon={<IntegrationTypeIcon type="readwise" />}
      name={t["com.myoxus.integration.readwise.name"]()}
      desc={t["com.myoxus.integration.readwise.desc"]()}
      action={action}
    />
  );
}

function TagsSetting() {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const tagIds = useLiveData(
    useMemo(() => readwise.setting$("tags"), [readwise]),
  );

  const handleCommit = useCallback(
    (nextIds: string[]) => {
      readwiseTrack.modifyIntegrationSettings({
        item: "Tag",
        option: nextIds.length >= (tagIds?.length ?? 0) ? "on" : "off",
      });
      readwise.updateSetting("tags", nextIds);
    },
    [readwise, tagIds?.length],
  );

  return (
    <SettingsField
      label={t["com.myoxus.integration.readwise.setting.tags-label"]()}
      data-myoxus-ui-role="readwise-tags-setting"
    >
      <WorkspaceTagsInlineEditor
        placeholder={
          <PlaceholderText>
            {t["com.myoxus.integration.readwise.setting.tags-placeholder"]()}
          </PlaceholderText>
        }
        tagMode="inline-tag"
        selectedTags={tagIds ?? []}
        commit={handleCommit}
        modalMenu
      />
    </SettingsField>
  );
}

function NewHighlightSetting() {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const syncNewHighlights = useLiveData(
    useMemo(() => readwise.setting$("syncNewHighlights"), [readwise]),
  );

  const handleToggle = useCallback(
    (checked: boolean) => {
      readwiseTrack.modifyIntegrationSettings({
        item: "New",
        option: checked ? "on" : "off",
      });
      readwise.updateSetting("syncNewHighlights", checked);
    },
    [readwise],
  );

  return (
    <IntegrationSettingToggle
      checked={Boolean(syncNewHighlights)}
      name={t["com.myoxus.integration.readwise.setting.sync-new-name"]()}
      desc={t["com.myoxus.integration.readwise.setting.sync-new-desc"]()}
      onChange={handleToggle}
    />
  );
}

function UpdateStrategySetting() {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const updateStrategy = useLiveData(
    useMemo(() => readwise.setting$("updateStrategy"), [readwise]),
  );

  const handleToggle = useCallback(
    (checked: boolean) => {
      readwiseTrack.modifyIntegrationSettings({
        item: "Update",
        option: checked ? "on" : "off",
        method: "append",
      });
      readwise.updateSetting("updateStrategy", checked ? "append" : undefined);
    },
    [readwise],
  );

  const handleSelectStrategy = useCallback(
    (strategy: ReadwiseConfig["updateStrategy"]) => {
      readwiseTrack.modifyIntegrationSettings({
        item: "Update",
        option: "on",
        method: strategy,
      });
      readwise.updateSetting("updateStrategy", strategy);
    },
    [readwise],
  );

  const strategies = useMemo<
    IntegrationSettingTextRadioGroupItem<
      NonNullable<ReadwiseConfig["updateStrategy"]>
    >[]
  >(
    () => [
      {
        name: t["com.myoxus.integration.readwise.setting.update-append-name"](),
        desc: t["com.myoxus.integration.readwise.setting.update-append-desc"](),
        value: "append",
      },
      {
        name: t[
          "com.myoxus.integration.readwise.setting.update-override-name"
        ](),
        desc: t[
          "com.myoxus.integration.readwise.setting.update-override-desc"
        ](),
        value: "override",
      },
    ],
    [t],
  );

  return (
    <>
      <IntegrationSettingToggle
        checked={Boolean(updateStrategy)}
        name={t["com.myoxus.integration.readwise.setting.update-name"]()}
        desc={t["com.myoxus.integration.readwise.setting.update-desc"]()}
        onChange={handleToggle}
      />
      {updateStrategy ? (
        <SettingsField
          label={t["com.myoxus.integration.readwise.setting.update-strategy"]()}
        >
          <IntegrationSettingTextRadioGroup
            items={strategies}
            checked={updateStrategy}
            onChange={handleSelectStrategy}
          />
        </SettingsField>
      ) : null}
    </>
  );
}

function StartImportRow({ onImport }: { onImport: () => void }) {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;

  const handleClick = useCallback(() => {
    const lastImportedAt = readwise.setting$("lastImportedAt").value;
    readwiseTrack.startIntegrationImport({
      method: lastImportedAt ? "withtimestamp" : "new",
      control: "Readwise settings",
    });
    onImport();
  }, [onImport, readwise]);

  return (
    <IntegrationSettingItem
      name={t["com.myoxus.integration.readwise.setting.start-import-name"]()}
      desc={t["com.myoxus.integration.readwise.setting.start-import-desc"]()}
    >
      <Button onClick={handleClick}>
        {t["com.myoxus.integration.readwise.setting.start-import-button"]()}
      </Button>
    </IntegrationSettingItem>
  );
}

export const ReadwiseSettingPanel = () => {
  const readwise = useService(IntegrationService).readwise;
  const token = useLiveData(readwise.settings$)?.token;
  const [importOpen, setImportOpen] = useState(false);

  if (!token) {
    return (
      <Stack data-myoxus-ui-role="readwise-not-connected-panel">
        <ReadwiseHeader
          action={
            <ReadwiseConnectButton
              onSuccess={(nextToken) => readwise.connect(nextToken)}
              prefix={<PlusIcon />}
              data-testid="readwise-connect-button"
            />
          }
        />
      </Stack>
    );
  }

  return (
    <Stack data-myoxus-ui-role="readwise-connected-panel">
      <ReadwiseHeader action={<ReadwiseDisconnectButton />} />
      <SurfaceList label="Readwise settings">
        <TagsSetting />
        <NewHighlightSetting />
        <UpdateStrategySetting />
        <StartImportRow onImport={() => setImportOpen(true)} />
      </SurfaceList>
      {importOpen ? (
        <ImportDialog onClose={() => setImportOpen(false)} />
      ) : null}
    </Stack>
  );
};
