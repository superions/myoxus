import { PageHeader } from "@myoxus/core/mobile/components/page-header";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Modal,
  MyoxusText,
  SettingsControlList,
  Stack,
  SurfaceListItem,
  SurfaceListSelectionSlot,
  SurfaceListSpacer,
} from "@myoxus/ui-facade";
import {
  type CSSProperties,
  forwardRef,
  type HTMLProps,
  type ReactNode,
} from "react";

interface ConfigModalProps {
  onBack?: () => void;
  onDone?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children: ReactNode;
  variant?: "popup" | "page";
}

type ConfigRowTone = "default" | "danger";

interface ConfigRowProps extends HTMLProps<HTMLDivElement> {
  right?: ReactNode;
  tone?: ConfigRowTone;
}

/**
 * Mobile configuration shell composed from shared Facade primitives. Keep this
 * free of local CSS so mobile settings inherit the same Modal/Button/Text rhythm
 * as Web/Core configuration surfaces.
 */
export const ConfigModal = ({
  onBack,
  onDone,
  open,
  onOpenChange,
  title,
  children,
  variant = "page",
}: ConfigModalProps) => {
  const t = useI18n();
  return (
    <Modal
      onOpenChange={onOpenChange}
      open={open}
      fullScreen={variant === "page"}
      width="100%"
      minHeight={0}
      animation="slideBottom"
      withoutCloseButton
      contentOptions={{
        bodyOverflow: variant === "page" ? "auto" : undefined,
        bodyPadding: variant === "page" ? "none" : "sm",
        surface: variant === "page" ? "secondary" : undefined,
      }}
    >
      {variant === "page" ? (
        <PageHeader
          back={!!onBack}
          backAction={onBack}
          suffix={
            onDone ? (
              <Button variant="plain" onClick={onDone}>
                {t["Done"]()}
              </Button>
            ) : undefined
          }
        >
          <MyoxusText
            component="span"
            fallbackSlot="body-small"
            typographySlot="nav"
            data-myoxus-ui-role="mobile-config-modal-page-title"
          >
            {title}
          </MyoxusText>
        </PageHeader>
      ) : null}
      <Stack
        gap={
          variant === "page"
            ? "var(--mantine-spacing-md)"
            : "var(--mantine-spacing-lg)"
        }
        p={variant === "page" ? "lg" : undefined}
        data-myoxus-ui-role={
          variant === "page"
            ? "mobile-config-modal-page-content"
            : "mobile-config-modal-popup-content"
        }
      >
        {variant === "page" ? null : (
          <MyoxusText
            component="div"
            fallbackSlot="body-small"
            typographySlot="nav"
            data-myoxus-ui-role="mobile-config-modal-popup-title"
          >
            {title}
          </MyoxusText>
        )}
        {children}
        {variant === "popup" && onDone ? (
          <Stack data-myoxus-ui-role="mobile-config-modal-popup-actions">
            <Button variant="primary" size="large" block onClick={onDone}>
              {t["Done"]()}
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </Modal>
  );
};

export const ConfigRow = forwardRef<HTMLDivElement, ConfigRowProps>(
  function ConfigRow(
    { children, className, right, tone = "default", style, ...attrs },
    ref,
  ) {
    return (
      <SurfaceListItem
        className={className}
        component="div"
        density="compact"
        fullWidth
        interactive={!!attrs.onClick}
        layout="row"
        tone={tone === "danger" ? "danger" : "default"}
        ref={ref}
        style={style}
        data-myoxus-ui-role="mobile-config-modal-row"
        {...attrs}
      >
        {children}
        {right ? (
          <>
            <SurfaceListSpacer />
            <SurfaceListSelectionSlot active>{right}</SurfaceListSelectionSlot>
          </>
        ) : null}
      </SurfaceListItem>
    );
  },
);

export interface SettingGroupProps extends Omit<
  HTMLProps<HTMLDivElement>,
  "title"
> {
  title?: ReactNode;
  contentClassName?: string;
  contentStyle?: CSSProperties;
}

export const ConfigRowGroup = forwardRef<HTMLDivElement, SettingGroupProps>(
  function ConfigRowGroup(
    { children, title, className, contentClassName, contentStyle, ...attrs },
    ref,
  ) {
    return (
      <Stack
        className={className}
        gap="xs"
        ref={ref}
        data-myoxus-ui-role="mobile-config-modal-row-group"
        {...attrs}
      >
        {title ? (
          <MyoxusText
            component="div"
            fallbackSlot="body-small"
            tone="tertiary"
            typographySlot="body-small"
            data-myoxus-ui-role="mobile-config-modal-row-group-title"
          >
            {title}
          </MyoxusText>
        ) : null}
        <SettingsControlList
          className={contentClassName}
          style={contentStyle}
          data-myoxus-ui-role="mobile-config-modal-row-group-content"
        >
          {children}
        </SettingsControlList>
      </Stack>
    );
  },
);

ConfigModal.RowGroup = ConfigRowGroup;
ConfigModal.Row = ConfigRow;
