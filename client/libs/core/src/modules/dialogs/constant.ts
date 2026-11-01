import type {
  TaskReferenceSource,
  TaskReferenceTarget,
  TaskReferenceInsertionState,
} from "../database/tasks/task-reference-insertion";
import type { RefObject } from "react";
import type { FilterParams } from "../collection-rules";
import type { EdgelessSnapshotPreflightResult } from "@virgultum/editor/blocks/surface";
import type { DocMode } from "@virgultum/editor/model";

import type { ServerPdfExportResult } from "../pdf-export/run-server-export";
import type {
  PdfExportDialogBootstrap,
  PdfExportDialogFormValue,
} from "../pdf-export/types";
import type { WorkspaceMetadata } from "../workspace";
import type { WorkspaceContentOperationDialogProps } from "../workspace-content-operation";

export type UserSettingTab =
  | "shortcuts"
  | "notifications"
  | "appearance"
  | "language-region"
  | "about"
  | "backup" // electron only
  | "experimental-features"
  | "editor"
  | "journal"
  | "account"
  | "meetings";

export type WorkspaceSettingTab =
  `workspace:${"preference" | "properties" | "documents" | "members" | "storage" | "integrations" | "embedding" | "search" | "pdf-export" | "organization"}`;

export type SettingTab = UserSettingTab | WorkspaceSettingTab;

export type GLOBAL_DIALOG_SCHEMA = {
  "create-workspace": (props: {
    serverId?: string;
    returnFocusRef?: RefObject<HTMLElement | null>;
  }) => {
    metadata: WorkspaceMetadata;
    defaultDocId?: string;
  };
  "import-workspace": (props?: {
    returnFocusRef?: RefObject<HTMLElement | null>;
  }) => {
    workspace: WorkspaceMetadata;
  };
  "import-template": (props: {
    templateName: string;
    templateMode: DocMode;
    snapshotUrl: string;
  }) => void;
  "sign-in": (props: { server?: string; step?: string }) => void;
  "change-password": (props: { server?: string }) => void;
  "verify-email": (props: { server?: string; changeEmail?: boolean }) => void;
  "enable-cloud": (props: {
    workspaceId: string;
    openPageId?: string;
    serverId?: string;
  }) => boolean;
  "deleted-account": () => void;
};

export type WORKSPACE_DIALOG_SCHEMA = {
  "bpmn-editor": (props: {
    session: import("../bpmn-editor/session").BpmnEditorSession;
  }) => import("@virgultum/shared/services").MyoxusBpmnEditorCloseResult;
  "template-inputs": (props: {
    prompt: import("../template-doc/services/template-input-prompt").TemplateInputPrompt;
  }) => void;
  "task-reference-insert": (props: {
    openingOwnerIdentity: string;
    source: TaskReferenceSource;
    returnFocusRef?: RefObject<HTMLElement | null>;
    onInsertReference: (
      intentId: string,
      target: TaskReferenceTarget,
      source: TaskReferenceSource,
    ) => Promise<TaskReferenceInsertionState>;
  }) => void;
  "task-capture": (props: {
    sourceDocumentId: string;
    sourceExternalId: string;
    openingOwnerIdentity: string;
    /** Live source-scope refresh only; never persisted with a capture attempt. */
    onConfirmed?: () => void;
    onCaptureReleased?: (requestId: string) => void;
    onInsertReference?: (
      requestId: string,
      target: TaskReferenceTarget,
      source: TaskReferenceSource,
    ) => Promise<TaskReferenceInsertionState>;
    blockId: string;
    selectionAnchor?: string;
    excerpt: string;
    returnFocusRef?: RefObject<HTMLElement | null>;
  }) => void;
  "user-settings": (props: {
    activeTab?: UserSettingTab;
    scrollAnchor?: string;
  }) => void;
  "workspace-settings": (props: {
    activeTab?: WorkspaceSettingTab;
    scrollAnchor?: string;
  }) => void;
  "doc-info": (props: {
    docId: string;
    returnFocusRef?: RefObject<HTMLElement | null>;
  }) => void;
  "doc-selector": (props: {
    init: string[];
    multiple?: boolean;
    extraFilters?: readonly FilterParams[];
    returnFocusRef?: RefObject<HTMLElement | null>;
    onBeforeConfirm?: (ids: string[], cb: () => void) => void;
  }) => string[];
  "collection-selector": (props: {
    init: string[];
    onBeforeConfirm?: (ids: string[], cb: () => void) => void;
  }) => string[];
  "database-selector": (props: {
    init?: string[];
    returnFocusRef?: RefObject<HTMLElement | null>;
  }) => { databaseId: string; viewId?: string | null } | undefined;
  "collection-editor": (props: {
    collectionId: string;
    mode?: "page" | "rule";
  }) => void;
  "tag-selector": (props: {
    init: string[];
    onBeforeConfirm?: (ids: string[], cb: () => void) => void;
  }) => string[];
  "date-selector": (props: {
    position?: [number, number, number, number]; // [x, y, width, height]
    onSelect?: (date?: string) => void;
  }) => string;
  import: (props?: {
    bpmnImport?: import("../mermaid-diagrams/services/bpmn-import").BpmnImportResult;
  }) => {
    docIds: string[];
    entryId?: string;
    isWorkspaceFile?: boolean;
  };
  "event-edit": (props: {
    /** Undefined = create mode; defined = edit mode. */
    eventId?: string;
    /** Pre-fill the start date in create mode (ISO date string). */
    defaultDate?: string;
    /** Link the created event to a journal or other doc. */
    sourceDocId?: string;
  }) => string | null;
  "event-block-remove": (props: { eventId: string }) => boolean;
  "pdf-export": (props: {
    workspaceId: string;
    docId: string;
    docTitle: string;
    bootstrap: PdfExportDialogBootstrap;
    onBeforeStart?: () => Promise<boolean | void>;
    returnFocusRef?: RefObject<HTMLElement | null>;
    initialTemplateId?: string | null;
    initialFormValue?: PdfExportDialogFormValue;
  }) => ServerPdfExportResult | null;
  "pdf-export-edgeless-preflight": (props: {
    result: EdgelessSnapshotPreflightResult;
  }) => boolean;
  "workspace-content-operation": (
    props: WorkspaceContentOperationDialogProps,
  ) => void;
};
