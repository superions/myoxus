// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type TooltipAlign,
  type TooltipSide,
  Tooltip,
  humanizeAccessibleToken,
} from "./helpers/tooltip";
import {
  type ReactNode,
  type CSSProperties,
  type PropsWithChildren,
  type HTMLAttributes,
  type MouseEvent as ReactMouseEvent,
  type ComponentProps,
  useState,
  useEffect,
} from "react";
import {
  type AvatarProps as MantineAvatarProps,
  Avatar as MantineAvatar,
  Box,
} from "@mantine/core";
import { withUnit } from "./css-utils";
import { cssVar } from "@myoxus/theme";
import { IconButton } from "./button";
import { CloseIcon } from "@myoxus/icons/react";

type AvatarKind = "document" | "generic" | "user" | "workspace";

type AvatarImageSource =
  Blob | File | HTMLImageElement | ImageBitmap | string | null | undefined;

type AvatarTooltipOptions = {
  align?: TooltipAlign;
  content?: ReactNode;
  delayDuration?: number;
  side?: TooltipSide;
};

type AvatarRemoveButtonProps = {
  "aria-label"?: string;
  className?: string;
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
};

export type AvatarProps = PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
    name?: string;
    url?: string | null;
    image?: AvatarImageSource;
    size?: MantineAvatarProps["size"];
    rounded?: CSSProperties["borderRadius"];
    kind?: AvatarKind;
    onRemove?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    hoverIcon?: ReactNode;
    colorfulFallback?: boolean;
    avatarTooltipOptions?: AvatarTooltipOptions;
    removeTooltipOptions?: AvatarTooltipOptions;
    removeButtonProps?: AvatarRemoveButtonProps;
    "data-testid"?: string;
    "data-myoxus-ui-role"?: string;
  }
>;

export type AvatarStackProps = PropsWithChildren<
  Omit<
    ComponentProps<typeof MantineAvatar.Group>,
    "children" | "classNames" | "styles" | "unstyled"
  > & {
    kind?: AvatarKind;
    "data-testid"?: string;
    "data-myoxus-ui-role"?: string;
  }
>;

