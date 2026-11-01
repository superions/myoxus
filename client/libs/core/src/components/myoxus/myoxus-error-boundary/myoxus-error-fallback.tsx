import { useI18n } from "@myoxus/i18n";
import { getCurrentStore } from "@myoxus/infra";
import { ExceptionBoundaryViewport } from "@myoxus/ui-facade";
import { Provider } from "jotai/react";
import { type FC, useCallback, useMemo } from "react";
import { useRouteError } from "react-router";

import { ErrorDetail } from "./error-basic/error-detail";
import {
  ERROR_REFLECT_KEY,
  type FallbackProps,
} from "./error-basic/fallback-creator";
import { DumpInfo } from "./error-basic/info-logger";
import { AnyErrorFallback } from "./error-fallbacks/any-error-fallback";
import { NoPageRootFallback } from "./error-fallbacks/no-page-root-fallback";
import { PageNotFoundDetail } from "./error-fallbacks/page-not-found-fallback";

/**
 * Register all fallback components here.
 * If have new one just add it to the set.
 */
const fallbacks = new Set([PageNotFoundDetail, NoPageRootFallback]);

function getErrorFallbackComponent(error: any): FC<FallbackProps> {
  for (const Component of fallbacks) {
    const ErrorConstructor = Reflect.get(Component, ERROR_REFLECT_KEY);
    if (ErrorConstructor && error instanceof ErrorConstructor) {
      return Component as FC<FallbackProps>;
    }
  }
  return AnyErrorFallback;
}

export interface MyoxusErrorFallbackProps extends FallbackProps {
  height?: number | string;
  className?: string;
}

export const MyoxusErrorFallback: FC<MyoxusErrorFallbackProps> = (props) => {
  const { error, resetError, height } = props;
  const Component = useMemo(() => getErrorFallbackComponent(error), [error]);

  return (
    <ExceptionBoundaryViewport className={props.className} height={height}>
      <Component error={error} resetError={resetError} />
      <Provider key="JotaiProvider" store={getCurrentStore()}>
        <DumpInfo error={error} />
      </Provider>
    </ExceptionBoundaryViewport>
  );
};

export const MyoxusErrorComponent = () => {
  const error = useRouteError() as Error;

  const t = useI18n();

  const reloadPage = useCallback(() => {
    document.location.reload();
  }, []);

  return (
    <ErrorDetail
      title={t["com.myoxus.error.unexpected-error.title"]()}
      resetError={reloadPage}
      buttonText={t["com.myoxus.error.reload"]()}
      description={
        "message" in (error as Error) ? (error as Error).message : `${error}`
      }
      error={error as Error}
    />
  );
};
