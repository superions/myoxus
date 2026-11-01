import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { OAuth } from "@myoxus/core/components/myoxus/auth/oauth";
import { AuthService, ServerService } from "@myoxus/core/modules/server";
import type { AuthSessionStatus } from "@myoxus/core/modules/server/entities/session";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace";
import { ServerDeploymentType } from "@myoxus/graphql";
import { Trans, useI18n } from "@myoxus/i18n";
import {
  ArrowRightBigIcon,
  LocalWorkspaceIcon,
  PublishIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  AuthActionStack,
  AuthContainer,
  AuthContent,
  AuthDivider,
  AuthFooter,
  AuthHeader,
  AuthInput,
  AuthStatusText,
  Button,
  notify,
} from "@myoxus/ui-facade";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

import { useStandaloneLoginVersionGuard } from "../hooks/myoxus/use-standalone-login-version-guard";
import type { SignInState } from ".";
import { AuthContextNotice } from "./auth-context";
import { Back } from "./back";

const emailRegex =
  /^(?:(?:[^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@(?:(?:\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|((?:[a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

function validateEmail(email: string) {
  return emailRegex.test(email);
}

export const SignInStep = ({
  state,
  changeState,
  onSkip,
  onAuthenticated,
}: {
  state: SignInState;
  changeState: Dispatch<SetStateAction<SignInState>>;
  onSkip: () => void;
  onAuthenticated?: (status: AuthSessionStatus) => void;
}) => {
  const t = useI18n();
  const serverService = useService(ServerService);
  const serverName = useLiveData(
    serverService.server.config$.selector((c) => c.serverName),
  );
  const versionError = useStandaloneLoginVersionGuard(serverService.server);
  const isStandalone = useLiveData(
    serverService.server.config$.selector(
      (c) => c.type === ServerDeploymentType.Standalone,
    ),
  );
  const authService = useService(AuthService);
  const showNativeLocalEntry = canUseLocalWorkspaces();
  const [isMutating, setIsMutating] = useState(false);

  const [email, setEmail] = useState("");

  const [isValidEmail, setIsValidEmail] = useState(true);

  const loginStatus = useLiveData(authService.session.status$);

  useEffect(() => {
    if (loginStatus === "authenticated") {
      notify.success({
        title: t["com.myoxus.auth.toast.title.signed-in"](),
        message: t["com.myoxus.auth.toast.message.signed-in"](),
      });
    }
    onAuthenticated?.(loginStatus);
  }, [loginStatus, onAuthenticated, t]);

  const onContinue = useAsyncCallback(async () => {
    if (!validateEmail(email)) {
      setIsValidEmail(false);
      return;
    }

    setIsValidEmail(true);
    setIsMutating(true);

    try {
      const { hasPassword } = await authService.checkUserByEmail(email);

      if (hasPassword) {
        changeState((prev) => ({
          ...prev,
          email,
          step: "signInWithPassword",
          hasPassword: true,
        }));
      } else {
        changeState((prev) => ({
          ...prev,
          email,
          step: "signInWithEmail",
          hasPassword: false,
        }));
      }
    } catch (err: any) {
      console.error(err);

      // TODO(@eyhn): better error handling
      notify.error({
        title: t["com.myoxus.sign-in.failed.title"](),
        message: err.message,
      });
    }

    setIsMutating(false);
  }, [authService, changeState, email]);

  const onAddStandalone = useCallback(() => {
    changeState((prev) => ({
      ...prev,
      step: "addStandalone",
    }));
  }, [changeState]);

  if (versionError && (isStandalone || BUILD_CONFIG.isElectron)) {
    return (
      <AuthContainer>
        <AuthHeader
          title={t["com.myoxus.auth.sign.in"]()}
          subTitle={serverName}
        />
        <AuthContent>{versionError}</AuthContent>
      </AuthContainer>
    );
  }

  return (
    <AuthContainer>
      <AuthHeader
        title={t["com.myoxus.auth.sign.in"]()}
        subTitle={serverName}
      />
      <AuthContextNotice authContext={state.authContext} />

      <AuthContent>
        <OAuth
          redirectUrl={state.redirectUrl}
          authContext={state.authContext}
        />

        <AuthInput
          autoFocus
          label={t["com.myoxus.settings.email"]()}
          name="username"
          autoComplete="username"
          type="email"
          placeholder={t["com.myoxus.auth.sign.email.placeholder"]()}
          onChange={setEmail}
          error={!isValidEmail}
          errorHint={
            isValidEmail ? "" : t["com.myoxus.auth.sign.email.error"]()
          }
          onEnter={onContinue}
        />

        <Button
          size="extraLarge"
          data-testid="continue-login-button"
          block
          loading={isMutating}
          suffix={<ArrowRightBigIcon aria-hidden="true" />}
          onClick={onContinue}
        >
          {t["com.myoxus.auth.sign.email.continue"]()}
        </Button>

        {(!isStandalone || BUILD_CONFIG.isElectron) && (
          <>
            {!BUILD_CONFIG.isElectron && (
              <AuthStatusText>
                {/*prettier-ignore*/}
                <Trans i18nKey="com.myoxus.auth.sign.message">
                By continuing with email, you use this server under its operator&apos;s policies. Myoxus is distributed under the <a href={BUILD_CONFIG.licenseUrl} target="_blank" rel="noreferrer">AGPL-3.0-or-later license</a>.
            </Trans>
              </AuthStatusText>
            )}
            {showNativeLocalEntry && (
              <>
                <AuthDivider label="or" />
                <AuthActionStack align="center">
                  {BUILD_CONFIG.isNative ? (
                    <Button
                      variant="plain"
                      prefix={<PublishIcon aria-hidden="true" />}
                      onClick={onAddStandalone}
                    >
                      {t["com.myoxus.auth.sign.add-standalone"]()}
                    </Button>
                  ) : (
                    <AuthStatusText>
                      {t["com.myoxus.mobile.sign-in.skip.hint"]()}
                    </AuthStatusText>
                  )}
                  <Button
                    variant="plain"
                    onClick={onSkip}
                    prefix={<LocalWorkspaceIcon aria-hidden="true" />}
                  >
                    {t["com.myoxus.mobile.sign-in.skip.link"]()}
                  </Button>
                </AuthActionStack>
              </>
            )}
          </>
        )}
      </AuthContent>
      {isStandalone && !BUILD_CONFIG.isElectron && (
        <AuthFooter>
          <Back changeState={changeState} />
        </AuthFooter>
      )}
    </AuthContainer>
  );
};
