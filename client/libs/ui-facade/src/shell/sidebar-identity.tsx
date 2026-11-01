// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type PropsWithChildren,
  type ReactNode,
  type ButtonHTMLAttributes,
  type MouseEventHandler,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { type SidebarLayoutSlotProps } from "./sidebar-frame";
import {
  Group,
  Stack,
  Text,
  Box,
  UnstyledButton as MantineUnstyledButton,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import { MyoxusText } from "../typography";
import { Badge } from "../badge";
import { Progress } from "../feedback";
import { IconButton } from "../button";
import { Card } from "../card";
import { resolveBrandPublicUrl, BrandAssetImage } from "../brand-asset-image";

export function SidebarIdentitySummary({
  children,
  style,
  ...props
}: PropsWithChildren<SidebarLayoutSlotProps>) {
  return (
    <Group
      {...props}
      gap={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
      style={{ minWidth: 0, ...style }}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "sidebar-identity-summary"
      }
    >
      {children}
    </Group>
  );
}

export function SidebarIdentityText({
  children,
  style,
  ...props
}: PropsWithChildren<SidebarLayoutSlotProps>) {
  return (
    <Stack
      {...props}
      gap={"var(--mantine-spacing-2xs)"}
      style={{ minWidth: 0, ...style }}
      data-myoxus-ui-role={
        props["data-myoxus-ui-role"] ?? "sidebar-identity-text"
      }
    >
      {children}
    </Stack>
  );
}

export function SidebarUserRow({ children }: PropsWithChildren) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      style={{
        minHeight:
          "calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs) + var(--mantine-spacing-2xs))",
        paddingInline:
          "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))",
        borderRadius: "var(--mantine-radius-sm)",
      }}
      data-myoxus-ui-role="sidebar-user-row"
    >
      {children}
    </Group>
  );
}

export function SidebarUserMain({ children }: PropsWithChildren) {
  return (
    <Group
      gap={"var(--mantine-spacing-xs)"}
      wrap="nowrap"
      style={{ minWidth: 0 }}
      data-myoxus-ui-role="sidebar-user-main"
    >
      {children}
    </Group>
  );
}

export function SidebarUserName({
  children,
  title,
}: PropsWithChildren<{ title?: string }>) {
  return (
    <Text
      component="span"
      title={title}
      truncate
      style={{
        color: cssVar("textPrimaryColor"),
        maxWidth: "100%",
      }}
      data-myoxus-ui-role="sidebar-user-name"
    >
      {children}
    </Text>
  );
}

export function SidebarVersionRow({
  label,
  value,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  title?: string;
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap={"var(--mantine-spacing-2xs)"}
      style={{
        paddingBlockStart: "var(--mantine-spacing-xs)",
        paddingInline: "var(--mantine-spacing-xs)",
        borderTopColor: cssVar("borderColor"),
        borderTopStyle: "solid",
        borderTopWidth: "calc(var(--mantine-scale) * 1px)",
        color: cssVar("textSecondaryColor"),
      }}
      data-myoxus-ui-role="sidebar-version-row"
    >
      <Text component="span" size="caption">
        {label}
      </Text>
      <Text
        component="span"
        title={title}
        truncate
        size="caption"
        style={{ minWidth: 0 }}
      >
        {value}
      </Text>
    </Group>
  );
}

export type SidebarPromoActionProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "disabled"
> & {
  icon?: ReactNode;
  label: ReactNode;
  hoverLabel?: ReactNode;
  detail?: ReactNode;
  progressValue?: number | null;
  disabled?: boolean;
  updating?: boolean;
  closeAction?: {
    "aria-label": string;
    icon?: ReactNode;
    onClick: MouseEventHandler<HTMLButtonElement>;
  };
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
};

/**
 * Sidebar promo actions centralize the former updater/open-in-app button
 * chrome. The component intentionally composes existing Mantine-backed Facade
 * primitives and theme tokens so product modules only provide state and copy.
 */
