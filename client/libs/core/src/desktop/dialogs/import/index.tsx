/**
 * `ImportDialog` — workspace content import modal.
 *
 * Allows the user to import external content (BPMN, Mermaid, Markdown, HTML, DOCX and Myoxus
 * document snapshots) into the current workspace. Notion HTML/ZIP
 * exports are intentionally NOT routed through this dialog: they are
 * imported as server-backed Databases via the Databases header import
 * entry point (P-DB-29).  The dialog integrates with:
 *
 * - `getStoreManager()` / `getMyoxusWorkspaceSchema()` — Virgultum store
 *   factory used to create a scratch document for content parsing.
 * - `OrganizeService` — to place the newly imported document in the organiser
 *   tree at the correct location.
 * - `ExplorerIconService` — to assign default icons to imported documents.
 * - `UrlService` — to resolve relative asset URLs inside imported content.
 * - `track` — analytics events for import actions.
 * - BPMN bypasses scratch transformers: the fork inspects exact bytes and the
 *   existing diagram registry owns acknowledged creation and original-ID retry.
 *
 * After a successful import the dialog navigates directly to the new document
 * via `useNavigateHelper`.
 */
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { useSystemOnline } from "@myoxus/core/components/hooks/use-system-online";
import { getStoreManager } from "@myoxus/core/editor/manager/store";
import {
  type DialogComponentProps,
  GlobalDialogService,
  type WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { ExplorerIconService } from "@myoxus/core/modules/explorer-icon/services/explorer-icon";
import { importMermaidFilesToDocs } from "@myoxus/core/modules/mermaid-diagrams/services/mermaid-import";
import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import {
  isPreservableBpmnImport,
  prepareBpmnImport,
  runBpmnImport,
  type BpmnImportResult,
} from "@myoxus/core/modules/mermaid-diagrams/services/bpmn-import";
import { bpmnSourceErrorText } from "@myoxus/core/modules/bpmn-editor/source-message";
import { OrganizeService } from "@myoxus/core/modules/organize";
import {
  getMyoxusWorkspaceSchema,
  type WorkspaceMetadata,
  WorkspaceService,
} from "@myoxus/core/modules/workspace";
import { CoreDocEmbedProvider, DocsService } from "@myoxus/core/modules/doc";
import { GuardService } from "@myoxus/core/modules/permissions";
import { useGuard } from "@myoxus/core/components/guard/use-guard";
import type { DocEmbedProvider } from "@virgultum/editor/shared/services";
import {
  DefaultServerService,
  GraphQLService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import type { SnapshotImportHooks } from "@virgultum/editor/widgets/linked-doc";
import { snapshotLabelImportHooks } from "./import-labels";
import {
  DocxImportStatus,
  showDocxImportNotification,
  useOwnedDocxImport,
} from "./docx-result";
import type { DocxImportAttempt } from "@myoxus/core/modules/doc/services/docs";
import { DebugLogger } from "@myoxus/debug";
import { useI18n } from "@myoxus/i18n";
import {
  ArchiveRestoreIcon,
  InformationIcon,
  FileIconDocxIcon,
  FileIconHtmlIcon,
  FileIconMdIcon,
  FileIconZipIcon,
  WorkflowIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import track from "@myoxus/track";
import {
  Button,
  DialogFooterActions,
  MenuItem,
  MenuPanel,
  Modal,
  MyoxusText,
  MyoxusTitle,
  Stack,
  Notice,
  Group,
  Text,
  Tooltip,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Badge,
} from "@myoxus/ui-facade";
import { downloadBlob, openFilesWith } from "@virgultum/editor/shared/utils";
import {
  emptyMarkdownImportDiagnostics,
  type MarkdownImportDiagnostics,
} from "@virgultum/editor/shared/adapters";
import type { Workspace } from "@virgultum/editor/store";
import {
  HtmlTransformer,
  MarkdownTransformer,
  ZipTransformer,
} from "@virgultum/editor/widgets/linked-doc";
import {
  type ReactElement,
  type RefObject,
  type SVGAttributes,
  useCallback,
  useState,
} from "react";

const logger = new DebugLogger("import");

export type ImportType =
  | "markdown"
  | "mermaid"
  | "bpmn"
  | "markdownZip"
  | "snapshot"
  | "html"
  | "docx"
  | "workspace";
type AcceptType =
  "Markdown" | "Mermaid" | "Bpmn" | "Zip" | "Html" | "Docx" | "Skip";
export type ImportStatus = "idle" | "importing" | "success" | "error";
export type ImportResult = {
  docIds: string[];
  docx?: Extract<DocxImportAttempt, { status: "complete" }>;
  bpmn?: BpmnImportResult;
  markdownDiagnostics?: MarkdownImportDiagnostics;
  entryId?: string;
  isWorkspaceFile?: boolean;
  rootFolderId?: string;
};

type ImportConfig = {
  fileOptions: { acceptType: AcceptType; multiple: boolean };
  importFunction: (
    docCollection: Workspace,
    files: File[],
    handleImportWorkspace: () => Promise<WorkspaceMetadata | undefined>,
    organizeService?: OrganizeService,
    explorerIconService?: ExplorerIconService,
    snapshotHooks?: SnapshotImportHooks,
    referenceAccess?: DocEmbedProvider,
    diagramRegistry?: MermaidDiagramsService,
  ) => Promise<ImportResult>;
};

const importOptions = [
  {
    key: "bpmn",
    label: "com.myoxus.editor.bpmn.slash-name",
    prefixIcon: <WorkflowIcon />,
    testId: "editor-option-menu-import-bpmn",
    type: "bpmn" as ImportType,
  },
  {
    key: "markdown",
    label: "com.myoxus.import.markdown-files",
    prefixIcon: <FileIconMdIcon />,
    testId: "editor-option-menu-import-markdown-files",
    type: "markdown" as ImportType,
  },
  {
    key: "mermaid",
    label: "Mermaid diagrams (.mmd)",
    prefixIcon: <FileIconMdIcon />,
    testId: "editor-option-menu-import-mermaid",
    type: "mermaid" as ImportType,
  },
  {
    key: "markdownZip",
    label: "com.myoxus.import.markdown-with-media-files",
    prefixIcon: <FileIconZipIcon />,
    testId: "editor-option-menu-import-markdown-with-media",
    type: "markdownZip" as ImportType,
  },
  {
    key: "html",
    label: "com.myoxus.import.html-files",
    prefixIcon: <FileIconHtmlIcon />,
    testId: "editor-option-menu-import-html",
    type: "html" as ImportType,
  },
  {
    key: "docx",
    label: "com.myoxus.import.docx",
    prefixIcon: <FileIconDocxIcon />,
    testId: "editor-option-menu-import-docx",
    type: "docx" as ImportType,
  },
  {
    key: "snapshot",
    label: "com.myoxus.import.snapshot",
    prefixIcon: <ArchiveRestoreIcon />,
    testId: "editor-option-menu-import-snapshot",
    type: "snapshot" as ImportType,
  },
  {
    key: "workspace",
    label: "com.myoxus.cmdk.import-workspace",
    prefixIcon: <ArchiveRestoreIcon />,
    testId: "editor-option-menu-import-workspace",
    type: "workspace" as ImportType,
  },
];

const importConfigs: Record<Exclude<ImportType, "docx">, ImportConfig> & {
  docx: { fileOptions: ImportConfig["fileOptions"] };
} = {
  bpmn: {
    fileOptions: { acceptType: "Bpmn", multiple: true },
    importFunction: async (
      _collection,
      files,
      _workspace,
      _organize,
      _icons,
      _snapshots,
      _access,
      registry,
    ) => {
      if (!registry) throw new Error("DIAGRAM_REGISTRY_UNAVAILABLE");
      const bpmn = await runBpmnImport(
        registry,
        await prepareBpmnImport(files),
      );
      return { docIds: bpmn.docIds, bpmn };
    },
  },
  markdown: {
    fileOptions: { acceptType: "Markdown", multiple: true },
    importFunction: async (
      docCollection,
      files,
      _handleImportWorkspace,
      _organizeService,
      _explorerIconService,
      _snapshotHooks,
      access,
    ) => {
      const docIds: string[] = [];
      const markdownDiagnostics = emptyMarkdownImportDiagnostics();
      for (const file of files) {
        const text = await file.text();
        const fileName = file.name.split(".").slice(0, -1).join(".");
        const { docId, diagnostics } =
          await MarkdownTransformer.importMarkdownToDoc({
            collection: docCollection,
            schema: getMyoxusWorkspaceSchema(),
            markdown: text,
            fileName,
            extensions: getStoreManager().config.init().value.get("store"),
            access,
          });
        markdownDiagnostics.unresolvedReferences +=
          diagnostics.unresolvedReferences;
        markdownDiagnostics.unsupportedReferences +=
          diagnostics.unsupportedReferences;
        for (const key of [
          "unsupportedAnnotations",
          "normalizedAnnotations",
          "unsupportedCallouts",
          "unsupportedMath",
          "unsupportedTables",
        ] as const) {
          if (diagnostics[key])
            markdownDiagnostics[key] =
              (markdownDiagnostics[key] ?? 0) + diagnostics[key];
        }
        if (docId) docIds.push(docId);
      }
      return {
        docIds,
        markdownDiagnostics,
      };
    },
  },
  mermaid: {
    fileOptions: { acceptType: "Mermaid", multiple: true },
    importFunction: async (docCollection, files) => {
      return {
        docIds: await importMermaidFilesToDocs({
          collection: docCollection,
          files,
        }),
      };
    },
  },
  markdownZip: {
    fileOptions: { acceptType: "Zip", multiple: false },
    importFunction: async (
      docCollection,
      files,
      _handleImportWorkspace,
      _organizeService,
      _explorerIconService,
      _snapshotHooks,
      access,
    ) => {
      const file = files.length === 1 ? files[0] : null;
      if (!file) {
        throw new Error("Expected a single zip file for markdownZip import");
      }
      const { docIds, diagnostics: markdownDiagnostics } =
        await MarkdownTransformer.importMarkdownZip({
          collection: docCollection,
          schema: getMyoxusWorkspaceSchema(),
          imported: file,
          extensions: getStoreManager().config.init().value.get("store"),
          access,
        });
      return {
        docIds,
        markdownDiagnostics,
      };
    },
  },
  html: {
    fileOptions: { acceptType: "Html", multiple: true },
    importFunction: async (
      docCollection,
      files,
      _handleImportWorkspace,
      _organizeService,
      _explorerIconService,
    ) => {
      const docIds: string[] = [];
      for (const file of files) {
        const text = await file.text();
        const fileName = file.name.split(".").slice(0, -1).join(".");
        const docId = await HtmlTransformer.importHTMLToDoc({
          collection: docCollection,
          schema: getMyoxusWorkspaceSchema(),
          extensions: getStoreManager().config.init().value.get("store"),
          html: text,
          fileName,
        });
        if (docId) docIds.push(docId);
      }
      return {
        docIds,
      };
    },
  },
  docx: {
    fileOptions: { acceptType: "Docx", multiple: false },
  },
  snapshot: {
    fileOptions: { acceptType: "Zip", multiple: false },
    importFunction: async (
      docCollection,
      files,
      _handleImportWorkspace,
      _organizeService,
      _explorerIconService,
      snapshotHooks,
    ) => {
      const file = files.length === 1 ? files[0] : null;
      if (!file) {
        throw new Error("Expected a single zip file for snapshot import");
      }
      const docIds = (
        await ZipTransformer.importDocs(
          docCollection,
          getMyoxusWorkspaceSchema(),
          file,
          snapshotHooks,
        )
      )
        .filter((doc) => doc !== undefined)
        .map((doc) => doc.id);

      return {
        docIds,
      };
    },
  },
  workspace: {
    fileOptions: { acceptType: "Skip", multiple: false },
    importFunction: async (
      _,
      __,
      handleImportWorkspace,
      _organizeService,
      _explorerIconService,
    ) => {
      await handleImportWorkspace();
      return {
        docIds: [],
        entryId: undefined,
        isWorkspaceFile: true,
      };
    },
  },
};

const ImportOptionItem = ({
  label,
  prefixIcon,
  type,
  onImport,
  unavailableReason,
  ...props
}: {
  label: string;
  prefixIcon: ReactElement<SVGAttributes<SVGElement>>;
  type: ImportType;
  onImport: (type: ImportType) => void | Promise<unknown>;
  unavailableReason?: string;
  "data-testid"?: string;
}) => {
  const t = useI18n();
  const translatedLabel =
    typeof (t as unknown as Record<string, () => string>)[label] === "function"
      ? (t as unknown as Record<string, () => string>)[label]()
      : label;
  return (
    <Tooltip
      content={unavailableReason}
      events={{ hover: true, focus: true, touch: false }}
    >
      <MenuItem
        block
        aria-disabled={Boolean(unavailableReason)}
        aria-description={unavailableReason}
        suffixIcon={unavailableReason ? <InformationIcon /> : undefined}
        closeMenuOnClick={!unavailableReason}
        onSelect={() => {
          if (!unavailableReason) void onImport(type);
        }}
        prefixIcon={prefixIcon}
        {...props}
      >
        {translatedLabel}
      </MenuItem>
    </Tooltip>
  );
};

export const ImportMenuItems = ({
  onImport,
}: {
  onImport: (type: ImportType) => void | Promise<unknown>;
}) => {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const server = useLiveData(useService(WorkspaceServerService).server$);
  const online = useSystemOnline();
  const canCreate = useGuard("Workspace_CreateDoc");
  const wordUnavailable =
    workspace.flavour === "local" || !server || !online
      ? t["com.myoxus.import.word.unavailable"]()
      : canCreate === false
        ? t["com.myoxus.import.word.permission"]()
        : canCreate === undefined
          ? t.Loading()
          : undefined;
  return (
    <>
      {importOptions.map(({ key, label, prefixIcon, testId, type }) => (
        <ImportOptionItem
          key={key}
          prefixIcon={prefixIcon}
          label={label}
          type={type}
          unavailableReason={type === "docx" ? wordUnavailable : undefined}
          onImport={onImport}
          data-testid={testId}
        />
      ))}
    </>
  );
};

const ImportOptions = ({
  onImport,
}: {
  onImport: (type: ImportType) => void | Promise<unknown>;
}) => {
  const t = useI18n();

  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["Import"]()}
      </MyoxusTitle>
      <MenuPanel panelWidth="wide">
        <ImportMenuItems onImport={onImport} />
      </MenuPanel>
    </>
  );
};

const ImportingStatus = () => {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["com.myoxus.import.status.importing.title"]()}
      </MyoxusTitle>
      <MyoxusText component="p" textAlign="center" tone="secondary">
        {t["com.myoxus.import.status.importing.message"]()}
      </MyoxusText>
    </>
  );
};

