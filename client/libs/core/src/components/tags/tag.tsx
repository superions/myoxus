import { useI18n } from "@myoxus/i18n";
import { ArchiveIcon } from "@myoxus/icons/react";
import { Badge, ColorSwatch, RemovableBadge } from "@myoxus/ui-facade";

import type { TagLike } from "./types";

export interface TagItemProps {
  tag: TagLike;
  idx?: number;
  mode: "inline-tag" | "list-tag" | "db-label";
  focused?: boolean;
  onRemoved?: () => void;
}

export const TagItem = ({
  tag,
  idx,
  mode,
  focused,
  onRemoved,
}: TagItemProps) => {
  const t = useI18n();
  const archivedLabel = tag.archived
    ? t["com.myoxus.tags.status.archived"]()
    : undefined;
  const commonProps = {
    "data-idx": idx,
    "data-focused": focused ? "true" : undefined,
    "data-tag-id": tag.id,
    "data-tag-value": tag.name,
    "data-tag-archived": tag.archived ? "true" : undefined,
    "aria-label": archivedLabel ? `${tag.name}, ${archivedLabel}` : tag.name,
    title: archivedLabel ? `${tag.name} - ${archivedLabel}` : tag.name,
    tagColorRole: tag.color,
  } as const;
  const prefix = tag.archived ? (
    <ArchiveIcon aria-hidden="true" />
  ) : mode === "db-label" ? undefined : (
    <ColorSwatch tagColorRole={tag.color} shape="circle" />
  );

  if (mode === "list-tag" && !onRemoved) {
    return (
      <Badge {...commonProps} prefix={prefix}>
        {tag.name}
      </Badge>
    );
  }

  return (
    <RemovableBadge
      {...commonProps}
      selected={focused}
      prefix={prefix}
      removeLabel={t["com.myoxus.common.remove-item"]({ item: tag.name })}
      onRemove={onRemoved}
      data-testid={onRemoved ? "tag-removable-badge" : undefined}
    >
      {tag.name}
    </RemovableBadge>
  );
};
