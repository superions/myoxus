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
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";

export const parseOpenAppUrl = (value: string | null) => {
  const parsed = appSchemaUrl.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const OpenAppRouteStatus = ({
  status,
  onRetry,
}: {
  status: "loading" | "invalid" | "error";
  onRetry?: () => void;
}) => {
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();
  const loading = status === "loading";
  const title = loading
    ? t["com.myoxus.open-app.loading.title"]()
    : status === "invalid"
      ? t["com.myoxus.open-app.invalid.title"]()
      : t["com.myoxus.open-app.error.title"]();
  const description = loading
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
              loading ? (
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
          loading ? undefined : (
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
};

const OpenUrl = () => {
  const [params] = useSearchParams();
  const urlToOpen = params.get("url");
  const navigateHelper = useNavigateHelper();

  const onOpenHere = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      navigateHelper.jumpToIndex();
    },
    [navigateHelper],
  );

  const parsedUrl = parseOpenAppUrl(urlToOpen);
  if (!parsedUrl) {
    return <OpenAppRouteStatus status="invalid" />;
  }

  const urlObj = new URL(parsedUrl);
  params.forEach((v, k) => {
    if (k === "url") {
      return;
    }
    urlObj.searchParams.set(k, v);
  });

  return (
    <OpenInAppPage urlToOpen={urlObj.toString()} openHereClicked={onOpenHere} />
  );
};

/**
 * @deprecated
 */
const OpenAppSignInRedirect = () => {
  const authService = useService(AuthService);
  const [params] = useSearchParams();
  const requestRef = useRef<Promise<string> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "error">("loading");
  const navigate = useNavigate();

  const maybeScheme = appSchemes.safeParse(params.get("scheme"));
  const scheme = maybeScheme.success
    ? maybeScheme.data
    : channelToScheme[BUILD_CONFIG.appBuildType];
  const next = normalizeOpenAppSignInNextParam(
    params.get("next"),
    location.origin,
  );

  useEffect(() => {
    let disposed = false;
    const request =
      requestRef.current ??
      (requestRef.current = authService.createOpenAppSignInCode());

    request
      .then((code) => {
        if (disposed) return;
        const urlToOpen = buildAuthenticationDeepLink({
          scheme,
          method: "open-app-signin",
          payload: next ? { code, next } : { code },
          server: location.origin,
        });
        navigate(buildOpenAppUrlRoute(urlToOpen), { replace: true });
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });

    return () => {
      disposed = true;
    };
  }, [attempt, authService, navigate, next, scheme]);

  const handleRetry = useCallback(() => {
    requestRef.current = null;
    setStatus("loading");
    setAttempt((value) => value + 1);
  }, []);

  return <OpenAppRouteStatus status={status} onRetry={handleRetry} />;
};

export const Component = () => {
  const params = useParams<{ action: string }>();
  const action = params.action || "";

  if (action === "url") {
    return <OpenUrl />;
  } else if (action === "signin-redirect") {
    return <OpenAppSignInRedirect />;
  }
  return <OpenAppRouteStatus status="invalid" />;
};
