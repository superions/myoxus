// SPDX-License-Identifier: AGPL-3.0-or-later

import { getDatabaseWorkspaceAvailability } from "@myoxus/core/modules/database/availability";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { GraphQLService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { type DatabasesQuery, databasesQuery } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { DatabaseIcon, SearchIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  Button,
  EmptyState,
  Group,
  Loading,
  Modal,
  MyoxusText,
  MyoxusTextInput,
  notify,
  SelectableCardRow,
  Stack,
  SurfaceList,
  SurfaceListItemIcon,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { useEffect, useMemo, useRef, useState } from "react";

type DatabaseSelectorState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "local-unavailable" | "unavailable" }
  | { status: "ready"; records: DatabaseSelectorRecord[] };

type DatabaseSelectorRecord = NonNullable<
  DatabasesQuery["workspace"]
>["databases"][number];

const SELECTOR_PAGE_SIZE = 100;

export const DatabaseSelectorDialog = ({
  close,
  init,
  returnFocusRef,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["database-selector"]>) => {
  const t = useI18n();
  const [open, setOpen] = useState(true);
  const resultRef = useRef<
    { databaseId: string; viewId?: string | null } | undefined
  >(undefined);
  // Keep the dialog mounted through exit so the shared Modal can restore its durable opener.
  const requestClose = (result?: {
    databaseId: string;
    viewId?: string | null;
  }) => {
    if (!open) return;
    resultRef.current = result;
    setOpen(false);
  };
  const workspace = useService(WorkspaceService).workspace;
  const availability = getDatabaseWorkspaceAvailability(workspace);
  const workspaceId = availability.serverWorkspaceId;
  const graphQLService = useService(GraphQLService);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(init?.[0] ?? null);
  const [state, setState] = useState<DatabaseSelectorState>({
    status: "loading",
  });

  useEffect(() => {
    if (!workspaceId) {
      setState({
        status:
          availability.reason === "local-workspace"
            ? "local-unavailable"
            : "unavailable",
      });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    graphQLService
      .gql({
        query: databasesQuery,
        variables: {
          first: SELECTOR_PAGE_SIZE,
          offset: 0,
          workspaceId,
        },
      })
      .then((response) => {
        if (cancelled) return;
        const records = response.workspace?.databases ?? [];
        setState({ status: "ready", records });
        setSelection((current) => current ?? records[0]?.id ?? null);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setState({ status: "error" });
        notify.error({
          title: t["com.myoxus.database.selector.load-failed"](),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [availability.reason, graphQLService, t, workspaceId]);

  const records = state.status === "ready" ? state.records : [];
  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(t.language);
    if (!needle) return records;
    return records.filter((record) => {
      const title = record.title.toLocaleLowerCase(t.language);
      const description = record.description?.toLocaleLowerCase(t.language);
      return title.includes(needle) || Boolean(description?.includes(needle));
    });
  }, [query, records, t.language]);

  const selectedRecord = records.find((record) => record.id === selection);
  const onConfirm = () => {
    if (!selectedRecord) return;
    requestClose({
      databaseId: selectedRecord.id,
      viewId: null,
    });
  };

  return (
    <Modal
      open={open}
      returnFocusRef={returnFocusRef}
      onExitTransitionEnd={() => close(resultRef.current)}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      title={t["com.myoxus.database.selector.title"]()}
      description={t["com.myoxus.database.selector.description"]()}
      contentOptions={{
        bodyPadding: "md",
        surface: "secondary",
        "data-testid": "database-selector-dialog",
      }}
    >
      <Stack gap="md">
        <MyoxusTextInput
          block
          aria-label={t["com.myoxus.database.selector.search-placeholder"]()}
          placeholder={t["com.myoxus.database.selector.search-placeholder"]()}
          preFix={<SearchIcon />}
          value={query}
          onChange={setQuery}
        />
        {state.status === "loading" ? (
          <Group justify="center">
            <Loading />
          </Group>
        ) : null}
        {state.status === "error" ? (
          <EmptyState
            title={t["com.myoxus.database.selector.error-title"]()}
            description={t["com.myoxus.database.selector.error-description"]()}
          />
        ) : null}
        {state.status === "local-unavailable" ||
        state.status === "unavailable" ? (
          <EmptyState
            title={
              state.status === "local-unavailable"
                ? t["com.myoxus.database.server-backed-only.title"]()
                : t["com.myoxus.database.selector.error-title"]()
            }
            description={
              state.status === "local-unavailable"
                ? t["com.myoxus.database.server-backed-only.description"]()
                : t["com.myoxus.database.selector.error-description"]()
            }
          />
        ) : null}
        {state.status === "ready" && filteredRecords.length === 0 ? (
          <EmptyState
            title={t["com.myoxus.database.selector.empty-title"]()}
            description={t["com.myoxus.database.selector.empty-description"]()}
          />
        ) : null}
        {filteredRecords.length > 0 ? (
          <SurfaceList
            label={t["com.myoxus.database.selector.list-label"]()}
            data-testid="database-selector-list"
          >
            {filteredRecords.map((record) => (
              <SelectableCardRow
                key={record.id}
                appearance="row"
                selected={selection === record.id}
                onClick={() => setSelection(record.id)}
                data-testid={`database-selector-row-${record.id}`}
              >
                <SurfaceListItemIcon>
                  <DatabaseIcon />
                </SurfaceListItemIcon>
                <SurfaceListItemMain>
                  <SurfaceListText kind="title">{record.title}</SurfaceListText>
                  <MyoxusText tone="secondary">
                    {t["com.myoxus.database.index.meta"]({
                      fields: String(record.fieldCount),
                      rows: String(record.rowCount),
                      views: String(record.viewCount),
                    })}
                  </MyoxusText>
                </SurfaceListItemMain>
              </SelectableCardRow>
            ))}
          </SurfaceList>
        ) : null}
        <Group justify="flex-end" wrap="wrap">
          <Button variant="secondary" onClick={() => requestClose()}>
            {t["Cancel"]()}
          </Button>
          <Button
            disabled={!selectedRecord}
            onClick={onConfirm}
            data-testid="database-selector-confirm"
          >
            {t["com.myoxus.database.selector.confirm"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
