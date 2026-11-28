// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

function AcceptInvite({ inviteId: targetInviteId }: { inviteId: string }) {
  const navigateHelper = useNavigateHelper();
  const invitationService = useService(InvitationService);
  const workspacesService = useService(WorkspacesService);
  const authService = useService(AuthService);

  const user = useLiveData(authService.session.account$);
  const error = useLiveData(invitationService.error$);
  const inviteId = useLiveData(invitationService.inviteId$);
  const inviteInfo = useLiveData(invitationService.inviteInfo$);
  const loading = useLiveData(invitationService.loading$);
  const workspaces = useLiveData(workspacesService.list.workspaces$);

  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [acceptError, setAcceptError] = useState<UserFriendlyError | null>(
    null,
  );

  const openWorkspace = useAsyncCallback(async () => {
    if (!inviteInfo?.workspace.id) {
      return;
    }
    await workspacesService.list.waitForRevalidation();
    navigateHelper.jumpToPage(
      inviteInfo.workspace.id,
      "home",
      RouteLogic.REPLACE,
    );
  }, [inviteInfo, navigateHelper, workspacesService]);

  const handleOpenMyoxus = useCallback(() => {
    navigateHelper.jumpToIndex();
  }, [navigateHelper]);

  useEffect(() => {
    if (
      !accepted &&
      inviteInfo?.workspace.id &&
      workspaces.some((workspace) => workspace.id === inviteInfo.workspace.id)
    ) {
      openWorkspace();
    }
  }, [accepted, inviteInfo?.workspace.id, openWorkspace, workspaces]);

  const requestToJoin = useAsyncCallback(async () => {
    setSubmitting(true);
    try {
      await invitationService.acceptInvite(targetInviteId);
      invitationService.getInviteInfo({ inviteId: targetInviteId });
      setAccepted(true);
    } catch (err) {
      const friendly = UserFriendlyError.fromAny(err);
      if (friendly.is("ALREADY_IN_SPACE")) {
        openWorkspace();
      } else {
        setAcceptError(friendly);
        notify.error(friendly);
      }
    } finally {
      setSubmitting(false);
    }
  }, [invitationService, openWorkspace, targetInviteId]);

  const handleSignOut = useAsyncCallback(async () => {
    await authService.signOut();
    navigateHelper.jumpToSignIn();
  }, [authService, navigateHelper]);

  if ((loading && !submitting) || inviteId !== targetInviteId) {
    return null;
  }
  if (!inviteInfo && !loading) {
    return <ExpiredPage onOpenMyoxus={handleOpenMyoxus} />;
  }
  if (error || acceptError) {
    return (
      <JoinFailedPage inviteInfo={inviteInfo} error={error || acceptError} />
    );
  }
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
    return inviteInfo ? (
      <SentRequestPage user={user} inviteInfo={inviteInfo} />
    ) : null;
  }

  return (
    <RequestToJoinPage
      user={user}
      inviteInfo={inviteInfo}
      requestToJoin={requestToJoin}
      onSignOut={handleSignOut}
    />
  );
}

export function Component() {
  const authService = useService(AuthService);
  const invitationService = useService(InvitationService);
  const { jumpToSignIn } = useNavigateHelper();
  const isRevalidating = useLiveData(authService.session.isRevalidating$);
  const loginStatus = useLiveData(authService.session.status$);
  const { inviteId } = useParams<{ inviteId: string }>();

  useEffect(() => {
    authService.session.revalidate();
    if (inviteId) {
      invitationService.getInviteInfo({ inviteId });
    }
  }, [authService, invitationService, inviteId]);

  useEffect(() => {
    if (loginStatus === "unauthenticated" && !isRevalidating) {
      jumpToSignIn(`/invite/${inviteId}`, RouteLogic.REPLACE);
    }
  }, [inviteId, isRevalidating, jumpToSignIn, loginStatus]);

  if (!inviteId) {
    return <Navigate to="/expired" />;
  }
  if (loginStatus === "authenticated") {
    return <AcceptInvite inviteId={inviteId} />;
  }
  return null;
}
