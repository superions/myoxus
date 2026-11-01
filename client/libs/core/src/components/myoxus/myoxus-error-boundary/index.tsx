import { ErrorBoundary, type FallbackRender } from "@sentry/react";
import { type FC, type PropsWithChildren, useCallback } from "react";

import { MyoxusErrorFallback } from "./myoxus-error-fallback";

export { type FallbackProps } from "./error-basic/fallback-creator";

export interface MyoxusErrorBoundaryProps extends PropsWithChildren {
  height?: number | string;
  className?: string;
}

/**
 * TODO(@eyhn): Unify with SWRErrorBoundary
 */
export const MyoxusErrorBoundary: FC<MyoxusErrorBoundaryProps> = (props) => {
  const fallbackRender: FallbackRender = useCallback(
    (fallbackProps) => {
      return (
        <MyoxusErrorFallback
          {...fallbackProps}
          height={props.height}
          className={props.className}
        />
      );
    },
    [props.height, props.className],
  );

  const onError = useCallback((error: unknown, componentStack?: string) => {
    console.error("Uncaught error:", error, componentStack);
  }, []);

  return (
    <ErrorBoundary fallback={fallbackRender} onError={onError}>
      {props.children}
    </ErrorBoundary>
  );
};
