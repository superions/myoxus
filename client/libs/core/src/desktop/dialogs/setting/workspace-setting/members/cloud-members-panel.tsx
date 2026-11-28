// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { Upload } from "@myoxus/core/components/pure/file-upload";
import { WorkspaceMembersService } from "@myoxus/core/modules/permissions";
import { WorkspaceQuotaService } from "@myoxus/core/modules/quota";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import { emailRegex } from "@myoxus/core/utils/email-regex";
import { UserFriendlyError } from "@myoxus/error";
import { WorkspaceInviteLinkExpireTime } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ExportIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  Button,
  ConfirmModal,
  FieldError,
  Group,
  Input,
  Loading,
  Menu,
  MenuItem,
  MenuTrigger,
  MyoxusText,
  notify,
  RadioGroup,
  SettingsControlEmpty,
  SettingsNotice,
  SettingsPage,
  SettingsSection,
  Stack,
} from "../../primitives";
import { ExistingUserInviteDialog } from "./existing-user-invite-dialog";
import { MemberList } from "./member-list";

export interface InviteWorkspaceMemberModalProps {
  open: boolean;
  setOpen: (value: boolean) => void;
  onConfirm: (params: { emails: string[] }) => void;
  isMutating: boolean;
  copyTextToClipboard: (text: string) => Promise<boolean>;
  onGenerateInviteLink: (
    expireTime: WorkspaceInviteLinkExpireTime,
  ) => Promise<string>;
  onRevokeInviteLink: () => Promise<boolean>;
  importCSV: ReactNode;
  invitationLink: { link: string; expireTime?: string | null } | null;
  serverUserInvite?: ReactNode;
}

type InviteMethod = "email" | "link" | "server-user";

const EXPIRY_DAY_COUNTS: Array<[WorkspaceInviteLinkExpireTime, string]> = [
  [WorkspaceInviteLinkExpireTime.OneDay, "1"],
  [WorkspaceInviteLinkExpireTime.ThreeDays, "3"],
  [WorkspaceInviteLinkExpireTime.OneWeek, "7"],
  [WorkspaceInviteLinkExpireTime.OneMonth, "30"],
];

function deduplicateEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  return emails.filter((email) => {
    const normalized = email.trim().toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

async function parseCsvEmails(blob: Blob): Promise<string[]> {
  try {
    const content = await blob.text();
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && emailRegex.test(line));
  } catch (error) {
    console.error("Error parsing CSV:", error);
    throw new Error("Failed to parse CSV");
  }
}

function InviteWorkspaceMemberModal({
  open,
  setOpen,
  onConfirm,
  isMutating,
  copyTextToClipboard: copyLink,
  onGenerateInviteLink,
  onRevokeInviteLink,
  importCSV,
  invitationLink,
  serverUserInvite,
}: InviteWorkspaceMemberModalProps) {
  const t = useI18n();
  const [inviteEmails, setInviteEmails] = useState("");
  const [isValidEmail, setIsValidEmail] = useState(true);
  const [inviteMethod, setInviteMethod] = useState<InviteMethod>("email");
  const [selectedExpiry, setSelectedExpiry] =
    useState<WorkspaceInviteLinkExpireTime>(
      WorkspaceInviteLinkExpireTime.OneWeek,
    );

  const expiryItems = useMemo(
    () =>
      EXPIRY_DAY_COUNTS.map(([value, days]) => (
        <MenuItem key={value} onSelect={() => setSelectedExpiry(value)}>
          {t["com.myoxus.member.invite.expiration-date"]({ number: days })}
        </MenuItem>
      )),
    [t],
  );

  const selectedExpiryDays =
    EXPIRY_DAY_COUNTS.find(([value]) => value === selectedExpiry)?.[1] ?? "7";
  const selectedExpiryLabel = t["com.myoxus.member.invite.expiration-date"]({
    number: selectedExpiryDays,
  });

  const handleConfirm = useCallback(() => {
    if (inviteMethod !== "email") {
      setOpen(false);
      return;
    }
    const emails = inviteEmails
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (emails.some((entry) => !emailRegex.test(entry))) {
      setIsValidEmail(false);
      return;
    }
    setIsValidEmail(true);
    onConfirm({ emails });
  }, [inviteEmails, inviteMethod, onConfirm, setOpen]);

  return (
    <ConfirmModal
      open={open}
      onOpenChange={setOpen}
      title={t["com.myoxus.member.invite.title"]()}
      cancelText={t["com.myoxus.inviteModal.button.cancel"]()}
      confirmText={
        inviteMethod === "email"
          ? t["com.myoxus.member.invite.send-invites"]()
          : t["com.myoxus.member.invite.done"]()
      }
      confirmButtonOptions={{ loading: isMutating, variant: "primary" }}
      onConfirm={handleConfirm}
      contentOptions={{ ["data-testid" as string]: "invite-modal" }}
    >
      <SettingsSection
        description={t["com.myoxus.member.invite.description"]()}
      >
        <RadioGroup
          value={inviteMethod}
          onChange={setInviteMethod}
          items={[
            {
              value: "email",
              label: t["com.myoxus.member.invite.email-invite"](),
            },
            {
              value: "link",
              label: t["com.myoxus.member.invite.invite-link"](),
            },
            ...(serverUserInvite
              ? [
                  {
                    value: "server-user" as const,
                    label:
                      t["com.myoxus.workspace.invite.existing-user.title"](),
                  },
                ]
              : []),
          ]}
        />
        {inviteMethod === "email" ? (
          <>
            <Input
              block
              disabled={isMutating}
              placeholder={t["com.myoxus.member.invite.email-placeholder"]()}
              value={inviteEmails}
              onChange={setInviteEmails}
              onEnter={handleConfirm}
              size="large"
              status={isValidEmail ? "default" : "error"}
            />
            {!isValidEmail ? (
              <FieldError>{t["com.myoxus.auth.sign.email.error"]()}</FieldError>
            ) : null}
            {importCSV}
          </>
        ) : inviteMethod === "link" ? (
          <>
            <Menu items={expiryItems}>
              <MenuTrigger block>{selectedExpiryLabel}</MenuTrigger>
            </Menu>
            {invitationLink ? (
              <Input block value={invitationLink.link} disabled size="large" />
            ) : null}
            <Group data-myoxus-ui-role="member-invite-link-actions">
              <Button
                onClick={() => {
                  onGenerateInviteLink(selectedExpiry).catch((error) => {
                    console.error("Failed to generate invitation link", error);
                    notify.error({ title: t["UNKNOWN_ERROR"]() });
                  });
                }}
              >
                {t["com.myoxus.member.invite.generate"]()}
              </Button>
              {invitationLink ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void copyLink(invitationLink.link).then(() =>
                        notify.success({
                          title: t["Copied link to clipboard"](),
                        }),
                      )
                    }
                  >
                    {t["com.myoxus.member.invite.copy"]()}
                  </Button>
                  <Button variant="plain" onClick={onRevokeInviteLink}>
                    {t["com.myoxus.member.revoke"]()}
                  </Button>
                </>
              ) : null}
            </Group>
          </>
        ) : (
          serverUserInvite
        )}
      </SettingsSection>
    </ConfirmModal>
  );
}

function InviteResultSummary({ failedEmails }: { failedEmails: string[] }) {
  const t = useI18n();
  if (failedEmails.length === 0) {
    return t["Invitation sent hint"]();
  }
  return (
    <Stack>
      <MyoxusText typographySlot="body-small">
        {t["com.myoxus.member.invite.notify.fail-message"]()}
      </MyoxusText>
      {failedEmails.map((email, index) => (
        <MyoxusText
          key={`${index}:${email}`}
          tone="secondary"
          typographySlot="body-small"
        >
          {email}
        </MyoxusText>
      ))}
    </Stack>
  );
}

export const MembersPanelFallback = () => {
  const t = useI18n();
  return (
    <SettingsPage title={t["Members"]()} subtitle={t["Members hint"]()}>
      <SettingsSection title={t["Members"]()}>
        <Group data-myoxus-ui-role="settings-member-loading">
          <Loading />
          <SettingsControlEmpty>
            {t["com.myoxus.settings.member.loading"]()}
          </SettingsControlEmpty>
        </Group>
      </SettingsSection>
    </SettingsPage>
  );
};

