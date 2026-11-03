// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AddTabOption,
  AppGroupInfo,
  BackupWorkspaces,
  BlobRecord,
  BookmarkData,
  CrawlResult,
  DocClock,
  DocIndexedClock,
  DocRecord,
  FakeDialogResult,
  FindInPageOptions,
  FindInPageResult,
  FullTextMatch,
  FullTextSearchResult,
  ListedBlobRecord,
  LoadDBFileResult,
  MeetingPermissions,
  RawAudioBuffers,
  RecordingDetails,
  RecordingDestination,
  RecordingDelivery,
  RecordingFailure,
  RecordingStatus,
  Rectangle,
  SaveDBFileResult,
  SelectDBFileLocationResult,
  SharedStorageSnapshot,
  SharedStorageValue,
  TabAction,
  TabStatus,
  TabViewsMetaSchema,
  UpdateInfo,
  UpdaterConfig,
  UpdaterState,
  WorkspaceLabelExport,
  WorkbenchMeta,
  WorkbenchViewMeta,
  WorkerConnection,
} from "./dto";

/** Closed file-delivery formats; native callers cannot supply arbitrary filters. */
export type ExportFileFormat = "pdf" | "docx";

export type DesktopHandler<Args, Result = void> = Args extends readonly [
  ...infer Parameters,
]
  ? (...args: Parameters) => Promise<Result>
  : never;

