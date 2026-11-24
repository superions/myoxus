// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { OverviewRegisterConfiguration } from "@myoxus/core/desktop/pages/workspace/overview/register-configuration";
import { useWorkspaceOverviewRead } from "@myoxus/core/desktop/pages/workspace/overview/read";
import {
  documentIndexPresentation,
  overviewPresentationIncomplete,
} from "@myoxus/core/desktop/pages/workspace/overview/presentation";

import { WorkspaceOverviewRegister } from "@myoxus/core/desktop/pages/workspace/overview/register";
import { ServerDeploymentType } from "@myoxus/graphql";
import { SocketConnection } from "@myoxus/storage/cloud";
import { GuardService } from "@myoxus/core/modules/permissions";

import { WorkspaceDBService } from "@myoxus/core/modules/db";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { generateUrl } from "@myoxus/core/components/hooks/myoxus/use-share-url";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { WorkspaceShareSettingService } from "@myoxus/core/modules/share-setting";
import { TagService } from "@myoxus/core/modules/tag";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { collectWorkspaceFolderOptions } from "@myoxus/core/modules/workspace-pages/organizer";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
import {
  Button,
  FormSelect,
  Group,
  Input,
  List,
  Loading,
  Modal,
  MyoxusText,
  MyoxusTitle,
  NavLink,
  Pagination,
  Stack,
} from "@myoxus/ui-facade";
import type {
  DocumentIndexBlockModel,
  DocumentIndexProps,
} from "@virgultum/editor/model";
import { useCallback, useEffect, useReducer, useState } from "react";

