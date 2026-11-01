import {
  BrandAssetImage,
  Button,
  OnboardingActions,
  OnboardingChip,
  OnboardingDescription,
  OnboardingFooter,
  OnboardingFormBody,
  OnboardingFormCard,
  OnboardingLogoSlot,
  OnboardingMain,
  OnboardingProgressBars,
  OnboardingProgressItem,
  OnboardingProgressList,
  OnboardingRule,
  OnboardingShell,
  OnboardingSideCard,
  OnboardingSideCopy,
  OnboardingStep,
  OnboardingStepContent,
  OnboardingStepHeader,
  OnboardingTitle,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useState } from "react";

interface OnboardingProps {
  onOpenApp?: () => void;
}

const onboardingSteps = [
  {
    description:
      "Collect notes, links and structured work in one workspace instead of scattering context across disconnected tools.",
    detail:
      "Myoxus pages can start as simple writing surfaces and grow into richer workspace material when the work demands it.",
    kicker: "Capture",
    progressLabel: "Capture knowledge in one place",
    title: "Bring your workspace material together",
  },
  {
    description:
      "Use documents, whiteboards and databases as connected views of the same workspace knowledge.",
    detail:
      "The editor keeps the page at the center while surrounding project structure stays close enough to navigate without leaving flow.",
    kicker: "Structure",
    progressLabel: "Structure documents and workspace context",
    title: "Move from writing to structure without switching products",
  },
  {
    description:
      "Review recent work, daily context and workspace changes with shared navigation and consistent controls.",
    detail:
      "The same Myoxus design system is used across onboarding, setup and workspace chrome so the first-run flow matches the application.",
    kicker: "Review",
    progressLabel: "Review work with consistent workspace chrome",
    title: "Keep orientation as the workspace grows",
  },
  {
    description:
      "Open Myoxus and continue in the real workspace UI when the short tour is complete.",
    detail:
      "The onboarding screen intentionally uses existing Facade primitives rather than a custom local animation stack, so it follows theme, typography and responsive behavior automatically.",
    kicker: "Start",
    progressLabel: "Open the workspace",
    title: "Start with the workspace itself",
  },
] as const;

export const Onboarding = ({ onOpenApp }: OnboardingProps) => {
  const [current, setCurrent] = useState(0);
  const step = onboardingSteps[current];
  const isFirst = current === 0;
  const isLast = current === onboardingSteps.length - 1;
  const currentLabel = `Step ${current + 1} of ${onboardingSteps.length}`;

  const handleBack = useCallback(() => {
    setCurrent((value) => Math.max(value - 1, 0));
  }, []);

  const handleNext = useCallback(() => {
    setCurrent((value) => Math.min(value + 1, onboardingSteps.length - 1));
  }, []);

  const handleOpenApp = useCallback(() => {
    if (onOpenApp) {
      onOpenApp();
      return;
    }
    globalThis.location?.assign("/");
  }, [onOpenApp]);

  const sideProgress = useMemo(
    () =>
      onboardingSteps.map((item, index) => (
        <OnboardingProgressItem
          key={item.kicker}
          marker={index + 1}
          active={index === current}
          complete={index < current}
        >
          {item.progressLabel}
        </OnboardingProgressItem>
      )),
    [current],
  );

  /*
   * This screen used to own a bespoke paper/canvas animation stack. Keep the
   * first-run experience on existing onboarding Facade primitives so future
   * product changes inherit Mantine theming instead of rebuilding local CSS.
   */
  return (
    <OnboardingMain>
      <OnboardingShell>
        <OnboardingSideCard>
          <OnboardingLogoSlot>
            <BrandAssetImage
              slot="productMark"
              alt="Myoxus Product Mark"
              fallback={<OnboardingChip>Myoxus</OnboardingChip>}
            />
          </OnboardingLogoSlot>
          <OnboardingRule />
          <OnboardingSideCopy>
            <OnboardingTitle>Workspace-first knowledge work</OnboardingTitle>
            <OnboardingDescription>
              A short first-run tour that uses the same Myoxus UI system as the
              application itself.
            </OnboardingDescription>
          </OnboardingSideCopy>
          <OnboardingProgressList label="Onboarding progress">
            {sideProgress}
          </OnboardingProgressList>
        </OnboardingSideCard>

        <OnboardingFormCard>
          <OnboardingFormBody>
            <OnboardingStep data-myoxus-ui-role="electron-onboarding-step">
              <OnboardingChip>{step.kicker}</OnboardingChip>
              <OnboardingStepHeader>
                <OnboardingTitle variant="hero">{step.title}</OnboardingTitle>
                <OnboardingDescription variant="hero">
                  {step.description}
                </OnboardingDescription>
              </OnboardingStepHeader>
              <OnboardingStepContent>
                <OnboardingDescription>{step.detail}</OnboardingDescription>
              </OnboardingStepContent>
            </OnboardingStep>
          </OnboardingFormBody>

          <OnboardingFooter bordered>
            <OnboardingProgressBars
              count={onboardingSteps.length}
              current={current}
              label={currentLabel}
            />
            <OnboardingActions data-myoxus-ui-role="electron-onboarding-actions">
              {!isFirst ? (
                <Button type="button" variant="secondary" onClick={handleBack}>
                  Back
                </Button>
              ) : null}
              <Button
                type="button"
                variant="primary"
                onClick={isLast ? handleOpenApp : handleNext}
              >
                {isLast ? "Open Myoxus" : "Next"}
              </Button>
            </OnboardingActions>
          </OnboardingFooter>
        </OnboardingFormCard>
      </OnboardingShell>
    </OnboardingMain>
  );
};
