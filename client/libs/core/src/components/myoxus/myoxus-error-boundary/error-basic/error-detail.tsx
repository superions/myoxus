import { getArtworkUrl } from "@myoxus/theme/artwork";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { Trans, useI18n } from "@myoxus/i18n";
import {
  Button,
  ExceptionBoundaryActions,
  ExceptionBoundaryCopy,
  ExceptionBoundaryDetailLayout,
  ExceptionBoundaryDetailSurface,
  ExceptionBoundaryIllustration,
  ExceptionBoundaryInlineLink,
  ExceptionBoundaryStackToggleButton,
  ExceptionBoundaryStackTrace,
  MyoxusText,
} from "@myoxus/ui-facade";
import {
  type FC,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useState,
} from "react";

export enum ErrorStatus {
  NotFound = 404,
  Unexpected = 500,
}

export interface ErrorDetailProps extends PropsWithChildren {
  status?: ErrorStatus;
  title: string;
  description: ReactNode | Array<ReactNode>;
  buttonText?: string;
  onButtonClick?: () => void | Promise<void>;
  resetError?: () => void;
  error?: Error;
}

/**
 * TODO(@eyhn): Unify with NotFoundPage.
 */
export const ErrorDetail: FC<ErrorDetailProps> = (props) => {
  const {
    status = ErrorStatus.Unexpected,
    description,
    onButtonClick,
    resetError,
    error,
  } = props;
  const descriptions = Array.isArray(description) ? description : [description];
  const [isBtnLoading, setBtnLoading] = useState(false);
  const [showStack, setShowStack] = useState(false);
  const t = useI18n();

  const onToggleStack = useCallback(() => {
    setShowStack(!showStack);
  }, [showStack]);

  const onBtnClick = useAsyncCallback(async () => {
    try {
      setBtnLoading(true);
      await onButtonClick?.();
      resetError?.(); // Only reset when retry success.
    } finally {
      setBtnLoading(false);
    }
  }, [onButtonClick, resetError]);

  const desc = descriptions.map((item, i) => (
    <MyoxusText
      component="p"
      data-myoxus-ui-role="exception-boundary-description"
      key={`error-desc-${i}`}
      preserveWhitespace
      typographySlot="body-small"
    >
      {item}
    </MyoxusText>
  ));

  return (
    <ExceptionBoundaryDetailLayout
      data-testid={
        status === ErrorStatus.NotFound ? "not-found" : "error-detail"
      }
      data-myoxus-error-status={status}
      data-myoxus-ui-role="exception-boundary-detail-layout"
    >
      <ExceptionBoundaryDetailSurface expanded={showStack}>
        <ExceptionBoundaryIllustration
          draggable={false}
          lightSrc={getArtworkUrl(
            status === ErrorStatus.Unexpected ? "server-error" : "not-found",
          )}
        />

        <ExceptionBoundaryCopy>
          <MyoxusText
            data-myoxus-ui-role="exception-boundary-title"
            preserveWhitespace
            typographySlot="body-small"
          >
            {props.title}
          </MyoxusText>
          {desc}
        </ExceptionBoundaryCopy>
        <ExceptionBoundaryStackTrace expanded={showStack}>
          {error?.stack || "No detailed error stack is provided."}
        </ExceptionBoundaryStackTrace>

        <ExceptionBoundaryActions>
          {error?.stack ? (
            <ExceptionBoundaryStackToggleButton
              expanded={showStack}
              onClick={onToggleStack}
            >
              {t["com.myoxus.error.hide-error"]()}
            </ExceptionBoundaryStackToggleButton>
          ) : null}
          <Button onClick={onBtnClick} loading={isBtnLoading} variant="primary">
            {props.buttonText ?? t["com.myoxus.error.reload"]()}
          </Button>
        </ExceptionBoundaryActions>
      </ExceptionBoundaryDetailSurface>
    </ExceptionBoundaryDetailLayout>
  );
};

export function ContactUS() {
  return (
    <Trans
      i18nKey="com.myoxus.error.contact-us"
      components={{
        1: (
          <ExceptionBoundaryInlineLink
            href={BUILD_CONFIG.communityUrl}
            rel="noreferrer"
            target="_blank"
          />
        ),
      }}
    />
  );
}
