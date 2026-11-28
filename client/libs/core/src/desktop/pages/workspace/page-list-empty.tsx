// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EmptyDocs } from "@myoxus/core/components/myoxus/empty";
import { EmptyCollections } from "@myoxus/core/components/myoxus/empty/collections";
import { Stack } from "@myoxus/ui-facade";
import type { ReactNode } from "react";

export function EmptyPageList({
  type,
  heading,
  tagId,
}: {
  type: "all" | "trash";
  heading?: ReactNode;
  tagId?: string;
}) {
  return (
    <Stack flex={1} h="100%" mih={0} data-myoxus-ui-role="page-list-empty">
      {heading}
      <EmptyDocs tagId={tagId} type={type} />
    </Stack>
  );
}

export function EmptyCollectionList({
  heading,
  showAction = true,
}: {
  heading: ReactNode;
  showAction?: boolean;
}) {
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
}
