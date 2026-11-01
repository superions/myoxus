import { useGuard } from "@myoxus/core/components/guard";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { ServerService } from "@myoxus/core/modules/server";
import { ShareDocsListService } from "@myoxus/core/modules/share-doc";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import {
  canonicalPublicDocUrl,
  notifyPublicDocPublished,
  notifyPublicDocRevoked,
  notifyPublicDocUnavailable,
  type PublicControlSource,
} from "@myoxus/core/modules/share-menu/view/share-menu/general-access";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { copyTextToClipboard } from "@myoxus/core/utils/clipboard";
import { UserFriendlyError } from "@myoxus/error";
import { PublicDocMode } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  GlobeIcon,
  InformationIcon,
  LinkIcon,
  LockIcon,
  ViewIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import track from "@myoxus/track";
import { Menu, MenuItem, notify } from "@myoxus/ui-facade";
import {
  type ComponentProps,
  memo,
  type ReactNode,
  useCallback,
  useRef,
} from "react";

import { PublicStatusTag } from "../../page-list/components/public-status-tag";

const source: PublicControlSource = "all-docs-globe";

export const AllDocsPublicStatusAction = memo(
  function AllDocsPublicStatusAction({ docId }: { docId: string }) {
    const t = useI18n();
    const canPublish = useGuard("Doc_Publish", docId, {
      revalidate: "if-missing",
    });
    const serverService = useService(ServerService);
    const workspaceDialogService = useService(WorkspaceDialogService);
    const shareDocsListService = useService(ShareDocsListService);
    const workspaceService = useService(WorkspaceService);
    const workspacePublication = useService(
      WorkspaceShareSettingService,
    ).sharePreview;
    const publiclyAccessible = useLiveData(
      workspacePublication.publiclyAccessible$,
    );
    const workspacePublicationLoading = useLiveData(
      workspacePublication.isLoading$,
    );
    const workspacePublicationError = useLiveData(workspacePublication.error$);
    const publicDeliveryEnabled = useLiveData(
      workspacePublication.publicDeliveryEnabled$,
    );
    const workspacePublic = useLiveData(workspacePublication.public$);
    const enableSharing = useLiveData(workspacePublication.enableSharing$);
    const canUpdateWorkspaceSettings = useGuard("Workspace_Settings_Update");
    const shareDocs = shareDocsListService.shareDocs;
    const statusButtonRef = useRef<HTMLButtonElement>(null);
    const restoreStatusFocus = useCallback(() => {
      statusButtonRef.current?.focus({ preventScroll: true });
    }, []);
    const mode = useLiveData(shareDocs?.publicMode$(docId) ?? null);
    const isLoading = useLiveData(shareDocs?.isLoading$ ?? null);
    const actionDisabled = !shareDocs || !canPublish || Boolean(isLoading);
    const publicationStateUnavailable =
      workspacePublicationLoading ||
      workspacePublicationError !== null ||
      publiclyAccessible === null;

    const publish = useAsyncCallback(
      async (nextMode: PublicDocMode) => {
        if (!shareDocs) {
          return;
        }

        try {
          await shareDocs.enableShare(docId, nextMode);
          track.$.sharePanel.$.createShareLink({
            control: source,
            mode: nextMode === PublicDocMode.Edgeless ? "edgeless" : "page",
          });
          notifyPublicDocPublished(t);
        } catch (error) {
          const err = UserFriendlyError.fromAny(error);
          if (err.is("DOC_NOT_FOUND")) {
            notifyPublicDocUnavailable(t);
            return;
          }
          notify.error({ title: err.name, message: err.message });
        } finally {
          restoreStatusFocus();
        }
      },
      [docId, restoreStatusFocus, shareDocs, t],
    );

    const revoke = useAsyncCallback(async () => {
      if (!shareDocs) {
        return;
      }

      try {
        await shareDocs.disableShare(docId);
        track.$.sharePanel.$.revokeShareLink({ control: source });
        notifyPublicDocRevoked(t);
      } catch (error) {
        const err = UserFriendlyError.fromAny(error);
        if (err.is("DOC_NOT_FOUND")) {
          notifyPublicDocUnavailable(t);
          return;
        }
        notify.error({ title: err.name, message: err.message });
      } finally {
        restoreStatusFocus();
      }
    }, [docId, restoreStatusFocus, shareDocs, t]);

    const copyPublicUrl = useAsyncCallback(async () => {
      if (!mode) {
        return;
      }

      const copied = await copyTextToClipboard(
        canonicalPublicDocUrl({
          baseUrl: serverService.server.baseUrl,
          docId,
          workspaceId: workspaceService.workspace.id,
        }),
      );
      if (copied) {
        track.$.sharePanel.$.copyShareLink({
          control: source,
          type: "public",
        });
        notify.success({ title: t["Copied link to clipboard"]() });
      }
    }, [
      docId,
      mode,
      serverService.server.baseUrl,
      t,
      workspaceService.workspace.id,
    ]);

    return (
      <Menu
        contentOptions={{
          align: "end",
          panelWidth: "comfortable",
          side: "bottom",
        }}
        items={
          <AllDocsPublicStatusMenuItems
            actionDisabled={actionDisabled}
            publishDisabled={
              actionDisabled ||
              publicationStateUnavailable ||
              !publiclyAccessible
            }
            copyDisabled={
              actionDisabled ||
              publicationStateUnavailable ||
              !publiclyAccessible ||
              !mode
            }
            currentMode={mode}
            workspaceExplanation={
              publiclyAccessible
                ? null
                : !publicDeliveryEnabled
                  ? t["com.myoxus.public-sharing.server-disabled"]()
                  : enableSharing === false
                    ? t[
                        "com.myoxus.public-sharing.workspace-sharing-disabled"
                      ]()
                    : workspacePublic === false
                      ? t["com.myoxus.public-sharing.workspace-private"]()
                      : t[
                          "com.myoxus.public-sharing.workspace-state-unavailable"
                        ]()
            }
            workspaceExplanationDisabled={
              publicationStateUnavailable || !canUpdateWorkspaceSettings
            }
            onCopyPublicUrl={copyPublicUrl}
            onOpenWorkspaceSettings={() =>
              workspaceDialogService.open("workspace-settings", {
                activeTab: "workspace:preference",
              })
            }
            onPublish={publish}
            onRevoke={revoke}
          />
        }
        rootOptions={{
          onOpen: () =>
            track.$.sharePanel.$.openPublicShareControl({
              control: source,
            }),
        }}
      >
        <PublicStatusTag
          data-testid="doc-list-public-status"
          disabled={actionDisabled}
          mode={publiclyAccessible ? mode : null}
          ref={statusButtonRef}
          size="small"
          tooltip={
            !shareDocs || !canPublish
              ? t["com.myoxus.public-sharing.permission-disabled"]()
              : mode && !publiclyAccessible
                ? t["com.myoxus.public-sharing.status.suspended"]()
                : undefined
          }
        />
      </Menu>
    );
  },
);

