import { PublicUserService } from "@myoxus/core/modules/server";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Avatar,
  BadgeListItem,
  RemovableBadge,
  Skeleton,
} from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

export interface MemberItemProps {
  userId: string;
  idx?: number;
  maxWidth?: number | string;
  focused?: boolean;
  onRemove?: () => void;
  style?: React.CSSProperties;
}

export const MemberItem = ({
  userId,
  idx,
  focused,
  onRemove,
  style,
  maxWidth,
}: MemberItemProps) => {
  const t = useI18n();
  const handleRemove = useCallback(() => {
    onRemove?.();
  }, [onRemove]);

  const publicUserService = useService(PublicUserService);
  const member = useLiveData(publicUserService.publicUser$(userId));
  const isLoading = useLiveData(publicUserService.isLoading$(userId));
  useEffect(() => {
    if (userId) {
      publicUserService.revalidate(userId);
    }
  }, [userId, publicUserService]);

  if (!member || ("removed" in member && member.removed)) {
    return (
      <BadgeListItem data-idx={idx} style={style}>
        <RemovableBadge
          selected={focused}
          removeLabel={t["com.myoxus.common.remove-item"]({
            item: t["Unknown User"](),
          })}
          onRemove={onRemove ? handleRemove : undefined}
          data-testid="member-selector-chip"
          style={maxWidth ? { maxWidth } : undefined}
        >
          {isLoading ? <Skeleton width="3em" /> : t["Unknown User"]()}
        </RemovableBadge>
      </BadgeListItem>
    );
  }
  const { name, avatarUrl } = member;

  return (
    <BadgeListItem data-idx={idx} title={name ?? undefined} style={style}>
      <RemovableBadge
        selected={focused}
        prefix={<Avatar url={avatarUrl} name={name ?? ""} size="xs" />}
        removeLabel={t["com.myoxus.common.remove-item"]({
          item: name ?? t["Unknown User"](),
        })}
        onRemove={onRemove ? handleRemove : undefined}
        data-testid="member-selector-chip"
        style={maxWidth ? { maxWidth } : undefined}
      >
        {name}
      </RemovableBadge>
    </BadgeListItem>
  );
};