export type MainClientHandlers = {
  debug: {
    revealLogFile: DesktopHandler<[], string>;
    logFilePath: DesktopHandler<[], string>;
  };
  ui: {
    isMaximized: DesktopHandler<[], boolean | undefined>;
    isFullScreen: DesktopHandler<[], boolean | undefined>;
    handleThemeChange: DesktopHandler<
      [theme: "system" | "light" | "dark"],
      void
    >;
    handleMinimizeApp: DesktopHandler<[], void>;
    handleMaximizeApp: DesktopHandler<[], void>;
    handleWindowResize: DesktopHandler<[], void>;
    handleCloseApp: DesktopHandler<[], void>;
    handleHideApp: DesktopHandler<[], void>;
    getChallengeResponse: DesktopHandler<
      [challenge: string],
      string | undefined
    >;
    handleOpenMainApp: DesktopHandler<[], void>;
    getBookmarkDataByLink: DesktopHandler<[link: string], BookmarkData>;
    openExternal: DesktopHandler<[url: string], void>;
    isActiveTab: DesktopHandler<[], boolean>;
    getWorkbenchMeta: DesktopHandler<[id: string], WorkbenchMeta | undefined>;
    updateWorkbenchMeta: DesktopHandler<
      [id: string, meta: Partial<Omit<WorkbenchMeta, "id">>],
      void
    >;
    updateWorkbenchViewMeta: DesktopHandler<
      [
        workbenchId: string,
        viewId: string | number,
        meta: Partial<WorkbenchViewMeta>,
      ],
      void
    >;
    getTabViewsMeta: DesktopHandler<[], TabViewsMetaSchema>;
    updateActiveViewMeta: DesktopHandler<
      [meta: Partial<WorkbenchViewMeta>],
      void
    >;
    getTabsStatus: DesktopHandler<[], TabStatus[]>;
    addTab: DesktopHandler<[option?: AddTabOption], void>;
    showTab: DesktopHandler<[id: string], void>;
    tabGoTo: DesktopHandler<[tabId: string, to: string], void>;
    ensureTabLoaded: DesktopHandler<[tabId: string], void>;
    closeTab: DesktopHandler<[tabId?: string], void>;
    setCloseParticipant: DesktopHandler<
      [participantId: string, participating: boolean],
      boolean
    >;
    answerCloseRequest: DesktopHandler<
      [requestId: string, participantId: string, allowed: boolean],
      boolean
    >;
    activateView: DesktopHandler<[tabId: string, viewIndex: number], void>;
    moveTab: DesktopHandler<
      [from: string, to: string, edge?: "left" | "right"],
      void
    >;
    toggleRightSidebar: DesktopHandler<[tabId?: string], void>;
    pingAppLayoutReady: DesktopHandler<[ready?: boolean], void>;
    showDevTools: DesktopHandler<[id?: string], void>;
    showTabContextMenu: DesktopHandler<
      [tabId: string, viewIndex: number],
      TabAction | null
    >;
    openThemeEditor: DesktopHandler<[], void>;
    restartApp: DesktopHandler<[], void>;
    showCalendarReminderNotification: DesktopHandler<
      [title: string, body: string, eventId: string, startDate: string],
      void
    >;
    onLanguageChange: DesktopHandler<[language: string], void>;
    invalidateBranding: DesktopHandler<[], void>;
    saveExportFile: DesktopHandler<
      [format: ExportFileFormat, filename: string, bytes: ArrayBuffer],
      { status: "saved" } | { status: "cancelled" }
    >;
    savePdf: DesktopHandler<
      [filename: string, bytes: ArrayBuffer],
      { status: "saved" } | { status: "cancelled" }
    >;
    captureArea: DesktopHandler<[area: Rectangle], void>;
  };
  clipboard: {
    copyAsPNG: DesktopHandler<[image: ArrayBuffer], boolean>;
  };
  updater: {
    currentVersion: DesktopHandler<[], string>;
    quitAndInstall: DesktopHandler<[], void>;
    downloadUpdate: DesktopHandler<[], void>;
    getConfig: DesktopHandler<[], UpdaterConfig>;
    setConfig: DesktopHandler<[config: Partial<UpdaterConfig>], void>;
    getState: DesktopHandler<[], UpdaterState>;
    checkForUpdates: DesktopHandler<[], UpdateInfo>;
  };
  findInPage: {
    find: DesktopHandler<
      [query: string, options?: FindInPageOptions],
      FindInPageResult | null
    >;
    clear: DesktopHandler<[], void>;
  };
  sharedStorage: {
    getAllGlobalState: DesktopHandler<[], SharedStorageSnapshot>;
    getAllGlobalCache: DesktopHandler<[], SharedStorageSnapshot>;
    setGlobalState: DesktopHandler<
      [key: string, value: SharedStorageValue, sourceId?: string],
      void
    >;
    delGlobalState: DesktopHandler<[key: string, sourceId?: string], void>;
    clearGlobalState: DesktopHandler<[sourceId?: string], void>;
    setGlobalCache: DesktopHandler<
      [key: string, value: SharedStorageValue, sourceId?: string],
      void
    >;
    delGlobalCache: DesktopHandler<[key: string, sourceId?: string], void>;
    clearGlobalCache: DesktopHandler<[sourceId?: string], void>;
  };
  worker: {
    connectWorker: DesktopHandler<
      [key: string, portId: string],
      WorkerConnection
    >;
    disconnectWorker: DesktopHandler<[key: string, portId: string], void>;
  };
  recording: {
    getRecording: DesktopHandler<[id: number], RecordingDetails | undefined>;
    getCurrentRecording: DesktopHandler<[], RecordingStatus | null>;
    startRecording: DesktopHandler<
      [appGroup?: AppGroupInfo | number],
      RecordingStatus | null
    >;
    listRecoverableRecordings: DesktopHandler<[], RecordingStatus[]>;
    getRecordingDestinations: DesktopHandler<
      [],
      Array<{ viewId: string; destination: RecordingDestination }>
    >;
    retryRecording: DesktopHandler<
      [id: number, destinationViewId?: string],
      void
    >;
    claimRecordingDelivery: DesktopHandler<[id: number], string | null>;
    updateRecordingDelivery: DesktopHandler<
      [id: number, delivery: RecordingDelivery, claim: string],
      void
    >;
    pauseRecording: DesktopHandler<[id: number], RecordingStatus | null>;
    stopRecording: DesktopHandler<[id: number], RecordingStatus | null>;
    getRawAudioBuffers: DesktopHandler<
      [id: number, cursor?: number],
      RawAudioBuffers
    >;
    readRecordingFile: DesktopHandler<[filepath: string], Uint8Array>;
    readyRecording: DesktopHandler<[id: number, buffer: Uint8Array], void>;
    handleBlockCreationSuccess: DesktopHandler<
      [id: number, claim: string],
      void
    >;
    handleBlockCreationFailed: DesktopHandler<
      [id: number, error?: RecordingFailure, claim?: string],
      void
    >;
    removeRecording: DesktopHandler<[id: number], void>;
    checkRecordingAvailable: DesktopHandler<[], boolean>;
    setupRecordingFeature: DesktopHandler<[], boolean | undefined>;
    disableRecordingFeature: DesktopHandler<[], void>;
    checkMeetingPermissions: DesktopHandler<[], MeetingPermissions | undefined>;
    askForMeetingPermission: DesktopHandler<
      [type: "screen" | "microphone"],
      boolean
    >;
    showRecordingPermissionSetting: DesktopHandler<
      [type: "screen" | "microphone"],
      boolean | void
    >;
    showSavedRecordings: DesktopHandler<[subpath?: string], void>;
  };
  popup: {
    getCurrentNotification: DesktopHandler<[], null>;
    dismissCurrentNotification: DesktopHandler<[], void>;
    dismissCurrentRecording: DesktopHandler<[], void>;
  };
  i18n: {
    changeLanguage: DesktopHandler<[language: string], void>;
  };
};

