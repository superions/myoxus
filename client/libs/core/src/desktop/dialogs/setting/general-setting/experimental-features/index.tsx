// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import {
  FeatureFlagService,
  type Flag,
  MYOXUS_FLAGS,
} from "@myoxus/core/modules/feature-flag";
import { useI18n } from "@myoxus/i18n";
import {
  ArrowRightSmallIcon,
  EmailIcon,
  GithubIcon,
} from "@myoxus/icons/react";
import { useLiveData, useServices } from "@myoxus/infra";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { type ChangeEvent, Suspense, useCallback, useState } from "react";

import {
  Button,
  Checkbox,
  DialogFooterActions,
  InlineLink,
  Loading,
  MyoxusSwitch,
  SettingsControlGroup,
  SettingsNotice,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  Stack,
} from "../../primitives";

const DEFAULT_FEEDBACK_URLS: Record<
  NonNullable<Flag["feedbackType"]>,
  string
> = {
  email: "mailto:myoxus@blume29.de",
  github: `${BUILD_CONFIG.githubUrl}/issues`,
};

const experimentalDisclaimerAtom = atomWithStorage(
  "myoxus:experimental-features-disclaimer",
  false,
);

const FeedbackChannelIcon = ({ type }: { type: Flag["feedbackType"] }) => {
  if (type === "email") {
    return <EmailIcon size="var(--mantine-spacing-lg)" />;
  }
  if (type === "github") {
    return <GithubIcon size="var(--mantine-spacing-lg)" />;
  }
  return null;
};

const FlagDescription = ({
  description,
  feedbackUrl,
  feedbackType,
}: {
  description?: string;
  feedbackUrl?: string;
  feedbackType?: Flag["feedbackType"];
}) => {
  const t = useI18n();
  if (!description && !feedbackUrl) {
    return null;
  }

  return (
    <>
      {description ? <>{description} </> : null}
      {feedbackUrl && feedbackType ? (
        <InlineLink
          href={feedbackUrl}
          target="_blank"
          rel="noreferrer"
          prefix={<FeedbackChannelIcon type={feedbackType} />}
        >
          {t["com.myoxus.settings.experimental-feedback.discussion"]()}
          <ArrowRightSmallIcon size="var(--mantine-spacing-lg)" />
        </InlineLink>
      ) : null}
    </>
  );
};

const ExperimentalDisclaimerGate = ({ onAccept }: { onAccept: () => void }) => {
  const t = useI18n();
  const [acknowledged, setAcknowledged] = useState(false);

  const handleAcknowledgeChange = useCallback(
    (_event: ChangeEvent<HTMLInputElement>, checked: boolean) => {
      setAcknowledged(checked);
    },
    [],
  );

  return (
    <SettingsPage
      title={t[
        "com.myoxus.settings.workspace.experimental-features.header.plugins"
      ]()}
      subtitle={t[
        "com.myoxus.settings.workspace.experimental-features.header.subtitle"
      ]()}
      testId="settings-page-experimental"
    >
      <SettingsSection>
        <Stack data-testid="experimental-prompt">
          <SettingsNotice
            tone="warning"
            title={t[
              "com.myoxus.settings.workspace.experimental-features.prompt-warning-title"
            ]()}
          >
            {t[
              "com.myoxus.settings.workspace.experimental-features.prompt-warning"
            ]()}
          </SettingsNotice>

          <SettingsRow
            name={t[
              "com.myoxus.settings.workspace.experimental-features.prompt-disclaimer"
            ]()}
            spreadCol={false}
            testId="experimental-prompt-disclaimer-row"
          >
            <Checkbox
              checked={acknowledged}
              onChange={handleAcknowledgeChange}
              data-testid="experimental-prompt-disclaimer"
            />
          </SettingsRow>

          <DialogFooterActions>
            <Button
              disabled={!acknowledged}
              onClick={onAccept}
              variant="primary"
              data-testid="experimental-confirm-button"
            >
              {t[
                "com.myoxus.settings.workspace.experimental-features.get-started"
              ]()}
            </Button>
          </DialogFooterActions>
        </Stack>
      </SettingsSection>
    </SettingsPage>
  );
};

const FeatureFlagRow = ({ flag, flagKey }: { flag: Flag; flagKey: string }) => {
  const t = useI18n();
  const enabled = useLiveData(flag.$);

  const handleToggle = useCallback(
    (checked: boolean) => {
      flag.set(checked);
    },
    [flag],
  );

  if (flag.configurable === false || flag.hide) {
    return null;
  }

  const label = t[flag.displayName]();
  const description = flag.description ? t[flag.description]() : undefined;
  const feedbackUrl = flag.feedbackType
    ? (flag.feedbackLink ?? DEFAULT_FEEDBACK_URLS[flag.feedbackType])
    : undefined;

  return (
    <SettingsRow
      name={label}
      desc={
        <FlagDescription
          description={description}
          feedbackUrl={feedbackUrl}
          feedbackType={flag.feedbackType}
        />
      }
      testId={`experimental-feature-row-${flagKey}`}
    >
      <SettingsControlGroup>
        <MyoxusSwitch
          data-testid={flagKey}
          checked={enabled}
          onChange={handleToggle}
          aria-label={label}
        />
      </SettingsControlGroup>
    </SettingsRow>
  );
};

const ExperimentalFlagsList = () => {
  const t = useI18n();
  const { featureFlagService } = useServices({ FeatureFlagService });

  return (
    <SettingsPage
      title={t[
        "com.myoxus.settings.workspace.experimental-features.header.plugins"
      ]()}
      subtitle={t[
        "com.myoxus.settings.workspace.experimental-features.header.subtitle"
      ]()}
      testId="settings-page-experimental"
    >
      <SettingsSection
        title={t[
          "com.myoxus.settings.workspace.experimental-features.header.plugins"
        ]()}
      >
        <Stack gap="xs" data-testid="experimental-settings">
          {Object.keys(MYOXUS_FLAGS).map((flagKey) => (
            <FeatureFlagRow
              key={flagKey}
              flagKey={flagKey}
              flag={featureFlagService.flags[flagKey as keyof MYOXUS_FLAGS]}
            />
          ))}
        </Stack>
      </SettingsSection>
    </SettingsPage>
  );
};

export const ExperimentalFeatures = () => {
  const [accepted, setAccepted] = useAtom(experimentalDisclaimerAtom);
  const handleAccept = useAsyncCallback(async () => {
    setAccepted(true);
  }, [setAccepted]);

  if (!accepted) {
    return <ExperimentalDisclaimerGate onAccept={handleAccept} />;
  }

  return (
    <Suspense fallback={<Loading />}>
      <ExperimentalFlagsList />
    </Suspense>
  );
};
