import { useGuard } from "@myoxus/core/components/guard";
import { DocService } from "@myoxus/core/modules/doc";
import { ServerService } from "@myoxus/core/modules/server";
import { ShareInfoService } from "@myoxus/core/modules/share-doc";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Divider,
  Group,
  MenuSection,
  MenuSectionLabel,
  MyoxusText,
  Skeleton,
  Stack,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import { Suspense, useEffect } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { CloudSvg } from "../cloud-svg";
import { CopyLinkButton } from "./copy-link-button";
import { MembersPermission, PublicDoc } from "./general-access";
import { InviteInput } from "./invite-member-editor";
import { MembersRow } from "./member-management";
import type { ShareMenuProps } from "./share-menu";

export const LocalSharePage = (props: ShareMenuProps) => {
  const t = useI18n();
  const {
    workspaceMetadata: { id: workspaceId },
  } = props;
  return (
    <Stack>
      <SurfaceListItem
        component="section"
        role="group"
        density="default"
        layout="block"
        muted
        data-myoxus-ui-role="share-menu-local-cloud-panel"
      >
        <Group align="center" justify="space-between" wrap="wrap">
          <Stack flex={1} miw={0}>
            <MyoxusText tone="secondary" typographySlot="body-small">
              {t["Enable Myoxus Cloud Description"]()}
            </MyoxusText>
            <Button
              onClick={props.onEnableServer}
              variant="primary"
              data-testid="share-menu-enable-myoxus-cloud-button"
            >
              {t["Enable Myoxus Cloud"]()}
            </Button>
          </Stack>
          <Group flex="0 0 auto" aria-hidden>
            <CloudSvg />
          </Group>
        </Group>
      </SurfaceListItem>
      <CopyLinkButton workspaceId={workspaceId} secondary />
    </Stack>
  );
};

export const MyoxusSharePage = (
  props: ShareMenuProps & {
    onClickInvite: () => void;
    onClickMembers: () => void;
  },
) => {
  const t = useI18n();
  const {
    workspaceMetadata: { id: workspaceId },
  } = props;
  const shareInfoService = useService(ShareInfoService);
  const serverService = useService(ServerService);
  const docService = useService(DocService);

  const canManageUsers = useGuard("Doc_Users_Manage", docService.doc.id);

  const canPublish = useGuard("Doc_Publish", docService.doc.id);

  useEffect(() => {
    shareInfoService.shareInfo.revalidate();
  }, [shareInfoService]);

  const isSharedPage = useLiveData(shareInfoService.shareInfo.isShared$);
  const sharedMode = useLiveData(shareInfoService.shareInfo.sharedMode$);
  const baseUrl = serverService.server.baseUrl;
  const isLoading =
    isSharedPage === null || sharedMode === null || baseUrl === null;

  if (isLoading) {
    return (
      <Stack>
        <Skeleton height={"calc(var(--mantine-spacing-2xl) * 2)"} />
        <Skeleton
          height={
            "calc(var(--mantine-spacing-2xl) + var(--mantine-spacing-sm))"
          }
        />
      </Stack>
    );
  }

  return (
    <Stack data-myoxus-ui-role="share-menu-page">
      <MenuSection>
        {canManageUsers && <InviteInput onFocus={props.onClickInvite} />}
        <MembersRow onClick={props.onClickMembers} />
        <MenuSectionLabel>
          {t["com.myoxus.share-menu.generalAccess"]()}
        </MenuSectionLabel>
        <MembersPermission disabled={!canManageUsers} />
        <PublicDoc disabled={!canPublish} />
      </MenuSection>
      <Divider space="sm" />
      <CopyLinkButton workspaceId={workspaceId} />
    </Stack>
  );
};

export const SharePage = (
  props: ShareMenuProps & {
    onClickInvite: () => void;
    onClickMembers: () => void;
  },
) => {
  if (props.workspaceMetadata.flavour === "local") {
    return <LocalSharePage {...props} />;
  } else {
    return (
      // TODO(@eyhn): refactor this part
      <ErrorBoundary fallback={null}>
        <Suspense>
          <MyoxusSharePage {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  }
};
