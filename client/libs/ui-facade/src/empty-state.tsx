// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type RoleBoxProps } from "./helpers/ui-role";
import { type ReactNode, type CSSProperties } from "react";
import { Stack, Box, Text } from "@mantine/core";
import { cssVar } from "@myoxus/theme";

export function EmptyState({
  title,
  description,
  cta,
  media,
  mediaWidth,
  absoluteCenter = false,
  className,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  ...props
}: RoleBoxProps & {
  title: ReactNode;
  description?: ReactNode;
  cta?: ReactNode;
  media?: ReactNode;
  mediaWidth?: CSSProperties["width"];
  /**
   * Full-page mobile empty states need positional centering. Keep this in the
   * Facade so product code does not rebuild responsive centering CSS.
   */
  absoluteCenter?: boolean;
}) {
  const illustrated = Boolean(media);
  const textMaxWidth = "28rem";
  return (
    <Stack
      {...props}
      align="center"
      className={className}
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole ?? "empty-state"}
      gap={
        illustrated ? "var(--mantine-spacing-lg)" : "var(--mantine-spacing-xs)"
      }
      w="100%"
      style={{
        ...(absoluteCenter
          ? {
              left: "50%",
              position: "absolute",
              top: "50%",
              transform: "translate(-50%, -50%)",
              width: "100%",
            }
          : null),
        paddingBlock: illustrated
          ? `0 calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-xs))`
          : "var(--mantine-spacing-xl)",
        paddingInline: "var(--mantine-spacing-lg)",
        textAlign: "center",
        ...style,
      }}
    >
      {media ? (
        <Box
          data-myoxus-ui-role="empty-state-media"
          style={{
            maxWidth: "100%",
            width:
              mediaWidth ??
              `min(100%, calc(calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs)) * 15))`,
          }}
        >
          {media}
        </Box>
      ) : null}
      <Stack
        align="center"
        data-myoxus-ui-role="empty-state-copy-stack"
        gap={"var(--mantine-spacing-xs)"}
        w="100%"
      >
        {/* Copy slots accept semantic headings and grouped content. */}
        <Text
          component="div"
          data-myoxus-ui-role="empty-state-title"
          w="100%"
          style={{
            color: cssVar("textPrimaryColor"),
            margin: 0,
            maxWidth: textMaxWidth,
          }}
        >
          {title}
        </Text>
        {description ? (
          <Text
            component="div"
            data-myoxus-ui-role="empty-state-copy"
            w="100%"
            style={{
              color: cssVar("textSecondaryColor"),
              margin: 0,
              maxWidth: "24rem",
            }}
          >
            {description}
          </Text>
        ) : null}
      </Stack>
      {cta ? (
        <Box
          data-myoxus-ui-role="empty-state-cta"
          mt={illustrated ? undefined : "var(--mantine-spacing-sm)"}
        >
          {cta}
        </Box>
      ) : null}
    </Stack>
  );
}