export const SuccessStatus = ({
  onComplete,
  result,
}: {
  onComplete: () => void;
  result: ImportResult | null;
}) => {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["com.myoxus.import.status.success.title"]()}
      </MyoxusTitle>
      <MyoxusText component="p" textAlign="center" tone="secondary">
        {t["com.myoxus.import.status.success.message"]()}
      </MyoxusText>
      {result?.markdownDiagnostics &&
      (result.markdownDiagnostics.unresolvedReferences ||
        result.markdownDiagnostics.unsupportedReferences) ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.import.markdown.reference-diagnostics.message"]({
            unresolved: String(result.markdownDiagnostics.unresolvedReferences),
            unsupported: String(
              result.markdownDiagnostics.unsupportedReferences,
            ),
          })}
        </MyoxusText>
      ) : null}
      {result?.markdownDiagnostics &&
      (result.markdownDiagnostics.unsupportedAnnotations ||
        result.markdownDiagnostics.normalizedAnnotations) ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.annotation-diagnostics.message"]({
            unsupported: String(
              result.markdownDiagnostics.unsupportedAnnotations ?? 0,
            ),
            normalized: String(
              result.markdownDiagnostics.normalizedAnnotations ?? 0,
            ),
          })}
        </MyoxusText>
      ) : null}
      {result?.markdownDiagnostics?.unsupportedCallouts ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.callout-diagnostics"]({
            count: String(result.markdownDiagnostics.unsupportedCallouts),
          })}
        </MyoxusText>
      ) : null}
      {result?.markdownDiagnostics?.unsupportedMath ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.math-diagnostics"]({
            count: String(result.markdownDiagnostics.unsupportedMath),
          })}
        </MyoxusText>
      ) : null}
      {result?.markdownDiagnostics?.unsupportedTables ? (
        <MyoxusText component="p" textAlign="center" tone="warning">
          {t["com.myoxus.markdown.table-diagnostics"]({
            count: String(result.markdownDiagnostics.unsupportedTables),
          })}
        </MyoxusText>
      ) : null}
      <DialogFooterActions>
        <Button onClick={onComplete} variant="primary">
          {t["Complete"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
};

/** File outcomes remain visible together; a partial attempt never gets the
 * generic success screen. Retry skips successes and retains original targets. */
function BpmnImportStatus({
  result,
  registry,
  onRetry,
  onComplete,
}: {
  result: BpmnImportResult;
  registry: MermaidDiagramsService;
  onRetry: () => Promise<void>;
  onComplete: () => void;
}) {
  const t = useI18n();
  const creation = useLiveData(registry.creation$);
  const workbench = useService(WorkbenchService).workbench;
  const unfinished = result.entries.some(
    (entry) =>
      isPreservableBpmnImport(entry) && entry.creation?.status !== "ready",
  );
  const blocked =
    creation?.failed &&
    !result.entries.some((entry) => entry.creation?.docId === creation.docId);
  return (
    <>
      <MyoxusTitle order={2}>{t.Import()}</MyoxusTitle>
      {blocked && (
        <Notice
          tone="warning"
          title={t["com.myoxus.diagrams.catalog.create-error"]()}
        >
          <Stack>
            <Text>{creation.title || t.Untitled()}</Text>
            <Button
              onClick={() => {
                onComplete();
                workbench.open(
                  `/diagrams?recoverDiagram=${encodeURIComponent(creation.docId)}`,
                  { at: "active" },
                );
              }}
            >
              {t.Retry()}
            </Button>
          </Stack>
        </Notice>
      )}
      <Accordion
        data-testid="bpmn-import-results"
        defaultValue={String(
          result.entries.findIndex(
            (entry) => entry.inspection.status !== "accepted",
          ),
        )}
      >
        {result.entries.map((entry, index) => {
          const ready = entry.creation?.status === "ready";
          const safe = isPreservableBpmnImport(entry);
          const accepted = entry.inspection.status === "accepted";
          return (
            <AccordionItem key={index} value={String(index)}>
              <AccordionControl>
                <Group>
                  <Text>{entry.file.name}</Text>
                  <Badge
                    tone={
                      ready && accepted ? "success" : safe ? "warning" : "error"
                    }
                  >
                    {ready
                      ? t["com.myoxus.import.status.success.title"]()
                      : !safe
                        ? t["com.myoxus.import.status.failed.title"]()
                        : entry.creation
                          ? t["com.myoxus.diagrams.catalog.create-error"]()
                          : t.Pending()}
                  </Badge>
                </Group>
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  {ready && !accepted && (
                    <Text>{t["com.myoxus.editor.bpmn.source-error"]()}</Text>
                  )}
                  {entry.inspection.status !== "accepted" && (
                    <Text>
                      {bpmnSourceErrorText(t, entry.inspection.error.code)}
                    </Text>
                  )}
                  <Group>
                    <Button
                      variant="secondary"
                      onClick={() => downloadBlob(entry.file, entry.file.name)}
                    >
                      {t["com.myoxus.attachment.download"]()}
                    </Button>
                  </Group>
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          );
        })}
      </Accordion>
      <DialogFooterActions>
        {unfinished && (
          <Button
            variant="primary"
            disabled={Boolean(blocked)}
            onClick={() => void onRetry()}
          >
            {t.Retry()}
          </Button>
        )}
        <Button
          variant={unfinished ? "secondary" : "primary"}
          onClick={onComplete}
        >
          {t.Complete()}
        </Button>
      </DialogFooterActions>
    </>
  );
}

const ErrorStatus = ({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) => {
  const t = useI18n();
  return (
    <>
      <MyoxusTitle order={2} textAlign="center" typographySlot="section-title">
        {t["com.myoxus.import.status.failed.title"]()}
      </MyoxusTitle>
      <MyoxusText component="p" textAlign="center" tone="secondary">
        {error || "Unknown error occurred"}
      </MyoxusText>
      <DialogFooterActions>
        <Button onClick={onRetry} variant="primary">
          {t["Retry"]()}
        </Button>
      </DialogFooterActions>
    </>
  );
};

type UseWorkspaceImportOptions = {
  returnFocusRef?: RefObject<HTMLElement | null>;
  onComplete?: (result: ImportResult) => void;
  onError?: (error: string | null) => void;
  onStatusChange?: (status: ImportStatus) => void;
  docxPresentation?: "dialog" | "notification";
};

export function useWorkspaceImport({
  returnFocusRef,
  onComplete,
  onError,
  onStatusChange,
  docxPresentation = "notification",
}: UseWorkspaceImportOptions = {}) {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const diagramRegistry = useService(MermaidDiagramsService);
  const guardService = useService(GuardService);
  const workspaceServerService = useService(WorkspaceServerService);
  const defaultServerService = useService(DefaultServerService);
  const docCollection = workspace.docCollection;
  const organizeService = useService(OrganizeService);
  const explorerIconService = useService(ExplorerIconService);
  const globalDialogService = useService(GlobalDialogService);
  const { jumpToPage } = useNavigateHelper();
  const importWord = useOwnedDocxImport({
    onComplete,
    presentation: docxPresentation,
  });

  const handleCreatedWorkspace = useCallback(
    (payload: { metadata: WorkspaceMetadata; defaultDocId?: string }) => {
      if (document.startViewTransition) {
        document.startViewTransition(() => {
          if (payload.defaultDocId) {
            jumpToPage(payload.metadata.id, payload.defaultDocId);
          } else {
            jumpToPage(payload.metadata.id, "home");
          }
          return new Promise((resolve) =>
            setTimeout(resolve, 150),
          ); /* start transition after 150ms */
        });
      } else {
        if (payload.defaultDocId) {
          jumpToPage(payload.metadata.id, payload.defaultDocId);
        } else {
          jumpToPage(payload.metadata.id, "home");
        }
      }
    },
    [jumpToPage],
  );

  const handleImportWorkspace = useCallback(async () => {
    track.$.navigationPanel.workspaceList.createWorkspace({
      control: "import",
    });

    return new Promise<WorkspaceMetadata | undefined>((resolve, reject) => {
      globalDialogService.open(
        "import-workspace",
        { returnFocusRef },
        (payload) => {
          if (payload) {
            handleCreatedWorkspace({ metadata: payload.workspace });
            resolve(payload.workspace);
          } else {
            reject(new Error("No workspace imported"));
          }
        },
      );
    });
  }, [globalDialogService, handleCreatedWorkspace, returnFocusRef]);

  return useAsyncCallback(
    async (type: ImportType) => {
      if (type === "docx") {
        await importWord();
        return;
      }
      onError?.(null);
      const access = new CoreDocEmbedProvider(
        guardService,
        docsService,
        workspace,
      );
      try {
        const importConfig = importConfigs[type];
        const { acceptType, multiple } = importConfig.fileOptions;

        const files =
          acceptType === "Skip"
            ? []
            : await openFilesWith(acceptType, multiple);

        if (!files || (files.length === 0 && acceptType !== "Skip")) {
          onStatusChange?.("idle");
          return;
        }

        if (acceptType !== "Skip") {
          onStatusChange?.("importing");
          track.$.importModal.$.import({
            type,
            status: "importing",
          });
        }

        const result = await importConfig.importFunction(
          docCollection,
          files,
          handleImportWorkspace,
          organizeService,
          explorerIconService,
          type === "snapshot" && workspace.flavour !== "local"
            ? await snapshotLabelImportHooks(
                workspace,
                docsService,
                (
                  workspaceServerService.server || defaultServerService.server
                ).scope.get(GraphQLService),
                files[0],
              )
            : undefined,
          access,
          diagramRegistry,
        );

        onComplete?.(result);
        onStatusChange?.("success");
        track.$.importModal.$.import({
          type,
          status: "success",
          result: {
            docCount: result.docIds.length,
          },
        });
        track.$.importModal.$.createDoc({
          control: "import",
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          onStatusChange?.("idle");
          return;
        }
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        onError?.(errorMessage);
        onStatusChange?.("error");
        track.$.importModal.$.import({
          type,
          status: "failed",
          error: errorMessage || undefined,
        });
        logger.error("Failed to import", error);
      } finally {
        access.dispose();
      }
    },
    [
      workspace,
      importWord,
      docsService,
      diagramRegistry,
      guardService,
      workspaceServerService,
      defaultServerService,
      docCollection,
      explorerIconService,
      handleImportWorkspace,
      onComplete,
      onError,
      onStatusChange,
      organizeService,
      t,
    ],
  );
}

export const ImportDialog = ({
  close,
  bpmnImport,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["import"]>) => {
  const t = useI18n();
  const [status, setStatus] = useState<ImportStatus>(
    bpmnImport ? "success" : "idle",
  );
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(
    bpmnImport ? { docIds: bpmnImport.docIds, bpmn: bpmnImport } : null,
  );
  const diagramRegistry = useService(MermaidDiagramsService);
  const docsService = useService(DocsService);
  const wordAttempt = useLiveData(docsService.docxImport$);
  const [wordActive, setWordActive] = useState(
    wordAttempt?.status === "selecting" || wordAttempt?.status === "importing",
  );
  const { jumpToPage } = useNavigateHelper();
  const handleImport = useWorkspaceImport({
    docxPresentation: "dialog",
    onComplete: setImportResult,
    onError: setImportError,
    onStatusChange: (nextStatus) => {
      if (nextStatus === "importing") setImportResult(null);
      setStatus(nextStatus);
    },
  });

  const handleComplete = useCallback(() => {
    close(importResult || undefined);
  }, [importResult, close]);

  const handleRetry = () => {
    setWordActive(false);
    setImportResult(null);
    setStatus("idle");
  };

  const statusComponents = {
    idle: (
      <ImportOptions
        onImport={(type) => {
          setWordActive(type === "docx");
          return handleImport(type);
        }}
      />
    ),
    importing: <ImportingStatus />,
    success: importResult?.bpmn ? (
      <BpmnImportStatus
        result={importResult.bpmn}
        registry={diagramRegistry}
        onComplete={handleComplete}
        onRetry={async () => {
          setStatus("importing");
          try {
            const bpmn = await runBpmnImport(
              diagramRegistry,
              importResult.bpmn!,
            );
            setImportResult({ docIds: bpmn.docIds, bpmn });
          } finally {
            setStatus("success");
          }
        }}
      />
    ) : (
      <SuccessStatus onComplete={handleComplete} result={importResult} />
    ),
    error: <ErrorStatus error={importError} onRetry={handleRetry} />,
  };

  return (
    <Modal
      open
      onOpenChange={(open: boolean) => {
        if (!open) {
          if (wordActive && docsService.docxImport$.value) {
            showDocxImportNotification(docsService, jumpToPage);
            close();
            return;
          }
          close(importResult || undefined);
        }
      }}
      contentOptions={{
        ["data-testid" as string]: "import-modal",
        "aria-label": t["Import"](),
      }}
      withoutCloseButton={!wordActive && status === "importing"}
      persistent={!wordActive && status === "importing"}
    >
      <Stack
        p="lg"
        data-myoxus-ui-role="import-dialog-content"
        data-testid="import-dialog"
      >
        {wordActive && wordAttempt ? (
          <DocxImportStatus
            attempt={wordAttempt}
            onOpen={() => {
              if (wordAttempt.status !== "complete") return;
              close({ docIds: [wordAttempt.id] });
              jumpToPage(wordAttempt.workspaceId, wordAttempt.id);
            }}
            onInspect={() => {
              close();
              jumpToPage(wordAttempt.workspaceId, "all");
              showDocxImportNotification(docsService, jumpToPage);
            }}
            onSelect={() => {
              void handleImport("docx");
            }}
          />
        ) : (
          statusComponents[status]
        )}
      </Stack>
    </Modal>
  );
};