export const CloudWorkspaceMembersPanel = () => {
  const t = useI18n();
  const workspaceId = useService(WorkspaceService).workspace.id;
  const sharePreview = useService(WorkspaceShareSettingService).sharePreview;
  const membersService = useService(WorkspaceMembersService);
  const workspaceQuotaService = useService(WorkspaceQuotaService);
  const canManageUsers = useGuard("Workspace_Users_Manage");

  const inviteLink = useLiveData(sharePreview.inviteLink$);
  const isLoading = useLiveData(workspaceQuotaService.quota.isRevalidating$);
  const error = useLiveData(workspaceQuotaService.quota.error$);
  const workspaceQuota = useLiveData(workspaceQuotaService.quota.quota$);

  const [openInvite, setOpenInvite] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    membersService.members.revalidate();
    workspaceQuotaService.quota.revalidate();
  }, [membersService, workspaceQuotaService]);

  const handleGenerateInviteLink = useCallback(
    async (expireTime: WorkspaceInviteLinkExpireTime) => {
      const { link } = await membersService.generateInviteLink(expireTime);
      sharePreview.revalidate();
      return link;
    },
    [membersService, sharePreview],
  );

  const handleRevokeInviteLink = useCallback(async () => {
    const success = await membersService.revokeInviteLink();
    sharePreview.revalidate();
    return success;
  }, [membersService, sharePreview]);

  const handleInviteBatch = useAsyncCallback(
    async ({ emails }: { emails: string[] }) => {
      setIsMutating(true);
      try {
        const uniqueEmails = deduplicateEmails(emails);
        const results = await membersService.inviteMembers(uniqueEmails);
        const failedEmails = results
          .filter((entry) => !entry.sentSuccess)
          .map((entry) => entry.email);
        notify({
          title: t["com.myoxus.member.invite.notify.title"]({
            successCount: String(uniqueEmails.length - failedEmails.length),
            failedCount: String(failedEmails.length),
          }),
          message: <InviteResultSummary failedEmails={failedEmails} />,
        });
        setOpenInvite(false);
        membersService.members.revalidate();
        workspaceQuotaService.quota.revalidate();
      } finally {
        setIsMutating(false);
      }
    },
    [membersService, t, workspaceQuotaService.quota],
  );

  const handleImportCsv = useAsyncCallback(
    async (file: File) => {
      setIsMutating(true);
      try {
        const emails = await parseCsvEmails(file);
        handleInviteBatch({ emails });
      } finally {
        setIsMutating(false);
      }
    },
    [handleInviteBatch],
  );

  if (workspaceQuota === null) {
    if (isLoading) {
      return <MembersPanelFallback />;
    }
    return (
      <SettingsNotice tone="error" role="alert">
        {error
          ? UserFriendlyError.fromAny(error).message
          : t["com.myoxus.settings.common.load-error"]()}
      </SettingsNotice>
    );
  }

  return (
    <SettingsPage title={t["Members"]()} subtitle={t["Members hint"]()}>
      <SettingsSection
        title={`${t["Members"]()} (${workspaceQuota.memberCount ?? 0})`}
        description={t["com.myoxus.member.description"]()}
        actions={
          canManageUsers ? (
            <Button onClick={() => setOpenInvite(true)}>
              {t["Invite Members"]()}
            </Button>
          ) : null
        }
      >
        {canManageUsers ? (
          <InviteWorkspaceMemberModal
            open={openInvite}
            setOpen={setOpenInvite}
            onConfirm={handleInviteBatch}
            isMutating={isMutating}
            copyTextToClipboard={copyTextToClipboard}
            onGenerateInviteLink={handleGenerateInviteLink}
            onRevokeInviteLink={handleRevokeInviteLink}
            importCSV={
              <Upload accept="text/csv" fileChange={handleImportCsv}>
                <Button prefix={<ExportIcon />} variant="secondary">
                  {t["com.myoxus.member.invite.import-csv"]()}
                </Button>
              </Upload>
            }
            invitationLink={inviteLink}
            serverUserInvite={
              <ExistingUserInviteDialog workspaceId={workspaceId} />
            }
          />
        ) : null}
        <MemberList />
      </SettingsSection>
    </SettingsPage>
  );
};
