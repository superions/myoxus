export type Maybe<T> = T | null;
export type InputMaybe<T> = T | null;
/** All built-in and custom scalars, mapped to their actual values */
export interface Scalars {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  /**
   * Implement the DateTime<Utc> scalar
   *
   * The input/output is a string in RFC3339 format.
   */
  DateTime: { input: string; output: string };
  /** A scalar that can represent any JSON value. */
  JSON: { input: any; output: any };
  /**
   * ISO 8601 calendar date without timezone.
   * Format: %Y-%m-%d
   *
   * # Examples
   *
   * * `1994-11-13`
   * * `2000-02-24`
   */
  NaiveDate: { input: unknown; output: unknown };
  /**
   * A UUID is a unique 128-bit number, stored as 16 octets. UUIDs are parsed as
   * Strings within GraphQL. UUIDs are used to assign unique identifiers to
   * entities without requiring a central allocating authority.
   *
   * # References
   *
   * * [Wikipedia: Universally Unique Identifier](http://en.wikipedia.org/wiki/Universally_unique_identifier)
   * * [RFC4122: A Universally Unique Identifier (UUID) URN Namespace](http://tools.ietf.org/html/rfc4122)
   */
  UUID: { input: string; output: string };
  /** A multipart file upload */
  Upload: { input: File; output: File };
}

/** An API / personal access token record (without the plaintext secret). */
export interface AccessToken {
  __typename?: "AccessToken";
  createdAt: Scalars["DateTime"]["output"];
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["UUID"]["output"];
  name: Scalars["String"]["output"];
}

export interface AddContextBlobInput {
  blobId: Scalars["String"]["input"];
  contextId: Scalars["String"]["input"];
}

export interface AddContextCategoryInput {
  categoryId: Scalars["String"]["input"];
  contextId: Scalars["String"]["input"];
  docs?: InputMaybe<Array<Scalars["String"]["input"]>>;
  type: Scalars["String"]["input"];
}

export interface AddContextDocInput {
  contextId: Scalars["String"]["input"];
  docId: Scalars["String"]["input"];
}

export interface AddContextFileInput {
  contextId: Scalars["String"]["input"];
}

export interface AdminAllSharedLinkEdgeType {
  __typename?: "AdminAllSharedLinkEdgeType";
  cursor: Scalars["String"]["output"];
  node: AdminAllSharedLinkType;
}

export interface AdminAllSharedLinkType {
  __typename?: "AdminAllSharedLinkType";
  docId: Scalars["String"]["output"];
  docUpdatedAt: Maybe<Scalars["DateTime"]["output"]>;
  guestViews: Maybe<Scalars["Int"]["output"]>;
  lastAccessedAt: Maybe<Scalars["DateTime"]["output"]>;
  lastUpdaterId: Maybe<Scalars["String"]["output"]>;
  publishedAt: Maybe<Scalars["DateTime"]["output"]>;
  shareUrl: Scalars["String"]["output"];
  title: Maybe<Scalars["String"]["output"]>;
  uniqueViews: Maybe<Scalars["Int"]["output"]>;
  views: Maybe<Scalars["Int"]["output"]>;
  workspaceId: Scalars["String"]["output"];
  workspaceOwnerId: Maybe<Scalars["String"]["output"]>;
}

export interface AdminAllSharedLinksFilterInput {
  analyticsWindowDays?: InputMaybe<Scalars["Int"]["input"]>;
  includeTotal?: InputMaybe<Scalars["Boolean"]["input"]>;
  keyword?: InputMaybe<Scalars["String"]["input"]>;
  updatedAfter?: InputMaybe<Scalars["DateTime"]["input"]>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface AdminAuditActorType {
  __typename?: "AdminAuditActorType";
  /** Delegated credential id. This is never a plaintext secret or key hash. */
  credentialId: Maybe<Scalars["String"]["output"]>;
  /** Delegated credential type, e.g. `mcp_api_key`. */
  credentialType: Maybe<Scalars["String"]["output"]>;
  id: Maybe<Scalars["ID"]["output"]>;
  /** Actor origin: `user`, `system` or `api_key`. */
  kind: Scalars["String"]["output"];
  /** Human-readable snapshot (email) at the time of the event. */
  label: Maybe<Scalars["String"]["output"]>;
}

export interface AdminAuditLogEntryType {
  __typename?: "AdminAuditLogEntryType";
  actor: Maybe<AdminAuditActorType>;
  category: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  eventKey: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  metadata: Maybe<Scalars["JSON"]["output"]>;
  newValue: Maybe<Scalars["JSON"]["output"]>;
  oldValue: Maybe<Scalars["JSON"]["output"]>;
  target: Maybe<AuditTargetType>;
  /**
   * Organisationseinheit, der dieses Event zugeordnet ist.
   * `None` fuer organisationsweite oder nicht-OU-bezogene Eintraege.
   */
  targetUnitId: Maybe<Scalars["ID"]["output"]>;
}

/** Live filesystem projection, distinct from the immutable trust loaded at startup. */
export interface AdminCaBundleStatus {
  __typename?: "AdminCaBundleStatus";
  certificateCount: Maybe<Scalars["Int"]["output"]>;
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  fileError: Maybe<Scalars["String"]["output"]>;
  fingerprint: Maybe<Scalars["String"]["output"]>;
  loadedSnapshot: Scalars["String"]["output"];
  maxUploadBytes: Scalars["Int"]["output"];
  path: Maybe<Scalars["String"]["output"]>;
  restartRequired: Scalars["Boolean"]["output"];
  restriction: Maybe<Scalars["String"]["output"]>;
  rollbackAvailable: Scalars["Boolean"]["output"];
}

export interface AdminConfigFieldErrorType {
  __typename?: "AdminConfigFieldErrorType";
  key: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
  module: Scalars["String"]["output"];
  path: Scalars["String"]["output"];
}

export interface AdminConfigFieldType {
  __typename?: "AdminConfigFieldType";
  databaseWritable: Scalars["Boolean"]["output"];
  /**
   * Server-owned fallback used when an older or partial client snapshot omits
   * this field. Sensitive fields never expose their startup value here.
   */
  defaultValue: Maybe<Scalars["JSON"]["output"]>;
  enum: Array<Scalars["String"]["output"]>;
  groupKey: Scalars["String"]["output"];
  helpText: Maybe<Scalars["String"]["output"]>;
  immediateApply: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  max: Maybe<Scalars["Int"]["output"]>;
  min: Maybe<Scalars["Int"]["output"]>;
  path: Scalars["String"]["output"];
  requiresRestart: Scalars["Boolean"]["output"];
  sensitive: Scalars["Boolean"]["output"];
  value: Maybe<Scalars["JSON"]["output"]>;
  valueType: AdminConfigValueType;
}

export interface AdminConfigGroupType {
  __typename?: "AdminConfigGroupType";
  fields: Array<AdminConfigFieldType>;
  groupKey: Scalars["String"]["output"];
  helpText: Maybe<Scalars["String"]["output"]>;
  label: Scalars["String"]["output"];
}

export interface AdminConfigModuleType {
  __typename?: "AdminConfigModuleType";
  groups: Array<AdminConfigGroupType>;
  label: Scalars["String"]["output"];
  module: Scalars["String"]["output"];
}

export interface AdminConfigSnapshotType {
  __typename?: "AdminConfigSnapshotType";
  /**
   * Provenance/lifecycle projection for config fields owned by the shared
   * live resolver. This remains bounded until registry code generation lands.
   */
  effectiveFields: Array<AdminEffectiveConfigFieldType>;
  modules: Array<AdminConfigModuleType>;
  /**
   * Stable, scrubbed revision of the projected schema or values. Sensitive
   * material contributes only set/unset state and can never be recovered from
   * this digest.
   */
  revision: Scalars["String"]["output"];
}

export interface AdminConfigUpdateResultType {
  __typename?: "AdminConfigUpdateResultType";
  applied: Scalars["Boolean"]["output"];
  config: AdminConfigSnapshotType;
  fieldErrors: Array<AdminConfigFieldErrorType>;
  /**
   * Optional runtime-overlay publication outcome. `failed` accompanies a
   * successful DB commit and must be rendered as a recovery warning.
   */
  writeback: Maybe<Scalars["String"]["output"]>;
}

export enum AdminConfigValueType {
  Array = "Array",
  Boolean = "Boolean",
  Number = "Number",
  Object = "Object",
  String = "String",
}

export interface AdminDashboardCacheMetricType {
  __typename?: "AdminDashboardCacheMetricType";
  entryCount: Scalars["Int"]["output"];
  hitRate: Scalars["Float"]["output"];
  hitsTotal: Scalars["Int"]["output"];
  invalidationsLocalTotal: Scalars["Int"]["output"];
  invalidationsRemoteTotal: Scalars["Int"]["output"];
  missesTotal: Scalars["Int"]["output"];
  name: Scalars["String"]["output"];
}

export interface AdminDashboardCaptchaType {
  __typename?: "AdminDashboardCaptchaType";
  enabled: Scalars["Boolean"]["output"];
  hmacKeyConfigured: Scalars["Boolean"]["output"];
  honeypotTotal: Scalars["Int"]["output"];
  rejectedTotal: Scalars["Int"]["output"];
  verifiedTotal: Scalars["Int"]["output"];
}

export interface AdminDashboardDbPoolType {
  __typename?: "AdminDashboardDbPoolType";
  active: Scalars["Int"]["output"];
  idle: Scalars["Int"]["output"];
  max: Scalars["Int"]["output"];
  userCount: Maybe<Scalars["Int"]["output"]>;
  workspaceCount: Maybe<Scalars["Int"]["output"]>;
}

export interface AdminDashboardInput {
  sharedLinkWindowDays?: InputMaybe<Scalars["Int"]["input"]>;
  storageHistoryDays?: InputMaybe<Scalars["Int"]["input"]>;
  syncHistoryHours?: InputMaybe<Scalars["Int"]["input"]>;
  timezone?: InputMaybe<Scalars["String"]["input"]>;
}

export interface AdminDashboardMetricsPipelineType {
  __typename?: "AdminDashboardMetricsPipelineType";
  acceptedTotal: Scalars["Int"]["output"];
  activeSeries: Scalars["Int"]["output"];
  cardinalityDropsTotal: Scalars["Int"]["output"];
  dailyRollups7D: Maybe<Scalars["Int"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  flushIntervalSeconds: Scalars["Int"]["output"];
  lastFlushAt: Maybe<Scalars["DateTime"]["output"]>;
  lastFlushCount: Scalars["Int"]["output"];
  offeredTotal: Scalars["Int"]["output"];
  persisted24H: Maybe<Scalars["Int"]["output"]>;
  persistenceEnabled: Scalars["Boolean"]["output"];
  prometheusEnabled: Scalars["Boolean"]["output"];
  rejectedDisabledTotal: Scalars["Int"]["output"];
}

export interface AdminDashboardMinutePointType {
  __typename?: "AdminDashboardMinutePointType";
  activeUsers: Scalars["Int"]["output"];
  minute: Scalars["DateTime"]["output"];
}

export interface AdminDashboardQueueMetricType {
  __typename?: "AdminDashboardQueueMetricType";
  deadLetter: Scalars["Int"]["output"];
  failed: Scalars["Int"]["output"];
  pendingReady: Scalars["Int"]["output"];
  queue: Scalars["String"]["output"];
  queueLagSeconds: Scalars["Float"]["output"];
}

export interface AdminDashboardQueueSummaryType {
  __typename?: "AdminDashboardQueueSummaryType";
  failedTotal: Scalars["Int"]["output"];
  pendingReadyTotal: Scalars["Int"]["output"];
  queues: Array<AdminDashboardQueueMetricType>;
}

export interface AdminDashboardRuntimeType {
  __typename?: "AdminDashboardRuntimeType";
  processUptimeSeconds: Scalars["Int"]["output"];
  requestErrorRate: Scalars["Float"]["output"];
  requestLatencyAvgMs: Scalars["Float"]["output"];
  requestLatencyMaxMs: Scalars["Float"]["output"];
  requestThroughputRps: Scalars["Float"]["output"];
  requestsErrorTotal: Scalars["Int"]["output"];
  requestsTotal: Scalars["Int"]["output"];
}

export interface AdminDashboardTelemetryPipelineType {
  __typename?: "AdminDashboardTelemetryPipelineType";
  acceptedTotal: Scalars["Int"]["output"];
  bufferOverflowTotal: Scalars["Int"]["output"];
  dailyRollups7D: Maybe<Scalars["Int"]["output"]>;
  dedupeHitRate: Scalars["Float"]["output"];
  enabled: Scalars["Boolean"]["output"];
  hotBufferLen: Scalars["Int"]["output"];
  lastFlushAt: Maybe<Scalars["DateTime"]["output"]>;
  lastFlushCount: Scalars["Int"]["output"];
  offeredTotal: Scalars["Int"]["output"];
  persisted24H: Maybe<Scalars["Int"]["output"]>;
  rejectedTotal: Scalars["Int"]["output"];
}

export interface AdminDashboardType {
  __typename?: "AdminDashboardType";
  blobStorageBytes: Scalars["Int"]["output"];
  blobStorageHistory: Array<AdminDashboardValueDayPointType>;
  cacheMetrics: Array<AdminDashboardCacheMetricType>;
  captcha: AdminDashboardCaptchaType;
  copilotConversations: Scalars["Int"]["output"];
  dbPool: Maybe<AdminDashboardDbPoolType>;
  generatedAt: Scalars["DateTime"]["output"];
  metricsPipeline: AdminDashboardMetricsPipelineType;
  queueSummary: AdminDashboardQueueSummaryType;
  runtime: AdminDashboardRuntimeType;
  storageWindow: TimeWindow;
  syncActiveUsers: Scalars["Int"]["output"];
  syncActiveUsersTimeline: Array<AdminDashboardMinutePointType>;
  syncWindow: TimeWindow;
  telemetryPipeline: AdminDashboardTelemetryPipelineType;
  topSharedLinks: Array<AdminSharedLinkTopItemType>;
  topSharedLinksWindow: TimeWindow;
  workspaceStorageBytes: Scalars["Int"]["output"];
  workspaceStorageHistory: Array<AdminDashboardValueDayPointType>;
}

export interface AdminDashboardValueDayPointType {
  __typename?: "AdminDashboardValueDayPointType";
  date: Scalars["DateTime"]["output"];
  value: Scalars["Int"]["output"];
}

export interface AdminDocumentAuditEntryType {
  __typename?: "AdminDocumentAuditEntryType";
  actor: Maybe<AdminAuditActorType>;
  createdAt: Scalars["DateTime"]["output"];
  docId: Maybe<Scalars["ID"]["output"]>;
  eventKey: Scalars["String"]["output"];
  group: AdminDocumentAuditGroupType;
  id: Scalars["ID"]["output"];
  metadata: Maybe<Scalars["JSON"]["output"]>;
  newValue: Maybe<Scalars["JSON"]["output"]>;
  oldValue: Maybe<Scalars["JSON"]["output"]>;
  source: AdminDocumentAuditSourceType;
  sourceCategory: Scalars["String"]["output"];
  target: Maybe<AuditTargetType>;
  targetUnitId: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface AdminDocumentAuditFilterInput {
  actorUserId?: InputMaybe<Scalars["ID"]["input"]>;
  docId?: InputMaybe<Scalars["ID"]["input"]>;
  eventKeyPrefix?: InputMaybe<Scalars["String"]["input"]>;
  from?: InputMaybe<Scalars["DateTime"]["input"]>;
  /**
   * Omitted groups mean every document-domain group, never every global
   * operational audit category.
   */
  groups?: InputMaybe<Array<AdminDocumentAuditGroupType>>;
  targetId?: InputMaybe<Scalars["String"]["input"]>;
  targetType?: InputMaybe<Scalars["String"]["input"]>;
  to?: InputMaybe<Scalars["DateTime"]["input"]>;
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

export enum AdminDocumentAuditGroupType {
  document_lifecycle = "document_lifecycle",
  document_metadata = "document_metadata",
  document_type = "document_type",
  document_version = "document_version",
  metadata_policy = "metadata_policy",
  pdf_export = "pdf_export",
  status_schema = "status_schema",
  status_transition = "status_transition",
  version_policy = "version_policy",
  workspace_settings = "workspace_settings",
}

export enum AdminDocumentAuditSourceType {
  admin_audit_log = "admin_audit_log",
  document_initial_sync_audit = "document_initial_sync_audit",
  pdf_export_render_audit = "pdf_export_render_audit",
}

export interface AdminDocumentRuntimeAggregateBucketType {
  __typename?: "AdminDocumentRuntimeAggregateBucketType";
  count: Scalars["Int"]["output"];
  /** Technical bucket key. `null` means the document has no value for that axis. */
  key: Maybe<Scalars["String"]["output"]>;
  /** Server-managed display label for configured values; synthetic buckets are localized by clients. */
  label: Maybe<Scalars["String"]["output"]>;
}

export interface AdminDocumentRuntimeOverviewType {
  __typename?: "AdminDocumentRuntimeOverviewType";
  byClassification: Array<AdminDocumentRuntimeAggregateBucketType>;
  byDocumentType: Array<AdminDocumentRuntimeAggregateBucketType>;
  byReviewDue: Array<AdminDocumentRuntimeAggregateBucketType>;
  byStatus: Array<AdminDocumentRuntimeAggregateBucketType>;
  byVersionState: Array<AdminDocumentRuntimeAggregateBucketType>;
  totalDocuments: Scalars["Int"]["output"];
}

export interface AdminDocumentVersioningDefaultsType {
  __typename?: "AdminDocumentVersioningDefaultsType";
  defaultAutoVersionOnPdfExport: Scalars["Boolean"]["output"];
  defaultEditCaptureEnabled: Scalars["Boolean"]["output"];
  defaultEditCaptureIntervalMs: Scalars["Int"]["output"];
  defaultEnabled: Scalars["Boolean"]["output"];
  defaultRetentionCount: Scalars["Int"]["output"];
}

export interface AdminDocumentVersioningWorkspaceSettingsType {
  __typename?: "AdminDocumentVersioningWorkspaceSettingsType";
  autoVersionOnPdfExport: Maybe<Scalars["Boolean"]["output"]>;
  editCaptureEnabled: Maybe<Scalars["Boolean"]["output"]>;
  editCaptureIntervalMs: Maybe<Scalars["Int"]["output"]>;
  editCaptureRuntimeAvailable: Scalars["Boolean"]["output"];
  effectiveAutoVersionOnPdfExport: Scalars["Boolean"]["output"];
  effectiveEditCaptureEnabled: Scalars["Boolean"]["output"];
  effectiveEditCaptureIntervalMs: Scalars["Int"]["output"];
  effectiveEnabled: Scalars["Boolean"]["output"];
  effectiveRetentionCount: Scalars["Int"]["output"];
  enabled: Maybe<Scalars["Boolean"]["output"]>;
  legacyIntervalNormalized: Scalars["Boolean"]["output"];
  retentionCount: Maybe<Scalars["Int"]["output"]>;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
  workspaceName: Maybe<Scalars["String"]["output"]>;
}

export interface AdminEffectiveConfigFieldType {
  __typename?: "AdminEffectiveConfigFieldType";
  configuredValue: Maybe<Scalars["JSON"]["output"]>;
  isSet: Scalars["Boolean"]["output"];
  overriddenSources: Array<Scalars["String"]["output"]>;
  path: Scalars["String"]["output"];
  requiresRestart: Scalars["Boolean"]["output"];
  runtimeEffectiveState: Scalars["String"]["output"];
  runtimeEffectiveValue: Maybe<Scalars["JSON"]["output"]>;
  sensitive: Scalars["Boolean"]["output"];
  winningKey: Maybe<Scalars["String"]["output"]>;
  winningSource: Maybe<Scalars["String"]["output"]>;
}

export interface AdminMetricsCountersType {
  __typename?: "AdminMetricsCountersType";
  acceptedTotal: Scalars["Int"]["output"];
  cardinalityDropsTotal: Scalars["Int"]["output"];
  offeredTotal: Scalars["Int"]["output"];
  rejectedDisabledTotal: Scalars["Int"]["output"];
  snapshotsTotal: Scalars["Int"]["output"];
}

export interface AdminMetricsFlushResultType {
  __typename?: "AdminMetricsFlushResultType";
  buffered: Scalars["Int"]["output"];
  inserted: Scalars["Int"]["output"];
}

export interface AdminMetricsStatusType {
  __typename?: "AdminMetricsStatusType";
  activeSeries: Scalars["Int"]["output"];
  cardinalityLimitPerMetric: Scalars["Int"]["output"];
  categories: Scalars["JSON"]["output"];
  counters: AdminMetricsCountersType;
  dailyRollups7d: Maybe<Scalars["Int"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  flushIntervalSeconds: Scalars["Int"]["output"];
  labelWorkspaceIdEnabled: Scalars["Boolean"]["output"];
  lastFlushAt: Maybe<Scalars["DateTime"]["output"]>;
  lastFlushCount: Scalars["Int"]["output"];
  persisted24h: Maybe<Scalars["Int"]["output"]>;
  persistenceEnabled: Scalars["Boolean"]["output"];
  prometheusEnabled: Scalars["Boolean"]["output"];
  retentionDailyDays: Scalars["Int"]["output"];
  retentionRawDays: Scalars["Int"]["output"];
  topSeries: Array<AdminMetricsTopSeriesType>;
}

export interface AdminMetricsTopSeriesType {
  __typename?: "AdminMetricsTopSeriesType";
  category: Scalars["String"]["output"];
  labels: Scalars["JSON"]["output"];
  name: Scalars["String"]["output"];
  value: Scalars["Float"]["output"];
}

export interface AdminOidcDirectoryEntry {
  __typename?: "AdminOidcDirectoryEntry";
  claimValue: Maybe<Scalars["String"]["output"]>;
  displayName: Scalars["String"]["output"];
  /** Provider catalog identity, not the persisted providerGroup claim value. */
  id: Scalars["String"]["output"];
  path: Maybe<Scalars["String"]["output"]>;
  state: AdminOidcDirectoryEntryState;
}

export enum AdminOidcDirectoryEntryState {
  AMBIGUOUS = "AMBIGUOUS",
  AVAILABLE = "AVAILABLE",
  UNAVAILABLE = "UNAVAILABLE",
}

/** Entire catalog visible to the read account, not an audit of its permissions. */
export interface AdminOidcGroupDirectory {
  __typename?: "AdminOidcGroupDirectory";
  entries: Array<AdminOidcDirectoryEntry>;
}

export interface AdminOidcProviderTestResult {
  __typename?: "AdminOidcProviderTestResult";
  authorizationEndpointPresent: Scalars["Boolean"]["output"];
  discoveryOk: Scalars["Boolean"]["output"];
  groupsClaimPresent: Scalars["Boolean"]["output"];
  groupsCount: Scalars["Int"]["output"];
  issuer: Maybe<Scalars["String"]["output"]>;
  jwksKeyCount: Scalars["Int"]["output"];
  jwksOk: Scalars["Boolean"]["output"];
  mappedGroupsCount: Scalars["Int"]["output"];
  tokenEndpointPresent: Scalars["Boolean"]["output"];
  unknownGroupsCount: Scalars["Int"]["output"];
  userinfoEndpointPresent: Scalars["Boolean"]["output"];
  warnings: Array<Scalars["String"]["output"]>;
}

/**
 * Filter object for the admin PDF-export diagnostics table.
 *
 * Keeping the filters in one input object prevents resolver-argument drift as
 * the diagnostics UI grows and keeps this surface aligned with other admin
 * modules that pass explicit filter structs instead of loose fields.
 */
export interface AdminPdfExportJobsFilterInput {
  createdAfter?: InputMaybe<Scalars["DateTime"]["input"]>;
  createdBefore?: InputMaybe<Scalars["DateTime"]["input"]>;
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  status?: InputMaybe<PdfExportJobStatus>;
  userId?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface AdminQueueCountsType {
  __typename?: "AdminQueueCountsType";
  active: Scalars["Int"]["output"];
  completed: Scalars["Int"]["output"];
  delayed: Scalars["Int"]["output"];
  failed: Scalars["Int"]["output"];
  stalled: Scalars["Int"]["output"];
  waiting: Scalars["Int"]["output"];
}

export interface AdminQueueHistoryPointType {
  __typename?: "AdminQueueHistoryPointType";
  pending: Scalars["Int"]["output"];
  timestamp: Scalars["Int"]["output"];
}

export interface AdminQueueJobType {
  __typename?: "AdminQueueJobType";
  attemptsMade: Scalars["Int"]["output"];
  data: Scalars["JSON"]["output"];
  failedReason: Maybe<Scalars["String"]["output"]>;
  finishedOn: Maybe<Scalars["Int"]["output"]>;
  id: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  returnValue: Maybe<Scalars["JSON"]["output"]>;
  timestamp: Maybe<Scalars["Int"]["output"]>;
  workspaceContentOperation: Maybe<WorkspaceContentOperationType>;
}

export interface AdminQueueJobsType {
  __typename?: "AdminQueueJobsType";
  jobs: Array<AdminQueueJobType>;
  nextCursor: Maybe<Scalars["Int"]["output"]>;
  numOfPages: Scalars["Int"]["output"];
  totalCount: Scalars["Int"]["output"];
}

export interface AdminQueueMutationResultType {
  __typename?: "AdminQueueMutationResultType";
  error: Maybe<Scalars["String"]["output"]>;
  failed: Maybe<Scalars["Int"]["output"]>;
  jobId: Maybe<Scalars["String"]["output"]>;
  name: Maybe<Scalars["String"]["output"]>;
  ok: Scalars["Boolean"]["output"];
  removed: Maybe<Scalars["Int"]["output"]>;
}

export interface AdminQueueStatusType {
  __typename?: "AdminQueueStatusType";
  degraded: Scalars["Boolean"]["output"];
  queues: Array<AdminQueueType>;
  redisAvailable: Scalars["Boolean"]["output"];
}

export interface AdminQueueType {
  __typename?: "AdminQueueType";
  counts: AdminQueueCountsType;
  degraded: Scalars["Boolean"]["output"];
  displayName: Scalars["String"]["output"];
  history: Maybe<Array<AdminQueueHistoryPointType>>;
  name: Scalars["String"]["output"];
  paused: Scalars["Boolean"]["output"];
}

export interface AdminRoot {
  __typename?: "AdminRoot";
  /** Add a feature to a workspace (replaces flat-root `addWorkspaceFeature`). */
  addWorkspaceFeature: Scalars["Boolean"]["output"];
  /**
   * Add a user to a workspace directly with `Accepted` status (admin bypass — no invite flow).
   *
   * Owner changes remain a separate operation.
   */
  addWorkspaceMember: InviteUserType;
  /** List all shared/published docs (replaces flat-root `adminAllSharedLinks`). */
  adminAllSharedLinks: PaginatedAdminAllSharedLinkType;
  /** Validate and atomically apply additional trust. This never reloads running transports. */
  adminApplyCaBundle: AdminCaBundleStatus;
  /**
   * Unified admin audit log — lists events across all admin mutation categories.
   *
   * Supports filtering by `category`, `actorUserId`, `targetType`, `targetId`,
   * `eventKeyPrefix`, and time range (`from` / `to`).  Results are ordered
   * newest-first.
   */
  adminAuditLog: Array<AdminAuditLogEntryType>;
  /** Count matching admin audit log entries (for pagination). */
  adminAuditLogCount: Scalars["Int"]["output"];
  /** Inspect current CA file bytes and the separately loaded startup snapshot. */
  adminCaBundleStatus: AdminCaBundleStatus;
  /** Cache tuning history (replaces flat-root `adminCacheTuningHistory`). */
  adminCacheTuningHistory: Array<CacheTuningHistoryPoint>;
  /** Cache tuning status (replaces flat-root `adminCacheTuningStatus`). */
  adminCacheTuningStatus: Array<CacheTuningStatusType>;
  /** Admin config schema (replaces flat-root `adminConfigSchema`). */
  adminConfigSchema: AdminConfigSnapshotType;
  /** Admin config values (replaces flat-root `adminConfigValues`). */
  adminConfigValues: AdminConfigSnapshotType;
  /** Admin dashboard metrics (replaces flat-root `adminDashboard`). */
  adminDashboard: AdminDashboardType;
  /**
   * Document-domain audit projection for the Admin Documents module.
   *
   * This is intentionally narrower than `adminAuditLog`: "all groups" means
   * all document-related evidence, never the complete global audit stream.
   */
  adminDocumentAuditLog: Array<AdminDocumentAuditEntryType>;
  /** Count document-domain audit evidence for the Admin Documents module. */
  adminDocumentAuditLogCount: Scalars["Int"]["output"];
  /**
   * Flush all doc Redis caches (snapshot, metadata, timestamps, compaction
   * locks). Returns the total number of deleted keys. Requires admin.
   */
  adminFlushAllDocCaches: Scalars["Int"]["output"];
  /**
   * Flush the doc metadata Redis cache.
   *
   * Deletes all `doc_meta:*` keys in Redis. Returns the number of deleted
   * keys. Requires admin.
   */
  adminFlushDocMetadataCache: Scalars["Int"]["output"];
  /**
   * Flush the canonical document metadata projection Redis cache.
   *
   * Deletes all `doc_metadata_projection:*` keys in Redis. Returns the number
   * of deleted keys. Requires admin.
   */
  adminFlushDocMetadataProjectionCache: Scalars["Int"]["output"];
  /**
   * Flush the doc snapshot Redis cache.
   *
   * Deletes all `doc_snapshot:*` keys in Redis. Returns the number of
   * deleted keys (or 0 when the cache is not configured). Requires admin.
   */
  adminFlushDocSnapshotCache: Scalars["Int"]["output"];
  adminRemoveCaBundle: AdminCaBundleStatus;
  /**
   * Remove a workspace member from the admin surface.
   *
   * Owners must be reassigned before they can disappear.
   */
  adminRemoveWorkspaceMember: Scalars["Boolean"]["output"];
  adminRestoreCaBundle: AdminCaBundleStatus;
  /**
   * Search users by email or name (substring, case-insensitive).
   *
   * Powers the admin user-picker (`P-AR-0-S02`). When `features` is set
   * to a non-empty list, only users that have ALL of the listed
   * user-features active are returned. `excludeUnitId` removes existing
   * members of that OU before returning the list, so admin pickers cannot
   * offer duplicate assignments. `limit` is clamped to `[1, 50]` (default 20).
   *
   * Returns `id`, `email`, `name`, `features`, `isAdmin`, `disabled`.
   */
  adminSearchUsers: Array<UserSearchResult>;
  /**
   * Search workspaces by name (substring, case-insensitive).
   *
   * Powers the admin workspace-picker (`P-AR-0-S03`). When `ouId` is set,
   * only workspaces linked to that OU are returned. When `excludeUnitId` is
   * set, workspaces already linked to that OU are removed so add-pickers
   * cannot offer duplicate links. `ouId` and `excludeUnitId` are mutually
   * exclusive. `limit` is clamped to `[1, 50]` (default 20).
   *
   * Returns `id`, `name`, `ownerUserId`, `ownerEmail` (snapshot), and the
   * full set of `linkedOuIds`.
   */
  adminSearchWorkspaces: Array<WorkspaceSearchResult>;
  /** Update admin config (replaces flat-root `adminUpdateConfig`). */
  adminUpdateConfig: AdminConfigUpdateResultType;
  /**
   * Update workspace metadata (replaces flat-root `adminUpdateWorkspace`).
   *
   * P112-QUOTA-C-05: Supports `storageQuotaMb` (primary, MB units) +
   * `clearStorageQuota` flag with tri-state semantics that correctly handles
   * clearing the override back to NULL.  The deprecated `storageQuotaBytes`
   * field remains functional for backwards compatibility.
   *
   * A-04: Delegates persistence to the workspace service (Application layer)
   * instead of executing raw SQL in the API resolver.
   */
  adminUpdateWorkspace: AdminWorkspaceType;
  /**
   * Change a workspace member role from the admin surface.
   *
   * This is deliberately workspace-centric: the admin frontend only knows the
   * workspace currently displayed in the drawer.
   */
  adminUpdateWorkspaceMemberRole: Scalars["Boolean"]["output"];
  /** Get a single workspace by ID with full admin metadata (replaces flat-root `adminWorkspace`). */
  adminWorkspace: Maybe<AdminWorkspaceType>;
  /**
   * Full quota breakdown for a single workspace (admin inspector).
   *
   * Returns the raw values at every level of the 4-level priority hierarchy
   * alongside the resolved effective quota and current usage.  Returns `null`
   * if the workspace does not exist or the DB is unavailable.
   */
  adminWorkspaceQuotaDetails: Maybe<WorkspaceQuotaDetailsType>;
  /** List workspaces with full admin metadata (replaces flat-root `adminWorkspaces`). */
  adminWorkspaces: Array<AdminWorkspaceType>;
  /** Count workspaces matching filter (replaces flat-root `adminWorkspacesCount`). */
  adminWorkspacesCount: Scalars["Int"]["output"];
  /**
   * Global app/server brand assets for shell, auth, setup and favicon usage.
   * Admin-only authoring surface; public runtime projection is exposed
   * separately so unauthenticated shells do not depend on AdminRoot.
   */
  appServerBranding: AppServerBrandingType;
  /** Apply a log preset (replaces flat-root `applyLogPreset`). */
  applyLogPreset: Array<GqlLogModuleLevel>;
  /** Apply a selected usable revision to an existing manual-update assignment. */
  applyTemplateManualUpdate: WorkspaceTemplateInstanceType;
  /** Approve a font for use in PDF exports. Admin-only. */
  approvePdfFont: PdfFontType;
  /** Archive a template (replaces `templateRegistry { archiveTemplate(...) }`). */
  archiveTemplate: TemplateCatalogEntryType;
  assignOrganizationManager: OrganizationUnitMemberType;
  assignOrganizationUnitWorkspace: Scalars["Boolean"]["output"];
  /** Grant a workspace access to a PDF template. Admin-only. */
  assignPdfTemplateToWorkspace: PdfWorkspaceTemplateAssignmentType;
  /** Assign a template to a workspace (replaces `templateRegistry { assignTemplateToWorkspace(...) }`). */
  assignTemplateToWorkspace: WorkspaceTemplatePolicyType;
  /**
   * Ban a user (replaces flat-root `banUser`).
   *
   * Delegates to the atomic auth suspension use-case; the resolver never
   * composes user/session/API-key writes itself.
   */
  banUser: UserType;
  /**
   * Bump the builder_version of a builtin template slug.
   *
   * The shared owner commits one increment and attempts a reconcile hint.
   * Returns the current version and target count, not delivery acknowledgements.
   */
  bumpBuilderVersion: BumpBuilderVersionResult;
  /** Cancel a queued PDF export job from the admin diagnostics view. */
  cancelPdfExportJob: Scalars["Boolean"]["output"];
  /**
   * Checks only saved configuration. No caller-selected endpoint or credential
   * can make this privileged server operation probe a different destination.
   */
  checkTranscriptionConnection: AdminTranscriptionConnectionCheckType;
  /** Clean completed/failed jobs for one queue. */
  cleanQueue: AdminQueueMutationResultType;
  /** Retry removal of operation-owned staging after a cancelled operation. */
  cleanupCancelledWorkspaceContentOperation: WorkspaceContentOperationType;
  /**
   * Configuration changelog.
   *
   * **Deprecated** — use `adminAuditLog(filter: { category: "config" })` instead.
   * This resolver is kept for backwards compatibility with the existing admin UI.
   * Internally it reads from `admin_audit_log` filtered to `category = "config"`.
   */
  configChangelog: Array<ConfigChangelogEntryType>;
  configureGitTokenRotation: GitTokenRotationStatus;
  /** Create a change-password URL for a user (replaces flat-root `createChangePasswordUrl`). */
  createChangePasswordUrl: Scalars["String"]["output"];
  /** Create a user (replaces flat-root `createUser`). */
  createUser: UserType;
  deactivateOrganizationUnit: Scalars["Boolean"]["output"];
  deactivateOrganizationUnitType: Scalars["Boolean"]["output"];
  decideOrganizationProjectRequest: Scalars["Boolean"]["output"];
  /** Clear a document-branding logo slot. Admin-only. */
  deleteDocumentBrandLogo: DocumentBrandingProfileAdmin;
  /** Delete an ICC color profile by id. Admin-only. */
  deleteIccProfile: Scalars["Boolean"]["output"];
  deleteOrganizationUnitPermanently: Scalars["Boolean"]["output"];
  /** Delete a font from the library. Admin-only. */
  deletePdfFont: Scalars["Boolean"]["output"];
  /** Soft-delete a PDF template. Admin-only. */
  deletePdfTemplate: Scalars["Boolean"]["output"];
  /** Delete a user (replaces flat-root `deleteUser`). */
  deleteUser: DeleteAccount;
  /** Delete a workspace. */
  deleteWorkspace: Scalars["Boolean"]["output"];
  /** Disable a template (replaces `templateRegistry { disableTemplate(...) }`). */
  disableTemplate: TemplateCatalogEntryType;
  /**
   * Document-safe color palettes for the workspace's effective theme.
   * Admin-only.
   */
  documentBrandColorPalettes: Array<DocumentBrandColorPaletteType>;
  /**
   * Document-branding profile (including audit fields) for one workspace.
   * Admin-only.
   */
  documentBrandingProfile: DocumentBrandingProfileAdmin;
  documentMetadataFieldDefinitions: Array<DocumentMetadataFieldDefinitionType>;
  documentMetadataValueDefinitions: Array<DocumentMetadataValueDefinitionType>;
  documentRuntimeOverview: AdminDocumentRuntimeOverviewType;
  documentStatusSchemas: Array<DocumentStatusSchemaType>;
  documentStatusValues: Array<DocumentStatusValueType>;
  documentTypes: Array<DocumentTypeDefinitionType>;
  documentVersionPolicies: Array<DocumentVersionPolicyType>;
  /**
   * Global document-versioning defaults, used only when a document has no
   * explicit settings row and its workspace has no override for a field.
   */
  documentVersioningDefaults: AdminDocumentVersioningDefaultsType;
  /**
   * Workspace override matrix for document-versioning defaults.
   *
   * Null override fields mean the workspace currently inherits the global
   * default. Effective fields are materialised so the UI can show the actual
   * runtime policy without duplicating inheritance rules.
   */
  documentVersioningWorkspaceSettings: Array<AdminDocumentVersioningWorkspaceSettingsType>;
  /**
   * Effective theme profile for global scope or a workspace override.
   * Admin-only.
   */
  effectiveThemeProfile: ThemeProfileType;
  /** Empty waiting and delayed jobs for one queue. */
  emptyQueue: AdminQueueMutationResultType;
  /** Enable a template (replaces `templateRegistry { enableTemplate(...) }`). */
  enableTemplate: TemplateCatalogEntryType;
  /**
   * Enable a user (replaces flat-root `enableUser`).
   *
   * The shared owner changes status without restoring revoked credentials.
   */
  enableUser: UserType;
  /** Export a revision's metadata (replaces `templateRegistry { exportRevision(...) }`). */
  exportRevision: TemplateRevisionType;
  /** Trigger an immediate metrics flush in the running API process. */
  flushMetrics: AdminMetricsFlushResultType;
  /** Trigger an immediate telemetry flush in the running API process. */
  flushTelemetry: AdminTelemetryFlushResultType;
  gitTokenRotationProviders: Array<GitTokenRotationProvider>;
  gitTokenRotationStatus: Maybe<GitTokenRotationStatus>;
  /** Import a template bundle (replaces `templateRegistry { importTemplate(...) }`). */
  importTemplate: TemplateImportResultType;
  /** Import multiple users (replaces flat-root `importUsers`). */
  importUsers: Array<UserImportResultType>;
  /** Admin logging config (replaces flat-root `loggingConfig`). */
  loggingConfig: GqlLoggingConfig;
  /** Metrics runtime state for the System > Metrics admin tab. */
  metricsStatus: AdminMetricsStatusType;
  /**
   * Read the saved effective directory only. No draft URL/credential inputs,
   * provider side effects, membership mutation or login dependency.
   */
  oidcGroupDirectory: AdminOidcGroupDirectory;
  organization: OrganizationType;
  organizationExport: OrganizationExportType;
  /**
   * Global organisation identity. This is intentionally not workspace
   * overrideable; document branding may consume it but must not redefine it.
   */
  organizationIdentity: OrganizationIdentityType;
  organizationImportApply: OrganizationImportPreviewType;
  organizationImportDryRun: OrganizationImportPreviewType;
  organizationPolicy: OrganizationPolicyType;
  organizationProjectRequests: Array<OrganizationProjectRequestType>;
  organizationUnit: Maybe<OrganizationUnitTypeOutput>;
  organizationUnitDeletionPreview: OrganizationUnitDeletionPreviewType;
  organizationUnitMembers: Array<OrganizationUnitMemberType>;
  organizationUnitTypes: Array<OrganizationUnitTypeType>;
  organizationUnitWorkspaces: Array<OrganizationUnitWorkspaceType>;
  organizationUnits: Array<OrganizationUnitTypeOutput>;
  /** List orphaned workspaces (owner deleted) (replaces flat-root `orphanedWorkspaces`). */
  orphanedWorkspaces: Array<AdminWorkspaceType>;
  /** Count orphaned workspaces (replaces flat-root `orphanedWorkspacesCount`). */
  orphanedWorkspacesCount: Scalars["Int"]["output"];
  /** Pause every known queue. */
  pauseAllQueues: AdminQueueMutationResultType;
  /** Pause one queue. */
  pauseQueue: AdminQueueMutationResultType;
  /**
   * Admin-only render-job list for the PDF Export diagnostics tab.
   *
   * The user-facing PDF export lifecycle remains on the public root
   * (`exportPdf`, `pdfExportJob`, `documentPdfExportHistory`) because regular
   * workspace members start and poll their own jobs. Operator diagnostics and
   * configuration data live here so the admin frontend has one auth/cache
   * contract for business data.
   */
  pdfExportJobs: Array<PdfExportAdminJobType>;
  /** PDF export settings for one workspace. Admin-only. */
  pdfExportSettings: PdfExportSettings;
  /** Fetch a single font by id. Admin-only. */
  pdfFont: Maybe<PdfFontType>;
  /**
   * List fonts in the PDF export font library, optionally filtered by
   * license status. Admin-only.
   */
  pdfFonts: Array<PdfFontType>;
  /** Fetch a single ICC color profile by id. Admin-only. */
  pdfIccProfile: Maybe<PdfIccProfileType>;
  /** List all ICC color profiles configured for PDF export. Admin-only. */
  pdfIccProfiles: Array<PdfIccProfileType>;
  /** Fetch a single PDF template by id. Admin-only. */
  pdfTemplate: Maybe<PdfTemplateAdminType>;
  /**
   * List every workspace that currently has `templateId` assigned.
   * Admin-only.
   */
  pdfTemplateAssignedWorkspaces: Array<PdfWorkspaceTemplateAssignmentType>;
  /** List every bundle file row for a PDF template. Admin-only. */
  pdfTemplateFiles: Array<PdfTemplateFileType>;
  /** Render an admin-side template preview PDF with representative document content. */
  pdfTemplatePreviewPdf: Scalars["String"]["output"];
  /** List every registered PDF template. Admin-only. */
  pdfTemplates: Array<PdfTemplateAdminType>;
  /** List all PDF template assignments for a workspace. Admin-only. */
  pdfWorkspaceAssignments: Array<PdfWorkspaceTemplateAssignmentType>;
  /** Promote a delayed job. */
  promoteJob: AdminQueueMutationResultType;
  /** Publish a template revision (replaces `templateRegistry { publishRevision(...) }`). */
  publishRevision: TemplateRevisionType;
  /** Paginated jobs for one queue/status. */
  queueJobs: AdminQueueJobsType;
  /** Queue runtime state for the Admin Queue page. */
  queueStatus: AdminQueueStatusType;
  /** Reassign workspace ownership to another user (admin-only). */
  reassignWorkspaceOwner: Scalars["Boolean"]["output"];
  /** Reject a font for use in PDF exports. Admin-only. */
  rejectPdfFont: PdfFontType;
  /** Remove a template assignment (replaces `templateRegistry { removeTemplateAssignment(...) }`). */
  removeTemplateAssignment: Scalars["Boolean"]["output"];
  /** Remove a feature from a workspace (replaces flat-root `removeWorkspaceFeature`). */
  removeWorkspaceFeature: Scalars["Boolean"]["output"];
  /** Atomically replace an administrator-owned PDF template bundle. */
  replacePdfTemplateBundle: PdfTemplateAdminType;
  /** Reset all log levels (replaces flat-root `resetLogLevels`). */
  resetLogLevels: Array<GqlLogModuleLevel>;
  /** Reset workspace document branding to global inheritance. Admin-only. */
  resetWorkspaceDocumentBranding: DocumentBrandingProfileAdmin;
  /**
   * Remove the workspace-specific theme profile so the workspace inherits
   * the current global profile again. Admin-only.
   */
  resetWorkspaceThemeProfile: ThemeProfileType;
  /** Resume every known queue. */
  resumeAllQueues: AdminQueueMutationResultType;
  /** Resume one queue. */
  resumeQueue: AdminQueueMutationResultType;
  /**
   * Resume the durable semantic step for an operator-reviewed
   * `cleanup_required` operation.
   */
  resumeWorkspaceContentCleanup: WorkspaceContentOperationType;
  /** Retire a template assignment (replaces `templateRegistry { retireTemplateAssignment(...) }`). */
  retireTemplateAssignment: Scalars["Boolean"]["output"];
  /** Retry a failed job. */
  retryJob: AdminQueueMutationResultType;
  runGitTokenRotationNow: GitTokenRotationStatus;
  /** Send a test email (replaces flat-root `sendTestEmail`). */
  sendTestEmail: Scalars["Boolean"]["output"];
  /**
   * Returns disk usage information for all server-managed directories.
   *
   * Each entry contains the path, whether it exists on the server filesystem,
   * and current size/free-space metrics.  I/O is performed in blocking threads
   * via `myoxus_infrastructure::disk` so this is safe under the async runtime.
   */
  serverDirectories: Array<ServerDirectory>;
  /**
   * Server info — same data as the public `serverConfig` query, exposed under
   * `admin { serverInfo }` for the admin frontend bootstrap.
   *
   * **Not gated behind admin auth.** The admin frontend's `RootRoutes` calls
   * this on every page load (including the unauthenticated `/auth` page) to
   * determine whether the server is initialised. Adding `ensure_admin` here
   * breaks the login bootstrap — the React tree throws "authentication
   * required" before the auth form can render. The fields returned are
   * identical to the public `serverConfig` query (P95-API-03's intent to
   * hide `availableUpgrade`/`availableUserFeatures`/`availableWorkspaceFeatures`
   * from the public endpoint was never actually wired up — the `#[graphql(skip)]`
   * attributes are absent from `ServerConfigType`), so gating this resolver
   * provides zero additional confidentiality.
   */
  serverInfo: AdminServerInfoType;
  /**
   * Update color schema values through the typed Theme DB model.
   * Admin-only and clone-on-write for locked system presets.
   */
  setColorSchemaValues: ThemeProfileType;
  /** Select a server-owned document colour policy. Admin-only. */
  setDocumentBrandingColorPolicy: DocumentBrandingProfileAdmin;
  setOrganizationUnitParent: Scalars["Boolean"]["output"];
  setOrganizationUnitStatus: OrganizationUnitTypeOutput;
  /**
   * Set a template default policy (admin only).
   *
   * Creates or updates the row in `template_default_policies` that drives
   * automatic seeding of new workspaces.
   */
  setTemplateDefaultPolicy: Scalars["Boolean"]["output"];
  /**
   * Set the global or workspace-specific effective theme.
   * Admin-only and backed by `theme_profiles`, not `app_configs`.
   */
  setThemeProfile: ThemeProfileType;
  /**
   * Update typography styles through the typed Theme DB model.
   * Admin-only and clone-on-write for locked system presets.
   */
  setTypographyStyles: ThemeProfileType;
  /** Set/unset admin privilege for a user. */
  setUserAdmin: Scalars["Boolean"]["output"];
  setUserManagerFeature: Scalars["Boolean"]["output"];
  /** Set a workspace's default PDF template. Admin-only. */
  setWorkspaceDefaultPdfTemplate: PdfExportSettings;
  /**
   * Set a per-workspace builtin-template override from the admin surface.
   *
   * The workspace-facing mutation is intentionally not used by the
   * adminfrontend: operator actions must run through the AdminRoot auth
   * contract and must not depend on the admin user being a member of the
   * target workspace.
   */
  setWorkspaceTemplateOverride: Scalars["Boolean"]["output"];
  /** Storage quota config (replaces flat-root `storageQuotaConfig`). */
  storageQuotaConfig: StorageQuotaConfigType;
  /** Telemetry runtime state for the System > Telemetry admin tab. */
  telemetryStatus: AdminTelemetryStatusType;
  /** List template assignments for a workspace (replaces `templateRegistry { templateAssignments(...) }`). */
  templateAssignments: Array<WorkspaceTemplatePolicyType>;
  /** List template catalog entries (replaces `templateRegistry { templateCatalog(...) }`). */
  templateCatalog: Array<TemplateCatalogEntryType>;
  /** Count template catalog entries (replaces `templateRegistry { templateCatalogCount(...) }`). */
  templateCatalogCount: Scalars["Int"]["output"];
  /**
   * List all template default policies (admin only).
   *
   * Returns every row in `template_default_policies`. Used by the
   * Default-Policies admin tab (P125-TPL-A-06).
   */
  templateDefaultPolicies: Array<TemplateDefaultPolicyType>;
  /** List template jobs (replaces `templateRegistry { templateJobs(...) }`). */
  templateJobs: Array<TemplateJobType>;
  /** List revisions for a template (replaces `templateRegistry { templateRevisions(...) }`). */
  templateRevisions: Array<TemplateRevisionType>;
  /** Test a generic OIDC provider config without returning secrets or raw claims. */
  testOidcProvider: AdminOidcProviderTestResult;
  /** Server-owned theme/font/branding catalog. Admin-only. */
  themeCatalog: ThemeCatalogType;
  transcriptionStatus: AdminTranscriptionStatusType;
  /**
   * Clean up search embeddings for deleted (trashed) documents.
   *
   * Removes stale entries from `search_content` for docs whose `deleted_at`
   * is set in the `docs` table.
   */
  triggerCleanupTrashedDocEmbeddings: Scalars["Int"]["output"];
  /** Trigger drift scan for a workspace (replaces `templateRegistry { triggerDriftScan(...) }`). */
  triggerDriftScan: Scalars["Boolean"]["output"];
  /** Trigger a full search reindex (replaces flat-root `triggerFullReindex`). */
  triggerFullReindex: Scalars["Boolean"]["output"];
  /** Trigger template reconcile for a workspace (replaces `templateRegistry { triggerReconcile(...) }`). */
  triggerReconcile: Scalars["Boolean"]["output"];
  /** Trigger search reindex for a workspace (replaces flat-root `triggerWorkspaceReindex`). */
  triggerWorkspaceReindex: Scalars["Boolean"]["output"];
  unassignOrganizationManager: Scalars["Boolean"]["output"];
  unassignOrganizationUnitWorkspace: Scalars["Boolean"]["output"];
  /** Revoke a workspace's access to a PDF template. Admin-only. */
  unassignPdfTemplateFromWorkspace: Scalars["Boolean"]["output"];
  /**
   * Update global app/server brand asset references. Binary upload remains
   * the REST transport; this mutation only selects already-persisted assets.
   */
  updateAppServerBranding: AppServerBrandingType;
  /**
   * Update category/tags of a builtin template (admin only).
   *
   * Title/description/slug are locked for builtins — only category and tags
   * are writable (§6.4 of the design doc).
   */
  updateBuiltinTemplateMetadata: TemplateCatalogEntryType;
  /** Update document branding colors. Admin-only. */
  updateDocumentBrandingColors: DocumentBrandingProfileAdmin;
  /** Update document-facing branding text. Admin-only. */
  updateDocumentBrandingText: DocumentBrandingProfileAdmin;
  updateDocumentMetadataFieldDefinition: DocumentMetadataFieldDefinitionType;
  /**
   * Replace the Admin-owned workspace overrides without changing Web-owned
   * edit-capture fields or non-PDF event triggers.
   */
  updateDocumentVersioningWorkspaceSettings: AdminDocumentVersioningWorkspaceSettingsType;
  /** Update log module level (replaces flat-root `updateLogModuleLevel`). */
  updateLogModuleLevel: GqlLogModuleLevel;
  /** Update log output config (replaces flat-root `updateLogOutput`). */
  updateLogOutput: GqlLogOutputConfig;
  updateOrganization: OrganizationType;
  /**
   * Update global organisation identity. This is not workspace-overridable
   * and does not own the product/server display name.
   */
  updateOrganizationIdentity: OrganizationIdentityType;
  updateOrganizationPolicy: OrganizationPolicyType;
  /** Update workspace-default render parameters. Admin-only. */
  updatePdfExportSettings: PdfExportSettings;
  /** Update display metadata of an existing PDF template. Admin-only. */
  updatePdfTemplateMetadata: PdfTemplateAdminType;
  /** Update a user (replaces flat-root `updateUser`). */
  updateUser: UserType;
  /** Update user features/roles (replaces flat-root `updateUserFeatures`). */
  updateUserFeatures: Array<FeatureType>;
  /** Upload a document-branding logo (PNG or SVG). Admin-only. */
  uploadDocumentBrandLogo: DocumentBrandingProfileAdmin;
  /** Upload a new ICC color profile for PDF export. Admin-only. */
  uploadIccProfile: PdfIccProfileType;
  /** Upload a new font to the PDF export font library. Admin-only. */
  uploadPdfFont: PdfFontType;
  /** Upload a new PDF template bundle. Admin-only. */
  uploadPdfTemplate: PdfTemplateAdminType;
  upsertDocumentMetadataValueDefinition: DocumentMetadataValueDefinitionType;
  upsertDocumentStatusSchema: DocumentStatusSchemaType;
  upsertDocumentStatusTransition: DocumentStatusTransitionType;
  upsertDocumentStatusValue: DocumentStatusValueType;
  upsertDocumentType: DocumentTypeDefinitionType;
  upsertDocumentVersionPolicy: DocumentVersionPolicyType;
  upsertOrganizationUnit: OrganizationUnitTypeOutput;
  upsertOrganizationUnitType: OrganizationUnitTypeType;
  /** Find a user by email (replaces flat-root `userByEmail`). */
  userByEmail: Maybe<UserType>;
  /** Find a user by ID (replaces flat-root `userById`). */
  userById: UserType;
  /**
   * Last known login timestamp for one user, derived from the auth session
   * table. This intentionally stays read-only and admin-scoped because the
   * Organization members tab only needs stale-login diagnostics.
   */
  userLastLoginAt: Maybe<Scalars["DateTime"]["output"]>;
  /**
   * List all OU memberships for a single user.
   *
   * Powers the admin user-detail panel (`P-AR-2-S02`). Returns one row
   * per `(unit, user)` membership including the OU snapshot (id, name,
   * slug), the role within the OU, the membership source (manual / sync
   * origin) and the join timestamp. Rows are ordered by OU name ASC.
   * Empty list when the user has no memberships.
   */
  userOrganizationMemberships: Array<UserOrganizationMembershipResult>;
  /** List users with rich filter (replaces flat-root `users` admin version). */
  users: Array<UserType>;
  /** Count users matching filter (replaces flat-root `usersCount` admin version). */
  usersCount: Scalars["Int"]["output"];
  /** Validate config updates (replaces flat-root `validateAppConfig`). */
  validateAppConfig: Array<AppConfigValidateResultType>;
  /**
   * Redacted operator projection for one XWS operation discovered through
   * the audit stream.
   */
  workspaceContentOperationStatus: WorkspaceContentOperationType;
  workspaceOrganizationUnitWorkspaces: Array<OrganizationUnitWorkspaceType>;
  /** List template instances for a workspace (replaces `templateRegistry { workspaceTemplateInstances(...) }`). */
  workspaceTemplateInstances: Array<WorkspaceTemplateInstanceType>;
  /** Read native workspace templates without importing or materializing sources. */
  workspaceTemplateSources: WorkspaceTemplateSourcePageType;
}

export interface AdminRootAddWorkspaceFeatureArgs {
  feature: FeatureType;
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootAddWorkspaceMemberArgs {
  role?: InputMaybe<Scalars["String"]["input"]>;
  userId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootAdminAllSharedLinksArgs {
  filter?: InputMaybe<AdminAllSharedLinksFilterInput>;
  pagination: PaginationInput;
}

export interface AdminRootAdminApplyCaBundleArgs {
  file: Scalars["Upload"]["input"];
}

export interface AdminRootAdminAuditLogArgs {
  filter?: InputMaybe<AuditLogFilterInput>;
  limit?: Scalars["Int"]["input"];
  offset?: Scalars["Int"]["input"];
}

export interface AdminRootAdminAuditLogCountArgs {
  filter?: InputMaybe<AuditLogFilterInput>;
}

export interface AdminRootAdminCacheTuningHistoryArgs {
  cacheName: Scalars["String"]["input"];
  hours?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface AdminRootAdminDashboardArgs {
  input?: InputMaybe<AdminDashboardInput>;
}

export interface AdminRootAdminDocumentAuditLogArgs {
  filter?: InputMaybe<AdminDocumentAuditFilterInput>;
  limit?: Scalars["Int"]["input"];
  offset?: Scalars["Int"]["input"];
}

export interface AdminRootAdminDocumentAuditLogCountArgs {
  filter?: InputMaybe<AdminDocumentAuditFilterInput>;
}

export interface AdminRootAdminRemoveWorkspaceMemberArgs {
  userId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootAdminSearchUsersArgs {
  excludeUnitId?: InputMaybe<Scalars["ID"]["input"]>;
  features?: InputMaybe<Array<Scalars["String"]["input"]>>;
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  query: Scalars["String"]["input"];
}

export interface AdminRootAdminSearchWorkspacesArgs {
  excludeUnitId?: InputMaybe<Scalars["ID"]["input"]>;
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  ouId?: InputMaybe<Scalars["ID"]["input"]>;
  query: Scalars["String"]["input"];
}

export interface AdminRootAdminUpdateConfigArgs {
  updates: Array<UpdateAppConfigInput>;
}

export interface AdminRootAdminUpdateWorkspaceArgs {
  input: AdminUpdateWorkspaceInput;
}

export interface AdminRootAdminUpdateWorkspaceMemberRoleArgs {
  role: Permission;
  userId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootAdminWorkspaceArgs {
  id: Scalars["String"]["input"];
}

export interface AdminRootAdminWorkspaceQuotaDetailsArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootAdminWorkspacesArgs {
  filter: ListWorkspaceInput;
}

export interface AdminRootAdminWorkspacesCountArgs {
  filter: ListWorkspaceInput;
}

export interface AdminRootApplyLogPresetArgs {
  preset: Scalars["String"]["input"];
}

export interface AdminRootApplyTemplateManualUpdateArgs {
  revisionId: Scalars["ID"]["input"];
  templateId: Scalars["ID"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootApprovePdfFontArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootArchiveTemplateArgs {
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootAssignOrganizationManagerArgs {
  input: AssignOrganizationManagerInput;
}

export interface AdminRootAssignOrganizationUnitWorkspaceArgs {
  input: AssignOrganizationUnitWorkspaceInput;
}

export interface AdminRootAssignPdfTemplateToWorkspaceArgs {
  templateId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootAssignTemplateToWorkspaceArgs {
  provisioningMode: ProvisioningModeType;
  selectedRevisionId?: InputMaybe<Scalars["ID"]["input"]>;
  selectionMode: SelectionModeType;
  templateId: Scalars["ID"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootBanUserArgs {
  id: Scalars["String"]["input"];
}

export interface AdminRootBumpBuilderVersionArgs {
  slug: Scalars["String"]["input"];
}

export interface AdminRootCancelPdfExportJobArgs {
  jobId: Scalars["String"]["input"];
}

export interface AdminRootCleanQueueArgs {
  gracePeriodMs?: Scalars["Int"]["input"];
  queueName: Scalars["String"]["input"];
  status: Scalars["String"]["input"];
}

export interface AdminRootCleanupCancelledWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface AdminRootConfigChangelogArgs {
  limit?: Scalars["Int"]["input"];
  offset?: Scalars["Int"]["input"];
}

export interface AdminRootConfigureGitTokenRotationArgs {
  input: ConfigureGitTokenRotationInput;
}

export interface AdminRootCreateChangePasswordUrlArgs {
  callbackUrl?: InputMaybe<Scalars["String"]["input"]>;
  userId: Scalars["String"]["input"];
}

export interface AdminRootCreateUserArgs {
  input: CreateUserInput;
}

export interface AdminRootDeactivateOrganizationUnitArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootDeactivateOrganizationUnitTypeArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootDecideOrganizationProjectRequestArgs {
  id: Scalars["ID"]["input"];
  newStatus: ProjectRequestStatusEnum;
}

export interface AdminRootDeleteDocumentBrandLogoArgs {
  kind: BrandLogoKind;
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootDeleteIccProfileArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootDeleteOrganizationUnitPermanentlyArgs {
  confirmedName: Scalars["String"]["input"];
  id: Scalars["ID"]["input"];
  previewRevision: Scalars["DateTime"]["input"];
}

export interface AdminRootDeletePdfFontArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootDeletePdfTemplateArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootDeleteUserArgs {
  id: Scalars["String"]["input"];
}

export interface AdminRootDeleteWorkspaceArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootDisableTemplateArgs {
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootDocumentBrandColorPalettesArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootDocumentBrandingProfileArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootDocumentMetadataValueDefinitionsArgs {
  fieldKey: Scalars["String"]["input"];
}

export interface AdminRootDocumentStatusValuesArgs {
  schemaKey: Scalars["String"]["input"];
}

export interface AdminRootEffectiveThemeProfileArgs {
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface AdminRootEmptyQueueArgs {
  queueName: Scalars["String"]["input"];
}

export interface AdminRootEnableTemplateArgs {
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootEnableUserArgs {
  id: Scalars["String"]["input"];
}

export interface AdminRootExportRevisionArgs {
  revisionId: Scalars["ID"]["input"];
}

export interface AdminRootGitTokenRotationStatusArgs {
  profileId: Scalars["String"]["input"];
}

export interface AdminRootImportTemplateArgs {
  file: Scalars["Upload"]["input"];
}

export interface AdminRootImportUsersArgs {
  input: ImportUsersInput;
}

export interface AdminRootOrganizationImportApplyArgs {
  input: OrganizationImportInput;
}

export interface AdminRootOrganizationImportDryRunArgs {
  input: OrganizationImportInput;
}

export interface AdminRootOrganizationProjectRequestsArgs {
  status?: InputMaybe<ProjectRequestStatusEnum>;
}

export interface AdminRootOrganizationUnitArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootOrganizationUnitDeletionPreviewArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootOrganizationUnitMembersArgs {
  role?: InputMaybe<OrganizationUnitRoleEnum>;
  unitId: Scalars["ID"]["input"];
}

export interface AdminRootOrganizationUnitTypesArgs {
  includeInactive?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface AdminRootOrganizationUnitWorkspacesArgs {
  unitId: Scalars["ID"]["input"];
}

export interface AdminRootOrganizationUnitsArgs {
  status?: InputMaybe<OrganizationUnitStatusEnum>;
}

export interface AdminRootOrphanedWorkspacesArgs {
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface AdminRootPauseQueueArgs {
  queueName: Scalars["String"]["input"];
}

export interface AdminRootPdfExportJobsArgs {
  filter?: InputMaybe<AdminPdfExportJobsFilterInput>;
}

export interface AdminRootPdfExportSettingsArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootPdfFontArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootPdfFontsArgs {
  status?: InputMaybe<PdfFontLicenseStatusEnum>;
}

export interface AdminRootPdfIccProfileArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootPdfTemplateArgs {
  id: Scalars["ID"]["input"];
}

export interface AdminRootPdfTemplateAssignedWorkspacesArgs {
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootPdfTemplateFilesArgs {
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootPdfTemplatePreviewPdfArgs {
  locale?: InputMaybe<Scalars["String"]["input"]>;
  templateId: Scalars["String"]["input"];
}

export interface AdminRootPdfTemplatesArgs {
  includeDeleted?: Scalars["Boolean"]["input"];
}

export interface AdminRootPdfWorkspaceAssignmentsArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootPromoteJobArgs {
  jobId: Scalars["String"]["input"];
  queueName: Scalars["String"]["input"];
}

export interface AdminRootPublishRevisionArgs {
  revisionId: Scalars["ID"]["input"];
}

export interface AdminRootQueueJobsArgs {
  cursor: Scalars["Int"]["input"];
  limit: Scalars["Int"]["input"];
  queueName: Scalars["String"]["input"];
  status: Scalars["String"]["input"];
}

export interface AdminRootReassignWorkspaceOwnerArgs {
  newOwnerId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootRejectPdfFontArgs {
  id: Scalars["ID"]["input"];
  reason: Scalars["String"]["input"];
}

export interface AdminRootRemoveTemplateAssignmentArgs {
  policyId: Scalars["ID"]["input"];
}

export interface AdminRootRemoveWorkspaceFeatureArgs {
  feature: FeatureType;
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootReplacePdfTemplateBundleArgs {
  filePaths: Array<Scalars["String"]["input"]>;
  files: Array<Scalars["Upload"]["input"]>;
  id: Scalars["ID"]["input"];
  manifest: Scalars["JSON"]["input"];
  rightsConfirmed: Scalars["Boolean"]["input"];
}

export interface AdminRootResetWorkspaceDocumentBrandingArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootResetWorkspaceThemeProfileArgs {
  input: ResetWorkspaceThemeProfileInput;
}

export interface AdminRootResumeQueueArgs {
  queueName: Scalars["String"]["input"];
}

export interface AdminRootResumeWorkspaceContentCleanupArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface AdminRootRetireTemplateAssignmentArgs {
  policyId: Scalars["ID"]["input"];
}

export interface AdminRootRetryJobArgs {
  jobId: Scalars["String"]["input"];
  queueName: Scalars["String"]["input"];
}

export interface AdminRootRunGitTokenRotationNowArgs {
  profileId: Scalars["String"]["input"];
}

export interface AdminRootSendTestEmailArgs {
  config: Scalars["JSON"]["input"];
}

export interface AdminRootSetColorSchemaValuesArgs {
  input: SetColorSchemaValuesInput;
}

export interface AdminRootSetDocumentBrandingColorPolicyArgs {
  paletteKey: Scalars["String"]["input"];
  policy: DocumentBrandColorPolicy;
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootSetOrganizationUnitParentArgs {
  parentUnitId?: InputMaybe<Scalars["ID"]["input"]>;
  unitId: Scalars["ID"]["input"];
}

export interface AdminRootSetOrganizationUnitStatusArgs {
  id: Scalars["ID"]["input"];
  status: OrganizationUnitStatusEnum;
}

export interface AdminRootSetTemplateDefaultPolicyArgs {
  input: SetTemplateDefaultPolicyInput;
}

export interface AdminRootSetThemeProfileArgs {
  input: SetThemeProfileInput;
}

export interface AdminRootSetTypographyStylesArgs {
  input: SetTypographyStylesInput;
}

export interface AdminRootSetUserAdminArgs {
  isAdmin: Scalars["Boolean"]["input"];
  userId: Scalars["ID"]["input"];
}

export interface AdminRootSetUserManagerFeatureArgs {
  enabled: Scalars["Boolean"]["input"];
  userId: Scalars["ID"]["input"];
}

export interface AdminRootSetWorkspaceDefaultPdfTemplateArgs {
  templateId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootSetWorkspaceTemplateOverrideArgs {
  input: SetWorkspaceTemplateOverrideInput;
}

export interface AdminRootTemplateAssignmentsArgs {
  skip?: Scalars["Int"]["input"];
  take?: Scalars["Int"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootTemplateCatalogArgs {
  skip?: Scalars["Int"]["input"];
  status?: InputMaybe<TemplateStatusType>;
  take?: Scalars["Int"]["input"];
}

export interface AdminRootTemplateCatalogCountArgs {
  status?: InputMaybe<TemplateStatusType>;
}

export interface AdminRootTemplateJobsArgs {
  skip?: Scalars["Int"]["input"];
  take?: Scalars["Int"]["input"];
}

export interface AdminRootTemplateRevisionsArgs {
  skip?: Scalars["Int"]["input"];
  take?: Scalars["Int"]["input"];
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootTestOidcProviderArgs {
  config: Scalars["JSON"]["input"];
  sampleClaims?: InputMaybe<Scalars["JSON"]["input"]>;
}

export interface AdminRootTriggerDriftScanArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootTriggerReconcileArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootTriggerWorkspaceReindexArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUnassignOrganizationManagerArgs {
  unitId: Scalars["ID"]["input"];
  userId: Scalars["ID"]["input"];
}

export interface AdminRootUnassignOrganizationUnitWorkspaceArgs {
  relationship: OrganizationUnitWorkspaceRelationshipEnum;
  unitId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUnassignPdfTemplateFromWorkspaceArgs {
  templateId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUpdateAppServerBrandingArgs {
  input: UpdateAppServerBrandingInput;
}

export interface AdminRootUpdateBuiltinTemplateMetadataArgs {
  category?: InputMaybe<Scalars["String"]["input"]>;
  tags?: InputMaybe<Array<Scalars["String"]["input"]>>;
  templateId: Scalars["ID"]["input"];
}

export interface AdminRootUpdateDocumentBrandingColorsArgs {
  accent?: InputMaybe<Scalars["String"]["input"]>;
  primary?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUpdateDocumentBrandingTextArgs {
  footerText?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUpdateDocumentMetadataFieldDefinitionArgs {
  input: AdminUpdateDocumentMetadataFieldDefinitionInput;
}

export interface AdminRootUpdateDocumentVersioningWorkspaceSettingsArgs {
  input: AdminUpdateDocumentVersioningWorkspaceSettingsInput;
}

export interface AdminRootUpdateLogModuleLevelArgs {
  input: UpdateLogModuleLevelInput;
}

export interface AdminRootUpdateLogOutputArgs {
  input: UpdateLogOutputInput;
}

export interface AdminRootUpdateOrganizationArgs {
  input: UpdateOrganizationInput;
}

export interface AdminRootUpdateOrganizationIdentityArgs {
  input: UpdateOrganizationIdentityInput;
}

export interface AdminRootUpdateOrganizationPolicyArgs {
  input: UpdateOrganizationPolicyInput;
}

export interface AdminRootUpdatePdfExportSettingsArgs {
  colorProfile?: InputMaybe<Scalars["String"]["input"]>;
  imageQuality?: InputMaybe<Scalars["String"]["input"]>;
  ligaturesEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  locale?: InputMaybe<Scalars["String"]["input"]>;
  paperSize?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUpdatePdfTemplateMetadataArgs {
  description?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["ID"]["input"];
  name?: InputMaybe<Scalars["String"]["input"]>;
}

export interface AdminRootUpdateUserArgs {
  id: Scalars["String"]["input"];
  input: ManageUserInput;
}

export interface AdminRootUpdateUserFeaturesArgs {
  features: Array<FeatureType>;
  id: Scalars["String"]["input"];
}

export interface AdminRootUploadDocumentBrandLogoArgs {
  file: Scalars["Upload"]["input"];
  kind: BrandLogoKind;
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootUploadIccProfileArgs {
  file: Scalars["Upload"]["input"];
  name: Scalars["String"]["input"];
  profileType: PdfIccProfileTypeEnum;
}

export interface AdminRootUploadPdfFontArgs {
  file: Scalars["Upload"]["input"];
  license?: InputMaybe<Scalars["String"]["input"]>;
}

export interface AdminRootUploadPdfTemplateArgs {
  filePaths: Array<Scalars["String"]["input"]>;
  files: Array<Scalars["Upload"]["input"]>;
  manifest: Scalars["JSON"]["input"];
  rightsConfirmed: Scalars["Boolean"]["input"];
}

export interface AdminRootUpsertDocumentMetadataValueDefinitionArgs {
  input: AdminUpsertDocumentMetadataValueDefinitionInput;
}

export interface AdminRootUpsertDocumentStatusSchemaArgs {
  input: AdminUpsertDocumentStatusSchemaInput;
}

export interface AdminRootUpsertDocumentStatusTransitionArgs {
  input: AdminUpsertDocumentStatusTransitionInput;
}

export interface AdminRootUpsertDocumentStatusValueArgs {
  input: AdminUpsertDocumentStatusValueInput;
}

export interface AdminRootUpsertDocumentTypeArgs {
  input: AdminUpsertDocumentTypeInput;
}

export interface AdminRootUpsertDocumentVersionPolicyArgs {
  input: AdminUpsertDocumentVersionPolicyInput;
}

export interface AdminRootUpsertOrganizationUnitArgs {
  input: UpsertOrganizationUnitInput;
}

export interface AdminRootUpsertOrganizationUnitTypeArgs {
  input: UpsertOrganizationUnitTypeInput;
}

export interface AdminRootUserByEmailArgs {
  email: Scalars["String"]["input"];
}

export interface AdminRootUserByIdArgs {
  id: Scalars["String"]["input"];
}

export interface AdminRootUserLastLoginAtArgs {
  userId: Scalars["ID"]["input"];
}

export interface AdminRootUserOrganizationMembershipsArgs {
  userId: Scalars["ID"]["input"];
}

export interface AdminRootUsersArgs {
  filter: ListUserInput;
}

export interface AdminRootUsersCountArgs {
  filter: ListUserInput;
}

export interface AdminRootValidateAppConfigArgs {
  updates: Array<UpdateAppConfigInput>;
}

export interface AdminRootWorkspaceContentOperationStatusArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface AdminRootWorkspaceOrganizationUnitWorkspacesArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface AdminRootWorkspaceTemplateInstancesArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface AdminRootWorkspaceTemplateSourcesArgs {
  skip?: Scalars["Int"]["input"];
  take?: Scalars["Int"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

/**
 * Admin-only server information type. Superset of `ServerConfigType`,
 * additionally exposing fields that should not be visible to unauthenticated users.
 * Accessible only via `admin { serverInfo { ... } }`.
 */
export interface AdminServerInfoType {
  __typename?: "AdminServerInfoType";
  /** Available server upgrade (admin-only — not exposed on public serverConfig). */
  availableUpgrade: Maybe<ReleaseVersionType>;
  /** Available user feature flags (admin-only). */
  availableUserFeatures: Array<FeatureType>;
  /** Available workspace feature flags (admin-only). */
  availableWorkspaceFeatures: Array<FeatureType>;
  baseUrl: Scalars["String"]["output"];
  calendarCalDAVProviders: Array<CalendarCalDavProviderPresetObjectType>;
  calendarProviders: Array<CalendarProviderType>;
  /** Client settings (admin-configurable). Includes the operator-set download URL. */
  client: ServerClientConfigType;
  credentialsRequirement: CredentialsRequirementType;
  deploymentType: ServerDeploymentType;
  features: Array<ServerFeature>;
  flavor: Scalars["String"]["output"];
  /**
   * Git Sync policy configuration. Added in 0.30 — older clients that
   * don't query this field are unaffected (GraphQL ignores unqueried fields).
   */
  gitSync: ServerGitSyncConfig;
  /**
   * i18n settings (admin-configurable). The web frontend reads `availableLocales` at startup
   * to restrict the language selector to admin-permitted locales.
   */
  i18n: ServerI18NConfigType;
  initialized: Scalars["Boolean"]["output"];
  /**
   * Journal settings (admin-configurable). The web frontend reads these
   * at startup to set firstDayOfWeek and showCalendarWeeks.
   */
  journal: ServerJournalConfigType;
  name: Scalars["String"]["output"];
  oauthProviders: Array<OAuthProviderType>;
  /**
   * Public request-lifecycle budgets for the private preview consumer. All
   * renderer and cache limits remain operator-private.
   */
  preview: ServerPreviewClientConfigType;
  /**
   * Capability is resolved outside the cached serverConfig value so a live
   * config change or observed service failure cannot leave stale readiness.
   */
  transcription: TranscriptionCapabilityType;
  /**
   * Legacy `type` field — alias for `deploymentType` as a string.
   * The web client queries this field by name; `type` is a Rust keyword
   * so we expose it via the graphql rename attribute.
   */
  type: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface AdminSharedLinkTopItemType {
  __typename?: "AdminSharedLinkTopItemType";
  docId: Scalars["String"]["output"];
  guestViews: Scalars["Int"]["output"];
  lastAccessedAt: Maybe<Scalars["DateTime"]["output"]>;
  publishedAt: Maybe<Scalars["DateTime"]["output"]>;
  shareUrl: Scalars["String"]["output"];
  title: Maybe<Scalars["String"]["output"]>;
  uniqueViews: Scalars["Int"]["output"];
  views: Scalars["Int"]["output"];
  workspaceId: Scalars["String"]["output"];
}

export interface AdminTelemetryCountersType {
  __typename?: "AdminTelemetryCountersType";
  acceptedTotal: Scalars["Int"]["output"];
  bufferOverflowTotal: Scalars["Int"]["output"];
  flushedTotal: Scalars["Int"]["output"];
  offeredTotal: Scalars["Int"]["output"];
  rejectedCategoryTotal: Scalars["Int"]["output"];
  rejectedDisabledTotal: Scalars["Int"]["output"];
  rejectedDuplicateTotal: Scalars["Int"]["output"];
  rejectedInvalidTotal: Scalars["Int"]["output"];
  rejectedSampledTotal: Scalars["Int"]["output"];
}

export interface AdminTelemetryFlushResultType {
  __typename?: "AdminTelemetryFlushResultType";
  buffered: Scalars["Int"]["output"];
  inserted: Scalars["Int"]["output"];
}

export interface AdminTelemetryStatusType {
  __typename?: "AdminTelemetryStatusType";
  batchMaxEvents: Scalars["Int"]["output"];
  categories: Scalars["JSON"]["output"];
  counters: AdminTelemetryCountersType;
  dailyRollups7d: Maybe<Scalars["Int"]["output"]>;
  dedupeHitRate: Scalars["Float"]["output"];
  dedupeTtlHours: Scalars["Int"]["output"];
  enabled: Scalars["Boolean"]["output"];
  flushIntervalSeconds: Scalars["Int"]["output"];
  hotBufferLen: Scalars["Int"]["output"];
  ingestRateLimitPerIpPerMin: Scalars["Int"]["output"];
  lastFlushAt: Maybe<Scalars["DateTime"]["output"]>;
  lastFlushCount: Scalars["Int"]["output"];
  persisted24h: Maybe<Scalars["Int"]["output"]>;
  retentionDailyDays: Scalars["Int"]["output"];
  retentionRawDays: Scalars["Int"]["output"];
  samplingRates: Scalars["JSON"]["output"];
}

export interface AdminTranscriptionConnectionCheckType {
  __typename?: "AdminTranscriptionConnectionCheckType";
  catalogSupported: Maybe<Scalars["Boolean"]["output"]>;
  error: Maybe<Scalars["String"]["output"]>;
  /** Catalog membership is not evidence of successful speech recognition. */
  modelListed: Maybe<Scalars["Boolean"]["output"]>;
  successful: Scalars["Boolean"]["output"];
}

export interface AdminTranscriptionStatusType {
  __typename?: "AdminTranscriptionStatusType";
  capability: TranscriptionCapabilityType;
  lastConnectionCheck: Maybe<AdminTranscriptionConnectionCheckType>;
}

export interface AdminUpdateDocumentMetadataFieldDefinitionInput {
  editableBy?: InputMaybe<Scalars["String"]["input"]>;
  enabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  exportMode?: InputMaybe<Scalars["String"]["input"]>;
  key: Scalars["String"]["input"];
  label?: InputMaybe<Scalars["String"]["input"]>;
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  requiredMode?: InputMaybe<Scalars["String"]["input"]>;
  validationConfig?: InputMaybe<Scalars["JSON"]["input"]>;
  visibleInHeader?: InputMaybe<Scalars["Boolean"]["input"]>;
  visibleInLists?: InputMaybe<Scalars["Boolean"]["input"]>;
  visibleInProperties?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface AdminUpdateDocumentVersioningWorkspaceSettingsInput {
  /** `null` inherits; `false` persists an empty trigger list for this workspace. */
  autoVersionOnPdfExport?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** `null` clears the workspace override and inherits the global default. */
  enabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** `null` inherits; values must be in the same 1..=50 envelope as per-doc settings. */
  retentionCount?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

/**
 * Input for the `adminUpdateWorkspace` mutation (all fields optional).
 *
 * ## Storage quota semantics (P112-QUOTA-C-05)
 *
 * | `storageQuotaMb`      | `clearStorageQuota` | Result |
 * |----------------------|---------------------|--------|
 * | absent / `null`      | absent / `false`    | quota unchanged |
 * | `Some(n)` where n > 0 | absent / `false`  | quota set to n MB |
 * | any                  | `true`              | quota cleared (→ NULL) |
 * | `0`                  | absent / `false`    | quota cleared (same as clear=true) |
 *
 * The deprecated `storageQuotaBytes` field is accepted for backwards compatibility
 * but values ≥ 2 GiB may have precision issues client-side. Prefer `storageQuotaMb`.
 * When `storageQuotaMb` is set, `storageQuotaBytes` is ignored.
 */
export interface AdminUpdateWorkspaceInput {
  avatarKey?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Explicitly clear the workspace storage quota override, reverting to the
   * server config default. When `true`, `storageQuotaMb` is ignored.
   */
  clearStorageQuota?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableAi?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableDocEmbedding?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableSharing?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableUrlPreview?: InputMaybe<Scalars["Boolean"]["input"]>;
  features?: InputMaybe<Array<FeatureType>>;
  id: Scalars["String"]["input"];
  name?: InputMaybe<Scalars["String"]["input"]>;
  public?: InputMaybe<Scalars["Boolean"]["input"]>;
  /**
   * **Deprecated** — use `storageQuotaMb` instead.
   * Per-workspace storage quota override in bytes. NULL = inherit from global default.
   * Ignored when `storageQuotaMb` is also present.
   */
  storageQuotaBytes?: InputMaybe<Scalars["Int"]["input"]>;
  /**
   * Per-workspace storage quota override in **megabytes**.
   * Use `0` or set `clearStorageQuota = true` to remove the override.
   * Values > 2,097,151 MB (~2 TiB) are rejected.
   */
  storageQuotaMb?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface AdminUpsertDocumentMetadataValueDefinitionInput {
  color?: InputMaybe<Scalars["String"]["input"]>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  fieldKey: Scalars["String"]["input"];
  icon?: InputMaybe<Scalars["String"]["input"]>;
  id?: InputMaybe<Scalars["ID"]["input"]>;
  isActive?: InputMaybe<Scalars["Boolean"]["input"]>;
  key: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  sortOrder?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface AdminUpsertDocumentStatusSchemaInput {
  complexity: Scalars["String"]["input"];
  description?: InputMaybe<Scalars["String"]["input"]>;
  id?: InputMaybe<Scalars["ID"]["input"]>;
  isActive?: InputMaybe<Scalars["Boolean"]["input"]>;
  isPreset?: InputMaybe<Scalars["Boolean"]["input"]>;
  key: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
}

export interface AdminUpsertDocumentStatusTransitionInput {
  createsVersion?: InputMaybe<Scalars["String"]["input"]>;
  dateEnforcement?: InputMaybe<Scalars["String"]["input"]>;
  fromStatusId: Scalars["ID"]["input"];
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  requiredMetadataFields?: InputMaybe<Array<Scalars["String"]["input"]>>;
  requiredRoles?: InputMaybe<Array<Scalars["String"]["input"]>>;
  setsVersionKind?: InputMaybe<Scalars["String"]["input"]>;
  toStatusId: Scalars["ID"]["input"];
}

export interface AdminUpsertDocumentStatusValueInput {
  color?: InputMaybe<Scalars["String"]["input"]>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  icon?: InputMaybe<Scalars["String"]["input"]>;
  id?: InputMaybe<Scalars["ID"]["input"]>;
  isActive?: InputMaybe<Scalars["Boolean"]["input"]>;
  key: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  okfStatus?: InputMaybe<Scalars["String"]["input"]>;
  schemaId: Scalars["ID"]["input"];
  sortOrder?: InputMaybe<Scalars["Int"]["input"]>;
  terminal?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface AdminUpsertDocumentTypeInput {
  color?: InputMaybe<Scalars["String"]["input"]>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  icon?: InputMaybe<Scalars["String"]["input"]>;
  id?: InputMaybe<Scalars["ID"]["input"]>;
  isActive?: InputMaybe<Scalars["Boolean"]["input"]>;
  isSuggested?: InputMaybe<Scalars["Boolean"]["input"]>;
  key: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
}

export interface AdminUpsertDocumentVersionPolicyInput {
  autoVersionOn?: InputMaybe<Array<Scalars["String"]["input"]>>;
  customPattern?: InputMaybe<Scalars["String"]["input"]>;
  enabledByDefault?: InputMaybe<Scalars["Boolean"]["input"]>;
  exportVersionsProtected?: InputMaybe<Scalars["Boolean"]["input"]>;
  id?: InputMaybe<Scalars["ID"]["input"]>;
  isDefault?: InputMaybe<Scalars["Boolean"]["input"]>;
  metadataSchema?: InputMaybe<Scalars["JSON"]["input"]>;
  name: Scalars["String"]["input"];
  pinManualVersions?: InputMaybe<Scalars["Boolean"]["input"]>;
  pinPublishVersions?: InputMaybe<Scalars["Boolean"]["input"]>;
  publishedVersionsProtected?: InputMaybe<Scalars["Boolean"]["input"]>;
  retentionCount?: InputMaybe<Scalars["Int"]["input"]>;
  schemePreset?: InputMaybe<Scalars["String"]["input"]>;
  scope: Scalars["String"]["input"];
  timezoneMode?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface AdminWorkspaceOwnerType {
  __typename?: "AdminWorkspaceOwnerType";
  avatarUrl: Maybe<Scalars["String"]["output"]>;
  email: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
}

export interface AdminWorkspaceSharedLinkType {
  __typename?: "AdminWorkspaceSharedLinkType";
  docId: Scalars["String"]["output"];
  publicMode: Scalars["String"]["output"];
  publishedAt: Maybe<Scalars["DateTime"]["output"]>;
  shareUrl: Scalars["String"]["output"];
  status: Scalars["String"]["output"];
  title: Maybe<Scalars["String"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

/**
 * Sort options for the admin workspace list.
 *
 * Uses `PascalCase` serialization to match the generated TypeScript
 * generated `AdminWorkspaceSort` client enum.
 */
export enum AdminWorkspaceSort {
  BlobCount = "BlobCount",
  BlobSize = "BlobSize",
  CreatedAt = "CreatedAt",
  MemberCount = "MemberCount",
  PublicPageCount = "PublicPageCount",
  SnapshotCount = "SnapshotCount",
  SnapshotSize = "SnapshotSize",
}

export interface AdminWorkspaceType {
  __typename?: "AdminWorkspaceType";
  avatarKey: Maybe<Scalars["String"]["output"]>;
  blobCount: Scalars["Int"]["output"];
  blobSize: Scalars["Int"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  enableAi: Scalars["Boolean"]["output"];
  enableDocEmbedding: Scalars["Boolean"]["output"];
  enableSharing: Scalars["Boolean"]["output"];
  enableUrlPreview: Scalars["Boolean"]["output"];
  features: Array<FeatureType>;
  /** Whether this workspace has an active Git Sync profile. */
  gitSyncEnabled: Scalars["Boolean"]["output"];
  /** Timestamp of the latest Git Sync run for this workspace. */
  gitSyncLastRunAt: Maybe<Scalars["DateTime"]["output"]>;
  /** Last Git Sync run status (Completed/Failed/Running/null). */
  gitSyncLastStatus: Maybe<Scalars["String"]["output"]>;
  gitSyncNextScheduledAt: Maybe<Scalars["DateTime"]["output"]>;
  /** ID of the active Git Sync profile for this workspace. */
  gitSyncProfileId: Maybe<Scalars["String"]["output"]>;
  gitSyncTokenRotationEnabled: Maybe<Scalars["Boolean"]["output"]>;
  gitSyncTokenRotationProvider: Maybe<GitTokenRotationProvider>;
  gitSyncTokenRotationState: Maybe<GitTokenRotationState>;
  gitSyncTriggerMode: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  /** Whether this is the user's single canonical personal userspace. */
  isPersonal: Scalars["Boolean"]["output"];
  memberCount: Scalars["Int"]["output"];
  members: Array<InviteUserType>;
  name: Maybe<Scalars["String"]["output"]>;
  owner: Maybe<AdminWorkspaceOwnerType>;
  ownerPrincipalId: Maybe<Scalars["String"]["output"]>;
  ownerPrincipalName: Maybe<Scalars["String"]["output"]>;
  ownerPrincipalType: Scalars["String"]["output"];
  public: Scalars["Boolean"]["output"];
  publicPageCount: Scalars["Int"]["output"];
  sharedLinks: Array<AdminWorkspaceSharedLinkType>;
  snapshotCount: Scalars["Int"]["output"];
  snapshotSize: Scalars["Int"]["output"];
  /** Per-workspace storage quota override in bytes. NULL = inherit from global default. */
  storageQuotaBytes: Maybe<Scalars["Int"]["output"]>;
  /** Total storage used by this workspace (snapshot_size + blob_size) in bytes. */
  storageQuotaUsed: Scalars["Int"]["output"];
  /** Computed workspace type: "Personal", "UserOwned", or "Shared". */
  workspaceType: Scalars["String"]["output"];
}

export interface AdminWorkspaceTypeMembersArgs {
  query?: InputMaybe<Scalars["String"]["input"]>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface AggregateBucketHitsObjectType {
  __typename?: "AggregateBucketHitsObjectType";
  nodes: Array<SearchNodeObjectType>;
}

export interface AggregateBucketObjectType {
  __typename?: "AggregateBucketObjectType";
  count: Scalars["Int"]["output"];
  hits: AggregateBucketHitsObjectType;
  key: Scalars["String"]["output"];
}

export interface AggregateHitsOptionsInputType {
  highlights?: InputMaybe<Array<SearchHighlightInputType>>;
  pagination?: InputMaybe<AggregateHitsPaginationInputType>;
}

export interface AggregateHitsPaginationInputType {
  cursor?: InputMaybe<Scalars["String"]["input"]>;
  limit?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface AggregateInput {
  options: AggregateOptionsInputType;
  query: SearchQueryInputType;
}

export interface AggregateOptionsInputType {
  hits: AggregateHitsOptionsInputType;
}

export interface AggregateResultObjectType {
  __typename?: "AggregateResultObjectType";
  buckets: Array<AggregateBucketObjectType>;
  pagination: SearchResultPaginationType;
}

export enum AiJobStatus {
  Failed = "Failed",
  Finished = "Finished",
  Pending = "Pending",
  Running = "Running",
}

export interface AlreadyInSpaceDataType {
  __typename?: "AlreadyInSpaceDataType";
  spaceId: Scalars["String"]["output"];
}

export interface ApiKeyMutationRoot {
  __typename?: "ApiKeyMutationRoot";
  /**
   * Create a new MCP API key for the current user.
   *
   * The returned `key` field contains the plaintext key; it is shown only once.
   * Supported scopes: `read:workspaces`, `write:workspaces`, `read:docs`, `write:docs`,
   * `read:databases`, `write:databases`, `read:document_graph`,
   * `read:templates`, `read:automations`, `write:automations`, `read:organization`,
   * `write:organization`, `read:users`, `write:users`, `read:calendar`, `write:calendar`. User and organization
   * scopes are reserved for active global administrators and are rechecked on
   * every tool call.
   *
   * Database access uses the canonical `read:databases` and
   * `write:databases` scopes. Older pre-P-DB-01 Database scope names are not
   * accepted after the naming cleanup.
   */
  createApiKey: CreatedApiKeyType;
  /** Revoke (delete) an API key. */
  revokeApiKey: Scalars["Boolean"]["output"];
}

export interface ApiKeyMutationRootCreateApiKeyArgs {
  expiresInDays?: InputMaybe<Scalars["Int"]["input"]>;
  name: Scalars["String"]["input"];
  scopes: Array<Scalars["String"]["input"]>;
}

export interface ApiKeyMutationRootRevokeApiKeyArgs {
  id: Scalars["String"]["input"];
}

export interface ApiKeyQueryRoot {
  __typename?: "ApiKeyQueryRoot";
  /** List all API keys for the current user. */
  listApiKeys: Array<ApiKeyType>;
}

/** GraphQL output type for an API key (without the secret). */
export interface ApiKeyType {
  __typename?: "ApiKeyType";
  createdAt: Scalars["DateTime"]["output"];
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["String"]["output"];
  lastUsedAt: Maybe<Scalars["DateTime"]["output"]>;
  name: Scalars["String"]["output"];
  scopes: Array<Scalars["String"]["output"]>;
}

export interface ApiMutationRoot {
  __typename?: "ApiMutationRoot";
  abortBlobUpload: Scalars["Boolean"]["output"];
  acceptInviteById: Scalars["Boolean"]["output"];
  acceptWorkspaceInvite: Scalars["Boolean"]["output"];
  activateLicense: LicenseType;
  addContextBlob: CopilotContextBlob;
  addContextCategory: CopilotContextCategory;
  addContextDoc: CopilotContextDoc;
  addContextFile: CopilotContextFile;
  /**
   * Manager-scoped: add (or update) an OU member's role. Anti-escalation
   * rules apply (no `manager` role, no admin escalation).
   */
  addOrganizationUnitMemberAsManager: OrganizationUnitMemberType;
  addWorkspaceEmbeddingFiles: CopilotWorkspaceFile;
  /** Admin operations sub-root. All admin mutations are accessible via this field. */
  admin: AdminRoot;
  /** Adopt a copilot-generated blob into the workspace blob store (root-level alias). */
  adoptCopilotBlob: Scalars["String"]["output"];
  /** MCP API key management mutations. */
  apiKeys: ApiKeyMutationRoot;
  applyContextDocuments: ContextDocuments;
  applyDocUpdates: Scalars["String"]["output"];
  applyLegacyDatabaseMigration: LegacyDatabaseMigrationApplyObjectType;
  applyWorkspaceImport: WorkspaceImportType;
  approveMember: Scalars["Boolean"]["output"];
  archiveWorkspaceTag: WorkspaceTag;
  attachDatabaseRowContentDocument: DatabaseRowRecord;
  auth: MutationRoot;
  bootstrapWorkspaceTags: WorkspaceTagBootstrapResultObjectType;
  bulkApplyDatabaseCellPatches: DatabaseBulkOperationResult;
  bulkClearDatabaseCellValue: DatabaseBulkOperationResult;
  bulkDeleteDatabaseRows: DatabaseBulkOperationResult;
  bulkRestoreDatabaseRows: DatabaseBulkOperationResult;
  bulkSetDatabaseCellValue: DatabaseBulkOperationResult;
  bulkUpdateDatabaseRowPositions: DatabaseBulkOperationResult;
  /** Manager cancels their own pending project request. */
  cancelOrganizationProjectRequest: Scalars["Boolean"]["output"];
  /** Cancel a queued PDF export job as the requester or as an admin. */
  cancelPdfExportJob: Scalars["Boolean"]["output"];
  cancelSubscription: SubscriptionType;
  /** Cancel an actor-owned XWS operation before canonical publication. */
  cancelWorkspaceContentOperation: WorkspaceContentOperationType;
  cancelWorkspaceImport: WorkspaceImportType;
  /** Create a named document version from the current document state. */
  captureDocumentHistory: DocumentHistoryCaptureType;
  changeEmail: UserType;
  changePassword: Scalars["Boolean"]["output"];
  claimAudioTranscription: TranscriptionResultType;
  cleanupCopilotSession: Array<Scalars["String"]["output"]>;
  clearDatabaseCellValue: DatabaseCellRevisionType;
  completeBlobUpload: Scalars["String"]["output"];
  completeWorkspaceImportUpload: WorkspaceImportType;
  configureDocumentReviewPlanning: DocumentReviewPlanningType;
  configureTaskMaintenance: TaskPreparationConfiguration;
  configureTaskPreparation: TaskPreparationConfiguration;
  configureTaskRecurrence: TaskRecurrence;
  confirmTaskCorrections: TaskMaintenance;
  controlWorkspaceEventRecurrence: CalendarEventType;
  /** Create a new MCP API key (root-level alias). */
  createApiKey: CreatedApiKeyType;
  createBlobUpload: BlobUploadInitType;
  createCheckoutSession: Scalars["String"]["output"];
  createComment: CommentObjectType;
  createCopilotContext: Scalars["String"]["output"];
  createCopilotMessage: Scalars["String"]["output"];
  createCopilotSession: Scalars["String"]["output"];
  createCopilotSessionWithHistory: CopilotHistories;
  createCustomerPortal: Scalars["String"]["output"];
  createDatabase: DatabaseRecord;
  createDatabaseField: DatabaseFieldType;
  createDatabaseFromTemplate: DatabaseRecord;
  createDatabaseRow: DatabaseRowRecord;
  createDatabaseRowContentDocument: DatabaseRowRecord;
  createDatabaseRowFromTemplate: DatabaseRowRecord;
  createDatabaseRowTemplate: DatabaseRowTemplateBinding;
  createDatabaseTaskFromSource: DatabaseTaskCaptureResult;
  createDatabaseView: DatabaseViewType;
  /** Create a named document version from the current document state. */
  createDocumentVersion: DocumentVersionType;
  /** Create a workspace event tag (INV-CAL-TAG-01). */
  createEventTag: CalendarEventTagType;
  /**
   * Create a Git Sync profile for a workspace.
   *
   * Requires workspace admin/owner permission. Existing profiles are changed
   * only through the partial-update mutation so their identity and history
   * cannot be replaced accidentally.
   */
  createGitSyncProfile: GitSyncProfileType;
  createInviteLink: InviteLink;
  /**
   * Manager-scoped project creation. Routes through the policy gate;
   * see `OrganizationManagerMutationRoot` for the three-state outcome.
   */
  createOrganizationProject: OrganizationProjectCreationResult;
  createProject: DatabaseRecord;
  createReply: ReplyObjectType;
  createSelfhostWorkspaceCustomerPortal: Scalars["String"]["output"];
  createWorkspace: WorkspaceType;
  createWorkspaceAutomation: WorkspaceAutomationType;
  /** Create a workspace-native calendar event (INV-CAL-NATIVE-03). */
  createWorkspaceEvent: CalendarEventType;
  createWorkspaceImportUpload: WorkspaceImportUploadType;
  /**
   * Manager-scoped workspace creation inside a specific OU. Combines
   * the workspace-creation flow with an `owner` link in the OU.
   */
  createWorkspaceInOrganizationUnit: WorkspaceType;
  createWorkspaceInviteLink: WorkspaceInviteLinkType;
  createWorkspaceTag: WorkspaceTag;
  deactivateLicense: Scalars["Boolean"]["output"];
  decideDocumentReview: DocumentReview;
  deleteAccount: DeleteAccount;
  deleteAssistantSetup: UserPreferencesType;
  deleteBlob: Scalars["Boolean"]["output"];
  /** Delete a calendar event by ID (P90-CAL-E-08). */
  deleteCalendarEvent: Scalars["Boolean"]["output"];
  /** Delete a calendar event instance (P90-CAL-I-05). */
  deleteCalendarEventInstance: Scalars["Boolean"]["output"];
  deleteComment: Scalars["Boolean"]["output"];
  /** P-DB-27: delete a saved CSV mapping template by name. */
  deleteDatabaseCsvMappingTemplate: Scalars["Boolean"]["output"];
  deleteDatabaseField: Scalars["Boolean"]["output"];
  deleteDatabasePermanently: Scalars["Boolean"]["output"];
  deleteDatabaseRow: Scalars["Boolean"]["output"];
  deleteDatabaseRowReminder: Scalars["Boolean"]["output"];
  deleteDatabaseRowTemplate: Scalars["Boolean"]["output"];
  deleteDatabaseView: Scalars["Boolean"]["output"];
  deleteDocumentPermanently: DeleteDocumentsPermanentlyPayload;
  /** Delete a non-pinned named document version. */
  deleteDocumentVersion: Scalars["Boolean"]["output"];
  deleteDocumentsPermanently: DeleteDocumentsPermanentlyPayload;
  /** Delete a workspace event tag (events lose their tag via FK SET NULL). */
  deleteEventTag: Scalars["Boolean"]["output"];
  /**
   * Delete a Git Sync profile.
   *
   * Cascades to all bindings, runs, conflicts, credentials, and baselines.
   * Requires workspace admin/owner permission.
   */
  deleteGitSyncProfile: Scalars["Boolean"]["output"];
  /** Admin-only: delete a persisted Git-Sync SSH host key pin. */
  deleteGitSyncSshHostKey: Scalars["Boolean"]["output"];
  deleteReply: Scalars["Boolean"]["output"];
  deleteWorkspace: Scalars["Boolean"]["output"];
  /** Delete a workspace-native calendar event (INV-CAL-NATIVE-02). */
  deleteWorkspaceEvent: Scalars["Boolean"]["output"];
  deleteWorkspaceTagPermanently: Scalars["Boolean"]["output"];
  detachDatabaseRowContentDocument: DatabaseRowRecord;
  /** Admin-only: disable a persisted Git-Sync SSH host key without deleting audit context. */
  disableGitSyncSshHostKey: Scalars["Boolean"]["output"];
  disableWorkspaceAutomation: WorkspaceAutomationType;
  emptyWorkspaceTrash: DeleteDocumentsPermanentlyPayload;
  endTaskRecurrence: TaskRecurrence;
  /** Explicit, independently gated generation; never submits or retries speech. */
  enrichAudioTranscription: TranscriptionEnrichmentType;
  /** Execute exactly the current XWS preflight revision. */
  executeWorkspaceContentOperation: WorkspaceContentOperationType;
  exportCopilotMessage: CopilotGeneratedFileType;
  exportDatabaseCsv: DatabaseCsvExport;
  exportDatabaseJson: DatabaseJsonExport;
  /**
   * V2 export mutation (`P-PDF-TPL-11-{01,02}`). Accepts the full L3
   * shape (locale, paper_size, image_quality, cover_page, toc_behavior,
   * confidentiality_label, typed_inputs); runs the manifest-driven
   * capability validator before dispatch and refuses
   * off-capability inputs with `extensions.class = "CapabilityViolation"`.
   */
  exportPdf: PdfExportJobType;
  forkCopilotSession: Scalars["String"]["output"];
  generateLicenseKey: Scalars["String"]["output"];
  generateUserAccessToken: RevealedAccessToken;
  /** Preview the exact cascade impact without modifying profile state. */
  gitSyncProfileDeleteImpact: GitSyncDeleteImpactType;
  grantDocUserRoles: Scalars["Boolean"]["output"];
  grantMember: Scalars["Boolean"]["output"];
  importDatabaseCsv: DatabaseCsvImportResult;
  importDatabaseJson: DatabaseJsonImportResult;
  /**
   * P-DB-29: Notion HTML / ZIP apply. Mirrors `importDatabaseJson`
   * but interprets the upload as a Notion export.
   */
  importDatabaseNotion: DatabaseJsonImportResult;
  /** Import events from an ICS blob into a workspace (P-JCAL-SERVER-07-B). */
  importWorkspaceCalendarIcs: CalendarIcsImportResult;
  importWorkspaceTags: WorkspaceTagTransfer;
  installLicense: LicenseType;
  inviteMembers: Array<InviteResult>;
  /** P100-SRV-F-02: Invite an existing server user by user ID. */
  inviteServerUserById: Scalars["String"]["output"];
  leaveWorkspace: Scalars["Boolean"]["output"];
  linkCalDAVAccount: CalendarAccountObjectType;
  linkCalendarAccount: Scalars["String"]["output"];
  /** P-DB-27: load a saved CSV mapping template by name. */
  loadDatabaseCsvMappingTemplate: Maybe<DatabaseCsvMappingTemplate>;
  markAllCommentThreadsRead: Scalars["Int"]["output"];
  markCommentThreadRead: Scalars["Boolean"]["output"];
  mentionUser: Scalars["ID"]["output"];
  moveDatabaseTasks: DatabaseTaskMoveResult;
  /** Attach a name to an existing immutable document history state. */
  nameDocumentHistoryState: DocumentVersionType;
  pauseTaskRecurrence: TaskRecurrence;
  /** Pin a named document version. */
  pinDocumentVersion: DocumentVersionType;
  previewDatabaseCsvImport: DatabaseCsvPreview;
  previewDatabaseJsonImport: DatabaseJsonPreview;
  /**
   * P-DB-29: Notion HTML / ZIP preview. Same input shape as the JSON
   * preview but the upload is interpreted as a Notion export. The
   * preview returns a [`DatabaseJsonPreviewObjectType`] so the Web
   * UI can render the result through the same modal as JSON imports.
   */
  previewDatabaseNotionImport: DatabaseJsonPreview;
  previewWorkspaceImport: WorkspaceImportType;
  publishDoc: DocType;
  queueWorkspaceEmbedding: Scalars["Boolean"]["output"];
  readAllNotifications: Scalars["Boolean"]["output"];
  readNotification: Scalars["Boolean"]["output"];
  recolorWorkspaceTag: WorkspaceTag;
  recoverDoc: Scalars["DateTime"]["output"];
  refreshUserSubscriptions: Array<SubscriptionType>;
  releaseDeletedBlobs: Scalars["Boolean"]["output"];
  removeAvatar: RemoveAvatar;
  removeContextBlob: Scalars["Boolean"]["output"];
  removeContextCategory: Scalars["Boolean"]["output"];
  removeContextDoc: Scalars["Boolean"]["output"];
  removeContextFile: Scalars["Boolean"]["output"];
  /** Manager-scoped: remove a non-manager OU member. */
  removeOrganizationUnitMemberAsManager: Scalars["Boolean"]["output"];
  removeWorkspaceEmbeddingFiles: Scalars["Boolean"]["output"];
  renameWorkspaceTag: WorkspaceTag;
  reopenComment: CommentType;
  reorderDatabaseFields: Array<DatabaseFieldType>;
  reorderDatabaseViews: Array<DatabaseViewType>;
  reportTemplateBuilderApplied: Scalars["Boolean"]["output"];
  reportTemplateBuilderTrashed: Scalars["Boolean"]["output"];
  requestApplySubscription: Array<SubscriptionType>;
  resetDatabaseViewUserState: Scalars["Boolean"]["output"];
  /** Reset the canonical personal workspace to the inherited server theme. */
  resetPersonalWorkspaceTheme: PersonalWorkspaceThemeSelectionType;
  /** Resolve a calendar conflict (P90-CAL-F-04). */
  resolveCalendarConflict: CalendarEventType;
  resolveComment: Scalars["Boolean"]["output"];
  /**
   * Resolve a Git Sync conflict.
   *
   * Applies the selected document resolution server-side, updates document
   * snapshot/baseline state where required, then marks the conflict resolved.
   * Requires workspace admin/owner permission on the conflict's workspace.
   */
  resolveGitSyncConflict: Scalars["Boolean"]["output"];
  /**
   * Resolve a non-Markdown Git Sync file conflict.
   *
   * File conflicts are resolved server-side because they mutate Git-Sync
   * baseline/binding/blob state. Clients only choose the strategy.
   */
  resolveGitSyncFileConflict: Scalars["Boolean"]["output"];
  restoreDatabase: DatabaseRecord;
  /** Restore a named document version as a new document update and snapshot. */
  restoreDocumentVersion: DocumentVersionType;
  restoreWorkspaceTag: WorkspaceTag;
  resumeSubscription: SubscriptionType;
  resumeTaskRecurrence: TaskRecurrence;
  retryAudioTranscription: TranscriptionResultType;
  retryContextDocuments: ContextDocuments;
  retryContextFile: CopilotContextFile;
  retryDocumentReview: DocumentReview;
  retryTaskHandover: TaskHandover;
  retryTaskMaintenance: TaskMaintenance;
  retryTaskPreparationRun: TaskPreparationRun;
  /** Re-authorize and resume an actor-owned failed XWS operation. */
  retryWorkspaceContentOperation: WorkspaceContentOperationType;
  retryWorkspaceCreation: Maybe<WorkspaceCreationResultType>;
  retryWorkspaceImportCleanup: WorkspaceImportType;
  /** Revoke an MCP API key (root-level alias). */
  revokeApiKey: Scalars["Boolean"]["output"];
  revokeDocUserRoles: Scalars["Boolean"]["output"];
  revokeInviteLink: Scalars["Boolean"]["output"];
  revokeMember: Scalars["Boolean"]["output"];
  revokePublicDoc: DocType;
  revokeUserAccessToken: Scalars["Boolean"]["output"];
  revokeWorkspaceInviteLink: Scalars["Boolean"]["output"];
  saveAssistantSetup: UserPreferencesType;
  /** P-DB-27: save (or update) a CSV mapping template. */
  saveDatabaseCsvMappingTemplate: DatabaseCsvMappingTemplate;
  saveDatabaseViewUserState: DatabaseViewType;
  sendChangeEmail: Scalars["Boolean"]["output"];
  sendChangePasswordEmail: Scalars["Boolean"]["output"];
  sendSetPasswordEmail: Scalars["Boolean"]["output"];
  sendVerifyChangeEmail: Scalars["Boolean"]["output"];
  sendVerifyEmail: Scalars["Boolean"]["output"];
  setBlob: Scalars["String"]["output"];
  setDatabaseRowReminder: DatabaseRowReminder;
  setDocumentMetadata: SetDocumentMetadataPayload;
  setDocumentWorkspaceTags: Array<Scalars["ID"]["output"]>;
  /** Select an existing server-owned theme for the canonical personal workspace. */
  setPersonalWorkspaceTheme: PersonalWorkspaceThemeSelectionType;
  skipTaskRecurrence: TaskRecurrence;
  startDocumentReview: DocumentReview;
  startTaskHandover: TaskHandover;
  startTaskMaintenance: TaskMaintenance;
  stopContextDocuments: ContextDocuments;
  stopDocumentReview: DocumentReview;
  stopProjectSetup: ProjectSetup;
  stopTaskHandover: TaskHandover;
  stopTaskMaintenance: TaskMaintenance;
  stopTaskPreparationRun: TaskPreparationRun;
  stopWorkspaceCreation: Maybe<WorkspaceCreationResultType>;
  submitAudioTranscription: TranscriptionResultType;
  /**
   * Test connection to a Git repository.
   *
   * Attempts to list-remote the repository to verify the URL and
   * credentials are valid. Supports all auth methods: HttpsToken,
   * HttpsPassword, and SshKey. Requires authentication.
   */
  testGitConnection: Scalars["Boolean"]["output"];
  transitionDocumentStatus: TransitionDocumentStatusPayload;
  trashDatabase: DatabaseRecord;
  triggerCleanupTrashedDocEmbeddings: Scalars["Boolean"]["output"];
  triggerGenerateTitleCron: Scalars["Boolean"]["output"];
  /**
   * Trigger a manual sync run.
   *
   * Creates a `Pending` run record and queues a worker job. Requires workspace
   * admin/owner permission.
   */
  triggerGitSync: GitSyncRunType;
  /** Preflight Undo as a separately authorized counter-operation. */
  undoWorkspaceContentOperation: WorkspaceContentPreflightType;
  unlinkCalendarAccount: Scalars["Boolean"]["output"];
  /** Unpin a named document version. */
  unpinDocumentVersion: DocumentVersionType;
  updateCalendarAccount: Maybe<CalendarAccountObjectType>;
  /** Update a single calendar event instance (P90-CAL-I-05). */
  updateCalendarEventInstance: UpdateCalendarEventInstanceResult;
  /**
   * Update the RSVP status of the current user for a calendar event
   * (P90-CAL-H-04).
   */
  updateCalendarEventRsvp: CalendarEventType;
  updateCalendarReminderStatus: CalendarReminderStatusResult;
  updateComment: Scalars["Boolean"]["output"];
  updateCopilotSession: Scalars["String"]["output"];
  updateDatabase: DatabaseRecord;
  updateDatabaseCellValue: DatabaseCellValueType;
  updateDatabaseField: DatabaseFieldType;
  updateDatabaseRowPosition: DatabaseRowRecord;
  updateDatabaseRowTemplate: DatabaseRowTemplateBinding;
  updateDatabaseRowTitle: DatabaseCellValueType;
  updateDatabaseView: DatabaseViewType;
  updateDocDefaultRole: Scalars["Boolean"]["output"];
  updateDocUserRole: Scalars["Boolean"]["output"];
  /** Update a named document version's mutable label/description metadata. */
  updateDocumentVersion: DocumentVersionType;
  /** Update per-document versioning settings. */
  updateDocumentVersioningSettings: DocumentVersioningSettingsType;
  /** Update a workspace event tag. */
  updateEventTag: CalendarEventTagType;
  /**
   * Partially update a Git-Sync profile while preserving profile identity and
   * history. A replacement credential is atomically rotated when present.
   */
  updateGitSyncProfile: GitSyncProfileType;
  updatePreferences: UserPreferencesType;
  updateProfile: UserType;
  updateReply: Scalars["Boolean"]["output"];
  updateSubscriptionRecurring: SubscriptionType;
  updateTaskRecurrence: TaskRecurrence;
  updateWorkspace: WorkspaceType;
  /** Update workspace-level calendar settings (writeback target + default reminder). */
  updateWorkspaceCalendarSettings: WorkspaceCalendarSettingsType;
  updateWorkspaceCalendars: WorkspaceCalendarObjectType;
  updateWorkspaceDocumentSettings: WorkspaceDocumentSettingsType;
  updateWorkspaceEmbeddingIgnoredDocs: Scalars["Int"]["output"];
  /**
   * Update a workspace-native calendar event.
   *
   * `scope=All` edits the master; `scope=This` creates an EXDATE+override.
   * Returns FORBIDDEN for external events (INV-CAL-NATIVE-02).
   */
  updateWorkspaceEvent: CalendarEventType;
  updateWorkspaceHistorySettings: WorkspaceHistorySettingsType;
  updateWorkspaceTagDescription: WorkspaceTag;
  uploadAvatar: UserType;
  uploadCommentAttachment: Scalars["String"]["output"];
  upsertCalendarEvent: CalendarEventType;
  upsertDatabaseViewUserState: DatabaseViewUserStateType;
  verifyEmail: Scalars["Boolean"]["output"];
  /** Build and persist one server-authoritative XWS preflight. */
  workspaceContentPreflight: WorkspaceContentPreflightType;
  workspaceTemplateReconcileSlugs: Array<BuiltinReconcileEntryType>;
}

export interface ApiMutationRootAbortBlobUploadArgs {
  key: Scalars["String"]["input"];
  uploadId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootAcceptInviteByIdArgs {
  inviteId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootAcceptWorkspaceInviteArgs {
  inviteId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootActivateLicenseArgs {
  license: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootAddContextBlobArgs {
  options: AddContextBlobInput;
}

export interface ApiMutationRootAddContextCategoryArgs {
  options: AddContextCategoryInput;
}

export interface ApiMutationRootAddContextDocArgs {
  options: AddContextDocInput;
}

export interface ApiMutationRootAddContextFileArgs {
  content: Scalars["Upload"]["input"];
  options: AddContextFileInput;
}

export interface ApiMutationRootAddOrganizationUnitMemberAsManagerArgs {
  role: OrganizationUnitRoleEnum;
  unitId: Scalars["ID"]["input"];
  userId: Scalars["ID"]["input"];
}

export interface ApiMutationRootAddWorkspaceEmbeddingFilesArgs {
  blob: Scalars["Upload"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootAdoptCopilotBlobArgs {
  copilotBlobKey: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootApplyContextDocumentsArgs {
  input: ApplyContextDocumentsInput;
}

export interface ApiMutationRootApplyDocUpdatesArgs {
  docId: Scalars["String"]["input"];
  op: Scalars["String"]["input"];
  updates: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootApplyLegacyDatabaseMigrationArgs {
  input: LegacyDatabaseMigrationInput;
}

export interface ApiMutationRootApplyWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface ApiMutationRootApproveMemberArgs {
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootArchiveWorkspaceTagArgs {
  input: WorkspaceTagLifecycleInput;
}

export interface ApiMutationRootAttachDatabaseRowContentDocumentArgs {
  input: AttachDatabaseRowContentDocumentInput;
}

export interface ApiMutationRootBootstrapWorkspaceTagsArgs {
  input: BootstrapWorkspaceTagsInput;
}

export interface ApiMutationRootBulkApplyDatabaseCellPatchesArgs {
  input: BulkApplyDatabaseCellPatchesInput;
}

export interface ApiMutationRootBulkClearDatabaseCellValueArgs {
  input: BulkClearDatabaseCellValueInput;
}

export interface ApiMutationRootBulkDeleteDatabaseRowsArgs {
  input: BulkDeleteDatabaseRowsInput;
}

export interface ApiMutationRootBulkRestoreDatabaseRowsArgs {
  input: BulkRestoreDatabaseRowsInput;
}

export interface ApiMutationRootBulkSetDatabaseCellValueArgs {
  input: BulkSetDatabaseCellValueInput;
}

export interface ApiMutationRootBulkUpdateDatabaseRowPositionsArgs {
  input: BulkUpdateDatabaseRowPositionsInput;
}

export interface ApiMutationRootCancelOrganizationProjectRequestArgs {
  id: Scalars["ID"]["input"];
}

export interface ApiMutationRootCancelPdfExportJobArgs {
  jobId: Scalars["String"]["input"];
}

export interface ApiMutationRootCancelSubscriptionArgs {
  idempotencyKey?: InputMaybe<Scalars["String"]["input"]>;
  plan?: InputMaybe<SubscriptionPlanType>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootCancelWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface ApiMutationRootCancelWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface ApiMutationRootCaptureDocumentHistoryArgs {
  description?: InputMaybe<Scalars["String"]["input"]>;
  docId: Scalars["ID"]["input"];
  name?: InputMaybe<Scalars["String"]["input"]>;
  requestKey: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootChangeEmailArgs {
  email: Scalars["String"]["input"];
  token: Scalars["String"]["input"];
}

export interface ApiMutationRootChangePasswordArgs {
  newPassword: Scalars["String"]["input"];
  token: Scalars["String"]["input"];
  userId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootClaimAudioTranscriptionArgs {
  jobId: Scalars["String"]["input"];
}

export interface ApiMutationRootCleanupCopilotSessionArgs {
  options: DeleteSessionInput;
}

export interface ApiMutationRootClearDatabaseCellValueArgs {
  input: ClearDatabaseCellValueInput;
}

export interface ApiMutationRootCompleteBlobUploadArgs {
  key: Scalars["String"]["input"];
  parts?: InputMaybe<Array<BlobUploadPartInput>>;
  uploadId?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCompleteWorkspaceImportUploadArgs {
  sourceHash: Scalars["String"]["input"];
  sourceSizeBytes: Scalars["Int"]["input"];
  workspaceImportId: Scalars["ID"]["input"];
}

export interface ApiMutationRootConfigureDocumentReviewPlanningArgs {
  docId: Scalars["ID"]["input"];
  enabled: Scalars["Boolean"]["input"];
  expectedMetadataRevision: Scalars["Int"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootConfigureTaskMaintenanceArgs {
  input: ConfigureTaskPreparationInput;
}

export interface ApiMutationRootConfigureTaskPreparationArgs {
  input: ConfigureTaskPreparationInput;
}

export interface ApiMutationRootConfigureTaskRecurrenceArgs {
  input: ConfigureTaskRecurrenceInput;
}

export interface ApiMutationRootConfirmTaskCorrectionsArgs {
  input: ConfirmTaskCorrectionsInput;
}

export interface ApiMutationRootControlWorkspaceEventRecurrenceArgs {
  action: CalendarTimingAction;
  eventId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateApiKeyArgs {
  expiresInDays?: InputMaybe<Scalars["Int"]["input"]>;
  name: Scalars["String"]["input"];
  scopes: Array<Scalars["String"]["input"]>;
}

export interface ApiMutationRootCreateBlobUploadArgs {
  key: Scalars["String"]["input"];
  mime: Scalars["String"]["input"];
  size: Scalars["Int"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateCheckoutSessionArgs {
  input: CreateCheckoutSessionInput;
}

export interface ApiMutationRootCreateCommentArgs {
  attachmentKeys?: InputMaybe<Array<Scalars["String"]["input"]>>;
  body?: InputMaybe<Scalars["JSON"]["input"]>;
  docId?: InputMaybe<Scalars["String"]["input"]>;
  docText?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<CommentCreateInput>;
  parentCommentId?: InputMaybe<Scalars["String"]["input"]>;
  selectionAnchor?: InputMaybe<SelectionAnchorInput>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootCreateCopilotContextArgs {
  sessionId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateCopilotMessageArgs {
  options: CreateChatMessageInput;
}

export interface ApiMutationRootCreateCopilotSessionArgs {
  options: CreateChatSessionInput;
}

export interface ApiMutationRootCreateCopilotSessionWithHistoryArgs {
  options: CreateChatSessionInput;
}

export interface ApiMutationRootCreateDatabaseArgs {
  input: CreateDatabaseInput;
}

export interface ApiMutationRootCreateDatabaseFieldArgs {
  input: CreateDatabaseFieldInput;
}

export interface ApiMutationRootCreateDatabaseFromTemplateArgs {
  input: CreateDatabaseFromTemplateInput;
}

export interface ApiMutationRootCreateDatabaseRowArgs {
  input: CreateDatabaseRowInput;
}

export interface ApiMutationRootCreateDatabaseRowContentDocumentArgs {
  input: CreateDatabaseRowContentDocumentInput;
}

export interface ApiMutationRootCreateDatabaseRowFromTemplateArgs {
  input: CreateDatabaseRowFromTemplateInput;
}

export interface ApiMutationRootCreateDatabaseRowTemplateArgs {
  input: CreateDatabaseRowTemplateInput;
}

export interface ApiMutationRootCreateDatabaseTaskFromSourceArgs {
  input: CreateDatabaseTaskFromSourceInput;
}

export interface ApiMutationRootCreateDatabaseViewArgs {
  input: CreateDatabaseViewInput;
}

export interface ApiMutationRootCreateDocumentVersionArgs {
  description?: InputMaybe<Scalars["String"]["input"]>;
  docId: Scalars["ID"]["input"];
  label: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootCreateEventTagArgs {
  input: CreateEventTagInput;
}

export interface ApiMutationRootCreateGitSyncProfileArgs {
  input: GitSyncProfileInput;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateInviteLinkArgs {
  expireTime: WorkspaceInviteLinkExpireTime;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateOrganizationProjectArgs {
  input: CreateOrganizationProjectInput;
}

export interface ApiMutationRootCreateProjectArgs {
  input: CreateProjectInput;
}

export interface ApiMutationRootCreateReplyArgs {
  input: ReplyCreateInput;
}

export interface ApiMutationRootCreateSelfhostWorkspaceCustomerPortalArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateWorkspaceArgs {
  init?: InputMaybe<Scalars["Upload"]["input"]>;
  input?: InputMaybe<CreateWorkspaceInput>;
}

export interface ApiMutationRootCreateWorkspaceAutomationArgs {
  input: CreateWorkspaceAutomationInput;
}

export interface ApiMutationRootCreateWorkspaceEventArgs {
  input: CreateWorkspaceEventInput;
}

export interface ApiMutationRootCreateWorkspaceImportUploadArgs {
  parts: Array<WorkspaceImportPartManifestInput>;
  sourceFormat?: InputMaybe<WorkspaceImportSourceFormatInput>;
  sourceHash: Scalars["String"]["input"];
  sourceSizeBytes: Scalars["Int"]["input"];
}

export interface ApiMutationRootCreateWorkspaceInOrganizationUnitArgs {
  input: CreateWorkspaceInOrganizationUnitInput;
}

export interface ApiMutationRootCreateWorkspaceInviteLinkArgs {
  expireTime: Scalars["Float"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootCreateWorkspaceTagArgs {
  input: CreateWorkspaceTagInput;
}

export interface ApiMutationRootDeactivateLicenseArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootDecideDocumentReviewArgs {
  input: DecideDocumentReviewInput;
}

export interface ApiMutationRootDeleteAssistantSetupArgs {
  expectedUserId: Scalars["ID"]["input"];
  id: Scalars["ID"]["input"];
}

export interface ApiMutationRootDeleteBlobArgs {
  hash?: InputMaybe<Scalars["String"]["input"]>;
  key?: InputMaybe<Scalars["String"]["input"]>;
  permanently?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteCalendarEventArgs {
  eventId: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteCalendarEventInstanceArgs {
  eventId: Scalars["String"]["input"];
  instanceStart: Scalars["DateTime"]["input"];
  scope: InstanceEditScope;
}

export interface ApiMutationRootDeleteCommentArgs {
  id: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteDatabaseCsvMappingTemplateArgs {
  input: DeleteDatabaseCsvMappingTemplateInput;
}

export interface ApiMutationRootDeleteDatabaseFieldArgs {
  input: DeleteDatabaseFieldInput;
}

export interface ApiMutationRootDeleteDatabasePermanentlyArgs {
  input: DatabaseLifecycleInput;
}

export interface ApiMutationRootDeleteDatabaseRowArgs {
  input: DeleteDatabaseRowInput;
}

export interface ApiMutationRootDeleteDatabaseRowReminderArgs {
  input: DeleteDatabaseRowReminderInput;
}

export interface ApiMutationRootDeleteDatabaseRowTemplateArgs {
  input: DeleteDatabaseRowTemplateInput;
}

export interface ApiMutationRootDeleteDatabaseViewArgs {
  input: DeleteDatabaseViewInput;
}

export interface ApiMutationRootDeleteDocumentPermanentlyArgs {
  input: DeleteDocumentPermanentlyInput;
}

export interface ApiMutationRootDeleteDocumentVersionArgs {
  id: Scalars["ID"]["input"];
}

export interface ApiMutationRootDeleteDocumentsPermanentlyArgs {
  input: DeleteDocumentsPermanentlyInput;
}

export interface ApiMutationRootDeleteEventTagArgs {
  tagId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteGitSyncProfileArgs {
  profileId: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteGitSyncSshHostKeyArgs {
  host: Scalars["String"]["input"];
  keyType: Scalars["String"]["input"];
  port: Scalars["Int"]["input"];
}

export interface ApiMutationRootDeleteReplyArgs {
  id: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteWorkspaceArgs {
  id: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteWorkspaceEventArgs {
  eventId: Scalars["String"]["input"];
  instanceStart?: InputMaybe<Scalars["DateTime"]["input"]>;
  scope: NativeEventScope;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootDeleteWorkspaceTagPermanentlyArgs {
  input: WorkspaceTagLifecycleInput;
}

export interface ApiMutationRootDetachDatabaseRowContentDocumentArgs {
  input: DetachDatabaseRowContentDocumentInput;
}

export interface ApiMutationRootDisableGitSyncSshHostKeyArgs {
  host: Scalars["String"]["input"];
  keyType: Scalars["String"]["input"];
  port: Scalars["Int"]["input"];
}

export interface ApiMutationRootDisableWorkspaceAutomationArgs {
  input: DisableWorkspaceAutomationInput;
}

export interface ApiMutationRootEmptyWorkspaceTrashArgs {
  input: EmptyWorkspaceTrashInput;
}

export interface ApiMutationRootEndTaskRecurrenceArgs {
  input: TaskRecurrenceControlInput;
}

export interface ApiMutationRootEnrichAudioTranscriptionArgs {
  actions: Scalars["Boolean"]["input"];
  jobId: Scalars["String"]["input"];
  summary: Scalars["Boolean"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootExecuteWorkspaceContentOperationArgs {
  input: WorkspaceContentExecuteInput;
}

export interface ApiMutationRootExportCopilotMessageArgs {
  format: CopilotExportFormat;
  messageId: Scalars["ID"]["input"];
}

export interface ApiMutationRootExportDatabaseCsvArgs {
  input: ExportDatabaseCsvInput;
}

export interface ApiMutationRootExportDatabaseJsonArgs {
  input: ExportDatabaseJsonInput;
}

export interface ApiMutationRootExportPdfArgs {
  input: PdfExportInputV2Input;
}

export interface ApiMutationRootForkCopilotSessionArgs {
  options: ForkChatSessionInput;
}

export interface ApiMutationRootGenerateLicenseKeyArgs {
  sessionId: Scalars["String"]["input"];
}

export interface ApiMutationRootGenerateUserAccessTokenArgs {
  input: GenerateAccessTokenInput;
}

export interface ApiMutationRootGitSyncProfileDeleteImpactArgs {
  profileId: Scalars["String"]["input"];
}

export interface ApiMutationRootGrantDocUserRolesArgs {
  input: GrantDocUserRolesInput;
}

export interface ApiMutationRootGrantMemberArgs {
  permission: Permission;
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootImportDatabaseCsvArgs {
  file: Scalars["Upload"]["input"];
  input: ImportDatabaseCsvInput;
}

export interface ApiMutationRootImportDatabaseJsonArgs {
  file: Scalars["Upload"]["input"];
  input: ImportDatabaseJsonInput;
}

export interface ApiMutationRootImportDatabaseNotionArgs {
  file: Scalars["Upload"]["input"];
  input: ImportDatabaseJsonInput;
}

export interface ApiMutationRootImportWorkspaceCalendarIcsArgs {
  icsBody: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootImportWorkspaceTagsArgs {
  input: ImportWorkspaceTagsInput;
}

export interface ApiMutationRootInstallLicenseArgs {
  license: Scalars["Upload"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootInviteMembersArgs {
  emails: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootInviteServerUserByIdArgs {
  role?: InputMaybe<Scalars["String"]["input"]>;
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootLeaveWorkspaceArgs {
  sendLeaveMail?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
  workspaceName?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootLinkCalDavAccountArgs {
  input: LinkCalDavAccountInput;
}

export interface ApiMutationRootLinkCalendarAccountArgs {
  input: LinkCalendarAccountInput;
}

export interface ApiMutationRootLoadDatabaseCsvMappingTemplateArgs {
  input: LoadDatabaseCsvMappingTemplateInput;
}

export interface ApiMutationRootMarkAllCommentThreadsReadArgs {
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootMarkCommentThreadReadArgs {
  commentId: Scalars["String"]["input"];
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootMentionUserArgs {
  input: MentionInput;
}

export interface ApiMutationRootMoveDatabaseTasksArgs {
  input: DatabaseTaskMoveInput;
}

export interface ApiMutationRootNameDocumentHistoryStateArgs {
  description?: InputMaybe<Scalars["String"]["input"]>;
  docId: Scalars["ID"]["input"];
  expectedVersionIds: Array<Scalars["ID"]["input"]>;
  historyId: Scalars["ID"]["input"];
  name: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootPauseTaskRecurrenceArgs {
  input: TaskRecurrenceControlInput;
}

export interface ApiMutationRootPinDocumentVersionArgs {
  id: Scalars["ID"]["input"];
}

export interface ApiMutationRootPreviewDatabaseCsvImportArgs {
  file: Scalars["Upload"]["input"];
  input: PreviewDatabaseCsvImportInput;
}

export interface ApiMutationRootPreviewDatabaseJsonImportArgs {
  file: Scalars["Upload"]["input"];
  input: PreviewDatabaseJsonImportInput;
}

export interface ApiMutationRootPreviewDatabaseNotionImportArgs {
  file: Scalars["Upload"]["input"];
  input: PreviewDatabaseJsonImportInput;
}

export interface ApiMutationRootPreviewWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface ApiMutationRootPublishDocArgs {
  docId: Scalars["String"]["input"];
  mode?: InputMaybe<PublicDocMode>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootQueueWorkspaceEmbeddingArgs {
  docId: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootReadNotificationArgs {
  id: Scalars["String"]["input"];
}

export interface ApiMutationRootRecolorWorkspaceTagArgs {
  input: RecolorWorkspaceTagInput;
}

export interface ApiMutationRootRecoverDocArgs {
  expectedRevision?: InputMaybe<Scalars["String"]["input"]>;
  guid: Scalars["String"]["input"];
  snapshotId?: InputMaybe<Scalars["ID"]["input"]>;
  timestamp?: InputMaybe<Scalars["DateTime"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootReleaseDeletedBlobsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRemoveContextBlobArgs {
  options: RemoveContextBlobInput;
}

export interface ApiMutationRootRemoveContextCategoryArgs {
  options: RemoveContextCategoryInput;
}

export interface ApiMutationRootRemoveContextDocArgs {
  options: RemoveContextDocInput;
}

export interface ApiMutationRootRemoveContextFileArgs {
  options: RemoveContextFileInput;
}

export interface ApiMutationRootRemoveOrganizationUnitMemberAsManagerArgs {
  unitId: Scalars["ID"]["input"];
  userId: Scalars["ID"]["input"];
}

export interface ApiMutationRootRemoveWorkspaceEmbeddingFilesArgs {
  fileId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRenameWorkspaceTagArgs {
  input: RenameWorkspaceTagInput;
}

export interface ApiMutationRootReopenCommentArgs {
  commentId: Scalars["String"]["input"];
}

export interface ApiMutationRootReorderDatabaseFieldsArgs {
  input: ReorderDatabaseFieldsInput;
}

export interface ApiMutationRootReorderDatabaseViewsArgs {
  input: ReorderDatabaseViewsInput;
}

export interface ApiMutationRootReportTemplateBuilderAppliedArgs {
  input: ReportBuilderAppliedInput;
}

export interface ApiMutationRootReportTemplateBuilderTrashedArgs {
  slug: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRequestApplySubscriptionArgs {
  transactionId: Scalars["String"]["input"];
}

export interface ApiMutationRootResetDatabaseViewUserStateArgs {
  input: ResetDatabaseViewUserStateInput;
}

export interface ApiMutationRootResetPersonalWorkspaceThemeArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootResolveCalendarConflictArgs {
  baseVersion?: InputMaybe<Scalars["JSON"]["input"]>;
  eventId: Scalars["String"]["input"];
  resolution: ConflictResolution;
}

export interface ApiMutationRootResolveCommentArgs {
  commentId?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<CommentResolveInput>;
}

export interface ApiMutationRootResolveGitSyncConflictArgs {
  input: ResolveConflictInput;
}

export interface ApiMutationRootResolveGitSyncFileConflictArgs {
  input: ResolveFileConflictInput;
}

export interface ApiMutationRootRestoreDatabaseArgs {
  input: DatabaseLifecycleInput;
}

export interface ApiMutationRootRestoreDocumentVersionArgs {
  expectedRevision?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["ID"]["input"];
}

export interface ApiMutationRootRestoreWorkspaceTagArgs {
  input: WorkspaceTagLifecycleInput;
}

export interface ApiMutationRootResumeSubscriptionArgs {
  idempotencyKey?: InputMaybe<Scalars["String"]["input"]>;
  plan?: InputMaybe<SubscriptionPlanType>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootResumeTaskRecurrenceArgs {
  input: TaskRecurrenceControlInput;
}

export interface ApiMutationRootRetryAudioTranscriptionArgs {
  jobId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRetryContextDocumentsArgs {
  input: RetryContextDocumentsInput;
}

export interface ApiMutationRootRetryContextFileArgs {
  options: RemoveContextFileInput;
}

export interface ApiMutationRootRetryDocumentReviewArgs {
  input: DocumentReviewRunInput;
}

export interface ApiMutationRootRetryTaskHandoverArgs {
  input: TaskHandoverRunInput;
}

export interface ApiMutationRootRetryTaskMaintenanceArgs {
  input: TaskMaintenanceRunInput;
}

export interface ApiMutationRootRetryTaskPreparationRunArgs {
  runId: Scalars["ID"]["input"];
}

export interface ApiMutationRootRetryWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface ApiMutationRootRetryWorkspaceCreationArgs {
  input: RetryWorkspaceCreationInput;
}

export interface ApiMutationRootRetryWorkspaceImportCleanupArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface ApiMutationRootRevokeApiKeyArgs {
  id: Scalars["String"]["input"];
}

export interface ApiMutationRootRevokeDocUserRolesArgs {
  input: RevokeDocUserRoleInput;
}

export interface ApiMutationRootRevokeInviteLinkArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRevokeMemberArgs {
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRevokePublicDocArgs {
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootRevokeUserAccessTokenArgs {
  id: Scalars["String"]["input"];
}

export interface ApiMutationRootRevokeWorkspaceInviteLinkArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootSaveAssistantSetupArgs {
  expectedUserId: Scalars["ID"]["input"];
  input: SaveAssistantSetupInput;
}

export interface ApiMutationRootSaveDatabaseCsvMappingTemplateArgs {
  input: SaveDatabaseCsvMappingTemplateInput;
}

export interface ApiMutationRootSaveDatabaseViewUserStateArgs {
  input: SaveDatabaseViewUserStateInput;
}

export interface ApiMutationRootSendChangeEmailArgs {
  callbackUrl: Scalars["String"]["input"];
  email?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootSendChangePasswordEmailArgs {
  callbackUrl?: InputMaybe<Scalars["String"]["input"]>;
  email?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootSendSetPasswordEmailArgs {
  callbackUrl?: InputMaybe<Scalars["String"]["input"]>;
  email?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootSendVerifyChangeEmailArgs {
  callbackUrl: Scalars["String"]["input"];
  email: Scalars["String"]["input"];
  token: Scalars["String"]["input"];
}

export interface ApiMutationRootSendVerifyEmailArgs {
  callbackUrl: Scalars["String"]["input"];
}

export interface ApiMutationRootSetBlobArgs {
  blob: Scalars["Upload"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootSetDatabaseRowReminderArgs {
  input: SetDatabaseRowReminderInput;
}

export interface ApiMutationRootSetDocumentMetadataArgs {
  docId: Scalars["ID"]["input"];
  input: SetDocumentMetadataInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootSetDocumentWorkspaceTagsArgs {
  input: SetDocumentWorkspaceTagsInput;
}

export interface ApiMutationRootSetPersonalWorkspaceThemeArgs {
  input: SetPersonalWorkspaceThemeInput;
}

export interface ApiMutationRootSkipTaskRecurrenceArgs {
  input: SkipTaskRecurrenceInput;
}

export interface ApiMutationRootStartDocumentReviewArgs {
  input: StartDocumentReviewInput;
}

export interface ApiMutationRootStartTaskHandoverArgs {
  input: StartTaskHandoverInput;
}

export interface ApiMutationRootStartTaskMaintenanceArgs {
  input: StartTaskMaintenanceInput;
}

export interface ApiMutationRootStopContextDocumentsArgs {
  input: StopContextDocumentsInput;
}

export interface ApiMutationRootStopDocumentReviewArgs {
  input: DocumentReviewRunInput;
}

export interface ApiMutationRootStopProjectSetupArgs {
  input: StopProjectSetupInput;
}

export interface ApiMutationRootStopTaskHandoverArgs {
  input: TaskHandoverRunInput;
}

export interface ApiMutationRootStopTaskMaintenanceArgs {
  input: TaskMaintenanceRunInput;
}

export interface ApiMutationRootStopTaskPreparationRunArgs {
  runId: Scalars["ID"]["input"];
}

export interface ApiMutationRootStopWorkspaceCreationArgs {
  input: StopWorkspaceCreationInput;
}

export interface ApiMutationRootSubmitAudioTranscriptionArgs {
  blob?: InputMaybe<Scalars["Upload"]["input"]>;
  blobId: Scalars["String"]["input"];
  blobs?: InputMaybe<Array<Scalars["Upload"]["input"]>>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootTestGitConnectionArgs {
  authMethod: GitSyncAuthMethod;
  branch?: InputMaybe<Scalars["String"]["input"]>;
  password?: InputMaybe<Scalars["String"]["input"]>;
  repoUrl: Scalars["String"]["input"];
  sshPassphrase?: InputMaybe<Scalars["String"]["input"]>;
  sshPrivateKey?: InputMaybe<Scalars["String"]["input"]>;
  token?: InputMaybe<Scalars["String"]["input"]>;
  username?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootTransitionDocumentStatusArgs {
  docId: Scalars["ID"]["input"];
  input: TransitionDocumentStatusInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootTrashDatabaseArgs {
  input: DatabaseLifecycleInput;
}

export interface ApiMutationRootTriggerGitSyncArgs {
  direction?: InputMaybe<GitSyncDirection>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootUndoWorkspaceContentOperationArgs {
  idempotencyId: Scalars["UUID"]["input"];
  originOperationId: Scalars["UUID"]["input"];
}

export interface ApiMutationRootUnlinkCalendarAccountArgs {
  accountId: Scalars["String"]["input"];
}

export interface ApiMutationRootUnpinDocumentVersionArgs {
  id: Scalars["ID"]["input"];
}

export interface ApiMutationRootUpdateCalendarAccountArgs {
  accountId?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<UpdateCalendarAccountInput>;
  refreshIntervalMinutes?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface ApiMutationRootUpdateCalendarEventInstanceArgs {
  input: UpdateCalendarEventInstanceInput;
}

export interface ApiMutationRootUpdateCalendarEventRsvpArgs {
  eventId: Scalars["String"]["input"];
  status: CalendarRsvpStatus;
}

export interface ApiMutationRootUpdateCalendarReminderStatusArgs {
  delivered: Scalars["Boolean"]["input"];
  reminderId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootUpdateCommentArgs {
  body?: InputMaybe<Scalars["JSON"]["input"]>;
  commentId?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<CommentUpdateInput>;
}

export interface ApiMutationRootUpdateCopilotSessionArgs {
  options: UpdateChatSessionInput;
}

export interface ApiMutationRootUpdateDatabaseArgs {
  input: UpdateDatabaseInput;
}

export interface ApiMutationRootUpdateDatabaseCellValueArgs {
  input: UpdateDatabaseCellValueInput;
}

export interface ApiMutationRootUpdateDatabaseFieldArgs {
  input: UpdateDatabaseFieldInput;
}

export interface ApiMutationRootUpdateDatabaseRowPositionArgs {
  input: UpdateDatabaseRowPositionInput;
}

export interface ApiMutationRootUpdateDatabaseRowTemplateArgs {
  input: UpdateDatabaseRowTemplateInput;
}

export interface ApiMutationRootUpdateDatabaseRowTitleArgs {
  input: UpdateDatabaseRowTitleInput;
}

export interface ApiMutationRootUpdateDatabaseViewArgs {
  input: UpdateDatabaseViewInput;
}

export interface ApiMutationRootUpdateDocDefaultRoleArgs {
  input: UpdateDocDefaultRoleInput;
}

export interface ApiMutationRootUpdateDocUserRoleArgs {
  input: UpdateDocUserRoleInput;
}

export interface ApiMutationRootUpdateDocumentVersionArgs {
  description?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["ID"]["input"];
  label: Scalars["String"]["input"];
}

export interface ApiMutationRootUpdateDocumentVersioningSettingsArgs {
  autoVersionOn?: InputMaybe<Array<AutoVersionTriggerType>>;
  docId: Scalars["ID"]["input"];
  enabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  retentionCount?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootUpdateEventTagArgs {
  input: UpdateEventTagInput;
  tagId: Scalars["String"]["input"];
}

export interface ApiMutationRootUpdateGitSyncProfileArgs {
  input: UpdateGitSyncProfileInput;
  profileId: Scalars["String"]["input"];
}

export interface ApiMutationRootUpdatePreferencesArgs {
  input: UpdateUserPreferencesInput;
}

export interface ApiMutationRootUpdateProfileArgs {
  input: UpdateUserInput;
}

export interface ApiMutationRootUpdateReplyArgs {
  input: ReplyUpdateInput;
}

export interface ApiMutationRootUpdateSubscriptionRecurringArgs {
  idempotencyKey?: InputMaybe<Scalars["String"]["input"]>;
  plan?: InputMaybe<SubscriptionPlanType>;
  recurring: SubscriptionRecurringType;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiMutationRootUpdateTaskRecurrenceArgs {
  input: UpdateTaskRecurrenceInput;
}

export interface ApiMutationRootUpdateWorkspaceArgs {
  input: UpdateWorkspaceInput;
}

export interface ApiMutationRootUpdateWorkspaceCalendarSettingsArgs {
  input: UpdateWorkspaceCalendarSettingsInput;
}

export interface ApiMutationRootUpdateWorkspaceCalendarsArgs {
  input: UpdateWorkspaceCalendarsInput;
}

export interface ApiMutationRootUpdateWorkspaceDocumentSettingsArgs {
  input: UpdateWorkspaceDocumentSettingsInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootUpdateWorkspaceEmbeddingIgnoredDocsArgs {
  add?: InputMaybe<Array<Scalars["String"]["input"]>>;
  remove?: InputMaybe<Array<Scalars["String"]["input"]>>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootUpdateWorkspaceEventArgs {
  eventId: Scalars["String"]["input"];
  input: UpdateWorkspaceEventInput;
  instanceStart?: InputMaybe<Scalars["DateTime"]["input"]>;
  scope: NativeEventScope;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootUpdateWorkspaceHistorySettingsArgs {
  input: UpdateWorkspaceHistorySettingsInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiMutationRootUpdateWorkspaceTagDescriptionArgs {
  input: UpdateWorkspaceTagDescriptionInput;
}

export interface ApiMutationRootUploadAvatarArgs {
  avatar: Scalars["Upload"]["input"];
}

export interface ApiMutationRootUploadCommentAttachmentArgs {
  attachment: Scalars["Upload"]["input"];
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiMutationRootUpsertCalendarEventArgs {
  input: CalendarEventInput;
}

export interface ApiMutationRootUpsertDatabaseViewUserStateArgs {
  input: UpsertDatabaseViewUserStateInput;
}

export interface ApiMutationRootVerifyEmailArgs {
  token: Scalars["String"]["input"];
}

export interface ApiMutationRootWorkspaceContentPreflightArgs {
  input: WorkspaceContentPreflightInput;
}

export interface ApiMutationRootWorkspaceTemplateReconcileSlugsArgs {
  locale: Scalars["String"]["input"];
  provisionSources?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRoot {
  __typename?: "ApiQueryRoot";
  admin: AdminRoot;
  aggregate: SearchAggregateType;
  /** MCP API key management queries. */
  apiKeys: ApiKeyQueryRoot;
  applyDocUpdates: Scalars["String"]["output"];
  auth: QueryRoot;
  /**
   * P-PDF-TPL-10-01: list PDF templates assigned to a workspace.
   * Members-only — non-members of `workspace_id` are rejected.
   */
  availablePdfTemplates: Array<PdfTemplatePublic>;
  calendarAccounts: Array<CalendarAccountType>;
  calendarCalDAVProviders: Array<Scalars["String"]["output"]>;
  /** Resolve a single workspace event by its stable local identifier. */
  calendarEvent: Maybe<CalendarEventType>;
  /** List workspace event tags (P-JCAL-SERVER-03). */
  calendarEventTags: Array<CalendarEventTagType>;
  calendarEvents: Array<CalendarEventType>;
  /** Query free/busy information for workspace members (P90-CAL-H-07). */
  calendarFreeBusy: Array<UserFreeBusy>;
  calendarProviders: Array<Scalars["String"]["output"]>;
  /**
   * Caller-scoped: project-creation policy gate. `unitId=null` queries
   * the root-policy.
   */
  canCreateOrganizationProject: ProjectCreationDecisionEnum;
  /** Caller-scoped: workspace-creation policy gate for a specific OU. */
  canCreateWorkspaceInOrganizationUnit: Scalars["Boolean"]["output"];
  /** Public, cache-free Browser Web update policy. */
  clientUpdateControl: ClientUpdateControlV1;
  commentEditHistory: Array<CommentEditHistoryType>;
  commentReplies: Array<CommentType>;
  commentThreads: Array<CommentType>;
  currentUser: Maybe<UserType>;
  /**
   * Workspace document-branding profile (audit fields stripped).
   * Members-only.
   */
  documentBrandingProfile: DocumentBrandingProfile;
  documentFieldCatalog: DocumentFieldCatalogType;
  documentFieldOutput: Array<Scalars["String"]["output"]>;
  documentFieldPresentations: Array<DocumentFieldPresentationType>;
  /** Read the committed content revision used to confirm a history restore. */
  documentHistoryRevision: Scalars["String"]["output"];
  documentMetadata: DocumentMetadataType;
  documentMetadataFieldDefinitions: Array<DocumentMetadataFieldDefinitionType>;
  documentMetadataIndex: Array<DocumentMetadataIndexRowType>;
  documentMetadataValidation: DocumentMetadataValidationType;
  documentMetadataValueDefinitions: Array<DocumentMetadataValueDefinitionType>;
  /** List recent PDF export jobs for a document. Workspace-read protected. */
  documentPdfExportHistory: Array<PdfExportHistoryEntryType>;
  documentReviewPlanning: DocumentReviewPlanningType;
  documentStatusSchemas: Array<DocumentStatusSchemaType>;
  documentStatusValues: Array<DocumentStatusValueType>;
  documentTypes: Array<DocumentTypeDefinitionType>;
  /** Fetch one named document version by id. */
  documentVersion: Maybe<DocumentVersionType>;
  /** Compute a diff between two named document versions. */
  documentVersionDiff: DocumentVersionDiffType;
  /** List global/workspace versioning policies selectable in workspace settings. */
  documentVersionPolicies: Array<DocumentVersionPolicyType>;
  /** Fetch per-document versioning settings for the PDF export picker. */
  documentVersioningSettings: DocumentVersioningSettingsType;
  /** List user-visible named versions for a document. */
  documentVersions: Array<DocumentVersionType>;
  /** Return structured error metadata for a given error name (introspection/documentation). */
  error: ErrorDataUnion;
  /** Export workspace-native events as an ICS string (P-JCAL-SERVER-07-A). */
  exportWorkspaceCalendarIcs: Scalars["String"]["output"];
  getInviteInfo: InvitationType;
  gitSyncSchedulePreview: Array<GitSyncScheduleOccurrence>;
  /** Admin-only: list persisted SSH host-key pins used by Git-Sync. */
  gitSyncSshHostKeys: Array<GitSyncSshHostKeyType>;
  /** Admin-only: disk usage for the git sync mirror repository directory. */
  gitSyncStorageUsage: GitSyncStorageUsageType;
  gitSyncTimezones: Array<Scalars["String"]["output"]>;
  /** List the current user's MCP API keys (root-level alias). */
  listApiKeys: Array<ApiKeyType>;
  /**
   * P-AR-0-S02: Manager-scoped user search. Permission gate:
   * `is_manager_for_unit(caller, unitId)`. Forwarder for
   * `OrganizationManagerQueryRoot::manager_search_users`.
   */
  managerSearchUsers: Array<ManagerUserSearchResult>;
  /**
   * Caller-scoped audit log for an OU managed by the current actor.
   * Manager-only; filters on `target_unit_id = unit_id`. See ORG-G-06.
   */
  myOrganizationAuditLog: Array<AdminAuditLogEntryType>;
  /** Caller-scoped: members of an OU the user manages (manager-only). */
  myOrganizationUnitMembers: Array<OrganizationUnitMemberType>;
  /** Caller-scoped: workspaces accessible via the user's OU memberships. */
  myOrganizationUnitWorkspaces: Array<MyOrganizationUnitWorkspace>;
  /**
   * Caller-scoped: organisation units in which the current session user is
   * a member (any role). Used by manager-scope UIs in web/admin frontends.
   */
  myOrganizationUnits: Array<OrganizationUnitTypeOutput>;
  oauthProviders: Array<OAuthProviderType>;
  /** Poll the status of a PDF export job. */
  pdfExportJob: PdfExportJobType;
  /**
   * Per-workspace export-time defaults (default template, locale, paper size,
   * color profile, image quality, ligatures). Members-only.
   */
  pdfExportSettings: PdfExportSettings;
  /**
   * Render a template preview PDF with representative document content.
   *
   * Admins call this without `workspaceId`; workspace clients must pass
   * `workspaceId`, which restricts access to templates assigned to that
   * workspace.
   */
  pdfTemplatePreviewPdf: Scalars["String"]["output"];
  /** Existing catalog themes selectable for the canonical personal workspace. */
  personalWorkspaceThemeCatalog: Array<PersonalWorkspaceThemeOptionType>;
  /** Effective catalog-theme selection for the canonical personal workspace. */
  personalWorkspaceThemeSelection: PersonalWorkspaceThemeSelectionType;
  previewLegacyDatabaseMigration: LegacyDatabaseMigrationPlanObjectType;
  prices: Array<SubscriptionPriceType>;
  publicUserById: Maybe<PublicUserType>;
  queryWorkspaceEmbeddingStatus: ContextWorkspaceEmbeddingStatus;
  /** @deprecated use currentUser.revealedAccessTokens */
  revealedAccessTokens: Array<RevealedAccessToken>;
  search: Array<SearchDocType>;
  searchDocs: Array<SearchDocType>;
  /**
   * P-AR-0-S01: Free-text search over OUs (`name`/`slug` ILIKE).
   * Admin sees all hits, non-admin sees only OUs they are a member of.
   * Forwarder for `OrganizationManagerQueryRoot::search_organization_units`.
   */
  searchOrganizationUnits: Array<OrganizationUnitSearchResult>;
  serverConfig: ServerConfigType;
  /**
   * Check server setup status for admin setup wizard (P91-CFG-C-01).
   * Reports whether critical configuration is complete.
   * Accessible by any authenticated user (for setup wizard redirect logic).
   */
  serverSetupStatus: ServerSetupStatusType;
  serverUsers: Array<ServerUserSearchResult>;
  user: Maybe<UserOrLimitedUser>;
  workspace: Maybe<WorkspaceType>;
  /** Authored native series, independent of their current projected window. */
  workspaceCalendarSeries: Array<CalendarEventType>;
  /** Get workspace calendar settings (writeback target + default reminder). */
  workspaceCalendarSettings: Maybe<WorkspaceCalendarSettingsType>;
  workspaceCalendars: Array<WorkspaceCalendarType>;
  /** Actor-scoped, redacted durable XWS status. */
  workspaceContentOperation: WorkspaceContentOperationType;
  /** Resolve an old XWS route without exposing a target the actor cannot read. */
  workspaceContentRedirect: Maybe<WorkspaceContentRedirectType>;
  workspaceDocumentSettings: Maybe<WorkspaceDocumentSettingsType>;
  workspaceHistorySettings: WorkspaceHistorySettingsType;
  workspaceImport: WorkspaceImportType;
  workspaceRolePermissions: WorkspaceRolePermissions;
  workspaces: Array<WorkspaceType>;
}

export interface ApiQueryRootAggregateArgs {
  language?: InputMaybe<Scalars["String"]["input"]>;
  query: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootApplyDocUpdatesArgs {
  docId: Scalars["String"]["input"];
  op: Scalars["String"]["input"];
  updates: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootAvailablePdfTemplatesArgs {
  locale?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootCalendarEventArgs {
  eventId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootCalendarEventTagsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootCalendarEventsArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootCalendarFreeBusyArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
  userIds: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootCanCreateOrganizationProjectArgs {
  unitId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface ApiQueryRootCanCreateWorkspaceInOrganizationUnitArgs {
  unitId: Scalars["ID"]["input"];
}

export interface ApiQueryRootCommentEditHistoryArgs {
  commentId: Scalars["String"]["input"];
  docId: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootCommentRepliesArgs {
  docId: Scalars["String"]["input"];
  parentCommentId: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootCommentThreadsArgs {
  docId: Scalars["String"]["input"];
  filter?: InputMaybe<CommentThreadFilter>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootDocumentBrandingProfileArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentFieldOutputArgs {
  docId: Scalars["ID"]["input"];
  fields: Scalars["JSON"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentFieldPresentationsArgs {
  docId: Scalars["ID"]["input"];
  fields: Scalars["JSON"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentHistoryRevisionArgs {
  docId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentMetadataArgs {
  docId: Scalars["ID"]["input"];
  requestedProjectionMode?: InputMaybe<DocumentMetadataProjectionModeType>;
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentMetadataIndexArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentMetadataValidationArgs {
  action?: InputMaybe<DocumentMetadataValidationActionType>;
  docId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentMetadataValueDefinitionsArgs {
  fieldKey: Scalars["String"]["input"];
}

export interface ApiQueryRootDocumentPdfExportHistoryArgs {
  docId: Scalars["String"]["input"];
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootDocumentReviewPlanningArgs {
  docId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentStatusValuesArgs {
  schemaKey: Scalars["String"]["input"];
}

export interface ApiQueryRootDocumentVersionArgs {
  id: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentVersionDiffArgs {
  fromId: Scalars["ID"]["input"];
  toId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentVersionPoliciesArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentVersioningSettingsArgs {
  docId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootDocumentVersionsArgs {
  docId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootErrorArgs {
  name: ErrorNames;
}

export interface ApiQueryRootExportWorkspaceCalendarIcsArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootGetInviteInfoArgs {
  inviteId: Scalars["String"]["input"];
}

export interface ApiQueryRootGitSyncSchedulePreviewArgs {
  count?: InputMaybe<Scalars["Int"]["input"]>;
  cron: Scalars["String"]["input"];
  cronTimezone: Scalars["String"]["input"];
}

export interface ApiQueryRootManagerSearchUsersArgs {
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  query: Scalars["String"]["input"];
  unitId: Scalars["ID"]["input"];
}

export interface ApiQueryRootMyOrganizationAuditLogArgs {
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  unitId: Scalars["ID"]["input"];
}

export interface ApiQueryRootMyOrganizationUnitMembersArgs {
  unitId: Scalars["ID"]["input"];
}

export interface ApiQueryRootPdfExportJobArgs {
  jobId: Scalars["String"]["input"];
}

export interface ApiQueryRootPdfExportSettingsArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootPdfTemplatePreviewPdfArgs {
  locale?: InputMaybe<Scalars["String"]["input"]>;
  templateId: Scalars["String"]["input"];
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ApiQueryRootPersonalWorkspaceThemeCatalogArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootPersonalWorkspaceThemeSelectionArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootPreviewLegacyDatabaseMigrationArgs {
  input: LegacyDatabaseMigrationInput;
}

export interface ApiQueryRootPublicUserByIdArgs {
  id: Scalars["String"]["input"];
}

export interface ApiQueryRootQueryWorkspaceEmbeddingStatusArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootSearchArgs {
  language?: InputMaybe<Scalars["String"]["input"]>;
  query: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  sortBy?: InputMaybe<SearchSortBy>;
  sortDirection?: InputMaybe<SortDirection>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  useSemanticSearch?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootSearchDocsArgs {
  language?: InputMaybe<Scalars["String"]["input"]>;
  query: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  sortBy?: InputMaybe<SearchSortBy>;
  sortDirection?: InputMaybe<SortDirection>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  useSemanticSearch?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootSearchOrganizationUnitsArgs {
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  query: Scalars["String"]["input"];
}

export interface ApiQueryRootServerUsersArgs {
  search: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface ApiQueryRootUserArgs {
  email: Scalars["String"]["input"];
}

export interface ApiQueryRootWorkspaceArgs {
  docId?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["String"]["input"];
}

export interface ApiQueryRootWorkspaceCalendarSeriesArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootWorkspaceCalendarSettingsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootWorkspaceCalendarsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface ApiQueryRootWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface ApiQueryRootWorkspaceContentRedirectArgs {
  input: WorkspaceContentRedirectInput;
}

export interface ApiQueryRootWorkspaceDocumentSettingsArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootWorkspaceHistorySettingsArgs {
  workspaceId: Scalars["ID"]["input"];
}

export interface ApiQueryRootWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface ApiQueryRootWorkspaceRolePermissionsArgs {
  id: Scalars["String"]["input"];
}

export interface AppConfigValidateResultType {
  __typename?: "AppConfigValidateResultType";
  error: Maybe<Scalars["String"]["output"]>;
  key: Scalars["String"]["output"];
  module: Scalars["String"]["output"];
  valid: Scalars["Boolean"]["output"];
  value: Scalars["JSON"]["output"];
}

export interface AppServerBrandingType {
  __typename?: "AppServerBrandingType";
  faviconPack: Maybe<BrandAssetType>;
  logo: Maybe<BrandAssetType>;
  productMark: Maybe<BrandAssetType>;
}

export interface ApplyContextDocumentsInput {
  admissionConfirmation?: InputMaybe<Scalars["String"]["input"]>;
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  planDigest: Scalars["String"]["input"];
  requestId: Scalars["ID"]["input"];
  target: ContextDocumentTargetInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface AssignOrganizationManagerInput {
  role: OrganizationUnitRoleEnum;
  unitId: Scalars["ID"]["input"];
  userId: Scalars["ID"]["input"];
}

export interface AssignOrganizationUnitWorkspaceInput {
  relationship: OrganizationUnitWorkspaceRelationshipEnum;
  unitId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export enum AssistanceMode {
  Automatic = "Automatic",
  Guided = "Guided",
  Manual = "Manual",
}

export enum AssistanceSource {
  Project = "Project",
  UserDefault = "UserDefault",
  Workspace = "Workspace",
}

export interface AssistantAction {
  __typename?: "AssistantAction";
  action: AssistantActionKind;
  component: Maybe<Scalars["String"]["output"]>;
  dialog: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  label: Maybe<AssistantLocalizedText>;
  targetStep: Maybe<Scalars["String"]["output"]>;
  visibleWhen: Maybe<AssistantVisibility>;
}

export enum AssistantActionKind {
  ApplyDocuments = "ApplyDocuments",
  Back = "Back",
  Cancel = "Cancel",
  CaptureTask = "CaptureTask",
  Check = "Check",
  Close = "Close",
  CommitTaskMove = "CommitTaskMove",
  ConfigureTaskPreparation = "ConfigureTaskPreparation",
  CreateProject = "CreateProject",
  CreateSubtask = "CreateSubtask",
  CreateTask = "CreateTask",
  CreateWorkspace = "CreateWorkspace",
  Next = "Next",
  OpenCurrentRow = "OpenCurrentRow",
  OpenProjectCreation = "OpenProjectCreation",
  OpenRelatedRow = "OpenRelatedRow",
  PrepareDocumentReview = "PrepareDocumentReview",
  PrepareDocuments = "PrepareDocuments",
  PrepareTaskHandover = "PrepareTaskHandover",
  PrepareTaskMaintenance = "PrepareTaskMaintenance",
  PrepareTaskMove = "PrepareTaskMove",
  PrepareTaskPreparation = "PrepareTaskPreparation",
  Refresh = "Refresh",
  RequestDocumentReview = "RequestDocumentReview",
  StartTaskHandover = "StartTaskHandover",
  StartTaskMaintenance = "StartTaskMaintenance",
}

export interface AssistantArtwork {
  __typename?: "AssistantArtwork";
  alternative: AssistantLocalizedText;
  caption: Maybe<AssistantLocalizedText>;
  digest: Scalars["String"]["output"];
  group: Scalars["String"]["output"];
  height: Scalars["Int"]["output"];
  mediaType: Scalars["String"]["output"];
  role: Maybe<AssistantArtworkRole>;
  step: Scalars["String"]["output"];
  url: Scalars["String"]["output"];
  width: Scalars["Int"]["output"];
}

export enum AssistantArtworkRole {
  Diagram = "Diagram",
  Illustration = "Illustration",
}

export enum AssistantBindingKind {
  Field = "Field",
  Role = "Role",
}

export enum AssistantBindingValueKind {
  Context = "Context",
  Input = "Input",
  LocalizedText = "LocalizedText",
  Result = "Result",
}

export enum AssistantCellPresence {
  Always = "Always",
  Empty = "Empty",
  Present = "Present",
}

export interface AssistantChoice {
  __typename?: "AssistantChoice";
  id: Scalars["String"]["output"];
  label: AssistantLocalizedText;
  value: AssistantValue;
}

export interface AssistantComponent {
  __typename?: "AssistantComponent";
  action: AssistantNativeAction;
  id: Scalars["String"]["output"];
}

export enum AssistantContext {
  ProjectCreation = "ProjectCreation",
  TaskCapture = "TaskCapture",
  TaskContainerAssistance = "TaskContainerAssistance",
  TaskCreation = "TaskCreation",
  TaskDetail = "TaskDetail",
  TaskHome = "TaskHome",
  TaskInventory = "TaskInventory",
  TaskMovement = "TaskMovement",
  TaskSubtask = "TaskSubtask",
  WorkspaceCreation = "WorkspaceCreation",
}

export enum AssistantContextValue {
  Database = "Database",
  ParentRow = "ParentRow",
  Requester = "Requester",
  Row = "Row",
  SourceDocument = "SourceDocument",
  Workspace = "Workspace",
}

export interface AssistantControl {
  __typename?: "AssistantControl";
  allowCustomOffset: Maybe<Scalars["Boolean"]["output"]>;
  binding: Maybe<AssistantFieldBinding>;
  control: Maybe<AssistantInputControlKind>;
  defaultOffsetMinutes: Maybe<Scalars["Int"]["output"]>;
  filter: Maybe<AssistantTaskFilter>;
  input: Maybe<Scalars["String"]["output"]>;
  kind: AssistantControlKind;
  offsetsMinutes: Maybe<Array<Scalars["Int"]["output"]>>;
  presence: Maybe<AssistantCellPresence>;
  search: Maybe<Scalars["Boolean"]["output"]>;
  value: Maybe<AssistantTaskSummaryValue>;
}

export enum AssistantControlKind {
  Activity = "Activity",
  BlockedBy = "BlockedBy",
  CurrentOwnerReadback = "CurrentOwnerReadback",
  DestinationAudience = "DestinationAudience",
  DocumentReview = "DocumentReview",
  Follow = "Follow",
  Input = "Input",
  MoveImpact = "MoveImpact",
  MoveSelection = "MoveSelection",
  NativeCell = "NativeCell",
  OfferingSelection = "OfferingSelection",
  Parent = "Parent",
  ProjectReview = "ProjectReview",
  Reminder = "Reminder",
  RowContent = "RowContent",
  RowLifecycle = "RowLifecycle",
  SourceOrigin = "SourceOrigin",
  TaskFilter = "TaskFilter",
  TaskHandoverReview = "TaskHandoverReview",
  TaskMaintenanceReview = "TaskMaintenanceReview",
  TaskPreparationReview = "TaskPreparationReview",
  TaskSummary = "TaskSummary",
  WorkspaceReview = "WorkspaceReview",
}

export interface AssistantDialog {
  __typename?: "AssistantDialog";
  actions: Array<AssistantAction>;
  groups: Array<AssistantGroup>;
  id: Scalars["String"]["output"];
  title: AssistantLocalizedText;
}

export interface AssistantDocumentComponentSource {
  __typename?: "AssistantDocumentComponentSource";
  componentId: Scalars["String"]["output"];
  digest: Scalars["String"]["output"];
  templateId: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface AssistantDocumentSource {
  __typename?: "AssistantDocumentSource";
  digest: Scalars["String"]["output"];
  group: Scalars["String"]["output"];
  step: Scalars["String"]["output"];
  /** Native document slug/version; the Library resolver supplies Registry UUIDs. */
  templateId: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface AssistantDocumentSourceInput {
  clientVersion: Scalars["Int"]["input"];
  group: Scalars["String"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  sourceDigest: Scalars["String"]["input"];
  step: Scalars["String"]["input"];
}

export interface AssistantFieldBinding {
  __typename?: "AssistantFieldBinding";
  fieldKey: Maybe<Scalars["String"]["output"]>;
  kind: AssistantBindingKind;
  roleKey: Maybe<Scalars["String"]["output"]>;
}

export interface AssistantFolderDestination {
  __typename?: "AssistantFolderDestination";
  id: Maybe<Scalars["String"]["output"]>;
  kind: AssistantFolderDestinationKind;
  name: Maybe<Scalars["String"]["output"]>;
  parent: Maybe<Scalars["String"]["output"]>;
}

export enum AssistantFolderDestinationKind {
  Existing = "Existing",
  New = "New",
}

export interface AssistantGroup {
  __typename?: "AssistantGroup";
  controls: Array<AssistantControl>;
  id: Scalars["String"]["output"];
  role: AssistantGroupRole;
  title: Maybe<AssistantLocalizedText>;
  visibleWhen: Maybe<AssistantVisibility>;
}

export enum AssistantGroupRole {
  Content = "Content",
  Details = "Details",
  Filters = "Filters",
  Inventory = "Inventory",
  More = "More",
  Review = "Review",
  Workflow = "Workflow",
}

export interface AssistantInput {
  __typename?: "AssistantInput";
  choices: Array<AssistantChoice>;
  defaultValue: Maybe<AssistantValue>;
  description: Maybe<AssistantLocalizedText>;
  id: Scalars["String"]["output"];
  label: AssistantLocalizedText;
  required: Scalars["Boolean"]["output"];
  target: AssistantInputTarget;
  valueType: AssistantValueType;
  visibleWhen: Maybe<AssistantVisibility>;
}

export enum AssistantInputControlKind {
  Date = "Date",
  DateTime = "DateTime",
  Destination = "Destination",
  Document = "Document",
  Folder = "Folder",
  Members = "Members",
  MultiSelect = "MultiSelect",
  Multiline = "Multiline",
  RadioCards = "RadioCards",
  Row = "Row",
  RowTemplate = "RowTemplate",
  Search = "Search",
  Select = "Select",
  TaskReferences = "TaskReferences",
  Text = "Text",
  Toggle = "Toggle",
}

export enum AssistantInputTarget {
  Assignees = "Assignees",
  AssistanceMode = "AssistanceMode",
  ComplexityPreset = "ComplexityPreset",
  CopyDescription = "CopyDescription",
  Deadline = "Deadline",
  DefaultCurrency = "DefaultCurrency",
  Description = "Description",
  Destination = "Destination",
  Due = "Due",
  EndDate = "EndDate",
  Folder = "Folder",
  Goal = "Goal",
  IncludeComponent = "IncludeComponent",
  IncludeSamples = "IncludeSamples",
  IncludeScaffold = "IncludeScaffold",
  InitialContent = "InitialContent",
  InitialView = "InitialView",
  Milestone = "Milestone",
  MoveSelection = "MoveSelection",
  Parent = "Parent",
  People = "People",
  Phase = "Phase",
  PrerequisiteTasks = "PrerequisiteTasks",
  PriorityPreset = "PriorityPreset",
  ProjectTemplate = "ProjectTemplate",
  Reviewer = "Reviewer",
  RowTemplate = "RowTemplate",
  Scope = "Scope",
  SourceDocument = "SourceDocument",
  StartDate = "StartDate",
  StructurePreset = "StructurePreset",
  TaskAssignee = "TaskAssignee",
  TaskBlockedOnly = "TaskBlockedOnly",
  TaskDuePreset = "TaskDuePreset",
  TaskLifecycle = "TaskLifecycle",
  TaskScope = "TaskScope",
  TaskSearch = "TaskSearch",
  TaskStatusGroup = "TaskStatusGroup",
  Tasks = "Tasks",
  Title = "Title",
  WorkspaceName = "WorkspaceName",
}

export interface AssistantLocalizedText {
  __typename?: "AssistantLocalizedText";
  de: Scalars["String"]["output"];
  en: Scalars["String"]["output"];
  es: Scalars["String"]["output"];
  fr: Scalars["String"]["output"];
}

export interface AssistantNamedBinding {
  __typename?: "AssistantNamedBinding";
  binding: AssistantValueBinding;
  name: Scalars["String"]["output"];
}

export interface AssistantNamedValue {
  __typename?: "AssistantNamedValue";
  input: Scalars["String"]["output"];
  value: AssistantValue;
}

export interface AssistantNativeAction {
  __typename?: "AssistantNativeAction";
  definitionId: Maybe<Scalars["String"]["output"]>;
  folder: Maybe<AssistantValueBinding>;
  inputs: Array<AssistantTargetBinding>;
  kind: AssistantNativeActionKind;
  proposal: Maybe<AssistantValueBinding>;
  selected: Maybe<AssistantValueBinding>;
  target: Maybe<AssistantValueBinding>;
  tasks: Maybe<AssistantValueBinding>;
  templateId: Maybe<Scalars["String"]["output"]>;
  variables: Array<AssistantNamedBinding>;
}

export enum AssistantNativeActionKind {
  ApplyTaskCorrections = "ApplyTaskCorrections",
  ConfigureTaskPreparation = "ConfigureTaskPreparation",
  CreateDatabaseFromDefinition = "CreateDatabaseFromDefinition",
  CreateDocument = "CreateDocument",
  CreateLinkedDocument = "CreateLinkedDocument",
  CreateProject = "CreateProject",
  CreateTaskFromDocument = "CreateTaskFromDocument",
  CreateWorkingDocument = "CreateWorkingDocument",
  CreateWorkspace = "CreateWorkspace",
  InspectTaskContent = "InspectTaskContent",
  PlaceNativeLink = "PlaceNativeLink",
  RequestDocumentReview = "RequestDocumentReview",
  TaskHandover = "TaskHandover",
  TaskMaintenance = "TaskMaintenance",
}

export interface AssistantPackage {
  __typename?: "AssistantPackage";
  artwork: Array<AssistantArtwork>;
  components: Array<AssistantComponent>;
  contexts: Array<AssistantContext>;
  defaultFor: Array<AssistantContext>;
  description: AssistantLocalizedText;
  documentComponents: Array<AssistantDocumentComponentSource>;
  documentSources: Array<AssistantDocumentSource>;
  identity: AssistantPackageIdentity;
  inputs: Array<AssistantInput>;
  name: AssistantLocalizedText;
  presentation: AssistantPresentation;
}

export interface AssistantPackageIdentity {
  __typename?: "AssistantPackageIdentity";
  digest: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface AssistantPackageIdentityInput {
  digest: Scalars["String"]["input"];
  id: Scalars["String"]["input"];
  version: Scalars["String"]["input"];
}

export interface AssistantPreparedDocumentComponent {
  __typename?: "AssistantPreparedDocumentComponent";
  folder: AssistantFolderDestination;
  locale: Scalars["String"]["output"];
  source: AssistantDocumentComponentSource;
  sourceContentDigest: Scalars["String"]["output"];
  sourceRevisionId: Scalars["ID"]["output"];
  title: Scalars["String"]["output"];
}

/**
 * Preallocation references expose published metadata only; native content is
 * captured only after the actual Workspace and folder are available.
 */
export interface AssistantPreparedDocumentMetadata {
  __typename?: "AssistantPreparedDocumentMetadata";
  folder: AssistantFolderDestination;
  locale: Scalars["String"]["output"];
  source: AssistantDocumentComponentSource;
  sourceRevisionId: Scalars["ID"]["output"];
  title: Scalars["String"]["output"];
}

export interface AssistantPresentation {
  __typename?: "AssistantPresentation";
  dialogs: Array<AssistantDialog>;
  guidedHelp: Maybe<AssistantStep>;
  steps: Array<AssistantStep>;
}

export interface AssistantProjectScaffold {
  __typename?: "AssistantProjectScaffold";
  id: Scalars["String"]["output"];
  kind: AssistantProjectScaffoldKind;
  title: AssistantLocalizedText;
}

export enum AssistantProjectScaffoldKind {
  Milestone = "Milestone",
  Phase = "Phase",
}

export interface AssistantProjectSetupCounts {
  __typename?: "AssistantProjectSetupCounts";
  explicitTasks: Scalars["Int"]["output"];
  milestones: Scalars["Int"]["output"];
  phases: Scalars["Int"]["output"];
  sampleRows: Scalars["Int"]["output"];
}

export interface AssistantProjectSetupFacts {
  __typename?: "AssistantProjectSetupFacts";
  endDate: Maybe<DatabaseDateCellValueType>;
  goal: Maybe<Scalars["String"]["output"]>;
  people: Array<Scalars["ID"]["output"]>;
  scaffold: Array<AssistantProjectScaffold>;
  scope: Maybe<Scalars["String"]["output"]>;
  startDate: Maybe<DatabaseDateCellValueType>;
}

export interface AssistantResolvedField {
  __typename?: "AssistantResolvedField";
  binding: AssistantFieldBinding;
  config: DatabaseFieldConfigType;
  fieldId: Scalars["ID"]["output"];
  fieldType: DatabaseFieldKind;
  name: Scalars["String"]["output"];
  required: Scalars["Boolean"]["output"];
}

export interface AssistantResolvedPresentation {
  __typename?: "AssistantResolvedPresentation";
  databaseId: Maybe<Scalars["ID"]["output"]>;
  descriptor: AssistantPackage;
  fields: Array<AssistantResolvedField>;
  managedSchema: Maybe<DatabaseManagedSchema>;
  rowId: Maybe<Scalars["ID"]["output"]>;
  unavailableReason: Maybe<Scalars["String"]["output"]>;
}

export enum AssistantResultValue {
  CorrectionProposal = "CorrectionProposal",
  Database = "Database",
  Document = "Document",
  Outcome = "Outcome",
  Reason = "Reason",
  Row = "Row",
}

export interface AssistantStep {
  __typename?: "AssistantStep";
  actions: Array<AssistantAction>;
  groups: Array<AssistantGroup>;
  id: Scalars["String"]["output"];
  title: AssistantLocalizedText;
}

export interface AssistantTargetBinding {
  __typename?: "AssistantTargetBinding";
  binding: AssistantValueBinding;
  target: AssistantInputTarget;
}

export enum AssistantTaskFilter {
  Assignee = "Assignee",
  BlockedOnly = "BlockedOnly",
  Destination = "Destination",
  DuePreset = "DuePreset",
  Lifecycle = "Lifecycle",
  Scope = "Scope",
  Search = "Search",
  StatusGroup = "StatusGroup",
}

export interface AssistantTaskReference {
  __typename?: "AssistantTaskReference";
  databaseId: Scalars["ID"]["output"];
  rowId: Scalars["ID"]["output"];
}

export enum AssistantTaskSummaryValue {
  Assignees = "Assignees",
  BlockedBy = "BlockedBy",
  Destination = "Destination",
  Due = "Due",
  Priority = "Priority",
  RowActions = "RowActions",
  Status = "Status",
  Title = "Title",
}

export interface AssistantValue {
  __typename?: "AssistantValue";
  boolean: Maybe<Scalars["Boolean"]["output"]>;
  choice: Maybe<Scalars["String"]["output"]>;
  choices: Maybe<Array<Scalars["String"]["output"]>>;
  databaseId: Maybe<Scalars["ID"]["output"]>;
  date: Maybe<DatabaseDateCellValueType>;
  dateTime: Maybe<DatabaseDateTimeCellValueType>;
  documentId: Maybe<Scalars["ID"]["output"]>;
  folder: Maybe<AssistantFolderDestination>;
  kind: AssistantValueType;
  memberIds: Maybe<Array<Scalars["ID"]["output"]>>;
  rowId: Maybe<Scalars["ID"]["output"]>;
  rowSelection: Maybe<Array<DatabaseTaskMoveSelection>>;
  rowTemplateId: Maybe<Scalars["ID"]["output"]>;
  taskReferences: Maybe<Array<AssistantTaskReference>>;
  text: Maybe<Scalars["String"]["output"]>;
}

export interface AssistantValueBinding {
  __typename?: "AssistantValueBinding";
  component: Maybe<Scalars["String"]["output"]>;
  context: Maybe<AssistantContextValue>;
  input: Maybe<Scalars["String"]["output"]>;
  kind: AssistantBindingValueKind;
  localizedText: Maybe<AssistantLocalizedText>;
  result: Maybe<AssistantResultValue>;
}

export enum AssistantValueType {
  Boolean = "Boolean",
  Choice = "Choice",
  Choices = "Choices",
  DatabaseDestination = "DatabaseDestination",
  Date = "Date",
  DateTime = "DateTime",
  Document = "Document",
  Folder = "Folder",
  Members = "Members",
  Row = "Row",
  RowSelection = "RowSelection",
  RowTemplate = "RowTemplate",
  TaskReferences = "TaskReferences",
  Text = "Text",
}

export interface AssistantVisibility {
  __typename?: "AssistantVisibility";
  input: Scalars["String"]["output"];
  kind: AssistantVisibilityKind;
  value: Maybe<AssistantValue>;
}

export enum AssistantVisibilityKind {
  Equals = "Equals",
  Present = "Present",
}

export interface AssistantWorkflowIdentity {
  __typename?: "AssistantWorkflowIdentity";
  digest: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface AttachDatabaseRowContentDocumentInput {
  databaseId: Scalars["ID"]["input"];
  documentId: Scalars["ID"]["input"];
  expectedEditRevision: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

/**
 * Filter for `adminAuditLog` / `adminAuditLogCount` queries.
 *
 * All fields are optional; absent fields match any value.
 */
export interface AuditLogFilterInput {
  /** Restrict to actor origin kind: `"user"`, `"system"` or `"api_key"`. */
  actorKind?: InputMaybe<Scalars["String"]["input"]>;
  /** Restrict to events performed by or delegated from a specific user. */
  actorUserId?: InputMaybe<Scalars["ID"]["input"]>;
  /**
   * Restrict to a specific category: `"config"`, `"organization"`, `"user"`,
   * `"workspace"`, `"feature"`, `"template"`, `"logging"`, `"cache"`.
   */
  category?: InputMaybe<Scalars["String"]["input"]>;
  /** Restrict to delegated credential id. */
  credentialId?: InputMaybe<Scalars["String"]["input"]>;
  /** Restrict to delegated credential type, e.g. `"mcp_api_key"`. */
  credentialType?: InputMaybe<Scalars["String"]["input"]>;
  /** Restrict to events whose `eventKey` starts with this prefix. */
  eventKeyPrefix?: InputMaybe<Scalars["String"]["input"]>;
  /** Lower bound (inclusive) on `createdAt`. */
  from?: InputMaybe<Scalars["DateTime"]["input"]>;
  /** Restrict to events affecting a specific entity ID (requires `targetType`). */
  targetId?: InputMaybe<Scalars["String"]["input"]>;
  /** Restrict to events affecting a specific entity type. */
  targetType?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Restrict to events tagged with a specific Organisationseinheit
   * (`target_unit_id`). Set automatically by `myOrganizationAuditLog`.
   */
  targetUnitId?: InputMaybe<Scalars["ID"]["input"]>;
  /** Upper bound (inclusive) on `createdAt`. */
  to?: InputMaybe<Scalars["DateTime"]["input"]>;
}

/** Target entity for an audit log entry. */
export interface AuditTargetType {
  __typename?: "AuditTargetType";
  /** UUID or config key string. */
  id: Scalars["String"]["output"];
  /** Human-readable snapshot for display. */
  label: Maybe<Scalars["String"]["output"]>;
  /** Entity type: `"organization_unit"`, `"user"`, `"workspace"`, `"config"`, etc. */
  type: Scalars["String"]["output"];
}

/** One authentication method in the server-owned setup diagnosis. */
export interface AuthMethodCapabilityType {
  __typename?: "AuthMethodCapabilityType";
  method: Scalars["String"]["output"];
  reasonCode: Maybe<Scalars["String"]["output"]>;
  supported: Scalars["Boolean"]["output"];
  usable: Scalars["Boolean"]["output"];
}

export enum AutoVersionTriggerType {
  daily = "daily",
  on_pdf_export = "on_pdf_export",
  on_publish = "on_publish",
}

export interface BlobNotFoundDataType {
  __typename?: "BlobNotFoundDataType";
  blobId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

/** Initialization response for `createBlobUploadInit` — tells the client how to upload. */
export interface BlobUploadInitType {
  __typename?: "BlobUploadInitType";
  /** `true` when an identical blob was already uploaded (content-addressed dedup). */
  alreadyUploaded: Maybe<Scalars["Boolean"]["output"]>;
  /** Storage key under which the blob will be stored. */
  blobKey: Scalars["String"]["output"];
  /** When the pre-signed URL expires. */
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  /** Additional headers to set when using the pre-signed URL. */
  headers: Maybe<Scalars["JSON"]["output"]>;
  /** Negotiated upload strategy. */
  method: BlobUploadMethod;
  /** Size in bytes of each part (for `Multipart` method). */
  partSize: Maybe<Scalars["Int"]["output"]>;
  /** Multipart upload ID (for `Multipart` method). */
  uploadId: Maybe<Scalars["String"]["output"]>;
  /** Pre-signed upload URL (for `Presigned` method). */
  uploadUrl: Maybe<Scalars["String"]["output"]>;
  /** Parts already uploaded (for resuming a multipart upload). */
  uploadedParts: Maybe<Array<BlobUploadedPartType>>;
}

/** Upload strategy negotiated by `createBlobUploadInit`. */
export enum BlobUploadMethod {
  /** Upload via GraphQL mutation body (small blobs). */
  Graphql = "Graphql",
  /** Multipart upload via the `/api/blob-upload/` REST endpoints. */
  Multipart = "Multipart",
  /** Pre-signed URL upload directly to object storage. */
  Presigned = "Presigned",
}

/** Acknowledgment of a completed part, used to finalize multipart uploads. */
export interface BlobUploadPartInput {
  /** ETag from the storage backend response. */
  etag: Scalars["String"]["input"];
  /** 1-based part number. */
  partNumber: Scalars["Int"]["input"];
}

/** Pre-signed URL for uploading a single multipart part. */
export interface BlobUploadPartType {
  __typename?: "BlobUploadPartType";
  /** When the pre-signed URL expires. */
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  /** Required headers to include when PUT-ting to the URL. */
  headers: Maybe<Scalars["JSON"]["output"]>;
  /** Pre-signed URL for this part. */
  uploadUrl: Scalars["String"]["output"];
}

/** An already-uploaded part in an in-progress multipart upload. */
export interface BlobUploadedPartType {
  __typename?: "BlobUploadedPartType";
  /** ETag returned by the storage backend for this part. */
  etag: Scalars["String"]["output"];
  /** 1-based part number. */
  partNumber: Scalars["Int"]["output"];
}

export interface BootstrapWorkspaceTagsInput {
  assignments: Array<LegacyWorkspaceTagDocumentAssignmentInput>;
  tags: Array<LegacyWorkspaceTagInput>;
  workspaceId: Scalars["ID"]["input"];
}

export interface BrandAssetType {
  __typename?: "BrandAssetType";
  byteSize: Maybe<Scalars["Int"]["output"]>;
  heightPx: Maybe<Scalars["Int"]["output"]>;
  id: Scalars["ID"]["output"];
  mime: Scalars["String"]["output"];
  publicUrl: Maybe<Scalars["String"]["output"]>;
  qualityClass: Scalars["String"]["output"];
  sha256: Scalars["String"]["output"];
  slot: Scalars["String"]["output"];
  storageKey: Scalars["String"]["output"];
  storageKind: Scalars["String"]["output"];
  variant: Scalars["String"]["output"];
  widthPx: Maybe<Scalars["Int"]["output"]>;
}

/**
 * Identifies which logo slot a brand-asset upload/delete targets. The two
 * slots are mirrored on the entity as `logo_large_blob` / `logo_small_blob`.
 */
export enum BrandLogoKind {
  /** Cover-page / hero logo. Maps to `logo_large_blob`. */
  Large = "Large",
  /** Header / footer mark. Maps to `logo_small_blob`. */
  Small = "Small",
}

/**
 * One entry in the reconcile-slugs response: tells the client whether to build,
 * replace, or retire a builtin template document in this workspace.
 */
export interface BuiltinReconcileEntryType {
  __typename?: "BuiltinReconcileEntryType";
  /** Hash of the last client-applied build, if any. */
  appliedHash: Maybe<Scalars["String"]["output"]>;
  builderVersion: Scalars["Int"]["output"];
  /** SHA-256 hex of `slug|builder_version|locale` — server-computed. */
  expectedHash: Scalars["String"]["output"];
  /** Whether the instance currently exists in this workspace. */
  hasInstance: Scalars["Boolean"]["output"];
  /** Server-owned lifecycle state of the current workspace binding. */
  instanceState: Maybe<InstanceStateType>;
  provisioningMode: ProvisioningModeType;
  slug: Scalars["String"]["output"];
  /** Document id of the current workspace instance, if one exists. */
  workspaceDocId: Maybe<Scalars["ID"]["output"]>;
}

/**
 * Bulk multi-field edit — apply many cell writes (possibly across many
 * rows) in one transaction. Total `(row, field)` writes are capped at
 * `DATABASE_BULK_MAX_FIELD_UPDATES_PER_OPERATION`.
 */
export interface BulkApplyDatabaseCellPatchesInput {
  databaseId: Scalars["ID"]["input"];
  /** P-DB-29B-C: force overwrites every stale snapshot. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  patches: Array<BulkDatabaseRowPatchInput>;
}

/** Bulk cell clear — clear a single cell on many rows in one transaction. */
export interface BulkClearDatabaseCellValueInput {
  databaseId: Scalars["ID"]["input"];
  /**
   * P-DB-29B-C: per-row optimistic-lock precondition. Rows missing an
   * entry skip the precondition (no client observation on file).
   */
  expectedEditRevisions?: InputMaybe<Array<BulkRowExpectedEditRevision>>;
  fieldId: Scalars["ID"]["input"];
  /** P-DB-29B-C: force every stale overwrite. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowIds: Array<Scalars["ID"]["input"]>;
}

/** A single `(row_id, value)` write inside a bulk multi-field patch. */
export interface BulkDatabaseCellPatchInput {
  clear?: Scalars["Boolean"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  /** Existing Set callers continue to supply value; Clear must omit it. */
  value?: InputMaybe<DatabaseCellValueInput>;
}

/** A single row's worth of cell writes inside a bulk multi-field patch. */
export interface BulkDatabaseRowPatchInput {
  cells: Array<BulkDatabaseCellPatchInput>;
  rowId: Scalars["ID"]["input"];
}

/** A single `(row_id, position)` write inside a bulk reorder mutation. */
export interface BulkDatabaseRowPositionInput {
  position: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

/** Bulk soft-delete — many rows in one transaction. */
export interface BulkDeleteDatabaseRowsInput {
  databaseId: Scalars["ID"]["input"];
  /** P-DB-29B-C: per-row optimistic-lock precondition. */
  expectedEditRevisions?: InputMaybe<Array<BulkRowExpectedEditRevision>>;
  /** P-DB-29B-C: force every stale overwrite. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowIds: Array<Scalars["ID"]["input"]>;
}

/** Bulk restore — restore many soft-deleted rows in one transaction. */
export interface BulkRestoreDatabaseRowsInput {
  databaseId: Scalars["ID"]["input"];
  /** P-DB-29B-C: per-row optimistic-lock precondition. */
  expectedEditRevisions?: InputMaybe<Array<BulkRowExpectedEditRevision>>;
  /** P-DB-29B-C: force every stale overwrite. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowIds: Array<Scalars["ID"]["input"]>;
}

/** Atomic row precondition for bulk row mutations. */
export interface BulkRowExpectedEditRevision {
  expectedEditRevision: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

/**
 * Bulk cell set — set the same cell value on many rows in one atomic
 * transaction. Up to `DATABASE_BULK_MAX_ROWS_PER_OPERATION` rows are
 * accepted per call.
 */
export interface BulkSetDatabaseCellValueInput {
  databaseId: Scalars["ID"]["input"];
  fieldId: Scalars["ID"]["input"];
  /**
   * P-DB-29B-C: force overwrites every stale snapshot. Recorded in the
   * audit log per affected row.
   */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rows: Array<BulkSetDatabaseCellValueRowInput>;
}

/** A single `(row_id, value)` write inside a bulk cell-set mutation. */
export interface BulkSetDatabaseCellValueRowInput {
  /** P-DB-29B-C optimistic-lock precondition for this row. */
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  rowId: Scalars["ID"]["input"];
  value: DatabaseCellValueInput;
}

/** Bulk position rewrite — used by Kanban DnD and list reorder. */
export interface BulkUpdateDatabaseRowPositionsInput {
  databaseId: Scalars["ID"]["input"];
  /** P-DB-29B-C: per-row optimistic-lock precondition. */
  expectedEditRevisions?: InputMaybe<Array<BulkRowExpectedEditRevision>>;
  /** P-DB-29B-C: force every stale overwrite. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  updates: Array<BulkDatabaseRowPositionInput>;
}

/**
 * Result of `bumpBuilderVersion` — includes the new version and
 * the number of workspaces notified via `template:reconcile-needed` push.
 */
export interface BumpBuilderVersionResult {
  __typename?: "BumpBuilderVersionResult";
  newVersion: Scalars["Int"]["output"];
  slug: Scalars["String"]["output"];
  workspacesNotified: Scalars["Int"]["output"];
}

/** AF-PERF-D-03: Single hourly data point for the cache tuning history sparkline. */
export interface CacheTuningHistoryPoint {
  __typename?: "CacheTuningHistoryPoint";
  /** Start of the hourly bucket (UTC). */
  bucket: Scalars["DateTime"]["output"];
  /** Average hit rate in [0.0, 1.0] during this hour. */
  hitRate: Scalars["Float"]["output"];
  /** Recommended TTL in seconds at the end of this bucket. */
  ttlSeconds: Scalars["Int"]["output"];
}

/** P84-J-26: Per-cache tuning status returned by `adminCacheTuningStatus`. */
export interface CacheTuningStatusType {
  __typename?: "CacheTuningStatusType";
  /** Current effective TTL in seconds (may have been updated by tuning cycles). */
  currentTtlSeconds: Scalars["Int"]["output"];
  /**
   * Average hit rate over the last 1 hour (from `cache_tuning_metrics`).
   * `null` when no data is available yet.
   */
  hitRate1H: Maybe<Scalars["Float"]["output"]>;
  /** Average hit rate over the last 24 hours. */
  hitRate24H: Maybe<Scalars["Float"]["output"]>;
  /** Whether a fixed admin override is active (`cache.{name}_fixed_ttl_seconds` is set). */
  isFixedOverride: Scalars["Boolean"]["output"];
  /** Last tuning action taken (e.g. `"increased"`, `"decreased"`, `"unchanged"`, `"skipped"`). */
  lastAction: Maybe<Scalars["String"]["output"]>;
  /** When the last tuning action was recorded. */
  lastActionAt: Maybe<Scalars["DateTime"]["output"]>;
  /** Cache name (e.g. `"app_config"`, `"user_features"`). */
  name: Scalars["String"]["output"];
}

export interface CalendarAccountObjectType {
  __typename?: "CalendarAccountObjectType";
  calendars: Array<CalendarSubscriptionObjectType>;
  calendarsCount: Scalars["Int"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  displayName: Maybe<Scalars["String"]["output"]>;
  email: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  lastError: Maybe<Scalars["String"]["output"]>;
  provider: CalendarProviderType;
  providerAccountId: Scalars["String"]["output"];
  refreshIntervalMinutes: Scalars["Int"]["output"];
  status: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface CalendarAccountType {
  __typename?: "CalendarAccountType";
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  provider: Scalars["String"]["output"];
  remoteAccountId: Scalars["String"]["output"];
  userId: Scalars["ID"]["output"];
}

export interface CalendarCalDavProviderPresetObjectType {
  __typename?: "CalendarCalDAVProviderPresetObjectType";
  docsUrl: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  requiresAppPassword: Maybe<Scalars["Boolean"]["output"]>;
}

export interface CalendarEventInput {
  accountId: Scalars["String"]["input"];
  endsAt: Scalars["DateTime"]["input"];
  id?: InputMaybe<Scalars["String"]["input"]>;
  participants: Array<CalendarParticipantInput>;
  reminders: Array<CalendarReminderInput>;
  remoteEventId: Scalars["String"]["input"];
  /** Deprecated: use `sourceExternalId`. This alias carries the same workspace-local external key. */
  sourceDocId?: InputMaybe<Scalars["String"]["input"]>;
  sourceExternalId?: InputMaybe<Scalars["String"]["input"]>;
  startsAt: Scalars["DateTime"]["input"];
  title?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

/**
 * A materialized recurrence instance of a calendar event (P90-CAL-C-05).
 *
 * Each row represents one concrete occurrence of a recurring event.
 * Override instances (RECURRENCE-ID exceptions) carry field-level overrides
 * in `title`, `description`, and `location`.
 */
export interface CalendarEventInstanceType {
  __typename?: "CalendarEventInstanceType";
  /** Description from override_payload if present, otherwise from the parent event. */
  description: Maybe<Scalars["String"]["output"]>;
  eventId: Scalars["ID"]["output"];
  id: Scalars["ID"]["output"];
  instanceEnd: Scalars["DateTime"]["output"];
  instanceStart: Scalars["DateTime"]["output"];
  isCancelled: Scalars["Boolean"]["output"];
  isOverride: Scalars["Boolean"]["output"];
  /** Location from override_payload if present, otherwise from the parent event. */
  location: Maybe<Scalars["String"]["output"]>;
  /** Title from override_payload if present, otherwise from the parent event. */
  title: Maybe<Scalars["String"]["output"]>;
}

export interface CalendarEventObjectType {
  __typename?: "CalendarEventObjectType";
  allDay: Scalars["Boolean"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  endAtUtc: Scalars["DateTime"]["output"];
  externalEventId: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  location: Maybe<Scalars["String"]["output"]>;
  originalTimezone: Maybe<Scalars["String"]["output"]>;
  recurrenceId: Maybe<Scalars["String"]["output"]>;
  reminders: Array<CalendarReminderType>;
  startAtUtc: Scalars["DateTime"]["output"];
  status: Maybe<Scalars["String"]["output"]>;
  subscriptionId: Scalars["String"]["output"];
  tagId: Maybe<Scalars["String"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
}

/** Origin discriminator for a calendar event. */
export enum CalendarEventOrigin {
  External = "External",
  Native = "Native",
}

export interface CalendarEventParticipantType {
  __typename?: "CalendarEventParticipantType";
  displayName: Maybe<Scalars["String"]["output"]>;
  email: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  isOrganizer: Scalars["Boolean"]["output"];
  responseStatus: Scalars["String"]["output"];
  userId: Maybe<Scalars["ID"]["output"]>;
}

/** A user-defined label assignable to native calendar events. */
export interface CalendarEventTagType {
  __typename?: "CalendarEventTagType";
  color: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export interface CalendarEventType {
  __typename?: "CalendarEventType";
  accountId: Scalars["ID"]["output"];
  allDay: Scalars["Boolean"]["output"];
  allMembers: Scalars["Boolean"]["output"];
  descriptionDelta: Maybe<Scalars["JSON"]["output"]>;
  endsAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  /**
   * List materialized recurrence instances within `[from, to)`.
   *
   * For non-recurring events this returns an empty list.
   * Override instances (RECURRENCE-ID exceptions) carry overridden
   * title/description/location from the provider.
   */
  instances: Array<CalendarEventInstanceType>;
  origin: CalendarEventOrigin;
  participants: Array<CalendarEventParticipantType>;
  /**
   * Native masters reference one canonical timing definition. Imported source
   * remains inspectable but cannot be authored through the native rule form.
   */
  recurrence: Maybe<CalendarRecurrence>;
  /** Original exception key, independent of the displayed/moved start. */
  recurrenceId: Maybe<Scalars["DateTime"]["output"]>;
  recurrenceParentId: Maybe<Scalars["ID"]["output"]>;
  reminders: Array<CalendarReminderType>;
  remoteEventId: Scalars["String"]["output"];
  /**
   * Deprecated same-value alias for `sourceExternalId`.
   * @deprecated use sourceExternalId
   */
  sourceDocId: Maybe<Scalars["ID"]["output"]>;
  sourceExternalId: Maybe<Scalars["ID"]["output"]>;
  startsAt: Scalars["DateTime"]["output"];
  tagId: Maybe<Scalars["ID"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
  workspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface CalendarEventTypeInstancesArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
}

/** A single free/busy period (P90-CAL-H-07). */
export interface CalendarFreeBusyPeriod {
  __typename?: "CalendarFreeBusyPeriod";
  /** End of the busy period. */
  end: Scalars["DateTime"]["output"];
  /** Start of the busy period. */
  start: Scalars["DateTime"]["output"];
}

/** Result of `importWorkspaceCalendarIcs` (P-JCAL-SERVER-07-B). */
export interface CalendarIcsImportResult {
  __typename?: "CalendarIcsImportResult";
  /** Per-event error messages for skipped events. */
  errors: Array<Scalars["String"]["output"]>;
  /** Number of VEVENTs successfully imported as native events. */
  importedCount: Scalars["Int"]["output"];
  /** Number of VEVENTs skipped due to validation or parse errors. */
  skippedCount: Scalars["Int"]["output"];
}

export interface CalendarParticipantInput {
  displayName?: InputMaybe<Scalars["String"]["input"]>;
  email: Scalars["String"]["input"];
  isOrganizer?: InputMaybe<Scalars["Boolean"]["input"]>;
  responseStatus?: InputMaybe<Scalars["String"]["input"]>;
  userId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface CalendarProviderRequestErrorDataType {
  __typename?: "CalendarProviderRequestErrorDataType";
  message: Scalars["String"]["output"];
  status: Scalars["Int"]["output"];
}

export enum CalendarProviderType {
  CalDAV = "CalDAV",
  Google = "Google",
}

export interface CalendarRecurrence {
  __typename?: "CalendarRecurrence";
  endsBefore: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  lifecycle: RecurrenceLifecycle;
  pausedAt: Maybe<Scalars["DateTime"]["output"]>;
  readOnly: Scalars["Boolean"]["output"];
  revision: Scalars["Int"]["output"];
  rule: Maybe<RecurrenceRule>;
  sourceRrule: Maybe<Scalars["String"]["output"]>;
  unsupportedReason: Maybe<Scalars["String"]["output"]>;
  zone: Scalars["String"]["output"];
}

export interface CalendarReminderInput {
  channel?: InputMaybe<Scalars["String"]["input"]>;
  minutesBefore: Scalars["Int"]["input"];
  scheduledFor: Scalars["DateTime"]["input"];
}

export interface CalendarReminderStatusResult {
  __typename?: "CalendarReminderStatusResult";
  ok: Scalars["Boolean"]["output"];
}

export interface CalendarReminderType {
  __typename?: "CalendarReminderType";
  channel: Scalars["String"]["output"];
  deliveredAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  minutesBefore: Scalars["Int"]["output"];
  scheduledFor: Scalars["DateTime"]["output"];
}

/** RSVP status for a calendar event participant (P90-CAL-H-04). */
export enum CalendarRsvpStatus {
  /** Attendee has accepted the invitation. */
  Accepted = "Accepted",
  /** Attendee has declined the invitation. */
  Declined = "Declined",
  /** Attendee has not yet responded. */
  NeedsAction = "NeedsAction",
  /** Attendee is tentatively accepting. */
  Tentative = "Tentative",
}

export interface CalendarSubscriptionObjectType {
  __typename?: "CalendarSubscriptionObjectType";
  accountId: Scalars["String"]["output"];
  color: Maybe<Scalars["String"]["output"]>;
  displayName: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  externalCalendarId: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  lastSyncAt: Maybe<Scalars["DateTime"]["output"]>;
  provider: CalendarProviderType;
  timezone: Maybe<Scalars["String"]["output"]>;
}

export enum CalendarTimingAction {
  End = "End",
  Pause = "Pause",
  Resume = "Resume",
}

/** Sort order for Copilot chat history queries. */
export enum ChatHistoryOrder {
  asc = "asc",
  desc = "desc",
}

/** A single message in a Copilot conversation. */
export interface ChatMessage {
  __typename?: "ChatMessage";
  attachments: Maybe<Array<Scalars["String"]["output"]>>;
  content: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  generatedFiles: Array<CopilotGeneratedFileType>;
  id: Maybe<Scalars["ID"]["output"]>;
  params: Maybe<Scalars["JSON"]["output"]>;
  role: Scalars["String"]["output"];
  streamObjects: Maybe<Array<StreamObject>>;
}

export interface ClearDatabaseCellValueInput {
  databaseId: Scalars["ID"]["input"];
  /** P-DB-29B-C optimistic-lock precondition. */
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  /** P-DB-29B-C: force the clear even when the precondition fails. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowId: Scalars["ID"]["input"];
}

export interface ClientUpdateCompletion {
  __typename?: "ClientUpdateCompletion";
  action: ClientUpdateCompletionAction;
  operationId: Scalars["ID"]["output"];
}

export enum ClientUpdateCompletionAction {
  none = "none",
  reload = "reload",
  reset_local_cache = "reset_local_cache",
}

export interface ClientUpdateControlV1 {
  __typename?: "ClientUpdateControlV1";
  cacheEpoch: Scalars["Int"]["output"];
  completion: Maybe<ClientUpdateCompletion>;
  maxAttempts: Maybe<Scalars["Int"]["output"]>;
  operationId: Maybe<Scalars["ID"]["output"]>;
  phase: ClientUpdatePhase;
  requiredWebBuildId: Maybe<Scalars["String"]["output"]>;
  retryAfterMs: Maybe<Scalars["Int"]["output"]>;
  schemaVersion: Scalars["Int"]["output"];
  stateId: Scalars["ID"]["output"];
  updatedAt: Scalars["String"]["output"];
}

export enum ClientUpdatePhase {
  failed = "failed",
  limited = "limited",
  normal = "normal",
  suspended = "suspended",
}

export interface ColorSchemaValuePatchInput {
  mode: Scalars["String"]["input"];
  tokenKey: Scalars["String"]["input"];
  value: Scalars["String"]["input"];
}

/** Action type for a comment change event (used in change-log / SSE feeds). */
export enum CommentChangeActionType {
  Create = "Create",
  Delete = "Delete",
  Update = "Update",
}

/** A single comment change event in the change log. */
export interface CommentChangeObjectType {
  __typename?: "CommentChangeObjectType";
  action: CommentChangeActionType;
  /** UUID of the comment that was changed. */
  commentId: Maybe<Scalars["ID"]["output"]>;
  /** UUID of the change event. */
  id: Scalars["ID"]["output"];
  /** Full comment payload at the time of the change. */
  item: Scalars["JSON"]["output"];
}

/** Cursor-based edge for a comment change list. */
export interface CommentChangeObjectTypeEdge {
  __typename?: "CommentChangeObjectTypeEdge";
  cursor: Scalars["String"]["output"];
  node: CommentChangeObjectType;
}

/** Input for creating a new top-level comment on a document. */
export interface CommentCreateInput {
  /** Rich-text body (Virgultum JSON format). */
  content: Scalars["JSON"]["input"];
  /** UUID of the document to comment on. */
  docId: Scalars["String"]["input"];
  /** UUID of the workspace containing the document. */
  workspaceId: Scalars["String"]["input"];
}

/** A historical snapshot of a comment body from before it was edited. */
export interface CommentEditHistoryType {
  __typename?: "CommentEditHistoryType";
  /** Body content at the time of this snapshot. */
  body: Scalars["JSON"]["output"];
  /** UUID of the comment that was edited. */
  commentId: Scalars["ID"]["output"];
  /** When the edit was recorded. */
  editedAt: Scalars["DateTime"]["output"];
  /** UUID of this history entry. */
  id: Scalars["ID"]["output"];
}

/** A top-level document comment with its nested replies. */
export interface CommentObjectType {
  __typename?: "CommentObjectType";
  content: Scalars["JSON"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  parentCommentId: Maybe<Scalars["ID"]["output"]>;
  replies: Array<ReplyObjectType>;
  resolved: Scalars["Boolean"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  user: PublicUserType;
}

/** Cursor-based edge for a paginated comment list. */
export interface CommentObjectTypeEdge {
  __typename?: "CommentObjectTypeEdge";
  cursor: Scalars["String"]["output"];
  node: CommentObjectType;
}

/** Input for changing the resolved state of a comment. */
export interface CommentResolveInput {
  /** UUID of the comment. */
  id: Scalars["String"]["input"];
  /** `true` to mark as resolved, `false` to reopen. */
  resolved: Scalars["Boolean"]["input"];
}

/** Filter for listing comment threads on a document. */
export enum CommentThreadFilter {
  /** All threads regardless of status. */
  All = "All",
  /** Only threads the current user is involved in. */
  Mine = "Mine",
  /** Only open (unresolved) threads. */
  Open = "Open",
  /** Only resolved threads. */
  Resolved = "Resolved",
}

export interface CommentType {
  __typename?: "CommentType";
  authorId: Scalars["ID"]["output"];
  body: Scalars["JSON"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  docId: Scalars["ID"]["output"];
  id: Scalars["ID"]["output"];
  parentCommentId: Maybe<Scalars["ID"]["output"]>;
  resolved: Scalars["Boolean"]["output"];
  /** Whether the requesting user has unread activity in this thread. */
  unread: Scalars["Boolean"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

/** Input for updating the body of an existing comment. */
export interface CommentUpdateInput {
  /** New rich-text body. */
  content: Scalars["JSON"]["input"];
  /** UUID of the comment to update. */
  id: Scalars["String"]["input"];
}

export interface CompletionRecurrenceInput {
  amount: Scalars["Int"]["input"];
  unit: RecurrenceRelativeUnit;
  zone: Scalars["String"]["input"];
}

export interface ConfigChangelogEntryType {
  __typename?: "ConfigChangelogEntryType";
  changedAt: Scalars["DateTime"]["output"];
  changedBy: Maybe<UserType>;
  configKey: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  newValue: Scalars["JSON"]["output"];
  oldValue: Maybe<Scalars["JSON"]["output"]>;
}

export interface ConfigureGitTokenRotationInput {
  enabled: Scalars["Boolean"]["input"];
  profileId: Scalars["String"]["input"];
  provider: GitTokenRotationProvider;
  renewBeforeDays: Scalars["Int"]["input"];
  requestedLifetimeDays: Scalars["Int"]["input"];
}

export interface ConfigureTaskPreparationInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  enabled: Scalars["Boolean"]["input"];
  expectedExecutionRevision?: InputMaybe<Scalars["Int"]["input"]>;
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  planDigest: Scalars["String"]["input"];
  ruleId?: InputMaybe<Scalars["ID"]["input"]>;
  target: ContextDocumentTargetInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface ConfigureTaskRecurrenceInput {
  databaseId: Scalars["ID"]["input"];
  expectedDueRevision: Scalars["Int"]["input"];
  expectedRowRevision: Scalars["Int"]["input"];
  recipe: TaskRecurrenceRecipeInput;
  rowId: Scalars["ID"]["input"];
  rule: RecurrenceRuleInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface ConfirmTaskCorrectionsInput {
  outcome: TaskCorrectionOutcome;
  proposalDigest: Scalars["String"]["input"];
  requestId: Scalars["ID"]["input"];
  runId: Scalars["ID"]["input"];
  waitId: Scalars["String"]["input"];
}

/** Resolution strategy for a calendar conflict. */
export enum ConflictResolution {
  /** Overwrite the remote with our local version. */
  KeepLocal = "KeepLocal",
  /** Discard our local changes and use the remote version. */
  KeepRemote = "KeepRemote",
  /** Attempt an automatic three-way merge. */
  MergeAuto = "MergeAuto",
}

/** These names come from the current authorized target, never a receipt cache. */
export interface ContextDocumentContext {
  __typename?: "ContextDocumentContext";
  containerTitle: Scalars["String"]["output"];
  taskTitle: Maybe<Scalars["String"]["output"]>;
}

export interface ContextDocumentTarget {
  __typename?: "ContextDocumentTarget";
  databaseId: Scalars["ID"]["output"];
  taskId: Maybe<Scalars["ID"]["output"]>;
}

export interface ContextDocumentTargetInput {
  databaseId: Scalars["ID"]["input"];
  taskId?: InputMaybe<Scalars["ID"]["input"]>;
}

/**
 * Current authorized links are distinct from retained reserved identities.
 * Readback never resumes creation or republishes a stored document snapshot.
 */
export interface ContextDocuments {
  __typename?: "ContextDocuments";
  acceptedDescriptor: Maybe<AssistantPackage>;
  acceptedPlan: PreparedContextDocuments;
  assistance: EffectiveAssistanceType;
  canRetry: Scalars["Boolean"]["output"];
  canStop: Scalars["Boolean"]["output"];
  currentReview: Maybe<PreparedContextDocuments>;
  documents: Array<ProjectSetupDocument>;
  folderId: Scalars["String"]["output"];
  placementComplete: Scalars["Boolean"]["output"];
  reasonCode: Maybe<Scalars["String"]["output"]>;
  requestId: Scalars["ID"]["output"];
  run: Maybe<WorkspaceAutomationRunType>;
  status: ProjectSetupStatus;
}

export interface ContextDocumentsPreparation {
  __typename?: "ContextDocumentsPreparation";
  assistance: EffectiveAssistanceType;
  context: ContextDocumentContext;
  plan: PreparedContextDocuments;
}

export enum ContextEmbedStatus {
  failed = "failed",
  finished = "finished",
  processing = "processing",
}

export interface ContextWorkspaceEmbeddingStatus {
  __typename?: "ContextWorkspaceEmbeddingStatus";
  available: Scalars["Boolean"]["output"];
  embedded: Scalars["Int"]["output"];
  error: Maybe<Scalars["String"]["output"]>;
  status: ContextEmbedStatus;
  total: Scalars["Int"]["output"];
}

export interface CopilotContext {
  __typename?: "CopilotContext";
  blobs: Array<CopilotContextBlob>;
  collections: Array<CopilotContextCategory>;
  createdAt: Scalars["Int"]["output"];
  docs: Array<CopilotContextDoc>;
  files: Array<CopilotContextFile>;
  id: Scalars["String"]["output"];
  /**
   * Search workspace file embeddings by semantic similarity.
   *
   * Query the productive index through the shared configured embedding port.
   * Only finished, selected source identities are eligible; unavailable
   * retrieval is an explicit error, not a successful empty search.
   */
  matchFiles: Array<CopilotContextMatchedFile>;
  /**
   * Search workspace document embeddings by semantic similarity.
   *
   * Search the productive document index for the configured embedding model;
   * current selection, ignored documents and live ACLs still bound results.
   */
  matchWorkspaceDocs: Array<CopilotContextMatchedDoc>;
  name: Scalars["String"]["output"];
  tags: Array<CopilotContextCategory>;
  workspaceId: Maybe<Scalars["String"]["output"]>;
}

export interface CopilotContextMatchFilesArgs {
  content: Scalars["String"]["input"];
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  scopedThreshold?: InputMaybe<Scalars["Float"]["input"]>;
  threshold?: InputMaybe<Scalars["Float"]["input"]>;
}

export interface CopilotContextMatchWorkspaceDocsArgs {
  content: Scalars["String"]["input"];
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  scopedThreshold?: InputMaybe<Scalars["Float"]["input"]>;
  threshold?: InputMaybe<Scalars["Float"]["input"]>;
}

export interface CopilotContextBlob {
  __typename?: "CopilotContextBlob";
  createdAt: Scalars["Int"]["output"];
  id: Scalars["String"]["output"];
  status: Maybe<ContextEmbedStatus>;
}

export interface CopilotContextCategory {
  __typename?: "CopilotContextCategory";
  createdAt: Scalars["Int"]["output"];
  docs: Array<CopilotContextDoc>;
  id: Scalars["String"]["output"];
  type: Scalars["String"]["output"];
}

export interface CopilotContextDoc {
  __typename?: "CopilotContextDoc";
  createdAt: Scalars["Int"]["output"];
  id: Scalars["String"]["output"];
  status: Maybe<ContextEmbedStatus>;
}

export interface CopilotContextFile {
  __typename?: "CopilotContextFile";
  blobId: Scalars["String"]["output"];
  chunkSize: Scalars["Int"]["output"];
  createdAt: Scalars["Int"]["output"];
  error: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  mimeType: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  status: ContextEmbedStatus;
}

export interface CopilotContextFileNotSupportedDataType {
  __typename?: "CopilotContextFileNotSupportedDataType";
  fileName: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
}

/** Match result for vector/embedding search. */
export interface CopilotContextMatchedDoc {
  __typename?: "CopilotContextMatchedDoc";
  /** Chunk index from the embedding record. */
  chunk: Scalars["Int"]["output"];
  content: Scalars["String"]["output"];
  /** Cosine distance exposed as `distance` for client compatibility. */
  distance: Scalars["Float"]["output"];
  docId: Scalars["String"]["output"];
}

/** Match result for file search. */
export interface CopilotContextMatchedFile {
  __typename?: "CopilotContextMatchedFile";
  /** Original blob ID from the file record. */
  blobId: Scalars["String"]["output"];
  /** Chunk index from the embedding record. */
  chunk: Scalars["Int"]["output"];
  content: Scalars["String"]["output"];
  /** Cosine distance exposed as `distance` for client compatibility. */
  distance: Scalars["Float"]["output"];
  fileId: Scalars["String"]["output"];
  /** MIME type from the file record. */
  mimeType: Scalars["String"]["output"];
  /** File name from the file record. */
  name: Scalars["String"]["output"];
}

export interface CopilotDocNotFoundDataType {
  __typename?: "CopilotDocNotFoundDataType";
  docId: Scalars["String"]["output"];
}

export enum CopilotExportFormat {
  HTML = "HTML",
  PDF = "PDF",
}

export interface CopilotFailedToAddWorkspaceFileEmbeddingDataType {
  __typename?: "CopilotFailedToAddWorkspaceFileEmbeddingDataType";
  message: Scalars["String"]["output"];
}

export interface CopilotFailedToGenerateEmbeddingDataType {
  __typename?: "CopilotFailedToGenerateEmbeddingDataType";
  message: Scalars["String"]["output"];
  provider: Scalars["String"]["output"];
}

export interface CopilotFailedToMatchContextDataType {
  __typename?: "CopilotFailedToMatchContextDataType";
  content: Scalars["String"]["output"];
  contextId: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
}

export interface CopilotFailedToMatchGlobalContextDataType {
  __typename?: "CopilotFailedToMatchGlobalContextDataType";
  content: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
  workspaceId: Scalars["String"]["output"];
}

export interface CopilotFailedToModifyContextDataType {
  __typename?: "CopilotFailedToModifyContextDataType";
  contextId: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
}

export interface CopilotGeneratedFileType {
  __typename?: "CopilotGeneratedFileType";
  downloadUrl: Scalars["String"]["output"];
  fileName: Scalars["String"]["output"];
  format: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  mimeType: Scalars["String"]["output"];
  sizeBytes: Scalars["Int"]["output"];
}

/** A full Copilot session record including all messages. */
export interface CopilotHistories {
  __typename?: "CopilotHistories";
  action: Maybe<Scalars["String"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  docId: Maybe<Scalars["String"]["output"]>;
  messages: Array<ChatMessage>;
  model: Scalars["String"]["output"];
  optionalModels: Array<Scalars["String"]["output"]>;
  parentSessionId: Maybe<Scalars["String"]["output"]>;
  pinned: Scalars["Boolean"]["output"];
  promptName: Scalars["String"]["output"];
  sessionId: Scalars["String"]["output"];
  title: Maybe<Scalars["String"]["output"]>;
  tokens: Scalars["Int"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["String"]["output"];
}

/** Cursor-based edge for a Copilot history record. */
export interface CopilotHistoriesTypeEdge {
  __typename?: "CopilotHistoriesTypeEdge";
  /** Opaque pagination cursor. */
  cursor: Scalars["String"]["output"];
  node: CopilotHistories;
}

/** Minimal ignored doc entry for allIgnoredDocs. */
export interface CopilotIgnoredDocBasic {
  __typename?: "CopilotIgnoredDocBasic";
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  docId: Scalars["String"]["output"];
}

/** Edge wrapper for paginated ignored doc results. */
export interface CopilotIgnoredDocEdge {
  __typename?: "CopilotIgnoredDocEdge";
  node: CopilotIgnoredDocNode;
}

/** A single ignored doc entry with metadata. */
export interface CopilotIgnoredDocNode {
  __typename?: "CopilotIgnoredDocNode";
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  createdBy: Maybe<Scalars["String"]["output"]>;
  createdByAvatar: Maybe<Scalars["String"]["output"]>;
  docCreatedAt: Maybe<Scalars["DateTime"]["output"]>;
  docId: Scalars["String"]["output"];
  docUpdatedAt: Maybe<Scalars["DateTime"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
  updatedBy: Maybe<Scalars["String"]["output"]>;
}

export interface CopilotInvalidContextDataType {
  __typename?: "CopilotInvalidContextDataType";
  contextId: Scalars["String"]["output"];
}

export interface CopilotMessageNotFoundDataType {
  __typename?: "CopilotMessageNotFoundDataType";
  messageId: Scalars["String"]["output"];
}

/** A single Copilot AI model descriptor. */
export interface CopilotModelType {
  __typename?: "CopilotModelType";
  /** Model identifier string (e.g. `"gpt-4o"`). */
  id: Scalars["String"]["output"];
  /** Human-readable model name. */
  name: Scalars["String"]["output"];
  /** An enabled configured provider can honor both explicit reasoning states. */
  reasoningAvailable: Scalars["Boolean"]["output"];
  /** At least one enabled configured provider preserves actual image input. */
  supportsVision: Scalars["Boolean"]["output"];
}

/** Available Copilot models for a workspace. */
export interface CopilotModelsType {
  __typename?: "CopilotModelsType";
  /** The default model ID selected for new sessions. */
  defaultModel: Scalars["String"]["output"];
  /** Optional models the user can switch to. */
  optionalModels: Array<CopilotModelType>;
  /** Retained empty protocol field; no access or plan semantics. */
  proModels: Array<CopilotModelType>;
}

export interface CopilotPromptNotFoundDataType {
  __typename?: "CopilotPromptNotFoundDataType";
  message: Scalars["String"]["output"];
}

export interface CopilotProviderNotSupportedDataType {
  __typename?: "CopilotProviderNotSupportedDataType";
  message: Scalars["String"]["output"];
}

export interface CopilotProviderSideErrorDataType {
  __typename?: "CopilotProviderSideErrorDataType";
  message: Scalars["String"]["output"];
}

/** Copilot usage quota (stub; always returns fixed values in the current implementation). */
export interface CopilotQuotaType {
  __typename?: "CopilotQuotaType";
  /** Maximum number of Copilot tokens/requests allowed. */
  limit: Scalars["Int"]["output"];
  /** Number of tokens/requests consumed. */
  used: Scalars["Int"]["output"];
}

export interface CopilotType {
  __typename?: "CopilotType";
  /**
   * List audio transcription jobs.
   *
   * P25-A-45: `copilot(workspaceId) { audioTranscription(jobId?, blobId?) }`
   */
  audioTranscription: Array<TranscriptionResultType>;
  chats: PaginatedCopilotHistoriesType;
  /**
   * List copilot contexts, optionally filtered by session or context ID.
   *
   * P25-A-28/29: `copilot { contexts(sessionId, contextId) }`
   */
  contexts: Array<CopilotContext>;
  models: CopilotModelsType;
  quota: CopilotQuotaType;
  /**
   * Token usage — same shape as quota. The web frontend's currentUser profile
   * fragment queries `copilot { tokens { limit used } }`.
   */
  tokens: CopilotQuotaType;
}

export interface CopilotTypeAudioTranscriptionArgs {
  blobId?: InputMaybe<Scalars["String"]["input"]>;
  jobId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface CopilotTypeChatsArgs {
  docId?: InputMaybe<Scalars["String"]["input"]>;
  options?: InputMaybe<QueryChatHistoriesInput>;
  pagination: PaginationInput;
}

export interface CopilotTypeContextsArgs {
  contextId?: InputMaybe<Scalars["String"]["input"]>;
  sessionId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface CopilotTypeModelsArgs {
  promptName: Scalars["String"]["input"];
}

export interface CopilotWorkspaceFile {
  __typename?: "CopilotWorkspaceFile";
  blobId: Scalars["String"]["output"];
  /** File creation timestamp in UTC. */
  createdAt: Scalars["DateTime"]["output"];
  fileId: Scalars["String"]["output"];
  fileName: Scalars["String"]["output"];
  mimeType: Scalars["String"]["output"];
  /** File size in bytes (default 0). */
  size: Scalars["Int"]["output"];
  /** Workspace ID that owns this file. */
  workspaceId: Scalars["String"]["output"];
}

/** Edge wrapper for paginated workspace file results. */
export interface CopilotWorkspaceFileEdge {
  __typename?: "CopilotWorkspaceFileEdge";
  node: CopilotWorkspaceFile;
}

/** Input for sending a new message to a Copilot session. */
export interface CreateChatMessageInput {
  /** Optional list of blob keys attached to the message. */
  attachments?: InputMaybe<Array<Scalars["String"]["input"]>>;
  /** Text content of the message. */
  content?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Prompt parameters. Server request/anchor/lease fields are reserved and
   * cannot be authored here; request correlation has its own input field.
   */
  params?: InputMaybe<Scalars["JSON"]["input"]>;
  /** Stable correlation for one explicit send, not a client-owned stream lease. */
  requestId?: InputMaybe<Scalars["String"]["input"]>;
  /** Session to post the message to. */
  sessionId: Scalars["String"]["input"];
}

/** Input for creating a new Copilot chat session. */
export interface CreateChatSessionInput {
  docId?: InputMaybe<Scalars["String"]["input"]>;
  pinned?: InputMaybe<Scalars["Boolean"]["input"]>;
  promptName: Scalars["String"]["input"];
  reuseLatestChat?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface CreateCheckoutSessionInput {
  args?: InputMaybe<Scalars["JSON"]["input"]>;
  coupon?: InputMaybe<Scalars["String"]["input"]>;
  idempotencyKey?: InputMaybe<Scalars["String"]["input"]>;
  plan?: InputMaybe<SubscriptionPlanType>;
  recurring?: InputMaybe<SubscriptionRecurringType>;
  successCallbackLink: Scalars["String"]["input"];
  variant?: InputMaybe<SubscriptionVariantType>;
}

export interface CreateDatabaseFieldInput {
  config?: InputMaybe<DatabaseFieldConfigInput>;
  databaseId: Scalars["ID"]["input"];
  fieldType: DatabaseFieldKind;
  name: Scalars["String"]["input"];
  required?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface CreateDatabaseFromTemplateInput {
  assistantConfirmation?: InputMaybe<ProjectAssistantConfirmationInput>;
  complexityPreset?: InputMaybe<ProjectOptionPreset>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  includeSampleRows?: InputMaybe<Scalars["Boolean"]["input"]>;
  priorityPreset?: InputMaybe<ProjectOptionPreset>;
  structurePreset?: InputMaybe<ProjectStructurePreset>;
  templateId: Scalars["String"]["input"];
  title: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface CreateDatabaseInput {
  description?: InputMaybe<Scalars["String"]["input"]>;
  initialViewKind?: InputMaybe<InitialDatabaseViewKind>;
  title: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface CreateDatabaseRowCellInput {
  fieldId: Scalars["ID"]["input"];
  value: DatabaseCellValueInput;
}

export interface CreateDatabaseRowContentDocumentInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface CreateDatabaseRowFromTemplateInput {
  bodyInputs?: InputMaybe<Scalars["JSON"]["input"]>;
  databaseId: Scalars["ID"]["input"];
  overrideCellValues?: InputMaybe<Array<CreateDatabaseRowCellInput>>;
  rowTemplateId: Scalars["ID"]["input"];
  sourceRevision?: InputMaybe<Scalars["String"]["input"]>;
  title?: InputMaybe<Scalars["String"]["input"]>;
}

export interface CreateDatabaseRowInput {
  cells?: InputMaybe<Array<CreateDatabaseRowCellInput>>;
  databaseId: Scalars["ID"]["input"];
  expectedViewEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  title?: InputMaybe<Scalars["String"]["input"]>;
  /** Optional selected View and its opening revision; both must be supplied together. */
  viewId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface CreateDatabaseRowTemplateInput {
  databaseId: Scalars["ID"]["input"];
  description?: InputMaybe<Scalars["String"]["input"]>;
  enabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  initialCellValues?: InputMaybe<Array<CreateDatabaseRowCellInput>>;
  isDefault?: InputMaybe<Scalars["Boolean"]["input"]>;
  name: Scalars["String"]["input"];
  position?: InputMaybe<Scalars["Int"]["input"]>;
  rowKind?: InputMaybe<Scalars["String"]["input"]>;
  templateId: Scalars["ID"]["input"];
}

export interface CreateDatabaseTaskFromSourceInput {
  blockId?: InputMaybe<Scalars["String"]["input"]>;
  cells?: InputMaybe<Array<CreateDatabaseRowCellInput>>;
  databaseId: Scalars["ID"]["input"];
  requestId: Scalars["ID"]["input"];
  selectionAnchor?: InputMaybe<Scalars["String"]["input"]>;
  sourceDocumentId: Scalars["ID"]["input"];
  sourceExternalId: Scalars["ID"]["input"];
  title: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface CreateDatabaseViewInput {
  config: DatabaseViewConfigInput;
  databaseId: Scalars["ID"]["input"];
  icon?: InputMaybe<DatabaseViewIconInput>;
  name: Scalars["String"]["input"];
  viewKind: DatabaseViewKind;
}

/** Input for creating a workspace event tag. */
export interface CreateEventTagInput {
  color: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

/**
 * Input for `createOrganizationProject` — the manager-scoped
 * project request entry-point.
 */
export interface CreateOrganizationProjectInput {
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  /**
   * `null` = root-level project (uses `manager_root_project_creation`
   * policy). Otherwise an existing OU id (uses
   * `manager_unit_project_creation` policy).
   */
  parentUnitId?: InputMaybe<Scalars["ID"]["input"]>;
  /** Optional list of additional members to seed into the new OU. */
  proposedMembers?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  proposedName: Scalars["String"]["input"];
  /**
   * OU type to assign — must be `can_be_manager_created`. Resolver
   * checks the type's flags before persisting.
   */
  proposedTypeId?: InputMaybe<Scalars["ID"]["input"]>;
  /**
   * If `true`, the request signals that an associated workspace should
   * be created alongside the OU (admin discretion at decide-time).
   */
  proposedWorkspace?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface CreateProjectInput {
  complexityPreset?: InputMaybe<ProjectOptionPreset>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  priorityPreset?: InputMaybe<ProjectOptionPreset>;
  structurePreset?: InputMaybe<ProjectStructurePreset>;
  title: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface CreateUserInput {
  email: Scalars["String"]["input"];
  name?: InputMaybe<Scalars["String"]["input"]>;
  password?: InputMaybe<Scalars["String"]["input"]>;
}

export interface CreateWorkspaceAutomationInput {
  actions: Array<WorkspaceAutomationActionDefinitionInput>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  name: Scalars["String"]["input"];
  trigger: WorkspaceAutomationTriggerInput;
  workspaceId: Scalars["ID"]["input"];
}

/** Input for creating a workspace-native calendar event. */
export interface CreateWorkspaceEventInput {
  allDay?: InputMaybe<Scalars["Boolean"]["input"]>;
  allMembers?: InputMaybe<Scalars["Boolean"]["input"]>;
  descriptionDelta?: InputMaybe<Scalars["JSON"]["input"]>;
  endsAt: Scalars["DateTime"]["input"];
  recurrence?: InputMaybe<FixedRecurrenceInput>;
  reminders?: InputMaybe<Array<NativeReminderInput>>;
  sourceBlockId?: InputMaybe<Scalars["String"]["input"]>;
  /** Deprecated: use `sourceExternalId`. This alias carries the same workspace-local external key. */
  sourceDocId?: InputMaybe<Scalars["String"]["input"]>;
  sourceEndOffset?: InputMaybe<Scalars["Int"]["input"]>;
  sourceExternalId?: InputMaybe<Scalars["String"]["input"]>;
  sourceKind?: InputMaybe<Scalars["String"]["input"]>;
  sourceStartOffset?: InputMaybe<Scalars["Int"]["input"]>;
  startsAt: Scalars["DateTime"]["input"];
  tagId?: InputMaybe<Scalars["String"]["input"]>;
  title?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

/**
 * Input for `createWorkspaceInOrganizationUnit` — the manager-scoped
 * workspace-creation entry-point. Creates an OU-owned shared workspace and
 * grants the caller an Admin membership.
 */
export interface CreateWorkspaceInOrganizationUnitInput {
  /**
   * Deprecated client-supplied Yjs state. Shared workspace roots are always
   * generated authoritatively by the server from the final workspace name.
   */
  initDataB64?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Optional workspace name. Omitted names retain the compatible server
   * default.
   */
  name?: InputMaybe<Scalars["String"]["input"]>;
  unitId: Scalars["ID"]["input"];
}

export interface CreateWorkspaceInput {
  admissionConfirmation?: InputMaybe<Scalars["String"]["input"]>;
  assistanceMode: AssistanceMode;
  assistantConfirmation: WorkspaceAssistantConfirmationInput;
  initialContent: WorkspaceInitialContent;
  name: Scalars["String"]["input"];
  project?: InputMaybe<WorkspaceProjectSetupInput>;
  requestId: Scalars["ID"]["input"];
  setup?: InputMaybe<WorkspaceSetupInput>;
}

export interface CreateWorkspaceTagInput {
  colorRole: Scalars["String"]["input"];
  description?: InputMaybe<Scalars["String"]["input"]>;
  name: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

/** GraphQL output type for a newly created API key (includes plaintext key, shown once). */
export interface CreatedApiKeyType {
  __typename?: "CreatedApiKeyType";
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["String"]["output"];
  /** Plaintext key — shown exactly once. Store it securely. */
  key: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  scopes: Array<Scalars["String"]["output"]>;
}

/** Password policy constraints included in server config. */
export interface CredentialsRequirementType {
  __typename?: "CredentialsRequirementType";
  password: PasswordLimitsType;
}

export interface DatabaseActivityEvent {
  __typename?: "DatabaseActivityEvent";
  actorDisplayName: Maybe<Scalars["String"]["output"]>;
  actorUserId: Maybe<Scalars["ID"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  databaseId: Scalars["ID"]["output"];
  eventType: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  payload: Scalars["JSON"]["output"];
  rowId: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseActivityFilterInput {
  actorUserId?: InputMaybe<Scalars["ID"]["input"]>;
  databaseId?: InputMaybe<Scalars["ID"]["input"]>;
  eventTypes?: InputMaybe<Array<Scalars["String"]["input"]>>;
  from?: InputMaybe<Scalars["DateTime"]["input"]>;
  rowId?: InputMaybe<Scalars["ID"]["input"]>;
  to?: InputMaybe<Scalars["DateTime"]["input"]>;
}

/**
 * Aggregate result of a bulk operation. The `succeeded` and `failed` lists
 * together cover every requested row exactly once so the client can render
 * a structured toast (e.g. "3 of 12 updated, 9 failed: cell invalid")
 * without re-deriving counts.
 */
export interface DatabaseBulkOperationResult {
  __typename?: "DatabaseBulkOperationResult";
  failed: Array<DatabaseBulkRowOutcome>;
  failureCount: Scalars["Int"]["output"];
  succeeded: Array<Scalars["ID"]["output"]>;
  successCount: Scalars["Int"]["output"];
  total: Scalars["Int"]["output"];
  transactionCommitted: Scalars["Boolean"]["output"];
}

/**
 * Per-row diagnostic entry for a bulk operation. Either `success` is `true`
 * (and `errorCode` / `errorMessage` are `None`) or `success` is `false` and
 * the failure carries a structured `MIX_DATABASE_*` code.
 */
export interface DatabaseBulkRowOutcome {
  __typename?: "DatabaseBulkRowOutcome";
  errorCode: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  rowId: Scalars["ID"]["output"];
  success: Scalars["Boolean"]["output"];
}

export enum DatabaseCalendarDateMode {
  Day = "Day",
  Month = "Month",
  Week = "Week",
  Year = "Year",
}

export enum DatabaseCalendarInitialRange {
  CurrentMonth = "CurrentMonth",
  CurrentWeek = "CurrentWeek",
  CurrentYear = "CurrentYear",
  Today = "Today",
}

export interface DatabaseCalendarViewConfigInput {
  dateFieldId: Scalars["ID"]["input"];
  dateMode?: InputMaybe<DatabaseCalendarDateMode>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  group?: InputMaybe<DatabaseGroupRuleInput>;
  initialRange?: InputMaybe<DatabaseCalendarInitialRange>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  subgroup?: InputMaybe<DatabaseGroupRuleInput>;
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseCalendarViewConfigType {
  __typename?: "DatabaseCalendarViewConfigType";
  dateFieldId: Scalars["ID"]["output"];
  dateMode: DatabaseCalendarDateMode;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  group: Maybe<DatabaseGroupRuleType>;
  initialRange: DatabaseCalendarInitialRange;
  sort: Array<DatabaseSortRuleType>;
  subgroup: Maybe<DatabaseGroupRuleType>;
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
}

export enum DatabaseCardDensity {
  Comfortable = "Comfortable",
  Compact = "Compact",
  Default = "Default",
}

export interface DatabaseCellRevisionType {
  __typename?: "DatabaseCellRevisionType";
  editRevision: Scalars["Int"]["output"];
  fieldId: Scalars["ID"]["output"];
  hasValue: Scalars["Boolean"]["output"];
  rowId: Scalars["ID"]["output"];
}

export interface DatabaseCellValueDataType {
  __typename?: "DatabaseCellValueDataType";
  checkbox: Maybe<Scalars["Boolean"]["output"]>;
  createdBy: Maybe<Scalars["ID"]["output"]>;
  createdTime: Maybe<Scalars["DateTime"]["output"]>;
  currency: Maybe<DatabaseCurrencyCellValueType>;
  date: Maybe<DatabaseDateCellValueType>;
  dateTime: Maybe<DatabaseDateTimeCellValueType>;
  documentLink: Maybe<DatabaseDocumentLinkCellValueType>;
  duration: Maybe<DatabaseDurationCellValueType>;
  email: Maybe<Scalars["String"]["output"]>;
  files: Maybe<DatabaseFilesCellValueType>;
  formula: Maybe<DatabaseFormulaValueType>;
  kind: DatabaseFieldKind;
  multiSelect: Maybe<Array<Scalars["String"]["output"]>>;
  number: Maybe<Scalars["Float"]["output"]>;
  percent: Maybe<Scalars["Float"]["output"]>;
  phone: Maybe<Scalars["String"]["output"]>;
  relation: Maybe<Array<Scalars["ID"]["output"]>>;
  relationTargets: Maybe<Array<DatabaseRelationTargetType>>;
  richText: Maybe<DatabaseRichTextCellValueType>;
  rollup: Maybe<DatabaseRollupValueType>;
  select: Maybe<Scalars["String"]["output"]>;
  status: Maybe<Scalars["String"]["output"]>;
  tags: Maybe<Array<Scalars["ID"]["output"]>>;
  text: Maybe<Scalars["String"]["output"]>;
  uniqueId: Maybe<DatabaseUniqueIdCellValueType>;
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  updatedTime: Maybe<Scalars["DateTime"]["output"]>;
  url: Maybe<Scalars["String"]["output"]>;
  user: Maybe<Scalars["ID"]["output"]>;
  users: Maybe<Array<Scalars["ID"]["output"]>>;
}

export interface DatabaseCellValueInput {
  checkbox?: InputMaybe<Scalars["Boolean"]["input"]>;
  currency?: InputMaybe<DatabaseCurrencyCellValueInput>;
  date?: InputMaybe<DatabaseDateCellValueInput>;
  dateTime?: InputMaybe<DatabaseDateTimeCellValueInput>;
  documentLink?: InputMaybe<DatabaseDocumentLinkCellValueInput>;
  duration?: InputMaybe<DatabaseDurationCellValueInput>;
  email?: InputMaybe<Scalars["String"]["input"]>;
  files?: InputMaybe<DatabaseFilesCellValueInput>;
  formula?: InputMaybe<DatabaseFormulaScalarValueInput>;
  multiSelect?: InputMaybe<Array<Scalars["String"]["input"]>>;
  number?: InputMaybe<Scalars["Float"]["input"]>;
  percent?: InputMaybe<Scalars["Float"]["input"]>;
  phone?: InputMaybe<Scalars["String"]["input"]>;
  relation?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  richText?: InputMaybe<DatabaseRichTextCellValueInput>;
  rollup?: InputMaybe<DatabaseRollupScalarValueInput>;
  select?: InputMaybe<Scalars["String"]["input"]>;
  status?: InputMaybe<Scalars["String"]["input"]>;
  tags?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  text?: InputMaybe<Scalars["String"]["input"]>;
  url?: InputMaybe<Scalars["String"]["input"]>;
  user?: InputMaybe<Scalars["ID"]["input"]>;
  users?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseCellValueType {
  __typename?: "DatabaseCellValueType";
  editRevision: Scalars["Int"]["output"];
  fieldId: Scalars["ID"]["output"];
  fieldType: DatabaseFieldKind;
  rowId: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  value: DatabaseCellValueDataType;
}

export interface DatabaseCsvAppliedColumnMapping {
  __typename?: "DatabaseCsvAppliedColumnMapping";
  fieldName: Scalars["String"]["output"];
  fieldType: DatabaseFieldKind;
  importColumn: Scalars["Boolean"]["output"];
  isTitle: Scalars["Boolean"]["output"];
  sourceHeader: Scalars["String"]["output"];
  sourceIndex: Scalars["Int"]["output"];
}

export interface DatabaseCsvAppliedColumnMappingInput {
  fieldName: Scalars["String"]["input"];
  fieldType: DatabaseFieldKind;
  importColumn: Scalars["Boolean"]["input"];
  isTitle: Scalars["Boolean"]["input"];
  sourceHeader: Scalars["String"]["input"];
  sourceIndex: Scalars["Int"]["input"];
}

export interface DatabaseCsvColumnMappingInput {
  fieldName?: InputMaybe<Scalars["String"]["input"]>;
  fieldType?: InputMaybe<DatabaseFieldKind>;
  importColumn?: InputMaybe<Scalars["Boolean"]["input"]>;
  isTitle?: InputMaybe<Scalars["Boolean"]["input"]>;
  sourceIndex: Scalars["Int"]["input"];
}

export enum DatabaseCsvDelimiter {
  Auto = "Auto",
  Comma = "Comma",
  Custom = "Custom",
  Pipe = "Pipe",
  Semicolon = "Semicolon",
  Tab = "Tab",
}

export interface DatabaseCsvDetectedColumn {
  __typename?: "DatabaseCsvDetectedColumn";
  fieldName: Scalars["String"]["output"];
  fieldType: DatabaseFieldKind;
  index: Scalars["Int"]["output"];
  isTitle: Scalars["Boolean"]["output"];
  sourceHeader: Scalars["String"]["output"];
}

export interface DatabaseCsvDiagnostic {
  __typename?: "DatabaseCsvDiagnostic";
  code: Scalars["String"]["output"];
  field: Maybe<Scalars["String"]["output"]>;
  message: Scalars["String"]["output"];
  row: Maybe<Scalars["Int"]["output"]>;
  source: Scalars["String"]["output"];
}

export interface DatabaseCsvDialect {
  __typename?: "DatabaseCsvDialect";
  customDelimiter: Maybe<Scalars["String"]["output"]>;
  delimiter: DatabaseCsvDelimiter;
  doubleQuote: Scalars["Boolean"]["output"];
  escape: Maybe<Scalars["String"]["output"]>;
  quote: Maybe<Scalars["String"]["output"]>;
}

export interface DatabaseCsvDialectInput {
  customDelimiter?: InputMaybe<Scalars["String"]["input"]>;
  delimiter?: InputMaybe<DatabaseCsvDelimiter>;
  doubleQuote?: InputMaybe<Scalars["Boolean"]["input"]>;
  escape?: InputMaybe<Scalars["String"]["input"]>;
  quote?: InputMaybe<Scalars["String"]["input"]>;
}

export interface DatabaseCsvExport {
  __typename?: "DatabaseCsvExport";
  columnCount: Scalars["Int"]["output"];
  content: Scalars["String"]["output"];
  contentType: Scalars["String"]["output"];
  databaseId: Scalars["ID"]["output"];
  fileName: Scalars["String"]["output"];
  includeHeader: Scalars["Boolean"]["output"];
  locale: Maybe<Scalars["String"]["output"]>;
  localeMode: DatabaseCsvLocaleMode;
  quoteStrategy: DatabaseCsvQuoteStrategy;
  rowCount: Scalars["Int"]["output"];
  target: DatabaseCsvExportTarget;
  viewId: Maybe<Scalars["ID"]["output"]>;
  warnings: Array<DatabaseCsvDiagnostic>;
  workspaceTagDiagnostics: Array<DatabaseWorkspaceTagImportDiagnostic>;
}

/**
 * Quote strategy applied to CSV export. `MINIMAL` (default) only
 * quotes fields that contain the delimiter, the quote byte, a
 * newline, or leading/trailing whitespace. `ALL` quotes every
 * field so the consumer can rely on positional round-trips
 * regardless of cell content.
 */
export interface DatabaseCsvExportOptionsInput {
  dialect?: InputMaybe<DatabaseCsvDialectInput>;
  includeHeader?: InputMaybe<Scalars["Boolean"]["input"]>;
  locale?: InputMaybe<Scalars["String"]["input"]>;
  localeMode?: InputMaybe<DatabaseCsvLocaleMode>;
  quoteStrategy?: InputMaybe<DatabaseCsvQuoteStrategy>;
  rowIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  target?: InputMaybe<DatabaseCsvExportTarget>;
  viewId?: InputMaybe<Scalars["ID"]["input"]>;
}

export enum DatabaseCsvExportTarget {
  Database = "Database",
  SelectedRows = "SelectedRows",
  View = "View",
}

export interface DatabaseCsvImportResult {
  __typename?: "DatabaseCsvImportResult";
  createdDocCount: Scalars["Int"]["output"];
  createdFieldCount: Scalars["Int"]["output"];
  createdRowCount: Scalars["Int"]["output"];
  database: DatabaseRecord;
  errors: Array<DatabaseCsvDiagnostic>;
  skippedRowCount: Scalars["Int"]["output"];
  warnings: Array<DatabaseCsvDiagnostic>;
  workspaceTagDiagnostics: Array<DatabaseWorkspaceTagImportDiagnostic>;
}

export enum DatabaseCsvLocaleMode {
  Localized = "Localized",
  Machine = "Machine",
}

export interface DatabaseCsvMappingTemplate {
  __typename?: "DatabaseCsvMappingTemplate";
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Scalars["ID"]["output"];
  dialect: DatabaseCsvDialect;
  firstRowIsHeader: Scalars["Boolean"]["output"];
  id: Scalars["ID"]["output"];
  isCurrent: Scalars["Boolean"]["output"];
  mapping: Array<DatabaseCsvAppliedColumnMapping>;
  name: Scalars["String"]["output"];
  revision: Scalars["Int"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseCsvMappingTemplateSummary {
  __typename?: "DatabaseCsvMappingTemplateSummary";
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  revision: Scalars["Int"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface DatabaseCsvPreview {
  __typename?: "DatabaseCsvPreview";
  appliedDialect: DatabaseCsvDialect;
  appliedMapping: Array<DatabaseCsvAppliedColumnMapping>;
  confidence: Scalars["String"]["output"];
  detectedColumns: Array<DatabaseCsvDetectedColumn>;
  detectedDelimiter: Scalars["String"]["output"];
  detectedDialect: DatabaseCsvDialect;
  errors: Array<DatabaseCsvDiagnostic>;
  inferredFields: Array<DatabaseFieldType>;
  rowCount: Scalars["Int"]["output"];
  warnings: Array<DatabaseCsvDiagnostic>;
  workspaceTagDiagnostics: Array<DatabaseWorkspaceTagImportDiagnostic>;
}

export enum DatabaseCsvQuoteStrategy {
  All = "All",
  Minimal = "Minimal",
}

export interface DatabaseCurrencyCellValueInput {
  amount: Scalars["Float"]["input"];
  currencyCode: Scalars["String"]["input"];
}

export interface DatabaseCurrencyCellValueType {
  __typename?: "DatabaseCurrencyCellValueType";
  amount: Scalars["Float"]["output"];
  currencyCode: Scalars["String"]["output"];
}

export interface DatabaseCurrencyFieldConfigInput {
  allowCurrencyOverride?: InputMaybe<Scalars["Boolean"]["input"]>;
  defaultCurrency?: InputMaybe<Scalars["String"]["input"]>;
  maxValue?: InputMaybe<Scalars["Float"]["input"]>;
  minValue?: InputMaybe<Scalars["Float"]["input"]>;
}

export interface DatabaseCurrencyFieldConfigType {
  __typename?: "DatabaseCurrencyFieldConfigType";
  allowCurrencyOverride: Scalars["Boolean"]["output"];
  defaultCurrency: Scalars["String"]["output"];
  maxValue: Maybe<Scalars["Float"]["output"]>;
  minValue: Maybe<Scalars["Float"]["output"]>;
}

export interface DatabaseCurrencyRangeType {
  currencyCode: Scalars["String"]["input"];
  end?: InputMaybe<Scalars["Float"]["input"]>;
  start?: InputMaybe<Scalars["Float"]["input"]>;
}

export interface DatabaseDateCellValueInput {
  end?: InputMaybe<Scalars["NaiveDate"]["input"]>;
  start: Scalars["NaiveDate"]["input"];
}

export interface DatabaseDateCellValueType {
  __typename?: "DatabaseDateCellValueType";
  end: Maybe<Scalars["NaiveDate"]["output"]>;
  start: Scalars["NaiveDate"]["output"];
}

export interface DatabaseDateFieldConfigInput {
  includeTime?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface DatabaseDateFieldConfigType {
  __typename?: "DatabaseDateFieldConfigType";
  includeTime: Scalars["Boolean"]["output"];
}

export interface DatabaseDateRangeType {
  end?: InputMaybe<Scalars["String"]["input"]>;
  start?: InputMaybe<Scalars["String"]["input"]>;
}

export interface DatabaseDateTimeCellValueInput {
  allDay?: InputMaybe<Scalars["Boolean"]["input"]>;
  end?: InputMaybe<Scalars["DateTime"]["input"]>;
  start: Scalars["DateTime"]["input"];
  timeZone: Scalars["String"]["input"];
}

export interface DatabaseDateTimeCellValueType {
  __typename?: "DatabaseDateTimeCellValueType";
  allDay: Scalars["Boolean"]["output"];
  end: Maybe<Scalars["DateTime"]["output"]>;
  start: Scalars["DateTime"]["output"];
  timeZone: Scalars["String"]["output"];
}

export interface DatabaseDateTimeFieldConfigInput {
  allowReminders?: InputMaybe<Scalars["Boolean"]["input"]>;
  defaultTimeZone?: InputMaybe<Scalars["String"]["input"]>;
}

export interface DatabaseDateTimeFieldConfigType {
  __typename?: "DatabaseDateTimeFieldConfigType";
  allowReminders: Scalars["Boolean"]["output"];
  defaultTimeZone: Maybe<Scalars["String"]["output"]>;
}

export interface DatabaseDocumentLinkCellValueInput {
  docId: Scalars["ID"]["input"];
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface DatabaseDocumentLinkCellValueType {
  __typename?: "DatabaseDocumentLinkCellValueType";
  docId: Scalars["ID"]["output"];
  target: Maybe<DatabaseRowContentDocument>;
  workspaceId: Maybe<Scalars["ID"]["output"]>;
}

export enum DatabaseDocumentReferenceKind {
  DocumentLinkField = "DocumentLinkField",
  RowContentDocument = "RowContentDocument",
  TaskSource = "TaskSource",
}

export interface DatabaseDocumentReferenceType {
  __typename?: "DatabaseDocumentReferenceType";
  databaseId: Scalars["ID"]["output"];
  databaseTitle: Scalars["String"]["output"];
  fieldId: Maybe<Scalars["ID"]["output"]>;
  fieldName: Maybe<Scalars["String"]["output"]>;
  rawTargetDocId: Scalars["String"]["output"];
  referenceKind: DatabaseDocumentReferenceKind;
  refreshedAt: Scalars["DateTime"]["output"];
  rowId: Scalars["ID"]["output"];
  rowTitle: Scalars["String"]["output"];
  targetDocId: Maybe<Scalars["ID"]["output"]>;
  targetWorkspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface DatabaseDurationCellValueInput {
  minutes: Scalars["Int"]["input"];
}

export interface DatabaseDurationCellValueType {
  __typename?: "DatabaseDurationCellValueType";
  minutes: Scalars["Int"]["output"];
}

export enum DatabaseDurationDisplayUnit {
  Days = "Days",
  Hours = "Hours",
  Minutes = "Minutes",
}

export interface DatabaseDurationFieldConfigInput {
  displayUnit?: InputMaybe<DatabaseDurationDisplayUnit>;
  maxMinutes?: InputMaybe<Scalars["Int"]["input"]>;
  minMinutes?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseDurationFieldConfigType {
  __typename?: "DatabaseDurationFieldConfigType";
  displayUnit: DatabaseDurationDisplayUnit;
  maxMinutes: Maybe<Scalars["Int"]["output"]>;
  minMinutes: Maybe<Scalars["Int"]["output"]>;
}

export interface DatabaseDurationRangeType {
  endMinutes?: InputMaybe<Scalars["Int"]["input"]>;
  startMinutes?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseEffectiveViewStateType {
  __typename?: "DatabaseEffectiveViewStateType";
  /** Current permission to edit live Rows, independent of shared View settings. */
  canEditRows: Scalars["Boolean"]["output"];
  canEditShared: Scalars["Boolean"]["output"];
  effectiveFieldWidths: Array<DatabaseFieldWidthType>;
  effectiveFilterTree: Maybe<DatabaseFilterGroupType>;
  effectiveSort: Array<DatabaseSortRuleType>;
  personalState: Maybe<DatabaseViewUserStateType>;
  savedFilterTree: Maybe<DatabaseFilterGroupType>;
  savedSort: Array<DatabaseSortRuleType>;
  searchText: Scalars["String"]["output"];
  viewId: Scalars["ID"]["output"];
}

export interface DatabaseFieldConfigInput {
  currency?: InputMaybe<DatabaseCurrencyFieldConfigInput>;
  date?: InputMaybe<DatabaseDateFieldConfigInput>;
  dateTime?: InputMaybe<DatabaseDateTimeFieldConfigInput>;
  duration?: InputMaybe<DatabaseDurationFieldConfigInput>;
  files?: InputMaybe<DatabaseFilesFieldConfigInput>;
  formula?: InputMaybe<DatabaseFormulaFieldConfigInput>;
  multiSelect?: InputMaybe<DatabaseSelectFieldConfigInput>;
  number?: InputMaybe<DatabaseNumberFieldConfigInput>;
  percent?: InputMaybe<DatabasePercentFieldConfigInput>;
  relation?: InputMaybe<DatabaseRelationFieldConfigInput>;
  richText?: InputMaybe<DatabaseRichTextFieldConfigInput>;
  rollup?: InputMaybe<DatabaseRollupFieldConfigInput>;
  select?: InputMaybe<DatabaseSelectFieldConfigInput>;
  status?: InputMaybe<DatabaseStatusFieldConfigInput>;
  tags?: InputMaybe<DatabaseTagsFieldConfigInput>;
  text?: InputMaybe<DatabaseTextFieldConfigInput>;
  uniqueId?: InputMaybe<DatabaseUniqueIdFieldConfigInput>;
  users?: InputMaybe<DatabaseUsersFieldConfigInput>;
}

export interface DatabaseFieldConfigType {
  __typename?: "DatabaseFieldConfigType";
  currency: Maybe<DatabaseCurrencyFieldConfigType>;
  date: Maybe<DatabaseDateFieldConfigType>;
  dateTime: Maybe<DatabaseDateTimeFieldConfigType>;
  duration: Maybe<DatabaseDurationFieldConfigType>;
  files: Maybe<DatabaseFilesFieldConfigType>;
  formula: Maybe<DatabaseFormulaFieldConfigType>;
  kind: DatabaseFieldKind;
  multiSelect: Maybe<DatabaseSelectFieldConfigType>;
  number: Maybe<DatabaseNumberFieldConfigType>;
  percent: Maybe<DatabasePercentFieldConfigType>;
  relation: Maybe<DatabaseRelationFieldConfigType>;
  richText: Maybe<DatabaseRichTextFieldConfigType>;
  rollup: Maybe<DatabaseRollupFieldConfigType>;
  select: Maybe<DatabaseSelectFieldConfigType>;
  status: Maybe<DatabaseStatusFieldConfigType>;
  tags: Maybe<DatabaseTagsFieldConfigType>;
  text: Maybe<DatabaseTextFieldConfigType>;
  uniqueId: Maybe<DatabaseUniqueIdFieldConfigType>;
  users: Maybe<DatabaseUsersFieldConfigType>;
}

export interface DatabaseFieldEditRevisionInput {
  expectedEditRevision: Scalars["Int"]["input"];
  fieldId: Scalars["ID"]["input"];
}

export enum DatabaseFieldKind {
  Checkbox = "Checkbox",
  CreatedBy = "CreatedBy",
  CreatedTime = "CreatedTime",
  Currency = "Currency",
  Date = "Date",
  DateTime = "DateTime",
  DocumentLink = "DocumentLink",
  Duration = "Duration",
  Email = "Email",
  Files = "Files",
  Formula = "Formula",
  MultiSelect = "MultiSelect",
  Number = "Number",
  Percent = "Percent",
  Phone = "Phone",
  Relation = "Relation",
  RichText = "RichText",
  Rollup = "Rollup",
  Select = "Select",
  Status = "Status",
  Tags = "Tags",
  Text = "Text",
  Title = "Title",
  UniqueId = "UniqueId",
  UpdatedBy = "UpdatedBy",
  UpdatedTime = "UpdatedTime",
  Url = "Url",
  User = "User",
  Users = "Users",
}

export interface DatabaseFieldRole {
  __typename?: "DatabaseFieldRole";
  config: Scalars["JSON"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  databaseId: Scalars["ID"]["output"];
  fieldId: Scalars["ID"]["output"];
  profileKind: DatabaseProfileKind;
  required: Scalars["Boolean"]["output"];
  roleKey: Scalars["String"]["output"];
  rowKindScope: Maybe<Scalars["String"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
}

export interface DatabaseFieldType {
  __typename?: "DatabaseFieldType";
  config: DatabaseFieldConfigType;
  createdAt: Scalars["DateTime"]["output"];
  databaseId: Scalars["ID"]["output"];
  editRevision: Scalars["Int"]["output"];
  fieldType: DatabaseFieldKind;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  position: Scalars["Int"]["output"];
  required: Scalars["Boolean"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface DatabaseFieldWidthInput {
  fieldId: Scalars["ID"]["input"];
  width: Scalars["Int"]["input"];
}

export interface DatabaseFieldWidthType {
  __typename?: "DatabaseFieldWidthType";
  fieldId: Scalars["ID"]["output"];
  width: Scalars["Int"]["output"];
}

export enum DatabaseFileMimeCategory {
  Any = "Any",
  Archive = "Archive",
  Audio = "Audio",
  Document = "Document",
  Image = "Image",
  Pdf = "Pdf",
  Video = "Video",
}

export interface DatabaseFileReferenceInput {
  blobKey: Scalars["String"]["input"];
  caption?: InputMaybe<Scalars["String"]["input"]>;
  cover?: InputMaybe<Scalars["Boolean"]["input"]>;
  mime?: InputMaybe<Scalars["String"]["input"]>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  size?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseFileReferenceType {
  __typename?: "DatabaseFileReferenceType";
  blobKey: Scalars["String"]["output"];
  caption: Maybe<Scalars["String"]["output"]>;
  cover: Scalars["Boolean"]["output"];
  mime: Maybe<Scalars["String"]["output"]>;
  name: Maybe<Scalars["String"]["output"]>;
  size: Maybe<Scalars["Int"]["output"]>;
}

export interface DatabaseFilesCellValueInput {
  files: Array<DatabaseFileReferenceInput>;
}

export interface DatabaseFilesCellValueType {
  __typename?: "DatabaseFilesCellValueType";
  files: Array<DatabaseFileReferenceType>;
}

export interface DatabaseFilesFieldConfigInput {
  allowedMimeCategories?: InputMaybe<Array<DatabaseFileMimeCategory>>;
  maxItemCount?: InputMaybe<Scalars["Int"]["input"]>;
  maxItemSize?: InputMaybe<Scalars["Int"]["input"]>;
  previewPolicy?: InputMaybe<DatabaseFilesPreviewPolicy>;
}

export interface DatabaseFilesFieldConfigType {
  __typename?: "DatabaseFilesFieldConfigType";
  allowedMimeCategories: Array<DatabaseFileMimeCategory>;
  maxItemCount: Maybe<Scalars["Int"]["output"]>;
  maxItemSize: Maybe<Scalars["Int"]["output"]>;
  previewPolicy: DatabaseFilesPreviewPolicy;
}

export enum DatabaseFilesPreviewPolicy {
  Auto = "Auto",
  Disabled = "Disabled",
}

export enum DatabaseFilterConjunction {
  And = "And",
  Or = "Or",
}

export interface DatabaseFilterGroupInput {
  conjunction?: InputMaybe<DatabaseFilterConjunction>;
  groups?: InputMaybe<Array<DatabaseFilterGroupInput>>;
  rules?: InputMaybe<Array<DatabaseFilterRuleInput>>;
}

export interface DatabaseFilterGroupType {
  __typename?: "DatabaseFilterGroupType";
  conjunction: DatabaseFilterConjunction;
  groups: Array<DatabaseFilterGroupType>;
  rules: Array<DatabaseFilterRuleType>;
}

export enum DatabaseFilterOperator {
  After = "After",
  AnyOf = "AnyOf",
  Before = "Before",
  Between = "Between",
  Checked = "Checked",
  Contains = "Contains",
  ContainsAll = "ContainsAll",
  ContainsRow = "ContainsRow",
  ContainsUser = "ContainsUser",
  CurrentUser = "CurrentUser",
  DoesNotContain = "DoesNotContain",
  DoesNotContainRow = "DoesNotContainRow",
  DoesNotContainUser = "DoesNotContainUser",
  Empty = "Empty",
  EndsWith = "EndsWith",
  Equals = "Equals",
  Greater = "Greater",
  GreaterOrEqual = "GreaterOrEqual",
  GroupAnyOf = "GroupAnyOf",
  GroupIs = "GroupIs",
  GroupIsNot = "GroupIsNot",
  GroupNoneOf = "GroupNoneOf",
  Is = "Is",
  IsNot = "IsNot",
  Less = "Less",
  LessOrEqual = "LessOrEqual",
  NoneOf = "NoneOf",
  NotEmpty = "NotEmpty",
  NotEquals = "NotEquals",
  On = "On",
  Relative = "Relative",
  StartsWith = "StartsWith",
  Unchecked = "Unchecked",
}

export interface DatabaseFilterRuleInput {
  fieldId: Scalars["ID"]["input"];
  operator: DatabaseFilterOperator;
  value: DatabaseFilterValueInput;
}

export interface DatabaseFilterRuleType {
  __typename?: "DatabaseFilterRuleType";
  fieldId: Scalars["ID"]["output"];
  operator: DatabaseFilterOperator;
  value: DatabaseFilterValueType;
}

export type DatabaseFilterValueInput =
  | {
      boolean: Scalars["Boolean"]["input"];
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency: DatabaseCurrencyCellValueInput;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange: DatabaseCurrencyRangeType;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date: Scalars["String"]["input"];
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange: DatabaseDateRangeType;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration: DatabaseDurationCellValueInput;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange: DatabaseDurationRangeType;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids: Array<Scalars["String"]["input"]>;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant: Scalars["DateTime"]["input"];
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange: DatabaseInstantRangeType;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none: Scalars["Boolean"]["input"];
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number: Scalars["Float"]["input"];
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange: DatabaseNumberRangeType;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId: Scalars["String"]["input"];
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId: Scalars["ID"]["input"];
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds: Array<Scalars["ID"]["input"]>;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate: DatabaseRelativeDatePreset;
      text?: never;
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text: Scalars["String"]["input"];
      userId?: never;
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId: Scalars["ID"]["input"];
      userIds?: never;
    }
  | {
      boolean?: never;
      currency?: never;
      currencyRange?: never;
      date?: never;
      dateRange?: never;
      duration?: never;
      durationRange?: never;
      ids?: never;
      instant?: never;
      instantRange?: never;
      none?: never;
      number?: never;
      numberRange?: never;
      optionId?: never;
      relationRowId?: never;
      relationRowIds?: never;
      relativeDate?: never;
      text?: never;
      userId?: never;
      userIds: Array<Scalars["ID"]["input"]>;
    };

export interface DatabaseFilterValueType {
  __typename?: "DatabaseFilterValueType";
  kind: Scalars["String"]["output"];
  value: Scalars["JSON"]["output"];
}

export interface DatabaseFormulaFieldConfigInput {
  dependencyFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  expression: Scalars["String"]["input"];
  format?: InputMaybe<Scalars["String"]["input"]>;
  resultType: DatabaseFormulaResultType;
  stalePolicy?: InputMaybe<DatabaseFormulaStalePolicy>;
}

export interface DatabaseFormulaFieldConfigType {
  __typename?: "DatabaseFormulaFieldConfigType";
  dependencyFieldIds: Array<Scalars["ID"]["output"]>;
  expression: Scalars["String"]["output"];
  format: Maybe<Scalars["String"]["output"]>;
  resultType: DatabaseFormulaResultType;
  stalePolicy: DatabaseFormulaStalePolicy;
}

export enum DatabaseFormulaResultType {
  Checkbox = "Checkbox",
  Currency = "Currency",
  Date = "Date",
  DateTime = "DateTime",
  Duration = "Duration",
  Number = "Number",
  Percent = "Percent",
  Text = "Text",
  User = "User",
  Users = "Users",
}

export interface DatabaseFormulaScalarValueInput {
  checkbox?: InputMaybe<Scalars["Boolean"]["input"]>;
  currency?: InputMaybe<DatabaseCurrencyCellValueInput>;
  date?: InputMaybe<DatabaseDateCellValueInput>;
  dateTime?: InputMaybe<DatabaseDateTimeCellValueInput>;
  duration?: InputMaybe<DatabaseDurationCellValueInput>;
  number?: InputMaybe<Scalars["Float"]["input"]>;
  percent?: InputMaybe<Scalars["Float"]["input"]>;
  text?: InputMaybe<Scalars["String"]["input"]>;
  user?: InputMaybe<Scalars["ID"]["input"]>;
  users?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseFormulaScalarValueType {
  __typename?: "DatabaseFormulaScalarValueType";
  checkbox: Maybe<Scalars["Boolean"]["output"]>;
  currency: Maybe<DatabaseCurrencyCellValueType>;
  date: Maybe<DatabaseDateCellValueType>;
  dateTime: Maybe<DatabaseDateTimeCellValueType>;
  duration: Maybe<DatabaseDurationCellValueType>;
  kind: DatabaseFieldKind;
  number: Maybe<Scalars["Float"]["output"]>;
  percent: Maybe<Scalars["Float"]["output"]>;
  text: Maybe<Scalars["String"]["output"]>;
  user: Maybe<Scalars["ID"]["output"]>;
  users: Maybe<Array<Scalars["ID"]["output"]>>;
}

export enum DatabaseFormulaStalePolicy {
  Async = "Async",
}

export enum DatabaseFormulaStaleState {
  Current = "Current",
  Failed = "Failed",
  Queued = "Queued",
  RecomputePending = "RecomputePending",
  Stale = "Stale",
}

export interface DatabaseFormulaValueType {
  __typename?: "DatabaseFormulaValueType";
  computedAt: Maybe<Scalars["DateTime"]["output"]>;
  errorCode: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  failedAt: Maybe<Scalars["DateTime"]["output"]>;
  staleState: DatabaseFormulaStaleState;
  value: Maybe<DatabaseFormulaScalarValueType>;
}

export enum DatabaseGalleryCardDensity {
  Compact = "Compact",
  Default = "Default",
  Large = "Large",
}

export interface DatabaseGalleryViewConfigInput {
  cardDensity?: InputMaybe<DatabaseGalleryCardDensity>;
  coverFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  group?: InputMaybe<DatabaseGroupRuleInput>;
  showEmptyCover?: InputMaybe<Scalars["Boolean"]["input"]>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  subgroup?: InputMaybe<DatabaseGroupRuleInput>;
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseGalleryViewConfigType {
  __typename?: "DatabaseGalleryViewConfigType";
  cardDensity: DatabaseGalleryCardDensity;
  coverFieldId: Maybe<Scalars["ID"]["output"]>;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  group: Maybe<DatabaseGroupRuleType>;
  showEmptyCover: Scalars["Boolean"]["output"];
  sort: Array<DatabaseSortRuleType>;
  subgroup: Maybe<DatabaseGroupRuleType>;
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseGanttViewConfigInput {
  dependencyFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  endFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  group?: InputMaybe<DatabaseGroupRuleInput>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  startFieldId: Scalars["ID"]["input"];
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  zoom?: InputMaybe<DatabaseTimelineZoom>;
}

export interface DatabaseGanttViewConfigType {
  __typename?: "DatabaseGanttViewConfigType";
  dependencyFieldId: Maybe<Scalars["ID"]["output"]>;
  endFieldId: Maybe<Scalars["ID"]["output"]>;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  group: Maybe<DatabaseGroupRuleType>;
  sort: Array<DatabaseSortRuleType>;
  startFieldId: Scalars["ID"]["output"];
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
  zoom: DatabaseTimelineZoom;
}

export interface DatabaseGroupRuleInput {
  descending?: InputMaybe<Scalars["Boolean"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  showEmptyGroups?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface DatabaseGroupRuleType {
  __typename?: "DatabaseGroupRuleType";
  descending: Scalars["Boolean"]["output"];
  fieldId: Scalars["ID"]["output"];
  showEmptyGroups: Scalars["Boolean"]["output"];
}

export interface DatabaseInstantRangeType {
  end?: InputMaybe<Scalars["DateTime"]["input"]>;
  start?: InputMaybe<Scalars["DateTime"]["input"]>;
}

export enum DatabaseInventorySort {
  TitleAsc = "TitleAsc",
  TitleDesc = "TitleDesc",
  UpdatedDesc = "UpdatedDesc",
}

/**
 * P-DB-28: conflict handling when a snapshot row collides with an
 * existing target Database row on the UniqueId field.
 */
export enum DatabaseJsonConflictStrategyType {
  ABORT = "ABORT",
  OVERWRITE = "OVERWRITE",
  RENAME = "RENAME",
}

export interface DatabaseJsonDiagnostic {
  __typename?: "DatabaseJsonDiagnostic";
  code: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
  path: Maybe<Scalars["String"]["output"]>;
  source: Scalars["String"]["output"];
}

export interface DatabaseJsonExport {
  __typename?: "DatabaseJsonExport";
  content: Scalars["String"]["output"];
  contentType: Scalars["String"]["output"];
  fileName: Scalars["String"]["output"];
}

export interface DatabaseJsonImportFieldMappingInput {
  snapshotFieldId: Scalars["String"]["input"];
  /** Either an existing target field id, or `new:<field name>`. */
  target: Scalars["String"]["input"];
}

/**
 * P-DB-28: import mode enum mirrored from
 * `domain::DatabaseJsonImportMode`. Used by every JSON import
 * endpoint and by the import wizard's mode selector.
 */
export enum DatabaseJsonImportModeType {
  CREATE = "CREATE",
  MERGE = "MERGE",
  REPLACE = "REPLACE",
}

export interface DatabaseJsonImportResult {
  __typename?: "DatabaseJsonImportResult";
  conflictStrategy: DatabaseJsonConflictStrategyType;
  conflictWarnings: Array<DatabaseJsonDiagnostic>;
  createdFieldCount: Scalars["Int"]["output"];
  createdRowCount: Scalars["Int"]["output"];
  createdTemplateCount: Scalars["Int"]["output"];
  createdViewCount: Scalars["Int"]["output"];
  database: DatabaseRecord;
  dryRun: Scalars["Boolean"]["output"];
  missingFileCount: Scalars["Int"]["output"];
  mode: DatabaseJsonImportModeType;
  skippedRowCount: Scalars["Int"]["output"];
  updatedRowCount: Scalars["Int"]["output"];
  warnings: Array<DatabaseJsonDiagnostic>;
  workspaceTagDiagnostics: Array<DatabaseWorkspaceTagImportDiagnostic>;
}

export interface DatabaseJsonPreview {
  __typename?: "DatabaseJsonPreview";
  bodyBlockCount: Scalars["Int"]["output"];
  contentDocumentCount: Scalars["Int"]["output"];
  defaultConflictStrategy: DatabaseJsonConflictStrategyType;
  defaultMode: DatabaseJsonImportModeType;
  emptyPageCount: Scalars["Int"]["output"];
  errors: Array<DatabaseJsonDiagnostic>;
  exportActor: Maybe<Scalars["String"]["output"]>;
  exportedAt: Maybe<Scalars["String"]["output"]>;
  fieldCount: Scalars["Int"]["output"];
  fileManifestCount: Scalars["Int"]["output"];
  matchedPageCount: Scalars["Int"]["output"];
  rewrittenInternalLinkCount: Scalars["Int"]["output"];
  rowCount: Scalars["Int"]["output"];
  schemaVersion: Scalars["Int"]["output"];
  schemaVersionSupported: Scalars["Boolean"]["output"];
  templateCount: Scalars["Int"]["output"];
  title: Scalars["String"]["output"];
  viewCount: Scalars["Int"]["output"];
  warnings: Array<DatabaseJsonDiagnostic>;
  workspaceTagDiagnostics: Array<DatabaseWorkspaceTagImportDiagnostic>;
}

export interface DatabaseKanbanViewConfigInput {
  cardDensity?: InputMaybe<DatabaseCardDensity>;
  coverFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  groupFieldId: Scalars["ID"]["input"];
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseKanbanViewConfigType {
  __typename?: "DatabaseKanbanViewConfigType";
  cardDensity: DatabaseCardDensity;
  coverFieldId: Maybe<Scalars["ID"]["output"]>;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  groupFieldId: Scalars["ID"]["output"];
  sort: Array<DatabaseSortRuleType>;
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseLifecycleInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export enum DatabaseListDensity {
  Comfortable = "Comfortable",
  Compact = "Compact",
  Default = "Default",
}

export interface DatabaseListViewConfigInput {
  density?: InputMaybe<DatabaseListDensity>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  group?: InputMaybe<DatabaseGroupRuleInput>;
  showFieldLabels?: InputMaybe<Scalars["Boolean"]["input"]>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  subgroup?: InputMaybe<DatabaseGroupRuleInput>;
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseListViewConfigType {
  __typename?: "DatabaseListViewConfigType";
  density: DatabaseListDensity;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  group: Maybe<DatabaseGroupRuleType>;
  showFieldLabels: Scalars["Boolean"]["output"];
  sort: Array<DatabaseSortRuleType>;
  subgroup: Maybe<DatabaseGroupRuleType>;
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseManagedSchema {
  __typename?: "DatabaseManagedSchema";
  canEditMetadata: Scalars["Boolean"]["output"];
  canEditStructure: Scalars["Boolean"]["output"];
  canManageLifecycle: Scalars["Boolean"]["output"];
  readiness: DatabaseManagedSchemaReadiness;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  schemaRevision: Scalars["Int"]["output"];
  /** Validated role identities are guaranteed only while readiness is Ready. */
  taskBindings: Array<DatabaseTaskBinding>;
  templateDigest: Scalars["String"]["output"];
  templateId: Scalars["String"]["output"];
  templateVersion: Scalars["String"]["output"];
  variant: DatabaseManagedSchemaVariant;
}

export enum DatabaseManagedSchemaReadiness {
  Ready = "Ready",
  Unavailable = "Unavailable",
}

export interface DatabaseManagedSchemaVariant {
  __typename?: "DatabaseManagedSchemaVariant";
  complexity: ProjectOptionPreset;
  currency: Scalars["String"]["output"];
  priority: ProjectOptionPreset;
  structure: ProjectStructurePreset;
}

export interface DatabaseNumberFieldConfigInput {
  format?: InputMaybe<Scalars["String"]["input"]>;
}

export interface DatabaseNumberFieldConfigType {
  __typename?: "DatabaseNumberFieldConfigType";
  format: Maybe<Scalars["String"]["output"]>;
}

export interface DatabaseNumberRangeType {
  end?: InputMaybe<Scalars["Float"]["input"]>;
  start?: InputMaybe<Scalars["Float"]["input"]>;
}

export interface DatabasePageIdentity {
  __typename?: "DatabasePageIdentity";
  createdAt: Scalars["DateTime"]["output"];
  deletedAt: Maybe<Scalars["DateTime"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  editRevision: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  profileKind: DatabaseProfileKind;
  systemRole: Maybe<DatabaseSystemRole>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface DatabasePercentFieldConfigInput {
  maxValue?: InputMaybe<Scalars["Float"]["input"]>;
  minValue?: InputMaybe<Scalars["Float"]["input"]>;
}

export interface DatabasePercentFieldConfigType {
  __typename?: "DatabasePercentFieldConfigType";
  maxValue: Maybe<Scalars["Float"]["output"]>;
  minValue: Maybe<Scalars["Float"]["output"]>;
}

export enum DatabaseProfileKind {
  Generic = "Generic",
  Project = "Project",
}

export interface DatabaseProgressGroupSummary {
  __typename?: "DatabaseProgressGroupSummary";
  averageProgress: Maybe<Scalars["Float"]["output"]>;
  blockedCount: Scalars["Int"]["output"];
  completedCount: Scalars["Int"]["output"];
  incompleteCount: Scalars["Int"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  overdueCount: Scalars["Int"]["output"];
  totalCount: Scalars["Int"]["output"];
}

export interface DatabaseProgressSummary {
  __typename?: "DatabaseProgressSummary";
  averageProgress: Maybe<Scalars["Float"]["output"]>;
  blockedCount: Scalars["Int"]["output"];
  completedCount: Scalars["Int"]["output"];
  groupFieldId: Maybe<Scalars["ID"]["output"]>;
  groups: Array<DatabaseProgressGroupSummary>;
  incompleteCount: Scalars["Int"]["output"];
  overdueCount: Scalars["Int"]["output"];
  progressFieldId: Scalars["ID"]["output"];
  totalCount: Scalars["Int"]["output"];
  viewId: Scalars["ID"]["output"];
}

export interface DatabaseProgressViewConfigInput {
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  groupFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  progressFieldId: Scalars["ID"]["input"];
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseProgressViewConfigType {
  __typename?: "DatabaseProgressViewConfigType";
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  groupFieldId: Maybe<Scalars["ID"]["output"]>;
  progressFieldId: Scalars["ID"]["output"];
  sort: Array<DatabaseSortRuleType>;
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseRecord {
  __typename?: "DatabaseRecord";
  database: DatabaseType;
  fieldRoles: Array<DatabaseFieldRole>;
  fields: Array<DatabaseFieldType>;
  /** Creation-only navigation hint, selected by the confirmed native plan. */
  initialViewId: Maybe<Scalars["ID"]["output"]>;
  managedSchema: Maybe<DatabaseManagedSchema>;
  rowCount: Scalars["Int"]["output"];
  viewRoles: Array<DatabaseViewRole>;
  views: Array<DatabaseViewType>;
}

export interface DatabaseRelationFieldConfigInput {
  allowMultiple?: InputMaybe<Scalars["Boolean"]["input"]>;
  maxTargets?: InputMaybe<Scalars["Int"]["input"]>;
  reciprocalFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  targetDatabaseId: Scalars["ID"]["input"];
}

export interface DatabaseRelationFieldConfigType {
  __typename?: "DatabaseRelationFieldConfigType";
  allowMultiple: Scalars["Boolean"]["output"];
  maxTargets: Maybe<Scalars["Int"]["output"]>;
  reciprocalFieldId: Maybe<Scalars["ID"]["output"]>;
  targetDatabaseId: Scalars["ID"]["output"];
}

export interface DatabaseRelationTargetType {
  __typename?: "DatabaseRelationTargetType";
  contentDocument: Maybe<DatabaseRowContentDocument>;
  deleted: Scalars["Boolean"]["output"];
  redacted: Scalars["Boolean"]["output"];
  rowId: Scalars["ID"]["output"];
  title: Maybe<Scalars["String"]["output"]>;
}

export enum DatabaseRelativeDatePreset {
  CurrentMonth = "CurrentMonth",
  CurrentWeek = "CurrentWeek",
  CurrentYear = "CurrentYear",
  Next7Days = "Next7Days",
  Overdue = "Overdue",
  Past7Days = "Past7Days",
  Today = "Today",
  Tomorrow = "Tomorrow",
  Yesterday = "Yesterday",
}

export interface DatabaseRichTextCellValueInput {
  document: Scalars["JSON"]["input"];
}

export interface DatabaseRichTextCellValueType {
  __typename?: "DatabaseRichTextCellValueType";
  document: Scalars["JSON"]["output"];
  plainText: Scalars["String"]["output"];
}

export interface DatabaseRichTextFieldConfigInput {
  maxPlainTextBytes?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseRichTextFieldConfigType {
  __typename?: "DatabaseRichTextFieldConfigType";
  maxPlainTextBytes: Maybe<Scalars["Int"]["output"]>;
}

export enum DatabaseRollupAggregate {
  Average = "Average",
  CheckedPercent = "CheckedPercent",
  Count = "Count",
  CountValues = "CountValues",
  Earliest = "Earliest",
  Latest = "Latest",
  Max = "Max",
  Min = "Min",
  Sum = "Sum",
  UncheckedPercent = "UncheckedPercent",
  UniqueValues = "UniqueValues",
}

export interface DatabaseRollupFieldConfigInput {
  aggregate: DatabaseRollupAggregate;
  emptyValue?: InputMaybe<DatabaseRollupScalarValueInput>;
  sourceRelationFieldId: Scalars["ID"]["input"];
  stalePolicy?: InputMaybe<DatabaseRollupStalePolicy>;
  targetFieldId: Scalars["ID"]["input"];
}

export interface DatabaseRollupFieldConfigType {
  __typename?: "DatabaseRollupFieldConfigType";
  aggregate: DatabaseRollupAggregate;
  emptyValue: Maybe<DatabaseRollupScalarValueType>;
  sourceRelationFieldId: Scalars["ID"]["output"];
  stalePolicy: DatabaseRollupStalePolicy;
  targetFieldId: Scalars["ID"]["output"];
}

export interface DatabaseRollupScalarValueInput {
  checkbox?: InputMaybe<Scalars["Boolean"]["input"]>;
  currency?: InputMaybe<DatabaseCurrencyCellValueInput>;
  date?: InputMaybe<DatabaseDateCellValueInput>;
  duration?: InputMaybe<DatabaseDurationCellValueInput>;
  number?: InputMaybe<Scalars["Float"]["input"]>;
  text?: InputMaybe<Scalars["String"]["input"]>;
  textList?: InputMaybe<Array<Scalars["String"]["input"]>>;
}

export interface DatabaseRollupScalarValueType {
  __typename?: "DatabaseRollupScalarValueType";
  checkbox: Maybe<Scalars["Boolean"]["output"]>;
  currency: Maybe<DatabaseCurrencyCellValueType>;
  date: Maybe<DatabaseDateCellValueType>;
  duration: Maybe<DatabaseDurationCellValueType>;
  kind: DatabaseFieldKind;
  number: Maybe<Scalars["Float"]["output"]>;
  text: Maybe<Scalars["String"]["output"]>;
  textList: Maybe<Array<Scalars["String"]["output"]>>;
}

export enum DatabaseRollupStalePolicy {
  Async = "Async",
}

export enum DatabaseRollupStaleState {
  Current = "Current",
  Failed = "Failed",
  Queued = "Queued",
  RecomputePending = "RecomputePending",
  Stale = "Stale",
}

export interface DatabaseRollupValueType {
  __typename?: "DatabaseRollupValueType";
  computedAt: Maybe<Scalars["DateTime"]["output"]>;
  errorCode: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  failedAt: Maybe<Scalars["DateTime"]["output"]>;
  staleState: DatabaseRollupStaleState;
  value: Maybe<DatabaseRollupScalarValueType>;
}

/**
 * Permission-safe metadata for an optional Row content document or a
 * DocumentLink target. Titles are exposed only while the target is available.
 */
export interface DatabaseRowContentDocument {
  __typename?: "DatabaseRowContentDocument";
  /** Internal UUID retained for Database mutations and reference joins. */
  documentId: Scalars["ID"]["output"];
  /** Workspace-local route key, exposed only for an available readable target. */
  externalId: Maybe<Scalars["ID"]["output"]>;
  state: DatabaseRowContentDocumentState;
  title: Maybe<Scalars["String"]["output"]>;
  workspaceId: Maybe<Scalars["ID"]["output"]>;
}

export enum DatabaseRowContentDocumentState {
  Available = "Available",
  Deleted = "Deleted",
  Missing = "Missing",
  Redacted = "Redacted",
}

export interface DatabaseRowGroupSummary {
  __typename?: "DatabaseRowGroupSummary";
  groups: Array<DatabaseRowGroupSummary>;
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  rowCount: Scalars["Int"]["output"];
}

export interface DatabaseRowRecord {
  __typename?: "DatabaseRowRecord";
  cellRevisions: Array<DatabaseCellRevisionType>;
  cells: Array<DatabaseCellValueType>;
  groupKeys: Array<Scalars["String"]["output"]>;
  redacted: Scalars["Boolean"]["output"];
  row: DatabaseRowType;
}

export interface DatabaseRowReminder {
  __typename?: "DatabaseRowReminder";
  databaseId: Scalars["ID"]["output"];
  fieldId: Scalars["ID"]["output"];
  id: Scalars["ID"]["output"];
  offsetMinutes: Scalars["Int"]["output"];
  rowId: Scalars["ID"]["output"];
  scheduleRevision: Scalars["Int"]["output"];
  status: DatabaseRowReminderStatus;
  triggerAt: Scalars["DateTime"]["output"];
}

export enum DatabaseRowReminderStatus {
  Cancelled = "Cancelled",
  Claimed = "Claimed",
  Fired = "Fired",
  Scheduled = "Scheduled",
}

export interface DatabaseRowTemplate {
  __typename?: "DatabaseRowTemplate";
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  databaseId: Scalars["ID"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  editRevision: Scalars["Int"]["output"];
  enabled: Scalars["Boolean"]["output"];
  id: Scalars["ID"]["output"];
  initialCellValues: Array<DatabaseRowTemplateCellValue>;
  isDefault: Scalars["Boolean"]["output"];
  name: Scalars["String"]["output"];
  position: Scalars["Int"]["output"];
  rowKind: Scalars["String"]["output"];
  templateId: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseRowTemplateBinding {
  __typename?: "DatabaseRowTemplateBinding";
  archived: Scalars["Boolean"]["output"];
  detached: Scalars["Boolean"]["output"];
  disabled: Scalars["Boolean"]["output"];
  reconcileRequired: Scalars["Boolean"]["output"];
  rowTemplate: DatabaseRowTemplate;
  templateAvailable: Scalars["Boolean"]["output"];
}

export interface DatabaseRowTemplateBodyInputs {
  __typename?: "DatabaseRowTemplateBodyInputs";
  requiredInputs: Array<Scalars["String"]["output"]>;
  sourceRevision: Maybe<Scalars["String"]["output"]>;
}

export interface DatabaseRowTemplateCellValue {
  __typename?: "DatabaseRowTemplateCellValue";
  fieldId: Scalars["ID"]["output"];
  fieldType: DatabaseFieldKind;
  value: DatabaseCellValueDataType;
}

export interface DatabaseRowType {
  __typename?: "DatabaseRowType";
  contentDocument: Maybe<DatabaseRowContentDocument>;
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  databaseId: Scalars["ID"]["output"];
  deletedAt: Maybe<Scalars["DateTime"]["output"]>;
  editRevision: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  position: Scalars["Int"]["output"];
  rowKind: Scalars["String"]["output"];
  /**
   * Resolve only when selected; paged Row lists must not load full Database
   * schemas and origin metadata merely because capture exists.
   */
  source: Maybe<DatabaseTaskSource>;
  /** Outgoing IDs remain the source Cell's identities, even when unresolved. */
  taskBlockedBy: DatabaseTaskBlockedBy;
  /**
   * The inverse is derived from canonical Cells; state describes this source
   * prerequisite's activity, while each Task summary describes its dependent.
   */
  taskBlocks: DatabaseTaskBlocks;
  /** Explicit detail projection; ordinary Row fragments incur no child reads. */
  taskChildren: DatabaseTaskChildren;
  /** Explicitly selected diagnostics never load target titles or repair Cells. */
  taskParent: DatabaseTaskParent;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
}

export interface DatabaseRowTypeTaskBlockedByArgs {
  after?: InputMaybe<Scalars["String"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseRowTypeTaskBlocksArgs {
  after?: InputMaybe<Scalars["String"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseRowTypeTaskChildrenArgs {
  after?: InputMaybe<Scalars["String"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseRowsPage {
  __typename?: "DatabaseRowsPage";
  endCursor: Maybe<Scalars["String"]["output"]>;
  rows: Array<DatabaseRowRecord>;
  totalCount: Scalars["Int"]["output"];
}

export interface DatabaseScheduleWindowInput {
  end: Scalars["DateTime"]["input"];
  endFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  start: Scalars["DateTime"]["input"];
}

export interface DatabaseSearchFilterInput {
  databaseId?: InputMaybe<Scalars["ID"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  query: Scalars["String"]["input"];
}

/**
 * P-DB-25: full-text search across database rows in a workspace. The
 * search index is the `database_row_search` table introduced
 * in the canonical schema; ACL is enforced by the workspace membership lookup
 * inside the SQL filter.
 */
export interface DatabaseSearchHit {
  __typename?: "DatabaseSearchHit";
  databaseId: Scalars["ID"]["output"];
  hasContentDocument: Scalars["Boolean"]["output"];
  rowId: Scalars["ID"]["output"];
  snippet: Maybe<Scalars["String"]["output"]>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface DatabaseSelectFieldConfigInput {
  options: Array<DatabaseSelectOptionInput>;
}

export interface DatabaseSelectFieldConfigType {
  __typename?: "DatabaseSelectFieldConfigType";
  options: Array<DatabaseSelectOptionType>;
}

export interface DatabaseSelectOptionInput {
  colorRole: Scalars["String"]["input"];
  id: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
  position: Scalars["Int"]["input"];
}

export interface DatabaseSelectOptionType {
  __typename?: "DatabaseSelectOptionType";
  colorRole: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  position: Scalars["Int"]["output"];
}

export enum DatabaseSortDirection {
  Asc = "Asc",
  Desc = "Desc",
}

export interface DatabaseSortRuleInput {
  direction: DatabaseSortDirection;
  fieldId: Scalars["ID"]["input"];
}

export interface DatabaseSortRuleType {
  __typename?: "DatabaseSortRuleType";
  direction: DatabaseSortDirection;
  fieldId: Scalars["ID"]["output"];
}

export interface DatabaseStarterTemplate {
  __typename?: "DatabaseStarterTemplate";
  category: DatabaseStarterTemplateCategory;
  defaultVariant: DatabaseTemplateSelection;
  defaultViewKinds: Array<DatabaseViewKind>;
  description: Scalars["String"]["output"];
  descriptionKey: Scalars["String"]["output"];
  digest: Scalars["String"]["output"];
  id: Scalars["String"]["output"];
  importMappings: Array<DatabaseStarterTemplateImportMapping>;
  name: Scalars["String"]["output"];
  nameKey: Scalars["String"]["output"];
  profileKind: DatabaseProfileKind;
  sampleRowCount: Scalars["Int"]["output"];
  selections: Array<DatabaseTemplateVariantSelection>;
  version: Scalars["String"]["output"];
}

export enum DatabaseStarterTemplateCategory {
  Database = "Database",
  Project = "Project",
}

export interface DatabaseStarterTemplateImportColumn {
  __typename?: "DatabaseStarterTemplateImportColumn";
  fieldKey: Scalars["String"]["output"];
  required: Scalars["Boolean"]["output"];
  sourceHeader: Scalars["String"]["output"];
}

export interface DatabaseStarterTemplateImportMapping {
  __typename?: "DatabaseStarterTemplateImportMapping";
  columnMappings: Array<DatabaseStarterTemplateImportColumn>;
  key: Scalars["String"]["output"];
  nameKey: Scalars["String"]["output"];
}

export interface DatabaseStatusFieldConfigInput {
  defaultOptionId?: InputMaybe<Scalars["String"]["input"]>;
  options: Array<DatabaseStatusOptionInput>;
}

export interface DatabaseStatusFieldConfigType {
  __typename?: "DatabaseStatusFieldConfigType";
  defaultOptionId: Scalars["String"]["output"];
  options: Array<DatabaseStatusOptionType>;
}

export enum DatabaseStatusGroup {
  Active = "Active",
  Archived = "Archived",
  Complete = "Complete",
  NotStarted = "NotStarted",
}

export interface DatabaseStatusOptionInput {
  colorRole: Scalars["String"]["input"];
  group: DatabaseStatusGroup;
  id: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
  position: Scalars["Int"]["input"];
}

export interface DatabaseStatusOptionType {
  __typename?: "DatabaseStatusOptionType";
  colorRole: Scalars["String"]["output"];
  group: DatabaseStatusGroup;
  id: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  position: Scalars["Int"]["output"];
}

export interface DatabaseSummary {
  __typename?: "DatabaseSummary";
  createdAt: Scalars["DateTime"]["output"];
  deletedAt: Maybe<Scalars["DateTime"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  editRevision: Scalars["Int"]["output"];
  fieldCount: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  profileKind: DatabaseProfileKind;
  profileStructurePreset: Maybe<Scalars["String"]["output"]>;
  rowCount: Scalars["Int"]["output"];
  systemRole: Maybe<DatabaseSystemRole>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  viewCount: Scalars["Int"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export enum DatabaseSystemRole {
  WorkspaceTasks = "WorkspaceTasks",
}

export interface DatabaseTableViewConfigInput {
  fieldWidths?: InputMaybe<Array<DatabaseFieldWidthInput>>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  group?: InputMaybe<DatabaseGroupRuleInput>;
  searchFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  subgroup?: InputMaybe<DatabaseGroupRuleInput>;
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
}

export interface DatabaseTableViewConfigType {
  __typename?: "DatabaseTableViewConfigType";
  fieldWidths: Array<DatabaseFieldWidthType>;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  group: Maybe<DatabaseGroupRuleType>;
  searchFieldIds: Array<Scalars["ID"]["output"]>;
  sort: Array<DatabaseSortRuleType>;
  subgroup: Maybe<DatabaseGroupRuleType>;
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseTagsFieldConfigInput {
  maxCount?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseTagsFieldConfigType {
  __typename?: "DatabaseTagsFieldConfigType";
  maxCount: Maybe<Scalars["Int"]["output"]>;
}

export interface DatabaseTaskAssignee {
  __typename?: "DatabaseTaskAssignee";
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
}

export interface DatabaseTaskBinding {
  __typename?: "DatabaseTaskBinding";
  fieldId: Scalars["ID"]["output"];
  roleKey: Scalars["String"]["output"];
}

export interface DatabaseTaskBlockedBy {
  __typename?: "DatabaseTaskBlockedBy";
  available: Scalars["Boolean"]["output"];
  diagnostics: Array<DatabaseTaskRelationReason>;
  fieldId: Maybe<Scalars["ID"]["output"]>;
  nextCursor: Maybe<Scalars["String"]["output"]>;
  retainedRowIds: Array<Scalars["ID"]["output"]>;
  rows: Array<DatabaseTaskBlockingEntry>;
}

export interface DatabaseTaskBlockerCounts {
  __typename?: "DatabaseTaskBlockerCounts";
  /** Distinct active prerequisites, or null when capability is unavailable. */
  activeCount: Maybe<Scalars["Int"]["output"]>;
  /** Whether the canonical blocker role and source Relation Cell are readable. */
  available: Scalars["Boolean"]["output"];
  diagnostics: Array<DatabaseTaskRelationReason>;
  /** Distinct unresolved prerequisite identities; unavailable capability yields null. */
  unresolvedCount: Maybe<Scalars["Int"]["output"]>;
}

export interface DatabaseTaskBlockingEntry {
  __typename?: "DatabaseTaskBlockingEntry";
  rowId: Scalars["ID"]["output"];
  state: DatabaseTaskBlockingState;
  task: Maybe<DatabaseTaskSummary>;
}

export enum DatabaseTaskBlockingState {
  Active = "Active",
  Inactive = "Inactive",
  Unavailable = "Unavailable",
}

export interface DatabaseTaskBlocks {
  __typename?: "DatabaseTaskBlocks";
  available: Scalars["Boolean"]["output"];
  diagnostics: Array<DatabaseTaskRelationReason>;
  fieldId: Maybe<Scalars["ID"]["output"]>;
  nextCursor: Maybe<Scalars["String"]["output"]>;
  rows: Array<DatabaseTaskBlockingEntry>;
}

export interface DatabaseTaskCaptureResult {
  __typename?: "DatabaseTaskCaptureResult";
  databaseId: Scalars["ID"]["output"];
  editRevision: Scalars["Int"]["output"];
  record: Maybe<DatabaseRowRecord>;
  replayed: Scalars["Boolean"]["output"];
  requestId: Scalars["ID"]["output"];
  rowId: Scalars["ID"]["output"];
  source: DatabaseTaskSource;
  state: DatabaseTaskCaptureState;
}

export enum DatabaseTaskCaptureState {
  Available = "Available",
  Missing = "Missing",
  Trashed = "Trashed",
}

export interface DatabaseTaskChildren {
  __typename?: "DatabaseTaskChildren";
  archivedCount: Scalars["Int"]["output"];
  available: Scalars["Boolean"]["output"];
  completeCount: Scalars["Int"]["output"];
  diagnostics: Array<DatabaseTaskRelationReason>;
  fieldId: Maybe<Scalars["ID"]["output"]>;
  nextCursor: Maybe<Scalars["String"]["output"]>;
  rows: Array<DatabaseTaskSummary>;
  totalCount: Scalars["Int"]["output"];
}

export interface DatabaseTaskDestination {
  __typename?: "DatabaseTaskDestination";
  databaseId: Scalars["ID"]["output"];
  editRevision: Scalars["Int"]["output"];
  managedSchema: DatabaseManagedSchema;
  title: Scalars["String"]["output"];
}

export interface DatabaseTaskDestinations {
  __typename?: "DatabaseTaskDestinations";
  coverageComplete: Scalars["Boolean"]["output"];
  /** Canonical default identity is independent of ordinary Project pagination. */
  defaultDestination: Maybe<DatabaseTaskDestination>;
  nextCursor: Maybe<Scalars["ID"]["output"]>;
  projects: Array<DatabaseTaskDestination>;
  unavailableProjects: Array<DatabaseUnavailableProject>;
}

export enum DatabaseTaskDuePreset {
  NextSevenDays = "NextSevenDays",
  Overdue = "Overdue",
  Today = "Today",
  Unscheduled = "Unscheduled",
}

export enum DatabaseTaskLifecycle {
  All = "All",
  Closed = "Closed",
  Open = "Open",
  Trash = "Trash",
}

export interface DatabaseTaskMoveBoundary {
  __typename?: "DatabaseTaskMoveBoundary";
  fieldId: Scalars["ID"]["output"];
  inbound: Scalars["Boolean"]["output"];
  recoverableTrash: Scalars["Boolean"]["output"];
  relatedRowId: Scalars["ID"]["output"];
  rowId: Scalars["ID"]["output"];
}

export interface DatabaseTaskMoveCellRevision {
  __typename?: "DatabaseTaskMoveCellRevision";
  expectedEditRevision: Scalars["Int"]["output"];
  fieldId: Scalars["ID"]["output"];
}

export interface DatabaseTaskMoveCellRevisionInput {
  expectedEditRevision: Scalars["Int"]["input"];
  fieldId: Scalars["ID"]["input"];
}

export interface DatabaseTaskMoveInput {
  milestoneRowId?: InputMaybe<Scalars["ID"]["input"]>;
  phaseRowId?: InputMaybe<Scalars["ID"]["input"]>;
  selection: Array<DatabaseTaskMoveSelectionInput>;
  sourceDatabaseId: Scalars["ID"]["input"];
  sourceEditRevision: Scalars["Int"]["input"];
  sourceSchemaRevision: Scalars["Int"]["input"];
  targetDatabaseId: Scalars["ID"]["input"];
  targetEditRevision: Scalars["Int"]["input"];
  targetSchemaRevision: Scalars["Int"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface DatabaseTaskMovePlan {
  __typename?: "DatabaseTaskMovePlan";
  milestoneRowId: Maybe<Scalars["ID"]["output"]>;
  phaseRowId: Maybe<Scalars["ID"]["output"]>;
  selection: Array<DatabaseTaskMoveSelection>;
  sourceDatabaseId: Scalars["ID"]["output"];
  sourceEditRevision: Scalars["Int"]["output"];
  sourceSchemaRevision: Scalars["Int"]["output"];
  targetDatabaseId: Scalars["ID"]["output"];
  targetEditRevision: Scalars["Int"]["output"];
  targetSchemaRevision: Scalars["Int"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseTaskMovePreview {
  __typename?: "DatabaseTaskMovePreview";
  allocatesDisplayIds: Scalars["Boolean"]["output"];
  boundaries: Array<DatabaseTaskMoveBoundary>;
  eligible: Scalars["Boolean"]["output"];
  input: DatabaseTaskMovePlan;
  reasons: Array<Scalars["String"]["output"]>;
  requiredRelatedTasks: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseTaskMoveResult {
  __typename?: "DatabaseTaskMoveResult";
  rows: Array<DatabaseRowRecord>;
  sourceDatabaseId: Scalars["ID"]["output"];
  targetDatabaseId: Scalars["ID"]["output"];
}

export interface DatabaseTaskMoveSelection {
  __typename?: "DatabaseTaskMoveSelection";
  cellRevisions: Array<DatabaseTaskMoveCellRevision>;
  expectedEditRevision: Scalars["Int"]["output"];
  rowId: Scalars["ID"]["output"];
}

export interface DatabaseTaskMoveSelectionInput {
  cellRevisions: Array<DatabaseTaskMoveCellRevisionInput>;
  expectedEditRevision: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface DatabaseTaskParent {
  __typename?: "DatabaseTaskParent";
  available: Scalars["Boolean"]["output"];
  diagnostics: Array<DatabaseTaskRelationReason>;
  fieldId: Maybe<Scalars["ID"]["output"]>;
  parentRowIds: Array<Scalars["ID"]["output"]>;
}

export interface DatabaseTaskReference {
  __typename?: "DatabaseTaskReference";
  databaseId: Scalars["ID"]["output"];
  rowId: Scalars["ID"]["output"];
  state: DatabaseTaskReferenceState;
  task: Maybe<DatabaseTaskSummary>;
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseTaskReferenceInput {
  databaseId: Scalars["ID"]["input"];
  rowId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export enum DatabaseTaskReferenceState {
  Available = "Available",
  Trashed = "Trashed",
  Unavailable = "Unavailable",
}

export enum DatabaseTaskRelationReason {
  Cycle = "Cycle",
  DuplicateTargets = "DuplicateTargets",
  ForeignDatabase = "ForeignDatabase",
  IncompatibleRoleConfiguration = "IncompatibleRoleConfiguration",
  MissingRole = "MissingRole",
  MultipleParents = "MultipleParents",
  SelfBlockedBy = "SelfBlockedBy",
  SelfParent = "SelfParent",
  UnavailableTarget = "UnavailableTarget",
  WrongRowKind = "WrongRowKind",
}

export enum DatabaseTaskScope {
  All = "All",
  Following = "Following",
  Mine = "Mine",
}

export enum DatabaseTaskSort {
  Due = "Due",
  Priority = "Priority",
  PriorityProject = "PriorityProject",
  Project = "Project",
}

export interface DatabaseTaskSource {
  __typename?: "DatabaseTaskSource";
  blockId: Maybe<Scalars["String"]["output"]>;
  documentId: Scalars["ID"]["output"];
  externalId: Maybe<Scalars["ID"]["output"]>;
  selectionAnchor: Maybe<Scalars["String"]["output"]>;
  sourceWorkspaceId: Scalars["ID"]["output"];
  state: DatabaseTaskSourceState;
  title: Maybe<Scalars["String"]["output"]>;
}

export enum DatabaseTaskSourceState {
  Available = "Available",
  Unavailable = "Unavailable",
}

export interface DatabaseTaskSummary {
  __typename?: "DatabaseTaskSummary";
  assignees: Array<DatabaseTaskAssignee>;
  /** Null when this summary producer does not project blocker counts. */
  blockers: Maybe<DatabaseTaskBlockerCounts>;
  canEdit: Scalars["Boolean"]["output"];
  databaseId: Scalars["ID"]["output"];
  deletedAt: Maybe<Scalars["DateTime"]["output"]>;
  descriptionPreview: Maybe<Scalars["String"]["output"]>;
  due: Maybe<DatabaseDateTimeCellValueType>;
  editRevision: Scalars["Int"]["output"];
  hasAssignees: Scalars["Boolean"]["output"];
  /** Known prerequisite/dependent links, including inactive ones; null is unknown. */
  hasDependencies: Maybe<Scalars["Boolean"]["output"]>;
  hasDue: Scalars["Boolean"]["output"];
  hasPriority: Scalars["Boolean"]["output"];
  /** Null means native parent membership is unavailable or unprojected. */
  isSubtask: Maybe<Scalars["Boolean"]["output"]>;
  priority: Maybe<DatabaseSelectOptionType>;
  projectTitle: Scalars["String"]["output"];
  rowId: Scalars["ID"]["output"];
  status: Maybe<DatabaseStatusOptionType>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseTasksInput {
  assigneeId?: InputMaybe<Scalars["ID"]["input"]>;
  /**
   * Match Tasks with known active prerequisites before total count and pagination.
   * Omitted or false keeps all Tasks; unavailable capability is never a known zero.
   */
  blockedOnly?: InputMaybe<Scalars["Boolean"]["input"]>;
  due?: InputMaybe<DatabaseTaskDuePreset>;
  lifecycle?: InputMaybe<DatabaseTaskLifecycle>;
  projectIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  scope?: InputMaybe<DatabaseTaskScope>;
  search?: InputMaybe<Scalars["String"]["input"]>;
  /** Omitted means the existing due-date/Row order. */
  sort?: InputMaybe<DatabaseTaskSort>;
  statusGroup?: InputMaybe<DatabaseStatusGroup>;
  timeZone: Scalars["String"]["input"];
}

export interface DatabaseTasksPage {
  __typename?: "DatabaseTasksPage";
  coverageComplete: Scalars["Boolean"]["output"];
  nextCursor: Maybe<Scalars["String"]["output"]>;
  projectCount: Scalars["Int"]["output"];
  rows: Array<DatabaseTaskSummary>;
  statusOptions: Array<DatabaseStatusOptionType>;
  totalCount: Scalars["Int"]["output"];
  unavailableProjects: Array<DatabaseUnavailableProject>;
}

export interface DatabaseTemplateSelection {
  __typename?: "DatabaseTemplateSelection";
  complexity: ProjectOptionPreset;
  priority: ProjectOptionPreset;
  structure: ProjectStructurePreset;
}

export interface DatabaseTemplateVariantSelection {
  __typename?: "DatabaseTemplateVariantSelection";
  input: DatabaseTemplateSelection;
  variant: DatabaseTemplateSelection;
}

export interface DatabaseTextFieldConfigInput {
  multiline?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface DatabaseTextFieldConfigType {
  __typename?: "DatabaseTextFieldConfigType";
  multiline: Scalars["Boolean"]["output"];
}

export enum DatabaseTimelineGroupBy {
  Day = "Day",
  Month = "Month",
  None = "None",
  Week = "Week",
}

export enum DatabaseTimelineOrder {
  Asc = "Asc",
  Desc = "Desc",
}

export interface DatabaseTimelineViewConfigInput {
  endFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  groupBy?: InputMaybe<DatabaseTimelineGroupBy>;
  order?: InputMaybe<DatabaseTimelineOrder>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  startFieldId: Scalars["ID"]["input"];
  titleFieldId: Scalars["ID"]["input"];
  visibleFieldIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  zoom?: InputMaybe<DatabaseTimelineZoom>;
}

export interface DatabaseTimelineViewConfigType {
  __typename?: "DatabaseTimelineViewConfigType";
  endFieldId: Maybe<Scalars["ID"]["output"]>;
  filter: Array<DatabaseFilterRuleType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  groupBy: DatabaseTimelineGroupBy;
  order: DatabaseTimelineOrder;
  sort: Array<DatabaseSortRuleType>;
  startFieldId: Scalars["ID"]["output"];
  titleFieldId: Scalars["ID"]["output"];
  visibleFieldIds: Array<Scalars["ID"]["output"]>;
  zoom: DatabaseTimelineZoom;
}

export enum DatabaseTimelineZoom {
  Day = "Day",
  Month = "Month",
  Quarter = "Quarter",
  Week = "Week",
  Year = "Year",
}

export interface DatabaseType {
  __typename?: "DatabaseType";
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  deletedAt: Maybe<Scalars["DateTime"]["output"]>;
  deletedBy: Maybe<Scalars["ID"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  editRevision: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  profileConfig: Scalars["JSON"]["output"];
  profileKind: DatabaseProfileKind;
  profileStructurePreset: Maybe<Scalars["String"]["output"]>;
  systemRole: Maybe<DatabaseSystemRole>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface DatabaseUnavailableProject {
  __typename?: "DatabaseUnavailableProject";
  databaseId: Scalars["ID"]["output"];
  reasonCode: Scalars["String"]["output"];
  title: Scalars["String"]["output"];
}

export interface DatabaseUniqueIdCellValueType {
  __typename?: "DatabaseUniqueIdCellValueType";
  display: Scalars["String"]["output"];
  prefix: Scalars["String"]["output"];
  sequence: Scalars["Int"]["output"];
}

export interface DatabaseUniqueIdFieldConfigInput {
  padding?: InputMaybe<Scalars["Int"]["input"]>;
  prefix?: InputMaybe<Scalars["String"]["input"]>;
  startNumber?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseUniqueIdFieldConfigType {
  __typename?: "DatabaseUniqueIdFieldConfigType";
  padding: Scalars["Int"]["output"];
  prefix: Scalars["String"]["output"];
  startNumber: Scalars["Int"]["output"];
}

export interface DatabaseUsersFieldConfigInput {
  maxCount?: InputMaybe<Scalars["Int"]["input"]>;
  minCount?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DatabaseUsersFieldConfigType {
  __typename?: "DatabaseUsersFieldConfigType";
  maxCount: Maybe<Scalars["Int"]["output"]>;
  minCount: Maybe<Scalars["Int"]["output"]>;
}

export interface DatabaseViewConfigInput {
  calendar?: InputMaybe<DatabaseCalendarViewConfigInput>;
  gallery?: InputMaybe<DatabaseGalleryViewConfigInput>;
  gantt?: InputMaybe<DatabaseGanttViewConfigInput>;
  kanban?: InputMaybe<DatabaseKanbanViewConfigInput>;
  list?: InputMaybe<DatabaseListViewConfigInput>;
  progress?: InputMaybe<DatabaseProgressViewConfigInput>;
  table?: InputMaybe<DatabaseTableViewConfigInput>;
  timeline?: InputMaybe<DatabaseTimelineViewConfigInput>;
}

export interface DatabaseViewConfigType {
  __typename?: "DatabaseViewConfigType";
  calendar: Maybe<DatabaseCalendarViewConfigType>;
  gallery: Maybe<DatabaseGalleryViewConfigType>;
  gantt: Maybe<DatabaseGanttViewConfigType>;
  kanban: Maybe<DatabaseKanbanViewConfigType>;
  kind: DatabaseViewKind;
  list: Maybe<DatabaseListViewConfigType>;
  progress: Maybe<DatabaseProgressViewConfigType>;
  table: Maybe<DatabaseTableViewConfigType>;
  timeline: Maybe<DatabaseTimelineViewConfigType>;
}

export interface DatabaseViewEditRevisionInput {
  expectedEditRevision: Scalars["Int"]["input"];
  viewId: Scalars["ID"]["input"];
}

export type DatabaseViewIconInput =
  | { emoji: Scalars["String"]["input"]; system?: never }
  | { emoji?: never; system: DatabaseViewSystemIcon };

export interface DatabaseViewIconType {
  __typename?: "DatabaseViewIconType";
  emoji: Maybe<Scalars["String"]["output"]>;
  system: Maybe<DatabaseViewSystemIcon>;
}

export enum DatabaseViewKind {
  Calendar = "Calendar",
  Gallery = "Gallery",
  Gantt = "Gantt",
  Kanban = "Kanban",
  List = "List",
  Progress = "Progress",
  Table = "Table",
  Timeline = "Timeline",
}

export interface DatabaseViewRole {
  __typename?: "DatabaseViewRole";
  createdAt: Scalars["DateTime"]["output"];
  databaseId: Scalars["ID"]["output"];
  profileKind: DatabaseProfileKind;
  required: Scalars["Boolean"]["output"];
  roleKey: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  viewId: Scalars["ID"]["output"];
}

export enum DatabaseViewSystemIcon {
  Board = "Board",
  Calendar = "Calendar",
  Database = "Database",
  Gallery = "Gallery",
  List = "List",
  Progress = "Progress",
  Project = "Project",
  Table = "Table",
  Timeline = "Timeline",
}

export interface DatabaseViewType {
  __typename?: "DatabaseViewType";
  config: DatabaseViewConfigType;
  createdAt: Scalars["DateTime"]["output"];
  databaseId: Scalars["ID"]["output"];
  editRevision: Scalars["Int"]["output"];
  icon: Maybe<DatabaseViewIconType>;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  position: Scalars["Int"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  viewKind: DatabaseViewKind;
}

export interface DatabaseViewUserStateType {
  __typename?: "DatabaseViewUserStateType";
  collapsedGroupKeys: Array<Scalars["String"]["output"]>;
  editRevision: Scalars["Int"]["output"];
  fieldWidthOverrides: Array<DatabaseFieldWidthType>;
  filterTree: Maybe<DatabaseFilterGroupType>;
  searchText: Scalars["String"]["output"];
  sort: Maybe<Array<DatabaseSortRuleType>>;
  updatedAt: Scalars["DateTime"]["output"];
  viewId: Scalars["ID"]["output"];
}

export enum DatabaseWorkspaceTagImportAction {
  ArchivedReference = "ArchivedReference",
  Create = "Create",
  Rejected = "Rejected",
  Reuse = "Reuse",
}

export interface DatabaseWorkspaceTagImportDiagnostic {
  __typename?: "DatabaseWorkspaceTagImportDiagnostic";
  action: DatabaseWorkspaceTagImportAction;
  affectedFields: Array<Scalars["String"]["output"]>;
  affectedRows: Array<Scalars["Int"]["output"]>;
  colorRole: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
  sourceColor: Maybe<Scalars["String"]["output"]>;
  sourceId: Maybe<Scalars["ID"]["output"]>;
  targetId: Maybe<Scalars["ID"]["output"]>;
}

export interface DecideDocumentReviewInput {
  decision: DocumentReviewDecisionKind;
  expectedDocumentRevision: Scalars["String"]["input"];
  expectedStatusEditRevision: Scalars["Int"]["input"];
  expectedTaskEditRevision: Scalars["Int"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
  requestId: Scalars["ID"]["input"];
  runId: Scalars["ID"]["input"];
  waitId: Scalars["String"]["input"];
}

/** Result of a `deleteAccount` mutation. */
export interface DeleteAccount {
  __typename?: "DeleteAccount";
  /** Always `true` on success. */
  success: Scalars["Boolean"]["output"];
}

export interface DeleteDatabaseCsvMappingTemplateInput {
  name: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface DeleteDatabaseFieldInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface DeleteDatabaseRowInput {
  databaseId: Scalars["ID"]["input"];
  /** P-DB-29B-C optimistic-lock precondition. */
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  /** P-DB-29B-C: force the delete even when the precondition fails. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowId: Scalars["ID"]["input"];
}

export interface DeleteDatabaseRowReminderInput {
  databaseId: Scalars["ID"]["input"];
  reminderId: Scalars["ID"]["input"];
}

export interface DeleteDatabaseRowTemplateInput {
  expectedEditRevision: Scalars["Int"]["input"];
  rowTemplateId: Scalars["ID"]["input"];
}

export interface DeleteDatabaseViewInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  replacementViewId?: InputMaybe<Scalars["ID"]["input"]>;
  viewId: Scalars["ID"]["input"];
}

export interface DeleteDocumentPermanentlyInput {
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface DeleteDocumentPermanentlyResultType {
  __typename?: "DeleteDocumentPermanentlyResultType";
  clientDocId: Scalars["String"]["output"];
  reason: Maybe<Scalars["String"]["output"]>;
  resolvedDocId: Maybe<Scalars["ID"]["output"]>;
  status: DeleteDocumentPermanentlyStatus;
  title: Maybe<Scalars["String"]["output"]>;
}

export enum DeleteDocumentPermanentlyStatus {
  AlreadyDeleted = "AlreadyDeleted",
  Deleted = "Deleted",
  Failed = "Failed",
  Forbidden = "Forbidden",
  NotFound = "NotFound",
  NotTrashed = "NotTrashed",
}

export interface DeleteDocumentsPermanentlyInput {
  docIds: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface DeleteDocumentsPermanentlyPayload {
  __typename?: "DeleteDocumentsPermanentlyPayload";
  alreadyDeleted: Scalars["Int"]["output"];
  deleted: Scalars["Int"]["output"];
  documents: Array<DeleteDocumentPermanentlyResultType>;
  failed: Scalars["Int"]["output"];
  forbidden: Scalars["Int"]["output"];
  notFound: Scalars["Int"]["output"];
  notTrashed: Scalars["Int"]["output"];
  requested: Scalars["Int"]["output"];
  rootMetaRemoved: Scalars["Int"]["output"];
}

/** Input for deleting one or more Copilot chat sessions. */
export interface DeleteSessionInput {
  docId?: InputMaybe<Scalars["String"]["input"]>;
  sessionIds: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface DetachDatabaseRowContentDocumentInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface DisableWorkspaceAutomationInput {
  automationId: Scalars["ID"]["input"];
}

export interface DocActionDeniedDataType {
  __typename?: "DocActionDeniedDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

/** A user with an explicitly-granted role on a specific document. */
export interface DocGrantedUserType {
  __typename?: "DocGrantedUserType";
  /** Role the user holds on this document. */
  role: DocRole;
  /** Public profile of the granted user. */
  user: PublicUserType;
}

/** A cursor-based edge wrapping a [`DocGrantedUserType`]. */
export interface DocGrantedUserTypeEdge {
  __typename?: "DocGrantedUserTypeEdge";
  /** Opaque cursor for this edge position. */
  cursor: Scalars["String"]["output"];
  node: DocGrantedUserType;
}

export interface DocHistoryNotFoundDataType {
  __typename?: "DocHistoryNotFoundDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

/** A single history snapshot entry. */
export enum DocHistoryOrigin {
  api = "api",
  automatic = "automatic",
  daily = "daily",
  manual = "manual",
  pdf_export = "pdf_export",
  publish = "publish",
  recovery = "recovery",
  restore = "restore",
}

export interface DocHistoryType {
  __typename?: "DocHistoryType";
  cursor: Scalars["String"]["output"];
  editor: Maybe<EditorType>;
  id: Scalars["String"]["output"];
  origin: Maybe<DocHistoryOrigin>;
  /** Immutable snapshot identity. `id` remains the legacy document selector. */
  snapshotId: Scalars["ID"]["output"];
  timestamp: Scalars["DateTime"]["output"];
  workspaceId: Scalars["String"]["output"];
}

export interface DocMemberLastAccessEdge {
  __typename?: "DocMemberLastAccessEdge";
  cursor: Scalars["String"]["output"];
  node: DocMemberLastAccessNode;
}

export interface DocMemberLastAccessNode {
  __typename?: "DocMemberLastAccessNode";
  lastAccessedAt: Scalars["DateTime"]["output"];
  lastDocId: Maybe<Scalars["String"]["output"]>;
  user: EditorType;
}

export interface DocNotFoundDataType {
  __typename?: "DocNotFoundDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

export interface DocPageAnalytics {
  __typename?: "DocPageAnalytics";
  generatedAt: Scalars["DateTime"]["output"];
  series: Array<DocPageAnalyticsPoint>;
  summary: DocPageAnalyticsSummary;
  window: TimeWindow;
}

export interface DocPageAnalyticsInput {
  timezone?: InputMaybe<Scalars["String"]["input"]>;
  windowDays?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface DocPageAnalyticsPoint {
  __typename?: "DocPageAnalyticsPoint";
  date: Scalars["DateTime"]["output"];
  guestViews: Scalars["Int"]["output"];
  totalViews: Scalars["Int"]["output"];
  uniqueViews: Scalars["Int"]["output"];
}

export interface DocPageAnalyticsSummary {
  __typename?: "DocPageAnalyticsSummary";
  guestViews: Scalars["Int"]["output"];
  lastAccessedAt: Maybe<Scalars["DateTime"]["output"]>;
  totalViews: Scalars["Int"]["output"];
  uniqueViews: Scalars["Int"]["output"];
}

/** Per-document permission matrix, computed from the caller's role. */
export interface DocPermissionsType {
  __typename?: "DocPermissionsType";
  Doc_Comments_Create: Scalars["Boolean"]["output"];
  Doc_Comments_Delete: Scalars["Boolean"]["output"];
  Doc_Comments_Read: Scalars["Boolean"]["output"];
  Doc_Comments_Resolve: Scalars["Boolean"]["output"];
  Doc_Copy: Scalars["Boolean"]["output"];
  Doc_Delete: Scalars["Boolean"]["output"];
  Doc_Duplicate: Scalars["Boolean"]["output"];
  Doc_Properties_Read: Scalars["Boolean"]["output"];
  Doc_Properties_Update: Scalars["Boolean"]["output"];
  Doc_Publish: Scalars["Boolean"]["output"];
  Doc_Read: Scalars["Boolean"]["output"];
  Doc_Restore: Scalars["Boolean"]["output"];
  Doc_TransferOwner: Scalars["Boolean"]["output"];
  Doc_Trash: Scalars["Boolean"]["output"];
  Doc_Update: Scalars["Boolean"]["output"];
  Doc_Users_Manage: Scalars["Boolean"]["output"];
  Doc_Users_Read: Scalars["Boolean"]["output"];
}

export enum DocRole {
  Commenter = "Commenter",
  Editor = "Editor",
  External = "External",
  Manager = "Manager",
  None = "None",
  Owner = "Owner",
  Reader = "Reader",
}

export interface DocType {
  __typename?: "DocType";
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  defaultRole: DocRole;
  id: Scalars["String"]["output"];
  mode: PublicDocMode;
  public: Scalars["Boolean"]["output"];
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

export interface DocUpdateBlockedDataType {
  __typename?: "DocUpdateBlockedDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

/**
 * Reduced document/PDF color proposal derived from the effective app theme.
 * The admin UI may present these as choices, but the mapping from theme to
 * document-safe colors stays server-owned.
 */
export interface DocumentBrandColorPaletteType {
  __typename?: "DocumentBrandColorPaletteType";
  accentColor: Scalars["String"]["output"];
  backgroundColor: Scalars["String"]["output"];
  isDefault: Scalars["Boolean"]["output"];
  name: Scalars["String"]["output"];
  paletteKey: Scalars["String"]["output"];
  primaryColor: Scalars["String"]["output"];
  ruleColor: Scalars["String"]["output"];
  textColor: Scalars["String"]["output"];
  themeName: Scalars["String"]["output"];
  themeSlug: Scalars["String"]["output"];
}

export enum DocumentBrandColorPolicy {
  plain = "plain",
  theme_palette = "theme_palette",
}

/**
 * Workspace document-branding row without audit fields. Document branding is
 * intentionally limited to document-visible identity: logos, footer text and
 * document color policy. Render defaults live in [`PdfExportSettings`].
 */
export interface DocumentBrandingProfile {
  __typename?: "DocumentBrandingProfile";
  brandColorAccent: Maybe<Scalars["String"]["output"]>;
  brandColorBackground: Maybe<Scalars["String"]["output"]>;
  brandColorPrimary: Maybe<Scalars["String"]["output"]>;
  brandColorRule: Maybe<Scalars["String"]["output"]>;
  brandColorText: Maybe<Scalars["String"]["output"]>;
  colorPaletteKey: Maybe<Scalars["String"]["output"]>;
  colorPolicy: Scalars["String"]["output"];
  footerText: Maybe<Scalars["String"]["output"]>;
  logoLargeBlob: Maybe<Scalars["String"]["output"]>;
  logoSmallBlob: Maybe<Scalars["String"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

/**
 * Admin projection of document-visible branding including the audit fields
 * (`updated_at`, `updated_by`). PDF export defaults are exposed through
 * [`PdfExportSettings`] and deliberately do not appear here.
 */
export interface DocumentBrandingProfileAdmin {
  __typename?: "DocumentBrandingProfileAdmin";
  brandColorAccent: Maybe<Scalars["String"]["output"]>;
  brandColorBackground: Maybe<Scalars["String"]["output"]>;
  brandColorPrimary: Maybe<Scalars["String"]["output"]>;
  brandColorRule: Maybe<Scalars["String"]["output"]>;
  brandColorText: Maybe<Scalars["String"]["output"]>;
  colorPaletteKey: Maybe<Scalars["String"]["output"]>;
  colorPolicy: Scalars["String"]["output"];
  footerText: Maybe<Scalars["String"]["output"]>;
  logoLargeBlob: Maybe<Scalars["String"]["output"]>;
  logoSmallBlob: Maybe<Scalars["String"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Scalars["ID"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export enum DocumentComparisonBlockKindType {
  added = "added",
  modified = "modified",
  removed = "removed",
  unchanged = "unchanged",
}

export interface DocumentComparisonBlockType {
  __typename?: "DocumentComparisonBlockType";
  blockId: Scalars["String"]["output"];
  flavour: Scalars["String"]["output"];
  kind: DocumentComparisonBlockKindType;
  /** False for a deletion without an unambiguous native parent/sibling anchor. */
  placementKnown: Scalars["Boolean"]["output"];
  runs: Array<DocumentTextRunType>;
}

export enum DocumentComparisonNoticeKindType {
  ambiguous_removal_anchor = "ambiguous_removal_anchor",
  incomplete_structure = "incomplete_structure",
  partial_extraction = "partial_extraction",
  presentation_not_compared = "presentation_not_compared",
  structure_changed = "structure_changed",
  unsupported_content = "unsupported_content",
}

export interface DocumentComparisonNoticeType {
  __typename?: "DocumentComparisonNoticeType";
  blockId: Maybe<Scalars["String"]["output"]>;
  kind: DocumentComparisonNoticeKindType;
}

/**
 * Editor discovery only. Existing native fields can be filled without fetching
 * this catalog; it contains no document values, identities or authored options.
 */
export interface DocumentFieldCatalogType {
  __typename?: "DocumentFieldCatalogType";
  inputKinds: Array<DocumentFieldInputDescriptorType>;
  maxIdBytes: Scalars["Int"]["output"];
  maxOptions: Scalars["Int"]["output"];
  maxStringBytes: Scalars["Int"]["output"];
  metadata: Array<DocumentFieldMetadataDescriptorType>;
}

export interface DocumentFieldInputDescriptorType {
  __typename?: "DocumentFieldInputDescriptorType";
  hasOptions: Scalars["Boolean"]["output"];
  kind: Scalars["String"]["output"];
  multiple: Scalars["Boolean"]["output"];
}

export interface DocumentFieldMetadataDescriptorType {
  __typename?: "DocumentFieldMetadataDescriptorType";
  formats: Array<Scalars["String"]["output"]>;
  key: Scalars["String"]["output"];
}

export enum DocumentFieldPresentationState {
  UNAVAILABLE = "UNAVAILABLE",
  UNSET = "UNSET",
  VALUE = "VALUE",
}

export interface DocumentFieldPresentationType {
  __typename?: "DocumentFieldPresentationType";
  complete: Scalars["Boolean"]["output"];
  state: DocumentFieldPresentationState;
  text: Maybe<Scalars["String"]["output"]>;
}

export enum DocumentGraphDirection {
  Both = "Both",
  Incoming = "Incoming",
  Outgoing = "Outgoing",
}

export interface DocumentGraphEdgeType {
  __typename?: "DocumentGraphEdgeType";
  firstOccurrencePreview: Maybe<Scalars["String"]["output"]>;
  linkKind: DocumentGraphLinkKind;
  occurrenceCount: Scalars["Int"]["output"];
  occurrences: Array<DocumentGraphOccurrenceType>;
  rawTargetDocId: Scalars["String"]["output"];
  sourceDocId: Scalars["ID"]["output"];
  staleState: DocumentGraphStaleState;
  targetDocId: Maybe<Scalars["ID"]["output"]>;
  targetState: DocumentGraphTargetState;
  targetWorkspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface DocumentGraphIndexStatusType {
  __typename?: "DocumentGraphIndexStatusType";
  attemptCount: Scalars["Int"]["output"];
  currentCount: Scalars["Int"]["output"];
  deletedCount: Scalars["Int"]["output"];
  errorCode: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  extractingCount: Scalars["Int"]["output"];
  failedAt: Maybe<Scalars["DateTime"]["output"]>;
  failedCount: Scalars["Int"]["output"];
  indexedAt: Maybe<Scalars["DateTime"]["output"]>;
  missingStateCount: Scalars["Int"]["output"];
  occurrenceCount: Scalars["Int"]["output"];
  queuedAt: Maybe<Scalars["DateTime"]["output"]>;
  queuedCount: Scalars["Int"]["output"];
  staleCount: Scalars["Int"]["output"];
  staleState: Maybe<DocumentGraphStaleState>;
  startedAt: Maybe<Scalars["DateTime"]["output"]>;
}

export interface DocumentGraphInput {
  after?: InputMaybe<Scalars["String"]["input"]>;
  direction: DocumentGraphDirection;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  focusDocId?: InputMaybe<Scalars["ID"]["input"]>;
  includeOccurrences?: InputMaybe<Scalars["Boolean"]["input"]>;
  metadataFilter?: InputMaybe<DocumentGraphMetadataFilterInput>;
}

export enum DocumentGraphLinkKind {
  DatabaseCellReference = "DatabaseCellReference",
  EmbedLinkedDoc = "EmbedLinkedDoc",
  EmbedSyncedDoc = "EmbedSyncedDoc",
  InlineReference = "InlineReference",
  SurfaceRef = "SurfaceRef",
}

export interface DocumentGraphMetadataFilterInput {
  classifications?: Array<Scalars["String"]["input"]>;
  documentTypes?: Array<Scalars["String"]["input"]>;
  statuses?: Array<Scalars["String"]["input"]>;
}

export interface DocumentGraphNodeType {
  __typename?: "DocumentGraphNodeType";
  classification: Maybe<Scalars["String"]["output"]>;
  deleted: Scalars["Boolean"]["output"];
  docId: Maybe<Scalars["ID"]["output"]>;
  documentType: Maybe<Scalars["String"]["output"]>;
  rawDocId: Scalars["String"]["output"];
  redacted: Scalars["Boolean"]["output"];
  status: Maybe<Scalars["String"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface DocumentGraphOccurrenceType {
  __typename?: "DocumentGraphOccurrenceType";
  extractedAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  linkKind: DocumentGraphLinkKind;
  markdownPreview: Maybe<Scalars["String"]["output"]>;
  paramsJson: Scalars["JSON"]["output"];
  rawTargetDocId: Scalars["String"]["output"];
  sourceBlockId: Scalars["String"]["output"];
  sourceDocId: Scalars["ID"]["output"];
  sourceParentBlockId: Maybe<Scalars["String"]["output"]>;
  sourceParentFlavour: Maybe<Scalars["String"]["output"]>;
  sourceUpdatedAt: Maybe<Scalars["DateTime"]["output"]>;
  targetDocId: Maybe<Scalars["ID"]["output"]>;
  targetState: DocumentGraphTargetState;
  targetWorkspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface DocumentGraphResult {
  __typename?: "DocumentGraphResult";
  databaseReferences: Array<DatabaseDocumentReferenceType>;
  edges: Array<DocumentGraphEdgeType>;
  indexStatus: DocumentGraphIndexStatusType;
  nodes: Array<DocumentGraphNodeType>;
}

export enum DocumentGraphStaleState {
  Current = "Current",
  Deleted = "Deleted",
  Extracting = "Extracting",
  Failed = "Failed",
  Queued = "Queued",
  Stale = "Stale",
}

export enum DocumentGraphTargetState {
  Available = "Available",
  Deleted = "Deleted",
  Missing = "Missing",
  Redacted = "Redacted",
  Unresolved = "Unresolved",
}

export interface DocumentHistoryCaptureType {
  __typename?: "DocumentHistoryCaptureType";
  historyId: Scalars["ID"]["output"];
  version: Maybe<DocumentVersionType>;
}

/** A fixed selected-history/current-persisted reading projection; no capture. */
export interface DocumentHistoryDiffType {
  __typename?: "DocumentHistoryDiffType";
  comparisonBlocks: Array<DocumentComparisonBlockType>;
  currentRevision: Scalars["ID"]["output"];
  extractionPartial: Scalars["Boolean"]["output"];
  notices: Array<DocumentComparisonNoticeType>;
  /** Time the consistent server read opened, not the document modification time. */
  readAt: Scalars["DateTime"]["output"];
  snapshotId: Scalars["ID"]["output"];
}

export interface DocumentLinksInput {
  after?: InputMaybe<Scalars["String"]["input"]>;
  direction: DocumentGraphDirection;
  docId: Scalars["ID"]["input"];
  first?: InputMaybe<Scalars["Int"]["input"]>;
  includeOccurrences?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface DocumentLinksResult {
  __typename?: "DocumentLinksResult";
  databaseReferences: Array<DatabaseDocumentReferenceType>;
  edges: Array<DocumentGraphEdgeType>;
  indexStatus: DocumentGraphIndexStatusType;
  nodes: Array<DocumentGraphNodeType>;
}

export interface DocumentMetadataAudienceType {
  __typename?: "DocumentMetadataAudienceType";
  source: DocumentMetadataSourceType;
  value: DocumentMetadataReferenceValueType;
}

export interface DocumentMetadataFieldDefinitionType {
  __typename?: "DocumentMetadataFieldDefinitionType";
  editableBy: Scalars["String"]["output"];
  enabled: Scalars["Boolean"]["output"];
  exportMode: Scalars["String"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  metadata: Scalars["JSON"]["output"];
  requiredMode: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  validationConfig: Scalars["JSON"]["output"];
  visibleInHeader: Scalars["Boolean"]["output"];
  visibleInLists: Scalars["Boolean"]["output"];
  visibleInProperties: Scalars["Boolean"]["output"];
}

export interface DocumentMetadataFieldLockType {
  __typename?: "DocumentMetadataFieldLockType";
  editable: Scalars["Boolean"]["output"];
  inheritanceMode: DocumentMetadataInheritanceModeType;
  key: Scalars["String"]["output"];
  reason: Maybe<Scalars["String"]["output"]>;
}

export interface DocumentMetadataFieldValueType {
  __typename?: "DocumentMetadataFieldValueType";
  /**
   * ISO-8601 calendar date (`YYYY-MM-DD`). The domain keeps calendar dates as
   * `NaiveDate`; GraphQL exposes the portable wire format instead of a
   * chrono-specific scalar that codegen cannot type safely.
   */
  dateValue: Maybe<Scalars["String"]["output"]>;
  key: Scalars["String"]["output"];
  reference: Maybe<DocumentMetadataReferenceValueType>;
  source: DocumentMetadataSourceType;
  textValue: Maybe<Scalars["String"]["output"]>;
  timestampValue: Maybe<Scalars["DateTime"]["output"]>;
  userId: Maybe<Scalars["ID"]["output"]>;
}

export interface DocumentMetadataFieldVisibilityInput {
  field: Scalars["String"]["input"];
  visible: Scalars["Boolean"]["input"];
}

/** Persisted overrides. Nullable fields intentionally inherit defaults. */
export interface DocumentMetadataFieldVisibilityType {
  __typename?: "DocumentMetadataFieldVisibilityType";
  field: Scalars["String"]["output"];
  visible: Scalars["Boolean"]["output"];
}

export interface DocumentMetadataIndexRowType {
  __typename?: "DocumentMetadataIndexRowType";
  canPublish: Scalars["Boolean"]["output"];
  classificationId: Maybe<Scalars["ID"]["output"]>;
  createdBy: Maybe<Scalars["ID"]["output"]>;
  currentVersionId: Maybe<Scalars["ID"]["output"]>;
  dirtySinceCurrentVersion: Scalars["Boolean"]["output"];
  docId: Scalars["ID"]["output"];
  documentTypeId: Maybe<Scalars["ID"]["output"]>;
  edgelessColorTheme: Maybe<Scalars["String"]["output"]>;
  externalId: Maybe<Scalars["ID"]["output"]>;
  integrationType: Maybe<Scalars["String"]["output"]>;
  isTemplate: Scalars["Boolean"]["output"];
  journalDate: Maybe<Scalars["NaiveDate"]["output"]>;
  pageWidth: Maybe<Scalars["String"]["output"]>;
  primaryMode: Maybe<Scalars["String"]["output"]>;
  reviewDueAt: Maybe<Scalars["DateTime"]["output"]>;
  statusId: Maybe<Scalars["ID"]["output"]>;
  /** Current ordered labels, joined after the shared index's visibility filter. */
  tagIds: Array<Scalars["ID"]["output"]>;
  templateCategory: Maybe<Scalars["String"]["output"]>;
  templateOrigin: Maybe<Scalars["String"]["output"]>;
  templateState: Maybe<Scalars["String"]["output"]>;
  templateTags: Maybe<Array<Scalars["String"]["output"]>>;
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  validUntil: Maybe<Scalars["DateTime"]["output"]>;
}

export enum DocumentMetadataInheritanceModeType {
  DOCUMENT_ONLY = "DOCUMENT_ONLY",
  INHERITED = "INHERITED",
  RELATION_INHERITED = "RELATION_INHERITED",
  SPECIALIZED_SUBSYSTEM = "SPECIALIZED_SUBSYSTEM",
  SYSTEM_READONLY = "SYSTEM_READONLY",
}

export interface DocumentMetadataIntegrationType {
  __typename?: "DocumentMetadataIntegrationType";
  integrationType: Maybe<Scalars["String"]["output"]>;
}

export interface DocumentMetadataJournalType {
  __typename?: "DocumentMetadataJournalType";
  /** ISO-8601 calendar date (`YYYY-MM-DD`). */
  journalDate: Maybe<Scalars["String"]["output"]>;
}

export interface DocumentMetadataPolicyType {
  __typename?: "DocumentMetadataPolicyType";
  locks: Array<DocumentMetadataFieldLockType>;
}

export interface DocumentMetadataPresentationType {
  __typename?: "DocumentMetadataPresentationType";
  edgelessColorTheme: Maybe<Scalars["String"]["output"]>;
  pageWidth: Maybe<Scalars["String"]["output"]>;
  primaryMode: Maybe<Scalars["String"]["output"]>;
}

export enum DocumentMetadataProjectionModeType {
  AFFINE_LEGACY = "AFFINE_LEGACY",
  MYOXUS_NATIVE = "MYOXUS_NATIVE",
}

export interface DocumentMetadataReferenceValueType {
  __typename?: "DocumentMetadataReferenceValueType";
  id: Scalars["ID"]["output"];
  isActive: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
}

export enum DocumentMetadataSourceType {
  DOCUMENT = "DOCUMENT",
  FALLBACK = "FALLBACK",
  ORGANIZATION = "ORGANIZATION",
  WORKSPACE = "WORKSPACE",
}

export interface DocumentMetadataSystemFactsType {
  __typename?: "DocumentMetadataSystemFactsType";
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  metadataUpdatedAt: Maybe<Scalars["DateTime"]["output"]>;
  metadataUpdatedBy: Maybe<Scalars["ID"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
}

export interface DocumentMetadataTemplateType {
  __typename?: "DocumentMetadataTemplateType";
  category: Maybe<Scalars["String"]["output"]>;
  instanceId: Maybe<Scalars["ID"]["output"]>;
  origin: Maybe<Scalars["String"]["output"]>;
  revisionId: Maybe<Scalars["ID"]["output"]>;
  state: Scalars["String"]["output"];
  tags: Maybe<Array<Scalars["String"]["output"]>>;
  templateId: Maybe<Scalars["ID"]["output"]>;
}

export interface DocumentMetadataType {
  __typename?: "DocumentMetadataType";
  audience: Array<DocumentMetadataAudienceType>;
  docId: Scalars["ID"]["output"];
  fields: Array<DocumentMetadataFieldValueType>;
  integration: Maybe<DocumentMetadataIntegrationType>;
  journal: DocumentMetadataJournalType;
  legacy: Scalars["JSON"]["output"];
  metadataRevision: Scalars["Int"]["output"];
  metadataUpdatedAt: Maybe<Scalars["DateTime"]["output"]>;
  metadataUpdatedBy: Maybe<Scalars["ID"]["output"]>;
  policy: DocumentMetadataPolicyType;
  presentation: Maybe<DocumentMetadataPresentationType>;
  projectionMode: DocumentMetadataProjectionModeType;
  projectionVersion: Scalars["String"]["output"];
  system: DocumentMetadataSystemFactsType;
  template: Maybe<DocumentMetadataTemplateType>;
  workspaceId: Scalars["ID"]["output"];
}

export enum DocumentMetadataValidationActionType {
  export_pdf = "export_pdf",
  read = "read",
  set_metadata = "set_metadata",
  share_public = "share_public",
  transition_status = "transition_status",
}

export interface DocumentMetadataValidationIssueType {
  __typename?: "DocumentMetadataValidationIssueType";
  blockedActions: Array<Scalars["String"]["output"]>;
  code: Scalars["String"]["output"];
  details: Scalars["JSON"]["output"];
  key: Maybe<Scalars["String"]["output"]>;
  message: Scalars["String"]["output"];
  severity: DocumentMetadataValidationSeverityType;
}

export enum DocumentMetadataValidationSeverityType {
  error = "error",
  info = "info",
  warning = "warning",
}

export interface DocumentMetadataValidationType {
  __typename?: "DocumentMetadataValidationType";
  blockedActions: Array<Scalars["String"]["output"]>;
  errors: Array<DocumentMetadataValidationIssueType>;
  missingRequiredMetadataFields: Array<Scalars["String"]["output"]>;
  valid: Scalars["Boolean"]["output"];
  warnings: Array<DocumentMetadataValidationIssueType>;
}

export interface DocumentMetadataValueDefinitionType {
  __typename?: "DocumentMetadataValueDefinitionType";
  color: Maybe<Scalars["String"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  fieldKey: Scalars["String"]["output"];
  icon: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  isActive: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  metadata: Scalars["JSON"]["output"];
  sortOrder: Scalars["Int"]["output"];
}

export interface DocumentReview {
  __typename?: "DocumentReview";
  acceptedDescriptor: Maybe<AssistantPackage>;
  acceptedPlan: PreparedDocumentReview;
  canApprove: Scalars["Boolean"]["output"];
  canRequestChanges: Scalars["Boolean"]["output"];
  canRetry: Scalars["Boolean"]["output"];
  canStop: Scalars["Boolean"]["output"];
  currentSourceRevision: Maybe<Scalars["String"]["output"]>;
  decision: Maybe<DocumentReviewDecisionKind>;
  expectedStatusEditRevision: Maybe<Scalars["Int"]["output"]>;
  expectedTaskEditRevision: Maybe<Scalars["Int"]["output"]>;
  followUpTaskAvailable: Scalars["Boolean"]["output"];
  followUpTaskId: Scalars["ID"]["output"];
  reason: Maybe<Scalars["String"]["output"]>;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  reviewTaskAvailable: Scalars["Boolean"]["output"];
  reviewTaskId: Scalars["ID"]["output"];
  run: WorkspaceAutomationRunType;
  sourceAvailable: Scalars["Boolean"]["output"];
  waitId: Scalars["String"]["output"];
}

export enum DocumentReviewDecisionKind {
  Approve = "Approve",
  RequestChanges = "RequestChanges",
}

export interface DocumentReviewPlanningType {
  __typename?: "DocumentReviewPlanningType";
  blockedReason: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  leadDays: Scalars["Int"]["output"];
  metadataRevision: Scalars["Int"]["output"];
  nextStart: Maybe<Scalars["DateTime"]["output"]>;
  processDeadline: Maybe<Scalars["DateTime"]["output"]>;
  ready: Scalars["Boolean"]["output"];
  responsibleId: Maybe<Scalars["ID"]["output"]>;
  runId: Maybe<Scalars["ID"]["output"]>;
  sourceDeadline: Maybe<Scalars["DateTime"]["output"]>;
  zone: Scalars["String"]["output"];
}

export interface DocumentReviewRunInput {
  runId: Scalars["ID"]["input"];
}

export interface DocumentStatusSchemaType {
  __typename?: "DocumentStatusSchemaType";
  complexity: Scalars["String"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  isActive: Scalars["Boolean"]["output"];
  isPreset: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  metadata: Scalars["JSON"]["output"];
}

export interface DocumentStatusTransitionType {
  __typename?: "DocumentStatusTransitionType";
  createsVersion: Scalars["String"]["output"];
  dateEnforcement: Scalars["String"]["output"];
  fromStatusId: Scalars["ID"]["output"];
  metadata: Scalars["JSON"]["output"];
  requiredMetadataFields: Array<Scalars["String"]["output"]>;
  requiredRoles: Array<Scalars["String"]["output"]>;
  setsVersionKind: Maybe<Scalars["String"]["output"]>;
  toStatusId: Scalars["ID"]["output"];
}

export interface DocumentStatusValueType {
  __typename?: "DocumentStatusValueType";
  color: Maybe<Scalars["String"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  icon: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  isActive: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  metadata: Scalars["JSON"]["output"];
  okfStatus: Scalars["String"]["output"];
  schemaId: Scalars["ID"]["output"];
  sortOrder: Scalars["Int"]["output"];
  terminal: Scalars["Boolean"]["output"];
}

export enum DocumentTextRunKindType {
  added = "added",
  removed = "removed",
  unchanged = "unchanged",
}

export interface DocumentTextRunType {
  __typename?: "DocumentTextRunType";
  kind: DocumentTextRunKindType;
  text: Scalars["String"]["output"];
}

export interface DocumentTypeDefinitionType {
  __typename?: "DocumentTypeDefinitionType";
  color: Maybe<Scalars["String"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  icon: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  isActive: Scalars["Boolean"]["output"];
  isSuggested: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
}

export enum DocumentVersionBlockDiffKindType {
  added = "added",
  modified = "modified",
  removed = "removed",
}

export interface DocumentVersionBlockDiffType {
  __typename?: "DocumentVersionBlockDiffType";
  blockId: Scalars["String"]["output"];
  fromChildren: Array<Scalars["String"]["output"]>;
  fromFlavour: Maybe<Scalars["String"]["output"]>;
  fromText: Maybe<Scalars["String"]["output"]>;
  kind: DocumentVersionBlockDiffKindType;
  toChildren: Array<Scalars["String"]["output"]>;
  toFlavour: Maybe<Scalars["String"]["output"]>;
  toText: Maybe<Scalars["String"]["output"]>;
}

export interface DocumentVersionDiffType {
  __typename?: "DocumentVersionDiffType";
  blockDiffs: Array<DocumentVersionBlockDiffType>;
  comparisonBlocks: Array<DocumentComparisonBlockType>;
  extractionPartial: Scalars["Boolean"]["output"];
  fromBlockCount: Scalars["Int"]["output"];
  notices: Array<DocumentComparisonNoticeType>;
  stateVector: DocumentVersionStateVectorDiffType;
  textDiffs: Array<DocumentVersionTextDiffType>;
  toBlockCount: Scalars["Int"]["output"];
}

export interface DocumentVersionPolicyType {
  __typename?: "DocumentVersionPolicyType";
  autoVersionOn: Array<AutoVersionTriggerType>;
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  customPattern: Maybe<Scalars["String"]["output"]>;
  enabledByDefault: Scalars["Boolean"]["output"];
  exportVersionsProtected: Scalars["Boolean"]["output"];
  id: Scalars["ID"]["output"];
  isDefault: Scalars["Boolean"]["output"];
  metadataSchema: Scalars["JSON"]["output"];
  name: Scalars["String"]["output"];
  pinManualVersions: Scalars["Boolean"]["output"];
  pinPublishVersions: Scalars["Boolean"]["output"];
  publishedVersionsProtected: Scalars["Boolean"]["output"];
  retentionCount: Scalars["Int"]["output"];
  schemePreset: Scalars["String"]["output"];
  scope: Scalars["String"]["output"];
  timezoneMode: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface DocumentVersionStateVectorDiffType {
  __typename?: "DocumentVersionStateVectorDiffType";
  changed: Scalars["Boolean"]["output"];
  fromStateVectorSha256: Scalars["String"]["output"];
  toStateVectorSha256: Scalars["String"]["output"];
}

export interface DocumentVersionTextDiffType {
  __typename?: "DocumentVersionTextDiffType";
  addedLines: Array<Scalars["String"]["output"]>;
  addedWords: Array<Scalars["String"]["output"]>;
  blockId: Scalars["String"]["output"];
  fromText: Scalars["String"]["output"];
  removedLines: Array<Scalars["String"]["output"]>;
  removedWords: Array<Scalars["String"]["output"]>;
  runs: Array<DocumentTextRunType>;
  toText: Scalars["String"]["output"];
}

export interface DocumentVersionType {
  __typename?: "DocumentVersionType";
  contentHash: Maybe<Scalars["String"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Scalars["ID"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  docHistoryId: Scalars["ID"]["output"];
  docId: Scalars["ID"]["output"];
  event: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  isPinned: Scalars["Boolean"]["output"];
  isProtected: Scalars["Boolean"]["output"];
  kind: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  metadata: Scalars["JSON"]["output"];
  policyId: Maybe<Scalars["ID"]["output"]>;
  policySnapshot: Scalars["JSON"]["output"];
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  versionNo: Maybe<Scalars["Int"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface DocumentVersioningSettingsType {
  __typename?: "DocumentVersioningSettingsType";
  autoVersionOn: Array<AutoVersionTriggerType>;
  docId: Scalars["ID"]["output"];
  enabled: Scalars["Boolean"]["output"];
  retentionCount: Scalars["Int"]["output"];
}

/** Brief user info returned in pageMeta and history entries. */
export interface EditorType {
  __typename?: "EditorType";
  avatarUrl: Maybe<Scalars["String"]["output"]>;
  name: Scalars["String"]["output"];
}

export interface EffectiveAssistanceType {
  __typename?: "EffectiveAssistanceType";
  interactiveMode: AssistanceMode;
  mode: AssistanceMode;
  source: AssistanceSource;
  userDefaultExplicit: Scalars["Boolean"]["output"];
}

/** Application-resolved values ready for direct consumption. */
export interface EffectiveUserPreferenceValuesType {
  __typename?: "EffectiveUserPreferenceValuesType";
  aiModelId: Maybe<Scalars["String"]["output"]>;
  aiReasoningEnabled: Scalars["Boolean"]["output"];
  assistanceMode: AssistanceMode;
  colorMode: Scalars["String"]["output"];
  dateFormat: Scalars["String"]["output"];
  defaultDocumentLanguage: Scalars["String"]["output"];
  documentMetadataHeaderVisibility: Array<WorkspaceDocumentMetadataVisibilityType>;
  edgelessDefaultTheme: Scalars["String"]["output"];
  editorCustomFontFamily: Scalars["String"]["output"];
  editorFontFamily: Scalars["String"]["output"];
  editorFontSize: Scalars["Int"]["output"];
  fullWidthLayout: Scalars["Boolean"]["output"];
  imageAntialiasing: Scalars["Boolean"]["output"];
  journalFirstDayOfWeek: Scalars["String"]["output"];
  journalShowCalendarWeeks: Scalars["Boolean"]["output"];
  locale: Scalars["String"]["output"];
  newDocumentMode: Scalars["String"]["output"];
  noisyBackground: Scalars["Boolean"]["output"];
  notifyCreatedDocuments: Scalars["Boolean"]["output"];
  openDocumentMode: Scalars["String"]["output"];
  receiveCommentEmail: Scalars["Boolean"]["output"];
  receiveInvitationEmail: Scalars["Boolean"]["output"];
  receiveMentionEmail: Scalars["Boolean"]["output"];
  showLinkedDocuments: Scalars["Boolean"]["output"];
  telemetryEnabled: Scalars["Boolean"]["output"];
  templateCatalogViews: Maybe<Array<TemplateCatalogViewType>>;
  timeFormat: Scalars["String"]["output"];
  timezone: Scalars["String"]["output"];
  workbenchToolLayouts: Maybe<Array<WorkbenchToolLayoutType>>;
  workspaceDashboardLayouts: Maybe<Array<WorkspaceDashboardLayoutType>>;
}

export interface EmptyWorkspaceTrashInput {
  clientVisibleDocIds?: InputMaybe<Array<Scalars["String"]["input"]>>;
  workspaceId: Scalars["ID"]["input"];
}

/** Union of all error data types — matches the upstream `ErrorDataUnion`. */
export type ErrorDataUnion =
  | AlreadyInSpaceDataType
  | BlobNotFoundDataType
  | CalendarProviderRequestErrorDataType
  | CopilotContextFileNotSupportedDataType
  | CopilotDocNotFoundDataType
  | CopilotFailedToAddWorkspaceFileEmbeddingDataType
  | CopilotFailedToGenerateEmbeddingDataType
  | CopilotFailedToMatchContextDataType
  | CopilotFailedToMatchGlobalContextDataType
  | CopilotFailedToModifyContextDataType
  | CopilotInvalidContextDataType
  | CopilotMessageNotFoundDataType
  | CopilotPromptNotFoundDataType
  | CopilotProviderNotSupportedDataType
  | CopilotProviderSideErrorDataType
  | DocActionDeniedDataType
  | DocHistoryNotFoundDataType
  | DocNotFoundDataType
  | DocUpdateBlockedDataType
  | ExpectToGrantDocUserRolesDataType
  | ExpectToRevokeDocUserRolesDataType
  | ExpectToUpdateDocUserRoleDataType
  | GraphqlBadRequestDataType
  | HttpRequestErrorDataType
  | InvalidAppConfigDataType
  | InvalidAppConfigInputDataType
  | InvalidEmailDataType
  | InvalidHistoryTimestampDataType
  | InvalidIndexerInputDataType
  | InvalidLicenseToActivateDataType
  | InvalidLicenseUpdateParamsDataType
  | InvalidOauthCallbackCodeDataType
  | InvalidOauthResponseDataType
  | InvalidPasswordLengthDataType
  | InvalidRuntimeConfigTypeDataType
  | InvalidSearchProviderRequestDataType
  | MemberNotFoundInSpaceDataType
  | MentionUserDocAccessDeniedDataType
  | MissingOauthQueryParameterDataType
  | NoCopilotProviderAvailableDataType
  | NoMoreSeatDataType
  | NotInSpaceDataType
  | QueryTooLongDataType
  | ResponseTooLargeErrorDataType
  | RuntimeConfigNotFoundDataType
  | SameSubscriptionRecurringDataType
  | SpaceAccessDeniedDataType
  | SpaceNotFoundDataType
  | SpaceOwnerNotFoundDataType
  | SpaceShouldHaveOnlyOneOwnerDataType
  | SsrfBlockedErrorDataType
  | SubscriptionAlreadyExistsDataType
  | SubscriptionNotExistsDataType
  | SubscriptionPlanNotFoundDataType
  | UnknownOauthProviderDataType
  | UnsupportedClientVersionDataType
  | UnsupportedSubscriptionPlanDataType
  | ValidationErrorDataType
  | VersionRejectedDataType
  | WorkspacePermissionNotFoundDataType
  | WrongSignInCredentialsDataType;

/**
 * All known error names in the API — mirrors the upstream AFFiNE schema.
 *
 * The frontend imports this enum for pattern-matching on error responses.
 */
export enum ErrorNames {
  ACCESS_DENIED = "ACCESS_DENIED",
  ACTION_FORBIDDEN = "ACTION_FORBIDDEN",
  ALREADY_IN_SPACE = "ALREADY_IN_SPACE",
  AUTHENTICATION_REQUIRED = "AUTHENTICATION_REQUIRED",
  BAD_REQUEST = "BAD_REQUEST",
  BLOB_INVALID = "BLOB_INVALID",
  BLOB_NOT_FOUND = "BLOB_NOT_FOUND",
  BLOB_QUOTA_EXCEEDED = "BLOB_QUOTA_EXCEEDED",
  CALENDAR_PROVIDER_REQUEST_ERROR = "CALENDAR_PROVIDER_REQUEST_ERROR",
  CANNOT_DELETE_ALL_ADMIN_ACCOUNT = "CANNOT_DELETE_ALL_ADMIN_ACCOUNT",
  CANNOT_DELETE_OWN_ACCOUNT = "CANNOT_DELETE_OWN_ACCOUNT",
  CANT_UPDATE_ONETIME_PAYMENT_SUBSCRIPTION = "CANT_UPDATE_ONETIME_PAYMENT_SUBSCRIPTION",
  CAN_NOT_BATCH_GRANT_DOC_OWNER_PERMISSIONS = "CAN_NOT_BATCH_GRANT_DOC_OWNER_PERMISSIONS",
  CAN_NOT_REVOKE_YOURSELF = "CAN_NOT_REVOKE_YOURSELF",
  CAPTCHA_VERIFICATION_FAILED = "CAPTCHA_VERIFICATION_FAILED",
  COMMENT_ATTACHMENT_NOT_FOUND = "COMMENT_ATTACHMENT_NOT_FOUND",
  COMMENT_ATTACHMENT_QUOTA_EXCEEDED = "COMMENT_ATTACHMENT_QUOTA_EXCEEDED",
  COMMENT_NOT_FOUND = "COMMENT_NOT_FOUND",
  COPILOT_ACTION_TAKEN = "COPILOT_ACTION_TAKEN",
  COPILOT_CONTEXT_FILE_NOT_SUPPORTED = "COPILOT_CONTEXT_FILE_NOT_SUPPORTED",
  COPILOT_DOCS_NOT_FOUND = "COPILOT_DOCS_NOT_FOUND",
  COPILOT_DOC_NOT_FOUND = "COPILOT_DOC_NOT_FOUND",
  COPILOT_EMBEDDING_DISABLED = "COPILOT_EMBEDDING_DISABLED",
  COPILOT_EMBEDDING_UNAVAILABLE = "COPILOT_EMBEDDING_UNAVAILABLE",
  COPILOT_FAILED_TO_ADD_WORKSPACE_FILE_EMBEDDING = "COPILOT_FAILED_TO_ADD_WORKSPACE_FILE_EMBEDDING",
  COPILOT_FAILED_TO_CREATE_MESSAGE = "COPILOT_FAILED_TO_CREATE_MESSAGE",
  COPILOT_FAILED_TO_GENERATE_EMBEDDING = "COPILOT_FAILED_TO_GENERATE_EMBEDDING",
  COPILOT_FAILED_TO_GENERATE_TEXT = "COPILOT_FAILED_TO_GENERATE_TEXT",
  COPILOT_FAILED_TO_MATCH_CONTEXT = "COPILOT_FAILED_TO_MATCH_CONTEXT",
  COPILOT_FAILED_TO_MATCH_GLOBAL_CONTEXT = "COPILOT_FAILED_TO_MATCH_GLOBAL_CONTEXT",
  COPILOT_FAILED_TO_MODIFY_CONTEXT = "COPILOT_FAILED_TO_MODIFY_CONTEXT",
  COPILOT_INVALID_CONTEXT = "COPILOT_INVALID_CONTEXT",
  COPILOT_MESSAGE_NOT_FOUND = "COPILOT_MESSAGE_NOT_FOUND",
  COPILOT_PROMPT_INVALID = "COPILOT_PROMPT_INVALID",
  COPILOT_PROMPT_NOT_FOUND = "COPILOT_PROMPT_NOT_FOUND",
  COPILOT_PROVIDER_NOT_SUPPORTED = "COPILOT_PROVIDER_NOT_SUPPORTED",
  COPILOT_PROVIDER_SIDE_ERROR = "COPILOT_PROVIDER_SIDE_ERROR",
  COPILOT_QUOTA_EXCEEDED = "COPILOT_QUOTA_EXCEEDED",
  COPILOT_SESSION_DELETED = "COPILOT_SESSION_DELETED",
  COPILOT_SESSION_INVALID_INPUT = "COPILOT_SESSION_INVALID_INPUT",
  COPILOT_SESSION_NOT_FOUND = "COPILOT_SESSION_NOT_FOUND",
  COPILOT_TRANSCRIPTION_AUDIO_NOT_PROVIDED = "COPILOT_TRANSCRIPTION_AUDIO_NOT_PROVIDED",
  COPILOT_TRANSCRIPTION_JOB_EXISTS = "COPILOT_TRANSCRIPTION_JOB_EXISTS",
  COPILOT_TRANSCRIPTION_JOB_NOT_FOUND = "COPILOT_TRANSCRIPTION_JOB_NOT_FOUND",
  CUSTOMER_PORTAL_CREATE_FAILED = "CUSTOMER_PORTAL_CREATE_FAILED",
  DOC_ACTION_DENIED = "DOC_ACTION_DENIED",
  DOC_DEFAULT_ROLE_CAN_NOT_BE_OWNER = "DOC_DEFAULT_ROLE_CAN_NOT_BE_OWNER",
  DOC_HISTORY_NOT_FOUND = "DOC_HISTORY_NOT_FOUND",
  DOC_IS_NOT_PUBLIC = "DOC_IS_NOT_PUBLIC",
  DOC_NOT_FOUND = "DOC_NOT_FOUND",
  DOC_UPDATE_BLOCKED = "DOC_UPDATE_BLOCKED",
  EMAIL_ALREADY_USED = "EMAIL_ALREADY_USED",
  EMAIL_SERVICE_NOT_CONFIGURED = "EMAIL_SERVICE_NOT_CONFIGURED",
  EMAIL_TOKEN_NOT_FOUND = "EMAIL_TOKEN_NOT_FOUND",
  EMAIL_VERIFICATION_REQUIRED = "EMAIL_VERIFICATION_REQUIRED",
  EXPECT_TO_GRANT_DOC_USER_ROLES = "EXPECT_TO_GRANT_DOC_USER_ROLES",
  EXPECT_TO_PUBLISH_DOC = "EXPECT_TO_PUBLISH_DOC",
  EXPECT_TO_REVOKE_DOC_USER_ROLES = "EXPECT_TO_REVOKE_DOC_USER_ROLES",
  EXPECT_TO_REVOKE_PUBLIC_DOC = "EXPECT_TO_REVOKE_PUBLIC_DOC",
  EXPECT_TO_UPDATE_DOC_USER_ROLE = "EXPECT_TO_UPDATE_DOC_USER_ROLE",
  FAILED_TO_CHECKOUT = "FAILED_TO_CHECKOUT",
  FAILED_TO_SAVE_UPDATES = "FAILED_TO_SAVE_UPDATES",
  FAILED_TO_UPSERT_SNAPSHOT = "FAILED_TO_UPSERT_SNAPSHOT",
  GRAPHQL_BAD_REQUEST = "GRAPHQL_BAD_REQUEST",
  HTTP_REQUEST_ERROR = "HTTP_REQUEST_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  INVALID_APP_CONFIG = "INVALID_APP_CONFIG",
  INVALID_APP_CONFIG_INPUT = "INVALID_APP_CONFIG_INPUT",
  INVALID_AUTH_STATE = "INVALID_AUTH_STATE",
  INVALID_CHECKOUT_PARAMETERS = "INVALID_CHECKOUT_PARAMETERS",
  INVALID_EMAIL = "INVALID_EMAIL",
  INVALID_EMAIL_TOKEN = "INVALID_EMAIL_TOKEN",
  INVALID_HISTORY_TIMESTAMP = "INVALID_HISTORY_TIMESTAMP",
  INVALID_INDEXER_INPUT = "INVALID_INDEXER_INPUT",
  INVALID_INVITATION = "INVALID_INVITATION",
  INVALID_LICENSE_SESSION_ID = "INVALID_LICENSE_SESSION_ID",
  INVALID_LICENSE_TO_ACTIVATE = "INVALID_LICENSE_TO_ACTIVATE",
  INVALID_LICENSE_UPDATE_PARAMS = "INVALID_LICENSE_UPDATE_PARAMS",
  INVALID_OAUTH_CALLBACK_CODE = "INVALID_OAUTH_CALLBACK_CODE",
  INVALID_OAUTH_CALLBACK_STATE = "INVALID_OAUTH_CALLBACK_STATE",
  INVALID_OAUTH_RESPONSE = "INVALID_OAUTH_RESPONSE",
  INVALID_PASSWORD_LENGTH = "INVALID_PASSWORD_LENGTH",
  INVALID_RUNTIME_CONFIG_TYPE = "INVALID_RUNTIME_CONFIG_TYPE",
  INVALID_SEARCH_PROVIDER_REQUEST = "INVALID_SEARCH_PROVIDER_REQUEST",
  INVALID_SUBSCRIPTION_PARAMETERS = "INVALID_SUBSCRIPTION_PARAMETERS",
  LICENSE_EXPIRED = "LICENSE_EXPIRED",
  LICENSE_NOT_FOUND = "LICENSE_NOT_FOUND",
  LICENSE_REVEALED = "LICENSE_REVEALED",
  LINK_EXPIRED = "LINK_EXPIRED",
  MAILER_SERVICE_IS_NOT_CONFIGURED = "MAILER_SERVICE_IS_NOT_CONFIGURED",
  MANAGED_BY_APP_STORE_OR_PLAY = "MANAGED_BY_APP_STORE_OR_PLAY",
  MEMBER_NOT_FOUND_IN_SPACE = "MEMBER_NOT_FOUND_IN_SPACE",
  MEMBER_QUOTA_EXCEEDED = "MEMBER_QUOTA_EXCEEDED",
  MENTION_USER_DOC_ACCESS_DENIED = "MENTION_USER_DOC_ACCESS_DENIED",
  MENTION_USER_ONESELF_DENIED = "MENTION_USER_ONESELF_DENIED",
  MISSING_OAUTH_QUERY_PARAMETER = "MISSING_OAUTH_QUERY_PARAMETER",
  NETWORK_ERROR = "NETWORK_ERROR",
  NEW_OWNER_IS_NOT_ACTIVE_MEMBER = "NEW_OWNER_IS_NOT_ACTIVE_MEMBER",
  NOTIFICATION_NOT_FOUND = "NOTIFICATION_NOT_FOUND",
  NOT_FOUND = "NOT_FOUND",
  NOT_IN_SPACE = "NOT_IN_SPACE",
  NO_COPILOT_PROVIDER_AVAILABLE = "NO_COPILOT_PROVIDER_AVAILABLE",
  NO_MORE_SEAT = "NO_MORE_SEAT",
  OAUTH_ACCOUNT_ALREADY_CONNECTED = "OAUTH_ACCOUNT_ALREADY_CONNECTED",
  OAUTH_STATE_EXPIRED = "OAUTH_STATE_EXPIRED",
  OWNER_CAN_NOT_LEAVE_WORKSPACE = "OWNER_CAN_NOT_LEAVE_WORKSPACE",
  PASSWORD_REQUIRED = "PASSWORD_REQUIRED",
  QUERY_TOO_LONG = "QUERY_TOO_LONG",
  REPLY_NOT_FOUND = "REPLY_NOT_FOUND",
  RESPONSE_TOO_LARGE_ERROR = "RESPONSE_TOO_LARGE_ERROR",
  RUNTIME_CONFIG_NOT_FOUND = "RUNTIME_CONFIG_NOT_FOUND",
  SAME_EMAIL_PROVIDED = "SAME_EMAIL_PROVIDED",
  SAME_SUBSCRIPTION_RECURRING = "SAME_SUBSCRIPTION_RECURRING",
  SEARCH_PROVIDER_NOT_FOUND = "SEARCH_PROVIDER_NOT_FOUND",
  SIGN_UP_FORBIDDEN = "SIGN_UP_FORBIDDEN",
  SPACE_ACCESS_DENIED = "SPACE_ACCESS_DENIED",
  SPACE_NOT_FOUND = "SPACE_NOT_FOUND",
  SPACE_OWNER_NOT_FOUND = "SPACE_OWNER_NOT_FOUND",
  SPACE_SHOULD_HAVE_ONLY_ONE_OWNER = "SPACE_SHOULD_HAVE_ONLY_ONE_OWNER",
  SSRF_BLOCKED_ERROR = "SSRF_BLOCKED_ERROR",
  STORAGE_QUOTA_EXCEEDED = "STORAGE_QUOTA_EXCEEDED",
  SUBSCRIPTION_ALREADY_EXISTS = "SUBSCRIPTION_ALREADY_EXISTS",
  SUBSCRIPTION_EXPIRED = "SUBSCRIPTION_EXPIRED",
  SUBSCRIPTION_HAS_BEEN_CANCELED = "SUBSCRIPTION_HAS_BEEN_CANCELED",
  SUBSCRIPTION_HAS_NOT_BEEN_CANCELED = "SUBSCRIPTION_HAS_NOT_BEEN_CANCELED",
  SUBSCRIPTION_NOT_EXISTS = "SUBSCRIPTION_NOT_EXISTS",
  SUBSCRIPTION_PLAN_NOT_FOUND = "SUBSCRIPTION_PLAN_NOT_FOUND",
  TOO_MANY_REQUEST = "TOO_MANY_REQUEST",
  UNKNOWN_OAUTH_PROVIDER = "UNKNOWN_OAUTH_PROVIDER",
  UNSPLASH_IS_NOT_CONFIGURED = "UNSPLASH_IS_NOT_CONFIGURED",
  UNSUPPORTED_CLIENT_VERSION = "UNSUPPORTED_CLIENT_VERSION",
  UNSUPPORTED_SUBSCRIPTION_PLAN = "UNSUPPORTED_SUBSCRIPTION_PLAN",
  USER_AVATAR_NOT_FOUND = "USER_AVATAR_NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  VERSION_REJECTED = "VERSION_REJECTED",
  WORKSPACE_ID_REQUIRED_FOR_TEAM_SUBSCRIPTION = "WORKSPACE_ID_REQUIRED_FOR_TEAM_SUBSCRIPTION",
  WORKSPACE_ID_REQUIRED_TO_UPDATE_TEAM_SUBSCRIPTION = "WORKSPACE_ID_REQUIRED_TO_UPDATE_TEAM_SUBSCRIPTION",
  WORKSPACE_LICENSE_ALREADY_EXISTS = "WORKSPACE_LICENSE_ALREADY_EXISTS",
  WORKSPACE_PERMISSION_NOT_FOUND = "WORKSPACE_PERMISSION_NOT_FOUND",
  WRONG_SIGN_IN_CREDENTIALS = "WRONG_SIGN_IN_CREDENTIALS",
  WRONG_SIGN_IN_METHOD = "WRONG_SIGN_IN_METHOD",
}

export interface ExpectToGrantDocUserRolesDataType {
  __typename?: "ExpectToGrantDocUserRolesDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

export interface ExpectToRevokeDocUserRolesDataType {
  __typename?: "ExpectToRevokeDocUserRolesDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

export interface ExpectToUpdateDocUserRoleDataType {
  __typename?: "ExpectToUpdateDocUserRoleDataType";
  docId: Scalars["String"]["output"];
  spaceId: Scalars["String"]["output"];
}

export interface ExportDatabaseCsvInput {
  databaseId: Scalars["ID"]["input"];
  /**
   * All P-DB-27 export knobs. When omitted the server falls back
   * to a default export (whole database, view id from the first
   * view, header row, minimal quoting, machine-readable locale).
   */
  options?: InputMaybe<DatabaseCsvExportOptionsInput>;
}

export interface ExportDatabaseJsonInput {
  databaseId: Scalars["ID"]["input"];
}

/**
 * GraphQL enum for compatibility feature flags returned in user/workspace contexts.
 *
 * These represent plan or feature entitlements that the client uses to
 * gate UI features.  They are derived from [`crate::config::CompatibilityFeature`].
 */
export enum FeatureType {
  AIEarlyAccess = "AIEarlyAccess",
  Admin = "Admin",
  EarlyAccess = "EarlyAccess",
  FreePlan = "FreePlan",
  LifetimeProPlan = "LifetimeProPlan",
  /**
   * Globale Manager-Capability: schaltet einen User als _potenziellen_
   * Manager frei. Wirksam erst in Kombination mit einer
   * `organization_unit_member.role='manager'`-Mitgliedschaft (Learning
   * LRN-20260502-ORG-A-01).
   */
  Manager = "Manager",
  ProPlan = "ProPlan",
  TeamPlan = "TeamPlan",
  UnlimitedCopilot = "UnlimitedCopilot",
  UnlimitedWorkspace = "UnlimitedWorkspace",
}

export interface FixedRecurrenceInput {
  day?: InputMaybe<Scalars["Int"]["input"]>;
  end?: InputMaybe<RecurrenceValueInput>;
  frequency: RecurrenceFrequency;
  interval: Scalars["Int"]["input"];
  lastDay?: InputMaybe<Scalars["Boolean"]["input"]>;
  month?: InputMaybe<Scalars["Int"]["input"]>;
  start: RecurrenceValueInput;
  weekdays?: InputMaybe<Array<RecurrenceWeekday>>;
  zone: Scalars["String"]["input"];
}

export interface ForkChatSessionInput {
  docId: Scalars["String"]["input"];
  latestMessageId?: InputMaybe<Scalars["String"]["input"]>;
  sessionId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

/** Input for creating a new personal access token. */
export interface GenerateAccessTokenInput {
  /** Optional absolute expiry timestamp. */
  expiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  /** Descriptive name for the token. */
  name: Scalars["String"]["input"];
}

/**
 * Authentication method for the remote Git repository.
 *
 * Maps to [`myoxus_domain::git_sync::AuthMethod`].
 */
export enum GitSyncAuthMethod {
  /** Username + password over HTTPS. */
  HttpsPassword = "HttpsPassword",
  /** Personal access token over HTTPS. */
  HttpsToken = "HttpsToken",
  /** PEM-encoded SSH private key. */
  SshKey = "SshKey",
}

/**
 * Stable mapping between a Myoxus document and a Git file.
 *
 * Identity is maintained via `syncId` (persisted in YAML frontmatter).
 * Path changes do not alter the binding — only the `repoPath` field
 * is updated.
 */
export interface GitSyncBindingType {
  __typename?: "GitSyncBindingType";
  docId: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  repoPath: Scalars["String"]["output"];
  syncId: Scalars["String"]["output"];
  tombstone: Scalars["Boolean"]["output"];
}

/**
 * Kind of conflict detected during reconciliation.
 *
 * Maps to [`myoxus_domain::git_sync::ConflictType`].
 */
export enum GitSyncConflictKind {
  /** Both Myoxus and Git modified the same document since last sync. */
  BothModified = "BothModified",
  /** Deleted in Git, modified in Myoxus. */
  DeleteVsModify = "DeleteVsModify",
  /** Modified in Git, deleted in Myoxus. */
  ModifyVsDelete = "ModifyVsDelete",
  /** One side renamed, the other modified. */
  RenameVsModify = "RenameVsModify",
  /** Both sides renamed the document to different targets. */
  RenameVsRename = "RenameVsRename",
}

/**
 * Resolution strategy for a Git Sync conflict.
 *
 * Maps to [`myoxus_domain::git_sync::ConflictResolution`] (without `Open`).
 */
export enum GitSyncConflictResolution {
  /** Conflict acknowledged but no action taken. */
  Dismissed = "Dismissed",
  /** Git version wins; Myoxus document overwritten. */
  GitWins = "GitWins",
  /** User provides manually merged content. */
  ManualMerge = "ManualMerge",
  /** Myoxus version wins; Git file overwritten on next sync. */
  MyoxusWins = "MyoxusWins",
}

/**
 * A persisted conflict between Myoxus and Git states.
 *
 * Surfaces the conflicting content so the user can choose a resolution
 * strategy via `resolveGitSyncConflict`.
 */
export interface GitSyncConflictType {
  __typename?: "GitSyncConflictType";
  conflictType: GitSyncConflictKind;
  createdAt: Scalars["DateTime"]["output"];
  gitContent: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  myoxusContent: Maybe<Scalars["String"]["output"]>;
  repoPath: Scalars["String"]["output"];
  resolution: Scalars["String"]["output"];
}

/** Replacement credential used by partial profile updates. */
export interface GitSyncCredentialInput {
  authMethod: GitSyncAuthMethod;
  expiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  password?: InputMaybe<Scalars["String"]["input"]>;
  sshPassphrase?: InputMaybe<Scalars["String"]["input"]>;
  sshPrivateKey?: InputMaybe<Scalars["String"]["input"]>;
  token?: InputMaybe<Scalars["String"]["input"]>;
  username?: InputMaybe<Scalars["String"]["input"]>;
}

export enum GitSyncCronMisfirePolicy {
  RunOnce = "RunOnce",
  Skip = "Skip",
}

export interface GitSyncDeleteImpactType {
  __typename?: "GitSyncDeleteImpactType";
  credentials: Scalars["Int"]["output"];
  documentBindings: Scalars["Int"]["output"];
  fileBindings: Scalars["Int"]["output"];
  openConflicts: Scalars["Int"]["output"];
  profileId: Scalars["ID"]["output"];
  runs: Scalars["Int"]["output"];
}

/**
 * Direction of synchronisation for a profile or a single run.
 *
 * Maps to [`myoxus_domain::git_sync::SyncDirection`].
 */
export enum GitSyncDirection {
  /** Both Myoxus-to-Git and Git-to-Myoxus. */
  Bidirectional = "Bidirectional",
  /** Import only: Git changes pulled into Myoxus. */
  GitToMyoxus = "GitToMyoxus",
  /** Export only: Myoxus changes pushed to Git. */
  MyoxusToGit = "MyoxusToGit",
}

/** Stable mapping between a Myoxus blob and a Git file. */
export interface GitSyncFileBindingType {
  __typename?: "GitSyncFileBindingType";
  blobKey: Scalars["String"]["output"];
  contentHash: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  fileSize: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  mimeType: Scalars["String"]["output"];
  repoPath: Scalars["String"]["output"];
  tombstoned: Scalars["Boolean"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

/**
 * Persisted conflict for a non-Markdown file.
 *
 * File conflicts are separate from document conflicts because they identify
 * blob/binding state and do not carry mergeable text bodies.
 */
export interface GitSyncFileConflictType {
  __typename?: "GitSyncFileConflictType";
  baselineHash: Maybe<Scalars["String"]["output"]>;
  bindingId: Maybe<Scalars["ID"]["output"]>;
  blobKey: Maybe<Scalars["String"]["output"]>;
  conflictType: GitSyncConflictKind;
  createdAt: Scalars["DateTime"]["output"];
  gitHash: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  myoxusHash: Maybe<Scalars["String"]["output"]>;
  repoPath: Scalars["String"]["output"];
  resolution: Scalars["String"]["output"];
  resolvedAt: Maybe<Scalars["DateTime"]["output"]>;
  resolvedBy: Maybe<Scalars["String"]["output"]>;
  runId: Scalars["ID"]["output"];
}

/**
 * Input for creating or updating a Git Sync profile.
 *
 * Contains the repository URL, branch, authentication credentials, and
 * synchronisation configuration.  The `token`, `username`, `sshPrivateKey`,
 * and `sshPassphrase` fields carry secrets and are never persisted in
 * plaintext — they are encrypted before storage.
 */
export interface GitSyncProfileInput {
  /** Authentication method for the remote. */
  authMethod: GitSyncAuthMethod;
  /** Branch to synchronise with (default: `main`). */
  branch?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Optional expiry timestamp for the credential (ISO 8601).
   * If set, the sync engine will refuse to use expired credentials.
   */
  credentialExpiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  cronExpression?: InputMaybe<Scalars["String"]["input"]>;
  cronMisfirePolicy?: InputMaybe<GitSyncCronMisfirePolicy>;
  cronTimezone?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Per-workspace mirror storage limit in MB.
   * If null, the global `max_mirror_storage_mb` from server config is used.
   */
  maxMirrorStorageMb?: InputMaybe<Scalars["Int"]["input"]>;
  /** Password (for `HttpsPassword` auth). */
  password?: InputMaybe<Scalars["String"]["input"]>;
  /** Seconds between automatic sync runs (only used with `Polling` trigger mode). */
  pollingIntervalSecs?: InputMaybe<Scalars["Int"]["input"]>;
  /** HTTPS or SSH URL of the remote Git repository. */
  repoUrl: Scalars["String"]["input"];
  /** Subdirectory inside the repo for managed content (default: `content/`). */
  rootPath?: InputMaybe<Scalars["String"]["input"]>;
  /** Passphrase for the SSH private key (optional). */
  sshPassphrase?: InputMaybe<Scalars["String"]["input"]>;
  /** PEM-encoded SSH private key (for `SshKey` auth). */
  sshPrivateKey?: InputMaybe<Scalars["String"]["input"]>;
  /** Synchronisation direction (default: `Bidirectional`). */
  syncDirection?: InputMaybe<GitSyncDirection>;
  /** Personal access token (for `HttpsToken` auth). */
  token?: InputMaybe<Scalars["String"]["input"]>;
  /** How sync runs are triggered (default: `Manual`). */
  triggerMode?: InputMaybe<GitSyncTriggerMode>;
  /** Username (for `HttpsPassword` or `HttpsToken` auth). */
  username?: InputMaybe<Scalars["String"]["input"]>;
}

/**
 * Git Sync profile configuration for a workspace.
 *
 * Represents the persistent configuration that binds a workspace to a
 * remote Git repository.  Secrets (tokens, keys) are never exposed here.
 */
export interface GitSyncProfileType {
  __typename?: "GitSyncProfileType";
  authMethod: GitSyncAuthMethod;
  branch: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  /** When the credential expires (null = never expires). */
  credentialExpiresAt: Maybe<Scalars["DateTime"]["output"]>;
  /**
   * Ownership metadata only; neither the active pointer nor secret bytes are
   * exposed to the client. Profile parents already enforce workspace access.
   */
  credentialInherited: Scalars["Boolean"]["output"];
  cronExpression: Maybe<Scalars["String"]["output"]>;
  cronMisfirePolicy: Maybe<GitSyncCronMisfirePolicy>;
  cronNextScheduledAt: Maybe<Scalars["DateTime"]["output"]>;
  cronPendingMisfireScheduledFor: Maybe<Scalars["DateTime"]["output"]>;
  cronTimezone: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  id: Scalars["ID"]["output"];
  manifestPath: Scalars["String"]["output"];
  /** Per-workspace mirror storage limit in MB (null = use global limit). */
  maxMirrorStorageMb: Maybe<Scalars["Int"]["output"]>;
  pollingIntervalSecs: Maybe<Scalars["Int"]["output"]>;
  repoUrl: Scalars["String"]["output"];
  rootPath: Scalars["String"]["output"];
  syncDirection: GitSyncDirection;
  triggerMode: GitSyncTriggerMode;
  updatedAt: Scalars["DateTime"]["output"];
}

export enum GitSyncRunSource {
  Cron = "Cron",
  HistoryCapture = "HistoryCapture",
  Manual = "Manual",
  Polling = "Polling",
  Webhook = "Webhook",
}

/**
 * Lifecycle status of a sync run.
 *
 * Maps to [`myoxus_domain::git_sync::RunStatus`].
 */
export enum GitSyncRunStatus {
  /** Run was cancelled before completion. */
  Cancelled = "Cancelled",
  /** Run finished successfully. */
  Completed = "Completed",
  /** Run terminated with an error. */
  Failed = "Failed",
  /** Run is queued but not yet started. */
  Pending = "Pending",
  /** Run is currently executing. */
  Running = "Running",
}

/**
 * A concrete synchronisation execution record.
 *
 * Contains direction, lifecycle status, timing, counters for docs
 * created/updated/deleted, and optional error information.
 */
export interface GitSyncRunType {
  __typename?: "GitSyncRunType";
  commitAfter: Maybe<Scalars["String"]["output"]>;
  commitBefore: Maybe<Scalars["String"]["output"]>;
  conflictsFound: Scalars["Int"]["output"];
  direction: GitSyncDirection;
  docsCreated: Scalars["Int"]["output"];
  docsDeleted: Scalars["Int"]["output"];
  docsUpdated: Scalars["Int"]["output"];
  errorClass: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  finishedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  jobId: Maybe<Scalars["String"]["output"]>;
  observedRemoteOid: Maybe<Scalars["String"]["output"]>;
  reconciliationReason: Maybe<Scalars["String"]["output"]>;
  reconciliationRequired: Scalars["Boolean"]["output"];
  scheduledFor: Maybe<Scalars["DateTime"]["output"]>;
  startedAt: Scalars["DateTime"]["output"];
  status: GitSyncRunStatus;
  triggerSource: GitSyncRunSource;
}

export interface GitSyncScheduleOccurrence {
  __typename?: "GitSyncScheduleOccurrence";
  localDateTime: Scalars["String"]["output"];
  scheduledAtUtc: Scalars["DateTime"]["output"];
  utcOffsetSeconds: Scalars["Int"]["output"];
}

/** Persisted SSH known-host pin used by Git-Sync SSH transports. */
export interface GitSyncSshHostKeyType {
  __typename?: "GitSyncSshHostKeyType";
  createdBy: Maybe<Scalars["ID"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  fingerprintSha256: Scalars["String"]["output"];
  firstSeenAt: Scalars["DateTime"]["output"];
  host: Scalars["String"]["output"];
  keyType: Scalars["String"]["output"];
  lastSeenAt: Scalars["DateTime"]["output"];
  port: Scalars["Int"]["output"];
  source: Scalars["String"]["output"];
}

/**
 * Aggregated Git Sync status for a workspace.
 *
 * `openConflicts` and `totalBindings` are aggregate compatibility fields:
 * `doc + file`. New consumers should prefer the explicit doc/file counters.
 */
export interface GitSyncStatusType {
  __typename?: "GitSyncStatusType";
  lastRun: Maybe<GitSyncRunType>;
  openConflicts: Scalars["Int"]["output"];
  openDocConflicts: Scalars["Int"]["output"];
  openFileConflicts: Scalars["Int"]["output"];
  partialFailedItems: Scalars["Int"]["output"];
  partialHasMore: Scalars["Boolean"]["output"];
  partialProcessedItems: Scalars["Int"]["output"];
  partialSessionId: Maybe<Scalars["ID"]["output"]>;
  partialStatus: Maybe<Scalars["String"]["output"]>;
  partialTotalItems: Scalars["Int"]["output"];
  profile: Maybe<GitSyncProfileType>;
  totalBindings: Scalars["Int"]["output"];
  totalDocBindings: Scalars["Int"]["output"];
  totalFileBindings: Scalars["Int"]["output"];
}

export interface GitSyncStorageUsageType {
  __typename?: "GitSyncStorageUsageType";
  capacityBytes: Scalars["Int"]["output"];
  freeBytes: Scalars["Int"]["output"];
  limitBytes: Scalars["Int"]["output"];
  repoCount: Scalars["Int"]["output"];
  totalBytes: Scalars["Int"]["output"];
  usagePercent: Scalars["Float"]["output"];
}

/**
 * How sync runs are triggered.
 *
 * Maps to [`myoxus_domain::git_sync::TriggerMode`].
 */
export enum GitSyncTriggerMode {
  /** Sync runs are admitted from server-calculated durable schedule slots. */
  Cron = "Cron",
  /** Sync runs follow committed document-history captures. */
  HistoryCapture = "HistoryCapture",
  /** Sync runs must be triggered explicitly via `triggerGitSync`. */
  Manual = "Manual",
  /** Sync runs are triggered automatically at a configurable interval. */
  Polling = "Polling",
  /** Sync runs are triggered by a webhook from the Git provider (V2). */
  Webhook = "Webhook",
}

export enum GitTokenRotationProvider {
  GitLab = "GitLab",
}

export enum GitTokenRotationState {
  Completed = "Completed",
  Configured = "Configured",
  Failed = "Failed",
  ManualIntervention = "ManualIntervention",
  Rotating = "Rotating",
}

export interface GitTokenRotationStatus {
  __typename?: "GitTokenRotationStatus";
  currentCredentialExpiresAt: Maybe<Scalars["DateTime"]["output"]>;
  diagnosis: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  lastAttemptAt: Maybe<Scalars["DateTime"]["output"]>;
  lastSuccessAt: Maybe<Scalars["DateTime"]["output"]>;
  nextAttemptAt: Maybe<Scalars["DateTime"]["output"]>;
  profileId: Scalars["ID"]["output"];
  provider: GitTokenRotationProvider;
  renewBeforeDays: Scalars["Int"]["output"];
  requestedLifetimeDays: Scalars["Int"]["output"];
  state: GitTokenRotationState;
}

export interface GqlLogChangeEntry {
  __typename?: "GqlLogChangeEntry";
  autoRevertAt: Maybe<Scalars["DateTime"]["output"]>;
  changedBy: Scalars["String"]["output"];
  group: Scalars["String"]["output"];
  newLevel: Scalars["String"]["output"];
  previousLevel: Scalars["String"]["output"];
  timestamp: Scalars["DateTime"]["output"];
}

export interface GqlLogDiskUsage {
  __typename?: "GqlLogDiskUsage";
  fileCount: Scalars["Int"]["output"];
  freeBytes: Scalars["Int"]["output"];
  totalBytes: Scalars["Int"]["output"];
}

export interface GqlLogModuleLevel {
  __typename?: "GqlLogModuleLevel";
  description: Scalars["String"]["output"];
  displayName: Scalars["String"]["output"];
  group: Scalars["String"]["output"];
  highVolumeWarning: Scalars["Boolean"]["output"];
  level: Scalars["String"]["output"];
  recommendedDefault: Scalars["String"]["output"];
}

export interface GqlLogOutputConfig {
  __typename?: "GqlLogOutputConfig";
  filePath: Maybe<Scalars["String"]["output"]>;
  maxFiles: Scalars["Int"]["output"];
  pathError: Maybe<Scalars["String"]["output"]>;
  pathValid: Scalars["Boolean"]["output"];
  /** Whether a server restart is required for the output changes to take effect. */
  requiresRestart: Scalars["Boolean"]["output"];
  rotation: LogRotation;
}

export interface GqlLoggingConfig {
  __typename?: "GqlLoggingConfig";
  /** Available log level values for frontend dropdowns. Registers LogLevel enum in schema. */
  availableLevels: Array<LogLevel>;
  diskUsage: GqlLogDiskUsage;
  modules: Array<GqlLogModuleLevel>;
  output: GqlLogOutputConfig;
  recentChanges: Array<GqlLogChangeEntry>;
}

export interface GrantDocUserRolesInput {
  /** Deprecated: use `externalDocId`. This alias carries the same workspace-local external key. */
  docId?: InputMaybe<Scalars["String"]["input"]>;
  externalDocId?: InputMaybe<Scalars["String"]["input"]>;
  role: DocRole;
  userIds: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface GraphqlBadRequestDataType {
  __typename?: "GraphqlBadRequestDataType";
  code: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
}

export interface HttpRequestErrorDataType {
  __typename?: "HttpRequestErrorDataType";
  message: Scalars["String"]["output"];
}

export interface ImportDatabaseCsvInput {
  databaseTitle: Scalars["String"]["input"];
  dialect?: InputMaybe<DatabaseCsvDialectInput>;
  firstRowIsHeader?: InputMaybe<Scalars["Boolean"]["input"]>;
  mapping?: InputMaybe<Array<DatabaseCsvColumnMappingInput>>;
  workspaceId: Scalars["ID"]["input"];
}

export interface ImportDatabaseJsonInput {
  /**
   * Required for `mode=Replace`. The wizard must set this to `true`
   * to confirm the operator intentionally wants a destructive
   * import.
   */
  confirmDestructive?: InputMaybe<Scalars["Boolean"]["input"]>;
  conflictStrategy?: InputMaybe<DatabaseJsonConflictStrategyType>;
  /**
   * When `true`, no rows are persisted and the response is purely
   * informational.
   */
  dryRun?: InputMaybe<Scalars["Boolean"]["input"]>;
  /**
   * Per-snapshot-field-id mapping: either an existing target field
   * id (UUID) or `new:<field name>` to allocate a fresh field on the
   * target Database. Used for `mode=Merge`.
   */
  fieldMapping?: InputMaybe<Array<DatabaseJsonImportFieldMappingInput>>;
  mode?: InputMaybe<DatabaseJsonImportModeType>;
  /**
   * Required for `mode=Replace` or `mode=Merge`. Must live in the
   * same workspace.
   */
  targetDatabaseId?: InputMaybe<Scalars["ID"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface ImportUsersInput {
  users: Array<CreateUserInput>;
}

/**
 * Portable metadata is parsed by the same Rust transfer owner as full-workspace
 * imports. Preflight never creates catalog entries or document assignments.
 */
export interface ImportWorkspaceTagsInput {
  /** Portable catalog: id, name/value, colorRole/color, description and archival metadata. */
  catalog: Scalars["JSON"]["input"];
  documents: Scalars["JSON"]["input"];
  /** SHA-256 of the immutable source archive, scoped to the destination workspace. */
  importId: Scalars["ID"]["input"];
  /** Validate before document creation; false applies to the supplied external target keys. */
  validateOnly: Scalars["Boolean"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export enum InitialDatabaseViewKind {
  Kanban = "Kanban",
  Table = "Table",
}

/** Scope of a recurring-event edit or delete operation (P90-CAL-I-05). */
export enum InstanceEditScope {
  /** Modify all occurrences — redirect to the regular series update/delete. */
  All = "All",
  /** Modify this occurrence and all future occurrences (thisAndFuture split). */
  ThisAndFuture = "ThisAndFuture",
  /** Modify only this single occurrence (RECURRENCE-ID exception). */
  ThisOnly = "ThisOnly",
}

/** Instance state as a GraphQL enum. */
export enum InstanceStateType {
  Detached = "Detached",
  Error = "Error",
  Ok = "Ok",
  Retired = "Retired",
  UpdateAvailable = "UpdateAvailable",
}

export interface InvalidAppConfigDataType {
  __typename?: "InvalidAppConfigDataType";
  key: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
}

export interface InvalidAppConfigInputDataType {
  __typename?: "InvalidAppConfigInputDataType";
  key: Scalars["String"]["output"];
  message: Scalars["String"]["output"];
}

export interface InvalidEmailDataType {
  __typename?: "InvalidEmailDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidHistoryTimestampDataType {
  __typename?: "InvalidHistoryTimestampDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidIndexerInputDataType {
  __typename?: "InvalidIndexerInputDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidLicenseToActivateDataType {
  __typename?: "InvalidLicenseToActivateDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidLicenseUpdateParamsDataType {
  __typename?: "InvalidLicenseUpdateParamsDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidOauthCallbackCodeDataType {
  __typename?: "InvalidOauthCallbackCodeDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidOauthResponseDataType {
  __typename?: "InvalidOauthResponseDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidPasswordLengthDataType {
  __typename?: "InvalidPasswordLengthDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidRuntimeConfigTypeDataType {
  __typename?: "InvalidRuntimeConfigTypeDataType";
  message: Scalars["String"]["output"];
}

export interface InvalidSearchProviderRequestDataType {
  __typename?: "InvalidSearchProviderRequestDataType";
  message: Scalars["String"]["output"];
}

/** Full invitation record returned when a user looks up their pending invitation. */
export interface InvitationType {
  __typename?: "InvitationType";
  /** The invitee's membership record, if accepted. */
  invitee: Maybe<InviteUserType>;
  /** Current status of the invitation. */
  status: WorkspaceMemberStatus;
  /** The user who sent the invitation, if known. */
  user: Maybe<PublicUserType>;
  /** The workspace the invitation is for. */
  workspace: InvitationWorkspaceType;
}

/** Workspace summary embedded in an invitation view. */
export interface InvitationWorkspaceType {
  __typename?: "InvitationWorkspaceType";
  /** URL or storage key for the workspace avatar. */
  avatar: Scalars["String"]["output"];
  /** Workspace UUID. */
  id: Scalars["ID"]["output"];
  /** Workspace display name. */
  name: Scalars["String"]["output"];
}

/** A shareable invite link with an expiry timestamp. */
export interface InviteLink {
  __typename?: "InviteLink";
  /** UTC timestamp when the link expires. */
  expireTime: Scalars["DateTime"]["output"];
  /** Fully qualified URL that can be shared with invitees. */
  link: Scalars["String"]["output"];
}

/** Result of a single invitation attempt within a batch-invite operation. */
export interface InviteResult {
  __typename?: "InviteResult";
  email: Scalars["String"]["output"];
  error: Maybe<Scalars["String"]["output"]>;
  inviteId: Maybe<Scalars["String"]["output"]>;
  sentSuccess: Scalars["Boolean"]["output"];
}

/** GraphQL output type for a workspace member / invitee (schema name `InviteUserType`). */
export interface InviteUserType {
  __typename?: "InviteUserType";
  avatarUrl: Maybe<Scalars["String"]["output"]>;
  disabled: Maybe<Scalars["Boolean"]["output"]>;
  email: Scalars["String"]["output"];
  emailVerified: Maybe<Scalars["Boolean"]["output"]>;
  hasPassword: Maybe<Scalars["Boolean"]["output"]>;
  id: Scalars["ID"]["output"];
  inviteId: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
  permission: Permission;
  role: Permission;
  status: WorkspaceMemberStatus;
}

/** Job state as a GraphQL enum. */
export enum JobStateType {
  Cancelled = "Cancelled",
  Completed = "Completed",
  Failed = "Failed",
  Pending = "Pending",
  Running = "Running",
}

export interface LegacyDatabaseMigrationApplyObjectType {
  __typename?: "LegacyDatabaseMigrationApplyObjectType";
  createdDatabaseIds: Array<Scalars["ID"]["output"]>;
  migratedBlockCount: Scalars["Int"]["output"];
  plan: LegacyDatabaseMigrationPlanObjectType;
}

export interface LegacyDatabaseMigrationInput {
  documentIds: Array<Scalars["ID"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

/**
 * Redacted persisted-document migration plan.
 *
 * The API intentionally projects identities, aggregate counts and diagnostics
 * only. Legacy field, row, cell and Yjs payloads stay inside the server-owned
 * migration boundary.
 */
export interface LegacyDatabaseMigrationPlanObjectType {
  __typename?: "LegacyDatabaseMigrationPlanObjectType";
  applyAllowed: Scalars["Boolean"]["output"];
  blockReferences: Array<LegacyDatabaseMigrationReferenceObjectType>;
  cellCount: Scalars["Int"]["output"];
  databaseIds: Array<Scalars["ID"]["output"]>;
  diagnostics: Array<WorkspaceImportDiagnosticType>;
  fieldCount: Scalars["Int"]["output"];
  rowCount: Scalars["Int"]["output"];
  viewCount: Scalars["Int"]["output"];
}

export interface LegacyDatabaseMigrationReferenceObjectType {
  __typename?: "LegacyDatabaseMigrationReferenceObjectType";
  alreadyMigrated: Scalars["Boolean"]["output"];
  blockId: Scalars["String"]["output"];
  sourceDocumentId: Scalars["ID"]["output"];
  targetDatabaseId: Scalars["ID"]["output"];
  targetViewId: Maybe<Scalars["ID"]["output"]>;
}

export interface LegacyWorkspaceTagDocumentAssignmentInput {
  docId: Scalars["ID"]["input"];
  legacyTagIds: Array<Scalars["String"]["input"]>;
}

export interface LegacyWorkspaceTagInput {
  color: Scalars["String"]["input"];
  createdAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  legacyId: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
  updatedAt?: InputMaybe<Scalars["DateTime"]["input"]>;
}

export interface LicenseType {
  __typename?: "LicenseType";
  expiredAt: Maybe<Scalars["DateTime"]["output"]>;
  installedAt: Scalars["DateTime"]["output"];
  quantity: Scalars["Int"]["output"];
  recurring: SubscriptionRecurringType;
  validatedAt: Scalars["DateTime"]["output"];
  variant: Maybe<SubscriptionVariantType>;
}

/** Reduced user view shown to callers who are not permitted to see full profile details. */
export interface LimitedUserType {
  __typename?: "LimitedUserType";
  /** E-mail address (only field exposed to unprivileged callers). */
  email: Scalars["String"]["output"];
  /** Whether a password is set (required by the sign-in preflight). */
  hasPassword: Scalars["Boolean"]["output"];
}

export interface LinkCalDavAccountInput {
  displayName?: InputMaybe<Scalars["String"]["input"]>;
  password: Scalars["String"]["input"];
  providerPresetId: Scalars["String"]["input"];
  username: Scalars["String"]["input"];
}

export interface LinkCalendarAccountInput {
  provider: CalendarProviderType;
  redirectUri?: InputMaybe<Scalars["String"]["input"]>;
}

export interface ListUserInput {
  features?: InputMaybe<Array<FeatureType>>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  keyword?: InputMaybe<Scalars["String"]["input"]>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface ListWorkspaceInput {
  enableAi?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableDocEmbedding?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableSharing?: InputMaybe<Scalars["Boolean"]["input"]>;
  enableUrlPreview?: InputMaybe<Scalars["Boolean"]["input"]>;
  features?: InputMaybe<Array<FeatureType>>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  gitSyncEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  gitSyncLastStatus?: InputMaybe<GitSyncRunStatus>;
  isPersonal?: InputMaybe<Scalars["Boolean"]["input"]>;
  keyword?: InputMaybe<Scalars["String"]["input"]>;
  memberCountMax?: InputMaybe<Scalars["Int"]["input"]>;
  memberCountMin?: InputMaybe<Scalars["Int"]["input"]>;
  orderBy?: InputMaybe<AdminWorkspaceSort>;
  public?: InputMaybe<Scalars["Boolean"]["input"]>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceType?: InputMaybe<WorkspaceTypeFilter>;
}

export interface ListedBlobType {
  __typename?: "ListedBlobType";
  createdAt: Scalars["DateTime"]["output"];
  key: Scalars["String"]["output"];
  mime: Scalars["String"]["output"];
  size: Scalars["Int"]["output"];
}

export interface LoadDatabaseCsvMappingTemplateInput {
  name: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

/**
 * GraphQL enum for log levels — exposed so the frontend can enumerate valid values.
 * The level field in GqlLogModuleLevel uses String for backward compatibility,
 * but this enum is registered in the schema for introspection (P33-F-03).
 */
export enum LogLevel {
  Debug = "Debug",
  Error = "Error",
  Info = "Info",
  Trace = "Trace",
  Warn = "Warn",
}

/** GraphQL enum for log output rotation policy. */
export enum LogRotation {
  Daily = "Daily",
  Hourly = "Hourly",
  Never = "Never",
  Weekly = "Weekly",
}

export interface ManageUserInput {
  email?: InputMaybe<Scalars["String"]["input"]>;
  name?: InputMaybe<Scalars["String"]["input"]>;
}

/**
 * Search-result row for `managerSearchUsers` (P-AR-0-S02). Manager-mode
 * deliberately does NOT expose `is_admin` / `disabled` — managers must
 * not learn the admin-status or the account-status of other users.
 */
export interface ManagerUserSearchResult {
  __typename?: "ManagerUserSearchResult";
  email: Scalars["String"]["output"];
  /**
   * Activated user features (e.g. `manager`). Surfaced so the picker can
   * show role-badges in the dropdown.
   */
  features: Array<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
}

export interface MemberNotFoundInSpaceDataType {
  __typename?: "MemberNotFoundInSpaceDataType";
  spaceId: Scalars["String"]["output"];
}

/** Document context embedded in a mention notification. */
export interface MentionDocInput {
  /** Block ID containing the mention anchor. */
  blockId?: InputMaybe<Scalars["String"]["input"]>;
  /** Inline element ID of the mention. */
  elementId?: InputMaybe<Scalars["String"]["input"]>;
  /** Document UUID. */
  id: Scalars["String"]["input"];
  /** Display mode the link should open in. */
  mode?: InputMaybe<Scalars["String"]["input"]>;
  /** Document title at the time of the mention. */
  title?: InputMaybe<Scalars["String"]["input"]>;
}

/** Input for dispatching an @-mention notification. */
export interface MentionInput {
  /** Document context for the mention link. */
  doc: MentionDocInput;
  /** UUID of the user who was mentioned. */
  userId: Scalars["String"]["input"];
  /** UUID of the workspace where the mention occurred. */
  workspaceId: Scalars["String"]["input"];
}

export interface MentionUserDocAccessDeniedDataType {
  __typename?: "MentionUserDocAccessDeniedDataType";
  message: Scalars["String"]["output"];
}

export interface MissingOauthQueryParameterDataType {
  __typename?: "MissingOauthQueryParameterDataType";
  message: Scalars["String"]["output"];
}

export interface MutationRoot {
  __typename?: "MutationRoot";
  abortBlobUpload: Scalars["Boolean"]["output"];
  acceptInviteById: Scalars["Boolean"]["output"];
  acceptWorkspaceInvite: Scalars["Boolean"]["output"];
  /**
   * Adopt a copilot-generated blob into the workspace blob store.
   *
   * Copilot blobs are stored ephemerally under a `{user_id}/{workspace_id}/{filename}`
   * key and are not tracked in the `blobs` DB table — they are subject to nightly
   * cleanup once the session that produced them is deleted.  This mutation copies the
   * bytes into the workspace blob store (under `{workspace_id}/{new_key}`) and creates
   * a `blobs` DB record so the blob is permanent and accessible via the regular blob API.
   *
   * `copilot_blob_key` must be a path of the form `{user_id}/{workspace_id}/{filename}`
   * where `user_id` matches the authenticated caller.
   *
   * Returns the new workspace-scoped blob key on success.
   */
  adoptCopilotBlob: Scalars["String"]["output"];
  applyContextDocuments: ContextDocuments;
  /** Migrate persisted editor-local Databases through the canonical service. */
  applyLegacyDatabaseMigration: LegacyDatabaseMigrationApplyObjectType;
  applyWorkspaceImport: WorkspaceImportType;
  approveMember: Scalars["Boolean"]["output"];
  archiveWorkspaceTag: WorkspaceTag;
  /** Attach an existing readable document as optional Row content. */
  attachDatabaseRowContentDocument: DatabaseRowRecord;
  bootstrapWorkspaceTags: WorkspaceTagBootstrapResultObjectType;
  bulkApplyDatabaseCellPatches: DatabaseBulkOperationResult;
  bulkClearDatabaseCellValue: DatabaseBulkOperationResult;
  bulkDeleteDatabaseRows: DatabaseBulkOperationResult;
  bulkRestoreDatabaseRows: DatabaseBulkOperationResult;
  bulkSetDatabaseCellValue: DatabaseBulkOperationResult;
  bulkUpdateDatabaseRowPositions: DatabaseBulkOperationResult;
  /** Cancel an actor-owned operation before canonical publication. */
  cancelWorkspaceContentOperation: WorkspaceContentOperationType;
  cancelWorkspaceImport: WorkspaceImportType;
  changeEmail: UserType;
  changePassword: Scalars["Boolean"]["output"];
  cleanupCopilotSession: Array<Scalars["String"]["output"]>;
  clearDatabaseCellValue: DatabaseCellRevisionType;
  completeBlobUpload: Scalars["String"]["output"];
  completeWorkspaceImportUpload: WorkspaceImportType;
  configureTaskMaintenance: TaskPreparationConfiguration;
  configureTaskPreparation: TaskPreparationConfiguration;
  configureTaskRecurrence: TaskRecurrence;
  confirmTaskCorrections: TaskMaintenance;
  controlWorkspaceEventRecurrence: CalendarEventType;
  createBlobUpload: BlobUploadInitType;
  createComment: CommentObjectType;
  createCopilotMessage: Scalars["String"]["output"];
  createCopilotSession: Scalars["String"]["output"];
  createCopilotSessionWithHistory: CopilotHistories;
  createDatabase: DatabaseRecord;
  createDatabaseField: DatabaseFieldType;
  createDatabaseFromTemplate: DatabaseRecord;
  createDatabaseRow: DatabaseRowRecord;
  /** Create and attach a normal workspace document as optional Row content. */
  createDatabaseRowContentDocument: DatabaseRowRecord;
  createDatabaseRowFromTemplate: DatabaseRowRecord;
  createDatabaseRowTemplate: DatabaseRowTemplateBinding;
  createDatabaseTaskFromSource: DatabaseTaskCaptureResult;
  createDatabaseView: DatabaseViewType;
  /**
   * Create a workspace event tag.
   *
   * Enforces workspace write permission (INV-CAL-TAG-01).
   */
  createEventTag: CalendarEventTagType;
  createInviteLink: InviteLink;
  createProject: DatabaseRecord;
  createReply: ReplyObjectType;
  createWorkspace: WorkspaceType;
  createWorkspaceAutomation: WorkspaceAutomationType;
  /**
   * Create a workspace-native calendar event.
   *
   * Enforces INV-CAL-NATIVE-03 (workspace write permission).
   */
  createWorkspaceEvent: CalendarEventType;
  createWorkspaceImportUpload: WorkspaceImportUploadType;
  createWorkspaceInviteLink: WorkspaceInviteLinkType;
  createWorkspaceTag: WorkspaceTag;
  decideDocumentReview: DocumentReview;
  deleteAccount: DeleteAccount;
  deleteAssistantSetup: UserPreferencesType;
  deleteBlob: Scalars["Boolean"]["output"];
  /**
   * Delete a calendar event by ID (P90-CAL-E-08).
   *
   * If the event has a `remote_href` and `etag`, the write-through layer
   * propagates the deletion to the remote provider.  Otherwise the event is
   * deleted locally only.
   *
   * Returns `true` on success, `false` if the event was not found.
   */
  deleteCalendarEvent: Scalars["Boolean"]["output"];
  /** Delete a single recurrence instance or the entire series (P90-CAL-I-03..I-05). */
  deleteCalendarEventInstance: Scalars["Boolean"]["output"];
  deleteComment: Scalars["Boolean"]["output"];
  /**
   * P-DB-27: delete every revision of a saved CSV mapping
   * template by name. Returns whether at least one revision was
   * removed.
   */
  deleteDatabaseCsvMappingTemplate: Scalars["Boolean"]["output"];
  deleteDatabaseField: Scalars["Boolean"]["output"];
  deleteDatabasePermanently: Scalars["Boolean"]["output"];
  deleteDatabaseRow: Scalars["Boolean"]["output"];
  deleteDatabaseRowReminder: Scalars["Boolean"]["output"];
  deleteDatabaseRowTemplate: Scalars["Boolean"]["output"];
  deleteDatabaseView: Scalars["Boolean"]["output"];
  deleteDocumentPermanently: DeleteDocumentsPermanentlyPayload;
  deleteDocumentsPermanently: DeleteDocumentsPermanentlyPayload;
  /**
   * Delete a workspace event tag.
   *
   * Events referencing the tag will have their `tag_id` set to NULL (FK SET NULL).
   */
  deleteEventTag: Scalars["Boolean"]["output"];
  deleteReply: Scalars["Boolean"]["output"];
  deleteWorkspace: Scalars["Boolean"]["output"];
  /**
   * Delete a workspace-native calendar event.
   *
   * scope=All removes the master (FK cascade removes overrides).
   * scope=This adds an EXDATE, hiding the single occurrence.
   * Returns `FORBIDDEN` for external events (INV-CAL-NATIVE-02).
   */
  deleteWorkspaceEvent: Scalars["Boolean"]["output"];
  deleteWorkspaceTagPermanently: Scalars["Boolean"]["output"];
  /** Detach optional Row content without deleting the document. */
  detachDatabaseRowContentDocument: DatabaseRowRecord;
  disableWorkspaceAutomation: WorkspaceAutomationType;
  emptyWorkspaceTrash: DeleteDocumentsPermanentlyPayload;
  endTaskRecurrence: TaskRecurrence;
  /** Execute exactly the current preflight revision and confirmation set. */
  executeWorkspaceContentOperation: WorkspaceContentOperationType;
  exportCopilotMessage: CopilotGeneratedFileType;
  exportDatabaseCsv: DatabaseCsvExport;
  exportDatabaseJson: DatabaseJsonExport;
  generateUserAccessToken: RevealedAccessToken;
  grantMember: Scalars["Boolean"]["output"];
  importDatabaseCsv: DatabaseCsvImportResult;
  importDatabaseJson: DatabaseJsonImportResult;
  importDatabaseNotion: DatabaseJsonImportResult;
  /**
   * Import events from a RFC 5545 VCALENDAR blob into a workspace
   * (P-JCAL-SERVER-07-B).
   *
   * Each VEVENT is created as a workspace-native event. VEVENTs that cannot
   * be mapped (e.g. zero-duration or malformed dates) are counted in
   * `skipped_count`. A 5 MiB hard limit is enforced on `ics_body`.
   */
  importWorkspaceCalendarIcs: CalendarIcsImportResult;
  importWorkspaceTags: WorkspaceTagTransfer;
  inviteMembers: Array<InviteResult>;
  /**
   * P100-SRV-F-02: Invite an existing user by their user ID.
   *
   * Creates a Pending membership and emits an Invite outbox event.
   * Returns the membership's invite_id (UUID string) on success.
   */
  inviteServerUserById: Scalars["String"]["output"];
  leaveWorkspace: Scalars["Boolean"]["output"];
  linkCaldavAccount: CalendarAccountObjectType;
  linkCalendarAccount: Scalars["String"]["output"];
  /**
   * P-DB-27: load the current revision of a saved CSV mapping
   * template by name. Returns `null` if no template exists under
   * that name.
   */
  loadDatabaseCsvMappingTemplate: Maybe<DatabaseCsvMappingTemplate>;
  markAllCommentThreadsRead: Scalars["Int"]["output"];
  markCommentThreadRead: Scalars["Boolean"]["output"];
  mentionUser: Scalars["ID"]["output"];
  moveDatabaseTasks: DatabaseTaskMoveResult;
  pauseTaskRecurrence: TaskRecurrence;
  previewDatabaseCsvImport: DatabaseCsvPreview;
  previewDatabaseJsonImport: DatabaseJsonPreview;
  previewDatabaseNotionImport: DatabaseJsonPreview;
  previewWorkspaceImport: WorkspaceImportType;
  readAllNotifications: Scalars["Boolean"]["output"];
  readNotification: Scalars["Boolean"]["output"];
  recolorWorkspaceTag: WorkspaceTag;
  releaseDeletedBlobs: Scalars["Boolean"]["output"];
  removeAvatar: RemoveAvatar;
  renameWorkspaceTag: WorkspaceTag;
  reopenComment: CommentType;
  reorderDatabaseFields: Array<DatabaseFieldType>;
  reorderDatabaseViews: Array<DatabaseViewType>;
  /** Report that the client builder has successfully applied a builtin template. */
  reportTemplateBuilderApplied: Scalars["Boolean"]["output"];
  /** Report that the client has trashed a builtin template document. */
  reportTemplateBuilderTrashed: Scalars["Boolean"]["output"];
  resetDatabaseViewUserState: Scalars["Boolean"]["output"];
  /**
   * Resolve a detected calendar conflict (P90-CAL-F-04).
   *
   * - `KEEP_LOCAL`   — the local version is authoritative; update the DB to
   * clear the pending-conflict flag (Force-PUT would be done
   * by the write-through layer in a future step).
   * - `KEEP_REMOTE`  — overwrite the local DB event with the remote version.
   * - `MERGE_AUTO`   — attempt a three-way auto-merge and apply the result.
   */
  resolveCalendarConflict: CalendarEventType;
  resolveComment: Scalars["Boolean"]["output"];
  restoreDatabase: DatabaseRecord;
  restoreWorkspaceTag: WorkspaceTag;
  resumeTaskRecurrence: TaskRecurrence;
  retryContextDocuments: ContextDocuments;
  retryDocumentReview: DocumentReview;
  retryTaskHandover: TaskHandover;
  retryTaskMaintenance: TaskMaintenance;
  retryTaskPreparationRun: TaskPreparationRun;
  /** Re-authorize failed content work or a successful Extract's pending Git work. */
  retryWorkspaceContentOperation: WorkspaceContentOperationType;
  /**
   * Retry addresses the existing actor-bound receipt; no allocation input or
   * new result identity is accepted through this recovery command.
   */
  retryWorkspaceCreation: Maybe<WorkspaceCreationResultType>;
  retryWorkspaceImportCleanup: WorkspaceImportType;
  revokeMember: Scalars["Boolean"]["output"];
  revokeUserAccessToken: Scalars["Boolean"]["output"];
  revokeWorkspaceInviteLink: Scalars["Boolean"]["output"];
  saveAssistantSetup: UserPreferencesType;
  /**
   * P-DB-27: save (or update) a CSV mapping template. Saving under
   * an existing name creates a new revision.
   */
  saveDatabaseCsvMappingTemplate: DatabaseCsvMappingTemplate;
  saveDatabaseViewUserState: DatabaseViewType;
  sendChangeEmail: Scalars["Boolean"]["output"];
  sendChangePasswordEmail: Scalars["Boolean"]["output"];
  sendSetPasswordEmail: Scalars["Boolean"]["output"];
  sendVerifyChangeEmail: Scalars["Boolean"]["output"];
  sendVerifyEmail: Scalars["Boolean"]["output"];
  setBlob: Scalars["String"]["output"];
  setDatabaseRowReminder: DatabaseRowReminder;
  setDocumentWorkspaceTags: Array<Scalars["ID"]["output"]>;
  /** Set per-workspace template override (enable/disable, provisioning_mode). */
  setWorkspaceTemplateOverride: Scalars["Boolean"]["output"];
  skipTaskRecurrence: TaskRecurrence;
  startDocumentReview: DocumentReview;
  startTaskHandover: TaskHandover;
  startTaskMaintenance: TaskMaintenance;
  stopContextDocuments: ContextDocuments;
  stopDocumentReview: DocumentReview;
  stopProjectSetup: ProjectSetup;
  stopTaskHandover: TaskHandover;
  stopTaskMaintenance: TaskMaintenance;
  stopTaskPreparationRun: TaskPreparationRun;
  stopWorkspaceCreation: Maybe<WorkspaceCreationResultType>;
  trashDatabase: DatabaseRecord;
  /** Preflight an Undo as a new correlated counter-operation. */
  undoWorkspaceContentOperation: WorkspaceContentPreflightType;
  unlinkCalendarAccount: Scalars["Boolean"]["output"];
  updateCalendarAccount: Maybe<CalendarAccountObjectType>;
  /** Update or split a single recurrence instance (P90-CAL-I-01, I-02). */
  updateCalendarEventInstance: UpdateCalendarEventInstanceResult;
  /**
   * Update the RSVP status of the current user for a calendar event (P90-CAL-H-04).
   *
   * `eventId` — the local UUID of the `calendar_events` row.
   * `status`  — one of `ACCEPTED`, `DECLINED`, `TENTATIVE`, `NEEDS_ACTION`.
   *
   * Requires the caller to be a participant in the event.  Returns the updated
   * event with the refreshed participant list.
   */
  updateCalendarEventRsvp: CalendarEventType;
  updateCalendarReminderStatus: CalendarReminderStatusResult;
  updateComment: Scalars["Boolean"]["output"];
  updateCopilotSession: Scalars["String"]["output"];
  updateDatabase: DatabaseRecord;
  updateDatabaseCellValue: DatabaseCellValueType;
  updateDatabaseField: DatabaseFieldType;
  updateDatabaseRowPosition: DatabaseRowRecord;
  updateDatabaseRowTemplate: DatabaseRowTemplateBinding;
  updateDatabaseRowTitle: DatabaseCellValueType;
  updateDatabaseView: DatabaseViewType;
  /** Update an existing workspace event tag. */
  updateEventTag: CalendarEventTagType;
  updatePreferences: UserPreferencesType;
  updateProfile: UserType;
  updateReply: Scalars["Boolean"]["output"];
  updateTaskRecurrence: TaskRecurrence;
  updateWorkspace: WorkspaceType;
  /**
   * Update workspace-level calendar settings (writeback target + default reminder).
   *
   * Requires SettingsUpdate permission on the workspace.
   */
  updateWorkspaceCalendarSettings: WorkspaceCalendarSettingsType;
  updateWorkspaceCalendars: WorkspaceCalendarObjectType;
  /**
   * Update a workspace-native calendar event.
   *
   * scope=All edits the master; scope=This creates an EXDATE + override row.
   * Returns `FORBIDDEN` for external events (INV-CAL-NATIVE-02).
   */
  updateWorkspaceEvent: CalendarEventType;
  updateWorkspaceTagDescription: WorkspaceTag;
  uploadAvatar: UserType;
  uploadCommentAttachment: Scalars["String"]["output"];
  upsertCalendarEvent: CalendarEventType;
  upsertDatabaseViewUserState: DatabaseViewUserStateType;
  verifyEmail: Scalars["Boolean"]["output"];
  /** Build and persist one server-authoritative XWS preflight. */
  workspaceContentPreflight: WorkspaceContentPreflightType;
  /**
   * Read retained builtin bindings, optionally repairing assigned native sources.
   * Passive callers retain read-only behavior; explicit recovery requires document
   * creation permission and never overrides detached source ownership.
   */
  workspaceTemplateReconcileSlugs: Array<BuiltinReconcileEntryType>;
}

export interface MutationRootAbortBlobUploadArgs {
  key: Scalars["String"]["input"];
  uploadId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootAcceptInviteByIdArgs {
  inviteId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootAcceptWorkspaceInviteArgs {
  inviteId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootAdoptCopilotBlobArgs {
  copilotBlobKey: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootApplyContextDocumentsArgs {
  input: ApplyContextDocumentsInput;
}

export interface MutationRootApplyLegacyDatabaseMigrationArgs {
  input: LegacyDatabaseMigrationInput;
}

export interface MutationRootApplyWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface MutationRootApproveMemberArgs {
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootArchiveWorkspaceTagArgs {
  input: WorkspaceTagLifecycleInput;
}

export interface MutationRootAttachDatabaseRowContentDocumentArgs {
  input: AttachDatabaseRowContentDocumentInput;
}

export interface MutationRootBootstrapWorkspaceTagsArgs {
  input: BootstrapWorkspaceTagsInput;
}

export interface MutationRootBulkApplyDatabaseCellPatchesArgs {
  input: BulkApplyDatabaseCellPatchesInput;
}

export interface MutationRootBulkClearDatabaseCellValueArgs {
  input: BulkClearDatabaseCellValueInput;
}

export interface MutationRootBulkDeleteDatabaseRowsArgs {
  input: BulkDeleteDatabaseRowsInput;
}

export interface MutationRootBulkRestoreDatabaseRowsArgs {
  input: BulkRestoreDatabaseRowsInput;
}

export interface MutationRootBulkSetDatabaseCellValueArgs {
  input: BulkSetDatabaseCellValueInput;
}

export interface MutationRootBulkUpdateDatabaseRowPositionsArgs {
  input: BulkUpdateDatabaseRowPositionsInput;
}

export interface MutationRootCancelWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface MutationRootCancelWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface MutationRootChangeEmailArgs {
  email: Scalars["String"]["input"];
  token: Scalars["String"]["input"];
}

export interface MutationRootChangePasswordArgs {
  newPassword: Scalars["String"]["input"];
  token: Scalars["String"]["input"];
  userId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface MutationRootCleanupCopilotSessionArgs {
  options: DeleteSessionInput;
}

export interface MutationRootClearDatabaseCellValueArgs {
  input: ClearDatabaseCellValueInput;
}

export interface MutationRootCompleteBlobUploadArgs {
  key: Scalars["String"]["input"];
  parts?: InputMaybe<Array<BlobUploadPartInput>>;
  uploadId?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootCompleteWorkspaceImportUploadArgs {
  sourceHash: Scalars["String"]["input"];
  sourceSizeBytes: Scalars["Int"]["input"];
  workspaceImportId: Scalars["ID"]["input"];
}

export interface MutationRootConfigureTaskMaintenanceArgs {
  input: ConfigureTaskPreparationInput;
}

export interface MutationRootConfigureTaskPreparationArgs {
  input: ConfigureTaskPreparationInput;
}

export interface MutationRootConfigureTaskRecurrenceArgs {
  input: ConfigureTaskRecurrenceInput;
}

export interface MutationRootConfirmTaskCorrectionsArgs {
  input: ConfirmTaskCorrectionsInput;
}

export interface MutationRootControlWorkspaceEventRecurrenceArgs {
  action: CalendarTimingAction;
  eventId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootCreateBlobUploadArgs {
  key: Scalars["String"]["input"];
  mime: Scalars["String"]["input"];
  size: Scalars["Int"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootCreateCommentArgs {
  attachmentKeys?: InputMaybe<Array<Scalars["String"]["input"]>>;
  body?: InputMaybe<Scalars["JSON"]["input"]>;
  docId?: InputMaybe<Scalars["String"]["input"]>;
  docText?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<CommentCreateInput>;
  parentCommentId?: InputMaybe<Scalars["String"]["input"]>;
  selectionAnchor?: InputMaybe<SelectionAnchorInput>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface MutationRootCreateCopilotMessageArgs {
  options: CreateChatMessageInput;
}

export interface MutationRootCreateCopilotSessionArgs {
  options: CreateChatSessionInput;
}

export interface MutationRootCreateCopilotSessionWithHistoryArgs {
  options: CreateChatSessionInput;
}

export interface MutationRootCreateDatabaseArgs {
  input: CreateDatabaseInput;
}

export interface MutationRootCreateDatabaseFieldArgs {
  input: CreateDatabaseFieldInput;
}

export interface MutationRootCreateDatabaseFromTemplateArgs {
  input: CreateDatabaseFromTemplateInput;
}

export interface MutationRootCreateDatabaseRowArgs {
  input: CreateDatabaseRowInput;
}

export interface MutationRootCreateDatabaseRowContentDocumentArgs {
  input: CreateDatabaseRowContentDocumentInput;
}

export interface MutationRootCreateDatabaseRowFromTemplateArgs {
  input: CreateDatabaseRowFromTemplateInput;
}

export interface MutationRootCreateDatabaseRowTemplateArgs {
  input: CreateDatabaseRowTemplateInput;
}

export interface MutationRootCreateDatabaseTaskFromSourceArgs {
  input: CreateDatabaseTaskFromSourceInput;
}

export interface MutationRootCreateDatabaseViewArgs {
  input: CreateDatabaseViewInput;
}

export interface MutationRootCreateEventTagArgs {
  input: CreateEventTagInput;
}

export interface MutationRootCreateInviteLinkArgs {
  expireTime: WorkspaceInviteLinkExpireTime;
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootCreateProjectArgs {
  input: CreateProjectInput;
}

export interface MutationRootCreateReplyArgs {
  input: ReplyCreateInput;
}

export interface MutationRootCreateWorkspaceArgs {
  init?: InputMaybe<Scalars["Upload"]["input"]>;
  input?: InputMaybe<CreateWorkspaceInput>;
}

export interface MutationRootCreateWorkspaceAutomationArgs {
  input: CreateWorkspaceAutomationInput;
}

export interface MutationRootCreateWorkspaceEventArgs {
  input: CreateWorkspaceEventInput;
}

export interface MutationRootCreateWorkspaceImportUploadArgs {
  parts: Array<WorkspaceImportPartManifestInput>;
  sourceFormat?: InputMaybe<WorkspaceImportSourceFormatInput>;
  sourceHash: Scalars["String"]["input"];
  sourceSizeBytes: Scalars["Int"]["input"];
}

export interface MutationRootCreateWorkspaceInviteLinkArgs {
  expireTime: Scalars["Float"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootCreateWorkspaceTagArgs {
  input: CreateWorkspaceTagInput;
}

export interface MutationRootDecideDocumentReviewArgs {
  input: DecideDocumentReviewInput;
}

export interface MutationRootDeleteAssistantSetupArgs {
  expectedUserId: Scalars["ID"]["input"];
  id: Scalars["ID"]["input"];
}

export interface MutationRootDeleteBlobArgs {
  hash?: InputMaybe<Scalars["String"]["input"]>;
  key?: InputMaybe<Scalars["String"]["input"]>;
  permanently?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootDeleteCalendarEventArgs {
  eventId: Scalars["String"]["input"];
}

export interface MutationRootDeleteCalendarEventInstanceArgs {
  eventId: Scalars["String"]["input"];
  instanceStart: Scalars["DateTime"]["input"];
  scope: InstanceEditScope;
}

export interface MutationRootDeleteCommentArgs {
  id: Scalars["String"]["input"];
}

export interface MutationRootDeleteDatabaseCsvMappingTemplateArgs {
  input: DeleteDatabaseCsvMappingTemplateInput;
}

export interface MutationRootDeleteDatabaseFieldArgs {
  input: DeleteDatabaseFieldInput;
}

export interface MutationRootDeleteDatabasePermanentlyArgs {
  input: DatabaseLifecycleInput;
}

export interface MutationRootDeleteDatabaseRowArgs {
  input: DeleteDatabaseRowInput;
}

export interface MutationRootDeleteDatabaseRowReminderArgs {
  input: DeleteDatabaseRowReminderInput;
}

export interface MutationRootDeleteDatabaseRowTemplateArgs {
  input: DeleteDatabaseRowTemplateInput;
}

export interface MutationRootDeleteDatabaseViewArgs {
  input: DeleteDatabaseViewInput;
}

export interface MutationRootDeleteDocumentPermanentlyArgs {
  input: DeleteDocumentPermanentlyInput;
}

export interface MutationRootDeleteDocumentsPermanentlyArgs {
  input: DeleteDocumentsPermanentlyInput;
}

export interface MutationRootDeleteEventTagArgs {
  tagId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootDeleteReplyArgs {
  id: Scalars["String"]["input"];
}

export interface MutationRootDeleteWorkspaceArgs {
  id: Scalars["String"]["input"];
}

export interface MutationRootDeleteWorkspaceEventArgs {
  eventId: Scalars["String"]["input"];
  instanceStart?: InputMaybe<Scalars["DateTime"]["input"]>;
  scope: NativeEventScope;
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootDeleteWorkspaceTagPermanentlyArgs {
  input: WorkspaceTagLifecycleInput;
}

export interface MutationRootDetachDatabaseRowContentDocumentArgs {
  input: DetachDatabaseRowContentDocumentInput;
}

export interface MutationRootDisableWorkspaceAutomationArgs {
  input: DisableWorkspaceAutomationInput;
}

export interface MutationRootEmptyWorkspaceTrashArgs {
  input: EmptyWorkspaceTrashInput;
}

export interface MutationRootEndTaskRecurrenceArgs {
  input: TaskRecurrenceControlInput;
}

export interface MutationRootExecuteWorkspaceContentOperationArgs {
  input: WorkspaceContentExecuteInput;
}

export interface MutationRootExportCopilotMessageArgs {
  format: CopilotExportFormat;
  messageId: Scalars["ID"]["input"];
}

export interface MutationRootExportDatabaseCsvArgs {
  input: ExportDatabaseCsvInput;
}

export interface MutationRootExportDatabaseJsonArgs {
  input: ExportDatabaseJsonInput;
}

export interface MutationRootGenerateUserAccessTokenArgs {
  input: GenerateAccessTokenInput;
}

export interface MutationRootGrantMemberArgs {
  permission: Permission;
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootImportDatabaseCsvArgs {
  file: Scalars["Upload"]["input"];
  input: ImportDatabaseCsvInput;
}

export interface MutationRootImportDatabaseJsonArgs {
  file: Scalars["Upload"]["input"];
  input: ImportDatabaseJsonInput;
}

export interface MutationRootImportDatabaseNotionArgs {
  file: Scalars["Upload"]["input"];
  input: ImportDatabaseJsonInput;
}

export interface MutationRootImportWorkspaceCalendarIcsArgs {
  icsBody: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootImportWorkspaceTagsArgs {
  input: ImportWorkspaceTagsInput;
}

export interface MutationRootInviteMembersArgs {
  emails: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootInviteServerUserByIdArgs {
  role?: InputMaybe<Scalars["String"]["input"]>;
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootLeaveWorkspaceArgs {
  sendLeaveMail?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
  workspaceName?: InputMaybe<Scalars["String"]["input"]>;
}

export interface MutationRootLinkCaldavAccountArgs {
  input: LinkCalDavAccountInput;
}

export interface MutationRootLinkCalendarAccountArgs {
  input: LinkCalendarAccountInput;
}

export interface MutationRootLoadDatabaseCsvMappingTemplateArgs {
  input: LoadDatabaseCsvMappingTemplateInput;
}

export interface MutationRootMarkAllCommentThreadsReadArgs {
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootMarkCommentThreadReadArgs {
  commentId: Scalars["String"]["input"];
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootMentionUserArgs {
  input: MentionInput;
}

export interface MutationRootMoveDatabaseTasksArgs {
  input: DatabaseTaskMoveInput;
}

export interface MutationRootPauseTaskRecurrenceArgs {
  input: TaskRecurrenceControlInput;
}

export interface MutationRootPreviewDatabaseCsvImportArgs {
  file: Scalars["Upload"]["input"];
  input: PreviewDatabaseCsvImportInput;
}

export interface MutationRootPreviewDatabaseJsonImportArgs {
  file: Scalars["Upload"]["input"];
  input: PreviewDatabaseJsonImportInput;
}

export interface MutationRootPreviewDatabaseNotionImportArgs {
  file: Scalars["Upload"]["input"];
  input: PreviewDatabaseJsonImportInput;
}

export interface MutationRootPreviewWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface MutationRootReadNotificationArgs {
  id: Scalars["String"]["input"];
}

export interface MutationRootRecolorWorkspaceTagArgs {
  input: RecolorWorkspaceTagInput;
}

export interface MutationRootReleaseDeletedBlobsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootRenameWorkspaceTagArgs {
  input: RenameWorkspaceTagInput;
}

export interface MutationRootReopenCommentArgs {
  commentId: Scalars["String"]["input"];
}

export interface MutationRootReorderDatabaseFieldsArgs {
  input: ReorderDatabaseFieldsInput;
}

export interface MutationRootReorderDatabaseViewsArgs {
  input: ReorderDatabaseViewsInput;
}

export interface MutationRootReportTemplateBuilderAppliedArgs {
  input: ReportBuilderAppliedInput;
}

export interface MutationRootReportTemplateBuilderTrashedArgs {
  slug: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootResetDatabaseViewUserStateArgs {
  input: ResetDatabaseViewUserStateInput;
}

export interface MutationRootResolveCalendarConflictArgs {
  baseVersion?: InputMaybe<Scalars["JSON"]["input"]>;
  eventId: Scalars["String"]["input"];
  resolution: ConflictResolution;
}

export interface MutationRootResolveCommentArgs {
  commentId?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<CommentResolveInput>;
}

export interface MutationRootRestoreDatabaseArgs {
  input: DatabaseLifecycleInput;
}

export interface MutationRootRestoreWorkspaceTagArgs {
  input: WorkspaceTagLifecycleInput;
}

export interface MutationRootResumeTaskRecurrenceArgs {
  input: TaskRecurrenceControlInput;
}

export interface MutationRootRetryContextDocumentsArgs {
  input: RetryContextDocumentsInput;
}

export interface MutationRootRetryDocumentReviewArgs {
  input: DocumentReviewRunInput;
}

export interface MutationRootRetryTaskHandoverArgs {
  input: TaskHandoverRunInput;
}

export interface MutationRootRetryTaskMaintenanceArgs {
  input: TaskMaintenanceRunInput;
}

export interface MutationRootRetryTaskPreparationRunArgs {
  runId: Scalars["ID"]["input"];
}

export interface MutationRootRetryWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface MutationRootRetryWorkspaceCreationArgs {
  input: RetryWorkspaceCreationInput;
}

export interface MutationRootRetryWorkspaceImportCleanupArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface MutationRootRevokeMemberArgs {
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootRevokeUserAccessTokenArgs {
  id: Scalars["String"]["input"];
}

export interface MutationRootRevokeWorkspaceInviteLinkArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootSaveAssistantSetupArgs {
  expectedUserId: Scalars["ID"]["input"];
  input: SaveAssistantSetupInput;
}

export interface MutationRootSaveDatabaseCsvMappingTemplateArgs {
  input: SaveDatabaseCsvMappingTemplateInput;
}

export interface MutationRootSaveDatabaseViewUserStateArgs {
  input: SaveDatabaseViewUserStateInput;
}

export interface MutationRootSendChangeEmailArgs {
  callbackUrl: Scalars["String"]["input"];
  email?: InputMaybe<Scalars["String"]["input"]>;
}

export interface MutationRootSendChangePasswordEmailArgs {
  callbackUrl?: InputMaybe<Scalars["String"]["input"]>;
  email?: InputMaybe<Scalars["String"]["input"]>;
}

export interface MutationRootSendSetPasswordEmailArgs {
  callbackUrl?: InputMaybe<Scalars["String"]["input"]>;
  email?: InputMaybe<Scalars["String"]["input"]>;
}

export interface MutationRootSendVerifyChangeEmailArgs {
  callbackUrl: Scalars["String"]["input"];
  email: Scalars["String"]["input"];
  token: Scalars["String"]["input"];
}

export interface MutationRootSendVerifyEmailArgs {
  callbackUrl: Scalars["String"]["input"];
}

export interface MutationRootSetBlobArgs {
  blob: Scalars["Upload"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootSetDatabaseRowReminderArgs {
  input: SetDatabaseRowReminderInput;
}

export interface MutationRootSetDocumentWorkspaceTagsArgs {
  input: SetDocumentWorkspaceTagsInput;
}

export interface MutationRootSetWorkspaceTemplateOverrideArgs {
  input: SetWorkspaceTemplateOverrideInput;
}

export interface MutationRootSkipTaskRecurrenceArgs {
  input: SkipTaskRecurrenceInput;
}

export interface MutationRootStartDocumentReviewArgs {
  input: StartDocumentReviewInput;
}

export interface MutationRootStartTaskHandoverArgs {
  input: StartTaskHandoverInput;
}

export interface MutationRootStartTaskMaintenanceArgs {
  input: StartTaskMaintenanceInput;
}

export interface MutationRootStopContextDocumentsArgs {
  input: StopContextDocumentsInput;
}

export interface MutationRootStopDocumentReviewArgs {
  input: DocumentReviewRunInput;
}

export interface MutationRootStopProjectSetupArgs {
  input: StopProjectSetupInput;
}

export interface MutationRootStopTaskHandoverArgs {
  input: TaskHandoverRunInput;
}

export interface MutationRootStopTaskMaintenanceArgs {
  input: TaskMaintenanceRunInput;
}

export interface MutationRootStopTaskPreparationRunArgs {
  runId: Scalars["ID"]["input"];
}

export interface MutationRootStopWorkspaceCreationArgs {
  input: StopWorkspaceCreationInput;
}

export interface MutationRootTrashDatabaseArgs {
  input: DatabaseLifecycleInput;
}

export interface MutationRootUndoWorkspaceContentOperationArgs {
  idempotencyId: Scalars["UUID"]["input"];
  originOperationId: Scalars["UUID"]["input"];
}

export interface MutationRootUnlinkCalendarAccountArgs {
  accountId: Scalars["String"]["input"];
}

export interface MutationRootUpdateCalendarAccountArgs {
  accountId?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<UpdateCalendarAccountInput>;
  refreshIntervalMinutes?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface MutationRootUpdateCalendarEventInstanceArgs {
  input: UpdateCalendarEventInstanceInput;
}

export interface MutationRootUpdateCalendarEventRsvpArgs {
  eventId: Scalars["String"]["input"];
  status: CalendarRsvpStatus;
}

export interface MutationRootUpdateCalendarReminderStatusArgs {
  delivered: Scalars["Boolean"]["input"];
  reminderId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootUpdateCommentArgs {
  body?: InputMaybe<Scalars["JSON"]["input"]>;
  commentId?: InputMaybe<Scalars["String"]["input"]>;
  input?: InputMaybe<CommentUpdateInput>;
}

export interface MutationRootUpdateCopilotSessionArgs {
  options: UpdateChatSessionInput;
}

export interface MutationRootUpdateDatabaseArgs {
  input: UpdateDatabaseInput;
}

export interface MutationRootUpdateDatabaseCellValueArgs {
  input: UpdateDatabaseCellValueInput;
}

export interface MutationRootUpdateDatabaseFieldArgs {
  input: UpdateDatabaseFieldInput;
}

export interface MutationRootUpdateDatabaseRowPositionArgs {
  input: UpdateDatabaseRowPositionInput;
}

export interface MutationRootUpdateDatabaseRowTemplateArgs {
  input: UpdateDatabaseRowTemplateInput;
}

export interface MutationRootUpdateDatabaseRowTitleArgs {
  input: UpdateDatabaseRowTitleInput;
}

export interface MutationRootUpdateDatabaseViewArgs {
  input: UpdateDatabaseViewInput;
}

export interface MutationRootUpdateEventTagArgs {
  input: UpdateEventTagInput;
  tagId: Scalars["String"]["input"];
}

export interface MutationRootUpdatePreferencesArgs {
  input: UpdateUserPreferencesInput;
}

export interface MutationRootUpdateProfileArgs {
  input: UpdateUserInput;
}

export interface MutationRootUpdateReplyArgs {
  input: ReplyUpdateInput;
}

export interface MutationRootUpdateTaskRecurrenceArgs {
  input: UpdateTaskRecurrenceInput;
}

export interface MutationRootUpdateWorkspaceArgs {
  input: UpdateWorkspaceInput;
}

export interface MutationRootUpdateWorkspaceCalendarSettingsArgs {
  input: UpdateWorkspaceCalendarSettingsInput;
}

export interface MutationRootUpdateWorkspaceCalendarsArgs {
  input: UpdateWorkspaceCalendarsInput;
}

export interface MutationRootUpdateWorkspaceEventArgs {
  eventId: Scalars["String"]["input"];
  input: UpdateWorkspaceEventInput;
  instanceStart?: InputMaybe<Scalars["DateTime"]["input"]>;
  scope: NativeEventScope;
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootUpdateWorkspaceTagDescriptionArgs {
  input: UpdateWorkspaceTagDescriptionInput;
}

export interface MutationRootUploadAvatarArgs {
  avatar: Scalars["Upload"]["input"];
}

export interface MutationRootUploadCommentAttachmentArgs {
  attachment: Scalars["Upload"]["input"];
  docId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface MutationRootUpsertCalendarEventArgs {
  input: CalendarEventInput;
}

export interface MutationRootUpsertDatabaseViewUserStateArgs {
  input: UpsertDatabaseViewUserStateInput;
}

export interface MutationRootVerifyEmailArgs {
  token: Scalars["String"]["input"];
}

export interface MutationRootWorkspaceContentPreflightArgs {
  input: WorkspaceContentPreflightInput;
}

export interface MutationRootWorkspaceTemplateReconcileSlugsArgs {
  locale: Scalars["String"]["input"];
  provisionSources?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

/**
 * A workspace link with the relationship label, used by
 * `myOrganizationUnitWorkspaces`.
 */
export interface MyOrganizationUnitWorkspace {
  __typename?: "MyOrganizationUnitWorkspace";
  relationship: OrganizationUnitWorkspaceRelationshipEnum;
  unitId: Scalars["ID"]["output"];
  unitName: Maybe<Scalars["String"]["output"]>;
  unitSlug: Maybe<Scalars["String"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
  workspaceName: Maybe<Scalars["String"]["output"]>;
}

/** Scope for a native recurring-event mutation. */
export enum NativeEventScope {
  /** Edit / delete the master event and all occurrences. */
  All = "All",
  /** Edit / delete only a single occurrence (creates an EXDATE + override row). */
  This = "This",
  /** Split / truncate at the addressed original occurrence key. */
  ThisAndFuture = "ThisAndFuture",
}

/** Reminder attached to a native calendar event during creation. */
export interface NativeReminderInput {
  /**
   * "in_app" (default), "email", or "push". Email reminders use the configured
   * localized mail catalog independently of optional notification emails.
   */
  channel?: InputMaybe<Scalars["String"]["input"]>;
  minutesBefore: Scalars["Int"]["input"];
}

export interface NoCopilotProviderAvailableDataType {
  __typename?: "NoCopilotProviderAvailableDataType";
  message: Scalars["String"]["output"];
}

export interface NoMoreSeatDataType {
  __typename?: "NoMoreSeatDataType";
  spaceId: Scalars["String"]["output"];
}

export interface NotInSpaceDataType {
  __typename?: "NotInSpaceDataType";
  spaceId: Scalars["String"]["output"];
}

/** Priority level of an in-app notification. */
export enum NotificationLevel {
  Default = "Default",
  High = "High",
  Low = "Low",
}

/** Optional server-side filters for the authenticated notification feed. */
export interface NotificationListFilterInput {
  /**
   * Include already-read notifications. Omitted values preserve the unread
   * default used by existing clients.
   */
  includeRead?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** Restrict the result set to these notification types. */
  types?: InputMaybe<Array<NotificationType>>;
}

/** A single in-app notification record. */
export interface NotificationObjectType {
  __typename?: "NotificationObjectType";
  body: Scalars["JSON"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  level: NotificationLevel;
  read: Scalars["Boolean"]["output"];
  /** Aliased as `type` for NestJS/Desktop client compatibility. */
  type: NotificationType;
  updatedAt: Scalars["DateTime"]["output"];
}

/** Cursor-based edge for notification pagination. */
export interface NotificationObjectTypeEdge {
  __typename?: "NotificationObjectTypeEdge";
  cursor: Scalars["String"]["output"];
  node: NotificationObjectType;
}

/** Discriminator for the kind of in-app notification. */
export enum NotificationType {
  CalendarReminder = "CalendarReminder",
  Comment = "Comment",
  CommentMention = "CommentMention",
  CommentReply = "CommentReply",
  DatabaseRowAssigned = "DatabaseRowAssigned",
  DatabaseRowReminder = "DatabaseRowReminder",
  DatabaseTaskChanged = "DatabaseTaskChanged",
  DocumentChanged = "DocumentChanged",
  DocumentShared = "DocumentShared",
  General = "General",
  Invitation = "Invitation",
  InvitationAccepted = "InvitationAccepted",
  InvitationBlocked = "InvitationBlocked",
  MemberApproval = "MemberApproval",
  MemberApprovalDeclined = "MemberApprovalDeclined",
  MemberApproved = "MemberApproved",
  MemberRemoved = "MemberRemoved",
  Mention = "Mention",
  RoleChanged = "RoleChanged",
  WorkspaceContentMoved = "WorkspaceContentMoved",
}

/** GraphQL enum of supported OAuth provider identifiers. */
export enum OAuthProviderType {
  Apple = "Apple",
  GitHub = "GitHub",
  Google = "Google",
  OIDC = "OIDC",
}

export interface OrganizationCsvFileInput {
  content: Scalars["String"]["input"];
  name: Scalars["String"]["input"];
}

/**
 * One CSV file as a tuple of name + body. Mirrors
 * `myoxus_application::organization::CsvFile`.
 */
export interface OrganizationCsvFileType {
  __typename?: "OrganizationCsvFileType";
  content: Scalars["String"]["output"];
  /** The file body as UTF-8 text. Always RFC-4180 with CRLF line endings. */
  contentType: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
}

/** Full export payload — JSON snapshot plus the five CSV files. */
export interface OrganizationExportType {
  __typename?: "OrganizationExportType";
  files: Array<OrganizationCsvFileType>;
  /**
   * JSON snapshot serialised as a string (clients usually parse it
   * client-side; the GraphQL `JSON` scalar is also acceptable but we
   * prefer a plain string for backwards-compat with stricter codegens).
   */
  json: Scalars["String"]["output"];
  schemaVersion: Scalars["Int"]["output"];
}

export interface OrganizationIdentityType {
  __typename?: "OrganizationIdentityType";
  addressLines: Scalars["JSON"]["output"];
  contactEmail: Maybe<Scalars["String"]["output"]>;
  displayName: Maybe<Scalars["String"]["output"]>;
  jurisdiction: Maybe<Scalars["String"]["output"]>;
  legalName: Maybe<Scalars["String"]["output"]>;
  registrationId: Maybe<Scalars["String"]["output"]>;
  shortName: Maybe<Scalars["String"]["output"]>;
  taxId: Maybe<Scalars["String"]["output"]>;
  websiteUrl: Maybe<Scalars["String"]["output"]>;
}

export interface OrganizationImportErrorType {
  __typename?: "OrganizationImportErrorType";
  field: Maybe<Scalars["String"]["output"]>;
  message: Scalars["String"]["output"];
  row: Maybe<Scalars["Int"]["output"]>;
  source: Scalars["String"]["output"];
}

export interface OrganizationImportInput {
  /**
   * Five CSV files (`organization.csv`, `ou_types.csv`, `ous.csv`,
   * `ou_members.csv`, `ou_workspaces.csv`). Order is irrelevant.
   */
  files?: InputMaybe<Array<OrganizationCsvFileInput>>;
  /** Full JSON snapshot. Either `json` or `files` must be provided. */
  json?: InputMaybe<Scalars["String"]["input"]>;
}

/**
 * Result of a non-applying validation pass. `errors` is empty if the
 * snapshot is consistent.
 */
export interface OrganizationImportPreviewType {
  __typename?: "OrganizationImportPreviewType";
  errors: Array<OrganizationImportErrorType>;
  /**
   * Stats that *would* be produced on apply, computed from a successful
   * dry-run. `null` when `errors` is non-empty.
   */
  summary: Maybe<OrganizationImportSummaryType>;
}

export interface OrganizationImportSummaryType {
  __typename?: "OrganizationImportSummaryType";
  membersInserted: Scalars["Int"]["output"];
  membersUpdated: Scalars["Int"]["output"];
  organizationUpdated: Scalars["Boolean"]["output"];
  policyUpdated: Scalars["Boolean"]["output"];
  unitTypesInserted: Scalars["Int"]["output"];
  unitTypesUpdated: Scalars["Int"]["output"];
  unitsInserted: Scalars["Int"]["output"];
  unitsUpdated: Scalars["Int"]["output"];
  workspaceLinksInserted: Scalars["Int"]["output"];
  workspaceLinksUpdated: Scalars["Int"]["output"];
}

export interface OrganizationPolicyType {
  __typename?: "OrganizationPolicyType";
  importExportEnabled: Scalars["Boolean"]["output"];
  managerCanCreateWorkspaces: Scalars["Boolean"]["output"];
  managerCanManageOuMembers: Scalars["Boolean"]["output"];
  managerRootProjectCreation: PolicyStateEnum;
  managerUnitProjectCreation: PolicyStateEnum;
  metadata: Scalars["JSON"]["output"];
  organizationId: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
}

/**
 * Result of `createOrganizationProject`. Either the manager may proceed
 * directly (returning the unit/request id), the request is pending
 * admin approval, or it was outright denied.
 */
export interface OrganizationProjectCreationResult {
  __typename?: "OrganizationProjectCreationResult";
  /**
   * Set on `Allowed`: id of the freshly created OU representing the
   * project. Currently `None` — direct project creation is forwarded
   * to a follow-up workspace flow that the caller drives.
   */
  createdUnitId: Maybe<Scalars["ID"]["output"]>;
  decision: ProjectCreationDecisionEnum;
  /** Set on `RequiresApproval`: id of the new pending request row. */
  requestId: Maybe<Scalars["ID"]["output"]>;
}

export interface OrganizationProjectRequestType {
  __typename?: "OrganizationProjectRequestType";
  createdAt: Scalars["DateTime"]["output"];
  decidedAt: Maybe<Scalars["DateTime"]["output"]>;
  decidedBy: Maybe<Scalars["ID"]["output"]>;
  id: Scalars["ID"]["output"];
  metadata: Scalars["JSON"]["output"];
  organizationId: Scalars["ID"]["output"];
  parentUnitId: Maybe<Scalars["ID"]["output"]>;
  proposedMembers: Array<Scalars["ID"]["output"]>;
  proposedName: Scalars["String"]["output"];
  proposedTypeId: Maybe<Scalars["ID"]["output"]>;
  proposedWorkspace: Scalars["Boolean"]["output"];
  requestedBy: Scalars["ID"]["output"];
  requestedScope: ProjectRequestScopeEnum;
  status: ProjectRequestStatusEnum;
  updatedAt: Scalars["DateTime"]["output"];
}

export interface OrganizationType {
  __typename?: "OrganizationType";
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  key: Scalars["String"]["output"];
  /** Frei-Form-Metadaten (avatar_key, etc.). */
  metadata: Scalars["JSON"]["output"];
  name: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface OrganizationUnitDeletionBlockerType {
  __typename?: "OrganizationUnitDeletionBlockerType";
  code: Scalars["String"]["output"];
  count: Scalars["Int"]["output"];
}

export interface OrganizationUnitDeletionPreviewType {
  __typename?: "OrganizationUnitDeletionPreviewType";
  blockers: Array<OrganizationUnitDeletionBlockerType>;
  deletable: Scalars["Boolean"]["output"];
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  status: OrganizationUnitStatusEnum;
  updatedAt: Scalars["DateTime"]["output"];
}

export enum OrganizationUnitMemberSourceEnum {
  Import = "Import",
  Ldap = "Ldap",
  Manual = "Manual",
  Oidc = "Oidc",
  Scim = "Scim",
}

export interface OrganizationUnitMemberType {
  __typename?: "OrganizationUnitMemberType";
  createdAt: Scalars["DateTime"]["output"];
  metadata: Scalars["JSON"]["output"];
  role: OrganizationUnitRoleEnum;
  source: OrganizationUnitMemberSourceEnum;
  unitId: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  userAvatarUrl: Maybe<Scalars["String"]["output"]>;
  userEmail: Maybe<Scalars["String"]["output"]>;
  userId: Scalars["ID"]["output"];
  userName: Maybe<Scalars["String"]["output"]>;
}

export enum OrganizationUnitRoleEnum {
  Manager = "Manager",
  Member = "Member",
  Reader = "Reader",
}

/**
 * Search-result row for `searchOrganizationUnits` (P-AR-0-S01). Returns
 * only the fields the OuPicker UI needs — full OU details remain reserved
 * for the admin/manager-scoped detail queries.
 */
export interface OrganizationUnitSearchResult {
  __typename?: "OrganizationUnitSearchResult";
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  /**
   * Ancestor names from the topmost ancestor down to (but excluding)
   * the unit itself. Empty for root-level OUs. Computed server-side via
   * a 32-hop walk over `parent_unit_id`.
   */
  parentBreadcrumb: Array<Scalars["String"]["output"]>;
  slug: Scalars["String"]["output"];
}

export enum OrganizationUnitStatusEnum {
  Active = "Active",
  Archived = "Archived",
  Disabled = "Disabled",
}

export interface OrganizationUnitTypeOutput {
  __typename?: "OrganizationUnitTypeOutput";
  /**
   * Direct child OUs. Computed in the repository list query so tree UIs do
   * not need per-node GraphQL follow-up requests.
   */
  childUnitCount: Scalars["Int"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  maxMembers: Scalars["Int"]["output"];
  /** Direct members of this OU. */
  memberCount: Scalars["Int"]["output"];
  metadata: Scalars["JSON"]["output"];
  name: Scalars["String"]["output"];
  organizationId: Scalars["ID"]["output"];
  parentUnitId: Maybe<Scalars["ID"]["output"]>;
  slug: Scalars["String"]["output"];
  status: OrganizationUnitStatusEnum;
  unitTypeId: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  /** Workspace relationships attached to this OU. */
  workspaceCount: Scalars["Int"]["output"];
}

export interface OrganizationUnitTypeType {
  __typename?: "OrganizationUnitTypeType";
  canBeManagerCreated: Scalars["Boolean"]["output"];
  canBeRootLevel: Scalars["Boolean"]["output"];
  canHaveChildren: Scalars["Boolean"]["output"];
  canHaveCrossUnitMembers: Scalars["Boolean"]["output"];
  canManageWorkspaces: Scalars["Boolean"]["output"];
  canOwnWorkspaces: Scalars["Boolean"]["output"];
  color: Maybe<Scalars["String"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  icon: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  isActive: Scalars["Boolean"]["output"];
  isPreset: Scalars["Boolean"]["output"];
  isStaffUnit: Scalars["Boolean"]["output"];
  isStructural: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  label: Scalars["String"]["output"];
  metadata: Scalars["JSON"]["output"];
  organizationId: Scalars["ID"]["output"];
  requiresAdminApproval: Scalars["Boolean"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export enum OrganizationUnitWorkspaceRelationshipEnum {
  Linked = "Linked",
  Managed = "Managed",
  Owner = "Owner",
}

export interface OrganizationUnitWorkspaceType {
  __typename?: "OrganizationUnitWorkspaceType";
  createdAt: Scalars["DateTime"]["output"];
  /** Effective workspace quota in bytes. */
  effectiveQuotaBytes: Maybe<Scalars["Int"]["output"]>;
  ownerEmail: Maybe<Scalars["String"]["output"]>;
  ownerUserId: Maybe<Scalars["ID"]["output"]>;
  relationship: OrganizationUnitWorkspaceRelationshipEnum;
  /**
   * Current workspace storage usage in bytes, if quota storage stats are
   * available on this server.
   */
  storageUsedBytes: Maybe<Scalars["Int"]["output"]>;
  unitId: Scalars["ID"]["output"];
  unitName: Maybe<Scalars["String"]["output"]>;
  unitSlug: Maybe<Scalars["String"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
  workspaceName: Maybe<Scalars["String"]["output"]>;
}

/** Standard Relay page-info object returned with paginated connection types. */
export interface PageInfoType {
  __typename?: "PageInfoType";
  /** Cursor of the last edge in this page. */
  endCursor: Maybe<Scalars["String"]["output"]>;
  hasNextPage: Scalars["Boolean"]["output"];
  hasPreviousPage: Scalars["Boolean"]["output"];
  /** Cursor of the first edge in this page. */
  startCursor: Maybe<Scalars["String"]["output"]>;
}

export interface PaginatedAdminAllSharedLinkType {
  __typename?: "PaginatedAdminAllSharedLinkType";
  analyticsWindow: TimeWindow;
  edges: Array<AdminAllSharedLinkEdgeType>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

/** Paginated list of comment change events. */
export interface PaginatedCommentChangeObjectType {
  __typename?: "PaginatedCommentChangeObjectType";
  edges: Array<CommentChangeObjectTypeEdge>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

/** Paginated list of document comments. */
export interface PaginatedCommentObjectType {
  __typename?: "PaginatedCommentObjectType";
  edges: Array<CommentObjectTypeEdge>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

/** Paginated list of Copilot session history records. */
export interface PaginatedCopilotHistoriesType {
  __typename?: "PaginatedCopilotHistoriesType";
  edges: Array<CopilotHistoriesTypeEdge>;
  pageInfo: PageInfoType;
  /** Total number of sessions matching the filter. */
  totalCount: Scalars["Int"]["output"];
}

/** Relay-style paginated ignored docs. */
export interface PaginatedCopilotIgnoredDocs {
  __typename?: "PaginatedCopilotIgnoredDocs";
  edges: Array<CopilotIgnoredDocEdge>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

/** Relay-style paginated workspace files. */
export interface PaginatedCopilotWorkspaceFiles {
  __typename?: "PaginatedCopilotWorkspaceFiles";
  edges: Array<CopilotWorkspaceFileEdge>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

/** Paginated list of users with explicit roles on a document. */
export interface PaginatedDocGrantedUserType {
  __typename?: "PaginatedDocGrantedUserType";
  edges: Array<DocGrantedUserTypeEdge>;
  pageInfo: PageInfoType;
  /** Total number of matching records (before pagination). */
  totalCount: Scalars["Int"]["output"];
}

export interface PaginatedDocMemberLastAccess {
  __typename?: "PaginatedDocMemberLastAccess";
  edges: Array<DocMemberLastAccessEdge>;
  pageInfo: PageInfoType;
  totalCount: Maybe<Scalars["Int"]["output"]>;
}

/** Paginated result for recently-updated docs. */
export interface PaginatedDocType {
  __typename?: "PaginatedDocType";
  edges: Array<RecentDocEdge>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

export interface PaginatedNotificationObjectType {
  __typename?: "PaginatedNotificationObjectType";
  edges: Array<NotificationObjectTypeEdge>;
  pageInfo: PageInfoType;
  totalCount: Scalars["Int"]["output"];
}

/** Cursor-based pagination input compatible with the Relay connection spec. */
export interface PaginationInput {
  /** Return records after this cursor. */
  after?: InputMaybe<Scalars["String"]["input"]>;
  /** Maximum number of records to return. */
  first?: InputMaybe<Scalars["Int"]["input"]>;
  /** Number of records to skip (offset pagination alternative). */
  offset?: InputMaybe<Scalars["Int"]["input"]>;
}

/** Minimum and maximum accepted password lengths. */
export interface PasswordLimitsType {
  __typename?: "PasswordLimitsType";
  maxLength: Scalars["Int"]["output"];
  minLength: Scalars["Int"]["output"];
}

/** Admin-facing job row used by the PDF Export render-jobs tab. */
export interface PdfExportAdminJobType {
  __typename?: "PdfExportAdminJobType";
  audit: Maybe<PdfExportRenderAuditType>;
  createdAt: Scalars["DateTime"]["output"];
  docId: Scalars["String"]["output"];
  /**
   * Wall-clock duration in milliseconds when enough timestamps are known.
   * Running jobs use `now - started_at`; queued jobs return `None`.
   */
  durationMs: Maybe<Scalars["Int"]["output"]>;
  errorClass: Maybe<Scalars["String"]["output"]>;
  errorDetail: Maybe<Scalars["String"]["output"]>;
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  finishedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["String"]["output"];
  pageCount: Maybe<Scalars["Int"]["output"]>;
  requestedBy: Scalars["String"]["output"];
  requestedByEmail: Maybe<Scalars["String"]["output"]>;
  requestedByName: Maybe<Scalars["String"]["output"]>;
  startedAt: Maybe<Scalars["DateTime"]["output"]>;
  status: PdfExportJobStatus;
  syncOrAsync: Scalars["String"]["output"];
  templateId: Scalars["String"]["output"];
  unmappedFontFamilies: Array<Scalars["String"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

/**
 * Workspace-facing PDF export history entry for one document.
 *
 * Unlike the admin jobs table this intentionally exposes only the fields a
 * document user needs for re-download/re-export. Authorization is checked per
 * workspace before any row is returned.
 */
export interface PdfExportHistoryEntryType {
  __typename?: "PdfExportHistoryEntryType";
  createdAt: Scalars["DateTime"]["output"];
  docId: Scalars["String"]["output"];
  downloadUrl: Maybe<Scalars["String"]["output"]>;
  errorClass: Maybe<Scalars["String"]["output"]>;
  errorDetail: Maybe<Scalars["String"]["output"]>;
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  finishedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["String"]["output"];
  pageCount: Maybe<Scalars["Int"]["output"]>;
  renderInputs: Scalars["JSON"]["output"];
  startedAt: Maybe<Scalars["DateTime"]["output"]>;
  status: PdfExportJobStatus;
  templateId: Scalars["String"]["output"];
  unmappedFontFamilies: Array<Scalars["String"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

/**
 * V2 export input (`P-PDF-TPL-11-01`). Mirrors the application-layer
 * [`PdfExportInputV2`] one-to-one so the GraphQL surface accepts the
 * full L3 shape declared by the V2 PDF-Export architecture (D1/D2/D3
 * in `docs/dev/server/pdf-export-v2-architecture.md`). Every optional
 * field is gated by the template's capability matrix at validation
 * time — the [`exportPdf`] mutation refuses inputs that touch
 * off-capabilities before any render is dispatched.
 *
 * [`PdfExportInputV2`]: myoxus_application::pdf_export::render_context::PdfExportInputV2
 * [`exportPdf`]: PdfExportMutation::export_pdf
 */
export interface PdfExportInputV2Input {
  /** Color treatment applied to the effective document palette. */
  colorVariant?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Optional PDF writer standards profile. Accepted values are
   * `"standard"`, `"pdfa-1b"`, `"pdfa-2b"`, `"pdfa-2u"`, `"pdfa-3b"` and
   * `"pdfua-1"`. PDF/X is intentionally not accepted until the renderer
   * has a proven PDF/X output path.
   */
  complianceProfile?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Confidentiality watermark label. Must be present in the
   * manifest's `confidentialityLabels` allowed-set.
   */
  confidentialityLabel?: InputMaybe<Scalars["String"]["input"]>;
  /** Cover-page override; absence uses the selected template default. */
  coverPage?: InputMaybe<Scalars["Boolean"]["input"]>;
  /**
   * Document UUID. Nanoid forms are accepted by the underlying parser
   * but the canonical wire form is the UUIDv5 derived from the nanoid.
   */
  docId: Scalars["String"]["input"];
  /**
   * Document-version selector from the export dialog.
   *
   * `latest` means "current document state"; if document versioning is
   * enabled and `on_pdf_export` is configured, the server captures a named
   * snapshot before rendering. A UUID pins the render to that named version's
   * DocHistory snapshot.
   */
  documentVersionId?: InputMaybe<Scalars["String"]["input"]>;
  /** Footer layout from the selected template capability; absence keeps its default. */
  footerStyle?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Image quality tier. Accepts `"low"` / `"med"` / `"high"` /
   * `"lossless"`. This per-render value overrides `pdf_export_settings`
   * and is persisted in the render-input/audit snapshot.
   */
  imageQuality?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Override locale (BCP-47, e.g. `"de-AT"`). Falls through to the
   * brand default and finally to the server default when `None`.
   */
  locale?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Page orientation. Always available independent of template capabilities.
   * Defaults to portrait for every export.
   */
  orientation?: InputMaybe<Scalars["String"]["input"]>;
  /** Page-number format independent of the selected footer layout. */
  pageNumbering?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Per-render override for the paper size: `"A4"`, `"Letter"`, `"A3"`,
   * `"A5"`, or `"16:9"`. The renderer consumes these V2 literals directly.
   */
  paperSize?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Template selector — accepts the kebab-case slug
   * (`"default"`/`"report"`/`"letter"`) or a UUID. The slug path is
   * preserved for backward compat with clients that have not migrated
   * to UUIDs; both forms resolve through the V2 registry.
   */
  templateId: Scalars["String"]["input"];
  /** TOC behavior — `"off"` / `"auto"` / `"force"`. */
  tocBehavior?: InputMaybe<Scalars["String"]["input"]>;
  /**
   * Free-form template inputs validated against the manifest's
   * `inputs_schema`. Persisted on `pdf_export_render_audit.l3_inputs`
   * for compliance.
   */
  typedInputs?: InputMaybe<Scalars["JSON"]["input"]>;
  /** Workspace UUID (string-form for GraphQL transport). */
  workspaceId: Scalars["String"]["input"];
}

export enum PdfExportJobStatus {
  done = "done",
  failed = "failed",
  queued = "queued",
  running = "running",
}

/**
 * One PDF export job. Returned by `exportPdf` (sync or async path) and
 * `pdfExportJob` (poll). State machine: `queued → running → done|failed`.
 * Sync renders skip `queued`/`running` and land directly in `done` (or
 * fail with a GraphQL error before any row is returned).
 */
export interface PdfExportJobType {
  __typename?: "PdfExportJobType";
  createdAt: Scalars["DateTime"]["output"];
  docId: Scalars["String"]["output"];
  /**
   * Present only when `status == done` and `output_blob_id` is set. The
   * path is workspace-scoped: a leaked `id` alone is not enough to fetch
   * the file (the REST handler re-checks workspace Read permission).
   */
  downloadUrl: Maybe<Scalars["String"]["output"]>;
  /**
   * Stable machine-readable failure category, set when `status == failed`.
   * Possible values: `TooLarge`, `Timeout`, `RenderError`, `DecodeError`,
   * `AssetError`, `TemplateError`, `StorageError`, `EnqueueError`,
   * `Stalled`. Pin user-facing translations on this field, never on
   * `error_detail`.
   */
  errorClass: Maybe<Scalars["String"]["output"]>;
  /**
   * Free-form failure message suitable for log lines. May contain
   * renderer/storage-backend text and is **not** intended for end-user
   * display.
   */
  errorDetail: Maybe<Scalars["String"]["output"]>;
  /**
   * Set when the job transitions to `done`. The download URL stops working
   * after this timestamp; the nightly cleanup sweep purges the row and
   * the underlying blob shortly after.
   */
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["String"]["output"];
  /**
   * Number of pages in the rendered PDF. Populated when `status == done`;
   * `None` while queued/running and on failed renders.
   */
  pageCount: Maybe<Scalars["Int"]["output"]>;
  /**
   * Set when the worker (or sync path) begins rendering. `None` while the
   * job is still `queued`. Clients can use `(now - started_at)` to estimate
   * how long the active render has been running.
   */
  startedAt: Maybe<Scalars["DateTime"]["output"]>;
  status: PdfExportJobStatus;
  /**
   * Theme font families the renderer could not match in the FontBook.
   * This should stay empty in production because the API resolves every
   * effective role to a pinned TTF/OTF/VF asset before dispatch. A non-empty
   * value is therefore diagnostic evidence that the server-side Theme DB gate
   * was bypassed or an asset vanished after enqueue.
   */
  unmappedFontFamilies: Array<Scalars["String"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

/** Latest render-audit projection attached to an admin job row. */
export interface PdfExportRenderAuditType {
  __typename?: "PdfExportRenderAuditType";
  classification: Maybe<Scalars["String"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  documentMetadataSnapshot: Scalars["JSON"]["output"];
  documentVersionId: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  l3Inputs: Scalars["JSON"]["output"];
  locale: Scalars["String"]["output"];
  metadataValidation: Scalars["JSON"]["output"];
  renderAppearanceHash: Scalars["String"]["output"];
  templateVersion: Scalars["String"]["output"];
}

/**
 * Flat view of the per-workspace export-time defaults. This is the only
 * workspace-facing contract for paper, locale, ICC profile, image quality,
 * ligatures and default template.
 */
export interface PdfExportSettings {
  __typename?: "PdfExportSettings";
  defaultColorProfile: Maybe<Scalars["String"]["output"]>;
  defaultImageQuality: Maybe<Scalars["String"]["output"]>;
  defaultLocale: Maybe<Scalars["String"]["output"]>;
  defaultPaperSize: Maybe<Scalars["String"]["output"]>;
  defaultTemplateId: Maybe<Scalars["ID"]["output"]>;
  ligaturesEnabled: Scalars["Boolean"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export enum PdfFontLicenseStatusEnum {
  Approved = "Approved",
  Pending = "Pending",
  Rejected = "Rejected",
}

/**
 * GraphQL projection of a font row. The `license` field is the SPDX-style
 * identifier (`"OFL-1.1"`, `"Apache-2.0"`, `"MIT"`, `"GPL"`,
 * `"Proprietary"`, or any free-form string for `Other`).
 */
export interface PdfFontType {
  __typename?: "PdfFontType";
  approvedAt: Maybe<Scalars["DateTime"]["output"]>;
  approvedBy: Maybe<Scalars["ID"]["output"]>;
  familyName: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  license: Scalars["String"]["output"];
  licenseStatus: PdfFontLicenseStatusEnum;
  sha256: Scalars["String"]["output"];
  style: Scalars["String"]["output"];
  uploadedAt: Scalars["DateTime"]["output"];
  /** Always set for rows returned by this add-on upload surface. */
  uploadedBy: Maybe<Scalars["ID"]["output"]>;
  weight: Scalars["Int"]["output"];
}

export interface PdfIccProfileType {
  __typename?: "PdfIccProfileType";
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  profileType: PdfIccProfileTypeEnum;
  sha256: Scalars["String"]["output"];
  uploadedAt: Scalars["DateTime"]["output"];
  /** `None` for system-seeded profiles (e.g. bundled sRGB/CMYK defaults). */
  uploadedBy: Maybe<Scalars["ID"]["output"]>;
}

export enum PdfIccProfileTypeEnum {
  CMYK = "CMYK",
  sRGB = "sRGB",
}

/**
 * Admin-facing projection of [`PdfTemplate`]. Mirrors the DB row shape
 * 1:1 — workspace-facing surface uses
 * [`crate::graphql::pdf_workspace::PdfTemplatePublic`] instead.
 */
export interface PdfTemplateAdminType {
  __typename?: "PdfTemplateAdminType";
  createdAt: Scalars["DateTime"]["output"];
  /**
   * Author of the upload; `None` for system-seeded entries (`default`,
   * `report`, `letter`).
   */
  createdBy: Maybe<Scalars["ID"]["output"]>;
  deletedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  /**
   * Full L2 manifest JSON. Surfaced verbatim so the admin UI can render
   * the capability matrix without an extra query.
   */
  manifest: Scalars["JSON"]["output"];
  name: Scalars["String"]["output"];
  schemaVersion: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

/**
 * One row from `pdf_template_files` — the manifest-declared bundle files
 * of a template. The blob key + sha256 let an admin page link straight
 * to the storage backend for diagnostics.
 */
export interface PdfTemplateFileType {
  __typename?: "PdfTemplateFileType";
  blobKey: Scalars["String"]["output"];
  contentHash: Scalars["String"]["output"];
  filePath: Scalars["String"]["output"];
  templateId: Scalars["ID"]["output"];
}

/**
 * Public, workspace-facing projection of a PDF template. Compared to the
 * internal [`PdfTemplate`] this:
 *
 * - Drops `created_by`, `created_at`, `deleted_at` (admin metadata).
 * - Carries the `is_default` flag from the workspace's assignment row so
 * the export picker can pre-select it.
 * - Surfaces `manifest.capabilities` as a JSON sub-object so the picker
 * can render capability inputs (toggle / enum / color / array<string>)
 * without an extra round-trip.
 * - Surfaces `manifest.inputs_schema` so the picker can prefill required
 * `typed_inputs` before the mutation hits the server-side validator.
 */
export interface PdfTemplatePublic {
  __typename?: "PdfTemplatePublic";
  /**
   * `manifest.capabilities` slice as JSON. Empty object if the manifest
   * has no capabilities block (defensive — schema validation rejects this
   * at upload time, but we don't trust DB-state invariants here).
   */
  capabilities: Scalars["JSON"]["output"];
  id: Scalars["ID"]["output"];
  /**
   * `manifest.inputs_schema` slice as JSON. Empty object if the manifest
   * does not constrain typed inputs.
   */
  inputsSchema: Scalars["JSON"]["output"];
  /**
   * Whether this template is the workspace's default selection in the
   * export picker.
   */
  isDefault: Scalars["Boolean"]["output"];
  name: Scalars["String"]["output"];
  schemaVersion: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

/**
 * Full workspace ↔ template assignment row, with the per-row audit metadata
 * the admin UI needs to show "who assigned this template, and when". Compare
 * to [`PdfTemplatePublic`] which is intentionally minimal for workspace
 * members.
 */
export interface PdfWorkspaceTemplateAssignmentType {
  __typename?: "PdfWorkspaceTemplateAssignmentType";
  assignedAt: Scalars["DateTime"]["output"];
  assignedBy: Maybe<Scalars["ID"]["output"]>;
  isDefault: Scalars["Boolean"]["output"];
  templateId: Scalars["ID"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

/**
 * GraphQL enum representing the role (permission level) of a workspace member.
 *
 * Named `"Permission"` in the GraphQL schema for backward compatibility.
 */
export enum Permission {
  Admin = "Admin",
  Collaborator = "Collaborator",
  Commenter = "Commenter",
  External = "External",
  Manager = "Manager",
  Owner = "Owner",
  Reader = "Reader",
}

/**
 * Existing catalog theme metadata exposed for a canonical personal workspace.
 *
 * Theme authoring remains an administrator capability. This surface only
 * exposes the fields needed to select an existing server-owned theme for the
 * workspace; it does not create a user-owned theme or account preference.
 */
export interface PersonalWorkspaceThemeOptionType {
  __typename?: "PersonalWorkspaceThemeOptionType";
  isDefault: Scalars["Boolean"]["output"];
  name: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
}

/** Effective catalog-theme selection for the canonical personal workspace. */
export interface PersonalWorkspaceThemeSelectionType {
  __typename?: "PersonalWorkspaceThemeSelectionType";
  inheritsGlobal: Scalars["Boolean"]["output"];
  themeName: Scalars["String"]["output"];
  themeSlug: Scalars["String"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export enum PolicyStateEnum {
  Allowed = "Allowed",
  Disabled = "Disabled",
  RequiresApproval = "RequiresApproval",
}

export interface PrepareContextDocumentsInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  target: ContextDocumentTargetInput;
}

export interface PrepareDocumentReviewInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  target: ContextDocumentTargetInput;
}

export interface PrepareProjectAssistantInput {
  /** Bounded answers decode to the package's declared native value types. */
  answers: Scalars["JSON"]["input"];
  clientVersion?: InputMaybe<Scalars["Int"]["input"]>;
  identity: AssistantPackageIdentityInput;
  locale?: InputMaybe<Scalars["String"]["input"]>;
}

export interface PrepareTaskHandoverInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  target: ContextDocumentTargetInput;
}

export interface PrepareTaskMaintenanceInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  target: ContextDocumentTargetInput;
}

export interface PrepareTaskPreparationInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  target: ContextDocumentTargetInput;
}

export interface PrepareWorkspaceAssistantInput {
  answers: Scalars["JSON"]["input"];
  identity: AssistantPackageIdentityInput;
  project?: InputMaybe<WorkspaceProjectSetupInput>;
  setup?: InputMaybe<WorkspaceSetupInput>;
}

/**
 * Server admission facts stay native. The client confirms the digest and
 * declared answers rather than supplying an installed schema or document body.
 */
export interface PreparedContextDocuments {
  __typename?: "PreparedContextDocuments";
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  documents: Array<AssistantPreparedDocumentComponent>;
  executionAvailable: Scalars["Boolean"]["output"];
  folder: AssistantFolderDestination;
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  target: ContextDocumentTarget;
}

export interface PreparedDocumentReview {
  __typename?: "PreparedDocumentReview";
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  deadlineAt: Scalars["DateTime"]["output"];
  deadlineTimeZone: Scalars["String"]["output"];
  destinationDatabaseId: Scalars["ID"]["output"];
  executionAvailable: Scalars["Boolean"]["output"];
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  reviewerId: Scalars["ID"]["output"];
  sourceDocumentId: Scalars["ID"]["output"];
  sourceExternalId: Scalars["String"]["output"];
  sourceMetadataDeadline: Maybe<Scalars["DateTime"]["output"]>;
  sourceRevision: Scalars["String"]["output"];
  target: ContextDocumentTarget;
  title: Scalars["String"]["output"];
}

export interface PreparedGenericDefinition {
  __typename?: "PreparedGenericDefinition";
  complexity: ProjectOptionPreset;
  componentId: Scalars["String"]["output"];
  defaultCurrency: Scalars["String"]["output"];
  definitionId: Scalars["String"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  digest: Scalars["String"]["output"];
  includeSampleRows: Scalars["Boolean"]["output"];
  priority: ProjectOptionPreset;
  structure: ProjectStructurePreset;
  title: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface PreparedProjectAssistant {
  __typename?: "PreparedProjectAssistant";
  answers: Array<AssistantNamedValue>;
  clientVersion: Maybe<Scalars["Int"]["output"]>;
  complexity: ProjectOptionPreset;
  counts: AssistantProjectSetupCounts;
  defaultCurrency: Scalars["String"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  documentMetadata: Array<AssistantPreparedDocumentMetadata>;
  documents: Array<AssistantPreparedDocumentComponent>;
  executionAvailable: Scalars["Boolean"]["output"];
  folder: Maybe<AssistantFolderDestination>;
  includeSampleRows: Scalars["Boolean"]["output"];
  initialViewKey: Scalars["String"]["output"];
  initialViewKind: DatabaseViewKind;
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  priority: ProjectOptionPreset;
  setup: AssistantProjectSetupFacts;
  structure: ProjectStructurePreset;
  templateDigest: Scalars["String"]["output"];
  templateId: Scalars["String"]["output"];
  templateVersion: Scalars["String"]["output"];
  title: Scalars["String"]["output"];
}

export interface PreparedTaskHandover {
  __typename?: "PreparedTaskHandover";
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  deadlineAt: Scalars["DateTime"]["output"];
  deadlineTimeZone: Scalars["String"]["output"];
  destinationDatabaseId: Scalars["ID"]["output"];
  executionAvailable: Scalars["Boolean"]["output"];
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  prerequisites: Array<AssistantTaskReference>;
  responsibleId: Scalars["ID"]["output"];
  sourceDocumentId: Scalars["ID"]["output"];
  sourceExternalId: Scalars["String"]["output"];
  target: ContextDocumentTarget;
  title: Scalars["String"]["output"];
}

export interface PreparedTaskMaintenance {
  __typename?: "PreparedTaskMaintenance";
  actorId: Scalars["ID"]["output"];
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  executionAvailable: Scalars["Boolean"]["output"];
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  proposal: TaskCorrectionProposal;
  target: ContextDocumentTarget;
  workspaceId: Scalars["ID"]["output"];
}

export interface PreparedTaskPreparation {
  __typename?: "PreparedTaskPreparation";
  actorId: Scalars["ID"]["output"];
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  executionAvailable: Scalars["Boolean"]["output"];
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  source: TaskPreparationSource;
  target: ContextDocumentTarget;
  workspaceId: Scalars["ID"]["output"];
}

export interface PreparedWorkspaceAssistant {
  __typename?: "PreparedWorkspaceAssistant";
  answers: Array<AssistantNamedValue>;
  assistanceMode: AssistanceMode;
  initialContent: WorkspaceInitialContent;
  name: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  project: Maybe<PreparedProjectAssistant>;
  setup: Maybe<PreparedWorkspaceSetup>;
}

export interface PreparedWorkspaceSetup {
  __typename?: "PreparedWorkspaceSetup";
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  components: Array<AssistantComponent>;
  definitions: Array<PreparedGenericDefinition>;
  documentMetadata: Array<AssistantPreparedDocumentMetadata>;
  documents: Array<AssistantPreparedDocumentComponent>;
  executionAvailable: Scalars["Boolean"]["output"];
  folder: Maybe<AssistantFolderDestination>;
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  workflow: AssistantWorkflowIdentity;
}

export interface PreviewDatabaseCsvImportInput {
  databaseTitle: Scalars["String"]["input"];
  dialect?: InputMaybe<DatabaseCsvDialectInput>;
  firstRowIsHeader?: InputMaybe<Scalars["Boolean"]["input"]>;
  mapping?: InputMaybe<Array<DatabaseCsvColumnMappingInput>>;
  workspaceId: Scalars["ID"]["input"];
}

export interface PreviewDatabaseJsonImportInput {
  conflictStrategy?: InputMaybe<DatabaseJsonConflictStrategyType>;
  mode?: InputMaybe<DatabaseJsonImportModeType>;
  /** Existing managed imports preview against their actual protected definition. */
  targetDatabaseId?: InputMaybe<Scalars["ID"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface ProjectAssistanceOverrideInput {
  mode?: InputMaybe<AssistanceMode>;
  projectId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ProjectAssistanceOverrideType {
  __typename?: "ProjectAssistanceOverrideType";
  mode: AssistanceMode;
  projectId: Scalars["ID"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export interface ProjectAssistantConfirmationInput {
  admissionConfirmation?: InputMaybe<Scalars["String"]["input"]>;
  answers: Scalars["JSON"]["input"];
  clientVersion?: InputMaybe<Scalars["Int"]["input"]>;
  identity: AssistantPackageIdentityInput;
  locale?: InputMaybe<Scalars["String"]["input"]>;
  planDigest: Scalars["String"]["input"];
  requestId?: InputMaybe<Scalars["ID"]["input"]>;
}

/** Three-state outcome of the project-creation policy gate. */
export enum ProjectCreationDecisionEnum {
  Allowed = "Allowed",
  Denied = "Denied",
  RequiresApproval = "RequiresApproval",
}

export enum ProjectOptionPreset {
  FiveStep = "FiveStep",
  ThreeStep = "ThreeStep",
}

export enum ProjectRequestScopeEnum {
  OrganizationRoot = "OrganizationRoot",
  Ou = "Ou",
}

export enum ProjectRequestStatusEnum {
  Approved = "Approved",
  Cancelled = "Cancelled",
  Pending = "Pending",
  Rejected = "Rejected",
}

/**
 * Accepted identities survive lost responses and source withdrawal. Readback
 * exposes the native state; it never starts or resumes publication.
 */
export interface ProjectSetup {
  __typename?: "ProjectSetup";
  acceptedDescriptor: Maybe<AssistantPackage>;
  acceptedPlan: PreparedProjectAssistant;
  currentReview: Maybe<PreparedProjectAssistant>;
  database: Maybe<DatabaseRecord>;
  documents: Array<ProjectSetupDocument>;
  folderId: Maybe<Scalars["String"]["output"]>;
  placementComplete: Scalars["Boolean"]["output"];
  reasonCode: Maybe<Scalars["String"]["output"]>;
  requestId: Scalars["ID"]["output"];
  reservedDatabaseId: Scalars["ID"]["output"];
  status: ProjectSetupStatus;
}

export interface ProjectSetupDocument {
  __typename?: "ProjectSetupDocument";
  componentId: Scalars["String"]["output"];
  created: Scalars["Boolean"]["output"];
  /** Available only after the native leaf/root transaction acknowledged it. */
  externalId: Maybe<Scalars["String"]["output"]>;
  placed: Scalars["Boolean"]["output"];
  reservedDocumentId: Scalars["ID"]["output"];
}

export enum ProjectSetupStatus {
  Pending = "Pending",
  ReReviewRequired = "ReReviewRequired",
  Ready = "Ready",
  StopRequested = "StopRequested",
  Stopped = "Stopped",
  Unavailable = "Unavailable",
}

export enum ProjectStructurePreset {
  Milestones = "Milestones",
  Phases = "Phases",
  PhasesAndMilestones = "PhasesAndMilestones",
  TasksOnly = "TasksOnly",
}

/** Provisioning mode for a workspace template policy. */
export enum ProvisioningModeType {
  ManagedUntilLocalEdit = "ManagedUntilLocalEdit",
  ManualUpdate = "ManualUpdate",
  SeedOnce = "SeedOnce",
}

export enum PublicDocMode {
  Edgeless = "Edgeless",
  Page = "Page",
}

/** Minimal public user profile exposed in invitation and document-share contexts. */
export interface PublicUserType {
  __typename?: "PublicUserType";
  avatarUrl: Maybe<Scalars["String"]["output"]>;
  email: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
}

/** Filter/pagination parameters for Copilot chat history queries. */
export interface QueryChatHistoriesInput {
  action?: InputMaybe<Scalars["Boolean"]["input"]>;
  fork?: InputMaybe<Scalars["Boolean"]["input"]>;
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  messageOrder?: InputMaybe<ChatHistoryOrder>;
  pinned?: InputMaybe<Scalars["Boolean"]["input"]>;
  sessionId?: InputMaybe<Scalars["String"]["input"]>;
  sessionOrder?: InputMaybe<ChatHistoryOrder>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  withMessages?: InputMaybe<Scalars["Boolean"]["input"]>;
  withPrompt?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface QueryRoot {
  __typename?: "QueryRoot";
  aggregate: SearchAggregateType;
  calendarAccounts: Array<CalendarAccountType>;
  calendarCaldavProviders: Array<Scalars["String"]["output"]>;
  /**
   * Resolve one calendar event inside an explicitly authorized workspace.
   *
   * Event blocks store only the stable event/workspace identifiers.  A
   * dedicated lookup keeps their rendering independent from whichever date
   * range the Journal currently has in its client cache.
   */
  calendarEvent: Maybe<CalendarEventType>;
  /** List all event tags for the workspace. */
  calendarEventTags: Array<CalendarEventTagType>;
  calendarEvents: Array<CalendarEventType>;
  /**
   * Query free/busy information for workspace members within a time range
   * (P90-CAL-H-07).
   *
   * Returns per-user busy periods derived from `calendar_event_instances`.
   * Only non-cancelled instances are included.  The caller must be a member
   * of the workspace to access its calendar data.
   */
  calendarFreeBusy: Array<UserFreeBusy>;
  calendarProviders: Array<Scalars["String"]["output"]>;
  /**
   * Public, cache-free projection of the server-owned Browser Web update policy.
   *
   * A malformed or unavailable value fails closed with a stable transport code;
   * persistence details are intentionally kept out of the client-visible error.
   */
  clientUpdateControl: ClientUpdateControlV1;
  commentEditHistory: Array<CommentEditHistoryType>;
  commentReplies: Array<CommentType>;
  commentThreads: Array<CommentType>;
  currentUser: Maybe<UserType>;
  /**
   * Export all workspace-native events within a time window as a RFC 5545
   * VCALENDAR string (P-JCAL-SERVER-07-A).
   *
   * Only native events (origin='native') owned by the workspace are included.
   * The caller needs SettingsRead permission.
   */
  exportWorkspaceCalendarIcs: Scalars["String"]["output"];
  getInviteInfo: InvitationType;
  oauthProviders: Array<OAuthProviderType>;
  /** Plan persisted editor-local Database migration without product writes. */
  previewLegacyDatabaseMigration: LegacyDatabaseMigrationPlanObjectType;
  publicUserById: Maybe<PublicUserType>;
  /** @deprecated use currentUser.revealedAccessTokens */
  revealedAccessTokens: Array<RevealedAccessToken>;
  /** Complexity 50: FTS query + optional semantic search + per-doc ACL filtering. */
  search: Array<SearchDocType>;
  searchDocs: Array<SearchDocType>;
  /**
   * Complexity 30: loads user count, feature/config state, and OAuth checks
   * plus 2 more for gitSync and journal config.
   */
  serverConfig: ServerConfigType;
  /**
   * Search server users by name or email (privacy-scoped — no email/admin field exposure).
   *
   * Permission: caller must be admin OR must hold `WorkspaceRole::Admin` (or higher)
   * on at least one workspace (`WorkspaceAction::UsersManage`).
   */
  serverUsers: Array<ServerUserSearchResult>;
  user: Maybe<UserOrLimitedUser>;
  /**
   * Complexity 10 * child: permission check + workspace fetch; child fields may trigger
   * additional DB queries.
   */
  workspace: Maybe<WorkspaceType>;
  workspaceCalendarSeries: Array<CalendarEventType>;
  /**
   * Get workspace calendar settings (writeback target, default reminder).
   *
   * Returns `None` when no settings have been saved yet (defaults apply).
   */
  workspaceCalendarSettings: Maybe<WorkspaceCalendarSettingsType>;
  workspaceCalendars: Array<WorkspaceCalendarType>;
  /** Actor-scoped, redacted durable XWS status. */
  workspaceContentOperation: WorkspaceContentOperationType;
  /**
   * Resolve an old XWS route only when the actor can currently read the
   * canonical target. Denied and missing targets both return `null`.
   */
  workspaceContentRedirect: Maybe<WorkspaceContentRedirectType>;
  workspaceImport: WorkspaceImportType;
  workspaceRolePermissions: WorkspaceRolePermissions;
  /**
   * Complexity 20 * child: lists all workspaces for a user; each returned workspace
   * may have expensive sub-field resolvers.
   */
  workspaces: Array<WorkspaceType>;
}

export interface QueryRootAggregateArgs {
  language?: InputMaybe<Scalars["String"]["input"]>;
  query: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCalendarEventArgs {
  eventId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCalendarEventTagsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCalendarEventsArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCalendarFreeBusyArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
  userIds: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCommentEditHistoryArgs {
  commentId: Scalars["String"]["input"];
  docId: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCommentRepliesArgs {
  docId: Scalars["String"]["input"];
  parentCommentId: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootCommentThreadsArgs {
  docId: Scalars["String"]["input"];
  filter?: InputMaybe<CommentThreadFilter>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootExportWorkspaceCalendarIcsArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootGetInviteInfoArgs {
  inviteId: Scalars["String"]["input"];
}

export interface QueryRootPreviewLegacyDatabaseMigrationArgs {
  input: LegacyDatabaseMigrationInput;
}

export interface QueryRootPublicUserByIdArgs {
  id: Scalars["String"]["input"];
}

export interface QueryRootSearchArgs {
  language?: InputMaybe<Scalars["String"]["input"]>;
  query: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  sortBy?: InputMaybe<SearchSortBy>;
  sortDirection?: InputMaybe<SortDirection>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  useSemanticSearch?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootSearchDocsArgs {
  language?: InputMaybe<Scalars["String"]["input"]>;
  query: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  sortBy?: InputMaybe<SearchSortBy>;
  sortDirection?: InputMaybe<SortDirection>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
  useSemanticSearch?: InputMaybe<Scalars["Boolean"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootServerUsersArgs {
  search: Scalars["String"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface QueryRootUserArgs {
  email: Scalars["String"]["input"];
}

export interface QueryRootWorkspaceArgs {
  docId?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["String"]["input"];
}

export interface QueryRootWorkspaceCalendarSeriesArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootWorkspaceCalendarSettingsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootWorkspaceCalendarsArgs {
  workspaceId: Scalars["String"]["input"];
}

export interface QueryRootWorkspaceContentOperationArgs {
  operationId: Scalars["UUID"]["input"];
}

export interface QueryRootWorkspaceContentRedirectArgs {
  input: WorkspaceContentRedirectInput;
}

export interface QueryRootWorkspaceImportArgs {
  workspaceImportId: Scalars["ID"]["input"];
}

export interface QueryRootWorkspaceRolePermissionsArgs {
  id: Scalars["String"]["input"];
}

export interface QueryTooLongDataType {
  __typename?: "QueryTooLongDataType";
  message: Scalars["String"]["output"];
}

/** Edge wrapper for paginated doc results. */
export interface RecentDocEdge {
  __typename?: "RecentDocEdge";
  node: RecentDocNode;
}

/** A doc node inside a paginated recently-updated-docs result. */
export interface RecentDocNode {
  __typename?: "RecentDocNode";
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  creatorId: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  lastUpdaterId: Maybe<Scalars["String"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
}

export interface RecolorWorkspaceTagInput {
  colorRole: Scalars["String"]["input"];
  tagId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export enum RecurrenceFrequency {
  Daily = "Daily",
  Monthly = "Monthly",
  Weekly = "Weekly",
  Yearly = "Yearly",
}

export enum RecurrenceLifecycle {
  Active = "Active",
  Ended = "Ended",
  Paused = "Paused",
}

export enum RecurrenceMode {
  AfterCompletion = "AfterCompletion",
  Fixed = "Fixed",
}

export interface RecurrenceOccurrence {
  __typename?: "RecurrenceOccurrence";
  dueAt: Scalars["DateTime"]["output"];
  nominal: RecurrenceValue;
}

export interface RecurrencePreview {
  __typename?: "RecurrencePreview";
  completionReference: Maybe<RecurrenceValue>;
  occurrence: RecurrenceOccurrence;
}

export interface RecurrencePreviewInput {
  after?: InputMaybe<Scalars["DateTime"]["input"]>;
  completionReference?: InputMaybe<RecurrenceValueInput>;
  count?: Scalars["Int"]["input"];
  expectedRevision?: InputMaybe<Scalars["Int"]["input"]>;
  rule: RecurrenceRuleInput;
  /** Optional native series-edit boundary; must accompany its current revision. */
  seriesId?: InputMaybe<Scalars["ID"]["input"]>;
}

export enum RecurrenceRelativeUnit {
  Days = "Days",
  Months = "Months",
  Weeks = "Weeks",
}

export interface RecurrenceRule {
  __typename?: "RecurrenceRule";
  dateOnly: Scalars["Boolean"]["output"];
  day: Maybe<Scalars["Int"]["output"]>;
  end: Maybe<RecurrenceValue>;
  frequency: Maybe<RecurrenceFrequency>;
  interval: Scalars["Int"]["output"];
  lastDay: Scalars["Boolean"]["output"];
  mode: RecurrenceMode;
  month: Maybe<Scalars["Int"]["output"]>;
  relativeUnit: Maybe<RecurrenceRelativeUnit>;
  start: Maybe<RecurrenceValue>;
  weekdays: Array<RecurrenceWeekday>;
  zone: Scalars["String"]["output"];
}

export type RecurrenceRuleInput =
  | { afterCompletion: CompletionRecurrenceInput; fixed?: never }
  | { afterCompletion?: never; fixed: FixedRecurrenceInput };

export interface RecurrenceValue {
  __typename?: "RecurrenceValue";
  date: Maybe<Scalars["String"]["output"]>;
  localDateTime: Maybe<Scalars["String"]["output"]>;
}

/** Exactly one civil value; a local timestamp must not carry a UTC offset. */
export type RecurrenceValueInput =
  | { date: Scalars["String"]["input"]; localDateTime?: never }
  | { date?: never; localDateTime: Scalars["String"]["input"] };

export enum RecurrenceWeekday {
  Friday = "Friday",
  Monday = "Monday",
  Saturday = "Saturday",
  Sunday = "Sunday",
  Thursday = "Thursday",
  Tuesday = "Tuesday",
  Wednesday = "Wednesday",
}

/** An available server upgrade with version string and download URL. */
export interface ReleaseVersionType {
  __typename?: "ReleaseVersionType";
  /** Human-readable changelog text for this release (optional). */
  changelog: Maybe<Scalars["String"]["output"]>;
  /** ISO-8601 publication timestamp of this release (optional). */
  publishedAt: Maybe<Scalars["String"]["output"]>;
  /** Download or changelog URL. */
  url: Scalars["String"]["output"];
  /** Semantic version string of the available release. */
  version: Scalars["String"]["output"];
}

/** Result of a `removeAvatar` mutation. */
export interface RemoveAvatar {
  __typename?: "RemoveAvatar";
  /** Always `true` on success. */
  success: Scalars["Boolean"]["output"];
}

export interface RemoveContextBlobInput {
  blobId: Scalars["String"]["input"];
  contextId: Scalars["String"]["input"];
}

export interface RemoveContextCategoryInput {
  categoryId: Scalars["String"]["input"];
  contextId: Scalars["String"]["input"];
  type: Scalars["String"]["input"];
}

export interface RemoveContextDocInput {
  contextId: Scalars["String"]["input"];
  docId: Scalars["String"]["input"];
}

export interface RemoveContextFileInput {
  contextId: Scalars["String"]["input"];
  fileId: Scalars["String"]["input"];
}

export interface RenameWorkspaceTagInput {
  name: Scalars["String"]["input"];
  tagId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface ReorderDatabaseFieldsInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevisions?: InputMaybe<Array<DatabaseFieldEditRevisionInput>>;
  fieldIds: Array<Scalars["ID"]["input"]>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface ReorderDatabaseViewsInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevisions?: InputMaybe<Array<DatabaseViewEditRevisionInput>>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  viewIds: Array<Scalars["ID"]["input"]>;
}

/** Input for adding a reply to a comment thread. */
export interface ReplyCreateInput {
  /** UUID of the parent comment. */
  commentId: Scalars["String"]["input"];
  /** Rich-text body of the reply. */
  content: Scalars["JSON"]["input"];
}

/** A reply to a document comment thread. */
export interface ReplyObjectType {
  __typename?: "ReplyObjectType";
  commentId: Scalars["ID"]["output"];
  content: Scalars["JSON"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  user: PublicUserType;
}

/** Input for updating a reply's body. */
export interface ReplyUpdateInput {
  /** New rich-text body. */
  content: Scalars["JSON"]["input"];
  /** UUID of the reply. */
  id: Scalars["String"]["input"];
}

/** Input for `reportTemplateBuilderApplied`. */
export interface ReportBuilderAppliedInput {
  appliedHash: Scalars["String"]["input"];
  docId?: InputMaybe<Scalars["String"]["input"]>;
  locale: Scalars["String"]["input"];
  slug: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface ResetDatabaseViewUserStateInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision: Scalars["Int"]["input"];
  viewId: Scalars["ID"]["input"];
}

export interface ResetWorkspaceThemeProfileInput {
  workspaceId: Scalars["ID"]["input"];
}

/**
 * Input for resolving a Git Sync conflict.
 *
 * The caller selects one of the available resolution strategies.  For
 * `ManualMerge`, the `mergedContent` field must contain the user-edited
 * Markdown that replaces both conflicting versions.
 */
export interface ResolveConflictInput {
  /** ID of the conflict to resolve. */
  conflictId: Scalars["String"]["input"];
  /** User-edited Markdown content (required for `ManualMerge`). */
  mergedContent?: InputMaybe<Scalars["String"]["input"]>;
  /** Resolution strategy to apply. */
  resolution: GitSyncConflictResolution;
}

/**
 * Input for resolving a non-Markdown Git Sync file conflict.
 *
 * File conflicts are binary/blob decisions. `ManualMerge` is therefore not a
 * valid file resolution and is rejected by the server mutation.
 */
export interface ResolveFileConflictInput {
  /** ID of the file conflict to resolve. */
  conflictId: Scalars["String"]["input"];
  /** Resolution strategy to apply. */
  resolution: GitSyncConflictResolution;
}

export interface ResolvedSavedAssistantSelection {
  __typename?: "ResolvedSavedAssistantSelection";
  cleared: Array<SavedSetupClearedValue>;
  defaults: Array<AssistantNamedValue>;
  descriptor: Maybe<AssistantPackage>;
  unavailable: Scalars["Boolean"]["output"];
}

export interface ResponseTooLargeErrorDataType {
  __typename?: "ResponseTooLargeErrorDataType";
  message: Scalars["String"]["output"];
}

export interface RetryContextDocumentsInput {
  requestId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface RetryWorkspaceCreationInput {
  requestId: Scalars["ID"]["input"];
}

/** An API / personal access token including the plaintext secret (shown once on creation). */
export interface RevealedAccessToken {
  __typename?: "RevealedAccessToken";
  createdAt: Scalars["DateTime"]["output"];
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["UUID"]["output"];
  name: Scalars["String"]["output"];
  /** Plaintext token — shown only once; store it securely. */
  token: Scalars["String"]["output"];
}

/** Revision state as a GraphQL enum. */
export enum RevisionStateType {
  Archived = "Archived",
  Deprecated = "Deprecated",
  Draft = "Draft",
  Published = "Published",
  Validated = "Validated",
}

export interface RevokeDocUserRoleInput {
  /** Deprecated: use `externalDocId`. This alias carries the same workspace-local external key. */
  docId?: InputMaybe<Scalars["String"]["input"]>;
  externalDocId?: InputMaybe<Scalars["String"]["input"]>;
  userIds: Array<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

export interface RuntimeConfigNotFoundDataType {
  __typename?: "RuntimeConfigNotFoundDataType";
  message: Scalars["String"]["output"];
}

export interface SameSubscriptionRecurringDataType {
  __typename?: "SameSubscriptionRecurringDataType";
  message: Scalars["String"]["output"];
}

export interface SaveAssistantSetupInput {
  assistanceMode?: InputMaybe<AssistanceMode>;
  context: AssistantContext;
  id: Scalars["ID"]["input"];
  name: Scalars["String"]["input"];
  package: SavedAssistantSelectionInput;
  project?: InputMaybe<SavedAssistantSelectionInput>;
  setup?: InputMaybe<SavedAssistantSelectionInput>;
}

export interface SaveDatabaseCsvMappingTemplateInput {
  dialect?: InputMaybe<DatabaseCsvDialectInput>;
  firstRowIsHeader?: InputMaybe<Scalars["Boolean"]["input"]>;
  mapping: Array<DatabaseCsvAppliedColumnMappingInput>;
  name: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface SaveDatabaseViewUserStateInput {
  databaseId: Scalars["ID"]["input"];
  expectedViewEditRevision: Scalars["Int"]["input"];
  viewId: Scalars["ID"]["input"];
}

export interface SavedAssistantSelection {
  __typename?: "SavedAssistantSelection";
  databaseSources: Array<SavedSetupDatabaseSource>;
  defaults: Array<AssistantNamedValue>;
  documentSources: Array<SavedSetupDocumentSource>;
  packageId: Scalars["String"]["output"];
  workflow: Maybe<AssistantWorkflowIdentity>;
}

export interface SavedAssistantSelectionInput {
  answers: Scalars["JSON"]["input"];
  identity: AssistantPackageIdentityInput;
}

export enum SavedSetupClearReason {
  InputUnavailable = "InputUnavailable",
  NewComponent = "NewComponent",
  PackageUnavailable = "PackageUnavailable",
  SourceUnavailable = "SourceUnavailable",
  ValueUnavailable = "ValueUnavailable",
  WorkflowUnavailable = "WorkflowUnavailable",
}

export interface SavedSetupClearedValue {
  __typename?: "SavedSetupClearedValue";
  componentId: Maybe<Scalars["String"]["output"]>;
  inputId: Maybe<Scalars["String"]["output"]>;
  reason: SavedSetupClearReason;
}

export interface SavedSetupConfiguration {
  __typename?: "SavedSetupConfiguration";
  assistanceMode: Maybe<AssistanceMode>;
  context: AssistantContext;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  package: SavedAssistantSelection;
  project: Maybe<SavedAssistantSelection>;
  setup: Maybe<SavedAssistantSelection>;
}

export interface SavedSetupDatabaseSource {
  __typename?: "SavedSetupDatabaseSource";
  componentId: Scalars["String"]["output"];
  definitionId: Scalars["String"]["output"];
}

export interface SavedSetupDocumentSource {
  __typename?: "SavedSetupDocumentSource";
  componentId: Scalars["String"]["output"];
  digest: Scalars["String"]["output"];
  templateId: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

export interface SavedSetupResolution {
  __typename?: "SavedSetupResolution";
  configuration: SavedSetupConfiguration;
  package: ResolvedSavedAssistantSelection;
  project: Maybe<ResolvedSavedAssistantSelection>;
  setup: Maybe<ResolvedSavedAssistantSelection>;
  unavailable: Scalars["Boolean"]["output"];
}

export interface SearchAggregateType {
  __typename?: "SearchAggregateType";
  total: Scalars["Int"]["output"];
}

export interface SearchDocObjectType {
  __typename?: "SearchDocObjectType";
  blockId: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  createdByUser: Maybe<PublicUserType>;
  databaseContexts: Array<DatabaseDocumentReferenceType>;
  docId: Scalars["UUID"]["output"];
  externalId: Scalars["String"]["output"];
  highlight: Scalars["String"]["output"];
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  updatedByUser: Maybe<PublicUserType>;
}

export interface SearchDocType {
  __typename?: "SearchDocType";
  docId: Scalars["UUID"]["output"];
  plainText: Scalars["String"]["output"];
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["UUID"]["output"];
}

export interface SearchDocsInput {
  keyword: Scalars["String"]["input"];
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  /** Offset in this source's returned order; omitted or negative values start at zero. */
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  useSemanticSearch?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface SearchHighlightInputType {
  field: Scalars["String"]["input"];
  postTag?: InputMaybe<Scalars["String"]["input"]>;
  preTag?: InputMaybe<Scalars["String"]["input"]>;
}

export interface SearchInput {
  options: SearchOptionsInputType;
  query: SearchQueryInputType;
  useSemanticSearch?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface SearchNodeObjectType {
  __typename?: "SearchNodeObjectType";
  fields: Scalars["JSON"]["output"];
  highlights: Maybe<Scalars["JSON"]["output"]>;
}

export interface SearchOptionsInputType {
  highlights?: InputMaybe<Array<SearchHighlightInputType>>;
  pagination?: InputMaybe<SearchPaginationInputType>;
}

export interface SearchPaginationInputType {
  cursor?: InputMaybe<Scalars["String"]["input"]>;
  limit?: InputMaybe<Scalars["Int"]["input"]>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface SearchQueryInputType {
  boost?: InputMaybe<Scalars["Float"]["input"]>;
  field?: InputMaybe<Scalars["String"]["input"]>;
  matchValue?: InputMaybe<Scalars["String"]["input"]>;
  occur?: InputMaybe<SearchQueryOccur>;
  queries?: InputMaybe<Array<SearchQueryInputType>>;
  query?: InputMaybe<SearchQueryInputType>;
  type?: InputMaybe<SearchQueryType>;
}

export enum SearchQueryOccur {
  filter = "filter",
  must = "must",
  must_not = "must_not",
  should = "should",
}

export enum SearchQueryType {
  Boolean = "Boolean",
  Boost = "Boost",
  Exists = "Exists",
  Fuzzy = "Fuzzy",
  Match = "Match",
  Phrase = "Phrase",
  Prefix = "Prefix",
  Regex = "Regex",
  Wildcard = "Wildcard",
}

export interface SearchResultObjectType {
  __typename?: "SearchResultObjectType";
  nodes: Array<SearchNodeObjectType>;
  pagination: SearchResultPaginationType;
}

export interface SearchResultPaginationType {
  __typename?: "SearchResultPaginationType";
  count: Scalars["Int"]["output"];
  hasMore: Scalars["Boolean"]["output"];
  nextCursor: Maybe<Scalars["String"]["output"]>;
}

export enum SearchSortBy {
  Relevance = "Relevance",
  UpdatedAt = "UpdatedAt",
}

/** Anchors a comment to a text range inside a document block. */
export interface SelectionAnchorInput {
  /** Character offset of the anchor end within the block. */
  end?: InputMaybe<Scalars["Int"]["input"]>;
  /** Text immediately before the quote (for disambiguation). */
  prefix?: InputMaybe<Scalars["String"]["input"]>;
  /** Quoted text the comment is anchored to. */
  quote: Scalars["String"]["input"];
  /** Character offset of the anchor start within the block. */
  start?: InputMaybe<Scalars["Int"]["input"]>;
  /** Text immediately after the quote (for disambiguation). */
  suffix?: InputMaybe<Scalars["String"]["input"]>;
}

/** Selection mode for a workspace template policy. */
export enum SelectionModeType {
  PinnedRevision = "PinnedRevision",
  Published = "Published",
}

/**
 * Client configuration exposed in serverConfig.
 * Values are set through the canonical Admin config contract and read by Web.
 */
export interface ServerClientConfigType {
  __typename?: "ServerClientConfigType";
  /**
   * Allow the web editor to fall back to the `execCommand('copy'/'paste')`
   * API when the Clipboard API is unavailable (e.g. HTTP without HTTPS).
   * Set to true if the instance is intentionally served over plain HTTP
   * behind a trusted reverse proxy.
   */
  clipboardHttpFallback: Scalars["Boolean"]["output"];
  /**
   * Operator-configured app download URL. Empty string means
   * "use BUILD_CONFIG.downloadUrl from the frontend build".
   */
  downloadUrl: Scalars["String"]["output"];
}

/**
 * Top-level server configuration object returned by `serverConfig` query.
 *
 * Provides version, feature flags, and OAuth provider list used by the web
 * client to configure itself at startup.
 */
export interface ServerConfigType {
  __typename?: "ServerConfigType";
  availableUpgrade: Maybe<ReleaseVersionType>;
  availableUserFeatures: Array<FeatureType>;
  availableWorkspaceFeatures: Array<FeatureType>;
  baseUrl: Scalars["String"]["output"];
  calendarCalDAVProviders: Array<CalendarCalDavProviderPresetObjectType>;
  calendarProviders: Array<CalendarProviderType>;
  /** Client settings (admin-configurable). Includes the operator-set download URL. */
  client: ServerClientConfigType;
  credentialsRequirement: CredentialsRequirementType;
  deploymentType: ServerDeploymentType;
  features: Array<ServerFeature>;
  flavor: Scalars["String"]["output"];
  /**
   * Git Sync policy configuration. Added in 0.30 — older clients that
   * don't query this field are unaffected (GraphQL ignores unqueried fields).
   */
  gitSync: ServerGitSyncConfig;
  /**
   * i18n settings (admin-configurable). The web frontend reads `availableLocales` at startup
   * to restrict the language selector to admin-permitted locales.
   */
  i18n: ServerI18NConfigType;
  initialized: Scalars["Boolean"]["output"];
  /**
   * Journal settings (admin-configurable). The web frontend reads these
   * at startup to set firstDayOfWeek and showCalendarWeeks.
   */
  journal: ServerJournalConfigType;
  name: Scalars["String"]["output"];
  oauthProviders: Array<OAuthProviderType>;
  /**
   * Public request-lifecycle budgets for the private preview consumer. All
   * renderer and cache limits remain operator-private.
   */
  preview: ServerPreviewClientConfigType;
  /**
   * Capability is resolved outside the cached serverConfig value so a live
   * config change or observed service failure cannot leave stale readiness.
   */
  transcription: TranscriptionCapabilityType;
  /**
   * Legacy `type` field — alias for `deploymentType` as a string.
   * The web client queries this field by name; `type` is a Rust keyword
   * so we expose it via the graphql rename attribute.
   */
  type: Scalars["String"]["output"];
  version: Scalars["String"]["output"];
}

/**
 * Identifies the server deployment model.
 *
 * This enum value is returned to clients via `serverConfig.deploymentType`.
 * Clients branch on this value to control socket transport (polling+WS vs
 * WS-only), telemetry transport (HTTP vs WebSocket), admin UI module
 * visibility, sign-in flow guards and desktop invite dialogs.
 *
 * The GraphQL wire values deliberately use the same Myoxus vocabulary as
 * the Rust model and operator configuration: `Cloud` / `Standalone`.
 */
export enum ServerDeploymentType {
  /**
   * Managed cloud deployment (Myoxus SaaS).
   * Client effects: WS-only transport, WS telemetry, cloud UI modules.
   */
  Cloud = "Cloud",
  /**
   * Standalone on-premise deployment.
   * Client effects: polling+WS transport, HTTP telemetry, standalone UI.
   */
  Standalone = "Standalone",
}

/** Info about a server-managed directory (storage, logs, git-sync repos, etc.). */
export interface ServerDirectory {
  __typename?: "ServerDirectory";
  /** Total capacity of the partition in bytes (0 if not exists). */
  capacityBytes: Scalars["Int"]["output"];
  /** Number of immediate subdirectories under this path (0 if not exists). */
  entryCount: Scalars["Int"]["output"];
  /** Whether the directory currently exists. */
  exists: Scalars["Boolean"]["output"];
  /** Free bytes on the filesystem partition containing this path (0 if not exists). */
  freeBytes: Scalars["Int"]["output"];
  /** Human-readable name, e.g. "Blob Storage". */
  name: Scalars["String"]["output"];
  /** Absolute path on the server filesystem. */
  path: Scalars["String"]["output"];
  /** Total size of all files under this directory in bytes (0 if not exists). */
  totalBytes: Scalars["Int"]["output"];
}

/** Optional server capabilities advertised to clients. */
export enum ServerFeature {
  /** CAPTCHA challenge is enabled on auth endpoints. */
  Captcha = "Captcha",
  /** Document commenting is enabled (always true in Myoxus). */
  Comment = "Comment",
  /** Copilot AI integration is enabled. */
  Copilot = "Copilot",
  /** Copilot embedding store is available (pgvector). */
  CopilotEmbedding = "CopilotEmbedding",
  /** Full-text search indexer is active (Postgres FTS + pgvector). */
  Indexer = "Indexer",
  /** Local-first Yjs workspaces are supported (always true in Myoxus). */
  LocalWorkspace = "LocalWorkspace",
  /** OAuth social login is configured. */
  OAuth = "OAuth",
  /** Payment/billing is enabled (always `false` in Myoxus). */
  Payment = "Payment",
}

/**
 * Git Sync policy configuration exposed in serverConfig.
 * All fields are read-only for non-admin users — the admin changes
 * these values through the canonical Admin config mutation.
 */
export interface ServerGitSyncConfig {
  __typename?: "ServerGitSyncConfig";
  /** Which auth methods users can choose. */
  allowedAuthMethods: Array<Scalars["String"]["output"]>;
  /** Which sync directions are available to users. */
  allowedDirections: Array<Scalars["String"]["output"]>;
  /** Whether automatic sync (polling/on-change) is available. */
  autoSyncAllowed: Scalars["Boolean"]["output"];
  /** Default branch pre-filled in profile forms. */
  defaultBranch: Scalars["String"]["output"];
  /** Master switch: when false, Git Sync UI is hidden from all users. */
  enabled: Scalars["Boolean"]["output"];
  /** Maximum total disk space (MB) for git mirror repositories (global setting). */
  maxMirrorStorageMb: Scalars["Int"]["output"];
  /** SSH host-key verification policy used by server-side Git transports. */
  sshHostKeyPolicy: Scalars["String"]["output"];
  /** Whether webhook-triggered sync is available. */
  webhookAllowed: Scalars["Boolean"]["output"];
}

/**
 * i18n configuration exposed in serverConfig.
 * Allows the web frontend to show only the locales permitted by the admin.
 */
export interface ServerI18NConfigType {
  __typename?: "ServerI18NConfigType";
  /**
   * List of locale codes available for the web frontend language selector.
   * An empty list means "all supported locales are available".
   */
  availableLocales: Array<Scalars["String"]["output"]>;
  /** Default locale for new users / first visit. */
  defaultLocale: Scalars["String"]["output"];
}

/**
 * Journal configuration exposed in serverConfig.
 * Admin paths are `journal.first_day_of_week` and
 * `journal.show_calendar_weeks`; GraphQL retains its camel-case field names.
 */
export interface ServerJournalConfigType {
  __typename?: "ServerJournalConfigType";
  /** First day of the week: "monday" or "sunday". */
  firstDayOfWeek: Scalars["String"]["output"];
  /** Whether to show ISO calendar week numbers in the journal month view. */
  showCalendarWeeks: Scalars["Boolean"]["output"];
}

export interface ServerPreviewClientConfigType {
  __typename?: "ServerPreviewClientConfigType";
  /** Browser requests share the existing effective per-actor render budget. */
  maxConcurrentRequests: Scalars["Int"]["output"];
  requestTimeoutMs: Scalars["Int"]["output"];
  retryCount: Scalars["Int"]["output"];
}

/** Locale-neutral operational finding. Clients own visible translations. */
export interface ServerSetupFindingType {
  __typename?: "ServerSetupFindingType";
  code: Scalars["String"]["output"];
  severity: Scalars["String"]["output"];
}

/** Persisted wizard completion and current operational readiness. */
export interface ServerSetupStatusType {
  __typename?: "ServerSetupStatusType";
  authMethods: Array<AuthMethodCapabilityType>;
  bootstrapAvailable: Scalars["Boolean"]["output"];
  findings: Array<ServerSetupFindingType>;
  /**
   * Compatibility alias for clients predating setup/readiness separation.
   * @deprecated use setupCompleted
   */
  isConfigured: Scalars["Boolean"]["output"];
  /**
   * Compatibility code projection; new clients should consume findings.
   * @deprecated use findings
   */
  missingCritical: Array<Scalars["String"]["output"]>;
  operationalReady: Scalars["Boolean"]["output"];
  setupCompleted: Scalars["Boolean"]["output"];
  /**
   * Compatibility code projection; new clients should consume findings.
   * @deprecated use findings
   */
  warnings: Array<Scalars["String"]["output"]>;
}

/**
 * Privacy-scoped user record returned by the `serverUsers` search query.
 *
 * Intentionally limited to non-sensitive fields — no email, no admin flag.
 * Used by the workspace invitation UI to search for users to invite.
 */
export interface ServerUserSearchResult {
  __typename?: "ServerUserSearchResult";
  avatarUrl: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
}

export interface SetColorSchemaValuesInput {
  colors: Array<ColorSchemaValuePatchInput>;
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface SetDatabaseRowReminderInput {
  databaseId: Scalars["ID"]["input"];
  fieldId: Scalars["ID"]["input"];
  offsetMinutes: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface SetDocumentMetadataInput {
  audienceIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  classificationId?: InputMaybe<Scalars["ID"]["input"]>;
  documentNumber?: InputMaybe<Scalars["String"]["input"]>;
  documentTypeId?: InputMaybe<Scalars["ID"]["input"]>;
  edgelessColorTheme?: InputMaybe<Scalars["String"]["input"]>;
  expectedMetadataRevision?: InputMaybe<Scalars["Int"]["input"]>;
  integrationType?: InputMaybe<Scalars["String"]["input"]>;
  journalDate?: InputMaybe<Scalars["String"]["input"]>;
  languageId?: InputMaybe<Scalars["ID"]["input"]>;
  pageWidth?: InputMaybe<Scalars["String"]["input"]>;
  primaryMode?: InputMaybe<Scalars["String"]["input"]>;
  responsibleUserId?: InputMaybe<Scalars["ID"]["input"]>;
  retentionPolicyId?: InputMaybe<Scalars["ID"]["input"]>;
  reviewDueAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  templateCategory?: InputMaybe<Scalars["String"]["input"]>;
  templateId?: InputMaybe<Scalars["ID"]["input"]>;
  templateInstanceId?: InputMaybe<Scalars["ID"]["input"]>;
  templateOrigin?: InputMaybe<Scalars["String"]["input"]>;
  templateRevisionId?: InputMaybe<Scalars["ID"]["input"]>;
  templateState?: InputMaybe<Scalars["String"]["input"]>;
  templateTags?: InputMaybe<Array<Scalars["String"]["input"]>>;
  validFrom?: InputMaybe<Scalars["DateTime"]["input"]>;
  validUntil?: InputMaybe<Scalars["DateTime"]["input"]>;
}

export interface SetDocumentMetadataPayload {
  __typename?: "SetDocumentMetadataPayload";
  metadata: DocumentMetadataType;
}

export interface SetDocumentWorkspaceTagsInput {
  /**
   * Explicit same-workspace duplication: tagIds must equal this readable
   * source's current ordered assignment; its archived references are retained.
   * Omit for ordinary complete replacement and its unchanged archive rules.
   */
  copyFromDocId?: InputMaybe<Scalars["ID"]["input"]>;
  docId: Scalars["ID"]["input"];
  tagIds: Array<Scalars["ID"]["input"]>;
  workspaceId: Scalars["ID"]["input"];
}

export interface SetPersonalWorkspaceThemeInput {
  themeSlug: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

/** Input for `setTemplateDefaultPolicy` (admin). */
export interface SetTemplateDefaultPolicyInput {
  applyToNewWorkspaces: Scalars["Boolean"]["input"];
  provisioningMode: ProvisioningModeType;
  selectionMode: SelectionModeType;
  templateId: Scalars["String"]["input"];
}

export interface SetThemeProfileInput {
  themeMode: Scalars["String"]["input"];
  themeSlug: Scalars["String"]["input"];
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface SetTypographyStylesInput {
  styles: Array<TypographyStylePatchInput>;
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

/** Input for `setWorkspaceTemplateOverride`. */
export interface SetWorkspaceTemplateOverrideInput {
  isEnabled: Scalars["Boolean"]["input"];
  provisioningMode?: InputMaybe<ProvisioningModeType>;
  templateId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

export interface SkipTaskRecurrenceInput {
  expectedRevision: Scalars["Int"]["input"];
  expectedRowRevision: Scalars["Int"]["input"];
  expectedStatusRevision: Scalars["Int"]["input"];
  memberId: Scalars["ID"]["input"];
  seriesId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export enum SortDirection {
  Asc = "Asc",
  Desc = "Desc",
}

export interface SpaceAccessDeniedDataType {
  __typename?: "SpaceAccessDeniedDataType";
  spaceId: Scalars["String"]["output"];
}

export interface SpaceNotFoundDataType {
  __typename?: "SpaceNotFoundDataType";
  spaceId: Scalars["String"]["output"];
}

export interface SpaceOwnerNotFoundDataType {
  __typename?: "SpaceOwnerNotFoundDataType";
  spaceId: Scalars["String"]["output"];
}

export interface SpaceShouldHaveOnlyOneOwnerDataType {
  __typename?: "SpaceShouldHaveOnlyOneOwnerDataType";
  spaceId: Scalars["String"]["output"];
}

export interface SsrfBlockedErrorDataType {
  __typename?: "SsrfBlockedErrorDataType";
  message: Scalars["String"]["output"];
}

export interface StartDocumentReviewInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  planDigest: Scalars["String"]["input"];
  requestId: Scalars["ID"]["input"];
  target: ContextDocumentTargetInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface StartTaskHandoverInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  planDigest: Scalars["String"]["input"];
  requestId: Scalars["ID"]["input"];
  target: ContextDocumentTargetInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface StartTaskMaintenanceInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  identity: AssistantPackageIdentityInput;
  locale: Scalars["String"]["input"];
  planDigest: Scalars["String"]["input"];
  requestId: Scalars["ID"]["input"];
  target: ContextDocumentTargetInput;
  workspaceId: Scalars["ID"]["input"];
}

export interface StopContextDocumentsInput {
  requestId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface StopProjectSetupInput {
  requestId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface StopWorkspaceCreationInput {
  requestId: Scalars["ID"]["input"];
}

/** Global storage quota defaults from server configuration (admin-only). */
export interface StorageQuotaConfigType {
  __typename?: "StorageQuotaConfigType";
  /** Default workspace storage quota in MB. 0 = unlimited. */
  defaultWorkspaceQuotaMb: Scalars["Int"]["output"];
}

/** A single event in a Copilot streaming response. */
export interface StreamObject {
  __typename?: "StreamObject";
  args: Maybe<Scalars["JSON"]["output"]>;
  result: Maybe<Scalars["JSON"]["output"]>;
  textDelta: Maybe<Scalars["String"]["output"]>;
  toolCallId: Maybe<Scalars["String"]["output"]>;
  toolName: Maybe<Scalars["String"]["output"]>;
  type: Scalars["String"]["output"];
}

export interface SubscriptionAlreadyExistsDataType {
  __typename?: "SubscriptionAlreadyExistsDataType";
  message: Scalars["String"]["output"];
}

export interface SubscriptionNotExistsDataType {
  __typename?: "SubscriptionNotExistsDataType";
  message: Scalars["String"]["output"];
}

export interface SubscriptionPlanNotFoundDataType {
  __typename?: "SubscriptionPlanNotFoundDataType";
  message: Scalars["String"]["output"];
}

export enum SubscriptionPlanType {
  AI = "AI",
  Enterprise = "Enterprise",
  Free = "Free",
  Pro = "Pro",
  SelfHosted = "SelfHosted",
  SelfHostedTeam = "SelfHostedTeam",
  Team = "Team",
}

export interface SubscriptionPriceType {
  __typename?: "SubscriptionPriceType";
  amount: Maybe<Scalars["Int"]["output"]>;
  currency: Scalars["String"]["output"];
  lifetimeAmount: Maybe<Scalars["Int"]["output"]>;
  plan: SubscriptionPlanType;
  type: Scalars["String"]["output"];
  yearlyAmount: Maybe<Scalars["Int"]["output"]>;
}

export enum SubscriptionRecurringType {
  Lifetime = "Lifetime",
  Monthly = "Monthly",
  Yearly = "Yearly",
}

export enum SubscriptionStatusType {
  Active = "Active",
  Canceled = "Canceled",
  Incomplete = "Incomplete",
  IncompleteExpired = "IncompleteExpired",
  PastDue = "PastDue",
  Paused = "Paused",
  Trialing = "Trialing",
  Unpaid = "Unpaid",
}

export interface SubscriptionType {
  __typename?: "SubscriptionType";
  canceledAt: Maybe<Scalars["DateTime"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  end: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["String"]["output"];
  nextBillAt: Maybe<Scalars["DateTime"]["output"]>;
  plan: SubscriptionPlanType;
  recurring: SubscriptionRecurringType;
  start: Scalars["DateTime"]["output"];
  status: SubscriptionStatusType;
  updatedAt: Scalars["DateTime"]["output"];
  variant: Maybe<SubscriptionVariantType>;
}

export enum SubscriptionVariantType {
  EA = "EA",
  Onetime = "Onetime",
}

export interface TaskContentFinding {
  __typename?: "TaskContentFinding";
  fieldId: Scalars["ID"]["output"];
  kind: TaskContentFindingKind;
  task: AssistantTaskReference;
}

export enum TaskContentFindingKind {
  AssignmentSuggestion = "AssignmentSuggestion",
  DueBeforeStart = "DueBeforeStart",
  ReferenceUnavailable = "ReferenceUnavailable",
  RequiredValueMissing = "RequiredValueMissing",
}

export interface TaskCorrectionConfirmation {
  __typename?: "TaskCorrectionConfirmation";
  acceptedAt: Scalars["DateTime"]["output"];
  outcome: TaskCorrectionOutcome;
  proposalDigest: Scalars["String"]["output"];
  requestId: Scalars["ID"]["output"];
  waitId: Scalars["String"]["output"];
}

export enum TaskCorrectionOutcome {
  Apply = "Apply",
  Decline = "Decline",
}

export interface TaskCorrectionPatch {
  __typename?: "TaskCorrectionPatch";
  clear: Scalars["Boolean"]["output"];
  expectedEditRevision: Scalars["Int"]["output"];
  fieldId: Scalars["ID"]["output"];
  oldValue: Maybe<DatabaseCellValueDataType>;
  rowId: Scalars["ID"]["output"];
  value: Maybe<DatabaseCellValueDataType>;
}

export interface TaskCorrectionProposal {
  __typename?: "TaskCorrectionProposal";
  actorId: Scalars["ID"]["output"];
  databaseId: Scalars["ID"]["output"];
  digest: Scalars["String"]["output"];
  findings: Array<TaskContentFinding>;
  patches: Array<TaskCorrectionPatch>;
  rowPreconditions: Array<TaskCorrectionRowPrecondition>;
  tasks: Array<AssistantTaskReference>;
  workspaceId: Scalars["ID"]["output"];
}

export interface TaskCorrectionRowPrecondition {
  __typename?: "TaskCorrectionRowPrecondition";
  expectedEditRevision: Scalars["Int"]["output"];
  rowId: Scalars["ID"]["output"];
}

export interface TaskHandover {
  __typename?: "TaskHandover";
  acceptedDescriptor: Maybe<AssistantPackage>;
  acceptedPlan: PreparedTaskHandover;
  canRetry: Scalars["Boolean"]["output"];
  canStop: Scalars["Boolean"]["output"];
  prerequisites: Array<TaskHandoverPrerequisite>;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  resultAvailable: Scalars["Boolean"]["output"];
  resultTask: Maybe<AssistantTaskReference>;
  resultTaskId: Scalars["ID"]["output"];
  run: WorkspaceAutomationRunType;
  sourceAvailable: Scalars["Boolean"]["output"];
}

export interface TaskHandoverPrerequisite {
  __typename?: "TaskHandoverPrerequisite";
  available: Scalars["Boolean"]["output"];
  complete: Scalars["Boolean"]["output"];
  reference: AssistantTaskReference;
  title: Maybe<Scalars["String"]["output"]>;
}

export interface TaskHandoverRunInput {
  runId: Scalars["ID"]["input"];
}

export interface TaskMaintenance {
  __typename?: "TaskMaintenance";
  acceptedDescriptor: Maybe<AssistantPackage>;
  acceptedPlan: PreparedTaskMaintenance;
  canApply: Scalars["Boolean"]["output"];
  canConfirm: Scalars["Boolean"]["output"];
  canDecline: Scalars["Boolean"]["output"];
  canRetry: Scalars["Boolean"]["output"];
  canStop: Scalars["Boolean"]["output"];
  confirmation: Maybe<TaskCorrectionConfirmation>;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  requestId: Scalars["ID"]["output"];
  run: WorkspaceAutomationRunType;
  waitId: Scalars["String"]["output"];
}

export interface TaskMaintenanceRunInput {
  runId: Scalars["ID"]["input"];
}

export interface TaskPreparationConfiguration {
  __typename?: "TaskPreparationConfiguration";
  actorId: Scalars["ID"]["output"];
  answers: Array<AssistantNamedValue>;
  clientVersion: Scalars["Int"]["output"];
  databaseId: Scalars["ID"]["output"];
  executionRevision: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  locale: Scalars["String"]["output"];
  package: AssistantPackageIdentity;
  planDigest: Scalars["String"]["output"];
  source: Maybe<TaskPreparationSource>;
  status: WorkspaceAutomationStatus;
  workspaceId: Scalars["ID"]["output"];
}

export interface TaskPreparationRun {
  __typename?: "TaskPreparationRun";
  canRetry: Scalars["Boolean"]["output"];
  canStop: Scalars["Boolean"]["output"];
  documentExternalId: Maybe<Scalars["String"]["output"]>;
  documentId: Maybe<Scalars["ID"]["output"]>;
  run: WorkspaceAutomationRunType;
  target: AssistantTaskReference;
}

export interface TaskPreparationSource {
  __typename?: "TaskPreparationSource";
  locale: Scalars["String"]["output"];
  source: AssistantDocumentComponentSource;
  sourceContentDigest: Scalars["String"]["output"];
  sourceRevisionDigest: Scalars["String"]["output"];
  sourceRevisionId: Scalars["ID"]["output"];
  title: Scalars["String"]["output"];
  variables: Array<TaskPreparationVariable>;
}

export interface TaskPreparationVariable {
  __typename?: "TaskPreparationVariable";
  name: Scalars["String"]["output"];
  value: Scalars["String"]["output"];
}

export interface TaskRecurrence {
  __typename?: "TaskRecurrence";
  actorId: Maybe<Scalars["ID"]["output"]>;
  blockedReason: Maybe<Scalars["String"]["output"]>;
  currentMemberId: Maybe<Scalars["ID"]["output"]>;
  effectiveAfter: Maybe<TaskRecurrenceMember>;
  generation: Scalars["Int"]["output"];
  id: Scalars["ID"]["output"];
  lifecycle: RecurrenceLifecycle;
  members: Array<TaskRecurrenceMember>;
  next: Maybe<RecurrenceOccurrence>;
  pausedAt: Maybe<Scalars["DateTime"]["output"]>;
  pending: Maybe<RecurrenceOccurrence>;
  preservedNext: Maybe<TaskRecurrenceMember>;
  recipe: TaskRecurrenceRecipe;
  revision: Scalars["Int"]["output"];
  rule: RecurrenceRule;
  workspaceId: Scalars["ID"]["output"];
}

export interface TaskRecurrenceControlInput {
  expectedRevision: Scalars["Int"]["input"];
  seriesId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export type TaskRecurrenceLookupInput =
  | { rowId: Scalars["ID"]["input"]; seriesId?: never }
  | { rowId?: never; seriesId: Scalars["ID"]["input"] };

export interface TaskRecurrenceMember {
  __typename?: "TaskRecurrenceMember";
  advanceKind: Maybe<Scalars["String"]["output"]>;
  advancedAt: Maybe<Scalars["DateTime"]["output"]>;
  capturedDatabaseId: Scalars["ID"]["output"];
  id: Scalars["ID"]["output"];
  occurrenceId: Maybe<Scalars["ID"]["output"]>;
  rowId: Scalars["ID"]["output"];
  slot: Maybe<RecurrenceOccurrence>;
  successorOccurrenceId: Maybe<Scalars["ID"]["output"]>;
}

export interface TaskRecurrenceRecipe {
  __typename?: "TaskRecurrenceRecipe";
  assignees: Array<Scalars["ID"]["output"]>;
  databaseId: Scalars["ID"]["output"];
  description: Maybe<DatabaseRichTextCellValueType>;
  priority: Maybe<Scalars["String"]["output"]>;
  title: Scalars["String"]["output"];
}

export interface TaskRecurrenceRecipeInput {
  assignees: Array<Scalars["ID"]["input"]>;
  databaseId: Scalars["ID"]["input"];
  /** Use the native document-only input; its plain-text projection is server-owned. */
  description?: InputMaybe<DatabaseRichTextCellValueInput>;
  priority?: InputMaybe<Scalars["String"]["input"]>;
  title: Scalars["String"]["input"];
}

/** A template catalog entry as exposed via GraphQL. */
export interface TemplateCatalogEntryType {
  __typename?: "TemplateCatalogEntryType";
  archivedAt: Maybe<Scalars["DateTime"]["output"]>;
  builderVersion: Maybe<Scalars["Int"]["output"]>;
  category: Maybe<Scalars["String"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  minClientVersion: Scalars["Int"]["output"];
  slug: Scalars["String"]["output"];
  source: TemplateSourceType;
  status: TemplateStatusType;
  tags: Array<Scalars["String"]["output"]>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface TemplateCatalogViewInput {
  view: Scalars["String"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface TemplateCatalogViewType {
  __typename?: "TemplateCatalogViewType";
  view: Scalars["String"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

/** A template default policy as exposed via GraphQL. */
export interface TemplateDefaultPolicyType {
  __typename?: "TemplateDefaultPolicyType";
  applyToNewWorkspaces: Scalars["Boolean"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  provisioningMode: ProvisioningModeType;
  selectionMode: SelectionModeType;
  /** Template catalog entry ID this policy applies to. */
  templateId: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface TemplateGuideDelivery {
  __typename?: "TemplateGuideDelivery";
  documentId: Maybe<Scalars["ID"]["output"]>;
  pending: Scalars["Boolean"]["output"];
  slug: Scalars["String"]["output"];
}

/** Result of a template bundle import. */
export interface TemplateImportResultType {
  __typename?: "TemplateImportResultType";
  /** Detected input format (`myoxus_bundle`, `upstream_snapshot_zip`, ...). */
  detectedFormat: Scalars["String"]["output"];
  /** Actual persisted children; a package never creates a synthetic entry. */
  documents: Array<TemplateImportedDocumentType>;
  /** Single-document catalog entry; packages expose their actual children. */
  entry: Maybe<TemplateCatalogEntryType>;
  /**
   * Present when some child writes/publications failed. Persisted children
   * remain visible and importing the same package resumes idempotently.
   */
  error: Maybe<Scalars["String"]["output"]>;
  /** Version tag of the server-side template error catalog. */
  errorCatalogVersion: Scalars["String"]["output"];
  /** Number of ignored noisy ZIP entries (for example `__MACOSX/**`). */
  ignoredEntriesCount: Scalars["Int"]["output"];
  jobId: Maybe<Scalars["ID"]["output"]>;
  /** Whether the import required normalization from a non-canonical input. */
  normalized: Scalars["Boolean"]["output"];
  package: Maybe<Scalars["JSON"]["output"]>;
  /** Single-document revision, validated through the existing import owner. */
  revision: Maybe<TemplateRevisionType>;
  /** Any validation warnings (non-fatal issues). */
  warnings: Array<ValidationErrorType>;
}

export interface TemplateImportedDocumentType {
  __typename?: "TemplateImportedDocumentType";
  entry: TemplateCatalogEntryType;
  revision: TemplateRevisionType;
}

/** Job type discriminator (import vs reconcile). */
export enum TemplateJobKind {
  Import = "Import",
  Reconcile = "Reconcile",
}

/** Unified view of template import and reconcile jobs. */
export interface TemplateJobType {
  __typename?: "TemplateJobType";
  finishedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  jobType: TemplateJobKind;
  startedAt: Maybe<Scalars["DateTime"]["output"]>;
  state: JobStateType;
  summaryJson: Maybe<Scalars["String"]["output"]>;
  templateId: Maybe<Scalars["String"]["output"]>;
  workspaceId: Maybe<Scalars["String"]["output"]>;
}

export interface TemplateLibraryFilterInput {
  kind?: InputMaybe<TemplateLibraryKind>;
  origin?: InputMaybe<TemplateLibraryOrigin>;
  search?: InputMaybe<Scalars["String"]["input"]>;
  sort?: InputMaybe<TemplateLibrarySort>;
  /** Exact workspace-local source key; returns at most one item, without list traversal. */
  sourceDocId?: InputMaybe<Scalars["ID"]["input"]>;
  workAreaTag?: InputMaybe<Scalars["String"]["input"]>;
}

export enum TemplateLibraryKind {
  BuildingBlock = "BuildingBlock",
  Document = "Document",
}

export enum TemplateLibraryOrigin {
  Builtin = "Builtin",
  Custom = "Custom",
  Imported = "Imported",
  Unknown = "Unknown",
}

export enum TemplateLibrarySort {
  NameAsc = "NameAsc",
  NameDesc = "NameDesc",
  UpdatedAsc = "UpdatedAsc",
  UpdatedDesc = "UpdatedDesc",
}

export interface TemplatePageDefaultReplacement {
  __typename?: "TemplatePageDefaultReplacement";
  replacementSourceDocId: Maybe<Scalars["ID"]["output"]>;
  retiredSourceDocId: Scalars["ID"]["output"];
}

/** A template revision as exposed via GraphQL. */
export interface TemplateRevisionType {
  __typename?: "TemplateRevisionType";
  checksum: Maybe<Scalars["String"]["output"]>;
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  /** File-owned locale, title and purpose metadata of this immutable revision. */
  manifest: Maybe<Scalars["JSON"]["output"]>;
  publishedAt: Maybe<Scalars["DateTime"]["output"]>;
  releaseNotes: Maybe<Scalars["String"]["output"]>;
  state: RevisionStateType;
  templateId: Scalars["ID"]["output"];
  version: Scalars["String"]["output"];
}

/** Template source discriminator. */
export enum TemplateSourceType {
  Builtin = "Builtin",
  Bundle = "Bundle",
}

/** Template catalog entry status as a GraphQL enum. */
export enum TemplateStatusType {
  Active = "Active",
  Archived = "Archived",
  Disabled = "Disabled",
}

export interface TemplateSuggestionInput {
  after?: InputMaybe<Scalars["String"]["input"]>;
  classificationId?: InputMaybe<Scalars["ID"]["input"]>;
  clientVersion: Scalars["Int"]["input"];
  collectionId?: InputMaybe<Scalars["ID"]["input"]>;
  currentDocId?: InputMaybe<Scalars["ID"]["input"]>;
  documentTypeId?: InputMaybe<Scalars["ID"]["input"]>;
  /** Library pages default to and allow 200 items; contextual pickers default to eight (maximum 20). */
  first?: InputMaybe<Scalars["Int"]["input"]>;
  /** Filters and SQL ordering for Library only; omitted for contextual suggestions. */
  library?: InputMaybe<TemplateLibraryFilterInput>;
  locale: Scalars["String"]["input"];
  mode?: InputMaybe<Scalars["String"]["input"]>;
  statusId?: InputMaybe<Scalars["ID"]["input"]>;
  surface: TemplateSuggestionSurface;
}

export interface TemplateSuggestionItem {
  __typename?: "TemplateSuggestionItem";
  available: Scalars["Boolean"]["output"];
  category: Maybe<Scalars["String"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  instanceState: Maybe<Scalars["String"]["output"]>;
  protectedSource: Scalars["Boolean"]["output"];
  reasons: Array<TemplateSuggestionReason>;
  score: Scalars["Int"]["output"];
  slug: Scalars["String"]["output"];
  source: Scalars["String"]["output"];
  sourceRevisionId: Maybe<Scalars["ID"]["output"]>;
  tags: Array<Scalars["String"]["output"]>;
  templateDocId: Maybe<Scalars["ID"]["output"]>;
  templateId: Scalars["ID"]["output"];
  title: Scalars["String"]["output"];
  titlePolicy: Maybe<Scalars["String"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
}

export enum TemplateSuggestionReason {
  AccessDenied = "AccessDenied",
  DefaultPolicy = "DefaultPolicy",
  Detached = "Detached",
  IncompatibleClient = "IncompatibleClient",
  InstanceError = "InstanceError",
  InstanceOk = "InstanceOk",
  MetadataClassification = "MetadataClassification",
  MetadataDocumentType = "MetadataDocumentType",
  MetadataStatus = "MetadataStatus",
  Preparing = "Preparing",
  ReconcileRequired = "ReconcileRequired",
  Redacted = "Redacted",
  RetryableFailure = "RetryableFailure",
  SourceMissing = "SourceMissing",
  SurfaceCategory = "SurfaceCategory",
  UpdateAvailable = "UpdateAvailable",
  WorkspacePolicy = "WorkspacePolicy",
}

export interface TemplateSuggestionResult {
  __typename?: "TemplateSuggestionResult";
  emptyDocumentAllowed: Scalars["Boolean"]["output"];
  endCursor: Maybe<Scalars["String"]["output"]>;
  guideDeliveries: Array<TemplateGuideDelivery>;
  hasNextPage: Scalars["Boolean"]["output"];
  items: Array<TemplateSuggestionItem>;
  pageDefaultReplacements: Array<TemplatePageDefaultReplacement>;
  reconcileRequired: Scalars["Boolean"]["output"];
  stale: Scalars["Boolean"]["output"];
}

export enum TemplateSuggestionSurface {
  AllPagesNewPage = "AllPagesNewPage",
  BuildingBlock = "BuildingBlock",
  CollectionNewPage = "CollectionNewPage",
  DatabaseRowTemplate = "DatabaseRowTemplate",
  JournalOnboarding = "JournalOnboarding",
  JournalSidebarFooter = "JournalSidebarFooter",
  Library = "Library",
  SidebarNewPage = "SidebarNewPage",
  StarterBar = "StarterBar",
}

export interface ThemeCatalogType {
  __typename?: "ThemeCatalogType";
  catalogHash: Scalars["String"]["output"];
  fontFamilies: Array<ThemeFontFamilyType>;
  themes: Array<ThemeDefinitionType>;
}

export interface ThemeDefinitionType {
  __typename?: "ThemeDefinitionType";
  category: Maybe<Scalars["String"]["output"]>;
  colorSchemaSlug: Scalars["String"]["output"];
  colors: Scalars["JSON"]["output"];
  descriptionKey: Maybe<Scalars["String"]["output"]>;
  isDefault: Scalars["Boolean"]["output"];
  locked: Scalars["Boolean"]["output"];
  name: Scalars["String"]["output"];
  origin: Scalars["String"]["output"];
  previewGroup: Maybe<Scalars["String"]["output"]>;
  previewOrder: Scalars["Int"]["output"];
  slug: Scalars["String"]["output"];
  taglineKey: Maybe<Scalars["String"]["output"]>;
  typographySlug: Scalars["String"]["output"];
  typographyStyles: Array<ThemeTypographyStyleType>;
}

export interface ThemeFontAssetType {
  __typename?: "ThemeFontAssetType";
  assetKey: Scalars["String"]["output"];
  format: Scalars["String"]["output"];
  mime: Scalars["String"]["output"];
  sha256: Scalars["String"]["output"];
  style: Scalars["String"]["output"];
  subsetTags: Array<Scalars["String"]["output"]>;
  unicodeRanges: Array<Scalars["String"]["output"]>;
  usage: Scalars["String"]["output"];
  weightDefault: Scalars["Int"]["output"];
  weightMax: Scalars["Int"]["output"];
  weightMin: Scalars["Int"]["output"];
}

export interface ThemeFontFamilyType {
  __typename?: "ThemeFontFamilyType";
  assets: Array<ThemeFontAssetType>;
  cssFamily: Scalars["String"]["output"];
  displayName: Scalars["String"]["output"];
  genericClass: Scalars["String"]["output"];
  isSelectable: Scalars["Boolean"]["output"];
  licenseSpdx: Scalars["String"]["output"];
  licenseStatus: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
  source: Scalars["String"]["output"];
}

export interface ThemeProfileType {
  __typename?: "ThemeProfileType";
  scope: Scalars["String"]["output"];
  theme: ThemeDefinitionType;
  themeMode: Scalars["String"]["output"];
  workspaceId: Maybe<Scalars["ID"]["output"]>;
}

export interface ThemeTypographyStyleType {
  __typename?: "ThemeTypographyStyleType";
  cssFamily: Scalars["String"]["output"];
  decoration: Maybe<Scalars["String"]["output"]>;
  fontFamily: Scalars["String"]["output"];
  fontFamilySlug: Scalars["String"]["output"];
  fontFeatures: Scalars["JSON"]["output"];
  fontStyle: Scalars["String"]["output"];
  fontVariations: Scalars["JSON"]["output"];
  fontWeight: Scalars["Int"]["output"];
  hoverDecoration: Maybe<Scalars["String"]["output"]>;
  letterSpacingEm: Maybe<Scalars["Float"]["output"]>;
  lineHeight: Maybe<Scalars["Float"]["output"]>;
  pdfRole: Maybe<Scalars["String"]["output"]>;
  sizePx: Maybe<Scalars["Float"]["output"]>;
  styleKey: Scalars["String"]["output"];
  textTransform: Maybe<Scalars["String"]["output"]>;
}

/** Bucket granularity for time-windowed analytics. */
export enum TimeBucket {
  Day = "Day",
  Minute = "Minute",
}

export interface TimeWindow {
  __typename?: "TimeWindow";
  bucket: TimeBucket;
  effectiveSize: Scalars["Int"]["output"];
  from: Scalars["DateTime"]["output"];
  requestedSize: Scalars["Int"]["output"];
  timezone: Scalars["String"]["output"];
  to: Scalars["DateTime"]["output"];
}

export enum TranscriptionAvailability {
  Available = "Available",
  Disabled = "Disabled",
  NotChecked = "NotChecked",
  Unavailable = "Unavailable",
  Unconfigured = "Unconfigured",
}

export interface TranscriptionCapabilityType {
  __typename?: "TranscriptionCapabilityType";
  configured: Scalars["Boolean"]["output"];
  enabled: Scalars["Boolean"]["output"];
  maxDurationSeconds: Scalars["Int"]["output"];
  maxInputBytes: Scalars["Int"]["output"];
  status: TranscriptionAvailability;
}

export interface TranscriptionEnrichmentType {
  __typename?: "TranscriptionEnrichmentType";
  actions: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  status: AiJobStatus;
  summary: Maybe<Scalars["String"]["output"]>;
}

export interface TranscriptionItemType {
  __typename?: "TranscriptionItemType";
  end: Scalars["String"]["output"];
  speaker: Scalars["String"]["output"];
  start: Scalars["String"]["output"];
  transcription: Scalars["String"]["output"];
}

export interface TranscriptionResultType {
  __typename?: "TranscriptionResultType";
  actions: Maybe<Scalars["String"]["output"]>;
  /** Readable even with Copilot disabled. Readback never invokes a provider. */
  enrichment: Maybe<TranscriptionEnrichmentType>;
  /** Existing durable job failure; no client-specific error classification. */
  errorMessage: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  segments: Maybe<Array<TranscriptionSegmentType>>;
  status: AiJobStatus;
  summary: Maybe<Scalars["String"]["output"]>;
  text: Maybe<Scalars["String"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
  transcription: Maybe<Array<TranscriptionItemType>>;
}

/** Provider timing and speakers remain unknown when absent. */
export interface TranscriptionSegmentType {
  __typename?: "TranscriptionSegmentType";
  endSeconds: Maybe<Scalars["Float"]["output"]>;
  speaker: Maybe<Scalars["String"]["output"]>;
  startSeconds: Maybe<Scalars["Float"]["output"]>;
  text: Scalars["String"]["output"];
}

export interface TransitionDocumentStatusInput {
  createVersion?: InputMaybe<Scalars["Boolean"]["input"]>;
  toStatusId: Scalars["ID"]["input"];
}

export interface TransitionDocumentStatusPayload {
  __typename?: "TransitionDocumentStatusPayload";
  metadata: DocumentMetadataType;
  validation: DocumentMetadataValidationType;
}

export interface TypographyStylePatchInput {
  decoration?: InputMaybe<Scalars["String"]["input"]>;
  fontFamilySlug?: InputMaybe<Scalars["String"]["input"]>;
  fontFeatures?: InputMaybe<Scalars["JSON"]["input"]>;
  fontStyle?: InputMaybe<Scalars["String"]["input"]>;
  fontVariations?: InputMaybe<Scalars["JSON"]["input"]>;
  fontWeight?: InputMaybe<Scalars["Int"]["input"]>;
  hoverDecoration?: InputMaybe<Scalars["String"]["input"]>;
  letterSpacingEm?: InputMaybe<Scalars["Float"]["input"]>;
  lineHeight?: InputMaybe<Scalars["Float"]["input"]>;
  pdfRole?: InputMaybe<Scalars["String"]["input"]>;
  sizePx?: InputMaybe<Scalars["Float"]["input"]>;
  styleKey: Scalars["String"]["input"];
  textTransform?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UnknownOauthProviderDataType {
  __typename?: "UnknownOauthProviderDataType";
  message: Scalars["String"]["output"];
}

export interface UnsupportedClientVersionDataType {
  __typename?: "UnsupportedClientVersionDataType";
  message: Scalars["String"]["output"];
}

export interface UnsupportedSubscriptionPlanDataType {
  __typename?: "UnsupportedSubscriptionPlanDataType";
  message: Scalars["String"]["output"];
}

export interface UpdateAppConfigInput {
  key: Scalars["String"]["input"];
  module: Scalars["String"]["input"];
  value?: InputMaybe<Scalars["JSON"]["input"]>;
}

export interface UpdateAppServerBrandingInput {
  faviconPackAssetId?: InputMaybe<Scalars["ID"]["input"]>;
  logoAssetId?: InputMaybe<Scalars["ID"]["input"]>;
  productMarkAssetId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface UpdateCalendarAccountInput {
  accountId: Scalars["String"]["input"];
  config?: InputMaybe<Scalars["JSON"]["input"]>;
  expiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
}

/** Input for updating a single recurring event instance or splitting the series. */
export interface UpdateCalendarEventInstanceInput {
  /** Field-level overrides to apply. */
  changes: Scalars["JSON"]["input"];
  eventId: Scalars["ID"]["input"];
  /** The original DTSTART of the instance to update (used as RECURRENCE-ID key). */
  instanceStart: Scalars["DateTime"]["input"];
  scope: InstanceEditScope;
}

/** Result of `updateCalendarEventInstance`. */
export interface UpdateCalendarEventInstanceResult {
  __typename?: "UpdateCalendarEventInstanceResult";
  instance: Maybe<CalendarEventInstanceType>;
  ok: Scalars["Boolean"]["output"];
}

/** Input for updating an existing Copilot chat session. */
export interface UpdateChatSessionInput {
  docId?: InputMaybe<Scalars["String"]["input"]>;
  pinned?: InputMaybe<Scalars["Boolean"]["input"]>;
  promptName?: InputMaybe<Scalars["String"]["input"]>;
  sessionId: Scalars["String"]["input"];
  title?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateDatabaseCellValueInput {
  databaseId: Scalars["ID"]["input"];
  /**
   * P-DB-29B-C optimistic-lock precondition; see
   * [`UpdateDatabaseRowPositionInput::expected_edit_revision`].
   */
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  /** P-DB-29B-C: force the write even when the precondition fails. */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowId: Scalars["ID"]["input"];
  value: DatabaseCellValueInput;
}

export interface UpdateDatabaseFieldInput {
  config?: InputMaybe<DatabaseFieldConfigInput>;
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  fieldId: Scalars["ID"]["input"];
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  required?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface UpdateDatabaseInput {
  databaseId: Scalars["ID"]["input"];
  description?: InputMaybe<Scalars["String"]["input"]>;
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  title?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateDatabaseRowPositionInput {
  databaseId: Scalars["ID"]["input"];
  /**
   * P-DB-29B-C optimistic-lock precondition. When supplied, the server
   * compares the row's current edit revision against this baseline and
   * rejects the write with `MIX_DATABASE_ROW_CONFLICT` on mismatch.
   */
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  /**
   * P-DB-29B-C: acknowledge that the client is intentionally overwriting
   * a stale snapshot. Forces the write to proceed even on mismatch and
   * records the overwrite in the audit log.
   */
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  position: Scalars["Int"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface UpdateDatabaseRowTemplateInput {
  description?: InputMaybe<Scalars["String"]["input"]>;
  enabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  expectedEditRevision: Scalars["Int"]["input"];
  initialCellValues?: InputMaybe<Array<CreateDatabaseRowCellInput>>;
  isDefault?: InputMaybe<Scalars["Boolean"]["input"]>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  position?: InputMaybe<Scalars["Int"]["input"]>;
  rowTemplateId: Scalars["ID"]["input"];
}

export interface UpdateDatabaseRowTitleInput {
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  rowId: Scalars["ID"]["input"];
  title: Scalars["String"]["input"];
  titleFieldId: Scalars["ID"]["input"];
}

export interface UpdateDatabaseViewInput {
  config?: InputMaybe<DatabaseViewConfigInput>;
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision?: InputMaybe<Scalars["Int"]["input"]>;
  force?: InputMaybe<Scalars["Boolean"]["input"]>;
  icon?: InputMaybe<DatabaseViewIconInput>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  viewId: Scalars["ID"]["input"];
  viewKind?: InputMaybe<DatabaseViewKind>;
}

export interface UpdateDocDefaultRoleInput {
  /** Deprecated: use `externalDocId`. This alias carries the same workspace-local external key. */
  docId?: InputMaybe<Scalars["String"]["input"]>;
  externalDocId?: InputMaybe<Scalars["String"]["input"]>;
  role: DocRole;
  workspaceId: Scalars["String"]["input"];
}

export interface UpdateDocUserRoleInput {
  /** Deprecated: use `externalDocId`. This alias carries the same workspace-local external key. */
  docId?: InputMaybe<Scalars["String"]["input"]>;
  externalDocId?: InputMaybe<Scalars["String"]["input"]>;
  role: DocRole;
  userId: Scalars["String"]["input"];
  workspaceId: Scalars["String"]["input"];
}

/** Input for updating an existing workspace event tag. */
export interface UpdateEventTagInput {
  color?: InputMaybe<Scalars["String"]["input"]>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId: Scalars["String"]["input"];
}

/**
 * Patch semantics for an existing profile. Omitted fields preserve persisted
 * values; `null` clears nullable polling/storage limits.
 */
export interface UpdateGitSyncProfileInput {
  branch?: InputMaybe<Scalars["String"]["input"]>;
  credential?: InputMaybe<GitSyncCredentialInput>;
  cronExpression?: InputMaybe<Scalars["String"]["input"]>;
  cronMisfirePolicy?: InputMaybe<GitSyncCronMisfirePolicy>;
  cronTimezone?: InputMaybe<Scalars["String"]["input"]>;
  enabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  maxMirrorStorageMb?: InputMaybe<Scalars["Int"]["input"]>;
  pollingIntervalSecs?: InputMaybe<Scalars["Int"]["input"]>;
  repoUrl?: InputMaybe<Scalars["String"]["input"]>;
  rootPath?: InputMaybe<Scalars["String"]["input"]>;
  syncDirection?: InputMaybe<GitSyncDirection>;
  triggerMode?: InputMaybe<GitSyncTriggerMode>;
}

export interface UpdateLogModuleLevelInput {
  autoRevertMinutes?: InputMaybe<Scalars["Int"]["input"]>;
  group: Scalars["String"]["input"];
  level: Scalars["String"]["input"];
}

export interface UpdateLogOutputInput {
  filePath?: InputMaybe<Scalars["String"]["input"]>;
  maxFiles?: InputMaybe<Scalars["Int"]["input"]>;
  rotation?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateOrganizationIdentityInput {
  addressLines?: InputMaybe<Array<Scalars["String"]["input"]>>;
  contactEmail?: InputMaybe<Scalars["String"]["input"]>;
  displayName?: InputMaybe<Scalars["String"]["input"]>;
  jurisdiction?: InputMaybe<Scalars["String"]["input"]>;
  legalName?: InputMaybe<Scalars["String"]["input"]>;
  registrationId?: InputMaybe<Scalars["String"]["input"]>;
  shortName?: InputMaybe<Scalars["String"]["input"]>;
  taxId?: InputMaybe<Scalars["String"]["input"]>;
  websiteUrl?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateOrganizationInput {
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  name?: InputMaybe<Scalars["String"]["input"]>;
  slug?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateOrganizationPolicyInput {
  importExportEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  managerCanCreateWorkspaces?: InputMaybe<Scalars["Boolean"]["input"]>;
  managerCanManageOuMembers?: InputMaybe<Scalars["Boolean"]["input"]>;
  managerRootProjectCreation?: InputMaybe<PolicyStateEnum>;
  managerUnitProjectCreation?: InputMaybe<PolicyStateEnum>;
}

export interface UpdateTaskRecurrenceInput {
  expectedRevision: Scalars["Int"]["input"];
  recipe: TaskRecurrenceRecipeInput;
  rule: RecurrenceRuleInput;
  seriesId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

/** Input for updating user profile fields. */
export interface UpdateUserInput {
  /** New display name. */
  name?: InputMaybe<Scalars["String"]["input"]>;
}

/**
 * Tri-state preference patch. Omitted leaves a field unchanged; null removes
 * its override; a concrete value sets it.
 */
export interface UpdateUserPreferencesInput {
  aiModelId?: InputMaybe<Scalars["String"]["input"]>;
  aiReasoningEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  assistanceMode?: InputMaybe<AssistanceMode>;
  colorMode?: InputMaybe<Scalars["String"]["input"]>;
  dateFormat?: InputMaybe<Scalars["String"]["input"]>;
  defaultDocumentLanguage?: InputMaybe<Scalars["String"]["input"]>;
  documentMetadataHeaderVisibility?: InputMaybe<
    Array<WorkspaceDocumentMetadataVisibilityInput>
  >;
  edgelessDefaultTheme?: InputMaybe<Scalars["String"]["input"]>;
  editorCustomFontFamily?: InputMaybe<Scalars["String"]["input"]>;
  editorFontFamily?: InputMaybe<Scalars["String"]["input"]>;
  editorFontSize?: InputMaybe<Scalars["Int"]["input"]>;
  fullWidthLayout?: InputMaybe<Scalars["Boolean"]["input"]>;
  imageAntialiasing?: InputMaybe<Scalars["Boolean"]["input"]>;
  journalFirstDayOfWeek?: InputMaybe<Scalars["String"]["input"]>;
  journalShowCalendarWeeks?: InputMaybe<Scalars["Boolean"]["input"]>;
  locale?: InputMaybe<Scalars["String"]["input"]>;
  newDocumentMode?: InputMaybe<Scalars["String"]["input"]>;
  noisyBackground?: InputMaybe<Scalars["Boolean"]["input"]>;
  notifyCreatedDocuments?: InputMaybe<Scalars["Boolean"]["input"]>;
  openDocumentMode?: InputMaybe<Scalars["String"]["input"]>;
  projectAssistanceOverrides?: InputMaybe<
    Array<ProjectAssistanceOverrideInput>
  >;
  receiveCommentEmail?: InputMaybe<Scalars["Boolean"]["input"]>;
  receiveInvitationEmail?: InputMaybe<Scalars["Boolean"]["input"]>;
  receiveMentionEmail?: InputMaybe<Scalars["Boolean"]["input"]>;
  showLinkedDocuments?: InputMaybe<Scalars["Boolean"]["input"]>;
  telemetryEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  templateCatalogViews?: InputMaybe<Array<TemplateCatalogViewInput>>;
  timeFormat?: InputMaybe<Scalars["String"]["input"]>;
  timezone?: InputMaybe<Scalars["String"]["input"]>;
  workbenchToolLayouts?: InputMaybe<Array<WorkbenchToolLayoutInput>>;
  /** Each entry modifies one key. Omission or an empty list preserves all keys. */
  workspaceAssistanceOverrides?: InputMaybe<
    Array<WorkspaceAssistanceOverrideInput>
  >;
  workspaceDashboardLayouts?: InputMaybe<Array<WorkspaceDashboardLayoutInput>>;
}

/** Input for updating workspace-level calendar settings. */
export interface UpdateWorkspaceCalendarSettingsInput {
  defaultReminderOffsetMinutes?: InputMaybe<Scalars["Int"]["input"]>;
  workspaceId: Scalars["String"]["input"];
  writebackSubscriptionId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateWorkspaceCalendarsInput {
  items: Array<WorkspaceCalendarItemInput>;
  workspaceId: Scalars["String"]["input"];
}

export interface UpdateWorkspaceDocumentSettingsInput {
  defaultClassificationId?: InputMaybe<Scalars["ID"]["input"]>;
  defaultDocumentTypeId?: InputMaybe<Scalars["ID"]["input"]>;
  defaultRetentionPolicyId?: InputMaybe<Scalars["ID"]["input"]>;
  defaultStatusId?: InputMaybe<Scalars["ID"]["input"]>;
  statusSchemaId?: InputMaybe<Scalars["ID"]["input"]>;
  versionPolicyId?: InputMaybe<Scalars["ID"]["input"]>;
}

/** Input for updating a workspace-native calendar event. */
export interface UpdateWorkspaceEventInput {
  allDay?: InputMaybe<Scalars["Boolean"]["input"]>;
  allMembers?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** Omit to preserve content; an explicit null clears it. */
  descriptionDelta?: InputMaybe<Scalars["JSON"]["input"]>;
  endsAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  recurrence?: InputMaybe<FixedRecurrenceInput>;
  /**
   * Omit to leave reminders unchanged; pass `null` or an empty list to clear
   * them; pass a list to replace the complete reminder set atomically.
   */
  reminders?: InputMaybe<Array<NativeReminderInput>>;
  sourceBlockId?: InputMaybe<Scalars["String"]["input"]>;
  /** Deprecated: use `sourceExternalId`. This alias carries the same workspace-local external key. */
  sourceDocId?: InputMaybe<Scalars["String"]["input"]>;
  sourceEndOffset?: InputMaybe<Scalars["Int"]["input"]>;
  /** Pass `null` to unlink the source doc; omit to leave unchanged. */
  sourceExternalId?: InputMaybe<Scalars["String"]["input"]>;
  sourceKind?: InputMaybe<Scalars["String"]["input"]>;
  sourceStartOffset?: InputMaybe<Scalars["Int"]["input"]>;
  startsAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  /** Pass `null` to clear the tag; omit to leave unchanged. */
  tagId?: InputMaybe<Scalars["String"]["input"]>;
  title?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UpdateWorkspaceHistorySettingsInput {
  autoVersionOn?: InputMaybe<Array<AutoVersionTriggerType>>;
  editCaptureEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  editCaptureIntervalMs?: InputMaybe<Scalars["Int"]["input"]>;
  expectedRevision: Scalars["String"]["input"];
  namedVersioningEnabled?: InputMaybe<Scalars["Boolean"]["input"]>;
  retentionCount?: InputMaybe<Scalars["Int"]["input"]>;
}

/** Input for the `updateWorkspace` mutation. */
export interface UpdateWorkspaceInput {
  /** New plain-text workspace description. Empty text clears it. */
  description?: InputMaybe<Scalars["String"]["input"]>;
  /** Toggle AI / Copilot features for the workspace. */
  enableAi?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** Toggle AI document embedding for search. */
  enableDocEmbedding?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** Toggle document sharing within the workspace. */
  enableSharing?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** Toggle URL preview card generation. */
  enableUrlPreview?: InputMaybe<Scalars["Boolean"]["input"]>;
  /** UUID of the workspace to update. */
  id: Scalars["String"]["input"];
  /** New workspace name. */
  name?: InputMaybe<Scalars["String"]["input"]>;
  /** One revision-fenced overview scope; unrelated settings remain untouched. */
  overview?: InputMaybe<WorkspaceOverviewSettingsInput>;
  /** Whether to make the workspace publicly accessible. */
  public?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface UpdateWorkspaceTagDescriptionInput {
  description?: InputMaybe<Scalars["String"]["input"]>;
  tagId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface UpsertDatabaseViewUserStateInput {
  collapsedGroupKeys?: InputMaybe<Array<Scalars["String"]["input"]>>;
  databaseId: Scalars["ID"]["input"];
  expectedEditRevision: Scalars["Int"]["input"];
  fieldWidthOverrides?: InputMaybe<Array<DatabaseFieldWidthInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  searchText?: InputMaybe<Scalars["String"]["input"]>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  viewId: Scalars["ID"]["input"];
}

export interface UpsertOrganizationUnitInput {
  description?: InputMaybe<Scalars["String"]["input"]>;
  id?: InputMaybe<Scalars["ID"]["input"]>;
  maxMembers?: InputMaybe<Scalars["Int"]["input"]>;
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  name: Scalars["String"]["input"];
  parentUnitId?: InputMaybe<Scalars["ID"]["input"]>;
  slug: Scalars["String"]["input"];
  status?: InputMaybe<OrganizationUnitStatusEnum>;
  unitTypeId: Scalars["ID"]["input"];
}

export interface UpsertOrganizationUnitTypeInput {
  canBeManagerCreated: Scalars["Boolean"]["input"];
  canBeRootLevel: Scalars["Boolean"]["input"];
  canHaveChildren: Scalars["Boolean"]["input"];
  canHaveCrossUnitMembers: Scalars["Boolean"]["input"];
  canManageWorkspaces: Scalars["Boolean"]["input"];
  canOwnWorkspaces: Scalars["Boolean"]["input"];
  color?: InputMaybe<Scalars["String"]["input"]>;
  description?: InputMaybe<Scalars["String"]["input"]>;
  icon?: InputMaybe<Scalars["String"]["input"]>;
  /** Either `null` (insert) or an existing UUID (update). */
  id?: InputMaybe<Scalars["ID"]["input"]>;
  isActive?: InputMaybe<Scalars["Boolean"]["input"]>;
  isStaffUnit?: InputMaybe<Scalars["Boolean"]["input"]>;
  isStructural: Scalars["Boolean"]["input"];
  key: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
  metadata?: InputMaybe<Scalars["JSON"]["input"]>;
  requiresAdminApproval?: InputMaybe<Scalars["Boolean"]["input"]>;
}

/** Free/busy result for a single user (P90-CAL-H-07). */
export interface UserFreeBusy {
  __typename?: "UserFreeBusy";
  /** List of busy periods within the queried window. */
  busyPeriods: Array<CalendarFreeBusyPeriod>;
  /** The user ID. */
  userId: Scalars["ID"]["output"];
}

export interface UserImportFailedType {
  __typename?: "UserImportFailedType";
  email: Scalars["String"]["output"];
  error: Scalars["String"]["output"];
}

export type UserImportResultType = UserImportFailedType | UserType;

/**
 * Union returned by `userById` — resolves to the full or limited profile depending on
 * whether the caller is the user themselves or an admin.
 */
export type UserOrLimitedUser = LimitedUserType | UserType;

/**
 * One OU-membership row for a single user — returned by
 * `userOrganizationMemberships`.
 *
 * Powers the admin-surface user-detail panel (`P-AR-2-S02`). Carries the
 * OU identity snapshot (id, display name, slug), the membership role
 * (`reader` / `member` / `manager`), the membership source
 * (`manual` / `import` / `oidc` / `ldap` / `scim`) and the join
 * timestamp (=`organization_unit_member.created_at`).
 */
export interface UserOrganizationMembershipResult {
  __typename?: "UserOrganizationMembershipResult";
  /** Timestamp when the membership row was created. */
  joinedAt: Scalars["DateTime"]["output"];
  /** Membership role: `reader` / `member` / `manager`. */
  role: Scalars["String"]["output"];
  /** Membership source: `manual` / `import` / `oidc` / `ldap` / `scim`. */
  source: Scalars["String"]["output"];
  /** OU id. */
  unitId: Scalars["ID"]["output"];
  /** OU display name. */
  unitName: Scalars["String"]["output"];
  /** OU slug. */
  unitSlug: Scalars["String"]["output"];
}

export interface UserPreferenceValuesType {
  __typename?: "UserPreferenceValuesType";
  aiModelId: Maybe<Scalars["String"]["output"]>;
  aiReasoningEnabled: Maybe<Scalars["Boolean"]["output"]>;
  assistanceMode: Maybe<AssistanceMode>;
  colorMode: Maybe<Scalars["String"]["output"]>;
  dateFormat: Maybe<Scalars["String"]["output"]>;
  defaultDocumentLanguage: Maybe<Scalars["String"]["output"]>;
  documentMetadataHeaderVisibility: Maybe<
    Array<WorkspaceDocumentMetadataVisibilityType>
  >;
  edgelessDefaultTheme: Maybe<Scalars["String"]["output"]>;
  editorCustomFontFamily: Maybe<Scalars["String"]["output"]>;
  editorFontFamily: Maybe<Scalars["String"]["output"]>;
  editorFontSize: Maybe<Scalars["Int"]["output"]>;
  fullWidthLayout: Maybe<Scalars["Boolean"]["output"]>;
  imageAntialiasing: Maybe<Scalars["Boolean"]["output"]>;
  journalFirstDayOfWeek: Maybe<Scalars["String"]["output"]>;
  journalShowCalendarWeeks: Maybe<Scalars["Boolean"]["output"]>;
  locale: Maybe<Scalars["String"]["output"]>;
  newDocumentMode: Maybe<Scalars["String"]["output"]>;
  noisyBackground: Maybe<Scalars["Boolean"]["output"]>;
  notifyCreatedDocuments: Maybe<Scalars["Boolean"]["output"]>;
  openDocumentMode: Maybe<Scalars["String"]["output"]>;
  projectAssistanceOverrides: Array<ProjectAssistanceOverrideType>;
  receiveCommentEmail: Maybe<Scalars["Boolean"]["output"]>;
  receiveInvitationEmail: Maybe<Scalars["Boolean"]["output"]>;
  receiveMentionEmail: Maybe<Scalars["Boolean"]["output"]>;
  savedSetups: Array<SavedSetupConfiguration>;
  showLinkedDocuments: Maybe<Scalars["Boolean"]["output"]>;
  telemetryEnabled: Maybe<Scalars["Boolean"]["output"]>;
  templateCatalogViews: Maybe<Array<TemplateCatalogViewType>>;
  timeFormat: Maybe<Scalars["String"]["output"]>;
  timezone: Maybe<Scalars["String"]["output"]>;
  workbenchToolLayouts: Maybe<Array<WorkbenchToolLayoutType>>;
  workspaceAssistanceOverrides: Array<WorkspaceAssistanceOverrideType>;
  workspaceDashboardLayouts: Maybe<Array<WorkspaceDashboardLayoutType>>;
}

export interface UserPreferencesType {
  __typename?: "UserPreferencesType";
  /** Resolve confirmed personal policy against current Workspace/Project authority. */
  assistance: EffectiveAssistanceType;
  effectiveValues: EffectiveUserPreferenceValuesType;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  values: UserPreferenceValuesType;
}

export interface UserPreferencesTypeAssistanceArgs {
  projectId?: InputMaybe<Scalars["ID"]["input"]>;
  workspaceId?: InputMaybe<Scalars["ID"]["input"]>;
}

/** Human-readable quota limits (formatted as strings) for display in the UI. */
export interface UserQuotaHumanReadableType {
  __typename?: "UserQuotaHumanReadableType";
  /** Maximum blob size in a human-readable format (e.g. `"10 MB"` or `"Unlimited"`). */
  blobLimit: Scalars["String"]["output"];
  /** History retention period as a human-readable string (e.g. `"30 days"` or `"Unlimited"`). */
  historyPeriod: Scalars["String"]["output"];
  /** Current member count (formatted string). */
  memberCount: Scalars["String"]["output"];
  /** Maximum number of workspace members as a human-readable string. */
  memberLimit: Scalars["String"]["output"];
  /** Quota plan name. */
  name: Scalars["String"]["output"];
  /** Number of members over the limit (formatted string). */
  overcapacityMemberCount: Scalars["String"]["output"];
  /** Total storage quota as a human-readable string (e.g. `"100 GB"` or `"Unlimited"`). */
  storageQuota: Scalars["String"]["output"];
}

/** Workspace resource quota and current usage. */
export interface UserQuotaType {
  __typename?: "UserQuotaType";
  /** Maximum blob upload size in bytes. */
  blobLimit: Scalars["Int"]["output"];
  /** Number of days of document history retained. */
  historyPeriod: Scalars["Int"]["output"];
  /** Human-readable representations of the quota values. */
  humanReadable: UserQuotaHumanReadableType;
  /** Current member count. */
  memberCount: Scalars["Int"]["output"];
  /** Maximum workspace members. */
  memberLimit: Scalars["Int"]["output"];
  /** Quota plan name. */
  name: Scalars["String"]["output"];
  /** Members exceeding the plan limit. */
  overcapacityMemberCount: Scalars["Int"]["output"];
  /** Total storage quota in bytes. */
  storageQuota: Scalars["Int"]["output"];
  /** Currently used storage in bytes. */
  usedStorageQuota: Scalars["Int"]["output"];
}

/** Storage usage for a user or workspace (returned by usage queries). */
export interface UserQuotaUsageType {
  __typename?: "UserQuotaUsageType";
  /** Current storage used in bytes. */
  storageQuota: Scalars["Int"]["output"];
}

/**
 * Admin-surface user search hit returned by `adminSearchUsers`.
 *
 * Powers the admin user-picker (`P-AR-0-S02`). Includes the activated
 * user-feature names plus the `is_admin` / `disabled` flags so the admin
 * UI can render badges. The manager surface uses a different output type
 * ([`ManagerUserSearchResult`]) that omits these fields.
 */
export interface UserSearchResult {
  __typename?: "UserSearchResult";
  /** Whether the account is disabled (status = 'disabled'). */
  disabled: Scalars["Boolean"]["output"];
  /** Email snapshot. */
  email: Scalars["String"]["output"];
  /** Activated user features (e.g. `manager`, `early_access`). */
  features: Array<Scalars["String"]["output"]>;
  /** User id. */
  id: Scalars["ID"]["output"];
  /** Whether the user holds server-admin privileges. */
  isAdmin: Scalars["Boolean"]["output"];
  /** Display name. */
  name: Scalars["String"]["output"];
}

export interface UserType {
  __typename?: "UserType";
  accessTokens: Array<AccessToken>;
  assistantPackages: Array<AssistantPackage>;
  avatarUrl: Maybe<Scalars["String"]["output"]>;
  calendarAccounts: Array<CalendarAccountObjectType>;
  copilot: CopilotType;
  disabled: Scalars["Boolean"]["output"];
  email: Scalars["String"]["output"];
  emailVerified: Scalars["Boolean"]["output"];
  features: Array<FeatureType>;
  hasPassword: Scalars["Boolean"]["output"];
  id: Scalars["UUID"]["output"];
  isAdmin: Scalars["Boolean"]["output"];
  name: Maybe<Scalars["String"]["output"]>;
  notifications: PaginatedNotificationObjectType;
  preferences: UserPreferencesType;
  prepareWorkspaceAssistant: PreparedWorkspaceAssistant;
  quota: UserQuotaType;
  quotaUsage: UserQuotaUsageType;
  /** Resolving a saved preference prepares no execution and changes no mode. */
  resolveSavedAssistantSetup: Maybe<SavedSetupResolution>;
  revealedAccessTokens: Array<RevealedAccessToken>;
  /** @deprecated use [/api/auth/sign-in?native=true] instead */
  token: TokenType;
  /** Receipt readback is read-only, including personal assistance preferences. */
  workspaceCreation: Maybe<WorkspaceCreationResultType>;
}

export interface UserTypeAssistantPackagesArgs {
  context: AssistantContext;
}

export interface UserTypeCopilotArgs {
  promptName?: InputMaybe<Scalars["String"]["input"]>;
  workspaceId?: InputMaybe<Scalars["String"]["input"]>;
}

export interface UserTypeNotificationsArgs {
  filter?: InputMaybe<NotificationListFilterInput>;
  pagination: PaginationInput;
}

export interface UserTypePrepareWorkspaceAssistantArgs {
  input: PrepareWorkspaceAssistantInput;
}

export interface UserTypeResolveSavedAssistantSetupArgs {
  id: Scalars["ID"]["input"];
}

export interface UserTypeWorkspaceCreationArgs {
  requestId: Scalars["ID"]["input"];
}

export interface ValidationErrorDataType {
  __typename?: "ValidationErrorDataType";
  message: Scalars["String"]["output"];
}

/** A validation error/warning from bundle import. */
export interface ValidationErrorType {
  __typename?: "ValidationErrorType";
  code: Scalars["String"]["output"];
  field: Maybe<Scalars["String"]["output"]>;
  message: Scalars["String"]["output"];
  path: Maybe<Scalars["String"]["output"]>;
  severity: ValidationSeverityType;
}

/** Validation severity as a GraphQL enum. */
export enum ValidationSeverityType {
  Error = "Error",
  Warning = "Warning",
}

export interface VersionRejectedDataType {
  __typename?: "VersionRejectedDataType";
  message: Scalars["String"]["output"];
}

/**
 * Stable product tool identifiers. Arbitrary client-defined IDs are rejected
 * by the schema before they can reach the preference aggregate.
 */
export enum WorkbenchToolId {
  Activity = "Activity",
  Agenda = "Agenda",
  Analytics = "Analytics",
  Calendar = "Calendar",
  Chat = "Chat",
  Comment = "Comment",
  DatabaseSettings = "DatabaseSettings",
  DocumentInfo = "DocumentInfo",
  Export = "Export",
  Frame = "Frame",
  GraphDetails = "GraphDetails",
  Outline = "Outline",
  Presence = "Presence",
  Tags = "Tags",
  TaskDetails = "TaskDetails",
}

export interface WorkbenchToolLayoutInput {
  collapsedToolIds: Array<WorkbenchToolId>;
  orderedToolIds: Array<WorkbenchToolId>;
  viewFamily: WorkbenchViewFamily;
  visibleToolIds: Array<WorkbenchToolId>;
  workspaceId: Scalars["ID"]["input"];
}

export interface WorkbenchToolLayoutType {
  __typename?: "WorkbenchToolLayoutType";
  collapsedToolIds: Array<WorkbenchToolId>;
  orderedToolIds: Array<WorkbenchToolId>;
  viewFamily: WorkbenchViewFamily;
  visibleToolIds: Array<WorkbenchToolId>;
  workspaceId: Scalars["ID"]["output"];
}

/** Stable Workbench route families accepted by the preference API. */
export enum WorkbenchViewFamily {
  Database = "Database",
  DocumentEdgeless = "DocumentEdgeless",
  DocumentPage = "DocumentPage",
  Graph = "Graph",
  Journal = "Journal",
}

export interface WorkspaceAssistanceOverrideInput {
  /** Omitted is rejected; null resets this one key to inherited policy. */
  mode?: InputMaybe<AssistanceMode>;
  workspaceId: Scalars["ID"]["input"];
}

export interface WorkspaceAssistanceOverrideType {
  __typename?: "WorkspaceAssistanceOverrideType";
  mode: AssistanceMode;
  workspaceId: Scalars["ID"]["output"];
}

export interface WorkspaceAssistantConfirmationInput {
  answers: Scalars["JSON"]["input"];
  identity: AssistantPackageIdentityInput;
  planDigest: Scalars["String"]["input"];
}

export interface WorkspaceAutomationActionConfigInput {
  createLinkedDocument?: InputMaybe<WorkspaceAutomationCreateLinkedDocumentActionInput>;
  createRow?: InputMaybe<WorkspaceAutomationCreateRowActionInput>;
  notifyWebhook?: InputMaybe<WorkspaceAutomationNotifyWebhookActionInput>;
  updateCell?: InputMaybe<WorkspaceAutomationUpdateCellActionInput>;
}

export interface WorkspaceAutomationActionDefinitionInput {
  config: WorkspaceAutomationActionConfigInput;
  position: Scalars["Int"]["input"];
}

export enum WorkspaceAutomationActionKind {
  CreateLinkedDocument = "CreateLinkedDocument",
  CreateRow = "CreateRow",
  NotifyWebhook = "NotifyWebhook",
  UpdateCell = "UpdateCell",
}

export interface WorkspaceAutomationActionType {
  __typename?: "WorkspaceAutomationActionType";
  actionType: WorkspaceAutomationActionKind;
  config: Scalars["JSON"]["output"];
  position: Scalars["Int"]["output"];
}

export interface WorkspaceAutomationCellInput {
  fieldId: Scalars["ID"]["input"];
  value: DatabaseCellValueInput;
}

export interface WorkspaceAutomationCreateLinkedDocumentActionInput {
  relationFieldId?: InputMaybe<Scalars["ID"]["input"]>;
  titleTemplate: Scalars["String"]["input"];
}

export interface WorkspaceAutomationCreateRowActionInput {
  cells?: InputMaybe<Array<WorkspaceAutomationCellInput>>;
  databaseId: Scalars["ID"]["input"];
  titleTemplate?: InputMaybe<Scalars["String"]["input"]>;
}

export interface WorkspaceAutomationNotifyWebhookActionInput {
  secretRef?: InputMaybe<Scalars["String"]["input"]>;
  url: Scalars["String"]["input"];
}

/** Product origin, without exposing accepted workflow inputs or private fingerprints. */
export enum WorkspaceAutomationRunOrigin {
  ConfirmedRequest = "ConfirmedRequest",
  DocumentReview = "DocumentReview",
  RecurringTask = "RecurringTask",
  Rule = "Rule",
  TaskHandover = "TaskHandover",
  TaskMaintenance = "TaskMaintenance",
  WorkspaceSetup = "WorkspaceSetup",
}

export enum WorkspaceAutomationRunStatus {
  DeadLetter = "DeadLetter",
  Failed = "Failed",
  Queued = "Queued",
  Running = "Running",
  Skipped = "Skipped",
  Succeeded = "Succeeded",
}

export interface WorkspaceAutomationRunType {
  __typename?: "WorkspaceAutomationRunType";
  attemptCount: Scalars["Int"]["output"];
  automationId: Maybe<Scalars["ID"]["output"]>;
  deadLetter: Scalars["Boolean"]["output"];
  errorCode: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  finishedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  idempotencyKey: Scalars["String"]["output"];
  origin: WorkspaceAutomationRunOrigin;
  queuedAt: Scalars["DateTime"]["output"];
  requestId: Maybe<Scalars["ID"]["output"]>;
  startedAt: Maybe<Scalars["DateTime"]["output"]>;
  status: WorkspaceAutomationRunStatus;
  triggerEvent: Maybe<Scalars["JSON"]["output"]>;
  triggerType: Maybe<WorkspaceAutomationTriggerKind>;
  workspaceId: Scalars["ID"]["output"];
}

export enum WorkspaceAutomationStatus {
  Disabled = "Disabled",
  Enabled = "Enabled",
}

export interface WorkspaceAutomationTriggerInput {
  databaseId: Scalars["ID"]["input"];
  fieldId?: InputMaybe<Scalars["ID"]["input"]>;
  selectOptionId?: InputMaybe<Scalars["String"]["input"]>;
  triggerType: WorkspaceAutomationTriggerKind;
}

export enum WorkspaceAutomationTriggerKind {
  RelationChanged = "RelationChanged",
  RowCreated = "RowCreated",
  RowUpdated = "RowUpdated",
  StatusSelectChanged = "StatusSelectChanged",
}

export interface WorkspaceAutomationTriggerType {
  __typename?: "WorkspaceAutomationTriggerType";
  databaseId: Scalars["ID"]["output"];
  fieldId: Maybe<Scalars["ID"]["output"]>;
  selectOptionId: Maybe<Scalars["String"]["output"]>;
  triggerType: WorkspaceAutomationTriggerKind;
}

export interface WorkspaceAutomationType {
  __typename?: "WorkspaceAutomationType";
  actions: Array<WorkspaceAutomationActionType>;
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<Scalars["ID"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  status: WorkspaceAutomationStatus;
  trigger: WorkspaceAutomationTriggerType;
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface WorkspaceAutomationUpdateCellActionInput {
  fieldId: Scalars["ID"]["input"];
  rowId: Scalars["ID"]["input"];
  value: DatabaseCellValueInput;
}

export interface WorkspaceCalendarItemInput {
  colorOverride?: InputMaybe<Scalars["String"]["input"]>;
  sortOrder?: InputMaybe<Scalars["Int"]["input"]>;
  subscriptionId: Scalars["String"]["input"];
}

export interface WorkspaceCalendarItemObjectType {
  __typename?: "WorkspaceCalendarItemObjectType";
  colorOverride: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  id: Scalars["String"]["output"];
  sortOrder: Maybe<Scalars["Int"]["output"]>;
  subscriptionId: Scalars["String"]["output"];
}

export interface WorkspaceCalendarObjectType {
  __typename?: "WorkspaceCalendarObjectType";
  colorOverride: Maybe<Scalars["String"]["output"]>;
  createdByUserId: Scalars["String"]["output"];
  displayNameOverride: Maybe<Scalars["String"]["output"]>;
  enabled: Scalars["Boolean"]["output"];
  events: Array<CalendarEventObjectType>;
  id: Scalars["String"]["output"];
  items: Array<WorkspaceCalendarItemObjectType>;
  workspaceId: Scalars["String"]["output"];
}

export interface WorkspaceCalendarObjectTypeEventsArgs {
  from: Scalars["DateTime"]["input"];
  to: Scalars["DateTime"]["input"];
}

/** Per-workspace calendar configuration (writeback target, default reminder). */
export interface WorkspaceCalendarSettingsType {
  __typename?: "WorkspaceCalendarSettingsType";
  defaultReminderOffsetMinutes: Maybe<Scalars["Int"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
  writebackSubscriptionId: Maybe<Scalars["String"]["output"]>;
}

export interface WorkspaceCalendarType {
  __typename?: "WorkspaceCalendarType";
  accountId: Scalars["ID"]["output"];
  enabled: Scalars["Boolean"]["output"];
  remoteCalendarId: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export enum WorkspaceContentBlockerType {
  BrokenReference = "BrokenReference",
  ExternalDeployment = "ExternalDeployment",
  GitSyncBusy = "GitSyncBusy",
  GitSyncConflicts = "GitSyncConflicts",
  GitSyncHandoffUnavailable = "GitSyncHandoffUnavailable",
  GitSyncManagementDenied = "GitSyncManagementDenied",
  GitSyncOwnershipUnproven = "GitSyncOwnershipUnproven",
  GitSyncScopeAmbiguous = "GitSyncScopeAmbiguous",
  MembershipPermission = "MembershipPermission",
  OwnershipUnsupported = "OwnershipUnsupported",
  PermissionDenied = "PermissionDenied",
  PublicShareConflict = "PublicShareConflict",
  TargetPolicy = "TargetPolicy",
  WorkspaceNameConflict = "WorkspaceNameConflict",
}

export interface WorkspaceContentConfirmationInput {
  kind: WorkspaceContentConfirmationKindType;
  resource?: InputMaybe<WorkspaceContentResourceInput>;
  resourceWorkspaceId?: InputMaybe<Scalars["UUID"]["input"]>;
  role?: InputMaybe<Permission>;
  userId?: InputMaybe<Scalars["UUID"]["input"]>;
}

export enum WorkspaceContentConfirmationKindType {
  AddTargetMember = "AddTargetMember",
  CopyDocumentAcl = "CopyDocumentAcl",
  DisablePublicShare = "DisablePublicShare",
}

export interface WorkspaceContentConfirmationType {
  __typename?: "WorkspaceContentConfirmationType";
  kind: WorkspaceContentConfirmationKindType;
  resource: Maybe<WorkspaceContentResourceType>;
  role: Maybe<Permission>;
  userId: Maybe<Scalars["UUID"]["output"]>;
}

export enum WorkspaceContentConflictKindType {
  Key = "Key",
  PublicSharing = "PublicSharing",
  Schema = "Schema",
}

export interface WorkspaceContentConflictType {
  __typename?: "WorkspaceContentConflictType";
  kind: WorkspaceContentConflictKindType;
  resource: WorkspaceContentResourceType;
  suggestedName: Maybe<Scalars["String"]["output"]>;
}

export enum WorkspaceContentErrorCodeType {
  XWS_BLOB_COMPENSATION_FAILED = "XWS_BLOB_COMPENSATION_FAILED",
  XWS_BLOB_INTEGRITY_MISMATCH = "XWS_BLOB_INTEGRITY_MISMATCH",
  XWS_BLOB_MATERIALIZATION_FAILED = "XWS_BLOB_MATERIALIZATION_FAILED",
  XWS_BLOB_SIZE_LIMIT = "XWS_BLOB_SIZE_LIMIT",
  XWS_BLOB_STAGING_ENTRY_MISSING = "XWS_BLOB_STAGING_ENTRY_MISSING",
  XWS_CANCELLATION_CLEANUP_REQUIRED = "XWS_CANCELLATION_CLEANUP_REQUIRED",
  XWS_COLLECTION_DECODE = "XWS_COLLECTION_DECODE",
  XWS_COLLECTION_IDENTITY_CHANGED = "XWS_COLLECTION_IDENTITY_CHANGED",
  XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE = "XWS_CONCURRENT_TAG_IDENTITY_IS_NOT_REUSABLE",
  XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED = "XWS_COPY_TARGET_PAGE_DIRECTORY_CHANGED",
  XWS_COPY_TARGET_POLICY_CHANGED = "XWS_COPY_TARGET_POLICY_CHANGED",
  XWS_DATABASE_CHECK_CONSTRAINT = "XWS_DATABASE_CHECK_CONSTRAINT",
  XWS_DATABASE_EDIT_CONFLICT = "XWS_DATABASE_EDIT_CONFLICT",
  XWS_DATABASE_FOREIGN_KEY_CONSTRAINT = "XWS_DATABASE_FOREIGN_KEY_CONSTRAINT",
  XWS_DATABASE_IDENTITY_CHANGED = "XWS_DATABASE_IDENTITY_CHANGED",
  XWS_DATABASE_IDENTITY_INVALID = "XWS_DATABASE_IDENTITY_INVALID",
  XWS_DATABASE_IMPORT_CONFLICT = "XWS_DATABASE_IMPORT_CONFLICT",
  XWS_DATABASE_NOT_NULL_CONSTRAINT = "XWS_DATABASE_NOT_NULL_CONSTRAINT",
  XWS_DATABASE_SNAPSHOT_INVALID = "XWS_DATABASE_SNAPSHOT_INVALID",
  XWS_DATABASE_UNAVAILABLE = "XWS_DATABASE_UNAVAILABLE",
  XWS_DATABASE_UNIQUE_CONSTRAINT = "XWS_DATABASE_UNIQUE_CONSTRAINT",
  XWS_DIAGNOSTIC_INSTANCE_INVALID = "XWS_DIAGNOSTIC_INSTANCE_INVALID",
  XWS_DISTINCT_WORKSPACES_REQUIRED = "XWS_DISTINCT_WORKSPACES_REQUIRED",
  XWS_DOCUMENT_METADATA_INVALID = "XWS_DOCUMENT_METADATA_INVALID",
  XWS_DOCUMENT_SNAPSHOT_INVALID = "XWS_DOCUMENT_SNAPSHOT_INVALID",
  XWS_ENCODING_FAILED = "XWS_ENCODING_FAILED",
  XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED = "XWS_EXTRACT_BLOB_STAGING_STATE_CHANGED",
  XWS_EXTRACT_FOLDER_BINDING_INVALID = "XWS_EXTRACT_FOLDER_BINDING_INVALID",
  XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED = "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_CHANGED",
  XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID = "XWS_EXTRACT_MEMBERSHIP_SNAPSHOT_IS_INVALID",
  XWS_EXTRACT_OPERATION_REVISION_CHANGED = "XWS_EXTRACT_OPERATION_REVISION_CHANGED",
  XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED = "XWS_EXTRACT_RECIPIENT_SNAPSHOT_CHANGED",
  XWS_EXTRACT_RECOVERY_STATE_CHANGED = "XWS_EXTRACT_RECOVERY_STATE_CHANGED",
  XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED = "XWS_EXTRACT_RECOVERY_TARGET_LIFECYCLE_CHANGED",
  XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING = "XWS_EXTRACT_RECOVERY_TARGET_RECEIPT_IS_MISSING",
  XWS_EXTRACT_TARGET_ACTIVATION_CHANGED = "XWS_EXTRACT_TARGET_ACTIVATION_CHANGED",
  XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED = "XWS_EXTRACT_TARGET_LIFECYCLE_CHANGED",
  XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED = "XWS_EXTRACT_TARGET_LIFECYCLE_OWNERSHIP_CHANGED",
  XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED = "XWS_EXTRACT_TARGET_OWNERSHIP_CHANGED",
  XWS_EXTRACT_TARGET_RECEIPT_CHANGED = "XWS_EXTRACT_TARGET_RECEIPT_CHANGED",
  XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING = "XWS_EXTRACT_TARGET_RECEIPT_IS_MISSING",
  XWS_EXTRACT_TARGET_REPLAY_CHANGED = "XWS_EXTRACT_TARGET_REPLAY_CHANGED",
  XWS_EXTRACT_TARGET_ROOT_CHANGED = "XWS_EXTRACT_TARGET_ROOT_CHANGED",
  XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING = "XWS_EXTRACT_TARGET_WORKSPACE_IS_MISSING",
  XWS_GIT_SYNC_HANDOFF_UNAVAILABLE = "XWS_GIT_SYNC_HANDOFF_UNAVAILABLE",
  XWS_GIT_SYNC_METADATA_AUTH_DENIED = "XWS_GIT_SYNC_METADATA_AUTH_DENIED",
  XWS_GIT_SYNC_METADATA_CONFLICT = "XWS_GIT_SYNC_METADATA_CONFLICT",
  XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING = "XWS_GIT_SYNC_OUTBOUND_CLEANUP_PENDING",
  XWS_GIT_SYNC_REMOTE_UNAVAILABLE = "XWS_GIT_SYNC_REMOTE_UNAVAILABLE",
  XWS_GIT_SYNC_UNDO_CONTENT_CHANGED = "XWS_GIT_SYNC_UNDO_CONTENT_CHANGED",
  XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED = "XWS_GIT_SYNC_UNDO_OWNERSHIP_CHANGED",
  XWS_GIT_SYNC_UNDO_PENDING = "XWS_GIT_SYNC_UNDO_PENDING",
  XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY = "XWS_GIT_SYNC_UNDO_TARGET_NOT_EMPTY",
  XWS_INVENTORY_INVALID = "XWS_INVENTORY_INVALID",
  XWS_INVENTORY_LIMIT = "XWS_INVENTORY_LIMIT",
  XWS_LINK_INTENT_MISSING = "XWS_LINK_INTENT_MISSING",
  XWS_LINK_INTENT_WORKSPACE_CHANGED = "XWS_LINK_INTENT_WORKSPACE_CHANGED",
  XWS_LINK_ORGANIZER_CHANGED = "XWS_LINK_ORGANIZER_CHANGED",
  XWS_LINK_TARGET_UNAVAILABLE = "XWS_LINK_TARGET_UNAVAILABLE",
  XWS_MAPPING_PLAN_INVALID = "XWS_MAPPING_PLAN_INVALID",
  XWS_MOVED_TAG_CELL_DISAPPEARED = "XWS_MOVED_TAG_CELL_DISAPPEARED",
  XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED = "XWS_MOVED_TAG_FILTER_CONTAINER_CHANGED",
  XWS_MOVED_TAG_FILTER_DISAPPEARED = "XWS_MOVED_TAG_FILTER_DISAPPEARED",
  XWS_MOVED_TAG_PREDICATE_DISAPPEARED = "XWS_MOVED_TAG_PREDICATE_DISAPPEARED",
  XWS_MOVED_TAG_TEMPLATE_DISAPPEARED = "XWS_MOVED_TAG_TEMPLATE_DISAPPEARED",
  XWS_MOVE_BLOB_METADATA_CHANGED = "XWS_MOVE_BLOB_METADATA_CHANGED",
  XWS_MOVE_CONTENT_REVISION_CHANGED = "XWS_MOVE_CONTENT_REVISION_CHANGED",
  XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED = "XWS_MOVE_DATABASE_CHILD_OWNERSHIP_CHANGED",
  XWS_MOVE_DATABASE_CONTENT_CHANGED = "XWS_MOVE_DATABASE_CONTENT_CHANGED",
  XWS_MOVE_DATABASE_REVISION_IS_MISSING = "XWS_MOVE_DATABASE_REVISION_IS_MISSING",
  XWS_MOVE_DOCUMENT_ACL_CHANGED = "XWS_MOVE_DOCUMENT_ACL_CHANGED",
  XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING = "XWS_MOVE_DOCUMENT_CHILD_COUNT_IS_MISSING",
  XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED = "XWS_MOVE_DOCUMENT_CHILD_OWNERSHIP_CHANGED",
  XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED = "XWS_MOVE_DOCUMENT_CLASSIFICATIONS_CHANGED",
  XWS_MOVE_DOCUMENT_IDENTITY_CHANGED = "XWS_MOVE_DOCUMENT_IDENTITY_CHANGED",
  XWS_MOVE_DOCUMENT_METADATA_CHANGED = "XWS_MOVE_DOCUMENT_METADATA_CHANGED",
  XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED = "XWS_MOVE_DOCUMENT_OWNERSHIP_CHANGED",
  XWS_MOVE_DOCUMENT_REVISION_IS_MISSING = "XWS_MOVE_DOCUMENT_REVISION_IS_MISSING",
  XWS_MOVE_HISTORY_REFERENCES_CHANGED = "XWS_MOVE_HISTORY_REFERENCES_CHANGED",
  XWS_MOVE_MAPPING_CHANGED = "XWS_MOVE_MAPPING_CHANGED",
  XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED = "XWS_MOVE_NATIVE_REFERENCE_PLAN_CHANGED",
  XWS_MOVE_OPERATION_REVISION_CHANGED = "XWS_MOVE_OPERATION_REVISION_CHANGED",
  XWS_MOVE_ORGANIZER_REFERENCES_CHANGED = "XWS_MOVE_ORGANIZER_REFERENCES_CHANGED",
  XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED = "XWS_MOVE_PERSISTED_REVISION_MANIFEST_CHANGED",
  XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED = "XWS_MOVE_RECIPIENT_SNAPSHOT_CHANGED",
  XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW = "XWS_MOVE_REFERENCES_REQUIRE_A_FRESH_PREVIEW",
  XWS_MOVE_REFERENCE_PLAN_IS_MISSING = "XWS_MOVE_REFERENCE_PLAN_IS_MISSING",
  XWS_MOVE_REFERENCE_SOURCE_CHANGED = "XWS_MOVE_REFERENCE_SOURCE_CHANGED",
  XWS_MOVE_RELATED_ROWS_CHANGED = "XWS_MOVE_RELATED_ROWS_CHANGED",
  XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION = "XWS_MOVE_REVISION_CHANGED_DURING_PUBLICATION",
  XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED = "XWS_MOVE_REVISION_MANIFEST_REPLAY_CHANGED",
  XWS_MOVE_TAG_LINEAGE_IS_MISSING = "XWS_MOVE_TAG_LINEAGE_IS_MISSING",
  XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW = "XWS_MOVE_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW",
  XWS_MOVE_TAG_PLAN_CHANGED = "XWS_MOVE_TAG_PLAN_CHANGED",
  XWS_MOVE_TARGET_MISSING = "XWS_MOVE_TARGET_MISSING",
  XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED = "XWS_MOVE_TARGET_PAGE_DIRECTORY_CHANGED",
  XWS_MOVE_UNDO_FOLDER_CHANGED = "XWS_MOVE_UNDO_FOLDER_CHANGED",
  XWS_MOVE_WORKSPACE_POLICY_CHANGED = "XWS_MOVE_WORKSPACE_POLICY_CHANGED",
  XWS_MOVE_WORKSPACE_ROOT_CHANGED = "XWS_MOVE_WORKSPACE_ROOT_CHANGED",
  XWS_NATIVE_REFERENCE_PLAN_MISSING = "XWS_NATIVE_REFERENCE_PLAN_MISSING",
  XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED = "XWS_NATIVE_REFERENCE_SNAPSHOT_CHANGED",
  XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED = "XWS_NATIVE_REFERENCE_VERSION_UNSUPPORTED",
  XWS_OPERATION_MISSING = "XWS_OPERATION_MISSING",
  XWS_OPERATION_STATE_INVALID = "XWS_OPERATION_STATE_INVALID",
  XWS_ORGANIZER_CYCLE = "XWS_ORGANIZER_CYCLE",
  XWS_ORGANIZER_DECODE = "XWS_ORGANIZER_DECODE",
  XWS_ORGANIZER_DUPLICATE = "XWS_ORGANIZER_DUPLICATE",
  XWS_ORGANIZER_ENTRY_AT_ROOT = "XWS_ORGANIZER_ENTRY_AT_ROOT",
  XWS_ORGANIZER_ENTRY_MISSING = "XWS_ORGANIZER_ENTRY_MISSING",
  XWS_ORGANIZER_FOLDER_MISSING = "XWS_ORGANIZER_FOLDER_MISSING",
  XWS_ORGANIZER_KEY_INVALID = "XWS_ORGANIZER_KEY_INVALID",
  XWS_ORGANIZER_LINK_TYPE_INVALID = "XWS_ORGANIZER_LINK_TYPE_INVALID",
  XWS_ORGANIZER_MALFORMED_ROW = "XWS_ORGANIZER_MALFORMED_ROW",
  XWS_ORGANIZER_MUTATION_EMPTY = "XWS_ORGANIZER_MUTATION_EMPTY",
  XWS_ORGANIZER_NAME_INVALID = "XWS_ORGANIZER_NAME_INVALID",
  XWS_ORGANIZER_ORDER_INVALID = "XWS_ORGANIZER_ORDER_INVALID",
  XWS_ORGANIZER_PARENT_MISSING = "XWS_ORGANIZER_PARENT_MISSING",
  XWS_ORGANIZER_REINDEX_REQUIRED = "XWS_ORGANIZER_REINDEX_REQUIRED",
  XWS_ORGANIZER_REVISION_STALE = "XWS_ORGANIZER_REVISION_STALE",
  XWS_ORGANIZER_TARGET_INVALID = "XWS_ORGANIZER_TARGET_INVALID",
  XWS_ORGANIZER_WORKSPACE_TARGET_INVALID = "XWS_ORGANIZER_WORKSPACE_TARGET_INVALID",
  XWS_OWNED_BLOB_MAPPING_MISSING = "XWS_OWNED_BLOB_MAPPING_MISSING",
  XWS_OWNED_DOCUMENT_MISSING = "XWS_OWNED_DOCUMENT_MISSING",
  XWS_OWNED_TAG_CLASSIFICATION_CHANGED = "XWS_OWNED_TAG_CLASSIFICATION_CHANGED",
  XWS_OWNERSHIP_UNSUPPORTED = "XWS_OWNERSHIP_UNSUPPORTED",
  XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED = "XWS_PLANNED_TAG_IDENTITY_WAS_RETIRED",
  XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE = "XWS_PLANNED_TAG_IS_NO_LONGER_REUSABLE",
  XWS_PREFLIGHT_STALE = "XWS_PREFLIGHT_STALE",
  XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED = "XWS_PREPARED_TAG_IDENTITY_WAS_RETIRED",
  XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE = "XWS_PREPARED_TAG_IS_NO_LONGER_REUSABLE",
  XWS_PREVIEW_CONFIRMATION_MISMATCH = "XWS_PREVIEW_CONFIRMATION_MISMATCH",
  XWS_PUBLICATION_DEADLOCK = "XWS_PUBLICATION_DEADLOCK",
  XWS_PUBLICATION_KIND_INVALID = "XWS_PUBLICATION_KIND_INVALID",
  XWS_PUBLICATION_MAPPINGS_EMPTY = "XWS_PUBLICATION_MAPPINGS_EMPTY",
  XWS_PUBLICATION_SERIALIZATION_CONFLICT = "XWS_PUBLICATION_SERIALIZATION_CONFLICT",
  XWS_PUBLICATION_STAGING_UNEXPECTED = "XWS_PUBLICATION_STAGING_UNEXPECTED",
  XWS_PUBLICATION_STATE_INVALID = "XWS_PUBLICATION_STATE_INVALID",
  XWS_PUBLICATION_TERMINAL_CONFLICT = "XWS_PUBLICATION_TERMINAL_CONFLICT",
  XWS_PUBLICATION_WORKSPACE_MISSING = "XWS_PUBLICATION_WORKSPACE_MISSING",
  XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED = "XWS_PUBLISHED_EXTRACT_CANNOT_BE_COMPENSATED",
  XWS_RECIPIENTS_EMPTY = "XWS_RECIPIENTS_EMPTY",
  XWS_RECIPIENT_ACTOR_MISSING = "XWS_RECIPIENT_ACTOR_MISSING",
  XWS_RECIPIENT_BINDING_INVALID = "XWS_RECIPIENT_BINDING_INVALID",
  XWS_RECIPIENT_COUNT_INVALID = "XWS_RECIPIENT_COUNT_INVALID",
  XWS_RECIPIENT_DUPLICATE = "XWS_RECIPIENT_DUPLICATE",
  XWS_RECIPIENT_KINDS_INVALID = "XWS_RECIPIENT_KINDS_INVALID",
  XWS_RECIPIENT_REPLAY_CONFLICT = "XWS_RECIPIENT_REPLAY_CONFLICT",
  XWS_RECIPIENT_REVISION_INVALID = "XWS_RECIPIENT_REVISION_INVALID",
  XWS_RELATION_ROW_MISSING = "XWS_RELATION_ROW_MISSING",
  XWS_RELATION_TARGET_OUTSIDE_SELECTION = "XWS_RELATION_TARGET_OUTSIDE_SELECTION",
  XWS_REQUEST_INVALID = "XWS_REQUEST_INVALID",
  XWS_RESOURCE_COUNT_INVALID = "XWS_RESOURCE_COUNT_INVALID",
  XWS_RESOURCE_IDENTITY_AMBIGUOUS = "XWS_RESOURCE_IDENTITY_AMBIGUOUS",
  XWS_SELECTED_RESOURCE_UNSUPPORTED = "XWS_SELECTED_RESOURCE_UNSUPPORTED",
  XWS_SOURCE_BLOB_MISSING = "XWS_SOURCE_BLOB_MISSING",
  XWS_SOURCE_DATABASE_MISSING = "XWS_SOURCE_DATABASE_MISSING",
  XWS_SOURCE_DOCUMENT_MISSING = "XWS_SOURCE_DOCUMENT_MISSING",
  XWS_SOURCE_ROOT_MISSING = "XWS_SOURCE_ROOT_MISSING",
  XWS_SOURCE_TAG_INVALID = "XWS_SOURCE_TAG_INVALID",
  XWS_SOURCE_TAG_MISSING = "XWS_SOURCE_TAG_MISSING",
  XWS_SOURCE_WORKSPACE_MISSING = "XWS_SOURCE_WORKSPACE_MISSING",
  XWS_STAGING_MANIFEST_INVALID = "XWS_STAGING_MANIFEST_INVALID",
  XWS_STAGING_REPLAY_CONFLICT = "XWS_STAGING_REPLAY_CONFLICT",
  XWS_STORAGE_UNAVAILABLE = "XWS_STORAGE_UNAVAILABLE",
  XWS_TAG_ASSIGNMENT_CONSTRAINT = "XWS_TAG_ASSIGNMENT_CONSTRAINT",
  XWS_TAG_IDENTITY_CHANGED = "XWS_TAG_IDENTITY_CHANGED",
  XWS_TARGET_BLOB_BYTES_CONFLICT = "XWS_TARGET_BLOB_BYTES_CONFLICT",
  XWS_TARGET_BLOB_METADATA_CONFLICT = "XWS_TARGET_BLOB_METADATA_CONFLICT",
  XWS_TARGET_DEFINITION_CHANGED = "XWS_TARGET_DEFINITION_CHANGED",
  XWS_TARGET_DEFINITION_MISSING = "XWS_TARGET_DEFINITION_MISSING",
  XWS_TARGET_DOCUMENT_KEY_CONFLICT = "XWS_TARGET_DOCUMENT_KEY_CONFLICT",
  XWS_TARGET_STORAGE_LIMIT = "XWS_TARGET_STORAGE_LIMIT",
  XWS_TARGET_WORKSPACE_MISSING = "XWS_TARGET_WORKSPACE_MISSING",
  XWS_TRANSFER_FORBIDDEN = "XWS_TRANSFER_FORBIDDEN",
  XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT = "XWS_UNDO_EXTRACT_HAS_NO_MATCHING_PUBLISHED_FOLDER_RECEIPT",
  XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT = "XWS_UNDO_HAS_NO_COMMITTED_ORIGIN_RECEIPT",
  XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED = "XWS_UNDO_ORIGIN_LINEAGE_HASH_CHANGED",
  XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW = "XWS_UNDO_TAG_LINEAGE_REQUIRES_A_FRESH_PREVIEW",
  XWS_UNEXPECTED_VALIDATION = "XWS_UNEXPECTED_VALIDATION",
  XWS_WORKER_EXECUTION_FAILED = "XWS_WORKER_EXECUTION_FAILED",
  XWS_WORKER_RETRY_EXHAUSTED = "XWS_WORKER_RETRY_EXHAUSTED",
  XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED = "XWS_WORKSPACE_CONTENT_TARGET_MEMBERSHIP_CHANGED",
  XWS_WORKSPACE_NAME_CONFLICT = "XWS_WORKSPACE_NAME_CONFLICT",
}

export interface WorkspaceContentExecuteInput {
  confirmations: Array<WorkspaceContentConfirmationInput>;
  operationId: Scalars["UUID"]["input"];
  revision: Scalars["String"]["input"];
}

export enum WorkspaceContentGitSyncChoiceType {
  Disconnect = "Disconnect",
  Move = "Move",
}

export interface WorkspaceContentGitSyncPreflightType {
  __typename?: "WorkspaceContentGitSyncPreflightType";
  branch: Scalars["String"]["output"];
  choice: WorkspaceContentGitSyncChoiceType;
  intendedEnabled: Scalars["Boolean"]["output"];
  isUndo: Scalars["Boolean"]["output"];
  newRoot: Scalars["String"]["output"];
  ownManifest: Scalars["String"]["output"];
  repository: Scalars["String"]["output"];
  sourceProfileId: Scalars["UUID"]["output"];
}

export interface WorkspaceContentKindCountType {
  __typename?: "WorkspaceContentKindCountType";
  count: Scalars["Int"]["output"];
  kind: WorkspaceContentResourceKindType;
}

export interface WorkspaceContentMembershipImpactType {
  __typename?: "WorkspaceContentMembershipImpactType";
  currentRole: Maybe<Permission>;
  requiredCapability: WorkspaceContentRequiredCapabilityType;
  requiredRole: Permission;
  userId: Scalars["UUID"]["output"];
}

export enum WorkspaceContentOperationKindType {
  Copy = "Copy",
  ExtractFolder = "ExtractFolder",
  Link = "Link",
  Move = "Move",
}

export enum WorkspaceContentOperationStatusType {
  Cancelled = "Cancelled",
  CleanupRequired = "CleanupRequired",
  Draft = "Draft",
  Failed = "Failed",
  Previewed = "Previewed",
  Queued = "Queued",
  Running = "Running",
  Succeeded = "Succeeded",
}

export interface WorkspaceContentOperationType {
  __typename?: "WorkspaceContentOperationType";
  errorCode: Maybe<WorkspaceContentErrorCodeType>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  /** Actual failing boundary; older operation records can have no phase. */
  errorPhase: Maybe<Scalars["String"]["output"]>;
  gitSync: Maybe<WorkspaceContentGitSyncPreflightType>;
  gitSyncErrorCode: Maybe<WorkspaceContentErrorCodeType>;
  /** Content success is independent from outstanding external Git metadata. */
  gitSyncPending: Scalars["Boolean"]["output"];
  gitSyncRetryExhausted: Scalars["Boolean"]["output"];
  id: Scalars["UUID"]["output"];
  kind: WorkspaceContentOperationKindType;
  originOperationId: Maybe<Scalars["UUID"]["output"]>;
  revision: Maybe<Scalars["String"]["output"]>;
  sourceWorkspaceId: Scalars["UUID"]["output"];
  status: WorkspaceContentOperationStatusType;
  targetWorkspaceId: Maybe<Scalars["UUID"]["output"]>;
}

export interface WorkspaceContentPreflightInput {
  copyDocumentAcl?: InputMaybe<Scalars["Boolean"]["input"]>;
  extractWorkspaceName?: InputMaybe<Scalars["String"]["input"]>;
  folderId?: InputMaybe<Scalars["String"]["input"]>;
  gitSyncChoice?: InputMaybe<WorkspaceContentGitSyncChoiceType>;
  idempotencyId: Scalars["UUID"]["input"];
  kind: WorkspaceContentOperationKindType;
  linkEntryId?: InputMaybe<Scalars["String"]["input"]>;
  linkIndex?: InputMaybe<Scalars["String"]["input"]>;
  linkParentId?: InputMaybe<Scalars["String"]["input"]>;
  resources?: InputMaybe<Array<WorkspaceContentResourceInput>>;
  sourceWorkspaceId: Scalars["UUID"]["input"];
  targetWorkspaceId?: InputMaybe<Scalars["UUID"]["input"]>;
}

export interface WorkspaceContentPreflightType {
  __typename?: "WorkspaceContentPreflightType";
  blockers: Array<WorkspaceContentBlockerType>;
  conflicts: Array<WorkspaceContentConflictType>;
  gitSync: Maybe<WorkspaceContentGitSyncPreflightType>;
  membershipImpactCount: Scalars["Int"]["output"];
  membershipImpacts: Array<WorkspaceContentMembershipImpactType>;
  /**
   * Identities only: preflight may be denied read permission on a linked
   * resource, so titles and content are never projected in blocker details.
   */
  missingResources: Array<WorkspaceContentResourceType>;
  operation: WorkspaceContentOperationType;
  requiredConfirmations: Array<WorkspaceContentConfirmationType>;
  resourceCount: Scalars["Int"]["output"];
  resourceCounts: Array<WorkspaceContentKindCountType>;
  revision: Scalars["String"]["output"];
}

export interface WorkspaceContentRedirectInput {
  resource: WorkspaceContentResourceInput;
  workspaceId: Scalars["UUID"]["input"];
}

export interface WorkspaceContentRedirectType {
  __typename?: "WorkspaceContentRedirectType";
  id: Scalars["String"]["output"];
  kind: WorkspaceContentResourceKindType;
  workspaceId: Scalars["UUID"]["output"];
}

export enum WorkspaceContentRequiredCapabilityType {
  AdministratorsManage = "AdministratorsManage",
  UsersManage = "UsersManage",
}

export interface WorkspaceContentResourceInput {
  id: Scalars["String"]["input"];
  kind: WorkspaceContentResourceKindType;
}

export enum WorkspaceContentResourceKindType {
  Blob = "Blob",
  Collection = "Collection",
  Database = "Database",
  Document = "Document",
  Folder = "Folder",
  Tag = "Tag",
}

export interface WorkspaceContentResourceType {
  __typename?: "WorkspaceContentResourceType";
  id: Scalars["String"]["output"];
  kind: WorkspaceContentResourceKindType;
  workspaceId: Scalars["UUID"]["output"];
}

export interface WorkspaceCreationResultType {
  __typename?: "WorkspaceCreationResultType";
  acceptedPlan: Maybe<PreparedWorkspaceAssistant>;
  assistanceSaved: Scalars["Boolean"]["output"];
  projectSetup: Maybe<ProjectSetup>;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  requestId: Scalars["ID"]["output"];
  retryRequired: Scalars["Boolean"]["output"];
  rootReady: Scalars["Boolean"]["output"];
  setup: Maybe<WorkspaceSetup>;
  status: WorkspaceCreationStatus;
  tasksDatabaseId: Maybe<Scalars["ID"]["output"]>;
  tasksReady: Scalars["Boolean"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export enum WorkspaceCreationStatus {
  AssistancePending = "AssistancePending",
  Ready = "Ready",
  Unavailable = "Unavailable",
}

export enum WorkspaceDashboardDashletId {
  Activity = "Activity",
  NewDocuments = "NewDocuments",
  RecentlyEdited = "RecentlyEdited",
  Reminders = "Reminders",
  Tasks = "Tasks",
  Today = "Today",
}

export enum WorkspaceDashboardDashletSize {
  Compact = "Compact",
  Standard = "Standard",
  Wide = "Wide",
}

export interface WorkspaceDashboardDashletSizeOverrideInput {
  dashletId: WorkspaceDashboardDashletId;
  size: WorkspaceDashboardDashletSize;
}

export interface WorkspaceDashboardDashletSizeOverrideType {
  __typename?: "WorkspaceDashboardDashletSizeOverrideType";
  dashletId: WorkspaceDashboardDashletId;
  size: WorkspaceDashboardDashletSize;
}

export interface WorkspaceDashboardLayoutInput {
  dashletSizes: Array<WorkspaceDashboardDashletSizeOverrideInput>;
  orderedDashletIds: Array<WorkspaceDashboardDashletId>;
  workspaceId: Scalars["ID"]["input"];
}

export interface WorkspaceDashboardLayoutType {
  __typename?: "WorkspaceDashboardLayoutType";
  dashletSizes: Array<WorkspaceDashboardDashletSizeOverrideType>;
  orderedDashletIds: Array<WorkspaceDashboardDashletId>;
  workspaceId: Scalars["ID"]["output"];
}

/** Cloud page metadata: author and timestamp information. */
export interface WorkspaceDocMeta {
  __typename?: "WorkspaceDocMeta";
  createdAt: Scalars["DateTime"]["output"];
  createdBy: Maybe<EditorType>;
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<EditorType>;
}

export interface WorkspaceDocType {
  __typename?: "WorkspaceDocType";
  /** Doc page analytics — daily view counts in a time window. */
  analytics: DocPageAnalytics;
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  defaultRole: DocRole;
  grantedUsersList: PaginatedDocGrantedUserType;
  id: Scalars["String"]["output"];
  /** Paginated last-accessed members for this doc. */
  lastAccessedMembers: PaginatedDocMemberLastAccess;
  mode: PublicDocMode;
  permissions: DocPermissionsType;
  public: Scalars["Boolean"]["output"];
  summary: Maybe<Scalars["String"]["output"]>;
  title: Maybe<Scalars["String"]["output"]>;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

export interface WorkspaceDocTypeAnalyticsArgs {
  input?: InputMaybe<DocPageAnalyticsInput>;
}

export interface WorkspaceDocTypeGrantedUsersListArgs {
  pagination?: InputMaybe<PaginationInput>;
}

export interface WorkspaceDocTypeLastAccessedMembersArgs {
  includeTotal?: Scalars["Boolean"]["input"];
  pagination: PaginationInput;
  query?: InputMaybe<Scalars["String"]["input"]>;
}

export interface WorkspaceDocumentMetadataVisibilityInput {
  fields: Array<DocumentMetadataFieldVisibilityInput>;
  workspaceId: Scalars["ID"]["input"];
}

export interface WorkspaceDocumentMetadataVisibilityType {
  __typename?: "WorkspaceDocumentMetadataVisibilityType";
  fields: Array<DocumentMetadataFieldVisibilityType>;
  workspaceId: Scalars["ID"]["output"];
}

export interface WorkspaceDocumentSettingsType {
  __typename?: "WorkspaceDocumentSettingsType";
  defaultClassificationId: Maybe<Scalars["ID"]["output"]>;
  defaultDocumentTypeId: Maybe<Scalars["ID"]["output"]>;
  defaultRetentionPolicyId: Maybe<Scalars["ID"]["output"]>;
  defaultStatusId: Maybe<Scalars["ID"]["output"]>;
  statusSchemaId: Maybe<Scalars["ID"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
  updatedBy: Maybe<Scalars["ID"]["output"]>;
  versionPolicyId: Maybe<Scalars["ID"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

/** Authorized list snippet backed only by the asynchronous search projection. */
export interface WorkspaceDocumentSnippetType {
  __typename?: "WorkspaceDocumentSnippetType";
  /** Client-visible document key. */
  docId: Scalars["String"]["output"];
  /** Search projection freshness, distinct from the source document timestamp. */
  indexedAt: Maybe<Scalars["DateTime"]["output"]>;
  /** Normalized list text; null when the index has no text or no row yet. */
  snippet: Maybe<Scalars["String"]["output"]>;
}

export interface WorkspaceEmbeddingType {
  __typename?: "WorkspaceEmbeddingType";
  allIgnoredDocs: Array<CopilotIgnoredDocBasic>;
  files: PaginatedCopilotWorkspaceFiles;
  ignoredDocs: PaginatedCopilotIgnoredDocs;
}

export interface WorkspaceEmbeddingTypeFilesArgs {
  pagination?: InputMaybe<PaginationInput>;
}

export interface WorkspaceEmbeddingTypeIgnoredDocsArgs {
  pagination?: InputMaybe<PaginationInput>;
}

export enum WorkspaceHistorySettingSourceType {
  server = "server",
  workspace = "workspace",
}

export interface WorkspaceHistorySettingsType {
  __typename?: "WorkspaceHistorySettingsType";
  autoVersionOn: Maybe<Array<AutoVersionTriggerType>>;
  editCaptureEnabled: Maybe<Scalars["Boolean"]["output"]>;
  editCaptureIntervalMs: Maybe<Scalars["Int"]["output"]>;
  effectiveAutoVersionOn: Array<AutoVersionTriggerType>;
  effectiveEditCaptureEnabled: Scalars["Boolean"]["output"];
  effectiveEditCaptureIntervalMs: Scalars["Int"]["output"];
  effectiveNamedVersioningEnabled: Scalars["Boolean"]["output"];
  effectiveRetentionCount: Scalars["Int"]["output"];
  enabledSource: WorkspaceHistorySettingSourceType;
  intervalSource: WorkspaceHistorySettingSourceType;
  lastEditCaptureAt: Maybe<Scalars["DateTime"]["output"]>;
  legacyIntervalNormalized: Scalars["Boolean"]["output"];
  namedVersioningEnabled: Maybe<Scalars["Boolean"]["output"]>;
  retentionCount: Maybe<Scalars["Int"]["output"]>;
  revision: Scalars["String"]["output"];
  runtimeAvailable: Scalars["Boolean"]["output"];
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface WorkspaceImportCountsType {
  __typename?: "WorkspaceImportCountsType";
  assets: Scalars["Int"]["output"];
  cells: Scalars["Int"]["output"];
  databases: Scalars["Int"]["output"];
  documents: Scalars["Int"]["output"];
  fields: Scalars["Int"]["output"];
  rows: Scalars["Int"]["output"];
  views: Scalars["Int"]["output"];
}

export interface WorkspaceImportDiagnosticType {
  __typename?: "WorkspaceImportDiagnosticType";
  code: Scalars["String"]["output"];
  context: Maybe<Scalars["JSON"]["output"]>;
  message: Scalars["String"]["output"];
  severity: Scalars["String"]["output"];
}

export interface WorkspaceImportPartManifestInput {
  contentHash: Scalars["String"]["input"];
  partNumber: Scalars["Int"]["input"];
  sizeBytes: Scalars["Int"]["input"];
}

export interface WorkspaceImportPartUploadType {
  __typename?: "WorkspaceImportPartUploadType";
  contentHash: Scalars["String"]["output"];
  partNumber: Scalars["Int"]["output"];
  sizeBytes: Scalars["Int"]["output"];
  uploadUrl: Scalars["String"]["output"];
}

export interface WorkspaceImportPreviewType {
  __typename?: "WorkspaceImportPreviewType";
  applyAllowed: Scalars["Boolean"]["output"];
  configFingerprint: Scalars["String"]["output"];
  counts: WorkspaceImportCountsType;
  detectedFormat: Scalars["String"]["output"];
  diagnostics: Array<WorkspaceImportDiagnosticType>;
  omittedCounts: Scalars["JSON"]["output"];
  planFingerprint: Scalars["String"]["output"];
  proposedWorkspaceTitle: Scalars["String"]["output"];
  sourceHash: Scalars["String"]["output"];
  sourceRoot: Scalars["String"]["output"];
  targetPlan: WorkspaceImportTargetPlanType;
}

export enum WorkspaceImportSourceFormatInput {
  ObsidianZip = "ObsidianZip",
}

export interface WorkspaceImportTargetPlanType {
  __typename?: "WorkspaceImportTargetPlanType";
  assetIds: Array<Scalars["ID"]["output"]>;
  databaseIds: Array<Scalars["ID"]["output"]>;
  documentIds: Array<Scalars["ID"]["output"]>;
  tagIds: Array<Scalars["ID"]["output"]>;
  vault: Maybe<Scalars["JSON"]["output"]>;
  workspaceId: Scalars["ID"]["output"];
}

export interface WorkspaceImportType {
  __typename?: "WorkspaceImportType";
  cancelRequested: Scalars["Boolean"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  errorCode: Maybe<Scalars["String"]["output"]>;
  errorMessage: Maybe<Scalars["String"]["output"]>;
  expiresAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  preview: Maybe<WorkspaceImportPreviewType>;
  progressCurrent: Scalars["Int"]["output"];
  progressStage: Maybe<Scalars["String"]["output"]>;
  progressTotal: Scalars["Int"]["output"];
  queuedOperation: Maybe<Scalars["String"]["output"]>;
  status: Scalars["String"]["output"];
  targetWorkspaceId: Maybe<Scalars["ID"]["output"]>;
  updatedAt: Scalars["DateTime"]["output"];
}

export interface WorkspaceImportUploadType {
  __typename?: "WorkspaceImportUploadType";
  expiresAt: Scalars["DateTime"]["output"];
  partSizeBytes: Scalars["Int"]["output"];
  parts: Array<WorkspaceImportPartUploadType>;
  workspaceImportId: Scalars["ID"]["output"];
}

export enum WorkspaceInitialContent {
  Empty = "Empty",
}

export enum WorkspaceInitialContentPolicy {
  Empty = "Empty",
  LegacyDefaults = "LegacyDefaults",
}

/** Duration options for workspace invite link expiry. */
export enum WorkspaceInviteLinkExpireTime {
  OneDay = "OneDay",
  OneMonth = "OneMonth",
  OneWeek = "OneWeek",
  ThreeDays = "ThreeDays",
}

/** Workspace invite link details returned after link creation. */
export interface WorkspaceInviteLinkType {
  __typename?: "WorkspaceInviteLinkType";
  /** Expiry time as a Unix epoch millisecond value (float for JS compatibility). */
  expireTime: Scalars["Float"]["output"];
  /** Opaque invite ID encoded in the link URL. */
  inviteId: Scalars["String"]["output"];
  /** UUID of the workspace the link grants access to. */
  workspaceId: Scalars["String"]["output"];
}

/** GraphQL enum for the lifecycle state of a workspace membership invitation. */
export enum WorkspaceMemberStatus {
  /** Membership is active. */
  Accepted = "Accepted",
  /** A seat is being allocated for the new member. */
  AllocatingSeat = "AllocatingSeat",
  /** The workspace has no available seats for this member. */
  NeedMoreSeat = "NeedMoreSeat",
  /** Invitation sent but not yet accepted. */
  Pending = "Pending",
  /** Membership was revoked. */
  Revoked = "Revoked",
  /** Membership is being reviewed by the workspace owner. */
  UnderReview = "UnderReview",
}

export interface WorkspaceOverviewDocumentType {
  __typename?: "WorkspaceOverviewDocumentType";
  canEdit: Scalars["Boolean"]["output"];
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  createdByName: Maybe<Scalars["String"]["output"]>;
  metadata: Maybe<DocumentMetadataIndexRowType>;
  metadataLabels: Maybe<WorkspaceOverviewMetadataLabelsType>;
  resource: WorkspaceContentResourceType;
  tags: Array<WorkspaceTag>;
  title: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

export interface WorkspaceOverviewFolderSettingsType {
  __typename?: "WorkspaceOverviewFolderSettingsType";
  folderId: Scalars["String"]["output"];
  introduction: Maybe<WorkspaceContentResourceType>;
  registerPresentation: Maybe<WorkspaceOverviewRegisterPresentationType>;
}

export interface WorkspaceOverviewFolderType {
  __typename?: "WorkspaceOverviewFolderType";
  id: Scalars["String"]["output"];
  name: Scalars["String"]["output"];
}

export interface WorkspaceOverviewMetadataLabelsType {
  __typename?: "WorkspaceOverviewMetadataLabelsType";
  classificationLabel: Maybe<Scalars["String"]["output"]>;
  documentTypeLabel: Maybe<Scalars["String"]["output"]>;
  statusLabel: Maybe<Scalars["String"]["output"]>;
  versionLabel: Maybe<Scalars["String"]["output"]>;
}

export interface WorkspaceOverviewOrderByInput {
  desc: Scalars["Boolean"]["input"];
  key: Scalars["String"]["input"];
  type: Scalars["String"]["input"];
}

export interface WorkspaceOverviewOrderByType {
  __typename?: "WorkspaceOverviewOrderByType";
  desc: Scalars["Boolean"]["output"];
  key: Scalars["String"]["output"];
  type: Scalars["String"]["output"];
}

/**
 * Authorized page facts only. The workspace row and its private bindings stay
 * with the native settings owner rather than becoming a generic JSON payload.
 */
export interface WorkspaceOverviewPageType {
  __typename?: "WorkspaceOverviewPageType";
  breadcrumbs: Array<WorkspaceOverviewFolderType>;
  children: Array<WorkspaceOverviewFolderType>;
  documentCount: Scalars["Int"]["output"];
  documents: Array<WorkspaceOverviewDocumentType>;
  folder: Maybe<WorkspaceOverviewFolderType>;
  hasMore: Scalars["Boolean"]["output"];
  introduction: Maybe<WorkspaceOverviewDocumentType>;
  introductionUnavailable: Scalars["Boolean"]["output"];
  limit: Scalars["Int"]["output"];
  offset: Scalars["Int"]["output"];
  registerPresentation: Maybe<WorkspaceOverviewRegisterPresentationType>;
}

export interface WorkspaceOverviewRegisterPresentationInput {
  displayProperties: Array<Scalars["String"]["input"]>;
  orderBy: WorkspaceOverviewOrderByInput;
}

export interface WorkspaceOverviewRegisterPresentationType {
  __typename?: "WorkspaceOverviewRegisterPresentationType";
  displayProperties: Array<Scalars["String"]["output"]>;
  orderBy: WorkspaceOverviewOrderByType;
}

/** Existing workspace settings update, scoped to its root or one Organizer folder. */
export interface WorkspaceOverviewSettingsInput {
  expectedRevision: Scalars["Int"]["input"];
  folderId?: InputMaybe<Scalars["String"]["input"]>;
  /** Omission preserves selection; null admits all branches; [] hides navigation. */
  folderIds?: InputMaybe<Array<Scalars["String"]["input"]>>;
  /** Omission preserves the binding; null clears it without deleting its Page. */
  introduction?: InputMaybe<WorkspaceContentResourceInput>;
  /** Omission preserves presentation; null clears this scope's override. */
  registerPresentation?: InputMaybe<WorkspaceOverviewRegisterPresentationInput>;
}

/** Private presentation bindings, readable only by workspace settings editors. */
export interface WorkspaceOverviewSettingsType {
  __typename?: "WorkspaceOverviewSettingsType";
  folderIds: Maybe<Array<Scalars["String"]["output"]>>;
  folders: Array<WorkspaceOverviewFolderSettingsType>;
  introduction: Maybe<WorkspaceContentResourceType>;
  registerPresentation: Maybe<WorkspaceOverviewRegisterPresentationType>;
  revision: Scalars["Int"]["output"];
}

export interface WorkspacePermissionNotFoundDataType {
  __typename?: "WorkspacePermissionNotFoundDataType";
  message: Scalars["String"]["output"];
}

/**
 * Full permission matrix for a workspace membership, computed from the member's role.
 *
 * Each boolean field corresponds to a [`WorkspaceAction`] and is derived via
 * [`WorkspacePermissions::from_role`].
 */
export interface WorkspacePermissions {
  __typename?: "WorkspacePermissions";
  Workspace_Administrators_Manage: Scalars["Boolean"]["output"];
  Workspace_Blobs_List: Scalars["Boolean"]["output"];
  Workspace_Blobs_Read: Scalars["Boolean"]["output"];
  Workspace_Blobs_Write: Scalars["Boolean"]["output"];
  Workspace_Content_Transfer: Scalars["Boolean"]["output"];
  Workspace_Copilot: Scalars["Boolean"]["output"];
  Workspace_CreateDoc: Scalars["Boolean"]["output"];
  Workspace_Delete: Scalars["Boolean"]["output"];
  Workspace_Organize_Read: Scalars["Boolean"]["output"];
  Workspace_Organize_Update: Scalars["Boolean"]["output"];
  /**
   * Compatibility-only field for clients that still select the removed paid
   * workspace capability. Myoxus has no payment-management product action,
   * so every role receives the neutral value `false`.
   */
  Workspace_Payment_Manage: Scalars["Boolean"]["output"];
  Workspace_Properties_Create: Scalars["Boolean"]["output"];
  Workspace_Properties_Delete: Scalars["Boolean"]["output"];
  Workspace_Properties_Read: Scalars["Boolean"]["output"];
  Workspace_Properties_Update: Scalars["Boolean"]["output"];
  Workspace_Read: Scalars["Boolean"]["output"];
  Workspace_Settings_Read: Scalars["Boolean"]["output"];
  Workspace_Settings_Update: Scalars["Boolean"]["output"];
  Workspace_Sync: Scalars["Boolean"]["output"];
  Workspace_Transcription: Scalars["Boolean"]["output"];
  Workspace_TransferOwner: Scalars["Boolean"]["output"];
  Workspace_Users_Manage: Scalars["Boolean"]["output"];
  Workspace_Users_Read: Scalars["Boolean"]["output"];
}

/**
 * Optional composition stays within the outer Workspace request. The package
 * and answers are distinct from the common Empty allocation descriptor.
 */
export interface WorkspaceProjectSetupInput {
  answers: Scalars["JSON"]["input"];
  clientVersion?: InputMaybe<Scalars["Int"]["input"]>;
  locale?: InputMaybe<Scalars["String"]["input"]>;
  package: AssistantPackageIdentityInput;
}

/**
 * Full quota state for a single workspace — returned by `adminWorkspaceQuotaDetails`.
 *
 * Exposes the raw values at every level of the priority hierarchy alongside
 * the resolved effective quota and current usage, so the admin inspector can
 * display both the active source and all configured overrides at a glance.
 */
export interface WorkspaceQuotaDetailsType {
  __typename?: "WorkspaceQuotaDetailsType";
  /** Config-level default in megabytes (server config). 0 = unlimited at config level. */
  configDefaultMb: Scalars["Int"]["output"];
  /** Resolved effective quota in bytes. 0 = unlimited. */
  effectiveBytes: Scalars["Int"]["output"];
  /** Which level of the hierarchy determined the effective quota. */
  source: WorkspaceQuotaSource;
  /** Current total storage usage in bytes (snapshot + blob). */
  usedBytes: Scalars["Int"]["output"];
  /** Workspace-level storage override in bytes. `null` = not set. */
  workspaceOverrideBytes: Maybe<Scalars["Int"]["output"]>;
}

/**
 * Which level of the 4-level priority hierarchy is currently determining the
 * effective storage quota for a workspace.
 *
 * Mirrors [`myoxus_application::quota::QuotaSource`] for the GraphQL schema.
 */
export enum WorkspaceQuotaSource {
  /** Global config default applies (no workspace override). */
  ConfigDefault = "ConfigDefault",
  /** No quota — unlimited storage. */
  Unlimited = "Unlimited",
  /** Workspace-level override is active (`workspaces.storage_quota_bytes` is set). */
  WorkspaceOverride = "WorkspaceOverride",
}

/** A role paired with its derived permission matrix. */
export interface WorkspaceRolePermissions {
  __typename?: "WorkspaceRolePermissions";
  permissions: WorkspacePermissions;
  role: Permission;
}

/**
 * Lightweight workspace search hit returned by `adminSearchWorkspaces`.
 *
 * Powers the admin workspace-picker (`P-AR-0-S03`). Includes the owner
 * snapshot (id + email) and every OU id this workspace is linked to —
 * regardless of relationship (`owner` / `managed` / `linked`).
 */
export interface WorkspaceSearchResult {
  __typename?: "WorkspaceSearchResult";
  /** Workspace id. */
  id: Scalars["ID"]["output"];
  /** All OU ids this workspace is linked to (any relationship). */
  linkedOuIds: Array<Scalars["ID"]["output"]>;
  /** Workspace display name. */
  name: Scalars["String"]["output"];
  /** Owner email snapshot (nullable when the owner user row was deleted). */
  ownerEmail: Maybe<Scalars["String"]["output"]>;
  /** Owner user id (nullable for orphaned/system-owned workspaces). */
  ownerUserId: Maybe<Scalars["ID"]["output"]>;
}

export interface WorkspaceSetup {
  __typename?: "WorkspaceSetup";
  acceptedDescriptor: Maybe<AssistantPackage>;
  acceptedPlan: PreparedWorkspaceSetup;
  canRetry: Scalars["Boolean"]["output"];
  canStop: Scalars["Boolean"]["output"];
  components: Array<WorkspaceSetupComponent>;
  currentReview: Maybe<PreparedWorkspaceSetup>;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  requestId: Scalars["ID"]["output"];
  run: Maybe<WorkspaceAutomationRunType>;
  status: ProjectSetupStatus;
}

export interface WorkspaceSetupAssistance {
  __typename?: "WorkspaceSetupAssistance";
  descriptor: AssistantPackage;
  documentTargets: Array<WorkspaceSetupDocumentTarget>;
}

export interface WorkspaceSetupComponent {
  __typename?: "WorkspaceSetupComponent";
  available: Scalars["Boolean"]["output"];
  componentId: Scalars["String"]["output"];
  documentExternalId: Maybe<Scalars["String"]["output"]>;
  reservedId: Scalars["ID"]["output"];
  result: Maybe<WorkspaceSetupResult>;
}

export interface WorkspaceSetupDocumentTarget {
  __typename?: "WorkspaceSetupDocumentTarget";
  componentId: Scalars["String"]["output"];
  documentExternalId: Scalars["String"]["output"];
  documentId: Scalars["ID"]["output"];
  group: Scalars["String"]["output"];
  sourceDigest: Scalars["String"]["output"];
  step: Scalars["String"]["output"];
}

/**
 * Optional authored content shares the allocation request and its native receipt.
 * Confirmed locale/client values are retained verbatim for uncertain replay.
 */
export interface WorkspaceSetupInput {
  answers: Scalars["JSON"]["input"];
  clientVersion: Scalars["Int"]["input"];
  locale: Scalars["String"]["input"];
  package: AssistantPackageIdentityInput;
}

export interface WorkspaceSetupResult {
  __typename?: "WorkspaceSetupResult";
  databaseId: Maybe<Scalars["ID"]["output"]>;
  documentId: Maybe<Scalars["ID"]["output"]>;
  entryId: Maybe<Scalars["String"]["output"]>;
  kind: WorkspaceSetupResultKind;
}

export enum WorkspaceSetupResultKind {
  Database = "Database",
  Document = "Document",
  NativeLink = "NativeLink",
}

export interface WorkspaceTag {
  __typename?: "WorkspaceTag";
  archived: Scalars["Boolean"]["output"];
  archivedAt: Maybe<Scalars["DateTime"]["output"]>;
  colorRole: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  description: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  name: Scalars["String"]["output"];
  slug: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["ID"]["output"];
}

export interface WorkspaceTagBootstrapResultObjectType {
  __typename?: "WorkspaceTagBootstrapResultObjectType";
  colorNormalizations: Array<WorkspaceTagColorNormalizationObjectType>;
  importedAssignments: Scalars["Int"]["output"];
  importedTags: Scalars["Int"]["output"];
  legacyIdMappings: Array<WorkspaceTagLegacyIdMappingObjectType>;
  reusedTags: Scalars["Int"]["output"];
  tags: Array<WorkspaceTag>;
}

export interface WorkspaceTagCatalogEntry {
  __typename?: "WorkspaceTagCatalogEntry";
  databaseRowCount: Scalars["Int"]["output"];
  documentCount: Scalars["Int"]["output"];
  tag: WorkspaceTag;
}

export interface WorkspaceTagColorNormalizationObjectType {
  __typename?: "WorkspaceTagColorNormalizationObjectType";
  colorRole: Scalars["String"]["output"];
  legacyId: Scalars["String"]["output"];
  normalized: Scalars["Boolean"]["output"];
  sourceColor: Scalars["String"]["output"];
}

export interface WorkspaceTagDatabaseRowUsage {
  __typename?: "WorkspaceTagDatabaseRowUsage";
  databaseId: Scalars["ID"]["output"];
  databaseTitle: Scalars["String"]["output"];
  rowId: Scalars["ID"]["output"];
  rowTitle: Scalars["String"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
}

/** A null assignment is unavailable; an empty list confirms no assigned labels. */
export interface WorkspaceTagDocumentAssignment {
  __typename?: "WorkspaceTagDocumentAssignment";
  externalId: Scalars["ID"]["output"];
  tagIds: Maybe<Array<Scalars["ID"]["output"]>>;
}

export interface WorkspaceTagDocumentUsage {
  __typename?: "WorkspaceTagDocumentUsage";
  externalId: Scalars["ID"]["output"];
  title: Scalars["String"]["output"];
}

export interface WorkspaceTagDocumentUsagePage {
  __typename?: "WorkspaceTagDocumentUsagePage";
  items: Array<WorkspaceTagDocumentUsage>;
  nextOffset: Maybe<Scalars["Int"]["output"]>;
}

export interface WorkspaceTagLegacyIdMappingObjectType {
  __typename?: "WorkspaceTagLegacyIdMappingObjectType";
  legacyId: Scalars["String"]["output"];
  tagId: Scalars["ID"]["output"];
}

export interface WorkspaceTagLifecycleInput {
  tagId: Scalars["ID"]["input"];
  workspaceId: Scalars["ID"]["input"];
}

export interface WorkspaceTagTransfer {
  __typename?: "WorkspaceTagTransfer";
  diagnostics: Scalars["JSON"]["output"];
  mappings: Scalars["JSON"]["output"];
  tags: Array<WorkspaceTag>;
}

export interface WorkspaceTemplateContextType {
  __typename?: "WorkspaceTemplateContextType";
  organizationName: Maybe<Scalars["String"]["output"]>;
  organizationUnitName: Maybe<Scalars["String"]["output"]>;
  /** Requested automatic document-template facts only; no generic context API. */
  requestedValues: Scalars["JSON"]["output"];
}

export interface WorkspaceTemplateContextTypeRequestedValuesArgs {
  deferCreation?: Scalars["Boolean"]["input"];
  folderId?: InputMaybe<Scalars["String"]["input"]>;
  parentDocId?: InputMaybe<Scalars["String"]["input"]>;
  requested: Array<Scalars["String"]["input"]>;
  targetDocId?: InputMaybe<Scalars["String"]["input"]>;
}

/** A workspace template instance as exposed via GraphQL. */
export interface WorkspaceTemplateInstanceType {
  __typename?: "WorkspaceTemplateInstanceType";
  currentHash: Maybe<Scalars["String"]["output"]>;
  detachedAt: Maybe<Scalars["DateTime"]["output"]>;
  id: Scalars["ID"]["output"];
  lastAppliedHash: Maybe<Scalars["String"]["output"]>;
  lastErrorCode: Maybe<Scalars["String"]["output"]>;
  lastErrorMessage: Maybe<Scalars["String"]["output"]>;
  lastSyncedAt: Maybe<Scalars["DateTime"]["output"]>;
  retiredAt: Maybe<Scalars["DateTime"]["output"]>;
  revisionId: Scalars["ID"]["output"];
  state: InstanceStateType;
  templateId: Scalars["ID"]["output"];
  workspaceDocId: Maybe<Scalars["String"]["output"]>;
  workspaceId: Scalars["String"]["output"];
}

/** A workspace template policy as exposed via GraphQL. */
export interface WorkspaceTemplatePolicyType {
  __typename?: "WorkspaceTemplatePolicyType";
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  isEnabled: Scalars["Boolean"]["output"];
  provisioningMode: ProvisioningModeType;
  selectedRevisionId: Maybe<Scalars["ID"]["output"]>;
  selectionMode: SelectionModeType;
  templateId: Scalars["ID"]["output"];
  updatedAt: Scalars["DateTime"]["output"];
  workspaceId: Scalars["String"]["output"];
}

export interface WorkspaceTemplateSourcePageType {
  __typename?: "WorkspaceTemplateSourcePageType";
  nextOffset: Maybe<Scalars["Int"]["output"]>;
  sources: Array<WorkspaceTemplateSourceType>;
}

export interface WorkspaceTemplateSourceType {
  __typename?: "WorkspaceTemplateSourceType";
  category: Maybe<Scalars["String"]["output"]>;
  description: Maybe<Scalars["String"]["output"]>;
  /** Workspace-local native document key, not a Registry revision ID. */
  docId: Scalars["ID"]["output"];
  documentRevision: Scalars["Int"]["output"];
  identifier: Maybe<Scalars["String"]["output"]>;
  locale: Maybe<Scalars["String"]["output"]>;
  metadataRevision: Scalars["Int"]["output"];
  origin: Maybe<Scalars["String"]["output"]>;
  tags: Array<Scalars["String"]["output"]>;
  title: Scalars["String"]["output"];
  titlePolicy: Maybe<Scalars["String"]["output"]>;
  version: Maybe<Scalars["String"]["output"]>;
}

export interface WorkspaceType {
  __typename?: "WorkspaceType";
  aggregate: AggregateResultObjectType;
  assistantDocumentSource: Maybe<TemplateSuggestionItem>;
  assistantPackages: Array<AssistantPackage>;
  assistantPresentation: AssistantResolvedPresentation;
  automationRuns: Array<WorkspaceAutomationRunType>;
  automations: Array<WorkspaceAutomationType>;
  blobUploadPartUrl: BlobUploadPartType;
  blobs: Array<ListedBlobType>;
  blobsSize: Scalars["Int"]["output"];
  /** Complexity 20: permission check + two DB queries (accounts + workspace calendars). */
  calendars: Array<WorkspaceCalendarObjectType>;
  /** Complexity 50: permission check + thread list + change assembly. */
  commentChanges: PaginatedCommentChangeObjectType;
  /** Complexity 50: permission check + thread list + per-thread reply fetches + batch author lookup. */
  comments: PaginatedCommentObjectType;
  contextDocuments: Maybe<ContextDocuments>;
  createdAt: Scalars["DateTime"]["output"];
  creation: Maybe<WorkspaceCreationResultType>;
  database: Maybe<DatabaseRecord>;
  /** P-DB-24: workspace-visible database activity stream. */
  databaseActivity: Array<DatabaseActivityEvent>;
  databaseCsvExport: DatabaseCsvExport;
  /**
   * P-DB-27: list every current CSV mapping template for the
   * workspace, ordered most-recently-updated first. Used by the
   * wizard's "reuse template" dropdown.
   */
  databaseCsvMappingTemplates: Array<DatabaseCsvMappingTemplateSummary>;
  databaseEffectiveViewState: DatabaseEffectiveViewStateType;
  databaseJsonExport: DatabaseJsonExport;
  /** Count-free active Database identities for mixed Document/Database lists. */
  databasePageIdentities: Array<DatabasePageIdentity>;
  databaseProgress: DatabaseProgressSummary;
  /**
   * Read the canonical Row. Trash inclusion is explicit and grants no write
   * authority; existing editable consumers retain the live-only default.
   */
  databaseRow: Maybe<DatabaseRowRecord>;
  /** P-DB-24: per-row database activity stream. */
  databaseRowActivity: Array<DatabaseActivityEvent>;
  databaseRowGroups: Array<DatabaseRowGroupSummary>;
  databaseRowReminders: Array<DatabaseRowReminder>;
  databaseRowTemplateBodyInputs: DatabaseRowTemplateBodyInputs;
  databaseRowTemplates: Array<DatabaseRowTemplateBinding>;
  databaseRows: DatabaseRowsPage;
  /**
   * P-DB-25: full-text search across database rows in this workspace.
   * Workspace ACL is enforced by the membership lookup inside the
   * SQL filter; the response is capped at 500 hits per call.
   */
  databaseSearch: Array<DatabaseSearchHit>;
  databaseStarterTemplates: Array<DatabaseStarterTemplate>;
  databaseSummary: Maybe<DatabaseSummary>;
  databaseTaskCaptureReceipt: Maybe<DatabaseTaskCaptureResult>;
  databaseTaskDestinations: DatabaseTaskDestinations;
  databaseTaskReferences: Array<DatabaseTaskReference>;
  databaseTasks: DatabaseTasksPage;
  databaseView: Maybe<DatabaseViewType>;
  databases: Array<DatabaseSummary>;
  description: Scalars["String"]["output"];
  /** Complexity 10: permission check + doc metadata DB query. */
  doc: Maybe<WorkspaceDocType>;
  /**
   * Paginated list of docs in workspace, sorted by created_at ASC.
   * Used by get-doc-created-by-updated-by-list.gql.
   */
  docs: PaginatedDocType;
  documentGraph: DocumentGraphResult;
  documentGraphIndexStatus: DocumentGraphIndexStatusType;
  documentLinks: DocumentLinksResult;
  documentReview: Maybe<DocumentReview>;
  documentReviewForTask: Maybe<DocumentReview>;
  documentReviewRequest: Maybe<DocumentReview>;
  /** Batch list snippets without loading document leaves or scheduling indexing. */
  documentSnippets: Array<WorkspaceDocumentSnippetType>;
  /**
   * Ordered SQL assignments for at most 200 external document keys. Null means
   * missing or forbidden; an empty array is a confirmed empty assignment.
   */
  documentWorkspaceTagAssignments: Array<WorkspaceTagDocumentAssignment>;
  documentWorkspaceTagIds: Array<Scalars["ID"]["output"]>;
  /**
   * Workspace embedding resolver — exposes files, ignoredDocs, allIgnoredDocs.
   *
   * P25-A-36/39/40: `workspace { embedding { files(...), ignoredDocs(...), allIgnoredDocs } }`
   *
   * Complexity 10 * child: permission check + child fields trigger DB queries.
   */
  embedding: WorkspaceEmbeddingType;
  enableAi: Scalars["Boolean"]["output"];
  enableDocEmbedding: Scalars["Boolean"]["output"];
  enableSharing: Scalars["Boolean"]["output"];
  enableUrlPreview: Scalars["Boolean"]["output"];
  /**
   * Coherent SQL label catalog and ordered assignments for explicit exported
   * external document keys. Fails on unavailable documents or export limits.
   */
  exportWorkspaceTags: Scalars["JSON"]["output"];
  /**
   * Git Sync document-to-file bindings for this workspace.
   *
   * Returns active (non-tombstoned) bindings showing which Myoxus
   * documents are mapped to which Git file paths.  Requires workspace
   * read permission.
   */
  gitSyncBindings: Array<GitSyncBindingType>;
  /**
   * Git Sync open conflicts for this workspace.
   *
   * Returns unresolved conflicts that require user attention.  Requires
   * workspace read permission.
   */
  gitSyncConflicts: Array<GitSyncConflictType>;
  /** Git Sync file-to-blob bindings for this workspace. */
  gitSyncFileBindings: Array<GitSyncFileBindingType>;
  /**
   * Git Sync open file conflicts for this workspace.
   *
   * File conflicts are exposed separately from document conflicts because
   * their resolution works with blob/binding hashes, not mergeable text.
   */
  gitSyncFileConflicts: Array<GitSyncFileConflictType>;
  /**
   * Git Sync profile for this workspace.
   *
   * Returns configured Git Sync metadata, including paused profiles, or `null` if none
   * is configured.  Requires workspace read permission.
   */
  gitSyncProfile: Maybe<GitSyncProfileType>;
  /**
   * Git Sync run history for this workspace.
   *
   * Returns the most recent sync runs, ordered by start time descending.
   * The optional `take` parameter limits the number of results (default: 20).
   * Requires workspace read permission.
   */
  gitSyncRuns: Array<GitSyncRunType>;
  /**
   * Git Sync status overview for this workspace.
   *
   * Aggregates the profile, latest run, and summary counters into a
   * single object.  Requires workspace read permission.
   */
  gitSyncStatus: GitSyncStatusType;
  /** Document version history entries for rollback/review. */
  histories: Array<DocHistoryType>;
  /**
   * Exact capture metadata, including entries outside the loaded cursor pages.
   * Snapshot bodies are only read by the existing preview/restore endpoints.
   */
  history: Maybe<DocHistoryType>;
  /**
   * Fixed selected historical state against the current server-persisted head.
   * Read authorization and lossless identity use the existing history owner.
   */
  historyDiff: DocumentHistoryDiffType;
  id: Scalars["UUID"]["output"];
  initialContentPolicy: WorkspaceInitialContentPolicy;
  /** Complexity 5: triggers a DB query to check workspace initialization state. */
  initialized: Scalars["Boolean"]["output"];
  /** Complexity 10: permission check + invite link DB query. */
  inviteLink: Maybe<InviteLink>;
  /** Complexity 5: triggers a DB COUNT query. */
  memberCount: Scalars["Int"]["output"];
  /** Complexity 20: permission check + paginated member list with user joins. */
  members: Array<InviteUserType>;
  name: Scalars["String"]["output"];
  /**
   * Folder IDs are opaque Organizer identities. The native reader owns both
   * current bulk document access and the root/direct-folder membership rules.
   */
  overview: WorkspaceOverviewPageType;
  /**
   * The captured row is also the mutation's exact saved basis; no second read
   * can replace its returned revision with a concurrent writer's settings.
   */
  overviewSettings: WorkspaceOverviewSettingsType;
  /** Complexity 10: DB query to fetch workspace owner with user data. */
  owner: Maybe<UserType>;
  /** Cloud page metadata — author and timestamp information for a single doc. */
  pageMeta: Maybe<WorkspaceDocMeta>;
  /**
   * Actor-owned pending Git work remains discoverable after dialog closure or
   * reload, including Disconnect targets without a configured Git profile.
   */
  pendingGitContentOperations: Array<WorkspaceContentOperationType>;
  /** Complexity 5: resolves direct membership plus OU-manager scope once. */
  permissions: WorkspacePermissions;
  prepareContextDocuments: ContextDocumentsPreparation;
  prepareDatabaseTaskMove: DatabaseTaskMovePreview;
  prepareDocumentReview: PreparedDocumentReview;
  prepareProjectAssistant: PreparedProjectAssistant;
  prepareTaskHandover: PreparedTaskHandover;
  prepareTaskMaintenance: PreparedTaskMaintenance;
  prepareTaskMaintenanceRule: PreparedTaskMaintenance;
  prepareTaskPreparation: PreparedTaskPreparation;
  projectSetup: Maybe<ProjectSetup>;
  public: Scalars["Boolean"]["output"];
  /** Whether this server currently exposes the dynamic public delivery routes. */
  publicDeliveryEnabled: Scalars["Boolean"]["output"];
  /**
   * List all publicly shared documents in this workspace.
   *
   * Returns `[DocType!]!` — the same type used by publishDoc/revokePublicDoc.
   * Frontend uses this in "Shared Pages" settings to show which docs are public.
   */
  publicDocs: Array<DocType>;
  /** Retained, otherwise eligible document selections activated with the workspace. */
  publicDocumentSelectionCount: Scalars["Int"]["output"];
  /** Server-authoritative effective anonymous workspace availability. */
  publiclyAccessible: Scalars["Boolean"]["output"];
  /** Resolve the effective workspace-owned storage quota and current usage. */
  quota: UserQuotaType;
  /** Paginated list of recently updated documents in this workspace. */
  recentlyUpdatedDocs: PaginatedDocType;
  recurrencePreview: Array<RecurrencePreview>;
  resolveWorkspaceTags: Array<WorkspaceTag>;
  /** Complexity 5: triggers a DB query to fetch the user's workspace role. */
  role: Permission;
  search: SearchResultObjectType;
  searchDocs: Array<SearchDocObjectType>;
  taskHandover: Maybe<TaskHandover>;
  taskHandoverRequest: Maybe<TaskHandover>;
  taskMaintenance: Maybe<TaskMaintenance>;
  taskMaintenanceRequest: Maybe<TaskMaintenance>;
  taskMaintenanceRule: Maybe<TaskPreparationConfiguration>;
  taskPreparation: Maybe<TaskPreparationConfiguration>;
  taskPreparationRun: Maybe<TaskPreparationRun>;
  taskRecurrence: Maybe<TaskRecurrence>;
  taskRecurrences: Array<TaskRecurrence>;
  /**
   * Workspace Read makes only these document-context names visible. It grants
   * no organization administration or manager/member-scoped OU access.
   */
  templateContext: Maybe<WorkspaceTemplateContextType>;
  templateSuggestions: TemplateSuggestionResult;
  /** Count-free trashed Database identities for the workspace trash list. */
  trashedDatabasePageIdentities: Array<DatabasePageIdentity>;
  /**
   * Recoverable Database roots in this workspace's trash. Child schema,
   * views, rows and cells stay intact until permanent deletion.
   */
  trashedDatabases: Array<DatabaseSummary>;
  /**
   * Guided help projects authored public source choices, never the creator's
   * answers or personal preferences. Native admission reads current scope.
   */
  workspaceSetupAssistance: Maybe<WorkspaceSetupAssistance>;
  workspaceTag: Maybe<WorkspaceTag>;
  /**
   * Complete catalog projection for the dedicated Tags surface. Assignment
   * controls keep using `workspaceTags` so ordinary workspace reads do not
   * pay for aggregate usage counts.
   */
  workspaceTagCatalog: Array<WorkspaceTagCatalogEntry>;
  workspaceTagDatabaseRowUsages: Array<WorkspaceTagDatabaseRowUsage>;
  /** Bounded document usages with an explicit continuation after ACL filtering. */
  workspaceTagDocumentUsages: WorkspaceTagDocumentUsagePage;
  /**
   * Canonical workspace tag catalog. Archived records are opt-in so normal
   * editors cannot accidentally offer them for new assignments.
   */
  workspaceTags: Array<WorkspaceTag>;
  /**
   * Authoritative workspace classification derived from ownership.
   *
   * - the one canonical userspace → "Personal"
   * - another user-owned workspace → "UserOwned"
   * - an OU-owned workspace → "Shared"
   */
  workspaceType: Scalars["String"]["output"];
}

export interface WorkspaceTypeAggregateArgs {
  input: AggregateInput;
}

export interface WorkspaceTypeAssistantDocumentSourceArgs {
  input: AssistantDocumentSourceInput;
}

export interface WorkspaceTypeAssistantPackagesArgs {
  context: AssistantContext;
}

export interface WorkspaceTypeAssistantPresentationArgs {
  context: AssistantContext;
  databaseId?: InputMaybe<Scalars["ID"]["input"]>;
  rowId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeAutomationRunsArgs {
  automationId?: InputMaybe<Scalars["ID"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  includeDeadLetter?: InputMaybe<Scalars["Boolean"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeAutomationsArgs {
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeBlobUploadPartUrlArgs {
  key: Scalars["String"]["input"];
  partNumber: Scalars["Int"]["input"];
  uploadId: Scalars["String"]["input"];
}

export interface WorkspaceTypeCommentChangesArgs {
  docId: Scalars["String"]["input"];
  pagination: PaginationInput;
}

export interface WorkspaceTypeCommentsArgs {
  docId: Scalars["String"]["input"];
  pagination?: InputMaybe<PaginationInput>;
}

export interface WorkspaceTypeContextDocumentsArgs {
  requestId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseArgs {
  databaseId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseActivityArgs {
  filter?: InputMaybe<DatabaseActivityFilterInput>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeDatabaseCsvExportArgs {
  databaseId: Scalars["ID"]["input"];
  options?: InputMaybe<DatabaseCsvExportOptionsInput>;
}

export interface WorkspaceTypeDatabaseEffectiveViewStateArgs {
  databaseId: Scalars["ID"]["input"];
  viewId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseJsonExportArgs {
  databaseId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabasePageIdentitiesArgs {
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeDatabaseProgressArgs {
  databaseId: Scalars["ID"]["input"];
  viewId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseRowArgs {
  databaseId: Scalars["ID"]["input"];
  includeTrashed?: Scalars["Boolean"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseRowActivityArgs {
  rowId: Scalars["ID"]["input"];
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeDatabaseRowGroupsArgs {
  databaseId: Scalars["ID"]["input"];
  locale?: InputMaybe<Scalars["String"]["input"]>;
  scheduleWindow?: InputMaybe<DatabaseScheduleWindowInput>;
  search?: InputMaybe<Scalars["String"]["input"]>;
  viewId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseRowRemindersArgs {
  databaseId: Scalars["ID"]["input"];
  fieldId: Scalars["ID"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseRowTemplateBodyInputsArgs {
  databaseId: Scalars["ID"]["input"];
  rowTemplateId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseRowTemplatesArgs {
  databaseId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseRowsArgs {
  after?: InputMaybe<Scalars["String"]["input"]>;
  databaseId: Scalars["ID"]["input"];
  filter?: InputMaybe<Array<DatabaseFilterRuleInput>>;
  filterTree?: InputMaybe<DatabaseFilterGroupInput>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  scheduleWindow?: InputMaybe<DatabaseScheduleWindowInput>;
  search?: InputMaybe<Scalars["String"]["input"]>;
  sort?: InputMaybe<Array<DatabaseSortRuleInput>>;
  viewId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeDatabaseSearchArgs {
  filter: DatabaseSearchFilterInput;
}

export interface WorkspaceTypeDatabaseSummaryArgs {
  databaseId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseTaskCaptureReceiptArgs {
  requestId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabaseTaskDestinationsArgs {
  after?: InputMaybe<Scalars["ID"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeDatabaseTaskReferencesArgs {
  targets: Array<DatabaseTaskReferenceInput>;
}

export interface WorkspaceTypeDatabaseTasksArgs {
  after?: InputMaybe<Scalars["String"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  input: DatabaseTasksInput;
}

export interface WorkspaceTypeDatabaseViewArgs {
  databaseId: Scalars["ID"]["input"];
  viewId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDatabasesArgs {
  databaseIds?: InputMaybe<Array<Scalars["ID"]["input"]>>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  profileKind?: InputMaybe<DatabaseProfileKind>;
  search?: InputMaybe<Scalars["String"]["input"]>;
  sort?: InputMaybe<DatabaseInventorySort>;
}

export interface WorkspaceTypeDocArgs {
  docId: Scalars["String"]["input"];
}

export interface WorkspaceTypeDocsArgs {
  pagination: PaginationInput;
}

export interface WorkspaceTypeDocumentGraphArgs {
  input: DocumentGraphInput;
}

export interface WorkspaceTypeDocumentGraphIndexStatusArgs {
  docId?: InputMaybe<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeDocumentLinksArgs {
  input: DocumentLinksInput;
}

export interface WorkspaceTypeDocumentReviewArgs {
  runId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDocumentReviewForTaskArgs {
  databaseId: Scalars["ID"]["input"];
  rowId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDocumentReviewRequestArgs {
  requestId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeDocumentSnippetsArgs {
  docIds: Array<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeDocumentWorkspaceTagAssignmentsArgs {
  externalIds: Array<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeDocumentWorkspaceTagIdsArgs {
  docId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeExportWorkspaceTagsArgs {
  externalIds: Array<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeGitSyncFileBindingsArgs {
  includeTombstoned?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface WorkspaceTypeGitSyncFileConflictsArgs {
  resolved?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface WorkspaceTypeGitSyncRunsArgs {
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeHistoriesArgs {
  before?: InputMaybe<Scalars["DateTime"]["input"]>;
  cursor?: InputMaybe<Scalars["String"]["input"]>;
  guid: Scalars["String"]["input"];
  namedOnly?: InputMaybe<Scalars["Boolean"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeHistoryArgs {
  guid: Scalars["String"]["input"];
  snapshotId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeHistoryDiffArgs {
  guid: Scalars["String"]["input"];
  snapshotId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeMembersArgs {
  query?: InputMaybe<Scalars["String"]["input"]>;
  skip?: InputMaybe<Scalars["Int"]["input"]>;
  take?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeOverviewArgs {
  first?: Scalars["Int"]["input"];
  folderId?: InputMaybe<Scalars["String"]["input"]>;
  offset?: Scalars["Int"]["input"];
}

export interface WorkspaceTypePageMetaArgs {
  pageId: Scalars["String"]["input"];
}

export interface WorkspaceTypePrepareContextDocumentsArgs {
  input: PrepareContextDocumentsInput;
}

export interface WorkspaceTypePrepareDatabaseTaskMoveArgs {
  input: DatabaseTaskMoveInput;
}

export interface WorkspaceTypePrepareDocumentReviewArgs {
  input: PrepareDocumentReviewInput;
}

export interface WorkspaceTypePrepareProjectAssistantArgs {
  input: PrepareProjectAssistantInput;
}

export interface WorkspaceTypePrepareTaskHandoverArgs {
  input: PrepareTaskHandoverInput;
}

export interface WorkspaceTypePrepareTaskMaintenanceArgs {
  input: PrepareTaskMaintenanceInput;
}

export interface WorkspaceTypePrepareTaskMaintenanceRuleArgs {
  input: PrepareTaskMaintenanceInput;
}

export interface WorkspaceTypePrepareTaskPreparationArgs {
  input: PrepareTaskPreparationInput;
}

export interface WorkspaceTypeProjectSetupArgs {
  requestId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeRecentlyUpdatedDocsArgs {
  pagination: PaginationInput;
}

export interface WorkspaceTypeRecurrencePreviewArgs {
  input: RecurrencePreviewInput;
}

export interface WorkspaceTypeResolveWorkspaceTagsArgs {
  tagIds: Array<Scalars["ID"]["input"]>;
}

export interface WorkspaceTypeSearchArgs {
  input: SearchInput;
}

export interface WorkspaceTypeSearchDocsArgs {
  input: SearchDocsInput;
}

export interface WorkspaceTypeTaskHandoverArgs {
  runId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskHandoverRequestArgs {
  requestId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskMaintenanceArgs {
  runId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskMaintenanceRequestArgs {
  requestId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskMaintenanceRuleArgs {
  databaseId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskPreparationArgs {
  databaseId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskPreparationRunArgs {
  runId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeTaskRecurrenceArgs {
  input: TaskRecurrenceLookupInput;
}

export interface WorkspaceTypeTaskRecurrencesArgs {
  after?: InputMaybe<Scalars["ID"]["input"]>;
  first?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeTemplateSuggestionsArgs {
  input: TemplateSuggestionInput;
}

export interface WorkspaceTypeTrashedDatabasePageIdentitiesArgs {
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeTrashedDatabasesArgs {
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
}

export interface WorkspaceTypeWorkspaceTagArgs {
  tagId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeWorkspaceTagCatalogArgs {
  includeArchived?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export interface WorkspaceTypeWorkspaceTagDatabaseRowUsagesArgs {
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  tagId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeWorkspaceTagDocumentUsagesArgs {
  first?: InputMaybe<Scalars["Int"]["input"]>;
  offset?: InputMaybe<Scalars["Int"]["input"]>;
  tagId: Scalars["ID"]["input"];
}

export interface WorkspaceTypeWorkspaceTagsArgs {
  includeArchived?: InputMaybe<Scalars["Boolean"]["input"]>;
}

export enum WorkspaceTypeFilter {
  Personal = "Personal",
  Shared = "Shared",
  UserOwned = "UserOwned",
}

export interface WrongSignInCredentialsDataType {
  __typename?: "WrongSignInCredentialsDataType";
  message: Scalars["String"]["output"];
}

/** JWT / session token bundle returned by token-based auth endpoints. */
export interface TokenType {
  __typename?: "tokenType";
  /** Long-lived refresh token. */
  refresh: Scalars["String"]["output"];
  /** Optional opaque session token. */
  sessionToken: Maybe<Scalars["String"]["output"]>;
  /** Short-lived access token. */
  token: Scalars["String"]["output"];
}
