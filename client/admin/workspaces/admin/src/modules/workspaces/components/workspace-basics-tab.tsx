// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Workspace identity, capabilities and lifecycle actions.
 *
 * The parent panel owns data loading and mutations. This component only
 * composes the established settings roles so the master-data tab does not
 * rebuild card and toolbar chrome locally.
 */
import type { FeatureType } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Divider,
  Input,
  SettingsControlList,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsRow,
  SettingsSection,
  SettingsSectionHeading,
  SettingsSwitchRow,
  SimpleGrid,
  Stack,
} from "@myoxus/ui-facade";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import { FeatureToggleList } from "../../../components/shared/feature-toggle-list";
import { formatAdminDateTime } from "../../../utils/locale-format";
import type { WorkspaceDetail } from "../schema";
import { formatBytes } from "../utils";

export type WorkspaceFlagsState = {
  public: boolean;
  enableAi: boolean;
  enableSharing: boolean;
  enableUrlPreview: boolean;
  enableDocEmbedding: boolean;
  name: string;
};

export function WorkspaceBasicsTab({
  workspace,
  flags,
  setFlags,
  featureSelection,
  availableFeatures,
  onFeaturesChange,
  onReindex,
  onDelete,
  templates,
}: {
  workspace: WorkspaceDetail;
  flags: WorkspaceFlagsState;
  setFlags: Dispatch<SetStateAction<WorkspaceFlagsState>>;
  featureSelection: FeatureType[];
  availableFeatures: FeatureType[];
  onFeaturesChange: (features: FeatureType[]) => void;
  onReindex: () => void;
  onDelete: () => void;
  templates?: ReactNode;
}) {
  const i18n = useI18n();
  const owner =
    workspace.ownerPrincipalName ??
    workspace.owner?.email ??
    i18n.t("admin.workspaces.list.no-owner");

  return (
    <Stack data-testid="workspace-basics-content">
      <Stack data-testid="workspace-basics-details">
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.common.details")}
        </SettingsSectionHeading>
        <Input
          label={i18n.t("admin.common.name")}
          value={flags.name}
          onChange={(value) => setFlags((prev) => ({ ...prev, name: value }))}
          placeholder={i18n.t("admin.workspaces.panel.name-placeholder")}
        />
        <SimpleGrid cols={2}>
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.columns.owner")}
            >
              {owner}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.list.created")}
            >
              {formatAdminDateTime(i18n.language, workspace.createdAt)}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.metrics.members")}
            >
              {workspace.memberCount}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.metrics.shared-pages")}
            >
              {workspace.publicPageCount}
            </SettingsDefinitionItem>
          </SettingsDefinitionList>
          <SettingsDefinitionList>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.metrics.snapshot-size")}
            >
              {formatBytes(workspace.snapshotSize)}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.metrics.snapshot-count")}
            >
              {workspace.snapshotCount}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.metrics.blob-size")}
            >
              {formatBytes(workspace.blobSize)}
            </SettingsDefinitionItem>
            <SettingsDefinitionItem
              label={i18n.t("admin.workspaces.metrics.blob-count")}
            >
              {workspace.blobCount}
            </SettingsDefinitionItem>
          </SettingsDefinitionList>
        </SimpleGrid>
      </Stack>

      <Divider space="none" />

      <Stack data-testid="workspace-basics-features">
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.workspaces.panel.features")}
        </SettingsSectionHeading>
        <SettingsControlList>
          <SettingsSwitchRow
            label={i18n.t("admin.workspaces.flags.public")}
            description={i18n.t("admin.workspaces.flags.public-desc")}
            checked={flags.public}
            separated
            onCheckedChange={(value) =>
              setFlags((prev) => ({ ...prev, public: value }))
            }
          />
          <SettingsSwitchRow
            label={i18n.t("admin.workspaces.flags.enable-ai")}
            description={i18n.t("admin.workspaces.flags.enable-ai-desc")}
            checked={flags.enableAi}
            separated
            onCheckedChange={(value) =>
              setFlags((prev) => ({ ...prev, enableAi: value }))
            }
          />
          <SettingsSwitchRow
            label={i18n.t("admin.workspaces.flags.enable-url-preview")}
            description={i18n.t(
              "admin.workspaces.flags.enable-url-preview-desc",
            )}
            checked={flags.enableUrlPreview}
            separated
            onCheckedChange={(value) =>
              setFlags((prev) => ({ ...prev, enableUrlPreview: value }))
            }
          />
          <SettingsSwitchRow
            label={i18n.t("admin.workspaces.flags.enable-sharing")}
            description={i18n.t("admin.workspaces.flags.enable-sharing-desc")}
            checked={flags.enableSharing}
            separated
            onCheckedChange={(value) =>
              setFlags((prev) => ({ ...prev, enableSharing: value }))
            }
          />
          <SettingsSwitchRow
            label={i18n.t("admin.workspaces.flags.enable-doc-embedding")}
            description={i18n.t(
              "admin.workspaces.flags.enable-doc-embedding-desc",
            )}
            checked={flags.enableDocEmbedding}
            onCheckedChange={(value) =>
              setFlags((prev) => ({ ...prev, enableDocEmbedding: value }))
            }
          />
        </SettingsControlList>
        {availableFeatures.length > 0 ? (
          <>
            <Divider space="none" />
            <FeatureToggleList
              features={availableFeatures}
              selected={featureSelection.filter((feature) =>
                availableFeatures.includes(feature),
              )}
              onChange={onFeaturesChange}
            />
          </>
        ) : null}
      </Stack>

      {templates}

      <Divider />
      <Stack>
        <SettingsSectionHeading level={3}>
          {i18n.t("admin.workspace.maintenance")}
        </SettingsSectionHeading>
        <SettingsRow
          name={i18n.t("admin.workspace.reindex")}
          desc={i18n.t("admin.workspace.reindex-desc")}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={onReindex}
            data-testid="workspace-reindex-btn"
          >
            {i18n.t("admin.workspace.reindex")}
          </Button>
        </SettingsRow>
      </Stack>

      <SettingsSection title={i18n.t("admin.workspace.danger-zone")} danger>
        <SettingsRow
          name={i18n.t("admin.workspace.delete")}
          desc={i18n.t("admin.workspace.delete-confirm-desc")}
        >
          <Button
            type="button"
            variant="error"
            onClick={onDelete}
            data-testid="workspace-delete-btn"
          >
            {i18n.t("admin.workspace.delete")}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </Stack>
  );
}
