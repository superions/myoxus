/**
 * Organization policy route.
 *
 * Policy states are product choices, but the visible card grid, switch list and
 * save area are shared Facade surfaces. Keep policy semantics here and generic
 * spacing, typography and status chrome in the Facade.
 */
import { PolicyStateEnum } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ClipboardCheck, Lock, Sparkles } from "@myoxus/icons/react";
import {
  Badge,
  Button,
  notify,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SelectionCardGrid,
  SettingsControlList,
  SettingsListItemMeta,
  SettingsSection,
  SettingsStatusText,
  SettingsSwitchRow,
  SettingsToolbar,
  Stack,
} from "@myoxus/ui-facade";
import { type ComponentProps, type FC, useEffect, useState } from "react";

import {
  useOrganizationPolicyQuery,
  useUpdateOrganizationPolicyMutation,
} from "./api";

interface StateOption {
  value: PolicyStateEnum;
  tone: "error" | "warning" | "success";
  icon: FC<{ className?: string; strokeWidth?: number }>;
  titleKey: string;
  subKey: string;
}

const STATES: StateOption[] = [
  {
    value: PolicyStateEnum.Disabled,
    tone: "error",
    icon: Lock,
    titleKey: "admin.organization.policy.state.disabled",
    subKey: "admin.organization.policy.state.disabled.desc",
  },
  {
    value: PolicyStateEnum.RequiresApproval,
    tone: "warning",
    icon: ClipboardCheck,
    titleKey: "admin.organization.policy.state.requires_approval",
    subKey: "admin.organization.policy.state.requires_approval.desc",
  },
  {
    value: PolicyStateEnum.Allowed,
    tone: "success",
    icon: Sparkles,
    titleKey: "admin.organization.policy.state.allowed",
    subKey: "admin.organization.policy.state.allowed.desc",
  },
];

const POLICY_BADGE_TONE = {
  error: "error",
  warning: "warning",
  success: "success",
} as const satisfies Record<
  StateOption["tone"],
  ComponentProps<typeof Badge>["tone"]
>;

