// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import {
  Box,
  Stack,
  Paper as MantinePaper,
  Group,
  Center,
  Loader,
  VisuallyHidden as MantineVisuallyHidden,
  TextInput,
  Alert,
  Divider as MantineDivider,
  Button as MantineButton,
  Container as MantineContainer,
  Card as MantineCard,
} from "@mantine/core";
import { cssVar } from "@myoxus/theme";
import {
  type PropsWithChildren,
  Children,
  isValidElement,
  type HTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
  useId,
  useState,
  type CSSProperties,
  useCallback,
} from "react";
import { MyoxusButton, Button, type ButtonProps } from "./button";
import { Progress } from "./feedback";
import { EmptyState } from "./empty-state";
import { MyoxusText, MyoxusTitle, type MyoxusTitleProps } from "./typography";
import {
  type MyoxusInputProps,
  PasswordInput,
  type MyoxusPasswordInputProps,
  Input,
} from "./input";
import {
  BrandAssetImage,
  type BrandAssetImageProps,
} from "./brand-asset-image";
import { useI18n } from "@myoxus/i18n";
import { ArrowLeftSmallIcon } from "@myoxus/icons/react";
import { getArtworkUrl } from "@myoxus/theme/artwork";

export function AuthBackgroundArt() {
  return (
    <Box
      aria-hidden="true"
      bg={cssVar("backgroundSecondaryColor")}
      inset={0}
      pos="fixed"
      style={{ overflow: "hidden", pointerEvents: "none", zIndex: 0 }}
      data-myoxus-ui-role="auth-background"
    >
      <Box
        component="img"
        src={getArtworkUrl("auth-background", "svg")}
        alt=""
        bottom={0}
        data-testid="auth-background-hedge"
        left={0}
        pos="absolute"
        right={0}
        w="100%"
      />
    </Box>
  );
}

export function AuthContainer({ children }: PropsWithChildren) {
  const childList = Children.toArray(children);
  const headerChildren = childList.filter(
    (child) => isValidElement(child) && child.type === AuthHeader,
  );
  const bodyChildren = childList.filter(
    (child) => !(isValidElement(child) && child.type === AuthHeader),
  );

  return (
    <Stack gap={0} data-myoxus-ui-role="auth-container">
      {headerChildren}
      <MantinePaper
        mt="xl"
        p="xl"
        radius="md"
        shadow="sm"
        withBorder
        data-myoxus-ui-role="auth-form-paper"
      >
        <Stack gap="lg" data-myoxus-ui-role="auth-form-body">
          {bodyChildren}
        </Stack>
      </MantinePaper>
    </Stack>
  );
}

export function AuthContent({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Stack
      {...props}
      className={className}
      gap="md"
      data-myoxus-ui-role="auth-content"
    >
      {children}
    </Stack>
  );
}

export function AuthActionStack({
  children,
  align = "stretch",
  direction = "column",
  className,
}: PropsWithChildren<{
  align?: "start" | "center" | "end" | "stretch";
  direction?: "column" | "row";
  className?: string;
}>) {
  if (direction === "row") {
    return (
      <Group
        className={className}
        gap={"var(--mantine-spacing-sm)"}
        align={align}
        data-myoxus-ui-role="auth-action-stack"
      >
        {children}
      </Group>
    );
  }

  return (
    <Stack
      className={className}
      gap={"var(--mantine-spacing-sm)"}
      align={align}
      data-myoxus-ui-role="auth-action-stack"
    >
      {children}
    </Stack>
  );
}

export function AuthCaptchaArea({ children }: PropsWithChildren) {
  return (
    <Stack
      justify="center"
      mih={"calc(var(--mantine-spacing-2xl) * 3 + var(--mantine-spacing-xs))"}
      data-myoxus-ui-role="auth-captcha-area"
    >
      {children}
    </Stack>
  );
}

