import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { AuthService, ServerService } from "@myoxus/core/modules/server";
import { UrlService } from "@myoxus/core/modules/url";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { OAuthProviderType } from "@myoxus/graphql";
import {
  AppleIcon,
  GithubIcon,
  GoogleIcon,
  LockIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { Button, notify } from "@myoxus/ui-facade";
import { type ReactElement, type SVGAttributes, useCallback } from "react";

import type { AuthContext } from "../../sign-in";

const OAuthProviderMap: Record<
  OAuthProviderType,
  {
    icon: ReactElement<SVGAttributes<SVGElement>>;
  }
> = {
  [OAuthProviderType.Google]: {
    icon: <GoogleIcon aria-hidden="true" />,
  },

  [OAuthProviderType.GitHub]: {
    icon: <GithubIcon aria-hidden="true" />,
  },

  [OAuthProviderType.OIDC]: {
    icon: <LockIcon aria-hidden="true" />,
  },

  [OAuthProviderType.Apple]: {
    icon: <AppleIcon aria-hidden="true" />,
  },
};

export function OAuth({
  redirectUrl,
  authContext,
}: {
  redirectUrl?: string;
  authContext?: AuthContext;
}) {
  const serverService = useService(ServerService);
  const urlService = useService(UrlService);
  const oauth = useLiveData(
    serverService.server.features$.map((r) => r?.oauth),
  );
  const oauthProviders = useLiveData(
    serverService.server.config$.map((r) => r?.oauthProviders),
  );
  const auth = useService(AuthService);

  const onContinue = useAsyncCallback(
    async (provider: OAuthProviderType) => {
      track.$.$.auth.signIn({ method: "oauth", provider });

      const open: () => Promise<void> | void = BUILD_CONFIG.isNative
        ? async () => {
            try {
              const scheme = urlService.getClientScheme();
              const options = await auth.oauthPreflight(
                provider,
                scheme ?? "web",
              );
              urlService.openPopupWindow(options.url);
            } catch (e) {
              notify.error(UserFriendlyError.fromAny(e));
            }
          }
        : () => {
            const params = new URLSearchParams();

            params.set("provider", provider);

            if (redirectUrl) {
              params.set("redirect_uri", redirectUrl);
            }
            if (authContext) {
              params.set("auth_context", authContext);
            }

            const oauthUrl =
              serverService.server.baseUrl +
              `/oauth/login?${params.toString()}`;

            urlService.openPopupWindow(oauthUrl);
          };

      const ret = open();

      if (ret instanceof Promise) {
        await ret;
      }
    },
    [urlService, redirectUrl, authContext, serverService, auth],
  );

  if (!oauth) {
    return null;
  }

  return oauthProviders?.map((provider) => {
    return (
      <OAuthProvider
        key={provider}
        provider={provider}
        onContinue={onContinue}
      />
    );
  });
}

interface OauthProviderProps {
  provider: OAuthProviderType;
  onContinue: (provider: OAuthProviderType) => void;
}

function OAuthProvider({ onContinue, provider }: OauthProviderProps) {
  const t = useI18n();
  const { icon } =
    provider in OAuthProviderMap
      ? OAuthProviderMap[provider]
      : { icon: undefined };

  const onClick = useCallback(() => {
    onContinue(provider);
  }, [onContinue, provider]);

  return (
    <Button
      variant="primary"
      block
      size="extraLarge"
      prefix={icon}
      onClick={onClick}
    >
      {t["com.myoxus.auth.continue-with-provider"]({ provider })}
    </Button>
  );
}
