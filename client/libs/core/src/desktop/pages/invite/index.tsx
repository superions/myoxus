/**
 * Workspace invite page (`/invite/:inviteId`).
 *
 * Handles the full workspace invitation flow for web users:
 *
 * 1. **Unauthenticated users** are redirected to the sign-in page with a
 *    `redirect_uri` pointing back to the invite URL.
 * 2. **Authenticated users** see the `<AcceptInvite>` component which fetches
 *    the invitation details from `InvitationService` and renders the
 *    appropriate UI based on the invitation's status:
 *    - If the user is already a member of the workspace, they are redirected
 *      directly to the workspace.
 *    - `Expired` — the invite link has expired or been revoked.
 *    - `JoinFailed` — a server error occurred during acceptance.
 *    - `SentRequest` — the request to join is pending admin approval.
 *    - `AcceptInvite` — the invite was accepted; shows a "Go to workspace"
 *       button.
 *    - Default — shows a `<RequestToJoinPage>` prompt.
 *
 * Note: web only; the Electron client uses a native deep-link flow instead.
 */
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspacesService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { WorkspaceMemberStatus } from "@myoxus/graphql";
import { useLiveData, useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";

import {
  RouteLogic,
  useNavigateHelper,
} from "../../../components/hooks/use-navigate-helper";
import { AuthService, InvitationService } from "../../../modules/server";
import {
  AcceptInvitePage,
  ExpiredPage,
  JoinFailedPage,
  RequestToJoinPage,
  SentRequestPage,
} from "./member-pages";

/**
 * Invitation acceptance component.
 *
 * Manages the full lifecycle of processing a workspace invitation:
 * - Polls `InvitationService` for the invite details.
 * - Redirects immediately if the user is already a workspace member.
 * - Handles "request to join" for invite-link flows (as opposed to direct
 *   email invitations).
 * - Shows contextual error and success states.
 *
 * @param inviteId - The invitation token from the URL.
 */
const AcceptInvite = ({ inviteId: targetInviteId }: { inviteId: string }) => {
  const { jumpToPage } = useNavigateHelper();

  const invitationService = useService(InvitationService);
  const workspacesService = useService(WorkspacesService);
  const authService = useService(AuthService);
  const user = useLiveData(authService.session.account$);
  const error = useLiveData(invitationService.error$);
  const inviteId = useLiveData(invitationService.inviteId$);
  const inviteInfo = useLiveData(invitationService.inviteInfo$);
  const loading = useLiveData(invitationService.loading$);
  const workspaces = useLiveData(workspacesService.list.workspaces$);
  const navigateHelper = useNavigateHelper();
  const [accepted, setAccepted] = useState(false);
  const [requestToJoinLoading, setRequestToJoinLoading] = useState(false);
  const [acceptError, setAcceptError] = useState<UserFriendlyError | null>(
    null,
  );

  const openWorkspace = useAsyncCallback(async () => {
    if (!inviteInfo?.workspace.id) {
      return;
    }
    await workspacesService.list.waitForRevalidation();
    jumpToPage(inviteInfo.workspace.id, "home", RouteLogic.REPLACE);
  }, [inviteInfo, workspacesService, jumpToPage]);

  const onOpenMyoxus = useCallback(() => {
    navigateHelper.jumpToIndex();
  }, [navigateHelper]);

  useEffect(() => {
    // if workspace already exists, open it
    if (
      !accepted &&
      inviteInfo?.workspace.id &&
      workspaces.some((w) => w.id === inviteInfo.workspace.id)
    ) {
      return openWorkspace();
    }
  }, [accepted, inviteInfo?.workspace.id, openWorkspace, workspaces]);

  const requestToJoin = useAsyncCallback(async () => {
    setRequestToJoinLoading(true);
    await invitationService
      .acceptInvite(targetInviteId)
      .then(() => {
        invitationService.getInviteInfo({ inviteId: targetInviteId });
        setAccepted(true);
      })
      .catch((error) => {
        const err = UserFriendlyError.fromAny(error);
        if (err.is("ALREADY_IN_SPACE")) {
          return openWorkspace();
        }
        setAcceptError(err);
        notify.error(err);
      });
    setRequestToJoinLoading(false);
  }, [invitationService, openWorkspace, targetInviteId]);

  const onSignOut = useAsyncCallback(async () => {
    await authService.signOut();
    navigateHelper.jumpToSignIn();
  }, [authService, navigateHelper]);

  if ((loading && !requestToJoinLoading) || inviteId !== targetInviteId) {
    return null;
  }

  if (!inviteInfo && !loading) {
    return <ExpiredPage onOpenMyoxus={onOpenMyoxus} />;
  }

  if (error || acceptError) {
    return (
      <JoinFailedPage inviteInfo={inviteInfo} error={error || acceptError} />
    );
  }

  // for email invite
  if (accepted && inviteInfo?.status === WorkspaceMemberStatus.Accepted) {
    return (
      <AcceptInvitePage
        onOpenWorkspace={openWorkspace}
        inviteInfo={inviteInfo}
      />
    );
  }

  if (
    inviteInfo?.status === WorkspaceMemberStatus.UnderReview ||
    inviteInfo?.status === WorkspaceMemberStatus.NeedMoreSeat
  ) {
    if (!inviteInfo) return null;
    return <SentRequestPage user={user} inviteInfo={inviteInfo} />;
  }

  return (
    <RequestToJoinPage
      user={user}
      inviteInfo={inviteInfo}
      requestToJoin={requestToJoin}
      onSignOut={onSignOut}
    />
  );
};

/**
 * /invite/:inviteId page
 *
 * only for web
 */
export const Component = () => {
  const authService = useService(AuthService);
  const invitationService = useService(InvitationService);
  const isRevalidating = useLiveData(authService.session.isRevalidating$);
  const loginStatus = useLiveData(authService.session.status$);
  const params = useParams<{ inviteId: string }>();

  useEffect(() => {
    authService.session.revalidate();
    if (params.inviteId) {
      invitationService.getInviteInfo({ inviteId: params.inviteId });
    }
  }, [authService, invitationService, params.inviteId]);

  const { jumpToSignIn } = useNavigateHelper();

  useEffect(() => {
    if (loginStatus === "unauthenticated" && !isRevalidating) {
      // We can not pass function to navigate state, so we need to save it in atom
      jumpToSignIn(`/invite/${params.inviteId}`, RouteLogic.REPLACE);
    }
  }, [isRevalidating, jumpToSignIn, loginStatus, params.inviteId]);

  if (!params.inviteId) {
    return <Navigate to="/expired" />;
  }

  if (loginStatus === "authenticated") {
    return <AcceptInvite inviteId={params.inviteId} />;
  }

  return null;
};
