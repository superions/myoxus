// SPDX-License-Identifier: AGPL-3.0-or-later

import { useGuard } from "@myoxus/core/components/guard";
import { WorkspaceDBService } from "@myoxus/core/modules/db";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { TagService } from "@myoxus/core/modules/tag";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import {
  canonicalPublicWorkspaceUrl,
  WorkspaceShareSettingService,
} from "@myoxus/core/modules/share-setting";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchLink,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  ChevronRightIcon,
  EditIcon,
  FolderIcon,
  GlobeIcon,
  OpenInNewIcon,
  SettingsIcon,
} from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
import { getArtworkUrl } from "@myoxus/theme/artwork";
import {
  Badge,
  BadgeList,
  BadgeListItem,
  Button,
  Divider,
  EmptyState,
  Grid,
  Group,
  IconButton,
  Loading,
  NavLink,
  Modal,
  MyoxusText,
  MyoxusTitle,
  notify,
  PageContentRail,
  Pagination,
  Stack,
  SettingsNotice,
  Text,
  Textarea,
  ThemedImg,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { useCallback, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { WorkspaceOverviewRegister } from "./register";
import { WorkspaceIntroduction } from "./introduction";
import { useWorkspaceOverviewRead } from "./read";
import { WorkspaceOverviewConfiguration } from "./configuration";

import {
  countWorkspaceDescriptionCodepoints,
  MAX_WORKSPACE_DESCRIPTION_CODEPOINTS,
  normalizeWorkspaceDescription,
} from "./description";

function openInNewTab(url: string) {
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

export const WorkspaceOverview = () => {
  const t = useI18n();
  const {
    workspaceService,
    workspaceServerService,
    workspaceShareSettingService,
    workbenchService,
    workspaceDBService,
    documentMetadataCacheService,
    tagService,
  } = useServices({
    WorkspaceService,
    WorkspaceServerService,
    WorkspaceShareSettingService,
    WorkbenchService,
    WorkspaceDBService,
    DocumentMetadataCacheService,
    TagService,
  });
  const [params, setParams] = useSearchParams();
  const requestedOffset = Number(params.get("offset") ?? 0);
  const offset =
    Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
      ? requestedOffset
      : 0;
  const folderId = params.get("folder");
  const server = useLiveData(workspaceServerService.server$);
  const account = useLiveData(server?.account$);
  const workspace = workspaceService.workspace;
  const metadataState = useLiveData(
    documentMetadataCacheService.watchIndexState(),
  );
  const tagRevision = useLiveData(tagService.tagList.inventoryRevision$);
  const tagCatalog = useLiveData(tagService.tagList.catalogState$);
  const setting = workspaceShareSettingService.sharePreview;
  const publicAccess = useLiveData(setting.public$);
  const enableSharing = useLiveData(setting.enableSharing$);
  const resetPage = useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("offset");
      return next;
    });
  }, [setParams]);
  const read = useWorkspaceOverviewRead({
    server,
    accountId: account?.id,
    workspace,
    folders: workspaceDBService.getWorkspaceDbDoc("folders"),
    folderId,
    offset,
    metadataGeneration: metadataState.generation,
    tagRevision,
    visibilityKey: JSON.stringify([
      publicAccess,
      enableSharing,
      tagCatalog.tags.map((tag) => [
        tag.id,
        tag.value,
        tag.color,
        tag.archived,
      ]),
    ]),
    onResetPage: resetPage,
  });
  const page = read.error ? undefined : read.data?.workspace?.overview;
  const reading = read.isLoading || read.isValidating;
  const number = useMemo(() => new Intl.NumberFormat(t.language), [t.language]);
  const overviewPath = (id?: string) =>
    id ? `/overview?${new URLSearchParams({ folder: id })}` : "/overview";
  const name = useLiveData(setting.name$);
  const description = useLiveData(setting.description$);
  const publiclyAccessible = useLiveData(setting.publiclyAccessible$);
  const loading = useLiveData(setting.isLoading$);
  const error = useLiveData(setting.error$);
  const canEdit = useGuard("Workspace_Settings_Update");
  const configureButton = useRef<HTMLButtonElement>(null);
  const configurationId = useRef(0);
  const routeKey = JSON.stringify([
    server?.id,
    account?.id,
    workspace.id,
    folderId,
  ]);
  const [configuration, setConfiguration] = useState<{
    id: number;
    routeKey: string;
    folderId?: string;
    title: string;
    open: boolean;
  }>();
  const activeConfiguration =
    configuration?.routeKey === routeKey ? configuration : undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceId = workspaceService.workspace.id;
  const publicUrl = useMemo(() => {
    const baseUrl = workspaceServerService.server?.baseUrl;
    if (!baseUrl) return null;
    const url = new URL(canonicalPublicWorkspaceUrl({ baseUrl, workspaceId }));
    if (page?.folder) url.searchParams.set("folder", page.folder.id);
    return url.toString();
  }, [workspaceId, workspaceServerService.server?.baseUrl, page?.folder]);
  const publicAvailable =
    !reading &&
    !!page &&
    !loading &&
    error === null &&
    publiclyAccessible === true &&
    publicUrl;
  const count = countWorkspaceDescriptionCodepoints(draft);
  const overLimit = count > MAX_WORKSPACE_DESCRIPTION_CODEPOINTS;

  const openEditor = useCallback(() => {
    setDraft(description ?? "");
    setEditing(true);
  }, [description]);

  const save = useCallback(async () => {
    const normalized = normalizeWorkspaceDescription(draft);
    if (
      saving ||
      countWorkspaceDescriptionCodepoints(normalized) >
        MAX_WORKSPACE_DESCRIPTION_CODEPOINTS
    ) {
      return;
    }
    setSaving(true);
    try {
      await setting.setDescription(normalized);
      setEditing(false);
    } catch {
      notify.error({
        title: t["com.myoxus.workspace-overview.modal.save-error"](),
      });
    } finally {
      setSaving(false);
    }
  }, [draft, saving, setting, t]);

  const status =
    loading || error !== null || publiclyAccessible === null
      ? t["com.myoxus.workspace-overview.public-status.unavailable"]()
      : publiclyAccessible
        ? t["com.myoxus.workspace-overview.public-status.public"]()
        : t["com.myoxus.workspace-overview.public-status.private"]();

  return (
    <>
      <ViewTitle
        title={page?.folder?.name ?? t["com.myoxus.workspace-overview.title"]()}
      />
      <ViewIcon icon="home" />
      <ViewHeader>
        <WorkbenchHeaderFrame
          right={
            <Group wrap="nowrap">
              <IconButton
                aria-label={t[
                  "com.myoxus.workspace-overview.public-status.open"
                ]()}
                tooltip={
                  publicAvailable
                    ? t["com.myoxus.workspace-overview.public-status.open"]()
                    : status
                }
                disabled={!publicAvailable}
                variant={publicAvailable ? "primary" : "plain"}
                onClick={() => {
                  if (publicAvailable) openInNewTab(publicAvailable);
                }}
              >
                <GlobeIcon aria-hidden="true" />
              </IconButton>
              {canEdit ? (
                <Button
                  ref={configureButton}
                  prefix={<SettingsIcon aria-hidden="true" />}
                  disabled={!page}
                  onClick={() => {
                    if (!page) return;
                    setConfiguration({
                      id: ++configurationId.current,
                      routeKey,
                      folderId: page.folder?.id,
                      title:
                        page.folder?.name ||
                        name ||
                        workspace.meta.name ||
                        t["Untitled"](),
                      open: true,
                    });
                  }}
                >
                  {t["com.myoxus.workspace-overview.configuration.open"]()}
                </Button>
              ) : null}
            </Group>
          }
          title={
            <WorkbenchHeaderContextPath
              current={
                page?.folder?.name ?? t["com.myoxus.workspace-overview.title"]()
              }
              parents={
                page?.folder
                  ? [
                      <Text
                        component={WorkbenchLink}
                        inherit
                        key="workspace"
                        to="/overview"
                      >
                        {name || workspace.meta.name}
                      </Text>,
                      ...page.breadcrumbs.slice(0, -1).map((folder) => (
                        <Text
                          component={WorkbenchLink}
                          inherit
                          key={folder.id}
                          to={overviewPath(folder.id)}
                        >
                          {folder.name}
                        </Text>
                      )),
                    ]
                  : []
              }
            />
          }
        />
      </ViewHeader>
      {activeConfiguration && canEdit ? (
        <WorkspaceOverviewConfiguration
          key={`${routeKey}:${activeConfiguration.id}`}
          open={activeConfiguration.open}
          folderId={activeConfiguration.folderId}
          scopeTitle={activeConfiguration.title}
          returnFocusRef={configureButton}
          onOpenChange={(open) =>
            setConfiguration((current) =>
              current?.id === activeConfiguration.id
                ? { ...current, open }
                : current,
            )
          }
          onSaved={resetPage}
        />
      ) : null}
      <ViewBody>
        <PageContentRail
          fill
          scroll
          spacious
          width="content"
          data-testid="workspace-overview"
        >
          <Stack>
            <BadgeList
              data-testid="workspace-overview-metadata-header"
              justify="center"
            >
              <BadgeListItem>
                <Badge
                  tone={
                    publiclyAccessible === true && !loading && error === null
                      ? "success"
                      : "neutral"
                  }
                >
                  {status}
                </Badge>
              </BadgeListItem>
            </BadgeList>
            <Stack>
              <MyoxusText typographySlot="caption" tone="secondary">
                {page?.folder
                  ? t["com.myoxus.sidebar.hierarchy.folders"]()
                  : t["com.myoxus.settings.workspace"]()}
              </MyoxusText>
              <MyoxusTitle order={1}>
                {page?.folder?.name || name || workspace.meta.name}
              </MyoxusTitle>
              {!folderId || (page && !page.folder) ? (
                <Group align="flex-start" wrap="nowrap">
                  <MyoxusText component="p" preserveWhitespace tone="secondary">
                    {description ||
                      t["com.myoxus.workspace-overview.description.empty"]()}
                  </MyoxusText>
                  {canEdit ? (
                    <IconButton
                      ref={editButtonRef}
                      aria-label={t[
                        "com.myoxus.workspace-overview.description.edit"
                      ]()}
                      tooltip={t[
                        "com.myoxus.workspace-overview.description.edit"
                      ]()}
                      onClick={openEditor}
                    >
                      <EditIcon aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </Group>
              ) : null}
            </Stack>
            <Divider />
            {read.error || (!server && workspace.flavour === "local") ? (
              <EmptyState
                role="alert"
                media={
                  <ThemedImg
                    fluid
                    alt=""
                    lightSrc={getArtworkUrl("not-found")}
                  />
                }
                title={t["com.myoxus.workspace-overview.load-error"]()}
                cta={
                  <Button
                    onClick={() => {
                      void read.refresh();
                    }}
                  >
                    {t["Retry"]()}
                  </Button>
                }
              />
            ) : reading || !page ? (
              <Loading />
            ) : (
              <>
                {page.introduction ||
                (page.introductionUnavailable && canEdit) ||
                page.children.length ? (
                  <Grid>
                    {page.introduction ||
                    (page.introductionUnavailable && canEdit) ? (
                      <Grid.Col span={page.children.length ? 8 : 12}>
                        <Stack>
                          <Group justify="space-between" align="baseline">
                            <MyoxusTitle
                              order={2}
                              typographySlot="caption"
                              tone="secondary"
                            >
                              {t[
                                "com.myoxus.workspace-overview.introduction.heading"
                              ]()}
                            </MyoxusTitle>
                            {page.introduction?.canEdit ? (
                              <Button
                                variant="plain"
                                suffix={<OpenInNewIcon aria-hidden="true" />}
                                onClick={() =>
                                  workbenchService.workbench.open(
                                    `/${encodeURIComponent(page.introduction!.resource.id)}`,
                                    { at: "active" },
                                  )
                                }
                              >
                                {t["Edit"]()}
                              </Button>
                            ) : null}
                          </Group>
                          {page.introduction ? (
                            <WorkspaceIntroduction
                              key={`${page.introduction.resource.workspaceId}:${page.introduction.resource.id}`}
                              docId={page.introduction.resource.id}
                            />
                          ) : (
                            <SettingsNotice>
                              {t[
                                "com.myoxus.workspace-overview.introduction.unavailable"
                              ]()}
                            </SettingsNotice>
                          )}
                        </Stack>
                      </Grid.Col>
                    ) : null}
                    {page.children.length ? (
                      <Grid.Col
                        span={
                          page.introduction ||
                          (page.introductionUnavailable && canEdit)
                            ? 4
                            : 12
                        }
                      >
                        <Stack
                          component="nav"
                          aria-label={t[
                            "com.myoxus.sidebar.hierarchy.folders"
                          ]()}
                        >
                          <Group justify="space-between" align="baseline">
                            <MyoxusTitle
                              order={2}
                              typographySlot="caption"
                              tone="secondary"
                            >
                              {t["com.myoxus.sidebar.hierarchy.folders"]()}
                            </MyoxusTitle>
                            <Badge>{number.format(page.children.length)}</Badge>
                          </Group>
                          <Stack>
                            {page.children.map((folder) => (
                              <NavLink
                                key={folder.id}
                                component={WorkbenchLink}
                                to={overviewPath(folder.id)}
                                label={folder.name}
                                leftSection={<FolderIcon aria-hidden="true" />}
                                rightSection={
                                  <ChevronRightIcon aria-hidden="true" />
                                }
                              />
                            ))}
                          </Stack>
                        </Stack>
                      </Grid.Col>
                    ) : null}
                  </Grid>
                ) : null}
                <Divider />
                <Stack component="section" aria-label={t["Documents"]()}>
                  <Group>
                    <MyoxusTitle order={2}>{t["Documents"]()}</MyoxusTitle>
                    <Badge>{number.format(page.documentCount)}</Badge>
                  </Group>
                  {page.documents.length ? (
                    <WorkspaceOverviewRegister
                      page={page}
                      workspaceId={workspaceId}
                    />
                  ) : (
                    <MyoxusText tone="secondary">
                      {t["com.myoxus.workspace-overview.documents.empty"]()}
                    </MyoxusText>
                  )}
                  {page.documentCount > page.limit ? (
                    <Pagination
                      totalCount={page.documentCount}
                      countPerPage={page.limit}
                      pageNum={Math.floor(page.offset / page.limit)}
                      disabled={reading}
                      onPageChange={(skip) => {
                        const next = new URLSearchParams(params);
                        if (skip) next.set("offset", String(skip));
                        else next.delete("offset");
                        setParams(next);
                      }}
                    />
                  ) : null}
                </Stack>
              </>
            )}
          </Stack>
        </PageContentRail>
      </ViewBody>
      <Modal
        open={editing}
        onOpenChange={setEditing}
        returnFocusRef={editButtonRef}
        title={t["com.myoxus.workspace-overview.modal.title"]()}
      >
        <Stack>
          <Textarea
            autoFocus
            data-autofocus
            aria-label={t[
              "com.myoxus.workspace-overview.description.heading"
            ]()}
            description={t["com.myoxus.workspace-overview.modal.consequence"]()}
            inputWrapperOrder={["description", "input", "error"]}
            error={
              overLimit
                ? t["com.myoxus.workspace-overview.modal.limit"]({
                    max: MAX_WORKSPACE_DESCRIPTION_CODEPOINTS.toString(),
                  })
                : undefined
            }
            disabled={saving}
            minRows={8}
            value={draft}
            onChange={setDraft}
          />
          <MyoxusText
            aria-live="polite"
            typographySlot="caption"
            tone="secondary"
          >
            {t["com.myoxus.workspace-overview.modal.counter"]({
              count: count.toString(),
              max: MAX_WORKSPACE_DESCRIPTION_CODEPOINTS.toString(),
            })}
          </MyoxusText>
          <Group justify="flex-end">
            <Button
              disabled={saving}
              variant="secondary"
              onClick={() => setEditing(false)}
            >
              {t["Cancel"]()}
            </Button>
            <Button
              disabled={overLimit || saving}
              loading={saving}
              onClick={save}
            >
              {t["Save"]()}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
};

export const Component = WorkspaceOverview;
