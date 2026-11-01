/**
 * Organization project-request inbox.
 *
 * The row layout uses Facade surfaces and status primitives so approval
 * workflow chrome stays visually aligned with the rest of Admin. Domain code
 * owns request decisions only; it must not recreate local inbox/card styling.
 */
import {
  ProjectRequestScopeEnum,
  ProjectRequestStatusEnum,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Badge,
  Button,
  notify,
  SettingsEmptyState,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsToolbar,
  Stack,
  StatusDot,
  SurfaceList,
  SurfaceListItem,
} from "@myoxus/ui-facade";

import {
  formatAdminDate,
  formatAdminDateTime,
} from "../../utils/locale-format";
import {
  useDecideOrganizationProjectRequestMutation,
  useOrganizationProjectRequestsQuery,
} from "./api";

type StatusTone = "neutral" | "success" | "warning" | "error" | "info";

const STATUS: Record<
  ProjectRequestStatusEnum,
  { tone: StatusTone; labelKey: string }
> = {
  [ProjectRequestStatusEnum.Pending]: {
    tone: "warning",
    labelKey: "admin.organization.requests.pending",
  },
  [ProjectRequestStatusEnum.Approved]: {
    tone: "success",
    labelKey: "admin.organization.requests.approved",
  },
  [ProjectRequestStatusEnum.Rejected]: {
    tone: "error",
    labelKey: "admin.organization.requests.rejected",
  },
  [ProjectRequestStatusEnum.Cancelled]: {
    tone: "neutral",
    labelKey: "admin.organization.requests.cancelled",
  },
};

const SCOPE_LABEL_KEYS: Record<ProjectRequestScopeEnum, string> = {
  [ProjectRequestScopeEnum.OrganizationRoot]:
    "admin.organization.requests.scope.organization-root",
  [ProjectRequestScopeEnum.Ou]: "admin.organization.requests.scope.ou",
};

export function ProjectRequestsTab() {
  const i18n = useI18n();
  const { requests, mutate } = useOrganizationProjectRequestsQuery();
  const decide = useDecideOrganizationProjectRequestMutation();

  const decideRequest = async (
    id: string,
    newStatus: ProjectRequestStatusEnum,
    toastKey: "approved" | "rejected",
  ) => {
    try {
      await decide.trigger({ id, newStatus });
      notify.success({
        title: i18n.t(`admin.organization.requests.${toastKey}` as never),
      });
      await mutate();
    } catch (e) {
      notify.error({ title: String(e) });
    }
  };

  return requests.length === 0 ? (
    <SettingsEmptyState
      title={i18n.t("admin.organization.requests.empty-title")}
      description={i18n.t("admin.organization.requests.empty-hint")}
    />
  ) : (
    <SurfaceList label={i18n.t("admin.organization.tab.requests")}>
      {requests.map((req) => {
        const meta =
          STATUS[req.status] ?? STATUS[ProjectRequestStatusEnum.Pending];
        const isPending = req.status === ProjectRequestStatusEnum.Pending;
        return (
          <SurfaceListItem key={req.id}>
            <SettingsToolbar justify="space-between" align="flex-start">
              <Stack>
                <SettingsToolbar justify="flex-start">
                  <StatusDot tone={toneToStatus(meta.tone)} />
                  <Badge tone={toneToStatus(meta.tone)}>
                    {i18n.t(meta.labelKey)}
                  </Badge>
                  <SettingsListItemMeta>
                    {formatAdminDateTime(i18n.language, req.createdAt)}
                  </SettingsListItemMeta>
                  <Badge>{i18n.t(SCOPE_LABEL_KEYS[req.requestedScope])}</Badge>
                </SettingsToolbar>
                <SettingsListItemTitle>
                  {req.proposedName}
                </SettingsListItemTitle>
                <SettingsListItemMeta>
                  {i18n.t("admin.organization.requests.requested-by")}{" "}
                  {req.requestedBy.slice(0, 8)}…
                  {req.parentUnitId
                    ? ` · ${i18n.t(
                        "admin.organization.requests.under",
                      )} ${req.parentUnitId.slice(0, 8)}…`
                    : ""}
                </SettingsListItemMeta>
              </Stack>

              {isPending ? (
                <SettingsToolbar>
                  <Button
                    disabled={decide.isMutating}
                    onClick={() =>
                      decideRequest(
                        req.id,
                        ProjectRequestStatusEnum.Approved,
                        "approved",
                      )
                    }
                  >
                    {i18n.t("admin.organization.requests.approve")}
                  </Button>
                  <Button
                    variant="error"
                    disabled={decide.isMutating}
                    onClick={() =>
                      decideRequest(
                        req.id,
                        ProjectRequestStatusEnum.Rejected,
                        "rejected",
                      )
                    }
                  >
                    {i18n.t("admin.organization.requests.reject")}
                  </Button>
                </SettingsToolbar>
              ) : (
                <SettingsListItemMeta>
                  {req.decidedAt
                    ? i18n.t("admin.organization.requests.decided-at", {
                        date: formatAdminDate(i18n.language, req.decidedAt),
                      })
                    : "—"}
                </SettingsListItemMeta>
              )}
            </SettingsToolbar>
          </SurfaceListItem>
        );
      })}
    </SurfaceList>
  );
}

function toneToStatus(tone: StatusTone): StatusTone {
  return tone;
}
