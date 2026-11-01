// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ReactNode, useCallback } from "react";
import { Group } from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { MyoxusText, typographyFontWeightVar } from "./typography";
import { IconButton, Button } from "./button";
import { CloseIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";

export function BrowserWarning({
  show,
  onClose,
  message,
}: {
  show: boolean;
  onClose: () => void;
  message: ReactNode;
}) {
  if (!show) return null;
  return (
    <Group
      component="aside"
      align="center"
      justify="center"
      wrap="nowrap"
      style={{
        position: "absolute",
        zIndex: 1,
        width: "100%",
        padding: `var(--mantine-spacing-xs) var(--mantine-spacing-sm)`,
        background: cssVar("backgroundWarningColor"),
        color: cssVar("warningColor"),
      }}
      data-myoxus-ui-role="browser-warning"
    >
      <MyoxusText
        component="span"
        tone="primary"
        typographySlot="body-small"
        style={{ color: "inherit" }}
      >
        {message}
      </MyoxusText>
      <IconButton
        aria-label="Close browser warning"
        icon={<CloseIcon />}
        onClick={onClose}
        size="default"
        style={{
          position: "absolute",
          insetInlineEnd: "var(--mantine-spacing-sm)",
        }}
        variant="plain"
        data-myoxus-ui-role="browser-warning-close"
      />
    </Group>
  );
}

export function LocalDemoTips({
  onClose,
  isLoggedIn,
  onLogin,
  onEnableCloud,
}: {
  isLoggedIn: boolean;
  onLogin: () => void;
  onEnableCloud: () => void;
  onClose: () => void;
}) {
  const t = useI18n();
  const buttonLabel = isLoggedIn
    ? t["Enable Myoxus Cloud"]()
    : t["Sign in and Enable"]();

  const handleClick = useCallback(() => {
    if (isLoggedIn) return onEnableCloud();
    return onLogin();
  }, [isLoggedIn, onEnableCloud, onLogin]);

  return (
    <Group
      component="aside"
      align="center"
      justify="space-between"
      gap="md"
      wrap="wrap"
      data-testid="local-demo-tips"
      style={{
        position: "absolute",
        zIndex: 1,
        width: "100%",
        padding: `calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs)) var(--mantine-spacing-sm)`,
        background: cssVar("backgroundErrorColor"),
        color: cssVar("errorColor"),
      }}
      data-myoxus-ui-role="local-demo-tips"
    >
      <MyoxusText
        component="span"
        tone="primary"
        typographySlot="body-small"
        style={{
          flex: "1 1 auto",
          color: "inherit",
          fontWeight: typographyFontWeightVar("section"),
        }}
        data-myoxus-ui-role="local-demo-tips-message"
      >
        {t["com.myoxus.banner.local-warning"]()}
      </MyoxusText>

      <Group
        align="center"
        justify="space-between"
        gap="md"
        wrap="nowrap"
        data-myoxus-ui-role="local-demo-tips-actions"
      >
        <Button variant="secondary" onClick={handleClick}>
          {buttonLabel}
        </Button>
        <IconButton
          aria-label="Close local demo tips"
          onClick={onClose}
          size="default"
          data-testid="local-demo-tips-close-button"
          variant="plain"
        >
          <CloseIcon />
        </IconButton>
      </Group>
    </Group>
  );
}