export function SidebarPromoAction({
  icon,
  label,
  hoverLabel,
  detail,
  progressValue,
  disabled,
  updating,
  closeAction,
  className,
  style,
  onClick,
  onMouseEnter,
  onMouseLeave,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "sidebar-promo-action",
  ...props
}: SidebarPromoActionProps) {
  const [hovered, setHovered] = useState(false);
  const active = hovered || Boolean(updating);
  const visibleLabel = active && hoverLabel ? hoverLabel : label;

  const handleMouseEnter: MouseEventHandler<HTMLButtonElement> = (event) => {
    setHovered(true);
    onMouseEnter?.(event);
  };
  const handleMouseLeave: MouseEventHandler<HTMLButtonElement> = (event) => {
    setHovered(false);
    onMouseLeave?.(event);
  };
  const handleCloseClick: MouseEventHandler<HTMLButtonElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeAction?.onClick(event);
  };

  return (
    <Box
      className={className}
      style={{ position: "relative", width: "100%", ...style }}
      data-myoxus-ui-role={`${uiRole}:shell`}
    >
      <MantineUnstyledButton
        {...props}
        type={props.type ?? "button"}
        disabled={disabled}
        data-testid={dataTestId}
        data-disabled={disabled ? "true" : "false"}
        data-updating={updating ? "true" : undefined}
        data-myoxus-ui-role={uiRole}
        onClick={onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          alignItems: "center",
          background: active
            ? cssVar("hoverColor")
            : cssVar("backgroundSecondaryColor"),
          border: `calc(var(--mantine-scale) * 1px) solid ${cssVar(
            "borderColor",
          )}`,
          borderRadius: "var(--mantine-radius-lg)",
          boxSizing: "border-box",
          color: cssVar("textPrimaryColor"),
          cursor: disabled ? "default" : "pointer",
          display: "flex",
          minHeight:
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
          overflow: "hidden",
          paddingInline: "var(--mantine-spacing-md)",
          pointerEvents: disabled ? "none" : undefined,
          position: "relative",
          transition: `background 120ms ease`,
          userSelect: "none",
          width: "100%",
        }}
      >
        <Stack
          gap={"var(--mantine-spacing-xs)"}
          style={{ minWidth: 0, width: "100%" }}
        >
          <Group gap={"var(--mantine-spacing-sm)"} wrap="nowrap">
            {icon ? (
              <Box
                component="span"
                style={{
                  alignItems: "center",
                  color: cssVar("iconColor"),
                  display: "inline-flex",
                  flex: "0 0 auto",
                  fontSize: "var(--mantine-spacing-xl)",
                }}
                data-myoxus-ui-role="sidebar-promo-action-icon"
              >
                {icon}
              </Box>
            ) : null}
            <MyoxusText
              component="span"
              truncate
              typographySlot="nav"
              fallbackSlot="body-small"
              data-myoxus-ui-role="sidebar-promo-action-label"
            >
              {visibleLabel}
            </MyoxusText>
            {detail ? (
              <Badge tone="neutral" data-myoxus-ui-role="sidebar-promo-detail">
                {detail}
              </Badge>
            ) : null}
          </Group>
          {progressValue !== null && progressValue !== undefined ? (
            <Progress
              showValueLabel={false}
              value={progressValue}
              testId="sidebar-promo-progress"
            />
          ) : null}
        </Stack>
      </MantineUnstyledButton>
      {closeAction ? (
        <IconButton
          aria-label={closeAction["aria-label"]}
          data-myoxus-ui-role="button:sidebar-promo-dismiss"
          icon={closeAction.icon}
          onClick={handleCloseClick}
          size="xs"
          style={{
            insetInlineEnd: "var(--mantine-spacing-xs)",
            insetBlockStart: "var(--mantine-spacing-xs)",
            position: "absolute",
          }}
          variant="plain"
        />
      ) : null}
    </Box>
  );
}

function readDocumentHasErrorStatus(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector("[data-myoxus-error-status]"));
}

function readDocumentHasDialog(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector('[role="dialog"]'));
}

