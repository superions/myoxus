import { useSignOut } from "@myoxus/core/components/hooks/myoxus/use-sign-out";
import { ConfigModal } from "@myoxus/core/components/mobile";
import { GlobalDialogService } from "@myoxus/core/modules/dialogs";
import { AuthService } from "@myoxus/core/modules/server";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListSelectionSlot,
  SurfaceListSpacer,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { type ReactNode } from "react";

import { SettingGroup } from "../group";

export const UserProfile = () => {
  const session = useService(AuthService).session;
  const loginStatus = useLiveData(session.status$);

  return loginStatus === "authenticated" ? (
    <AuthorizedUserProfile />
  ) : (
    <UnauthorizedUserProfile />
  );
};

const BaseLayout = ({
  avatar,
  title,
  caption,
  onClick,
}: {
  avatar: ReactNode;
  title: ReactNode;
  caption: ReactNode;
  onClick?: () => void;
}) => {
  return (
    <SettingGroup>
      <ConfigModal.Row
        onClick={onClick}
        data-myoxus-ui-role="mobile-setting-user-profile-row"
      >
        <SurfaceListItemIcon size="lg">{avatar}</SurfaceListItemIcon>
        <SurfaceListItemMain compact grow>
          <SurfaceListText kind="title">{title}</SurfaceListText>
          <SurfaceListText kind="description">{caption}</SurfaceListText>
        </SurfaceListItemMain>
        <SurfaceListSpacer />
        <SurfaceListSelectionSlot>
          <ArrowRightSmallIcon aria-hidden />
        </SurfaceListSelectionSlot>
      </ConfigModal.Row>
    </SettingGroup>
  );
};

const AuthorizedUserProfile = () => {
  const session = useService(AuthService).session;
  const account = useLiveData(session.account$);
  const confirmSignOut = useSignOut();

  return (
    <BaseLayout
      avatar={<Avatar size="lg" url={account?.avatar} name={account?.label} />}
      caption={account?.email}
      title={account?.label}
      onClick={confirmSignOut}
    />
  );
};

const UnauthorizedUserProfile = () => {
  const globalDialogService = useService(GlobalDialogService);

  return (
    <BaseLayout
      onClick={() => globalDialogService.open("sign-in", {})}
      avatar={<Avatar size="lg" />}
      title="Sign up / Sign in"
      caption="Sync with Myoxus Cloud"
    />
  );
};
