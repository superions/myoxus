import { getArtworkUrl } from "@myoxus/theme/artwork";
import { useI18n } from "@myoxus/i18n";

import { EmptyLayout } from "./layout";
import type { UniversalEmptyProps } from "./types";

export const EmptyTags = (props: UniversalEmptyProps) => {
  const t = useI18n();

  return (
    <EmptyLayout
      illustrationLight={getArtworkUrl("tags")}
      title={t["com.myoxus.empty.tags.title"]()}
      description={t["com.myoxus.empty.tags.description"]()}
      {...props}
    />
  );
};