export type NativeStoreHandlers = {
  connect: DesktopHandler<[id: string], void>;
  disconnect: DesktopHandler<[id: string], void>;
  pushUpdate: DesktopHandler<
    [id: string, docId: string, update: Uint8Array],
    Date
  >;
  getDocSnapshot: DesktopHandler<[id: string, docId: string], DocRecord | null>;
  setDocSnapshot: DesktopHandler<[id: string, snapshot: DocRecord], boolean>;
  getDocUpdates: DesktopHandler<[id: string, docId: string], DocRecord[]>;
  markUpdatesMerged: DesktopHandler<
    [id: string, docId: string, updates: Date[]],
    number
  >;
  deleteDoc: DesktopHandler<[id: string, docId: string], void>;
  getDocClocks: DesktopHandler<[id: string, after?: Date | null], DocClock[]>;
  getDocClock: DesktopHandler<[id: string, docId: string], DocClock | null>;
  getDocIndexedClock: DesktopHandler<
    [id: string, docId: string],
    DocIndexedClock | null
  >;
  setDocIndexedClock: DesktopHandler<
    [id: string, docId: string, indexedClock: Date, indexerVersion: number],
    void
  >;
  clearDocIndexedClock: DesktopHandler<[id: string, docId: string], void>;
  getBlob: DesktopHandler<[id: string, key: string], BlobRecord | null>;
  setBlob: DesktopHandler<[id: string, blob: BlobRecord], void>;
  deleteBlob: DesktopHandler<
    [id: string, key: string, permanently: boolean],
    void
  >;
  releaseBlobs: DesktopHandler<[id: string], void>;
  listBlobs: DesktopHandler<[id: string], ListedBlobRecord[]>;
  getPeerRemoteClocks: DesktopHandler<[id: string, peer: string], DocClock[]>;
  getPeerRemoteClock: DesktopHandler<
    [id: string, peer: string, docId: string],
    DocClock | null
  >;
  setPeerRemoteClock: DesktopHandler<
    [id: string, peer: string, docId: string, clock: Date],
    void
  >;
  getPeerPulledRemoteClocks: DesktopHandler<
    [id: string, peer: string],
    DocClock[]
  >;
  getPeerPulledRemoteClock: DesktopHandler<
    [id: string, peer: string, docId: string],
    DocClock | null
  >;
  setPeerPulledRemoteClock: DesktopHandler<
    [id: string, peer: string, docId: string, clock: Date],
    void
  >;
  getPeerPushedClocks: DesktopHandler<[id: string, peer: string], DocClock[]>;
  getPeerPushedClock: DesktopHandler<
    [id: string, peer: string, docId: string],
    DocClock | null
  >;
  setPeerPushedClock: DesktopHandler<
    [id: string, peer: string, docId: string, clock: Date],
    void
  >;
  clearClocks: DesktopHandler<[id: string], void>;
  setBlobUploadedAt: DesktopHandler<
    [id: string, peer: string, blobId: string, uploadedAt: Date | null],
    void
  >;
  getBlobUploadedAt: DesktopHandler<
    [id: string, peer: string, blobId: string],
    Date | null
  >;
  crawlDocData: DesktopHandler<[id: string, docId: string], CrawlResult>;
  ftsAddDocument: DesktopHandler<
    [
      id: string,
      indexName: string,
      docId: string,
      text: string,
      index: boolean,
    ],
    void
  >;
  ftsDeleteDocument: DesktopHandler<
    [id: string, indexName: string, docId: string],
    void
  >;
  ftsSearch: DesktopHandler<
    [id: string, indexName: string, query: string],
    FullTextSearchResult[]
  >;
  ftsGetDocument: DesktopHandler<
    [id: string, indexName: string, docId: string],
    string | null
  >;
  ftsGetMatches: DesktopHandler<
    [id: string, indexName: string, docId: string, query: string],
    FullTextMatch[]
  >;
  ftsFlushIndex: DesktopHandler<[id: string], void>;
  ftsIndexState: DesktopHandler<
    [id: string],
    "ready" | "rebuilding" | "failed"
  >;
  ftsCompleteRebuild: DesktopHandler<[id: string], void>;
  ftsFailRebuild: DesktopHandler<[id: string], void>;
  ftsIndexVersion: DesktopHandler<[], number>;
};

