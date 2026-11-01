// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  type ReactNode,
  type CSSProperties,
  useRef,
  useState,
  useCallback,
  forwardRef,
  type InputHTMLAttributes,
  type Ref,
} from "react";
import {
  FileButton as MantineFileButton,
  Card as MantineCard,
  Stack,
  ThemeIcon as MantineThemeIcon,
  Text,
  Button as MantineButton,
} from "@mantine/core";
import { reactNodeText } from "./helpers/accessibility";
import { UploadIcon } from "@myoxus/icons/react";
import { type MyoxusUiRoleProp } from "./helpers/ui-role";

export type UploadTargetProps = {
  title: ReactNode;
  description?: ReactNode;
  pickLabel: ReactNode;
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
  onFile?: (file: File) => void;
  onFiles?: (files: File[]) => void;
};

export function UploadTarget({
  title,
  description,
  pickLabel,
  accept,
  multiple = false,
  directory = false,
  disabled = false,
  className,
  style,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole,
  onFile,
  onFiles,
}: UploadTargetProps) {
  // Directory upload is a browser-native extension. Mantine owns the file input
  // and reset behavior; the facade only passes the technical attribute.
  const resetFilePickerRef = useRef<() => void>(null);
  const [drag, setDrag] = useState(false);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDrag(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback(() => {
    setDrag(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      setDrag(false);
      const files = Array.from(event.dataTransfer.files ?? []);
      const firstFile = files[0];
      if (!firstFile) return;
      onFiles?.(files);
      onFile?.(firstFile);
    },
    [disabled, onFile, onFiles],
  );

  const handleFilePick = useCallback(
    (payload: File | File[] | null) => {
      const files = Array.isArray(payload) ? payload : payload ? [payload] : [];
      const firstFile = files[0];
      if (firstFile) {
        onFiles?.(files);
        onFile?.(firstFile);
      }
      resetFilePickerRef.current?.();
    },
    [onFile, onFiles],
  );

  return (
    <MantineFileButton
      accept={accept}
      multiple={multiple}
      disabled={disabled}
      resetRef={resetFilePickerRef}
      onChange={handleFilePick}
      inputProps={
        directory
          ? ({
              webkitdirectory: "",
            } as React.ComponentProps<"input">)
          : undefined
      }
    >
      {({ onClick }) => {
        const open = () => {
          if (disabled) return;
          onClick();
        };

        return (
          <MantineCard
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-label={reactNodeText(title) || undefined}
            aria-disabled={disabled || undefined}
            data-drag={drag ? "true" : "false"}
            data-disabled={disabled ? "true" : "false"}
            data-testid={dataTestId}
            data-myoxus-ui-role={uiRole ?? "button:upload-target"}
            className={className}
            p="xl"
            radius="lg"
            ta="center"
            bg={
              drag
                ? "var(--mantine-color-default-hover)"
                : "var(--mantine-color-body)"
            }
            bd={`calc(0.125rem * var(--mantine-scale)) dashed ${
              drag
                ? "var(--mantine-primary-color-filled)"
                : "var(--mantine-color-default-border)"
            }`}
            opacity={disabled ? 0.5 : 1}
            style={{
              ...style,
              cursor: disabled ? "not-allowed" : "pointer",
            }}
            onClick={open}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
              }
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <Stack align="center" gap="xs">
              <MantineThemeIcon
                aria-hidden
                color="myoxus"
                radius="xl"
                size="lg"
                variant="light"
              >
                <UploadIcon aria-hidden />
              </MantineThemeIcon>
              <Text component="span">{title}</Text>
              {description ? (
                <Text component="span" c="dimmed">
                  {description}
                </Text>
              ) : null}
              <MantineButton
                type="button"
                disabled={disabled}
                size="xs"
                variant="subtle"
                data-myoxus-ui-role="button:compact:upload-pick"
                onClick={(event) => {
                  event.stopPropagation();
                  open();
                }}
              >
                {pickLabel}
              </MantineButton>
            </Stack>
          </MantineCard>
        );
      }}
    </MantineFileButton>
  );
}

export const HiddenFileInput = forwardRef(function HiddenFileInput(
  {
    "data-myoxus-ui-role": uiRole = "hidden-file-input",
    style,
    ...props
  }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & MyoxusUiRoleProp,
  ref: Ref<HTMLInputElement>,
) {
  // File inputs opened from menu actions should stay programmatically
  // triggerable without adding a second tabbable or screen-reader control.
  // Use a native input instead of Mantine Box so the HTML `hidden` attribute
  // cannot be lost through polymorphic component prop handling.
  return (
    <input
      {...props}
      ref={ref}
      type="file"
      hidden
      tabIndex={-1}
      aria-hidden="true"
      style={{
        height: 0,
        opacity: 0,
        overflow: "hidden",
        pointerEvents: "none",
        position: "fixed",
        width: 0,
        ...style,
      }}
      data-myoxus-ui-role={uiRole}
    />
  );
});