function isAvatarBlobSource(value: AvatarImageSource): value is Blob | File {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isAvatarImageElementSource(
  value: AvatarImageSource,
): value is HTMLImageElement {
  return (
    typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement
  );
}

function isAvatarImageBitmapSource(
  value: AvatarImageSource,
): value is ImageBitmap {
  return typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap;
}

function useResolvedAvatarSource(
  url: string | null | undefined,
  image: AvatarImageSource,
) {
  const [resolvedImage, setResolvedImage] = useState<string | undefined>(() =>
    typeof image === "string" ? image || undefined : undefined,
  );

  useEffect(() => {
    if (url) {
      setResolvedImage(url);
      return undefined;
    }

    if (!image) {
      setResolvedImage(undefined);
      return undefined;
    }

    if (typeof image === "string") {
      setResolvedImage(image || undefined);
      return undefined;
    }

    if (isAvatarBlobSource(image)) {
      const objectUrl = URL.createObjectURL(image);
      setResolvedImage(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }

    if (isAvatarImageElementSource(image)) {
      setResolvedImage(image.currentSrc || image.src || undefined);
      return undefined;
    }

    if (isAvatarImageBitmapSource(image)) {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) {
        setResolvedImage(undefined);
        return undefined;
      }
      context.drawImage(image, 0, 0);
      setResolvedImage(canvas.toDataURL("image/png"));
      return undefined;
    }

    setResolvedImage(undefined);
    return undefined;
  }, [image, url]);

  return url || resolvedImage;
}

function getAvatarFallbackLabel(
  name: string | undefined,
  size: MantineAvatarProps["size"],
) {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const firstPart = parts[0];
  if (!firstPart) return undefined;
  const lastPart = parts.at(-1) ?? firstPart;
  const codepoints = (value: string) => Array.from(value).filter(Boolean);
  const initials =
    parts.length > 1
      ? [codepoints(firstPart)[0], codepoints(lastPart)[0]]
      : codepoints(firstPart).slice(0, 2);

  // Compact Mantine avatar slots use one clear glyph, while normal user avatars
  // keep the familiar two-letter mark. Numeric legacy sizes keep the previous
  // threshold for existing call sites.
  const compactSize =
    typeof size === "number" ? size < 24 : size === "xs" || size === "sm";
  const maxGlyphs = compactSize ? 1 : 2;
  return initials.filter(Boolean).slice(0, maxGlyphs).join("").toUpperCase();
}

export function Avatar({
  children,
  name,
  url,
  image,
  size,
  rounded,
  kind = "user",
  className,
  onRemove,
  hoverIcon,
  colorfulFallback,
  avatarTooltipOptions,
  removeTooltipOptions,
  removeButtonProps,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  ...domProps
}: AvatarProps) {
  // Shared fallback rendering prevents square-frame/avatar regressions when
  // Admin and Web both display compact workspace or user marks.
  const fallbackLabel = getAvatarFallbackLabel(name, size);
  const resolvedSource = useResolvedAvatarSource(url, image);
  const [showEditChrome, setShowEditChrome] = useState(false);
  const radius = rounded ?? "var(--mantine-radius-xl)";
  const hasEditChrome = Boolean(hoverIcon || onRemove);
  const avatarSize = typeof size === "number" ? withUnit(size, "px") : size;
  const styledAvatarSize = style?.width ?? style?.height;
  const resolvedStyledAvatarSize =
    typeof styledAvatarSize === "number"
      ? withUnit(styledAvatarSize, "px")
      : styledAvatarSize;

  const avatar = (
    <MantineAvatar
      {...domProps}
      src={resolvedSource}
      name={name}
      alt={name ?? ""}
      size={size}
      radius={radius}
      className={className}
      data-testid={dataTestId}
      style={{
        "--avatar-bd": "0",
        ...(resolvedStyledAvatarSize
          ? { "--avatar-size": resolvedStyledAvatarSize }
          : null),
        boxShadow: "none",
        ...(!resolvedSource && colorfulFallback
          ? {
              "--avatar-bg": cssVar("primaryColor"),
              "--avatar-color": cssVar("pureWhite"),
              "--avatar-placeholder-fz":
                "min(var(--mantine-font-size-nav, var(--mantine-font-size-md)), calc(var(--avatar-size) / 2))",
              background: cssVar("primaryColor"),
              color: cssVar("pureWhite"),
              letterSpacing: "0",
            }
          : null),
        lineHeight: 1,
        textRendering: "geometricPrecision",
        WebkitFontSmoothing: "antialiased",
        MozOsxFontSmoothing: "grayscale",
        ...style,
      }}
      data-avatar-kind={kind}
      data-myoxus-ui-role={uiRole ?? `avatar:${kind}`}
    >
      {!resolvedSource ? (children ?? fallbackLabel) : undefined}
    </MantineAvatar>
  );

  const handleRemove = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove?.(event);
  };

  const renderedAvatar = hasEditChrome ? (
    <Box
      component="span"
      onMouseEnter={() => setShowEditChrome(true)}
      onMouseLeave={() => setShowEditChrome(false)}
      onFocus={() => setShowEditChrome(true)}
      onBlur={() => setShowEditChrome(false)}
      style={{
        borderRadius: radius,
        display: "inline-flex",
        flex: "0 0 auto",
        height: avatarSize,
        position: "relative",
        width: avatarSize,
      }}
      data-myoxus-ui-role={`avatar-edit-shell:${kind}`}
    >
      {avatar}
      {hoverIcon ? (
        <Box
          component="span"
          aria-hidden="true"
          style={{
            alignItems: "center",
            background: cssVar("backgroundModalColor"),
            borderRadius: "inherit",
            color: cssVar("pureWhite"),
            display: "flex",
            inset: 0,
            justifyContent: "center",
            opacity: showEditChrome ? 1 : 0,
            pointerEvents: "none",
            position: "absolute",
            transition: `opacity 120ms ease`,
          }}
          data-myoxus-ui-role={`avatar-hover-overlay:${kind}`}
        >
          {hoverIcon}
        </Box>
      ) : null}
      {onRemove ? (
        <Tooltip
          content={removeTooltipOptions?.content}
          align={removeTooltipOptions?.align}
          side={removeTooltipOptions?.side}
          rootOptions={{ delayDuration: removeTooltipOptions?.delayDuration }}
        >
          <IconButton
            type="button"
            className={removeButtonProps?.className}
            data-testid={removeButtonProps?.["data-testid"]}
            disabled={removeButtonProps?.disabled}
            size="xs"
            icon={<CloseIcon aria-hidden />}
            title={removeButtonProps?.title}
            aria-label={
              removeButtonProps?.["aria-label"] ??
              humanizeAccessibleToken(removeButtonProps?.["data-testid"]) ??
              "Remove avatar"
            }
            onClick={handleRemove}
            style={{
              insetBlockStart: `calc(var(--mantine-spacing-2xs) * -1)`,
              insetInlineEnd: `calc(var(--mantine-spacing-2xs) * -1)`,
              opacity: showEditChrome ? 1 : 0,
              position: "absolute",
              transition: `opacity 120ms ease`,
              ...removeButtonProps?.style,
            }}
            data-myoxus-ui-role={
              removeButtonProps?.["data-myoxus-ui-role"] ??
              `button:avatar-remove:${kind}`
            }
          />
        </Tooltip>
      ) : null}
    </Box>
  ) : (
    avatar
  );

  if (!avatarTooltipOptions?.content) {
    return renderedAvatar;
  }

  return (
    <Tooltip
      content={avatarTooltipOptions.content}
      align={avatarTooltipOptions.align}
      side={avatarTooltipOptions.side}
      rootOptions={{ delayDuration: avatarTooltipOptions.delayDuration }}
    >
      {renderedAvatar}
    </Tooltip>
  );
}

export function AvatarStack({
  children,
  kind = "user",
  spacing = "var(--mantine-spacing-xs)",
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  ...domProps
}: AvatarStackProps) {
  return (
    <MantineAvatar.Group
      {...domProps}
      spacing={spacing}
      data-testid={dataTestId}
      data-avatar-kind={kind}
      data-myoxus-ui-role={uiRole ?? `avatar-stack:${kind}`}
      style={{
        alignItems: "center",
        ...style,
      }}
    >
      {children}
    </MantineAvatar.Group>
  );
}
