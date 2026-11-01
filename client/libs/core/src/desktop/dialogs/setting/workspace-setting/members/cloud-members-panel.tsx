import { useGuard } from "@myoxus/core/components/guard/use-guard";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { Upload } from "@myoxus/core/components/pure/file-upload";
import { WorkspaceMembersService } from "@myoxus/core/modules/permissions";
import { WorkspaceQuotaService } from "@myoxus/core/modules/quota";
import { formatMemberLimit } from "@myoxus/core/modules/quota/utils/quota-display";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import { emailRegex } from "@myoxus/core/utils/email-regex";
import { UserFriendlyError } from "@myoxus/error";
import { WorkspaceInviteLinkExpireTime } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { ExportIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  importCSV: React.ReactNode;
  invitationLink: { link: string; expireTime?: string | null } | null;
  serverUserInvite?: React.ReactNode;
}

type InviteMethodType = "email" | "link" | "server-user";

const INVITE_LINK_EXPIRY_OPTIONS = [
  WorkspaceInviteLinkExpireTime.OneDay,
  WorkspaceInviteLinkExpireTime.ThreeDays,
  WorkspaceInviteLinkExpireTime.OneWeek,
  WorkspaceInviteLinkExpireTime.OneMonth,
];

const InviteWorkspaceMemberModal = ({
  open,
  setOpen,
  onConfirm,
  isMutating,
  copyTextToClipboard,
  onGenerateInviteLink,
  onRevokeInviteLink,
  importCSV,
  invitationLink,
  serverUserInvite,
}: InviteWorkspaceMemberModalProps) => {
  const t = useI18n();
  const [inviteEmails, setInviteEmails] = useState("");
  const [isValidEmail, setIsValidEmail] = useState(true);
  const [inviteMethod, setInviteMethod] = useState<InviteMethodType>("email");
  const [selectedExpiry, setSelectedExpiry] =
    useState<WorkspaceInviteLinkExpireTime>(
      WorkspaceInviteLinkExpireTime.OneWeek,
    );

  const expiryItems = useMemo(
    () =>
      INVITE_LINK_EXPIRY_OPTIONS.map((value) => (
        <MenuItem key={value} onSelect={() => setSelectedExpiry(value)}>
          {t["com.myoxus.member.invite.expiration-date"]({
            number:
              value === WorkspaceInviteLinkExpireTime.OneDay
                ? "1"
                : value === WorkspaceInviteLinkExpireTime.ThreeDays
                  ? "3"
                  : value === WorkspaceInviteLinkExpireTime.OneWeek
                    ? "7"
                    : "30",
          })}
        </MenuItem>
      )),
    [t],
  );

  const selectedExpiryLabel = useMemo(() => {
    const dayCount =
      selectedExpiry === WorkspaceInviteLinkExpireTime.OneDay
        ? "1"
        : selectedExpiry === WorkspaceInviteLinkExpireTime.ThreeDays
          ? "3"
          : selectedExpiry === WorkspaceInviteLinkExpireTime.OneWeek
            ? "7"
            : "30";
    return t["com.myoxus.member.invite.expiration-date"]({
      number: dayCount,
    });
  }, [selectedExpiry, t]);

  const handleConfirm = useCallback(() => {
    if (inviteMethod === "link" || inviteMethod === "server-user") {
      setOpen(false);
      return;
    }
    const emails = inviteEmails
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.some((email) => !emailRegex.test(email))) {
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
      confirmButtonOptions={{
        loading: isMutating,
        variant: "primary",
      }}
      onConfirm={handleConfirm}
      contentOptions={{
        ["data-testid" as string]: "invite-modal",
      }}
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
                    notify.error({
                      title: t["UNKNOWN_ERROR"](),
                    });
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
                      copyTextToClipboard(invitationLink.link).then(() =>
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
};

const parseCSV = async (blob: Blob): Promise<string[]> => {
  try {
    const textContent = await blob.text();
    const emails = textContent
      .split("\n")
      .map((email) => email.trim())
      .filter((email) => email.length > 0 && emailRegex.test(email));

    return emails;
  } catch (error) {
    console.error("Error parsing CSV:", error);
    throw new Error("Failed to parse CSV");
  }
};

export const CloudWorkspaceMembersPanel = () => {
  const workspaceId = useService(WorkspaceService).workspace.id;
  const workspaceShareSettingService = useService(WorkspaceShareSettingService);
  const inviteLink = useLiveData(
    workspaceShareSettingService.sharePreview.inviteLink$,
  );
  const membersService = useService(WorkspaceMembersService);
  const canManageUsers = useGuard("Workspace_Users_Manage");

  useEffect(() => {
    membersService.members.revalidate();
  }, [membersService]);

  const workspaceQuotaService = useService(WorkspaceQuotaService);
  useEffect(() => {
    workspaceQuotaService.quota.revalidate();
  }, [workspaceQuotaService]);
  const isLoading = useLiveData(workspaceQuotaService.quota.isRevalidating$);
  const error = useLiveData(workspaceQuotaService.quota.error$);
  const workspaceQuota = useLiveData(workspaceQuotaService.quota.quota$);
  const t = useI18n();

  const [openInvite, setOpenInvite] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  const openInviteModal = useCallback(() => {
    // No subscription-canceled check — invite is always available
    setOpenInvite(true);
  }, []);

  const onGenerateInviteLink = useCallback(
    async (expireTime: WorkspaceInviteLinkExpireTime) => {
      const { link } = await membersService.generateInviteLink(expireTime);
      workspaceShareSettingService.sharePreview.revalidate();
      return link;
    },
    [membersService, workspaceShareSettingService.sharePreview],
  );

  const onRevokeInviteLink = useCallback(async () => {
    const success = await membersService.revokeInviteLink();
    workspaceShareSettingService.sharePreview.revalidate();
    return success;
  }, [membersService, workspaceShareSettingService.sharePreview]);

  const onInviteBatchConfirm = useAsyncCallback(
    async ({
      emails,
    }: Parameters<InviteWorkspaceMemberModalProps["onConfirm"]>[0]) => {
      setIsMutating(true);
      const uniqueEmails = deduplicateEmails(emails);
      const results = await membersService.inviteMembers(uniqueEmails);
      const unSuccessInvites = results.reduce<string[]>((acc, result) => {
        if (!result.sentSuccess) {
          acc.push(result.email);
        }
        return acc;
      }, []);
      if (results) {
        notify({
          title: t["com.myoxus.member.invite.notify.title"]({
            successCount: (
              uniqueEmails.length - unSuccessInvites.length
            ).toString(),
            failedCount: unSuccessInvites.length.toString(),
          }),
          message: <NotifyMessage unSuccessInvites={unSuccessInvites} />,
        });
        setOpenInvite(false);
        membersService.members.revalidate();
        workspaceQuotaService.quota.revalidate();
      }
      setIsMutating(false);
    },
    [membersService, t, workspaceQuotaService.quota],
  );

  const onImportCSV = useAsyncCallback(
    async (file: File) => {
      setIsMutating(true);
      const emails = await parseCSV(file);
      onInviteBatchConfirm({ emails });
      setIsMutating(false);
    },
    [onInviteBatchConfirm],
  );

  const desc = useMemo(() => {
    if (!workspaceQuota) return null;

    return t["com.myoxus.member.description"]();
  }, [t, workspaceQuota]);

  const title = useMemo(() => {
    const memberCount = workspaceQuota?.memberCount ?? 0;
    return `${t["Members"]()} (${memberCount}/${formatMemberLimit(
      workspaceQuota?.memberLimit,
      t["com.myoxus.storage.unlimited"](),
    )})`;
  }, [t, workspaceQuota?.memberCount, workspaceQuota?.memberLimit]);

  if (workspaceQuota === null) {
    if (isLoading) {
      return <MembersPanelFallback />;
    } else {
      return (
        <SettingsNotice tone="error" role="alert">
          {error
            ? UserFriendlyError.fromAny(error).message
            : t["com.myoxus.settings.common.load-error"]()}
        </SettingsNotice>
      );
    }
  }

  return (
    <SettingsPage title={t["Members"]()} subtitle={t["Members hint"]()}>
      <SettingsSection
        title={title}
        description={desc}
        actions={
          canManageUsers ? (
            <Button onClick={openInviteModal}>{t["Invite Members"]()}</Button>
          ) : null
        }
      >
        {canManageUsers ? (
          <InviteWorkspaceMemberModal
            open={openInvite}
            setOpen={setOpenInvite}
            onConfirm={onInviteBatchConfirm}
            isMutating={isMutating}
            copyTextToClipboard={copyTextToClipboard}
            onGenerateInviteLink={onGenerateInviteLink}
            onRevokeInviteLink={onRevokeInviteLink}
            importCSV={<ImportCSV onImport={onImportCSV} />}
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

const NotifyMessage = ({
  unSuccessInvites,
}: {
  unSuccessInvites: string[];
}) => {
  const t = useI18n();

  if (unSuccessInvites.length === 0) {
    return t["Invitation sent hint"]();
  }

  return (
    <Stack>
      <MyoxusText typographySlot="body-small">
        {t["com.myoxus.member.invite.notify.fail-message"]()}
      </MyoxusText>
      {unSuccessInvites.map((email, index) => (
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
};

export const MembersPanelFallback = () => {
  const t = useI18n();

  return (
    <SettingsPage title={t["Members"]()} subtitle={t["Members hint"]()}>
      <SettingsSection title={t["Members"]()}>
        <MemberListFallback />
      </SettingsSection>
    </SettingsPage>
  );
};

const MemberListFallback = () => {
  const t = useI18n();

  return (
    <Group data-myoxus-ui-role="settings-member-loading">
      <Loading />
      <SettingsControlEmpty>
        {t["com.myoxus.settings.member.loading"]()}
      </SettingsControlEmpty>
    </Group>
  );
};

const ImportCSV = ({ onImport }: { onImport: (file: File) => void }) => {
  const t = useI18n();

  return (
    <Upload accept="text/csv" fileChange={onImport}>
      <Button prefix={<ExportIcon />} variant="secondary">
        {t["com.myoxus.member.invite.import-csv"]()}
      </Button>
    </Upload>
  );
};

function deduplicateEmails(emails: string[]): string[] {
  const seenEmails = new Set<string>();
  return emails.filter((email) => {
    const lowerCaseEmail = email.trim().toLowerCase();
    if (seenEmails.has(lowerCaseEmail)) {
      return false;
    } else {
      seenEmails.add(lowerCaseEmail);
      return true;
    }
  });
}