function AllDocsPublicStatusMenuItems({
  actionDisabled,
  publishDisabled,
  copyDisabled,
  currentMode,
  workspaceExplanation,
  workspaceExplanationDisabled,
  onCopyPublicUrl,
  onOpenWorkspaceSettings,
  onPublish,
  onRevoke,
}: {
  actionDisabled?: boolean;
  publishDisabled?: boolean;
  copyDisabled?: boolean;
  currentMode: PublicDocMode | null | undefined;
  workspaceExplanation: string | null;
  workspaceExplanationDisabled?: boolean;
  onCopyPublicUrl: () => void;
  onOpenWorkspaceSettings: () => void;
  onPublish: (mode: PublicDocMode) => void;
  onRevoke: () => void;
}) {
  const t = useI18n();
  const isShared = Boolean(currentMode);

  // All Documents renders many rows at once, so this menu intentionally works
  // from the workspace-level public-doc projection instead of creating a
  // DocScope ShareInfo entity for every row/card action.
  return (
    <>
      <AllDocsPublicStatusMenuItem
        disabled={publishDisabled}
        onSelect={() => onPublish(PublicDocMode.Page)}
        prefixIcon={<ViewIcon />}
        selected={currentMode === PublicDocMode.Page}
      >
        {t["com.myoxus.public-sharing.publish-page"]()}
      </AllDocsPublicStatusMenuItem>
      <AllDocsPublicStatusMenuItem
        disabled={publishDisabled}
        onSelect={() => onPublish(PublicDocMode.Edgeless)}
        prefixIcon={<GlobeIcon />}
        selected={currentMode === PublicDocMode.Edgeless}
      >
        {t["com.myoxus.public-sharing.publish-edgeless"]()}
      </AllDocsPublicStatusMenuItem>
      <AllDocsPublicStatusMenuItem
        disabled={actionDisabled || !isShared}
        onSelect={onRevoke}
        prefixIcon={<LockIcon />}
        selected={!isShared}
      >
        {t["com.myoxus.public-sharing.revoke"]()}
      </AllDocsPublicStatusMenuItem>
      {workspaceExplanation && (
        <AllDocsPublicStatusMenuItem
          closeMenuOnClick={false}
          disabled={workspaceExplanationDisabled}
          onSelect={onOpenWorkspaceSettings}
          prefixIcon={<InformationIcon />}
        >
          {workspaceExplanation}
        </AllDocsPublicStatusMenuItem>
      )}
      <AllDocsPublicStatusMenuItem
        disabled={copyDisabled}
        onSelect={onCopyPublicUrl}
        prefixIcon={<LinkIcon />}
      >
        {t["com.myoxus.public-sharing.copy-url"]()}
      </AllDocsPublicStatusMenuItem>
      <AllDocsPublicStatusMenuItem
        closeMenuOnClick={false}
        disabled
        prefixIcon={<InformationIcon />}
      >
        {t["com.myoxus.public-sharing.noindex-default"]()}
      </AllDocsPublicStatusMenuItem>
    </>
  );
}

function AllDocsPublicStatusMenuItem({
  children,
  ...props
}: ComponentProps<typeof MenuItem> & { children: ReactNode }) {
  return <MenuItem {...props}>{children}</MenuItem>;
}
