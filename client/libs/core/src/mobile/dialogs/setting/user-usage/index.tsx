import {
  AuthService,
  ServerService,
  UserCopilotQuotaService,
  UserQuotaService,
} from "@myoxus/core/modules/server";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Progress as FacadeProgress,
  SettingsStatusText,
  SettingsToolbar,
  Skeleton,
  Stack,
} from "@myoxus/ui-facade";
import { type ReactNode, useEffect } from "react";

import { SettingGroup } from "../group";

export const UserUsage = () => {
  const session = useService(AuthService).session;
  const loginStatus = useLiveData(session.status$);

  if (loginStatus !== "authenticated") {
    return null;
  }

  return <UsagePanel />;
};

const UsageProgress = ({
  name,
  percent,
  desc,
  color,
  tone = "default",
  ariaLabel,
}: {
  name: ReactNode;
  desc: ReactNode;
  percent: number;
  color?: string | null;
  tone?: "default" | "error" | "warning";
  ariaLabel: string;
}) => {
  return (
    <Stack data-myoxus-ui-role="mobile-user-usage-progress-meter">
      <SettingsToolbar
        layout="split"
        justify="space-between"
        data-myoxus-ui-role="mobile-user-usage-progress-labels"
      >
        <SettingsStatusText tone="active">{name}</SettingsStatusText>
        <SettingsStatusText>{desc}</SettingsStatusText>
      </SettingsToolbar>
      <FacadeProgress
        showValueLabel={false}
        value={percent}
        color={color ?? undefined}
        tone={tone}
        ariaLabel={ariaLabel}
      />
    </Stack>
  );
};

const Loading = () => {
  return (
    <Stack data-myoxus-ui-role="mobile-user-usage-progress-loading">
      <SettingsToolbar
        layout="split"
        justify="space-between"
        data-myoxus-ui-role="mobile-user-usage-progress-loading-labels"
      >
        <Skeleton variant="text" />
        <Skeleton variant="text" />
      </SettingsToolbar>
      <Skeleton
        variant="rectangular"
        data-myoxus-ui-role="mobile-user-usage-progress-loading-meter"
      />
    </Stack>
  );
};

const UsagePanel = () => {
  const serverService = useService(ServerService);
  const serverFeatures = useLiveData(serverService.server.features$);

  return (
    <SettingGroup title="Storage">
      <CloudUsage />
      {serverFeatures?.copilot ? <AiUsage /> : null}
    </SettingGroup>
  );
};

const CloudUsage = () => {
  const quota = useService(UserQuotaService).quota;

  const color = useLiveData(quota.color$);
  const usedFormatted = useLiveData(quota.usedFormatted$);
  const maxFormatted = useLiveData(quota.maxFormatted$);
  const percent = useLiveData(quota.percent$);

  useEffect(() => {
    // revalidate quota to get the latest status
    quota.revalidate();
  }, [quota]);

  const loading = percent === null;

  if (loading) return <Loading />;

  return (
    <UsageProgress
      name="Cloud"
      percent={percent}
      desc={`${usedFormatted}/${maxFormatted}`}
      color={color}
      ariaLabel="Cloud storage used"
    />
  );
};
const AiUsage = () => {
  const copilotQuotaService = useService(UserCopilotQuotaService);

  const copilotActionLimit = useLiveData(
    copilotQuotaService.copilotQuota.copilotActionLimit$,
  );
  const copilotActionUsed = useLiveData(
    copilotQuotaService.copilotQuota.copilotActionUsed$,
  );
  const loading = copilotActionLimit === null || copilotActionUsed === null;
  const loadError = useLiveData(copilotQuotaService.copilotQuota.error$);

  useEffect(() => {
    copilotQuotaService.copilotQuota.revalidate();
  }, [copilotQuotaService]);

  if (loading || loadError) {
    return <Loading />;
  }

  if (copilotActionLimit === "unlimited") {
    return null;
  }

  const percent = Math.min(
    100,
    Math.max(
      0.5,
      Number(((copilotActionUsed / copilotActionLimit) * 100).toFixed(4)),
    ),
  );

  return (
    <UsageProgress
      name="AI"
      percent={percent}
      desc={`${copilotActionUsed}/${copilotActionLimit}`}
      tone={percent > 80 ? "error" : "default"}
      ariaLabel="AI usage"
    />
  );
};