export function AuthCaptchaFallback({ children }: PropsWithChildren) {
  return (
    <Stack align="center" gap="md" data-myoxus-ui-role="auth-captcha-fallback">
      {children}
    </Stack>
  );
}

export function AuthCaptchaFallbackButton({
  children,
  solving = false,
  className,
  ...props
}: PropsWithChildren<
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "prefix"> & {
    solving?: boolean;
  }
>) {
  return (
    <MyoxusButton
      {...props}
      aria-busy={solving || undefined}
      className={className}
      data-myoxus-ui-role="auth-captcha-fallback-button"
      prefix={
        <Center
          aria-hidden="true"
          w={"calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))"}
        >
          {solving ? (
            <Loader
              size={
                "calc(var(--mantine-spacing-md) + var(--mantine-spacing-2xs))"
              }
            />
          ) : null}
        </Center>
      }
      size="large"
      variant="secondary"
    >
      {children}
    </MyoxusButton>
  );
}

export function AuthCaptchaFallbackStatus({
  children,
  progress,
}: PropsWithChildren<{ progress?: number }>) {
  return (
    <Stack gap="xs" data-myoxus-ui-role="auth-captcha-fallback-status">
      <AuthStatusText>{children}</AuthStatusText>
      {progress === undefined ? null : (
        <Progress
          value={progress}
          showValueLabel={false}
          ariaLabel="Captcha progress"
        />
      )}
    </Stack>
  );
}

export function AuthPanelFrame({
  children,
  className,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <Box
      {...props}
      className={className}
      w="100%"
      data-myoxus-ui-role="auth-panel-frame"
    >
      {children}
    </Box>
  );
}

export function AuthProgressRow({ children }: PropsWithChildren) {
  return (
    <Group align="center" gap="md" data-myoxus-ui-role="auth-progress-row">
      <Loader aria-hidden="true" />
      <MyoxusText component="p" m={0} tone="secondary">
        {children}
      </MyoxusText>
    </Group>
  );
}

export type AuthInputProps = Omit<MyoxusInputProps, "error" | "label"> & {
  label?: string;
  error?: boolean;
  errorHint?: ReactNode;
  onEnter?: () => void;
};