export type HelperClientHandlers = {
  store: NativeStoreHandlers;
  workspace: {
    delete: DesktopHandler<[universalId: string], void>;
    moveToTrash: DesktopHandler<[universalId: string], void>;
    getBackupWorkspaces: DesktopHandler<[], BackupWorkspaces>;
    deleteBackupWorkspace: DesktopHandler<[id: string], void>;
    listLocalWorkspaceIds: DesktopHandler<[], string[]>;
  };
  dialog: {
    loadDBFile: DesktopHandler<[defaultPath?: string], LoadDBFileResult>;
    saveDBFileAs: DesktopHandler<
      [universalId: string, name: string, labels?: WorkspaceLabelExport],
      SaveDBFileResult
    >;
    selectDBFileLocation: DesktopHandler<[], SelectDBFileLocationResult>;
    setFakeDialogResult: DesktopHandler<
      [result: FakeDialogResult | undefined],
      void
    >;
  };
};

export type ClientHandler = MainClientHandlers & HelperClientHandlers;

type ChannelShape<Surface> = {
  readonly [Namespace in keyof Surface]: {
    readonly [Channel in keyof Surface[Namespace]]: true;
  };
};

export const mainHandlerChannelManifest = {
  debug: { revealLogFile: true, logFilePath: true },
  ui: {
    isMaximized: true,
    isFullScreen: true,
    handleThemeChange: true,
    handleMinimizeApp: true,
    handleMaximizeApp: true,
    handleWindowResize: true,
    handleCloseApp: true,
    handleHideApp: true,
    getChallengeResponse: true,
    handleOpenMainApp: true,
    getBookmarkDataByLink: true,
    openExternal: true,
    isActiveTab: true,
    getWorkbenchMeta: true,
    updateWorkbenchMeta: true,
    updateWorkbenchViewMeta: true,
    getTabViewsMeta: true,
    updateActiveViewMeta: true,
    getTabsStatus: true,
    addTab: true,
    showTab: true,
    tabGoTo: true,
    ensureTabLoaded: true,
    closeTab: true,
    setCloseParticipant: true,
    answerCloseRequest: true,
    activateView: true,
    moveTab: true,
    toggleRightSidebar: true,
    pingAppLayoutReady: true,
    showDevTools: true,
    showTabContextMenu: true,
    openThemeEditor: true,
    restartApp: true,
    showCalendarReminderNotification: true,
    onLanguageChange: true,
    invalidateBranding: true,
    saveExportFile: true,
    savePdf: true,
    captureArea: true,
  },
  clipboard: { copyAsPNG: true },
  updater: {
    currentVersion: true,
    quitAndInstall: true,
    downloadUpdate: true,
    getConfig: true,
    setConfig: true,
    checkForUpdates: true,
    getState: true,
  },
  findInPage: { find: true, clear: true },
  sharedStorage: {
    getAllGlobalState: true,
    getAllGlobalCache: true,
    setGlobalState: true,
    delGlobalState: true,
    clearGlobalState: true,
    setGlobalCache: true,
    delGlobalCache: true,
    clearGlobalCache: true,
  },
  worker: { connectWorker: true, disconnectWorker: true },
  recording: {
    getRecording: true,
    getCurrentRecording: true,
    startRecording: true,
    listRecoverableRecordings: true,
    getRecordingDestinations: true,
    retryRecording: true,
    claimRecordingDelivery: true,
    updateRecordingDelivery: true,
    pauseRecording: true,
    stopRecording: true,
    getRawAudioBuffers: true,
    readRecordingFile: true,
    readyRecording: true,
    handleBlockCreationSuccess: true,
    handleBlockCreationFailed: true,
    removeRecording: true,
    checkRecordingAvailable: true,
    setupRecordingFeature: true,
    disableRecordingFeature: true,
    checkMeetingPermissions: true,
    askForMeetingPermission: true,
    showRecordingPermissionSetting: true,
    showSavedRecordings: true,
  },
  popup: {
    getCurrentNotification: true,
    dismissCurrentNotification: true,
    dismissCurrentRecording: true,
  },
  i18n: { changeLanguage: true },
} as const satisfies ChannelShape<MainClientHandlers>;

