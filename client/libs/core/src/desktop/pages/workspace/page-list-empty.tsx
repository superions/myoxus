/**
 * Empty-state components for list views.
 *
 * Thin wrappers that combine an optional heading slot with the appropriate
 * illustration and call-to-action copy from `@myoxus/core/components/myoxus/empty`.
 *
 * - `EmptyPageList` — used by the all-docs and tag-detail views when there are
 *   no matching documents. The `type` prop switches between the generic
 *   "all docs" and the "trash" variant.
 * - `EmptyCollectionList` — used by the all-collections view.
 *
 * Each component accepts an optional `heading` node so the calling page can
 * insert a header (e.g. the create-tag input) above the illustration.
 */
import { EmptyDocs } from "@myoxus/core/components/myoxus/empty";
import { EmptyCollections } from "@myoxus/core/components/myoxus/empty/collections";
import { Stack } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

/**
 * Empty-state component for document list views.
 *
 * @param type - `'all'` for the regular all-docs empty state, `'trash'` for
 *   the trash-specific variant with different copy and illustration.
 * @param heading - Optional header node rendered above the illustration (e.g.
 *   action buttons or a title).
 * @param tagId - Optional tag ID passed to `<EmptyDocs>` to contextualise the
 *   empty-state copy (e.g. "No documents with this tag").
 */
export const EmptyPageList = ({
  type,
  heading,
  tagId,
}: {
  type: "all" | "trash";
  heading?: ReactNode;
  tagId?: string;
}) => {
  return (
    <Stack flex={1} h="100%" mih={0} data-myoxus-ui-role="page-list-empty">
      {heading}
      <EmptyDocs tagId={tagId} type={type} />
    </Stack>
  );
};

/**
 * Empty-state component for the all-collections view.
 *
 * @param heading - Optional header node rendered above the illustration.
 * @param showAction - Whether the generic empty-state CTA is rendered. Routes
 *   that already expose the same primary action in the Workbench header keep
 *   this disabled to avoid competing create buttons.
 */
export const EmptyCollectionList = ({
  heading,
  showAction = true,
}: {
  heading: ReactNode;
  showAction?: boolean;
}) => {
  return (
    <Stack
      flex={1}
      h="100%"
      mih={0}
      data-myoxus-ui-role="page-list-empty:collections"
    >
      {heading}
      <EmptyCollections {...(showAction ? {} : { action: null })} />
    </Stack>
  );
};
