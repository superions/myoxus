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

const feedbackLink: Record<NonNullable<Flag["feedbackType"]>, string> = {
  email: "mailto:myoxus@blume29.de",
  github: BUILD_CONFIG.githubUrl + "/issues",
};

const FeedbackIcon = ({ type }: { type: Flag["feedbackType"] }) => {
  switch (type) {
    case "email":
      return <EmailIcon size="var(--mantine-spacing-lg)" />;
    case "github":
      return <GithubIcon size="var(--mantine-spacing-lg)" />;
    default:
      return null;
  }
};

const FeedbackLink = ({
  link,
  type,
}: {
  link: string;
  type: NonNullable<Flag["feedbackType"]>;
}) => {
  const t = useI18n();

  return (
    <InlineLink
      href={link}
      target="_blank"
      rel="noreferrer"
      prefix={<FeedbackIcon type={type} />}
    >
      {t["com.myoxus.settings.experimental-feedback.discussion"]()}
      <ArrowRightSmallIcon size="var(--mantine-spacing-lg)" />
    </InlineLink>
  );
};

const DescriptionWithFeedback = ({
  description,
  link,
  type,
}: {
  description?: string;
  link?: string;
  type?: Flag["feedbackType"];
}) => {
  if (!description && !link) {
    return null;
  }

  return (
    <>
      {description ? <>{description} </> : null}
      {link && type ? <FeedbackLink link={link} type={type} /> : null}
    </>
  );
};

const ExperimentalFeaturesPrompt = ({
  onConfirm,
}: {
  onConfirm: () => void;
}) => {
  const t = useI18n();
  const [checked, setChecked] = useState(false);

  const onChange: (
    event: ChangeEvent<HTMLInputElement>,
    checked: boolean,
  ) => void = useCallback((_, checked) => {
    setChecked(checked);
  }, []);

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
              checked={checked}
              onChange={onChange}
              data-testid="experimental-prompt-disclaimer"
            />
          </SettingsRow>

          <DialogFooterActions>
            <Button
              disabled={!checked}
              onClick={onConfirm}
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

const ExperimentalFeaturesItem = ({
  flag,
  flagKey,
}: {
  flag: Flag;
  flagKey: string;
}) => {
  const value = useLiveData(flag.$);
  const t = useI18n();
  const onChange = useCallback(
    (checked: boolean) => {
      flag.set(checked);
    },
    [flag],
  );
  const link = flag.feedbackType
    ? flag.feedbackLink
      ? flag.feedbackLink
      : feedbackLink[flag.feedbackType]
    : undefined;
  const name = t[flag.displayName]();
  const description = flag.description ? t[flag.description]() : undefined;

  if (flag.configurable === false || flag.hide) {
    return null;
  }

  return (
    <SettingsRow
      name={name}
      desc={
        <DescriptionWithFeedback
          description={description}
          link={link}
          type={flag.feedbackType}
        />
      }
      testId={`experimental-feature-row-${flagKey}`}
    >
      <SettingsControlGroup>
        <MyoxusSwitch
          data-testid={flagKey}
          checked={value}
          onChange={onChange}
          aria-label={name}
        />
      </SettingsControlGroup>
    </SettingsRow>
  );
};

const ExperimentalFeaturesMain = () => {
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
          {Object.keys(MYOXUS_FLAGS).map((key) => (
            <ExperimentalFeaturesItem
              key={key}
              flagKey={key}
              flag={featureFlagService.flags[key as keyof MYOXUS_FLAGS]}
            />
          ))}
        </Stack>
      </SettingsSection>
    </SettingsPage>
  );
};

// TODO(@Peng): save to workspace meta instead?
const experimentalFeaturesDisclaimerAtom = atomWithStorage(
  "myoxus:experimental-features-disclaimer",
  false,
);

export const ExperimentalFeatures = () => {
  const [enabled, setEnabled] = useAtom(experimentalFeaturesDisclaimerAtom);
  const handleConfirm = useAsyncCallback(async () => {
    setEnabled(true);
  }, [setEnabled]);
  if (!enabled) {
    return <ExperimentalFeaturesPrompt onConfirm={handleConfirm} />;
  } else {
    return (
      <Suspense fallback={<Loading />}>
        <ExperimentalFeaturesMain />
      </Suspense>
    );
  }
};
