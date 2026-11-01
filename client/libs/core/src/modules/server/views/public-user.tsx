import { useCurrentServerService } from "@myoxus/core/components/providers/current-server-scope";
import { useI18n } from "@myoxus/i18n";
import { useLiveData } from "@myoxus/infra";
import {
  Avatar,
  type AvatarProps,
  Group,
  MyoxusText,
  Tooltip,
} from "@myoxus/ui-facade";
import { type ComponentType, useLayoutEffect, useMemo } from "react";

import { PublicUserService } from "../services/public-user";

type PublicUserLabelAlign = "baseline" | "center";

export const PublicUserLabel = ({
  id,
  size = "xs",
  showName = true,
  tooltip: NameTip,
  align = "baseline",
}: {
  id: string;
  size?: AvatarProps["size"];
  showName?: boolean;
  tooltip?: ComponentType<{ userName: string }>;
  align?: PublicUserLabelAlign;
}) => {
  const serverService = useCurrentServerService();
  const publicUser = useMemo(() => {
    return serverService?.scope.get(PublicUserService);
  }, [serverService]);

  useLayoutEffect(() => {
    if (publicUser) {
      publicUser.revalidate(id);
    }
  }, [id, publicUser]);

  const user = useLiveData(publicUser?.publicUser$(id));
  const isLoading = useLiveData(publicUser?.isLoading$(id));
  const t = useI18n();

  if (isLoading && !user) {
    return (
      <MyoxusText
        component="span"
        tone="secondary"
        typographySlot="body-small"
        data-myoxus-ui-role="public-user-label-loading"
      >
        ...
      </MyoxusText>
    );
  }

  if (user?.removed) {
    return showName ? (
      <MyoxusText
        component="span"
        strikethrough
        tone="secondary"
        typographySlot="body-small"
        data-myoxus-ui-role="public-user-label-removed"
      >
        {t["Unknown User"]()}
      </MyoxusText>
    ) : (
      <Avatar size={size} name={t["Unknown User"]()} />
    );
  }

  return (
    <Tooltip
      content={
        NameTip ? (
          <NameTip userName={user?.name || t["Unknown User"]()} />
        ) : null
      }
    >
      <Group
        component="span"
        align={align}
        display="inline-flex"
        gap={showName ? "xs" : undefined}
        wrap="nowrap"
        data-myoxus-ui-role="public-user-label"
      >
        <Avatar url={user?.avatar} name={user?.name ?? ""} size={size} />
        {showName && user?.name ? (
          <MyoxusText
            component="span"
            typographySlot="body-small"
            data-myoxus-ui-role="public-user-label-name"
          >
            {user.name}
          </MyoxusText>
        ) : null}
      </Group>
    </Tooltip>
  );
};
