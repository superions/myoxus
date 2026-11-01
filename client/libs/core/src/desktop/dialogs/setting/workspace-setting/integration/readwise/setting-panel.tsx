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

export const ReadwiseSettingPanel = () => {
  const readwise = useService(IntegrationService).readwise;
  const settings = useLiveData(readwise.settings$);
  const token = settings?.token;

  return token ? <ReadwiseConnectedSetting /> : <ReadwiseNotConnectedSetting />;
};

const ReadwiseSettingHeader = ({ action }: { action?: ReactNode }) => {
  const t = useI18n();

  return (
    <IntegrationSettingHeader
      icon={<IntegrationTypeIcon type="readwise" />}
      name={t["com.myoxus.integration.readwise.name"]()}
      desc={t["com.myoxus.integration.readwise.desc"]()}
      action={action}
    />
  );
};

const ReadwiseNotConnectedSetting = () => {
  const readwise = useService(IntegrationService).readwise;

  const handleConnectSuccess = useCallback(
    (token: string) => {
      readwise.connect(token);
    },
    [readwise],
  );

  return (
    <Stack data-myoxus-ui-role="readwise-not-connected-panel">
      <ReadwiseSettingHeader
        action={
          <ReadwiseConnectButton
            onSuccess={handleConnectSuccess}
            prefix={<PlusIcon />}
            data-testid="readwise-connect-button"
          />
        }
      />
    </Stack>
  );
};
const ReadwiseConnectedSetting = () => {
  const [openImportDialog, setOpenImportDialog] = useState(false);

  const onImport = useCallback(() => {
    setOpenImportDialog(true);
  }, []);

  const closeImportDialog = useCallback(() => {
    setOpenImportDialog(false);
  }, []);

  return (
    <Stack data-myoxus-ui-role="readwise-connected-panel">
      <ReadwiseSettingHeader action={<ReadwiseDisconnectButton />} />
      <SurfaceList label="Readwise settings">
        <TagsSetting />
        <NewHighlightSetting />
        <UpdateStrategySetting />
        <StartImport onImport={onImport} />
      </SurfaceList>
      {openImportDialog && <ImportDialog onClose={closeImportDialog} />}
    </Stack>
  );
};

const trackModifySetting = (
  item: "New" | "Update" | "Tag",
  option: "on" | "off",
  method?: "append" | "override",
) => {
  readwiseTrack.modifyIntegrationSettings({
    item,
    option,
    method,
  });
};

const NewHighlightSetting = () => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const syncNewHighlights = useLiveData(
    useMemo(() => readwise.setting$("syncNewHighlights"), [readwise]),
  );

  const toggle = useCallback(
    (value: boolean) => {
      trackModifySetting("New", value ? "on" : "off");
      readwise.updateSetting("syncNewHighlights", value);
    },
    [readwise],
  );

  return (
    <IntegrationSettingToggle
      checked={!!syncNewHighlights}
      name={t["com.myoxus.integration.readwise.setting.sync-new-name"]()}
      desc={t["com.myoxus.integration.readwise.setting.sync-new-desc"]()}
      onChange={toggle}
    />
  );
};

const UpdateStrategySetting = () => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const updateStrategy = useLiveData(
    useMemo(() => readwise.setting$("updateStrategy"), [readwise]),
  );

  const toggle = useCallback(
    (value: boolean) => {
      trackModifySetting("Update", value ? "on" : "off", "append");
      if (!value) readwise.updateSetting("updateStrategy", undefined);
      else readwise.updateSetting("updateStrategy", "append");
    },
    [readwise],
  );

  const handleUpdate = useCallback(
    (value: ReadwiseConfig["updateStrategy"]) => {
      trackModifySetting("Update", "on", value);
      readwise.updateSetting("updateStrategy", value);
    },
    [readwise],
  );

  const strategies = useMemo(
    () =>
      [
        {
          name: t[
            "com.myoxus.integration.readwise.setting.update-append-name"
          ](),
          desc: t[
            "com.myoxus.integration.readwise.setting.update-append-desc"
          ](),
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
      ] satisfies IntegrationSettingTextRadioGroupItem[],
    [t],
  );

  return (
    <>
      <IntegrationSettingToggle
        checked={!!updateStrategy}
        name={t["com.myoxus.integration.readwise.setting.update-name"]()}
        desc={t["com.myoxus.integration.readwise.setting.update-desc"]()}
        onChange={toggle}
      />
      {updateStrategy ? (
        <SettingsField
          label={t["com.myoxus.integration.readwise.setting.update-strategy"]()}
        >
          <IntegrationSettingTextRadioGroup
            items={strategies}
            checked={updateStrategy}
            onChange={handleUpdate}
          />
        </SettingsField>
      ) : null}
    </>
  );
};

const StartImport = ({ onImport }: { onImport: () => void }) => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;

  const handleImport = useCallback(() => {
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
      <Button onClick={handleImport}>
        {t["com.myoxus.integration.readwise.setting.start-import-button"]()}
      </Button>
    </IntegrationSettingItem>
  );
};

const TagsSetting = () => {
  const t = useI18n();
  const readwise = useService(IntegrationService).readwise;
  const tagIds = useLiveData(
    useMemo(() => readwise.setting$("tags"), [readwise]),
  );

  const commit = useCallback(
    (nextIds: string[]) => {
      trackModifySetting(
        "Tag",
        nextIds.length >= (tagIds?.length ?? 0) ? "on" : "off",
      );
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
        commit={commit}
        modalMenu={true}
      />
    </SettingsField>
  );
};
