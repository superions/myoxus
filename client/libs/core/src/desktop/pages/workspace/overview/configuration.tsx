// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FilterParams } from "@myoxus/core/modules/collection-rules";
import { DisplayProperties } from "@myoxus/core/components/explorer/display-menu/properties";
import {
  OrderByList,
  OrderByName,
} from "@myoxus/core/components/explorer/display-menu/order";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { OrganizeService } from "@myoxus/core/modules/organize";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { collectWorkspaceFolderOptions } from "@myoxus/core/modules/workspace-pages/organizer";
import { UserFriendlyError } from "@myoxus/error";
import {
  workspaceOverviewSettingsQuery,
  updateWorkspaceOverviewMutation,
  WorkspaceContentResourceKindType,
  type WorkspaceOverviewSettingsQuery,
  type WorkspaceOverviewSettingsInput,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { LiveData, useLiveData, useServices } from "@myoxus/infra";
import {
  Button,
  DialogFooter,
  DialogFooterActions,
  Group,
  Loading,
  Modal,
  Menu,
  MenuPanel,
  MyoxusMultiSelect,
  MyoxusText,
  MyoxusTitle,
  SettingsNotice,
  Stack,
  Switch,
} from "@myoxus/ui-facade";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR from "swr";
import {
  defaultOverviewRegisterPresentation,
  overviewPresentationKey,
  overviewRegisterProperties,
  type OverviewRegisterPresentation,
} from "./presentation";

type Configuration = NonNullable<
  WorkspaceOverviewSettingsQuery["workspace"]
>["overviewSettings"];
type Introduction = NonNullable<Configuration["introduction"]>;
const introductionFilters: readonly FilterParams[] = [
  { type: "system", key: "docPrimaryMode", method: "is", value: "page" },
  { type: "system", key: "template", method: "is", value: "false" },
];
const bindingKey = (ref: Introduction | null | undefined) =>
  ref ? JSON.stringify([ref.workspaceId, ref.kind, ref.id]) : "";
const folderKey = (ids: readonly string[] | null | undefined) =>
  ids == null ? "all" : JSON.stringify([...new Set(ids)].sort());

/** A draft over one native settings scope. Membership and folder order stay
 * server-owned; a refresh never replaces a draft without explicit reload.
 */
export function WorkspaceOverviewConfiguration({
  open,
  folderId,
  scopeTitle,
  onOpenChange,
  onSaved,
  returnFocusRef,
}: {
  open: boolean;
  folderId?: string;
  scopeTitle: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useI18n();
  const {
    workspaceService,
    workspaceServerService,
    workspaceDialogService,
    organizeService,
    docDisplayMetaService,
    guardService,
  } = useServices({
    WorkspaceService,
    WorkspaceServerService,
    WorkspaceDialogService,
    OrganizeService,
    DocDisplayMetaService,
    GuardService,
  });
  const workspace = workspaceService.workspace;
  const server = useLiveData(workspaceServerService.server$);
  const account = useLiveData(server?.account$);
  const root = organizeService.folderTree.rootFolder;
  const rootChildren = useLiveData(root.sortedChildren$);
  const folderOptions = useMemo(() => {
    void rootChildren;
    return collectWorkspaceFolderOptions(root);
  }, [root, rootChildren]);
  const read = useSWR(
    open && server && account
      ? [
          workspaceOverviewSettingsQuery.id,
          server.id,
          server.baseUrl,
          account.id,
          workspace.id,
        ]
      : null,
    () =>
      server!.gql({
        query: workspaceOverviewSettingsQuery,
        variables: { id: workspace.id },
      }),
    {
      suspense: false,
      keepPreviousData: false,
      revalidateOnMount: true,
      dedupingInterval: 0,
      shouldRetryOnError: false,
      suppressErrorNotification: true,
    },
  );
  const [basis, setBasis] = useState<Configuration>();
  const [introduction, setIntroduction] = useState<Introduction | null>(null);
  const [allFolders, setAllFolders] = useState(true);
  const [folders, setFolders] = useState<string[]>([]);
  // Null retains inheritance; only an explicit edit creates a local override.
  const [presentation, setPresentation] =
    useState<OverviewRegisterPresentation | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<"conflict" | "save" | null>(null);
  const [reloadFailed, setReloadFailed] = useState(false);
  const sourceButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const initialize = useCallback(
    (value: Configuration) => {
      setBasis(value);
      setIntroduction(
        (folderId
          ? value.folders.find((folder) => folder.folderId === folderId)
              ?.introduction
          : value.introduction) ?? null,
      );
      setAllFolders(value.folderIds == null);
      setFolders(value.folderIds ?? []);
      setPresentation(
        (folderId
          ? value.folders.find((folder) => folder.folderId === folderId)
              ?.registerPresentation
          : value.registerPresentation) ?? null,
      );
      setError(null);
      setReloadFailed(false);
    },
    [folderId],
  );
  useEffect(() => {
    const value = read.data?.workspace?.overviewSettings;
    if (open && !basis && !read.error && !read.isValidating && value) {
      initialize(value);
    }
  }, [open, basis, initialize, read.data, read.error, read.isValidating]);
  const localId =
    introduction?.workspaceId === workspace.id &&
    introduction.kind === WorkspaceContentResourceKindType.Document
      ? introduction.id
      : undefined;
  const observedRead = useLiveData(
    useMemo(
      () =>
        localId ? guardService.can$("Doc_Read", localId) : new LiveData(false),
      [guardService, localId],
    ),
  );
  const [sourceRead, setSourceRead] = useState<{
    id: string;
    allowed: boolean;
  }>();
  useEffect(() => {
    if (!localId) return;
    let current = true;
    const settle = (allowed: boolean) => {
      if (current) setSourceRead({ id: localId, allowed });
    };
    // can$ only observes. Load the selected source, retain native revocations
    // and settle failures as unavailable instead of leaving a missing ID loading.
    void guardService
      .can("Doc_Read", localId)
      .then(settle, () => settle(false));
    return () => {
      current = false;
    };
  }, [guardService, localId]);
  const sourceReady = sourceRead?.id === localId;
  const readable = sourceReady && sourceRead?.allowed && observedRead === true;
  const sourceTitle = useLiveData(
    useMemo(
      () =>
        localId && readable
          ? docDisplayMetaService.title$(localId)
          : new LiveData<string | undefined>(undefined),
      [docDisplayMetaService, localId, readable],
    ),
  );
  const oldIntroduction = folderId
    ? basis?.folders.find((folder) => folder.folderId === folderId)
        ?.introduction
    : basis?.introduction;
  const selectedFolders = allFolders ? null : folders;
  const introductionChanged =
    bindingKey(oldIntroduction) !== bindingKey(introduction);
  const foldersChanged =
    !folderId && folderKey(basis?.folderIds) !== folderKey(selectedFolders);
  const previousPresentation = folderId
    ? basis?.folders.find((folder) => folder.folderId === folderId)
        ?.registerPresentation
    : basis?.registerPresentation;
  const effectivePresentation =
    presentation ??
    (folderId ? basis?.registerPresentation : undefined) ??
    defaultOverviewRegisterPresentation;
  const presentationChanged =
    overviewPresentationKey(previousPresentation) !==
    overviewPresentationKey(presentation);
  const dirty =
    !!basis && (introductionChanged || foldersChanged || presentationChanged);
  const presentationDisabled = saving || (!!folderId && presentation === null);
  const options = [
    ...folderOptions,
    // Missing selections stay removable and disappear from options on removal.
    ...folders
      .filter((id) => !folderOptions.some((option) => option.value === id))
      .map((id) => ({
        value: id,
        label:
          t["com.myoxus.workspace-overview.configuration.missing-folder"](),
      })),
  ];
  const choose = () => {
    // The host id is returned immediately; selection arrives on dialog close.
    workspaceDialogService.open(
      "doc-selector",
      {
        init: localId && readable ? [localId] : [],
        multiple: false,
        extraFilters: introductionFilters,
        returnFocusRef: sourceButton,
      },
      (ids) => {
        if (!alive.current || ids === undefined) return;
        setIntroduction(
          ids[0]
            ? {
                workspaceId: workspace.id,
                kind: WorkspaceContentResourceKindType.Document,
                id: ids[0],
              }
            : null,
        );
      },
    );
  };
  const reload = async () => {
    if (busy.current || !server) return;
    busy.current = true;
    setSaving(true);
    setReloadFailed(false);
    try {
      // SWR revalidation may resolve to cached data after a failed fetch. Only
      // an explicit successful read can replace a conflicted draft and basis.
      const fresh = await server.gql({
        query: workspaceOverviewSettingsQuery,
        variables: { id: workspace.id },
      });
      if (!alive.current) return;
      if (!fresh.workspace)
        throw new Error("Workspace settings are unavailable");
      initialize(fresh.workspace.overviewSettings);
      await read.mutate(fresh, { revalidate: false });
    } catch {
      if (alive.current) setReloadFailed(true);
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const save = async () => {
    if (!server || !basis || !dirty || busy.current || error === "conflict")
      return;
    busy.current = true;
    setSaving(true);
    setError(null);
    const patch: WorkspaceOverviewSettingsInput = {
      expectedRevision: basis.revision,
      folderId,
    };
    // Omit unchanged fields: an old unavailable binding must not block an
    // unrelated change, and another scope is never copied back by this form.
    if (introductionChanged)
      patch.introduction = introduction
        ? {
            kind: WorkspaceContentResourceKindType.Document,
            id: introduction.id,
          }
        : null;
    if (foldersChanged) patch.folderIds = selectedFolders;
    if (presentationChanged)
      patch.registerPresentation = presentation
        ? {
            displayProperties: presentation.displayProperties,
            orderBy: {
              type: presentation.orderBy.type,
              key: presentation.orderBy.key,
              desc: presentation.orderBy.desc,
            },
          }
        : null;
    try {
      const result = await server.gql({
        query: updateWorkspaceOverviewMutation,
        variables: { input: { id: workspace.id, overview: patch } },
      });
      if (!alive.current) return;
      const saved = result.updateWorkspace.overviewSettings;
      initialize(saved);
      await read.mutate(
        { workspace: { id: workspace.id, overviewSettings: saved } },
        { revalidate: false },
      );
      if (!alive.current) return;
      onOpenChange(false);
      onSaved();
    } catch (cause) {
      if (alive.current)
        setError(
          UserFriendlyError.fromAny(cause).extensions?.name ===
            "WORKSPACE_OVERVIEW_REVISION_CONFLICT"
            ? "conflict"
            : "save",
        );
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t["com.myoxus.workspace-overview.configuration.title"]()}
      description={scopeTitle}
      width="lg"
      persistent={saving}
      returnFocusRef={returnFocusRef}
    >
      <Stack>
        {!basis ? (
          read.error ? (
            <SettingsNotice tone="error">
              {t["com.myoxus.workspace-overview.load-error"]()}
              <Button onClick={() => void reload()}>{t["Retry"]()}</Button>
            </SettingsNotice>
          ) : (
            <Loading />
          )
        ) : (
          <>
            <Stack>
              <MyoxusTitle order={3}>
                {t["com.myoxus.workspace-overview.introduction.heading"]()}
              </MyoxusTitle>
              {introduction && localId && !sourceReady ? (
                <Loading />
              ) : (
                <MyoxusText>
                  {introduction
                    ? readable && localId
                      ? sourceTitle || t["Untitled"]()
                      : t[
                          "com.myoxus.workspace-overview.introduction.unavailable"
                        ]()
                    : t[
                        "com.myoxus.workspace-overview.configuration.no-introduction"
                      ]()}
                </MyoxusText>
              )}
              <Group>
                <Button
                  data-autofocus
                  ref={sourceButton}
                  variant="secondary"
                  disabled={saving}
                  onClick={choose}
                >
                  {t[
                    "com.myoxus.workspace-overview.configuration.choose-document"
                  ]()}
                </Button>
                {introduction ? (
                  <Button
                    variant="plain"
                    disabled={saving}
                    onClick={() => setIntroduction(null)}
                  >
                    {t[
                      "com.myoxus.workspace-overview.configuration.clear-introduction"
                    ]()}
                  </Button>
                ) : null}
              </Group>
            </Stack>
            {!folderId ? (
              <Stack>
                <MyoxusTitle order={3}>
                  {t["com.myoxus.sidebar.hierarchy.folders"]()}
                </MyoxusTitle>
                <Switch
                  checked={allFolders}
                  disabled={saving}
                  onChange={setAllFolders}
                >
                  {t[
                    "com.myoxus.workspace-overview.configuration.all-folders"
                  ]()}
                </Switch>
                <MyoxusMultiSelect
                  label={t["com.myoxus.sidebar.hierarchy.folders"]()}
                  data={options}
                  value={folders}
                  onChange={setFolders}
                  disabled={allFolders || saving}
                  searchable
                />
                <MyoxusText tone="secondary" typographySlot="caption">
                  {t[
                    "com.myoxus.workspace-overview.configuration.folders-help"
                  ]()}
                </MyoxusText>
              </Stack>
            ) : null}
            <Stack>
              <MyoxusTitle order={3}>{t["Documents"]()}</MyoxusTitle>
              {folderId ? (
                <Switch
                  checked={presentation === null}
                  disabled={saving}
                  onChange={(inherit) =>
                    setPresentation(inherit ? null : effectivePresentation)
                  }
                >
                  {t[
                    "com.myoxus.workspace-overview.configuration.inherit-presentation"
                  ]()}
                </Switch>
              ) : null}
              <Group>
                <Menu
                  items={
                    <MenuPanel panelWidth="display">
                      <DisplayProperties
                        displayPreference={effectivePresentation}
                        systemPropertyKeys={overviewRegisterProperties}
                        requiredSystemProperties={["title"]}
                        onDisplayPreferenceChange={(next) =>
                          !busy.current &&
                          !presentationDisabled &&
                          setPresentation({
                            ...effectivePresentation,
                            displayProperties:
                              next.displayProperties ??
                              effectivePresentation.displayProperties,
                          })
                        }
                      />
                    </MenuPanel>
                  }
                >
                  <Button variant="secondary" disabled={presentationDisabled}>
                    {t["com.myoxus.all-docs.display.properties"]()}
                  </Button>
                </Menu>
                <Menu
                  title={t["com.myoxus.explorer.display-menu.ordering"]()}
                  items={
                    <MenuPanel panelWidth="display">
                      <OrderByList
                        orderBy={effectivePresentation.orderBy}
                        systemPropertyKeys={overviewRegisterProperties}
                        onChange={(next) =>
                          !busy.current &&
                          !presentationDisabled &&
                          setPresentation({
                            ...effectivePresentation,
                            orderBy: {
                              type: next.type,
                              key: next.key,
                              desc: next.desc ?? false,
                            },
                          })
                        }
                      />
                    </MenuPanel>
                  }
                >
                  <Button variant="secondary" disabled={presentationDisabled}>
                    {t["com.myoxus.explorer.display-menu.ordering"]()}
                    {" · "}
                    <OrderByName orderBy={effectivePresentation.orderBy} />
                  </Button>
                </Menu>
              </Group>
            </Stack>
            <SettingsNotice>
              {t[
                "com.myoxus.workspace-overview.configuration.public-visibility"
              ]()}
            </SettingsNotice>
            {error || reloadFailed ? (
              <SettingsNotice tone="error">
                {error === "conflict"
                  ? t["com.myoxus.workspace-overview.configuration.conflict"]()
                  : error === "save"
                    ? t[
                        "com.myoxus.workspace-overview.configuration.save-error"
                      ]()
                    : null}
                {reloadFailed ? (
                  <MyoxusText>
                    {t["com.myoxus.workspace-overview.load-error"]()}
                  </MyoxusText>
                ) : null}
                {error === "conflict" || reloadFailed ? (
                  <Button onClick={() => void reload()} disabled={saving}>
                    {t["com.myoxus.workspace-overview.configuration.reload"]()}
                  </Button>
                ) : null}
              </SettingsNotice>
            ) : null}
          </>
        )}
        <DialogFooter>
          <DialogFooterActions>
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {t["Cancel"]()}
            </Button>
            <Button
              disabled={!dirty || saving || error === "conflict"}
              onClick={() => void save()}
            >
              {t["Save"]()}
            </Button>
          </DialogFooterActions>
        </DialogFooter>
      </Stack>
    </Modal>
  );
}
