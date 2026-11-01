// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type CSSProperties,
  type ReactNode,
  isValidElement,
  cloneElement,
  type PropsWithChildren,
  Children,
  type ReactElement,
} from "react";
import { useI18n } from "@myoxus/i18n";
import { cssVar } from "@myoxus/theme";
import { ErrorMessage } from "./feedback";
import {
  Center,
  Grid,
  Card as MantineCard,
  Stack,
  Box,
  Divider as MantineDivider,
  Badge as MantineBadge,
  Group,
} from "@mantine/core";
import { MyoxusText } from "./typography";
import {
  SettingsSectionHeading,
  SettingsSectionDescription,
} from "./settings/page";
import { SettingsToolbar } from "./settings/fields";
import { Stepper, StepperStep } from "./stepper";

type OnboardingVariant = "default" | "config";

/*
 * Onboarding is an attended desktop/admin bootstrap surface. Do not add mobile
 * onboarding APIs, route-local setup chrome or another onboarding-shell.css.
 * If setup layout changes, keep it inside these Mantine-backed facade
 * primitives so the bootstrap flow cannot regress into parallel UI systems.
 */
const ONBOARDING_PANEL_STYLE: CSSProperties = {
  background: cssVar("backgroundOverlayPanelColor"),
  backdropFilter: `blur(12px)`,
  borderColor: cssVar("borderColor"),
};

const ONBOARDING_BORDER_STYLE = `calc(var(--mantine-scale) * 1px) solid ${cssVar(
  "borderColor",
)}`;

function renderOnboardingLogoChild(child: ReactNode) {
  if (!isValidElement<{ style?: CSSProperties }>(child)) {
    return child;
  }

  return cloneElement(child, {
    style: {
      width: "auto",
      height: "3.5rem",
      objectFit: "contain",
      ...child.props.style,
    },
  });
}

function renderOnboardingFieldChild(child: ReactNode, visible: boolean) {
  if (
    !isValidElement<{
      style?: CSSProperties;
      "data-myoxus-ui-role"?: string;
    }>(child) ||
    (child.type !== ErrorMessage &&
      child.props["data-myoxus-ui-role"] !== "error-message")
  ) {
    return child;
  }

  return cloneElement(child, {
    style: {
      ...child.props.style,
      position: "absolute",
      bottom: 0,
      left: 0,
      opacity: visible ? child.props.style?.opacity : 0,
      pointerEvents: visible ? child.props.style?.pointerEvents : "none",
      visibility: visible ? child.props.style?.visibility : "hidden",
    },
  });
}

export function OnboardingMain({
  children,
  loading = false,
}: PropsWithChildren<{ loading?: boolean }>) {
  return (
    <Center
      component="main"
      mih="100dvh"
      p={{ base: "md", sm: "xl" }}
      pos="relative"
      w="100%"
      style={{ zIndex: "20" }}
      data-myoxus-ui-role={loading ? "onboarding-loading" : "onboarding-main"}
    >
      {children}
    </Center>
  );
}

export function OnboardingShell({
  children,
  variant = "default",
}: PropsWithChildren<{ variant?: OnboardingVariant }>) {
  const items = Children.toArray(children);
  const sideSpan = variant === "config" ? 9 : 11;

  return (
    <Grid
      component="section"
      align="center"
      columns={24}
      gap="lg"
      maw={"64rem"}
      w="100%"
      data-myoxus-ui-role={`onboarding-shell:${variant}`}
    >
      {items.map((child, index) => (
        <Grid.Col
          key={index}
          span={{ base: 24, sm: index === 0 ? sideSpan : 24 - sideSpan }}
        >
          {child}
        </Grid.Col>
      ))}
    </Grid>
  );
}

export function OnboardingSideCard({
  children,
  variant = "default",
}: PropsWithChildren<{ variant?: OnboardingVariant }>) {
  return (
    <MantineCard
      component="aside"
      mih={
        variant === "config"
          ? undefined
          : {
              base: "auto",
              sm: "32.5rem",
            }
      }
      p="lg"
      radius="xl"
      shadow="sm"
      withBorder
      style={ONBOARDING_PANEL_STYLE}
      data-myoxus-ui-role={`onboarding-side-card:${variant}`}
    >
      <Stack gap="lg" justify="flex-start">
        {children}
      </Stack>
    </MantineCard>
  );
}

