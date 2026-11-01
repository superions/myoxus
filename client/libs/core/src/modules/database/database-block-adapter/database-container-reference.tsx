// SPDX-License-Identifier: AGPL-3.0-or-later

import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import { databaseSummaryQuery, DatabaseSystemRole } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import type { FrameworkProvider } from "@myoxus/infra";
import {
  Button,
  Loading,
  MyoxusText,
  SelectableCardRow,
  Stack,
} from "@myoxus/ui-facade";
import useSWR from "swr";
import { useRef } from "react";

import { useTaskIdentity } from "../tasks/use-workspace-tasks";

/** A native scoped link reads only authorized metadata, never Views or Rows. */
export function DatabaseContainerReference({
  databaseId,
  framework,
  workspaceId,
}: {
  databaseId: string;
  framework: FrameworkProvider;
  workspaceId: string;
}) {
  const t = useI18n();
  const focusTarget = useRef<HTMLDivElement>(null);
  const owner = useTaskIdentity();
  const available =
    owner.availability.status === "available" &&
    owner.workspace.id === workspaceId &&
    owner.server &&
    owner.account;
  const read = useSWR(
    available
      ? ["database-container-reference", owner.identity, databaseId]
      : null,
    async () =>
      owner.server!.gql({
        query: databaseSummaryQuery,
        variables: { workspaceId, databaseId },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      suppressErrorNotification: true,
    },
  );
  const summary = available ? read.data?.workspace?.databaseSummary : undefined;
  const unavailable =
    read.error ||
    !summary ||
    summary.id !== databaseId ||
    summary.workspaceId !== workspaceId ||
    summary.deletedAt;
  return (
    <Stack
      data-testid="database-container-reference"
      ref={focusTarget}
      tabIndex={-1}
      aria-label={t["com.myoxus.database.embed.open"]()}
    >
      {available && read.isLoading ? (
        <Loading />
      ) : unavailable ? (
        <>
          <MyoxusText>
            {t["com.myoxus.database.embed.unavailable"]()}
          </MyoxusText>
          {available ? (
            <Button
              variant="secondary"
              onClick={() => {
                focusTarget.current?.focus();
                void read.mutate(undefined, {
                  revalidate: true,
                  throwOnError: false,
                });
              }}
            >
              {t.Retry()}
            </Button>
          ) : null}
        </>
      ) : summary ? (
        <SelectableCardRow
          type="button"
          onClick={() =>
            framework
              .get(WorkbenchService)
              .workbench.open(
                summary.systemRole === DatabaseSystemRole.WorkspaceTasks
                  ? "/tasks"
                  : `/databases/${summary.id}`,
                { at: "active" },
              )
          }
        >
          <MyoxusText>{summary.title}</MyoxusText>
        </SelectableCardRow>
      ) : null}
    </Stack>
  );
}
