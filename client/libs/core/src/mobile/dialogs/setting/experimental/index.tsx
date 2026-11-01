import { ConfigModal } from "@myoxus/core/components/mobile";
import {
  FeatureFlagService,
  type Flag,
  MYOXUS_FLAGS,
} from "@myoxus/core/modules/feature-flag";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { SettingsField, SettingsFieldGroup, Switch } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { SettingGroup } from "../group";
import { RowLayout } from "../row.layout";

export const ExperimentalFeatureSetting = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SettingGroup title="Experimental">
        <RowLayout
          label={"Experimental Features"}
          onClick={() => setOpen(true)}
        >
          <ArrowRightSmallIcon aria-hidden />
        </RowLayout>
      </SettingGroup>
      <ConfigModal
        open={open}
        onOpenChange={setOpen}
        onBack={() => setOpen(false)}
        title="Experimental Features"
      >
        <ExperimentalFeatureList />
      </ConfigModal>
    </>
  );
};

const ExperimentalFeatureList = () => {
  const featureFlagService = useService(FeatureFlagService);

  return (
    <SettingsFieldGroup data-myoxus-ui-role="mobile-experimental-feature-list">
      {Object.keys(MYOXUS_FLAGS).map((key) => (
        <ExperimentalFeaturesItem
          key={key}
          flagKey={key}
          flag={featureFlagService.flags[key as keyof MYOXUS_FLAGS]}
        />
      ))}
    </SettingsFieldGroup>
  );
};

const ExperimentalFeaturesItem = ({
  flag,
  flagKey,
}: {
  flag: Flag;
  flagKey: string;
}) => {
  const t = useI18n();
  const value = useLiveData(flag.$);

  const onChange = useCallback(
    (checked: boolean) => {
      flag.set(checked);
    },
    [flag],
  );

  if (flag.configurable === false || flag.hide) {
    return null;
  }

  return (
    <SettingsField
      inline
      label={t[flag.displayName]()}
      description={flag.description ? t[flag.description]() : undefined}
      data-myoxus-ui-role="mobile-experimental-feature-row"
    >
      <Switch data-testid={flagKey} checked={value} onChange={onChange} />
    </SettingsField>
  );
};