export function OnboardingFormCard({
  children,
  variant = "default",
}: PropsWithChildren<{ variant?: OnboardingVariant }>) {
  return (
    <MantineCard
      component="section"
      mih={
        variant === "config"
          ? undefined
          : {
              base: "auto",
              sm: "35rem",
            }
      }
      p="lg"
      radius="xl"
      shadow="sm"
      withBorder
      style={{
        ...ONBOARDING_PANEL_STYLE,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
      data-myoxus-ui-role={`onboarding-form-card:${variant}`}
    >
      {children}
    </MantineCard>
  );
}

export function OnboardingFormBody({ children }: PropsWithChildren) {
  return (
    <Box flex={1} mih={0} data-myoxus-ui-role="onboarding-form-body">
      {children}
    </Box>
  );
}

export function OnboardingSideCopy({ children }: PropsWithChildren) {
  return (
    <Stack
      gap={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
      data-myoxus-ui-role="onboarding-side-copy"
    >
      {children}
    </Stack>
  );
}

export function OnboardingLogoSlot({ children }: PropsWithChildren) {
  return (
    <Box data-myoxus-ui-role="onboarding-logo-slot">
      {Children.map(children, renderOnboardingLogoChild)}
    </Box>
  );
}

export function OnboardingRule() {
  return (
    <MantineDivider
      color={cssVar("placeholderColor")}
      mt={"calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"}
      size={"calc(var(--mantine-scale) * 1px)"}
      w={"6rem"}
      data-myoxus-ui-role="onboarding-rule"
    />
  );
}

export function OnboardingKicker({ children }: PropsWithChildren) {
  return (
    <MyoxusText
      component="p"
      tone="tertiary"
      typographySlot="body-small"
      style={{ margin: 0 }}
      data-myoxus-ui-role="onboarding-kicker"
    >
      {children}
    </MyoxusText>
  );
}

export function OnboardingTitle({
  children,
  variant = "default",
}: PropsWithChildren<{ variant?: "default" | "hero" | "step" }>) {
  const maxWidth = variant === "hero" ? "36rem" : "22rem";

  return (
    <SettingsSectionHeading
      level={variant === "default" ? 2 : 1}
      style={{ maxWidth }}
    >
      {children}
    </SettingsSectionHeading>
  );
}

export function OnboardingDescription({
  children,
  variant = "default",
}: PropsWithChildren<{ variant?: "default" | "hero" | "step" }>) {
  const maxWidth = variant === "hero" ? "36rem" : "24rem";

  return (
    <SettingsSectionDescription style={{ maxWidth }}>
      {children}
    </SettingsSectionDescription>
  );
}

export function OnboardingChip({ children }: PropsWithChildren) {
  return (
    <MantineBadge
      radius="lg"
      variant="default"
      styles={{
        root: {
          width: "fit-content",
          borderColor: cssVar("borderColor"),
          background: cssVar("backgroundSecondaryColor"),
          color: cssVar("textSecondaryColor"),
        },
      }}
      data-myoxus-ui-role="onboarding-chip"
    >
      {children}
    </MantineBadge>
  );
}

export function OnboardingStep({
  children,
  centered = false,
  compact = false,
  "data-myoxus-ui-role": uiRole,
}: PropsWithChildren<{
  centered?: boolean;
  compact?: boolean;
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <Stack
      component="section"
      gap="md"
      justify="center"
      mih={compact ? undefined : "20rem"}
      align={centered ? "center" : undefined}
      style={{ textAlign: centered ? "center" : undefined }}
      data-myoxus-ui-role={uiRole ?? "onboarding-step"}
    >
      {children}
    </Stack>
  );
}

export function OnboardingStepContent({ children }: PropsWithChildren) {
  return (
    <Stack maw={"27.5rem"} data-myoxus-ui-role="onboarding-step-content">
      {children}
    </Stack>
  );
}

export function OnboardingStepHeader({ children }: PropsWithChildren) {
  return (
    <Stack gap="xs" data-myoxus-ui-role="onboarding-step-header">
      {children}
    </Stack>
  );
}

export function OnboardingFieldList({ children }: PropsWithChildren) {
  return (
    <Stack gap="md" data-myoxus-ui-role="onboarding-field-list">
      {children}
    </Stack>
  );
}

export function OnboardingFieldErrorSlot({
  children,
  visible,
}: PropsWithChildren<{ visible: boolean }>) {
  return (
    <Stack
      gap="xs"
      pb="md"
      pos="relative"
      data-visible={visible ? "true" : "false"}
      data-myoxus-ui-role="onboarding-field-error-slot"
    >
      {Children.map(children, (child) =>
        renderOnboardingFieldChild(child, visible),
      )}
    </Stack>
  );
}

export function OnboardingInlineControls({
  children,
  "data-myoxus-ui-role": uiRole,
}: PropsWithChildren<{ "data-myoxus-ui-role"?: string }>) {
  return (
    <SettingsToolbar
      layout="split"
      align="flex-start"
      justify="stretch"
      style={{ width: "100%" }}
      data-myoxus-ui-role={uiRole ?? "onboarding-inline-controls"}
    >
      {children}
    </SettingsToolbar>
  );
}

export function OnboardingCompleteIcon({
  children,
  "data-myoxus-ui-role": uiRole,
}: PropsWithChildren<{ "data-myoxus-ui-role"?: string }>) {
  return (
    <Center
      h={"calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs))"}
      mx="auto"
      w={"calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs))"}
      bg={cssVar("backgroundSecondaryColor")}
      c={cssVar("textSecondaryColor")}
      style={{
        border: ONBOARDING_BORDER_STYLE,
        borderRadius: "var(--mantine-radius-lg)",
      }}
      data-myoxus-ui-role={uiRole ?? "onboarding-complete-icon"}
    >
      {children}
    </Center>
  );
}

export function OnboardingFooter({
  children,
  bordered = false,
}: PropsWithChildren<{ bordered?: boolean }>) {
  return (
    <Group
      component="footer"
      align="center"
      justify="space-between"
      gap="xs"
      mt="lg"
      wrap="wrap"
      style={{
        borderTop: bordered ? ONBOARDING_BORDER_STYLE : undefined,
        paddingTop: bordered
          ? "calc(var(--mantine-spacing-sm) + var(--mantine-spacing-2xs))"
          : undefined,
      }}
      data-myoxus-ui-role={
        bordered ? "onboarding-footer:bordered" : "onboarding-footer"
      }
    >
      {children}
    </Group>
  );
}

export function OnboardingActions({
  children,
  fullWidth = false,
  justify,
  "data-myoxus-ui-role": uiRole,
}: PropsWithChildren<{
  fullWidth?: boolean;
  justify?: CSSProperties["justifyContent"];
  "data-myoxus-ui-role"?: string;
}>) {
  return (
    <Group
      gap="xs"
      justify={justify}
      w={fullWidth ? "100%" : undefined}
      data-myoxus-ui-role={uiRole ?? "onboarding-actions"}
    >
      {children}
    </Group>
  );
}

export function OnboardingProgressBars({
  count,
  current,
  label,
}: {
  count: number;
  current: number;
  label?: string;
}) {
  const t = useI18n();
  return (
    <Stepper
      active={current}
      ariaLabel={
        label ??
        t.t("com.myoxus.common.step-progress", {
          current: current + 1,
          total: count,
        })
      }
      compact
      hideLabels
      orientation="horizontal"
      uiRole="onboarding-progress-bars"
    >
      {Array.from({ length: count }).map((_, index) => (
        <StepperStep
          key={index}
          label={t.t("com.myoxus.common.step-number", { number: index + 1 })}
          icon={index + 1}
          completedIcon={index + 1}
        />
      ))}
    </Stepper>
  );
}

export function OnboardingCounter({ children }: PropsWithChildren) {
  return (
    <MyoxusText
      component="div"
      tone="tertiary"
      typographySlot="caption"
      data-myoxus-ui-role="onboarding-counter"
    >
      {children}
    </MyoxusText>
  );
}

export function OnboardingProgressList({
  children,
  label,
}: PropsWithChildren<{ label: string }>) {
  const items = Children.toArray(children).filter(
    isOnboardingProgressItemElement,
  );
  const activeIndex = items.findIndex((item) => item.props.active);

  return (
    <Stepper
      active={activeIndex === -1 ? items.length : activeIndex}
      ariaLabel={label}
      orientation="vertical"
      uiRole="onboarding-progress-list"
    >
      {items.map((item, index) => (
        <StepperStep
          key={index}
          label={item.props.children}
          icon={item.props.marker}
          completedIcon={item.props.marker}
        />
      ))}
    </Stepper>
  );
}

type OnboardingProgressItemProps = PropsWithChildren<{
  marker: ReactNode;
  active: boolean;
  complete: boolean;
}>;

function isOnboardingProgressItemElement(
  child: ReactNode,
): child is ReactElement<OnboardingProgressItemProps> {
  return isValidElement(child) && child.type === OnboardingProgressItem;
}

export function OnboardingProgressItem({
  children,
  marker,
  active,
  complete,
}: OnboardingProgressItemProps) {
  void children;
  void marker;
  void active;
  void complete;
  // Parsed by OnboardingProgressList so product code keeps a declarative facade
  // API while the rendered progress UI is owned by Mantine Stepper.
  return null;
}
