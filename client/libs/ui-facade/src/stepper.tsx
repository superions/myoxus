// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type ReactNode,
  type ReactElement,
  isValidElement,
  Children,
} from "react";
import {
  Stepper as MantineStepper,
  VisuallyHidden as MantineVisuallyHidden,
} from "@mantine/core";

type StepperOrientation = "horizontal" | "vertical";

type StepperStepProps = PropsWithChildren<{
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  completedIcon?: ReactNode;
  disabled?: boolean;
}>;

function isStepperStepElement(
  child: ReactNode,
): child is ReactElement<StepperStepProps> {
  return isValidElement(child) && child.type === StepperStep;
}

export function StepperStep({
  children,
  completedIcon,
  description,
  disabled,
  icon,
  label,
}: StepperStepProps) {
  void children;
  void completedIcon;
  void description;
  void disabled;
  void icon;
  void label;
  // Compound facade marker. Stepper reads the props and renders Mantine
  // Stepper.Step so product code never imports Mantine directly.
  return null;
}

export function Stepper({
  active,
  ariaLabel,
  children,
  compact = false,
  hideLabels = false,
  interactive = false,
  onStepChange,
  orientation = "horizontal",
  uiRole = "stepper",
}: PropsWithChildren<{
  active: number;
  ariaLabel: string;
  compact?: boolean;
  hideLabels?: boolean;
  interactive?: boolean;
  onStepChange?: (stepIndex: number) => void;
  orientation?: StepperOrientation;
  uiRole?: string;
}>) {
  const steps = Children.toArray(children).filter(isStepperStepElement);

  return (
    <MantineStepper
      active={active}
      allowNextStepsSelect={interactive}
      aria-label={ariaLabel}
      color="myoxus"
      contentPadding={0}
      iconSize={"var(--mantine-spacing-xl)"}
      onStepClick={interactive ? onStepChange : undefined}
      orientation={orientation}
      size={compact ? "xs" : "sm"}
      wrap={!compact}
      styles={
        compact
          ? {
              root: {
                minWidth:
                  "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))",
              },
              stepBody: {
                display: hideLabels ? "none" : undefined,
              },
            }
          : hideLabels
            ? {
                stepBody: {
                  display: "none",
                },
              }
            : undefined
      }
      data-myoxus-ui-role={uiRole}
    >
      {steps.map((step, index) => (
        <MantineStepper.Step
          key={index}
          allowStepSelect={interactive && !step.props.disabled}
          aria-current={index === active ? "step" : undefined}
          completedIcon={step.props.completedIcon}
          description={step.props.description}
          icon={step.props.icon}
          label={
            hideLabels ? (
              <MantineVisuallyHidden>{step.props.label}</MantineVisuallyHidden>
            ) : (
              step.props.label
            )
          }
        />
      ))}
    </MantineStepper>
  );
}
