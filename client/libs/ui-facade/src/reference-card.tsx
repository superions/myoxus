// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useState, type ReactNode } from "react";
import {
  AspectRatio,
  Box,
  Center,
  Grid,
  Group,
  Image,
  Stack,
} from "@mantine/core";
import { SurfaceListItem, type SurfaceListItemProps } from "./surface-list";
import { MyoxusText } from "./typography";

export type ReferenceCardSize = "small" | "large" | "preview";
export type ReferenceCardProps = Omit<
  SurfaceListItemProps,
  "title" | "layout" | "density" | "appearance"
> & {
  /** Select by display mode, never by loading or resource success. */
  size: ReferenceCardSize;
  /** Fixed renderer/container bounds take precedence over the normal size width. */
  contained?: boolean;
  /** Preserves horizontal/vertical resource placement without a separate card family. */
  orientation?: "horizontal" | "vertical";
  icon?: ReactNode;
  title?: ReactNode;
  metadata?: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  /** Live previews fill a fixed vertical frame after metadata has taken its intrinsic height. */
  preview?: ReactNode;
  image?: string | null;
  imageFallback?: ReactNode;
  "data-testid"?: string;
  actions?: ReactNode;
  footer?: ReactNode;
};

/** Shared small, large and preview templates. Content, commands and resource lifetime belong to callers. */
export function ReferenceCard({
  size,
  contained = false,
  orientation = "horizontal",
  icon,
  title,
  metadata,
  status,
  description,
  preview,
  image,
  imageFallback,
  actions,
  footer,
  children,
  fullHeight = false,
  component = "div",
  "data-testid": testId,
  ...props
}: ReferenceCardProps) {
  const media =
    preview ??
    (image || imageFallback ? (
      <ReferenceCardMedia
        key={image ?? ""}
        image={image}
        fallback={imageFallback ?? icon}
      />
    ) : null);
  const fillContent = fullHeight || (size === "preview" && !!media);
  const stretchPreview =
    size === "preview" && fullHeight && orientation === "vertical" && !!preview;
  const compact = size === "small";
  const stacked = compact && orientation === "vertical";
  const titleSlot =
    title == null ? null : typeof title === "string" ||
      typeof title === "number" ? (
      <MyoxusText
        component="span"
        typographySlot={size === "large" ? "card-title" : "body-small"}
        truncate={!stacked && size !== "large"}
        lineClamp={stacked || size === "large" ? 2 : undefined}
        title={String(title)}
        data-testid={testId ? `${testId}-title` : undefined}
        data-slot="title"
      >
        <strong>{title}</strong>
      </MyoxusText>
    ) : (
      title
    );
  const metaSlot =
    metadata == null ? null : typeof metadata === "string" ? (
      <MyoxusText
        component="span"
        typographySlot="dense-label"
        tone="secondary"
        lineClamp={2}
        title={metadata}
      >
        {metadata}
      </MyoxusText>
    ) : (
      metadata
    );
  const heading = (
    <Group gap="xs" wrap="nowrap">
      {icon ? (
        <Box
          component="span"
          display="inline-flex"
          flex="0 0 auto"
          fz={compact ? "lg" : "xl"}
          aria-hidden
          data-slot="icon"
        >
          {icon}
        </Box>
      ) : null}
      {size !== "large" ? status : null}
      {!stacked ? (
        <Stack gap={0} miw={0} flex={1}>
          {titleSlot}
          {metaSlot}
        </Stack>
      ) : (
        <Box flex={1} />
      )}
      {size !== "large" && actions ? (
        <Group gap="xs" wrap="nowrap" data-slot="actions">
          {actions}
        </Group>
      ) : null}
      {compact && !stacked && footer ? (
        <Box miw={0} data-slot="footer">
          {footer}
        </Box>
      ) : null}
    </Group>
  );
  const content = (
    <Stack
      gap={size === "large" ? undefined : "xs"}
      miw={0}
      h={fullHeight && !stretchPreview ? "100%" : undefined}
      flex={size === "preview" && orientation === "horizontal" ? 3 : undefined}
    >
      {size === "large" && (status || actions) ? (
        <Group justify={status ? "space-between" : "flex-end"} wrap="nowrap">
          {status}
          {actions ? (
            <Group gap="xs" wrap="nowrap" data-slot="actions">
              {actions}
            </Group>
          ) : null}
        </Group>
      ) : null}
      {heading}
      {stacked ? (
        <Stack gap={0} miw={0}>
          {titleSlot}
          {metaSlot}
        </Stack>
      ) : null}
      {description == null ? null : typeof description === "string" ? (
        <MyoxusText
          typographySlot={size === "large" ? "body" : "dense-label"}
          tone="secondary"
          lineClamp={orientation === "vertical" ? 6 : 2}
          preserveWhitespace
          data-testid={testId ? `${testId}-description` : undefined}
        >
          {description}
        </MyoxusText>
      ) : (
        description
      )}
      {children != null ? (
        <Stack gap="xs" flex={fillContent ? 1 : undefined} mih={0}>
          {children}
        </Stack>
      ) : null}
      {/* Flexible editor/reader content owns its remaining height. */}
      {fillContent && footer && children == null ? <Box flex={1} /> : null}
      {(!compact || stacked) && footer ? (
        <Box miw={0} data-slot="footer">
          {footer}
        </Box>
      ) : null}
    </Stack>
  );
  const frame = (
    <SurfaceListItem
      {...props}
      component={component}
      data-focus-ring={component === "button" ? "auto" : undefined}
      appearance="card"
      density={compact ? "compact" : "default"}
      fullHeight={fullHeight}
      data-card-size={size}
      data-testid={testId}
    >
      {size === "preview" && media ? (
        orientation === "horizontal" ? (
          <Group
            align="stretch"
            wrap="nowrap"
            gap="xs"
            h={fullHeight ? "100%" : undefined}
          >
            {content}
            <Box flex={1} miw={0}>
              {media}
            </Box>
          </Group>
        ) : (
          <Stack gap="xs" h={fullHeight ? "100%" : undefined}>
            {stretchPreview ? (
              <Box flex={1} mih={0}>
                {media}
              </Box>
            ) : (
              media
            )}
            <Box miw={0} flex={stretchPreview ? undefined : 1}>
              {content}
            </Box>
          </Stack>
        )
      ) : (
        content
      )}
    </SurfaceListItem>
  );
  if (contained) return frame;
  return (
    <Grid gap={0} h={fullHeight ? "100%" : undefined}>
      <Grid.Col
        span={size === "large" ? 6 : compact ? "content" : 12}
        maw={compact ? "50%" : undefined}
        h={fullHeight ? "100%" : undefined}
      >
        {frame}
      </Grid.Col>
    </Grid>
  );
}

/** Image failure is presentation state; changing/retrying the source remounts only this slot. */
function ReferenceCardMedia({
  image,
  fallback,
}: {
  image?: string | null;
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <AspectRatio ratio={2}>
      {image && !failed ? (
        <Image src={image} alt="" fit="cover" onError={() => setFailed(true)} />
      ) : (
        <Center>
          <Box component="span" display="inline-flex" fz="xl" aria-hidden>
            {fallback}
          </Box>
        </Center>
      )}
    </AspectRatio>
  );
}