// Promo cards are overlays; recovery and dialog surfaces must not be covered by
// desktop-app promotion chrome.
function subscribeDocumentOverlayStatus(listener: () => void) {
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return () => {};
  }

  const observer = new MutationObserver(listener);
  observer.observe(document.body, {
    attributeFilter: ["data-myoxus-error-status", "role"],
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

function useDocumentHasErrorStatus(enabled: boolean) {
  return useSyncExternalStore(
    enabled ? subscribeDocumentOverlayStatus : () => () => {},
    enabled ? readDocumentHasErrorStatus : () => false,
    () => false,
  );
}

function useDocumentHasDialog(enabled: boolean) {
  return useSyncExternalStore(
    enabled ? subscribeDocumentOverlayStatus : () => () => {},
    enabled ? readDocumentHasDialog : () => false,
    () => false,
  );
}

export type SidebarPromoCardProps = PropsWithChildren<{
  actions?: ReactNode;
  closeAction?: ReactNode;
  controls?: ReactNode;
  hidden?: boolean;
  hideOnDialog?: boolean;
  hideOnErrorStatus?: boolean;
  icon?: ReactNode;
  title: ReactNode;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
}>;

/**
 * Fixed sidebar promotion card used by install/open-in-app surfaces. Geometry
 * is expressed only through shared web tokens and Facade layout primitives; the
 * consuming product code must not reintroduce route-local card CSS.
 */
export function SidebarPromoCard({
  actions,
  children,
  closeAction,
  controls,
  hidden,
  hideOnDialog = true,
  hideOnErrorStatus = false,
  icon,
  title,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "sidebar-promo-card",
}: SidebarPromoCardProps) {
  const hasErrorStatus = useDocumentHasErrorStatus(hideOnErrorStatus);
  const hasDialog = useDocumentHasDialog(hideOnDialog);
  const resolvedHidden = Boolean(hidden || hasErrorStatus || hasDialog);

  return (
    <Card
      data-testid={dataTestId}
      data-hidden={resolvedHidden ? "true" : "false"}
      data-myoxus-ui-role={uiRole}
      padding="md"
      style={{
        bottom: `clamp(var(--mantine-spacing-md), 3dvw, var(--mantine-spacing-lg))`,
        display: "flex",
        left: `max(var(--mantine-spacing-md), calc(50dvw - (calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 11) / 2)))`,
        pointerEvents: resolvedHidden ? "none" : undefined,
        position: "fixed",
        right: `max(var(--mantine-spacing-md), calc(50dvw - (calc(calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 11) / 2)))`,
        transform: resolvedHidden ? "translateY(200%)" : undefined,
        transition: `transform 120ms ease`,
        visibility: resolvedHidden ? "hidden" : undefined,
        width: "auto",
        zIndex: `calc(${cssVar("zIndexModal")} - 1)`,
      }}
    >
      <Group align="flex-start" gap={"var(--mantine-spacing-sm)"} wrap="nowrap">
        {icon ? (
          <Box
            component="span"
            style={{
              alignItems: "center",
              display: "inline-flex",
              flex: "0 0 auto",
              height:
                "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg))",
              justifyContent: "center",
              width:
                "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-lg))",
            }}
            data-myoxus-ui-role="sidebar-promo-card-icon"
          >
            {icon}
          </Box>
        ) : null}
        <Stack
          gap={"calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"}
          style={{ flex: "1 1 auto", minWidth: 0 }}
        >
          <Group justify="space-between" wrap="nowrap">
            <MyoxusText
              component="span"
              truncate
              typographySlot="nav"
              fallbackSlot="body-small"
              data-myoxus-ui-role="sidebar-promo-card-title"
            >
              {title}
            </MyoxusText>
            {closeAction}
          </Group>
          {children ? (
            <MyoxusText
              component="div"
              typographySlot="body-small"
              data-myoxus-ui-role="sidebar-promo-card-description"
            >
              {children}
            </MyoxusText>
          ) : null}
          {controls || actions ? (
            <Group
              align="center"
              gap={
                "calc(var(--mantine-spacing-2xs) + var(--mantine-spacing-xs))"
              }
              justify="space-between"
              wrap="wrap"
              data-myoxus-ui-role="sidebar-promo-card-controls"
            >
              <Box style={{ minWidth: 0 }}>{controls}</Box>
              <Group gap={"var(--mantine-spacing-xs)"} wrap="nowrap">
                {actions}
              </Group>
            </Group>
          ) : null}
        </Stack>
      </Group>
    </Card>
  );
}

export function SidebarPromoProductMark({
  alt = "Myoxus app icon",
}: {
  alt?: string;
}) {
  const staticProductMarkUrl =
    resolveBrandPublicUrl(
      "/style/product-mark.svg",
      typeof environment === "undefined" ? undefined : environment.subPath,
    ) ?? "/style/product-mark.svg";
  const imageStyle: CSSProperties = {
    display: "block",
    height: "100%",
    width: "100%",
  };

  return (
    <BrandAssetImage
      alt={alt}
      slot="productMark"
      style={imageStyle}
      fallback={<img alt={alt} src={staticProductMarkUrl} style={imageStyle} />}
    />
  );
}