export function PolicyTab() {
  const i18n = useI18n();
  const { policy, mutate } = useOrganizationPolicyQuery();
  const update = useUpdateOrganizationPolicyMutation();

  const [rootState, setRootState] = useState<PolicyStateEnum>(
    PolicyStateEnum.Disabled,
  );
  const [unitState, setUnitState] = useState<PolicyStateEnum>(
    PolicyStateEnum.Disabled,
  );
  const [canCreateWs, setCanCreateWs] = useState(false);
  const [canManageOu, setCanManageOu] = useState(false);
  const [importExport, setImportExport] = useState(true);

  useEffect(() => {
    if (policy) {
      setRootState(policy.managerRootProjectCreation);
      setUnitState(policy.managerUnitProjectCreation);
      setCanCreateWs(policy.managerCanCreateWorkspaces);
      setCanManageOu(policy.managerCanManageOuMembers);
      setImportExport(policy.importExportEnabled);
    }
  }, [policy]);

  if (!policy) {
    return (
      <SettingsSection component="section">
        <SettingsStatusText>{i18n.t("admin.state.loading")}</SettingsStatusText>
      </SettingsSection>
    );
  }

  const dirty =
    rootState !== policy.managerRootProjectCreation ||
    unitState !== policy.managerUnitProjectCreation ||
    canCreateWs !== policy.managerCanCreateWorkspaces ||
    canManageOu !== policy.managerCanManageOuMembers ||
    importExport !== policy.importExportEnabled;

  return (
    <Stack>
      <Tableau
        i18n={i18n}
        title={i18n.t("admin.organization.policy.scope.root.title")}
        subtitle={i18n.t("admin.organization.policy.scope.root.desc")}
        value={rootState}
        onChange={setRootState}
      />

      <Tableau
        i18n={i18n}
        title={i18n.t("admin.organization.policy.scope.unit.title")}
        subtitle={i18n.t("admin.organization.policy.scope.unit.desc")}
        value={unitState}
        onChange={setUnitState}
      />

      <SettingsSection
        component="section"
        title={i18n.t("admin.organization.policy.flags.title")}
      >
        <SettingsControlList>
          <Toggle
            title={i18n.t("admin.organization.policy.can-create-ws")}
            subtitle={i18n.t("admin.organization.policy.can-create-ws.desc")}
            checked={canCreateWs}
            onChange={setCanCreateWs}
          />
          <Toggle
            title={i18n.t("admin.organization.policy.can-manage-ou")}
            subtitle={i18n.t("admin.organization.policy.can-manage-ou.desc")}
            checked={canManageOu}
            onChange={setCanManageOu}
          />
          <Toggle
            title={i18n.t("admin.organization.policy.import-export")}
            subtitle={i18n.t("admin.organization.policy.import-export.desc")}
            checked={importExport}
            onChange={setImportExport}
          />
        </SettingsControlList>
      </SettingsSection>

      <SettingsSection component="section">
        <SettingsToolbar justify="space-between">
          <SettingsStatusText
            tone={dirty ? "active" : "muted"}
            data-testid="organization-policy-save-state"
          >
            {dirty
              ? i18n.t("admin.organization.policy.dirty")
              : i18n.t("admin.organization.policy.clean")}
          </SettingsStatusText>
          <SettingsToolbar>
            <Button
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setRootState(policy.managerRootProjectCreation);
                setUnitState(policy.managerUnitProjectCreation);
                setCanCreateWs(policy.managerCanCreateWorkspaces);
                setCanManageOu(policy.managerCanManageOuMembers);
                setImportExport(policy.importExportEnabled);
              }}
            >
              {i18n.t("admin.actions.revert")}
            </Button>
            <Button
              disabled={!dirty || update.isMutating}
              data-testid="organization-policy-save-button"
              onClick={async () => {
                try {
                  await update.trigger({
                    input: {
                      managerRootProjectCreation: rootState,
                      managerUnitProjectCreation: unitState,
                      managerCanCreateWorkspaces: canCreateWs,
                      managerCanManageOuMembers: canManageOu,
                      importExportEnabled: importExport,
                    },
                  });
                  notify.success({
                    title: i18n.t("admin.organization.policy.saved"),
                  });
                  await mutate();
                } catch (e) {
                  notify.error({ title: String(e) });
                }
              }}
            >
              {i18n.t("admin.organization.policy.save")}
            </Button>
          </SettingsToolbar>
        </SettingsToolbar>
      </SettingsSection>
    </Stack>
  );
}

function Tableau({
  i18n,
  title,
  subtitle,
  value,
  onChange,
}: {
  i18n: ReturnType<typeof useI18n>;
  title: string;
  subtitle: string;
  value: PolicyStateEnum;
  onChange: (v: PolicyStateEnum) => void;
}) {
  return (
    <SettingsSection title={title} description={subtitle} component="section">
      <RadioCardGroup
        value={value}
        onChange={(nextValue) => onChange(nextValue as PolicyStateEnum)}
        aria-label={title}
      >
        <SelectionCardGrid columns={3}>
          {STATES.map((s) => {
            const active = value === s.value;
            return (
              <RadioCard
                key={s.value}
                value={s.value}
                data-active={active ? "true" : "false"}
                selected={active}
              >
                <Stack>
                  <SettingsToolbar justify="space-between">
                    <SettingsToolbar justify="flex-start">
                      <RadioCardIndicator />
                      <Badge tone={POLICY_BADGE_TONE[s.tone]}>
                        <span>
                          <s.icon strokeWidth={1.7} aria-hidden="true" />{" "}
                          {i18n.t(s.titleKey as never)}
                        </span>
                      </Badge>
                    </SettingsToolbar>
                    {active ? (
                      <Badge tone="info">
                        {i18n.t("admin.state.selected")}
                      </Badge>
                    ) : null}
                  </SettingsToolbar>
                  <SettingsListItemMeta>
                    {i18n.t(s.subKey as never)}
                  </SettingsListItemMeta>
                </Stack>
              </RadioCard>
            );
          })}
        </SelectionCardGrid>
      </RadioCardGroup>
    </SettingsSection>
  );
}

function Toggle({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SettingsSwitchRow
      label={title}
      description={subtitle}
      checked={checked}
      onChange={onChange}
      separated
    />
  );
}