export const helperHandlerChannelManifest = {
  store: {
    connect: true,
    disconnect: true,
    pushUpdate: true,
    getDocSnapshot: true,
    setDocSnapshot: true,
    getDocUpdates: true,
    markUpdatesMerged: true,
    deleteDoc: true,
    getDocClocks: true,
    getDocClock: true,
    getDocIndexedClock: true,
    setDocIndexedClock: true,
    clearDocIndexedClock: true,
    getBlob: true,
    setBlob: true,
    deleteBlob: true,
    releaseBlobs: true,
    listBlobs: true,
    getPeerRemoteClocks: true,
    getPeerRemoteClock: true,
    setPeerRemoteClock: true,
    getPeerPulledRemoteClocks: true,
    getPeerPulledRemoteClock: true,
    setPeerPulledRemoteClock: true,
    getPeerPushedClocks: true,
    getPeerPushedClock: true,
    setPeerPushedClock: true,
    clearClocks: true,
    setBlobUploadedAt: true,
    getBlobUploadedAt: true,
    crawlDocData: true,
    ftsAddDocument: true,
    ftsDeleteDocument: true,
    ftsSearch: true,
    ftsGetDocument: true,
    ftsGetMatches: true,
    ftsFlushIndex: true,
    ftsIndexState: true,
    ftsCompleteRebuild: true,
    ftsFailRebuild: true,
    ftsIndexVersion: true,
  },
  workspace: {
    delete: true,
    moveToTrash: true,
    getBackupWorkspaces: true,
    deleteBackupWorkspace: true,
    listLocalWorkspaceIds: true,
  },
  dialog: {
    loadDBFile: true,
    saveDBFileAs: true,
    selectDBFileLocation: true,
    setFakeDialogResult: true,
  },
} as const satisfies ChannelShape<HelperClientHandlers>;

export const clientHandlerChannelManifest = {
  ...mainHandlerChannelManifest,
  ...helperHandlerChannelManifest,
} as const satisfies ChannelShape<ClientHandler>;
