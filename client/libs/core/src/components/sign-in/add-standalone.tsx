import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { ServersService } from "@myoxus/core/modules/server";
import { normalizeServerBaseUrl } from "@myoxus/core/modules/server/constant";
import { UserFriendlyError } from "@myoxus/error";
import { Trans, useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  AuthContainer,
  AuthContent,
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
  useMemo,
  useState,
} from "react";

import type { SignInState } from ".";
import { Back } from "./back";

export const AddStandaloneStep = ({
  state,
  changeState,
}: {
  state: SignInState;
  changeState: Dispatch<SetStateAction<SignInState>>;
}) => {
  const t = useI18n();
  const serversService = useService(ServersService);
  const [baseURL, setBaseURL] = useState(state.initialServerBaseUrl ?? "");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<boolean>(false);
  const [errorHint, setErrorHint] = useState(
    t["com.myoxus.auth.sign.add-standalone.error"](),
  );

  const urlValid = useMemo(() => {
    try {
      normalizeServerBaseUrl(baseURL);
      return true;
    } catch {
      return false;
    }
  }, [baseURL]);

  const onBaseURLChange = useCallback(
    (value: string) => {
      setBaseURL(value);
      setError(false);
      setErrorHint(t["com.myoxus.auth.sign.add-standalone.error"]());
    },
    [t],
  );

  const onConnect = useAsyncCallback(async () => {
    setIsConnecting(true);
    try {
      const server = await serversService.addOrGetServerByBaseUrl(
        normalizeServerBaseUrl(baseURL),
      );
      changeState((prev) => ({
        ...prev,
        step: "signIn",
        server,
      }));
    } catch (err) {
      console.error(err);
      const userFriendlyError = UserFriendlyError.fromAny(err);
      setError(true);
      if (userFriendlyError.is("TOO_MANY_REQUEST")) {
        setErrorHint(t["error.TOO_MANY_REQUEST"]());
      } else if (
        userFriendlyError.is("NETWORK_ERROR") ||
        userFriendlyError.is("REQUEST_ABORTED")
      ) {
        setErrorHint(t["error.NETWORK_ERROR"]());
      } else {
        setErrorHint(t["com.myoxus.auth.sign.add-standalone.error"]());
      }

      notify.error({
        title: t["com.myoxus.auth.toast.title.failed"](),
        message:
          userFriendlyError.is("REQUEST_ABORTED") ||
          userFriendlyError.is("NETWORK_ERROR")
            ? t["error.NETWORK_ERROR"]()
            : userFriendlyError.is("TOO_MANY_REQUEST")
              ? t["error.TOO_MANY_REQUEST"]()
              : t[`error.${userFriendlyError.name}`](userFriendlyError.data),
      });
    } finally {
      setIsConnecting(false);
    }
  }, [baseURL, changeState, serversService, t]);

  useEffect(() => {
    if (state.initialServerBaseUrl) {
      changeState((prev) => ({
        ...prev,
        initialServerBaseUrl: undefined,
      }));
      if (serversService.getServerByBaseUrl(state.initialServerBaseUrl)) {
        onConnect();
      }
    }
  }, [changeState, onConnect, serversService, state]);

  return (
    <AuthContainer>
      <AuthHeader
        title={t["com.myoxus.auth.sign.add-standalone.title"]()}
        subTitle={t["com.myoxus.auth.sign.add-standalone"]()}
      />
      <AuthContent>
        <AuthInput
          label={t["com.myoxus.auth.sign.add-standalone.baseurl"]()}
          value={baseURL}
          onChange={onBaseURLChange}
          placeholder="https://your-server.com"
          error={!!error}
          disabled={isConnecting}
          errorHint={errorHint}
          onEnter={onConnect}
        />
        <Button
          data-testid="connect-standalone-button"
          variant="primary"
          size="extraLarge"
          block
          disabled={!urlValid || isConnecting}
          loading={isConnecting}
          onClick={onConnect}
        >
          {t["com.myoxus.auth.sign.add-standalone.connect-button"]()}
        </Button>
      </AuthContent>
      <AuthFooter>
        <AuthStatusText>
          <Trans
            i18nKey="com.myoxus.auth.sign.add-standalone.description"
            components={{
              1: (
                <a
                  href={BUILD_CONFIG.operatorGuideUrl}
                  target="_blank"
                  rel="noreferrer"
                />
              ),
            }}
          />
        </AuthStatusText>
        <Back changeState={changeState} />
      </AuthFooter>
    </AuthContainer>
  );
};
