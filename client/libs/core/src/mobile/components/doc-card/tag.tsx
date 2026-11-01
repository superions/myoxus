import { type Tag, TagService } from "@myoxus/core/modules/tag";
import { MoreHorizontalIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  BadgeList,
  BadgeListItem,
  ColorSwatch,
} from "@myoxus/ui-facade";

const DocCardTag = ({ tag }: { tag: Tag }) => {
  const name = useLiveData(tag.value$);
  const color = useLiveData(tag.color$);

  return (
    <BadgeListItem
      data-name={name}
      data-color={color}
      data-myoxus-ui-role="mobile-doc-card-tag-item"
    >
      <Badge prefix={<ColorSwatch aria-hidden color={color} shape="circle" />}>
        {name}
      </Badge>
    </BadgeListItem>
  );
};

const DocCardTagsRenderer = ({ tags }: { tags: Tag[] }) => {
  const hiddenTagCount = tags.length - 2;
  return (
    <BadgeList data-testid="doc-card-tags" grow>
      {tags.slice(0, 2).map((tag) => (
        <DocCardTag key={tag.id} tag={tag} />
      ))}
      {hiddenTagCount > 0 ? (
        <BadgeListItem data-myoxus-ui-role="mobile-doc-card-more-tags">
          <Badge
            aria-label={`${hiddenTagCount} more tags`}
            prefix={<MoreHorizontalIcon aria-hidden />}
          >
            {hiddenTagCount}
          </Badge>
        </BadgeListItem>
      ) : null}
    </BadgeList>
  );
};

export const DocCardTags = ({ docId }: { docId: string; rows?: number }) => {
  const tagService = useService(TagService);
  const tags = useLiveData(tagService.tagList.tagsByPageId$(docId));

  if (!tags.length) return null;
  return <DocCardTagsRenderer tags={tags} />;
};