export function AuthInput({
  label,
  error,
  errorHint,
  onEnter,
  className,
  id,
  attributes,
  ...inputProps
}: AuthInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = error && errorHint ? `${inputId}-error` : undefined;
  const isPassword = inputProps.type === "password";
  const sharedInputProps = {
    ...inputProps,
    id: inputId,
    className,
    size: inputProps.size ?? "extraLarge",
    status: error ? "error" : "default",
    "aria-invalid": error || undefined,
    attributes: {
      ...attributes,
      input: {
        ...attributes?.input,
        "aria-describedby": errorId,
      },
    },
    onEnter: () => onEnter?.(),
  } satisfies MyoxusInputProps;

  return (
    <Stack gap="xs" data-myoxus-ui-role="auth-input">
      {label ? (
        <Box
          component="label"
          data-myoxus-ui-role="form-label"
          htmlFor={inputId}
        >
          <MyoxusText
            component="span"
            typographySlot="caption"
            tone="secondary"
          >
            {label}
          </MyoxusText>
        </Box>
      ) : null}
      {isPassword ? (
        <PasswordInput {...(sharedInputProps as MyoxusPasswordInputProps)} />
      ) : (
        <Input {...sharedInputProps} />
      )}
      {errorId ? (
        <MyoxusText
          component="div"
          id={errorId}
          typographySlot="caption"
          tone="danger"
        >
          {errorHint}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}

export function AuthHiddenInput({
  value,
  onChange,
  name = "website",
}: {
  value: string;
  name?: string;
  onChange: (value: string) => void;
}) {
  return (
    <MantineVisuallyHidden>
      <TextInput
        type="text"
        name={name}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={value}
        data-myoxus-ui-role="auth-hidden-input"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </MantineVisuallyHidden>
  );
}

export function AuthStatusText({
  children,
  state = "neutral",
  className,
}: PropsWithChildren<{
  state?: "neutral" | "error" | "success";
  className?: string;
}>) {
  return (
    <MyoxusText
      component="div"
      className={className}
      data-state={state}
      tone={
        state === "error"
          ? "danger"
          : state === "success"
            ? "success"
            : "secondary"
      }
      data-myoxus-ui-role="auth-status-text"
    >
      {children}
    </MyoxusText>
  );
}

export function AuthNotice({
  children,
  tone = "neutral",
  className,
  "data-testid": dataTestId,
}: PropsWithChildren<{
  tone?: "neutral" | "info" | "warning" | "error";
  className?: string;
  "data-testid"?: string;
}>) {
  return (
    <Alert
      className={className}
      data-testid={dataTestId}
      data-tone={tone}
      color={
        tone === "error"
          ? "myoxusError"
          : tone === "warning"
            ? "myoxusWarning"
            : tone === "info"
              ? "myoxusInfo"
              : undefined
      }
      variant="light"
      data-myoxus-ui-role="auth-notice"
    >
      {children}
    </Alert>
  );
}

export function AuthDivider({ label }: { label: ReactNode }) {
  return (
    <MantineDivider
      data-myoxus-ui-role="auth-divider"
      label={label}
      labelPosition="center"
    />
  );
}

export function AuthInlineActionButton({
  children,
  className,
  style,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <MantineButton
      {...props}
      component="button"
      type={type}
      className={className}
      size="compact-sm"
      style={style}
      variant="subtle"
      data-myoxus-ui-role="auth-inline-action"
    >
      {children}
    </MantineButton>
  );
}

export function AuthFooter({ children }: PropsWithChildren) {
  return (
    <Stack component="footer" gap="md" data-myoxus-ui-role="auth-footer">
      {children}
    </Stack>
  );
}

function AuthHeaderLogo() {
  const [logoFailed, setLogoFailed] = useState(false);
  const logoHeight = "3.5rem";
  const logoWidth = "8rem";
  const imageStyle: CSSProperties = {
    display: "block",
    height: "100%",
    objectFit: "contain",
    width: "100%",
  };

  return (
    <Box h={logoHeight} w={logoWidth} data-myoxus-ui-role="auth-header-mark">
      {logoFailed ? (
        <BrandAssetImage
          slot="productMark"
          alt="Myoxus Product Mark"
          style={imageStyle}
        />
      ) : (
        <BrandAssetImage
          slot="logo"
          alt="Myoxus Logo"
          onError={() => setLogoFailed(true)}
          style={imageStyle}
        />
      )}
    </Box>
  );
}

export function AuthHeader({
  title,
  subTitle,
  className,
  titleProps,
}: {
  title: string;
  subTitle?: string;
  className?: string;
  titleProps?: Pick<MyoxusTitleProps, "id" | "order" | "tabIndex">;
}) {
  return (
    <Stack
      align="center"
      className={className}
      gap="xs"
      data-myoxus-ui-role="auth-header"
    >
      <Stack align="center" gap="xs" data-myoxus-ui-role="auth-header-title">
        <AuthHeaderLogo />
        <MyoxusTitle
          order={2}
          {...titleProps}
          typographySlot="section-title"
          textAlign="center"
          m={0}
        >
          {title}
        </MyoxusTitle>
      </Stack>
      {subTitle ? (
        <MyoxusText component="p" tone="secondary" textAlign="center" m={0}>
          {subTitle}
        </MyoxusText>
      ) : null}
    </Stack>
  );
}

export function SignInPageContainer({ children }: PropsWithChildren) {
  return (
    <MantineContainer
      component="main"
      my="xl"
      size={420}
      style={{ zIndex: 1 }}
      data-myoxus-ui-role="sign-in-page-container"
    >
      {children}
    </MantineContainer>
  );
}

export function OtherPageHeroProductMark({
  alt = "Myoxus Product Mark",
  className,
  "data-myoxus-ui-role": uiRole = "other-page-hero-product-mark",
  fallback,
  ...props
}: BrandAssetImageProps & { "data-myoxus-ui-role"?: string }) {
  const markSize =
    "calc(var(--mantine-spacing-2xl) * 2 + var(--mantine-spacing-lg))";

  return (
    <BrandAssetImage
      {...props}
      slot="productMark"
      alt={alt}
      data-myoxus-ui-role={uiRole}
      className={className}
      fallback={fallback}
      style={{
        display: "block",
        height: markSize,
        objectFit: "contain",
        width: markSize,
        ...props.style,
      }}
    />
  );
}

export function MyoxusOtherPageLayout({
  children,
  downloadUrl,
  showDownloadAction = true,
}: PropsWithChildren<{
  downloadUrl?: string;
  showDownloadAction?: boolean;
}>) {
  const t = useI18n();
  const openDownloadLink = useCallback(() => {
    open(downloadUrl ?? BUILD_CONFIG.downloadUrl, "_blank");
  }, [downloadUrl]);
  const brandMarkSize = "var(--mantine-spacing-xl)";

  return (
    <Stack
      bg={cssVar("backgroundSecondaryColor")}
      gap={0}
      mih="100dvh"
      pos="relative"
      data-myoxus-ui-role="other-page-layout"
    >
      {BUILD_CONFIG.isElectron ? (
        <Box
          data-testid="draggable-header"
          h={"calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"}
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        />
      ) : (
        <Group
          component="header"
          justify="space-between"
          p="md"
          pos="relative"
          wrap="nowrap"
          style={{ zIndex: 1 }}
        >
          <Box
            component="a"
            c={cssVar("textPrimaryColor")}
            href="/"
            rel="noreferrer"
            aria-label="Myoxus"
          >
            <BrandAssetImage
              slot="productMark"
              alt="Myoxus Product Mark"
              style={{
                display: "block",
                height: brandMarkSize,
                width: brandMarkSize,
              }}
            />
          </Box>
          {showDownloadAction ? (
            <Button onClick={openDownloadLink} variant="secondary">
              {t["com.myoxus.auth.open.myoxus.download-app"]()}
            </Button>
          ) : null}
        </Group>
      )}

      {children}
    </Stack>
  );
}

export function AuthPageContainer({
  children,
  title,
  subtitle,
  media,
}: PropsWithChildren<{
  title?: ReactNode;
  subtitle?: ReactNode;
  media?: ReactNode;
}>) {
  return (
    <MyoxusOtherPageLayout>
      <AuthBackgroundArt />
      <Center
        component="main"
        flex={1}
        p="xl"
        pos="relative"
        style={{ zIndex: 1 }}
      >
        <MantineCard
          maw="32rem"
          p="xl"
          radius="md"
          shadow="xl"
          w="100%"
          withBorder
        >
          {media ? (
            <EmptyState
              media={media}
              title={
                title ? (
                  <MyoxusTitle order={2} textAlign="center" m={0}>
                    {title}
                  </MyoxusTitle>
                ) : undefined
              }
              description={subtitle}
              cta={children}
            />
          ) : (
            <>
              {title ? (
                <MyoxusTitle order={2} textAlign="center" m={0}>
                  {title}
                </MyoxusTitle>
              ) : null}
              {subtitle ? (
                <MyoxusText component="div" tone="secondary" textAlign="center">
                  {subtitle}
                </MyoxusText>
              ) : null}
              {children}
            </>
          )}
        </MantineCard>
      </Center>
    </MyoxusOtherPageLayout>
  );
}

export function BackButton(props: ButtonProps) {
  const t = useI18n();
  return (
    <Button
      {...props}
      variant={props.variant ?? "plain"}
      className={props.className}
      prefix={props.prefix ?? <ArrowLeftSmallIcon />}
    >
      {props.children ?? t["com.myoxus.backButton"]()}
    </Button>
  );
}