export function Configuration({
  value,
  apply,
  close,
}: {
  value: DocumentIndexProps;
  apply: (value: DocumentIndexProps) => void;
  close: () => void;
}) {
  const t = useI18n();
  const { organizeService, workspaceService } = useServices({
    OrganizeService,
    WorkspaceService,
  });
  const roots = useLiveData(
    organizeService.folderTree.rootFolder.sortedChildren$,
  );
  void roots;
  const folders = collectWorkspaceFolderOptions(
    organizeService.folderTree.rootFolder,
  );
  const [draft, setDraft] = useState(
    () => JSON.parse(JSON.stringify(value)) as DocumentIndexProps,
  );
  const foreign =
    draft.workspaceId !== undefined &&
    draft.workspaceId !== workspaceService.workspace.id;
  const source = foreign ? "linked" : (draft.query.folderId ?? "");
  const presentation = documentIndexPresentation(
    draft.query,
    draft.displayProperties,
  );
  return (
    <Modal
      open
      width="lg"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t[
        draft.view === "table"
          ? "com.myoxus.wiki.report.title"
          : "com.myoxus.wiki.directory.title"
      ]()}
    >
      <Stack>
        <Input
          label={t["Title"]()}
          value={draft.title}
          onChange={(title) => setDraft((d) => ({ ...d, title }))}
        />
        <FormSelect
          label={t["switchView"]()}
          value={draft.view}
          data={[
            { value: "list", label: t["com.myoxus.all-docs.view.list"]() },
            { value: "table", label: t["com.myoxus.editor.slash.table"]() },
          ]}
          onChange={(view) => {
            if (view === "list" || view === "table")
              setDraft((d) => ({ ...d, view }));
          }}
        />
        <FormSelect
          label={t["com.myoxus.wiki.directory.scope"]()}
          value={source}
          data={[
            { value: "", label: t["com.myoxus.wiki.directory.workspace"]() },
            ...folders,
            ...(foreign
              ? [
                  {
                    value: "linked",
                    label: t["com.myoxus.settings.workspace"](),
                    disabled: true,
                  },
                ]
              : []),
          ]}
          onChange={(folderId) => {
            if (folderId !== null && folderId !== "linked")
              setDraft((d) => ({
                ...d,
                workspaceId: folderId
                  ? workspaceService.workspace.id
                  : undefined,
                query: { ...d.query, folderId: folderId || null },
              }));
          }}
        />
        <OverviewRegisterConfiguration
          value={presentation}
          onChange={(next) =>
            setDraft((d) => ({
              ...d,
              displayProperties: next.displayProperties,
              query: {
                ...d.query,
                ...next.selection,
                orderBy:
                  next.orderBy.key === "organizer"
                    ? null
                    : {
                        type: "system",
                        key: next.orderBy.key,
                        desc: next.orderBy.desc,
                      },
              },
            }))
          }
        />
        <Group>
          <Button variant="secondary" onClick={close}>
            {t["Cancel"]()}
          </Button>
          <Button
            disabled={overviewPresentationIncomplete(presentation)}
            onClick={() => apply(draft)}
          >
            {t["Save"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function Directory({
  model,
  readonly: viewReadonly = false,
}: {
  model: DocumentIndexBlockModel;
  readonly?: boolean;
}) {
  const storeReadonly = useSignalValue(model.store.readonly$);
  const readonly = viewReadonly || storeReadonly;
  const t = useI18n();
  const {
    workspaceService,
    workspaceServerService,
    workspaceDBService,
    documentMetadataCacheService,
    tagService,
    workspaceShareSettingService,
    guardService,
  } = useServices({
    WorkspaceService,
    WorkspaceServerService,
    WorkspaceDBService,
    DocumentMetadataCacheService,
    TagService,
    WorkspaceShareSettingService,
    GuardService,
  });
  const workspace = workspaceService.workspace;
  const server = useLiveData(workspaceServerService.server$);
  const account = useLiveData(server?.account$);
  const serverConfig = useLiveData(server?.config$);
  const deploymentType = serverConfig?.type;
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    if (!server || !deploymentType) return;
    // Observe Storage's shared transport; do not open another socket or join rooms.
    const connection = new SocketConnection(
      server.baseUrl,
      deploymentType === ServerDeploymentType.Standalone,
      server.id,
    );
    const update = () =>
      setConnected(
        connection.status === "idle" || connection.status === "connecting"
          ? null
          : connection.status === "connected",
      );
    const unsubscribe = connection.onStatusChanged(update);
    connection.connect();
    update();
    return () => {
      unsubscribe();
      connection.disconnect();
    };
  }, [server, deploymentType]);
  const metadata = useLiveData(documentMetadataCacheService.watchIndexState());
  const tags = useLiveData(tagService.tagList.inventoryRevision$);
  const publicAccess = useLiveData(
    workspaceShareSettingService.sharePreview.public$,
  );
  const sharing = useLiveData(
    workspaceShareSettingService.sharePreview.enableSharing$,
  );
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [definition, changed] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    const subscription = model.propsUpdated.subscribe(() => changed());
    return () => subscription.unsubscribe();
  }, [model]);
  const read = useWorkspaceOverviewRead({
    server,
    accountId: account?.id,
    workspace,
    folders: workspaceDBService.getWorkspaceDbDoc("folders"),
    folderId: model.props.query.folderId ?? null,
    offset,
    metadataGeneration: metadata.generation,
    tagRevision: tags,
    visibilityKey: JSON.stringify([
      publicAccess,
      sharing,
      connected,
      definition,
    ]),
    onResetPage: useCallback(() => setOffset(0), []),
    sourceWorkspaceId: model.props.workspaceId ?? workspace.id,
    registerPresentation: documentIndexPresentation(
      model.props.query,
      model.props.displayProperties,
    ),
    enabled: connected === true,
    permissionChanges: guardService.permissionChanges$,
  });
  const current = read.error
    ? { error: true, page: undefined }
    : !read.isLoading && !read.isValidating && read.data?.workspace?.overview
      ? { error: false, page: read.data.workspace.overview }
      : undefined;
  const refresh = () => void read.refresh();
  return (
    <Stack>
      <Group>
        <MyoxusTitle order={3}>
          {model.props.title ||
            t[
              model.props.view === "table"
                ? "com.myoxus.wiki.report.title"
                : "com.myoxus.wiki.directory.title"
            ]()}
        </MyoxusTitle>
        {!readonly && (
          <Button variant="plain" onClick={() => setEditing(true)}>
            {t["Edit"]()}
          </Button>
        )}
        <Button variant="plain" onClick={refresh}>
          {t["com.myoxus.wiki.directory.refresh"]()}
        </Button>
      </Group>
      {!server || read.offline || connected === false ? (
        <MyoxusText>{t["com.myoxus.wiki.directory.offline"]()}</MyoxusText>
      ) : current?.error ? (
        <Group>
          <MyoxusText role="alert">
            {t["com.myoxus.wiki.directory.error"]()}
          </MyoxusText>
          <Button onClick={refresh}>{t["Retry"]()}</Button>
        </Group>
      ) : !current?.page ? (
        <Loading />
      ) : (
        <>
          {current.page.documents.length ? (
            model.props.view === "table" ? (
              <WorkspaceOverviewRegister
                page={current.page}
                workspaceId={workspace.id}
                displayProperties={model.props.displayProperties}
              />
            ) : (
              <List>
                {current.page.documents.map((row) => (
                  <List.Item
                    key={`${row.resource.workspaceId}:${row.resource.id}`}
                  >
                    <NavLink
                      component="a"
                      href={generateUrl({
                        pageId: row.resource.id,
                        workspaceId: row.resource.workspaceId,
                        baseUrl: server.baseUrl,
                      })}
                      label={row.title || t["Untitled"]()}
                    />
                  </List.Item>
                ))}
              </List>
            )
          ) : (
            <MyoxusText>
              {t["com.myoxus.workspace-overview.documents.empty"]()}
            </MyoxusText>
          )}
          {current.page.documentCount > current.page.limit && (
            <Pagination
              totalCount={current.page.documentCount}
              countPerPage={current.page.limit}
              pageNum={Math.floor(current.page.offset / current.page.limit)}
              onPageChange={(skip) => setOffset(skip)}
            />
          )}
        </>
      )}
      {editing && !readonly && (
        <Configuration
          value={{
            title: model.props.title,
            view: model.props.view,
            displayProperties: model.props.displayProperties,
            workspaceId: model.props.workspaceId,
            query: model.props.query,
          }}
          close={() => setEditing(false)}
          apply={(value) => {
            if (
              readonly ||
              model.store.readonly ||
              model.store.getModelById(model.id) !== model
            )
              return;
            model.store.captureSync();
            model.store.updateBlock(model, value);
            model.store.captureSync();
            setEditing(false);
          }}
        />
      )}
    </Stack>
  );
}
