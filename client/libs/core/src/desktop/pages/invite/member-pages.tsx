// SPDX-License-Identifier: AGPL-3.0-or-later
import { getArtworkUrl } from "@myoxus/theme/artwork";

import { UserFriendlyError } from "@myoxus/error";
import {
  ErrorNames,
  type GetInviteInfoQuery,
  WorkspaceMemberStatus,
} from "@myoxus/graphql";
import { Trans, useI18n } from "@myoxus/i18n";
import { SignOutIcon } from "@myoxus/icons/react";
import {
  AuthActionStack,
  AuthPageContainer,
  ThemedImg,
  Avatar,
  type AvatarProps,
  Box,
  Button,
  Group,
  IconButton,
  MyoxusText,
  Stack,
  type User,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

type InviteInfo = GetInviteInfoQuery["getInviteInfo"];

function WorkspaceAvatar({
  inviteInfo,
  size = "sm",
}: {
  inviteInfo?: InviteInfo;
  size?: AvatarProps["size"];
}) {
  return (
    <Avatar
      url={
        inviteInfo?.workspace.avatar
          ? `data:image/png;base64,${inviteInfo.workspace.avatar}`
          : undefined
      }
      name={inviteInfo?.workspace.name}
      size={size}
      colorfulFallback
    />
  );
}

function InviteSummary({ inviteInfo }: { inviteInfo?: InviteInfo }) {
  const t = useI18n();
  const inviterName = inviteInfo?.user?.name ?? t["admin.common.unknown"]();
  const inviterAvatar = inviteInfo?.user?.avatarUrl ?? "";
  return (
    <Group
      align="center"
      gap="sm"
      wrap="wrap"
      data-myoxus-ui-role="invite-summary"
    >
      <AuthActionStack direction="row" align="center">
        <Avatar url={inviterAvatar} name={inviterName} size="sm" />
        <InviteEmphasis>{inviterName}</InviteEmphasis>
      </AuthActionStack>
      <MyoxusText component="span" tone="secondary" typographySlot="body">
        {t["invited you to join"]()}
      </MyoxusText>
      <AuthActionStack direction="row" align="center">
        <WorkspaceAvatar inviteInfo={inviteInfo} />
        <InviteEmphasis>{inviteInfo?.workspace.name}</InviteEmphasis>
      </AuthActionStack>
    </Group>
  );
}

function InviteBodyText({ children }: { children: ReactNode }) {
  return (
    <MyoxusText component="div" tone="secondary" typographySlot="body">
      {children}
    </MyoxusText>
  );
}

function InviteInlineAvatar({ inviteInfo }: { inviteInfo?: InviteInfo }) {
  return (
    <Box
      component="span"
      display="inline-flex"
      data-myoxus-ui-role="invite-inline-avatar"
    >
      <WorkspaceAvatar inviteInfo={inviteInfo} />
    </Box>
  );
}

function InviteEmphasis({ children }: { children?: ReactNode }) {
  return (
    <MyoxusText component="span" tone="primary" typographySlot="body">
      <strong>{children}</strong>
    </MyoxusText>
  );
}

function InviteUserLine({
  user,
  onSignOut,
}: {
  user: User;
  onSignOut: () => void;
}) {
  const t = useI18n();
  return (
    <AuthActionStack direction="row" align="center">
      <Avatar url={user.avatar ?? user.image} name={user.label} />
      <MyoxusText component="span" tone="secondary" typographySlot="body-small">
        {user.email}
      </MyoxusText>
      <IconButton
        aria-label={t["404.signOut"]()}
        onClick={onSignOut}
        size={"calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))"}
        tooltip={t["404.signOut"]()}
      >
        <SignOutIcon />
      </IconButton>
    </AuthActionStack>
  );
}

export const ExpiredPage = ({ onOpenMyoxus }: { onOpenMyoxus: () => void }) => {
  const t = useI18n();
  return (
    <AuthPageContainer
      media={
        <ThemedImg fluid alt="" lightSrc={getArtworkUrl("invitation-error")} />
      }
      title={t["com.myoxus.expired.page.title"]()}
      subtitle={t["com.myoxus.expired.page.new-subtitle"]()}
    >
      <Button variant="primary" size="large" onClick={onOpenMyoxus}>
        {t["com.myoxus.auth.open.myoxus"]()}
      </Button>
    </AuthPageContainer>
  );
};

export const AcceptInvitePage = ({
  onOpenWorkspace,
  inviteInfo,
}: {
  onOpenWorkspace: () => void;
  inviteInfo: InviteInfo;
}) => {
  const t = useI18n();
  return (
    <AuthPageContainer
      media={
        <ThemedImg
          fluid
          alt=""
          lightSrc={getArtworkUrl("invitation-success")}
        />
      }
      title={t["Successfully joined!"]()}
      subtitle={<InviteSummary inviteInfo={inviteInfo} />}
    >
      <Button variant="primary" size="large" onClick={onOpenWorkspace}>
        {t["Visit Workspace"]()}
      </Button>
    </AuthPageContainer>
  );
};

export const JoinFailedPage = ({
  inviteInfo,
  error,
}: {
  inviteInfo?: InviteInfo;
  error?: unknown;
}) => {
  const userFriendlyError = UserFriendlyError.fromAny(error);
  const t = useI18n();
  return (
    <AuthPageContainer
      media={
        <ThemedImg fluid alt="" lightSrc={getArtworkUrl("invitation-error")} />
      }
      title={t["com.myoxus.fail-to-join-workspace.title"]()}
      subtitle={
        userFriendlyError.name === ErrorNames.MEMBER_QUOTA_EXCEEDED ? (
          <InviteBodyText>
            <Trans
              i18nKey="com.myoxus.fail-to-join-workspace.description-1"
              components={{
                1: <InviteInlineAvatar inviteInfo={inviteInfo} />,
                2: <InviteEmphasis />,
              }}
              values={{ workspaceName: inviteInfo?.workspace.name }}
            />
            <MyoxusText component="div" tone="secondary" typographySlot="body">
              {t["com.myoxus.fail-to-join-workspace.description-2"]()}
            </MyoxusText>
          </InviteBodyText>
        ) : (
          <InviteBodyText>
            {t["error." + userFriendlyError.name]()}
            <br />
            {userFriendlyError.message}
          </InviteBodyText>
        )
      }
    />
  );
};

export const RequestToJoinPage = ({
  user,
  inviteInfo,
  requestToJoin,
  onSignOut,
}: {
  user: User | null;
  inviteInfo?: InviteInfo;
  requestToJoin: () => void;
  onSignOut: () => void;
}) => {
  const t = useI18n();
  return (
    <AuthPageContainer subtitle={<InviteSummary inviteInfo={inviteInfo} />}>
      <Stack
        gap={"calc(var(--mantine-spacing-xl) + var(--mantine-spacing-xs))"}
      >
        <Button variant="primary" size="large" onClick={requestToJoin}>
          {inviteInfo?.status === WorkspaceMemberStatus.Pending
            ? t["com.myoxus.notification.invitation.accept"]()
            : t["com.myoxus.request-to-join-workspace.button"]()}
        </Button>
        {user ? <InviteUserLine user={user} onSignOut={onSignOut} /> : null}
      </Stack>
    </AuthPageContainer>
  );
};

export const SentRequestPage = ({
  user,
  inviteInfo,
}: {
  user: User | null;
  inviteInfo: InviteInfo;
}) => {
  const t = useI18n();
  return (
    <AuthPageContainer
      title={t["com.myoxus.sent-request-to-join-workspace.title"]()}
      subtitle={
        <InviteBodyText>
          <Trans
            i18nKey="com.myoxus.sent-request-to-join-workspace.description"
            components={{
              1: <InviteInlineAvatar inviteInfo={inviteInfo} />,
              2: <InviteEmphasis />,
              3: <InviteEmphasis />,
            }}
            values={{
              workspaceName: inviteInfo.workspace.name,
              userEmail: user?.email,
            }}
          />
        </InviteBodyText>
      }
    />
  );
};
