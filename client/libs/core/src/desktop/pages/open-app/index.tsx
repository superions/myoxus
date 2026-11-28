// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  RouteLogic,
  useNavigateHelper,
} from "@myoxus/core/components/hooks/use-navigate-helper";
import {
  buildAuthenticationDeepLink,
  buildOpenAppUrlRoute,
  normalizeOpenAppSignInNextParam,
} from "@myoxus/core/modules/open-in-app";
import { OpenInAppPage } from "@myoxus/core/modules/open-in-app/views/open-in-app-page";
import { AuthService } from "@myoxus/core/modules/server";
import {
  appSchemaUrl,
  appSchemes,
  channelToScheme,
} from "@myoxus/core/utils/channel";
import { useI18n } from "@myoxus/i18n";
import { AlertTriangleIcon, OpenInNewIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  AuthPageContainer,
  Button,
  DialogFooterActions,
  EmptyState,
  EmptyStateTitle,
  Loading,
} from "@myoxus/ui-facade";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

export function parseOpenAppUrl(value: string | null): string | null {
  const parsed = appSchemaUrl.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function OpenAppRouteStatus({
  status,
  onRetry,
}: {
  status: "loading" | "invalid" | "error";
  onRetry?: () => void;
}) {
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();
  const isLoading = status === "loading";

  const title = isLoading
    ? t["com.myoxus.open-app.loading.title"]()
    : status === "invalid"
      ? t["com.myoxus.open-app.invalid.title"]()
      : t["com.myoxus.open-app.error.title"]();
  const description = isLoading
    ? t["com.myoxus.open-app.loading.description"]()
    : status === "invalid"
      ? t["com.myoxus.open-app.invalid.description"]()
      : t["com.myoxus.open-app.error.description"]();

  return (
    <AuthPageContainer>
      <EmptyState
        title={
          <EmptyStateTitle
            icon={
              isLoading ? (
                <Loading />
              ) : status === "invalid" ? (
                <OpenInNewIcon />
              ) : (
                <AlertTriangleIcon />
              )
            }
          >
            {title}
          </EmptyStateTitle>
        }
        description={description}
        cta={
          isLoading ? undefined : (
            <DialogFooterActions>
              <Button
                variant="secondary"
                onClick={() => jumpToIndex(RouteLogic.REPLACE)}
              >
                {t["Go Back"]()}
              </Button>
              {onRetry ? (
                <Button onClick={onRetry}>{t["Retry"]()}</Button>
              ) : null}
            </DialogFooterActions>
          )
        }
        data-testid={`open-app-${status}`}
      />
    </AuthPageContainer>
  );
}

function OpenUrl() {
  const [params] = useSearchParams();
  const navigateHelper = useNavigateHelper();

  const handleOpenHere = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      navigateHelper.jumpToIndex();
    },
    [navigateHelper],
  );

  const parsedUrl = parseOpenAppUrl(params.get("url"));
  if (!parsedUrl) {
    return <OpenAppRouteStatus status="invalid" />;
  }

  const targetUrl = new URL(parsedUrl);
  params.forEach((value, key) => {
    if (key !== "url") {
      targetUrl.searchParams.set(key, value);
    }
  });

  return (
    <OpenInAppPage
      urlToOpen={targetUrl.toString()}
      openHereClicked={handleOpenHere}
    />
  );
}

function OpenAppSignInRedirect() {
  const authService = useService(AuthService);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requestRef = useRef<Promise<string> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "error">("loading");

  const parsedScheme = appSchemes.safeParse(params.get("scheme"));
  const scheme = parsedScheme.success
    ? parsedScheme.data
    : channelToScheme[BUILD_CONFIG.appBuildType];
  const next = normalizeOpenAppSignInNextParam(
    params.get("next"),
    location.origin,
  );

  useEffect(() => {
    let disposed = false;
    const pending =
      requestRef.current ??
      (requestRef.current = authService.createOpenAppSignInCode());

    pending
      .then((code) => {
        if (disposed) {
          return;
        }
        const deepLink = buildAuthenticationDeepLink({
          scheme,
          method: "open-app-signin",
          payload: next ? { code, next } : { code },
          server: location.origin,
        });
        navigate(buildOpenAppUrlRoute(deepLink), { replace: true });
      })
      .catch(() => {
        if (!disposed) {
          setStatus("error");
        }
      });

    return () => {
      disposed = true;
    };
  }, [attempt, authService, navigate, next, scheme]);

  const handleRetry = useCallback(() => {
    requestRef.current = null;
    setStatus("loading");
    setAttempt((count) => count + 1);
  }, []);

  return <OpenAppRouteStatus status={status} onRetry={handleRetry} />;
}

export function Component() {
  const { action } = useParams<{ action: string }>();
  if (action === "url") {
    return <OpenUrl />;
  }
  if (action === "signin-redirect") {
    return <OpenAppSignInRedirect />;
  }
  return <OpenAppRouteStatus status="invalid" />;
}
