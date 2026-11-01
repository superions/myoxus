import {
  DefaultServerService,
  type Server,
  ServersService,
} from "@myoxus/core/modules/server";
import type { AuthSessionStatus } from "@myoxus/core/modules/server/entities/session";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { FrameworkScope, useLiveData, useService } from "@myoxus/infra";
import { useEffect, useState } from "react";

import { AddStandaloneStep } from "./add-standalone";
import { SignInStep } from "./sign-in";
import { SignInWithEmailStep } from "./sign-in-with-email";
import { SignInWithPasswordStep } from "./sign-in-with-password";

export type AuthContext = "admin";

export type SignInStep =
  "signIn" | "signInWithPassword" | "signInWithEmail" | "addStandalone";

export interface SignInState {
  step: SignInStep;
  server?: Server;
  initialServerBaseUrl?: string;
  email?: string;
  hasPassword?: boolean;
  redirectUrl?: string;
  authContext?: AuthContext;
}

export const SignInPanel = ({
  onSkip,
  server: initialServerBaseUrl,
  initStep,
  onAuthenticated,
  redirectUrl,
  authContext,
}: {
  onAuthenticated?: (status: AuthSessionStatus) => void;
  onSkip: () => void;
  server?: string;
  initStep?: SignInStep | undefined;
  redirectUrl?: string;
  authContext?: AuthContext;
}) => {
  const defaultServerService = useService(DefaultServerService);
  const globalContext = useService(GlobalContextService).globalContext;
  const workspaceId = useLiveData(globalContext.workspaceId.$);
  const serversService = useService(ServersService);
  const defaultServer = useLiveData(defaultServerService.server$);
  const [state, setState] = useState<SignInState>({
    // Pin an open auth draft to its server. A selection change in a different
    // tab must never send a partially entered password to the new default.
    server: defaultServer,
    step: initStep
      ? initStep
      : initialServerBaseUrl
        ? "addStandalone"
        : "signIn",
    initialServerBaseUrl: initialServerBaseUrl,
    redirectUrl,
    authContext,
  });

  const step = state.step;
  const server = useLiveData(
    state.server
      ? serversService.server$(state.server.id)
      : defaultServerService.server$,
  );
  useEffect(() => {
    if (!BUILD_CONFIG.isElectron || workspaceId) return;
    // Keep the native frame's branding/telemetry owner with the pinned auth
    // draft, even while a different tab changes the last-used default. A modal
    // over an open workspace does not own that workspace's frame context.
    globalContext.serverId.set(
      step === "addStandalone" ? null : (server?.id ?? null),
    );
    return () => {
      if (!globalContext.workspaceId.get()) globalContext.serverId.set(null);
    };
  }, [globalContext, server, step, workspaceId]);

  // URL registration needs only global services, so it must also work before
  // the first ServerScope exists. Auth fields mount only after the handshake.
  if (step === "addStandalone" || !server) {
    return <AddStandaloneStep state={state} changeState={setState} />;
  }

  return (
    <FrameworkScope scope={server.scope}>
      {step === "signIn" ? (
        <SignInStep
          state={state}
          changeState={setState}
          onSkip={onSkip}
          onAuthenticated={onAuthenticated}
        />
      ) : step === "signInWithEmail" ? (
        <SignInWithEmailStep
          state={state}
          changeState={setState}
          onAuthenticated={onAuthenticated}
        />
      ) : step === "signInWithPassword" ? (
        <SignInWithPasswordStep
          state={state}
          changeState={setState}
          onAuthenticated={onAuthenticated}
        />
      ) : null}
    </FrameworkScope>
  );
};
