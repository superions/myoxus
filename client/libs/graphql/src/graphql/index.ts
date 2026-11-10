/* do not manipulate this file manually. */
export type GraphQLOperationKind = "query" | "mutation" | "subscription";
export interface GraphQLQuery {
  id: string;
  op: string;
  kind?: GraphQLOperationKind;
  query: string;
  file?: boolean;
  deprecations?: string[];
}
export const adminCaBundleFieldsFragment = `fragment AdminCaBundleFields on AdminCaBundleStatus {
  path
  fingerprint
  certificateCount
  expiresAt
  fileError
  restriction
  rollbackAvailable
  loadedSnapshot
  restartRequired
  maxUploadBytes
}`;
export const adminDocumentVersioningWorkspaceSettingsFieldsFragment = `fragment AdminDocumentVersioningWorkspaceSettingsFields on AdminDocumentVersioningWorkspaceSettingsType {
  workspaceId
  workspaceName
  enabled
  autoVersionOnPdfExport
  retentionCount
  effectiveEnabled
  effectiveAutoVersionOnPdfExport
  effectiveRetentionCount
  editCaptureEnabled
  editCaptureIntervalMs
  effectiveEditCaptureEnabled
  effectiveEditCaptureIntervalMs
  legacyIntervalNormalized
  editCaptureRuntimeAvailable
  updatedAt
}`;
export const adminDocumentVersionPolicyFieldsFragment = `fragment AdminDocumentVersionPolicyFields on DocumentVersionPolicyType {
  id
  scope
  workspaceId
  name
  isDefault
  enabledByDefault
  schemePreset
  customPattern
  timezoneMode
  autoVersionOn
  retentionCount
  pinManualVersions
  pinPublishVersions
  publishedVersionsProtected
  exportVersionsProtected
  metadataSchema
  createdBy
  createdAt
  updatedBy
  updatedAt
}`;
export const adminOrganizationFragment = `fragment AdminOrganizationFragment on OrganizationType {
  id
  key
  name
  slug
  metadata
  createdAt
  updatedAt
}`;
export const adminOrganizationPolicyFragment = `fragment AdminOrganizationPolicyFragment on OrganizationPolicyType {
  organizationId
  managerRootProjectCreation
  managerUnitProjectCreation
  managerCanCreateWorkspaces
  managerCanManageOuMembers
  importExportEnabled
  updatedBy
  updatedAt
}`;
export const adminOrganizationUnitFragment = `fragment AdminOrganizationUnitFragment on OrganizationUnitTypeOutput {
  id
  organizationId
  parentUnitId
  unitTypeId
  name
  slug
  description
  status
  maxMembers
  metadata
  createdBy
  childUnitCount
  memberCount
  workspaceCount
  createdAt
  updatedAt
}`;
export const adminOrganizationUnitMemberFragment = `fragment AdminOrganizationUnitMemberFragment on OrganizationUnitMemberType {
  unitId
  userId
  userEmail
  userName
  userAvatarUrl
  role
  source
  metadata
  createdAt
  updatedAt
}`;
export const adminOrganizationUnitTypeFragment = `fragment AdminOrganizationUnitTypeFragment on OrganizationUnitTypeType {
  id
  organizationId
  key
  label
  description
  icon
  color
  isPreset
  isActive
  isStructural
  canHaveChildren
  canBeRootLevel
  canBeManagerCreated
  canHaveCrossUnitMembers
  canOwnWorkspaces
  canManageWorkspaces
  isStaffUnit
  requiresAdminApproval
  metadata
  createdAt
  updatedAt
}`;
export const calendarRecurrenceFieldsFragment = `fragment CalendarRecurrenceFields on CalendarRecurrence {
  id
  revision
  zone
  lifecycle
  endsBefore
  pausedAt
  readOnly
  unsupportedReason
  sourceRrule
  rule {
    ...RecurrenceRuleFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`;
export const preparedContextDocumentsFragment = `fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const contextDocumentsFragment = `fragment ContextDocumentsFragment on ContextDocuments {
  requestId
  status
  reasonCode
  folderId
  placementComplete
  run {
    ...WorkspaceAutomationRun
  }
  canRetry
  canStop
  acceptedPlan {
    ...PreparedContextDocumentsFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedContextDocumentsFragment
  }
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  assistance {
    mode
    source
    userDefaultExplicit
    interactiveMode
  }
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`;
export const databaseManagedSchemaFragment = `fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}`;
export const databaseTaskDestinationFragment = `fragment DatabaseTaskDestination on DatabaseTaskDestination {
  databaseId
  title
  editRevision
  managedSchema {
    ...DatabaseManagedSchema
  }
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}`;
export const databaseTaskMovePlanFragment = `fragment DatabaseTaskMovePlan on DatabaseTaskMovePlan {
  workspaceId
  sourceDatabaseId
  targetDatabaseId
  sourceEditRevision
  targetEditRevision
  sourceSchemaRevision
  targetSchemaRevision
  selection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
  phaseRowId
  milestoneRowId
}`;
export const databaseSelectOptionFragment = `fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`;
export const databaseStatusOptionFragment = `fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}`;
export const databaseRollupScalarValueFragment = `fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`;
export const databaseFormulaScalarValueFragment = `fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseFieldConfigFragment = `fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`;
export const databaseSortRuleFragment = `fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}`;
export const databaseFilterRuleFragment = `fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}`;
export const databaseFilterGroupFragment = `fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}`;
export const databaseGroupRuleFragment = `fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`;
export const databaseRowGroupSummaryFragment = `fragment DatabaseRowGroupSummary on DatabaseRowGroupSummary {
  key
  label
  rowCount
  groups {
    key
    label
    rowCount
    groups {
      key
      label
      rowCount
    }
  }
}`;
export const databaseViewConfigFragment = `fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`;
export const databaseFieldFragment = `fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`;
export const databaseViewFragment = `fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`;
export const databaseViewSummaryFragment = `fragment DatabaseViewSummary on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    kind
  }
  position
  editRevision
  createdAt
  updatedAt
}`;
export const databaseFragment = `fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}`;
export const databaseFieldRoleFragment = `fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}`;
export const databaseViewRoleFragment = `fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`;
export const databaseRecordFragment = `fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`;
export const databaseSchemaRecordFragment = `fragment DatabaseSchemaRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`;
export const databaseViewsRecordFragment = `fragment DatabaseViewsRecord on DatabaseRecord {
  views {
    ...DatabaseViewSummary
  }
}
fragment DatabaseViewSummary on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    kind
  }
  position
  editRevision
  createdAt
  updatedAt
}`;
export const databaseSummaryFragment = `fragment DatabaseSummary on DatabaseSummary {
  id
  systemRole
  workspaceId
  profileKind
  profileStructurePreset
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
  rowCount
  fieldCount
  viewCount
}`;
export const databasePageIdentityFragment = `fragment DatabasePageIdentity on DatabasePageIdentity {
  id
  systemRole
  profileKind
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
}`;
export const databaseCellValueDataFragment = `fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseCellValueFragment = `fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseRowFragment = `fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}`;
export const databaseTaskSourceFragment = `fragment DatabaseTaskSource on DatabaseTaskSource {
  sourceWorkspaceId
  documentId
  externalId
  blockId
  selectionAnchor
  state
  title
}`;
export const databaseRowRecordFragment = `fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseRowTemplateCellValueFragment = `fragment DatabaseRowTemplateCellValue on DatabaseRowTemplateCellValue {
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseRowTemplateFragment = `fragment DatabaseRowTemplate on DatabaseRowTemplate {
  editRevision
  id
  workspaceId
  databaseId
  templateId
  rowKind
  name
  description
  position
  enabled
  isDefault
  initialCellValues {
    ...DatabaseRowTemplateCellValue
  }
  createdBy
  updatedBy
  createdAt
  updatedAt
}
fragment DatabaseRowTemplateCellValue on DatabaseRowTemplateCellValue {
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseRowTemplateBindingFragment = `fragment DatabaseRowTemplateBinding on DatabaseRowTemplateBinding {
  rowTemplate {
    ...DatabaseRowTemplate
  }
  templateAvailable
  reconcileRequired
  detached
  disabled
  archived
}
fragment DatabaseRowTemplate on DatabaseRowTemplate {
  editRevision
  id
  workspaceId
  databaseId
  templateId
  rowKind
  name
  description
  position
  enabled
  isDefault
  initialCellValues {
    ...DatabaseRowTemplateCellValue
  }
  createdBy
  updatedBy
  createdAt
  updatedAt
}
fragment DatabaseRowTemplateCellValue on DatabaseRowTemplateCellValue {
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const databaseCsvDiagnosticFragment = `fragment DatabaseCsvDiagnostic on DatabaseCsvDiagnostic {
  code
  source
  row
  field
  message
}`;
export const databaseJsonDiagnosticFragment = `fragment DatabaseJsonDiagnostic on DatabaseJsonDiagnostic {
  code
  source
  path
  message
}`;
export const databaseWorkspaceTagImportDiagnosticFragment = `fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`;
export const databaseBulkRowOutcomeFragment = `fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`;
export const databaseBulkOperationResultFragment = `fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`;
export const workspaceAutomationTriggerFragment = `fragment WorkspaceAutomationTrigger on WorkspaceAutomationTriggerType {
  triggerType
  databaseId
  fieldId
  selectOptionId
}`;
export const workspaceAutomationActionFragment = `fragment WorkspaceAutomationAction on WorkspaceAutomationActionType {
  position
  actionType
  config
}`;
export const workspaceAutomationFragment = `fragment WorkspaceAutomation on WorkspaceAutomationType {
  id
  workspaceId
  name
  description
  status
  trigger {
    ...WorkspaceAutomationTrigger
  }
  actions {
    ...WorkspaceAutomationAction
  }
  createdAt
  updatedAt
}
fragment WorkspaceAutomationTrigger on WorkspaceAutomationTriggerType {
  triggerType
  databaseId
  fieldId
  selectOptionId
}
fragment WorkspaceAutomationAction on WorkspaceAutomationActionType {
  position
  actionType
  config
}`;
export const workspaceAutomationRunFragment = `fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}`;
export const databaseStarterTemplateFragment = `fragment DatabaseStarterTemplate on DatabaseStarterTemplate {
  id
  version
  digest
  defaultVariant {
    priority
    complexity
    structure
  }
  selections {
    input {
      priority
      complexity
      structure
    }
    variant {
      priority
      complexity
      structure
    }
  }
  name
  nameKey
  description
  descriptionKey
  category
  profileKind
  defaultViewKinds
  sampleRowCount
  importMappings {
    key
    nameKey
    columnMappings {
      sourceHeader
      fieldKey
      required
    }
  }
}`;
export const databaseActivityEventFragment = `fragment DatabaseActivityEvent on DatabaseActivityEvent {
  id
  workspaceId
  databaseId
  rowId
  eventType
  actorUserId
  actorDisplayName
  payload
  createdAt
}`;
export const legacyDatabaseMigrationPlanFragment = `fragment LegacyDatabaseMigrationPlan on LegacyDatabaseMigrationPlanObjectType {
  databaseIds
  blockReferences {
    sourceDocumentId
    blockId
    targetDatabaseId
    targetViewId
    alreadyMigrated
  }
  fieldCount
  rowCount
  cellCount
  viewCount
  diagnostics {
    code
    severity
    message
    context
  }
  applyAllowed
}`;
export const databaseTaskSummaryFragment = `fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`;
export const databaseTaskCaptureResultFragment = `fragment DatabaseTaskCaptureResult on DatabaseTaskCaptureResult {
  requestId
  databaseId
  rowId
  editRevision
  state
  replayed
  record {
    ...DatabaseRowRecord
  }
  source {
    ...DatabaseTaskSource
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseTaskSource on DatabaseTaskSource {
  sourceWorkspaceId
  documentId
  externalId
  blockId
  selectionAnchor
  state
  title
}`;
export const databaseTaskReferenceFragment = `fragment DatabaseTaskReference on DatabaseTaskReference {
  workspaceId
  databaseId
  rowId
  state
  task {
    ...DatabaseTaskSummary
  }
}
fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`;
export const assistantLocalizedTextFragment = `fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const assistantArtworkFragment = `fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const assistantDocumentSourceFragment = `fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`;
export const assistantPackageIdentityFragment = `fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}`;
export const assistantFolderDestinationFragment = `fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const assistantValueBindingFragment = `fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const assistantValueFragment = `fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const assistantVisibilityFragment = `fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const assistantInputFragment = `fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}`;
export const assistantControlFragment = `fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}`;
export const assistantGroupFragment = `fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const assistantActionFragment = `fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const assistantStepFragment = `fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}`;
export const assistantDialogFragment = `fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}`;
export const assistantPackageFragment = `fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`;
export const assistantResolvedFieldFragment = `fragment AssistantResolvedFieldFragment on AssistantResolvedField {
  binding {
    kind
    roleKey
    fieldKey
  }
  fieldId
  name
  fieldType
  required
  config {
    ...DatabaseFieldConfig
  }
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`;
export const preparedProjectAssistantFragment = `fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const projectSetupFragment = `fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`;
export const documentGraphNodeFieldsFragment = `fragment DocumentGraphNodeFields on DocumentGraphNodeType {
  workspaceId
  docId
  rawDocId
  title
  documentType
  status
  classification
  deleted
  redacted
}`;
export const documentGraphOccurrenceFieldsFragment = `fragment DocumentGraphOccurrenceFields on DocumentGraphOccurrenceType {
  id
  sourceDocId
  sourceBlockId
  sourceParentBlockId
  sourceParentFlavour
  rawTargetDocId
  targetWorkspaceId
  targetDocId
  linkKind
  paramsJson
  markdownPreview
  targetState
  extractedAt
  sourceUpdatedAt
}`;
export const documentGraphEdgeFieldsFragment = `fragment DocumentGraphEdgeFields on DocumentGraphEdgeType {
  sourceDocId
  targetDocId
  rawTargetDocId
  targetWorkspaceId
  targetState
  linkKind
  occurrenceCount
  firstOccurrencePreview
  staleState
  occurrences {
    ...DocumentGraphOccurrenceFields
  }
}
fragment DocumentGraphOccurrenceFields on DocumentGraphOccurrenceType {
  id
  sourceDocId
  sourceBlockId
  sourceParentBlockId
  sourceParentFlavour
  rawTargetDocId
  targetWorkspaceId
  targetDocId
  linkKind
  paramsJson
  markdownPreview
  targetState
  extractedAt
  sourceUpdatedAt
}`;
export const documentGraphIndexStatusFieldsFragment = `fragment DocumentGraphIndexStatusFields on DocumentGraphIndexStatusType {
  staleState
  indexedAt
  queuedAt
  startedAt
  failedAt
  errorCode
  errorMessage
  attemptCount
  occurrenceCount
  currentCount
  staleCount
  queuedCount
  extractingCount
  failedCount
  deletedCount
  missingStateCount
}`;
export const documentMetadataFieldDefinitionFieldsFragment = `fragment DocumentMetadataFieldDefinitionFields on DocumentMetadataFieldDefinitionType {
  key
  label
  enabled
  requiredMode
  editableBy
  visibleInHeader
  visibleInProperties
  visibleInLists
  exportMode
  validationConfig
  metadata
  updatedBy
  updatedAt
}`;
export const documentStatusValueFieldsFragment = `fragment DocumentStatusValueFields on DocumentStatusValueType {
  id
  schemaId
  key
  label
  description
  color
  icon
  sortOrder
  terminal
  okfStatus
  isActive
  metadata
}`;
export const documentTypeDefinitionFieldsFragment = `fragment DocumentTypeDefinitionFields on DocumentTypeDefinitionType {
  id
  key
  label
  description
  icon
  color
  isActive
  isSuggested
}`;
export const documentMetadataIndexFieldsFragment = `fragment DocumentMetadataIndexFields on DocumentMetadataIndexRowType {
  docId
  externalId
  createdBy
  updatedBy
  journalDate
  isTemplate
  templateState
  templateOrigin
  templateCategory
  templateTags
  primaryMode
  pageWidth
  edgelessColorTheme
  integrationType
  canPublish
  statusId
  documentTypeId
  currentVersionId
  dirtySinceCurrentVersion
  reviewDueAt
  validUntil
  classificationId
  tagIds
}`;
export const documentMetadataReferenceValueFieldsFragment = `fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}`;
export const documentMetadataFieldValueFieldsFragment = `fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}`;
export const documentMetadataAudienceFieldsFragment = `fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}`;
export const documentMetadataValidationIssueFieldsFragment = `fragment DocumentMetadataValidationIssueFields on DocumentMetadataValidationIssueType {
  code
  key
  message
  severity
  blockedActions
  details
}`;
export const documentMetadataValidationFieldsFragment = `fragment DocumentMetadataValidationFields on DocumentMetadataValidationType {
  valid
  missingRequiredMetadataFields
  blockedActions
  errors {
    ...DocumentMetadataValidationIssueFields
  }
  warnings {
    ...DocumentMetadataValidationIssueFields
  }
}
fragment DocumentMetadataValidationIssueFields on DocumentMetadataValidationIssueType {
  code
  key
  message
  severity
  blockedActions
  details
}`;
export const documentMetadataFieldsFragment = `fragment DocumentMetadataFields on DocumentMetadataType {
  docId
  workspaceId
  projectionMode
  projectionVersion
  metadataRevision
  metadataUpdatedAt
  metadataUpdatedBy
  system {
    createdAt
    updatedAt
    createdBy
    updatedBy
    metadataUpdatedAt
    metadataUpdatedBy
  }
  fields {
    ...DocumentMetadataFieldValueFields
  }
  audience {
    ...DocumentMetadataAudienceFields
  }
  template {
    state
    origin
    category
    tags
    templateId
    revisionId
    instanceId
  }
  journal {
    journalDate
  }
  presentation {
    primaryMode
    pageWidth
    edgelessColorTheme
  }
  integration {
    integrationType
  }
  policy {
    locks {
      key
      inheritanceMode
      editable
      reason
    }
  }
  legacy
}
fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}
fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}`;
export const documentReviewPlanningFieldsFragment = `fragment DocumentReviewPlanningFields on DocumentReviewPlanningType {
  enabled
  metadataRevision
  responsibleId
  sourceDeadline
  nextStart
  processDeadline
  zone
  leadDays
  ready
  blockedReason
  runId
}`;
export const preparedDocumentReviewFragment = `fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const documentReviewFragment = `fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`;
export const documentVersionFieldsFragment = `fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`;
export const copilotChatHistoryFragment = `fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`;
export const credentialsRequirementsFragment = `fragment CredentialsRequirements on CredentialsRequirementType {
  password {
    ...PasswordLimits
  }
}
fragment PasswordLimits on PasswordLimitsType {
  minLength
  maxLength
}`;
export const currentUserProfileFragment = `fragment CurrentUserProfile on UserType {
  id
  name
  email
  avatarUrl
  emailVerified
  features
  preferences {
    updatedAt
    values {
      locale
      defaultDocumentLanguage
      timezone
      dateFormat
      timeFormat
      receiveInvitationEmail
      receiveMentionEmail
      receiveCommentEmail
      journalFirstDayOfWeek
      journalShowCalendarWeeks
      colorMode
      showLinkedDocuments
      imageAntialiasing
      noisyBackground
      editorFontFamily
      editorCustomFontFamily
      editorFontSize
      newDocumentMode
      fullWidthLayout
      openDocumentMode
      edgelessDefaultTheme
      telemetryEnabled
      aiModelId
      aiReasoningEnabled
      documentMetadataHeaderVisibility {
        workspaceId
        fields {
          field
          visible
        }
      }
    }
    effectiveValues {
      locale
      defaultDocumentLanguage
      timezone
      dateFormat
      timeFormat
      receiveInvitationEmail
      receiveMentionEmail
      receiveCommentEmail
      journalFirstDayOfWeek
      journalShowCalendarWeeks
      colorMode
      showLinkedDocuments
      imageAntialiasing
      noisyBackground
      editorFontFamily
      editorCustomFontFamily
      editorFontSize
      newDocumentMode
      fullWidthLayout
      openDocumentMode
      edgelessDefaultTheme
      telemetryEnabled
      aiModelId
      aiReasoningEnabled
      documentMetadataHeaderVisibility {
        workspaceId
        fields {
          field
          visible
        }
      }
    }
  }
  quota {
    name
    blobLimit
    storageQuota
    historyPeriod
    memberLimit
    humanReadable {
      name
      blobLimit
      storageQuota
      historyPeriod
      memberLimit
    }
  }
  quotaUsage {
    storageQuota
  }
  copilot {
    quota {
      limit
      used
    }
  }
}`;
export const databaseDocumentReferenceFieldsFragment = `fragment DatabaseDocumentReferenceFields on DatabaseDocumentReferenceType {
  databaseId
  databaseTitle
  rowId
  rowTitle
  fieldId
  fieldName
  referenceKind
  rawTargetDocId
  targetDocId
  targetWorkspaceId
  refreshedAt
}`;
export const paginatedCopilotChatsFragment = `fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`;
export const passwordLimitsFragment = `fragment PasswordLimits on PasswordLimitsType {
  minLength
  maxLength
}`;
export const recurrenceValueFieldsFragment = `fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`;
export const recurrenceOccurrenceFieldsFragment = `fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`;
export const recurrenceRuleFieldsFragment = `fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`;
export const taskRecurrenceMemberFieldsFragment = `fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`;
export const taskRecurrenceFieldsFragment = `fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`;
export const savedAssistantSelectionFragment = `fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const savedSetupConfigurationFragment = `fragment SavedSetupConfigurationFragment on SavedSetupConfiguration {
  id
  name
  context
  assistanceMode
  package {
    ...SavedAssistantSelectionFragment
  }
  project {
    ...SavedAssistantSelectionFragment
  }
  setup {
    ...SavedAssistantSelectionFragment
  }
}
fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const savedSetupPreferencesFragment = `fragment SavedSetupPreferencesFragment on UserPreferencesType {
  updatedAt
  values {
    savedSetups {
      ...SavedSetupConfigurationFragment
    }
  }
}
fragment SavedSetupConfigurationFragment on SavedSetupConfiguration {
  id
  name
  context
  assistanceMode
  package {
    ...SavedAssistantSelectionFragment
  }
  project {
    ...SavedAssistantSelectionFragment
  }
  setup {
    ...SavedAssistantSelectionFragment
  }
}
fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const resolvedSavedAssistantSelectionFragment = `fragment ResolvedSavedAssistantSelectionFragment on ResolvedSavedAssistantSelection {
  descriptor {
    identity {
      ...AssistantPackageIdentityFragment
    }
    contexts
  }
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  cleared {
    inputId
    componentId
    reason
  }
  unavailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const preparedTaskHandoverFragment = `fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`;
export const taskHandoverFragment = `fragment TaskHandoverFragment on TaskHandover {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskHandoverFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  resultTaskId
  resultTask {
    databaseId
    rowId
  }
  resultAvailable
  sourceAvailable
  prerequisites {
    reference {
      databaseId
      rowId
    }
    available
    title
    complete
  }
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`;
export const preparedTaskMaintenanceFragment = `fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`;
export const taskMaintenanceFragment = `fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`;
export const taskPreparationSourceFragment = `fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`;
export const preparedTaskPreparationFragment = `fragment PreparedTaskPreparationFragment on PreparedTaskPreparation {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`;
export const taskPreparationConfigurationFragment = `fragment TaskPreparationConfigurationFragment on TaskPreparationConfiguration {
  id
  actorId
  workspaceId
  databaseId
  executionRevision
  planDigest
  status
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`;
export const taskPreparationRunFragment = `fragment TaskPreparationRunFragment on TaskPreparationRun {
  run {
    ...WorkspaceAutomationRun
  }
  target {
    databaseId
    rowId
  }
  documentId
  documentExternalId
  canRetry
  canStop
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}`;
export const templateSuggestionItemFieldsFragment = `fragment TemplateSuggestionItemFields on TemplateSuggestionItem {
  templateId
  templateDocId
  slug
  title
  description
  source
  updatedAt
  category
  titlePolicy
  sourceRevisionId
  tags
  score
  reasons
  instanceState
  available
  protectedSource
}`;
export const preparedWorkspaceAssistantFragment = `fragment PreparedWorkspaceAssistantFragment on PreparedWorkspaceAssistant {
  ...WorkspaceCreationPlanFragment
  setup {
    ...PreparedWorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}`;
export const workspaceCreationPlanFragment = `fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const preparedWorkspaceSetupFragment = `fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const workspaceSetupFragment = `fragment WorkspaceSetupFragment on WorkspaceSetup {
  requestId
  status
  canRetry
  canStop
  reasonCode
  acceptedPlan {
    ...PreparedWorkspaceSetupFragment
  }
  currentReview {
    ...PreparedWorkspaceSetupFragment
  }
  run {
    id
    status
  }
  components {
    componentId
    reservedId
    documentExternalId
    available
    result {
      kind
      databaseId
      documentId
      entryId
    }
  }
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`;
export const workspaceCreationResultFragment = `fragment WorkspaceCreationResultFragment on WorkspaceCreationResultType {
  workspaceId
  requestId
  status
  rootReady
  tasksReady
  tasksDatabaseId
  assistanceSaved
  retryRequired
  reasonCode
  acceptedPlan {
    ...WorkspaceCreationPlanFragment
  }
  projectSetup {
    ...ProjectSetupFragment
  }
  setup {
    ...WorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment WorkspaceSetupFragment on WorkspaceSetup {
  requestId
  status
  canRetry
  canStop
  reasonCode
  acceptedPlan {
    ...PreparedWorkspaceSetupFragment
  }
  currentReview {
    ...PreparedWorkspaceSetupFragment
  }
  run {
    id
    status
  }
  components {
    componentId
    reservedId
    documentExternalId
    available
    result {
      kind
      databaseId
      documentId
      entryId
    }
  }
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}`;
export const workspaceContentOperationProjectionFragment = `fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`;
export const workspaceContentGitSyncProjectionFragment = `fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`;
export const workspaceContentPreflightProjectionFragment = `fragment WorkspaceContentPreflightProjection on WorkspaceContentPreflightType {
  operation {
    ...WorkspaceContentOperationProjection
  }
  revision
  blockers
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
  missingResources {
    workspaceId
    kind
    id
  }
  requiredConfirmations {
    kind
    userId
    role
    resource {
      workspaceId
      kind
      id
    }
  }
  membershipImpacts {
    userId
    currentRole
    requiredRole
    requiredCapability
  }
  conflicts {
    kind
    resource {
      workspaceId
      kind
      id
    }
    suggestedName
  }
  resourceCounts {
    kind
    count
  }
  resourceCount
  membershipImpactCount
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`;
export const workspaceImportProjectionFragment = `fragment WorkspaceImportProjection on WorkspaceImportType {
  id
  status
  queuedOperation
  progressStage
  progressCurrent
  progressTotal
  cancelRequested
  preview {
    detectedFormat
    sourceRoot
    proposedWorkspaceTitle
    counts {
      documents
      assets
      databases
      fields
      rows
      cells
      views
    }
    omittedCounts
    targetPlan {
      workspaceId
      documentIds
      assetIds
      databaseIds
      tagIds
      vault
    }
    diagnostics {
      code
      severity
      message
      context
    }
    sourceHash
    configFingerprint
    planFingerprint
    applyAllowed
  }
  targetWorkspaceId
  errorCode
  errorMessage
  createdAt
  updatedAt
  expiresAt
}`;
export const workspaceOverviewSettingsFieldsFragment = `fragment workspaceOverviewSettingsFields on WorkspaceOverviewSettingsType {
  revision
  introduction {
    workspaceId
    kind
    id
  }
  folderIds
  registerPresentation {
    ...workspaceOverviewRegisterPresentationFields
  }
  folders {
    folderId
    introduction {
      workspaceId
      kind
      id
    }
    registerPresentation {
      ...workspaceOverviewRegisterPresentationFields
    }
  }
}
fragment workspaceOverviewRegisterPresentationFields on WorkspaceOverviewRegisterPresentationType {
  displayProperties
  orderBy {
    type
    key
    desc
  }
}`;
export const workspaceOverviewRegisterPresentationFieldsFragment = `fragment workspaceOverviewRegisterPresentationFields on WorkspaceOverviewRegisterPresentationType {
  displayProperties
  orderBy {
    type
    key
    desc
  }
}`;
export const workspaceTagFieldsFragment = `fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`;
export const generateUserAccessTokenMutation = {
  id: "generateUserAccessTokenMutation" as const,
  op: "generateUserAccessToken",
  kind: "mutation" as const,
  query: `mutation generateUserAccessToken($input: GenerateAccessTokenInput!) {
  generateUserAccessToken(input: $input) {
    id
    name
    token
    createdAt
    expiresAt
  }
}`,
};

export const listUserAccessTokensQuery = {
  id: "listUserAccessTokensQuery" as const,
  op: "listUserAccessTokens",
  kind: "query" as const,
  query: `query listUserAccessTokens {
  currentUser {
    revealedAccessTokens {
      id
      name
      createdAt
      expiresAt
      token
    }
  }
}`,
};

export const revokeUserAccessTokenMutation = {
  id: "revokeUserAccessTokenMutation" as const,
  op: "revokeUserAccessToken",
  kind: "mutation" as const,
  query: `mutation revokeUserAccessToken($id: String!) {
  revokeUserAccessToken(id: $id)
}`,
};

export const addOrganizationUnitMemberAsManagerMutation = {
  id: "addOrganizationUnitMemberAsManagerMutation" as const,
  op: "addOrganizationUnitMemberAsManager",
  kind: "mutation" as const,
  query: `mutation addOrganizationUnitMemberAsManager($unitId: ID!, $userId: ID!, $role: OrganizationUnitRoleEnum!) {
  addOrganizationUnitMemberAsManager(
    unitId: $unitId
    userId: $userId
    role: $role
  ) {
    unitId
    userId
    role
    source
  }
}`,
};

export const adminCaBundleStatusQuery = {
  id: "adminCaBundleStatusQuery" as const,
  op: "adminCaBundleStatus",
  kind: "query" as const,
  query: `query adminCaBundleStatus {
  admin {
    adminCaBundleStatus {
      ...AdminCaBundleFields
    }
  }
}
fragment AdminCaBundleFields on AdminCaBundleStatus {
  path
  fingerprint
  certificateCount
  expiresAt
  fileError
  restriction
  rollbackAvailable
  loadedSnapshot
  restartRequired
  maxUploadBytes
}`,
};

export const adminApplyCaBundleMutation = {
  id: "adminApplyCaBundleMutation" as const,
  op: "adminApplyCaBundle",
  kind: "mutation" as const,
  query: `mutation adminApplyCaBundle($file: Upload!) {
  admin {
    adminApplyCaBundle(file: $file) {
      ...AdminCaBundleFields
    }
  }
}
fragment AdminCaBundleFields on AdminCaBundleStatus {
  path
  fingerprint
  certificateCount
  expiresAt
  fileError
  restriction
  rollbackAvailable
  loadedSnapshot
  restartRequired
  maxUploadBytes
}`,
  file: true,
};

export const adminRestoreCaBundleMutation = {
  id: "adminRestoreCaBundleMutation" as const,
  op: "adminRestoreCaBundle",
  kind: "mutation" as const,
  query: `mutation adminRestoreCaBundle {
  admin {
    adminRestoreCaBundle {
      ...AdminCaBundleFields
    }
  }
}
fragment AdminCaBundleFields on AdminCaBundleStatus {
  path
  fingerprint
  certificateCount
  expiresAt
  fileError
  restriction
  rollbackAvailable
  loadedSnapshot
  restartRequired
  maxUploadBytes
}`,
};

export const adminRemoveCaBundleMutation = {
  id: "adminRemoveCaBundleMutation" as const,
  op: "adminRemoveCaBundle",
  kind: "mutation" as const,
  query: `mutation adminRemoveCaBundle {
  admin {
    adminRemoveCaBundle {
      ...AdminCaBundleFields
    }
  }
}
fragment AdminCaBundleFields on AdminCaBundleStatus {
  path
  fingerprint
  certificateCount
  expiresAt
  fileError
  restriction
  rollbackAvailable
  loadedSnapshot
  restartRequired
  maxUploadBytes
}`,
};

export const adminSearchUsersQuery = {
  id: "adminSearchUsersQuery" as const,
  op: "adminSearchUsers",
  kind: "query" as const,
  query: `query adminSearchUsers($query: String!, $limit: Int, $features: [String!], $excludeUnitId: ID) {
  admin {
    adminSearchUsers(
      query: $query
      limit: $limit
      features: $features
      excludeUnitId: $excludeUnitId
    ) {
      id
      email
      name
      features
      isAdmin
      disabled
    }
  }
}`,
};

export const adminSearchWorkspacesQuery = {
  id: "adminSearchWorkspacesQuery" as const,
  op: "adminSearchWorkspaces",
  kind: "query" as const,
  query: `query adminSearchWorkspaces($query: String!, $ouId: ID, $excludeUnitId: ID, $limit: Int) {
  admin {
    adminSearchWorkspaces(
      query: $query
      ouId: $ouId
      excludeUnitId: $excludeUnitId
      limit: $limit
    ) {
      id
      name
      ownerUserId
      ownerEmail
      linkedOuIds
    }
  }
}`,
};

export const adminAddWorkspaceMemberMutation = {
  id: "adminAddWorkspaceMemberMutation" as const,
  op: "adminAddWorkspaceMember",
  kind: "mutation" as const,
  query: `mutation adminAddWorkspaceMember($workspaceId: ID!, $userId: ID!, $role: String) {
  admin {
    addWorkspaceMember(workspaceId: $workspaceId, userId: $userId, role: $role) {
      id
      name
      email
      avatarUrl
      role
      status
    }
  }
}`,
};

export const adminAllSharedLinksQuery = {
  id: "adminAllSharedLinksQuery" as const,
  op: "adminAllSharedLinks",
  kind: "query" as const,
  query: `query adminAllSharedLinks($pagination: PaginationInput!, $filter: AdminAllSharedLinksFilterInput) {
  admin {
    adminAllSharedLinks(pagination: $pagination, filter: $filter) {
      totalCount
      analyticsWindow {
        from
        to
        timezone
        bucket
        requestedSize
        effectiveSize
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          workspaceId
          docId
          title
          publishedAt
          docUpdatedAt
          workspaceOwnerId
          lastUpdaterId
          shareUrl
          views
          uniqueViews
          guestViews
          lastAccessedAt
        }
      }
    }
  }
}`,
};

export const adminAssignOrganizationManagerMutation = {
  id: "adminAssignOrganizationManagerMutation" as const,
  op: "adminAssignOrganizationManager",
  kind: "mutation" as const,
  query: `mutation adminAssignOrganizationManager($input: AssignOrganizationManagerInput!) {
  admin {
    assignOrganizationManager(input: $input) {
      ...AdminOrganizationUnitMemberFragment
    }
  }
}
fragment AdminOrganizationUnitMemberFragment on OrganizationUnitMemberType {
  unitId
  userId
  userEmail
  userName
  userAvatarUrl
  role
  source
  metadata
  createdAt
  updatedAt
}`,
};

export const adminAssignOrganizationUnitWorkspaceMutation = {
  id: "adminAssignOrganizationUnitWorkspaceMutation" as const,
  op: "adminAssignOrganizationUnitWorkspace",
  kind: "mutation" as const,
  query: `mutation adminAssignOrganizationUnitWorkspace($input: AssignOrganizationUnitWorkspaceInput!) {
  admin {
    assignOrganizationUnitWorkspace(input: $input)
  }
}`,
};

export const adminAuditLogQuery = {
  id: "adminAuditLogQuery" as const,
  op: "adminAuditLog",
  kind: "query" as const,
  query: `query adminAuditLog($filter: AuditLogFilterInput, $limit: Int!, $offset: Int!) {
  admin {
    adminAuditLog(filter: $filter, limit: $limit, offset: $offset) {
      id
      eventKey
      category
      target {
        id
        type
        label
      }
      actor {
        id
        label
        kind
        credentialType
        credentialId
      }
      createdAt
      oldValue
      newValue
      metadata
      targetUnitId
    }
    adminAuditLogCount(filter: $filter)
  }
}`,
};

export const adminDashboardQuery = {
  id: "adminDashboardQuery" as const,
  op: "adminDashboard",
  kind: "query" as const,
  query: `query adminDashboard($input: AdminDashboardInput) {
  admin {
    adminDashboard(input: $input) {
      syncActiveUsers
      syncActiveUsersTimeline {
        minute
        activeUsers
      }
      syncWindow {
        from
        to
        timezone
        bucket
        requestedSize
        effectiveSize
      }
      copilotConversations
      workspaceStorageBytes
      blobStorageBytes
      workspaceStorageHistory {
        date
        value
      }
      blobStorageHistory {
        date
        value
      }
      storageWindow {
        from
        to
        timezone
        bucket
        requestedSize
        effectiveSize
      }
      topSharedLinks {
        workspaceId
        docId
        title
        shareUrl
        publishedAt
        views
        uniqueViews
        guestViews
        lastAccessedAt
      }
      topSharedLinksWindow {
        from
        to
        timezone
        bucket
        requestedSize
        effectiveSize
      }
      generatedAt
    }
  }
}`,
};

export const adminDeactivateOrganizationUnitTypeMutation = {
  id: "adminDeactivateOrganizationUnitTypeMutation" as const,
  op: "adminDeactivateOrganizationUnitType",
  kind: "mutation" as const,
  query: `mutation adminDeactivateOrganizationUnitType($id: ID!) {
  admin {
    deactivateOrganizationUnitType(id: $id)
  }
}`,
};

export const adminDeactivateOrganizationUnitMutation = {
  id: "adminDeactivateOrganizationUnitMutation" as const,
  op: "adminDeactivateOrganizationUnit",
  kind: "mutation" as const,
  query: `mutation adminDeactivateOrganizationUnit($id: ID!) {
  admin {
    deactivateOrganizationUnit(id: $id)
  }
}`,
};

export const adminDecideOrganizationProjectRequestMutation = {
  id: "adminDecideOrganizationProjectRequestMutation" as const,
  op: "adminDecideOrganizationProjectRequest",
  kind: "mutation" as const,
  query: `mutation adminDecideOrganizationProjectRequest($id: ID!, $newStatus: ProjectRequestStatusEnum!) {
  admin {
    decideOrganizationProjectRequest(id: $id, newStatus: $newStatus)
  }
}`,
};

export const adminDeleteOrganizationUnitPermanentlyMutation = {
  id: "adminDeleteOrganizationUnitPermanentlyMutation" as const,
  op: "adminDeleteOrganizationUnitPermanently",
  kind: "mutation" as const,
  query: `mutation adminDeleteOrganizationUnitPermanently($id: ID!, $confirmedName: String!, $previewRevision: DateTime!) {
  admin {
    deleteOrganizationUnitPermanently(
      id: $id
      confirmedName: $confirmedName
      previewRevision: $previewRevision
    )
  }
}`,
};

export const adminDocumentAuditLogQuery = {
  id: "adminDocumentAuditLogQuery" as const,
  op: "adminDocumentAuditLog",
  kind: "query" as const,
  query: `query adminDocumentAuditLog($filter: AdminDocumentAuditFilterInput, $limit: Int!, $offset: Int!) {
  admin {
    adminDocumentAuditLog(filter: $filter, limit: $limit, offset: $offset) {
      id
      source
      group
      eventKey
      sourceCategory
      target {
        id
        type
        label
      }
      actor {
        id
        label
        kind
        credentialType
        credentialId
      }
      createdAt
      oldValue
      newValue
      metadata
      targetUnitId
      workspaceId
      docId
    }
    adminDocumentAuditLogCount(filter: $filter)
  }
}`,
};

export const adminDocumentMetadataFieldDefinitionsQuery = {
  id: "adminDocumentMetadataFieldDefinitionsQuery" as const,
  op: "adminDocumentMetadataFieldDefinitions",
  kind: "query" as const,
  query: `query adminDocumentMetadataFieldDefinitions {
  admin {
    documentMetadataFieldDefinitions {
      ...DocumentMetadataFieldDefinitionFields
    }
  }
}
fragment DocumentMetadataFieldDefinitionFields on DocumentMetadataFieldDefinitionType {
  key
  label
  enabled
  requiredMode
  editableBy
  visibleInHeader
  visibleInProperties
  visibleInLists
  exportMode
  validationConfig
  metadata
  updatedBy
  updatedAt
}`,
};

export const adminDocumentStatusSchemasQuery = {
  id: "adminDocumentStatusSchemasQuery" as const,
  op: "adminDocumentStatusSchemas",
  kind: "query" as const,
  query: `query adminDocumentStatusSchemas {
  admin {
    documentStatusSchemas {
      id
      key
      label
      description
      complexity
      isPreset
      isActive
      metadata
    }
  }
}`,
};

export const adminDocumentStatusValuesQuery = {
  id: "adminDocumentStatusValuesQuery" as const,
  op: "adminDocumentStatusValues",
  kind: "query" as const,
  query: `query adminDocumentStatusValues($schemaKey: String!) {
  admin {
    documentStatusValues(schemaKey: $schemaKey) {
      ...DocumentStatusValueFields
    }
  }
}
fragment DocumentStatusValueFields on DocumentStatusValueType {
  id
  schemaId
  key
  label
  description
  color
  icon
  sortOrder
  terminal
  okfStatus
  isActive
  metadata
}`,
};

export const adminDocumentTypesQuery = {
  id: "adminDocumentTypesQuery" as const,
  op: "adminDocumentTypes",
  kind: "query" as const,
  query: `query adminDocumentTypes {
  admin {
    documentTypes {
      ...DocumentTypeDefinitionFields
    }
  }
}
fragment DocumentTypeDefinitionFields on DocumentTypeDefinitionType {
  id
  key
  label
  description
  icon
  color
  isActive
  isSuggested
}`,
};

export const adminDocumentRuntimeOverviewQuery = {
  id: "adminDocumentRuntimeOverviewQuery" as const,
  op: "adminDocumentRuntimeOverview",
  kind: "query" as const,
  query: `query adminDocumentRuntimeOverview {
  admin {
    documentRuntimeOverview {
      totalDocuments
      byStatus {
        key
        label
        count
      }
      byDocumentType {
        key
        label
        count
      }
      byClassification {
        key
        label
        count
      }
      byReviewDue {
        key
        label
        count
      }
      byVersionState {
        key
        label
        count
      }
    }
  }
}`,
};

export const documentVersioningAdminSettingsQuery = {
  id: "documentVersioningAdminSettingsQuery" as const,
  op: "documentVersioningAdminSettings",
  kind: "query" as const,
  query: `query documentVersioningAdminSettings {
  admin {
    documentVersioningDefaults {
      defaultEnabled
      defaultAutoVersionOnPdfExport
      defaultRetentionCount
      defaultEditCaptureEnabled
      defaultEditCaptureIntervalMs
    }
    documentVersioningWorkspaceSettings {
      ...AdminDocumentVersioningWorkspaceSettingsFields
    }
  }
}
fragment AdminDocumentVersioningWorkspaceSettingsFields on AdminDocumentVersioningWorkspaceSettingsType {
  workspaceId
  workspaceName
  enabled
  autoVersionOnPdfExport
  retentionCount
  effectiveEnabled
  effectiveAutoVersionOnPdfExport
  effectiveRetentionCount
  editCaptureEnabled
  editCaptureIntervalMs
  effectiveEditCaptureEnabled
  effectiveEditCaptureIntervalMs
  legacyIntervalNormalized
  editCaptureRuntimeAvailable
  updatedAt
}`,
};

export const updateDocumentVersioningWorkspaceSettingsMutation = {
  id: "updateDocumentVersioningWorkspaceSettingsMutation" as const,
  op: "updateDocumentVersioningWorkspaceSettings",
  kind: "mutation" as const,
  query: `mutation updateDocumentVersioningWorkspaceSettings($input: AdminUpdateDocumentVersioningWorkspaceSettingsInput!) {
  admin {
    updateDocumentVersioningWorkspaceSettings(input: $input) {
      ...AdminDocumentVersioningWorkspaceSettingsFields
    }
  }
}
fragment AdminDocumentVersioningWorkspaceSettingsFields on AdminDocumentVersioningWorkspaceSettingsType {
  workspaceId
  workspaceName
  enabled
  autoVersionOnPdfExport
  retentionCount
  effectiveEnabled
  effectiveAutoVersionOnPdfExport
  effectiveRetentionCount
  editCaptureEnabled
  editCaptureIntervalMs
  effectiveEditCaptureEnabled
  effectiveEditCaptureIntervalMs
  legacyIntervalNormalized
  editCaptureRuntimeAvailable
  updatedAt
}`,
};

export const adminDocumentVersionPoliciesQuery = {
  id: "adminDocumentVersionPoliciesQuery" as const,
  op: "adminDocumentVersionPolicies",
  kind: "query" as const,
  query: `query adminDocumentVersionPolicies {
  admin {
    documentVersionPolicies {
      ...AdminDocumentVersionPolicyFields
    }
  }
}
fragment AdminDocumentVersionPolicyFields on DocumentVersionPolicyType {
  id
  scope
  workspaceId
  name
  isDefault
  enabledByDefault
  schemePreset
  customPattern
  timezoneMode
  autoVersionOn
  retentionCount
  pinManualVersions
  pinPublishVersions
  publishedVersionsProtected
  exportVersionsProtected
  metadataSchema
  createdBy
  createdAt
  updatedBy
  updatedAt
}`,
};

export const adminDocumentMetadataValueDefinitionsQuery = {
  id: "adminDocumentMetadataValueDefinitionsQuery" as const,
  op: "adminDocumentMetadataValueDefinitions",
  kind: "query" as const,
  query: `query adminDocumentMetadataValueDefinitions($fieldKey: String!) {
  admin {
    documentMetadataValueDefinitions(fieldKey: $fieldKey) {
      id
      fieldKey
      key
      label
      description
      color
      icon
      sortOrder
      isActive
      metadata
    }
  }
}`,
};

export const adminUpdateDocumentMetadataFieldDefinitionMutation = {
  id: "adminUpdateDocumentMetadataFieldDefinitionMutation" as const,
  op: "adminUpdateDocumentMetadataFieldDefinition",
  kind: "mutation" as const,
  query: `mutation adminUpdateDocumentMetadataFieldDefinition($input: AdminUpdateDocumentMetadataFieldDefinitionInput!) {
  admin {
    updateDocumentMetadataFieldDefinition(input: $input) {
      ...DocumentMetadataFieldDefinitionFields
    }
  }
}
fragment DocumentMetadataFieldDefinitionFields on DocumentMetadataFieldDefinitionType {
  key
  label
  enabled
  requiredMode
  editableBy
  visibleInHeader
  visibleInProperties
  visibleInLists
  exportMode
  validationConfig
  metadata
  updatedBy
  updatedAt
}`,
};

export const adminUpsertDocumentMetadataValueDefinitionMutation = {
  id: "adminUpsertDocumentMetadataValueDefinitionMutation" as const,
  op: "adminUpsertDocumentMetadataValueDefinition",
  kind: "mutation" as const,
  query: `mutation adminUpsertDocumentMetadataValueDefinition($input: AdminUpsertDocumentMetadataValueDefinitionInput!) {
  admin {
    upsertDocumentMetadataValueDefinition(input: $input) {
      id
      fieldKey
      key
      label
      description
      color
      icon
      sortOrder
      isActive
      metadata
    }
  }
}`,
};

export const adminUpsertDocumentStatusSchemaMutation = {
  id: "adminUpsertDocumentStatusSchemaMutation" as const,
  op: "adminUpsertDocumentStatusSchema",
  kind: "mutation" as const,
  query: `mutation adminUpsertDocumentStatusSchema($input: AdminUpsertDocumentStatusSchemaInput!) {
  admin {
    upsertDocumentStatusSchema(input: $input) {
      id
      key
      label
      description
      complexity
      isPreset
      isActive
      metadata
    }
  }
}`,
};

export const adminUpsertDocumentStatusValueMutation = {
  id: "adminUpsertDocumentStatusValueMutation" as const,
  op: "adminUpsertDocumentStatusValue",
  kind: "mutation" as const,
  query: `mutation adminUpsertDocumentStatusValue($input: AdminUpsertDocumentStatusValueInput!) {
  admin {
    upsertDocumentStatusValue(input: $input) {
      ...DocumentStatusValueFields
    }
  }
}
fragment DocumentStatusValueFields on DocumentStatusValueType {
  id
  schemaId
  key
  label
  description
  color
  icon
  sortOrder
  terminal
  okfStatus
  isActive
  metadata
}`,
};

export const adminUpsertDocumentStatusTransitionMutation = {
  id: "adminUpsertDocumentStatusTransitionMutation" as const,
  op: "adminUpsertDocumentStatusTransition",
  kind: "mutation" as const,
  query: `mutation adminUpsertDocumentStatusTransition($input: AdminUpsertDocumentStatusTransitionInput!) {
  admin {
    upsertDocumentStatusTransition(input: $input) {
      fromStatusId
      toStatusId
      requiredRoles
      requiredMetadataFields
      createsVersion
      setsVersionKind
      dateEnforcement
      metadata
    }
  }
}`,
};

export const adminUpsertDocumentTypeMutation = {
  id: "adminUpsertDocumentTypeMutation" as const,
  op: "adminUpsertDocumentType",
  kind: "mutation" as const,
  query: `mutation adminUpsertDocumentType($input: AdminUpsertDocumentTypeInput!) {
  admin {
    upsertDocumentType(input: $input) {
      ...DocumentTypeDefinitionFields
    }
  }
}
fragment DocumentTypeDefinitionFields on DocumentTypeDefinitionType {
  id
  key
  label
  description
  icon
  color
  isActive
  isSuggested
}`,
};

export const adminUpsertDocumentVersionPolicyMutation = {
  id: "adminUpsertDocumentVersionPolicyMutation" as const,
  op: "adminUpsertDocumentVersionPolicy",
  kind: "mutation" as const,
  query: `mutation adminUpsertDocumentVersionPolicy($input: AdminUpsertDocumentVersionPolicyInput!) {
  admin {
    upsertDocumentVersionPolicy(input: $input) {
      ...AdminDocumentVersionPolicyFields
    }
  }
}
fragment AdminDocumentVersionPolicyFields on DocumentVersionPolicyType {
  id
  scope
  workspaceId
  name
  isDefault
  enabledByDefault
  schemePreset
  customPattern
  timezoneMode
  autoVersionOn
  retentionCount
  pinManualVersions
  pinPublishVersions
  publishedVersionsProtected
  exportVersionsProtected
  metadataSchema
  createdBy
  createdAt
  updatedBy
  updatedAt
}`,
};

export const adminOidcGroupDirectoryQuery = {
  id: "adminOidcGroupDirectoryQuery" as const,
  op: "adminOidcGroupDirectory",
  kind: "query" as const,
  query: `query adminOidcGroupDirectory {
  admin {
    oidcGroupDirectory {
      entries {
        id
        displayName
        path
        claimValue
        state
      }
    }
  }
}`,
};

export const adminOrganizationExportQuery = {
  id: "adminOrganizationExportQuery" as const,
  op: "adminOrganizationExport",
  kind: "query" as const,
  query: `query adminOrganizationExport {
  admin {
    organizationExport {
      schemaVersion
      json
      files {
        name
        contentType
        content
      }
    }
  }
}`,
};

export const adminOrganizationImportApplyMutation = {
  id: "adminOrganizationImportApplyMutation" as const,
  op: "adminOrganizationImportApply",
  kind: "mutation" as const,
  query: `mutation adminOrganizationImportApply($input: OrganizationImportInput!) {
  admin {
    organizationImportApply(input: $input) {
      errors {
        source
        row
        field
        message
      }
      summary {
        organizationUpdated
        unitTypesInserted
        unitTypesUpdated
        unitsInserted
        unitsUpdated
        membersInserted
        membersUpdated
        workspaceLinksInserted
        workspaceLinksUpdated
        policyUpdated
      }
    }
  }
}`,
};

export const adminOrganizationImportDryRunMutation = {
  id: "adminOrganizationImportDryRunMutation" as const,
  op: "adminOrganizationImportDryRun",
  kind: "mutation" as const,
  query: `mutation adminOrganizationImportDryRun($input: OrganizationImportInput!) {
  admin {
    organizationImportDryRun(input: $input) {
      errors {
        source
        row
        field
        message
      }
      summary {
        organizationUpdated
        unitTypesInserted
        unitTypesUpdated
        unitsInserted
        unitsUpdated
        membersInserted
        membersUpdated
        workspaceLinksInserted
        workspaceLinksUpdated
        policyUpdated
      }
    }
  }
}`,
};

export const adminOrganizationPolicyQuery = {
  id: "adminOrganizationPolicyQuery" as const,
  op: "adminOrganizationPolicy",
  kind: "query" as const,
  query: `query adminOrganizationPolicy {
  admin {
    organizationPolicy {
      ...AdminOrganizationPolicyFragment
    }
  }
}
fragment AdminOrganizationPolicyFragment on OrganizationPolicyType {
  organizationId
  managerRootProjectCreation
  managerUnitProjectCreation
  managerCanCreateWorkspaces
  managerCanManageOuMembers
  importExportEnabled
  updatedBy
  updatedAt
}`,
};

export const adminOrganizationProjectRequestsQuery = {
  id: "adminOrganizationProjectRequestsQuery" as const,
  op: "adminOrganizationProjectRequests",
  kind: "query" as const,
  query: `query adminOrganizationProjectRequests($status: ProjectRequestStatusEnum) {
  admin {
    organizationProjectRequests(status: $status) {
      id
      organizationId
      requestedBy
      requestedScope
      parentUnitId
      proposedName
      proposedTypeId
      proposedMembers
      proposedWorkspace
      status
      decidedBy
      decidedAt
      metadata
      createdAt
      updatedAt
    }
  }
}`,
};

export const adminOrganizationUnitDeletionPreviewQuery = {
  id: "adminOrganizationUnitDeletionPreviewQuery" as const,
  op: "adminOrganizationUnitDeletionPreview",
  kind: "query" as const,
  query: `query adminOrganizationUnitDeletionPreview($id: ID!) {
  admin {
    organizationUnitDeletionPreview(id: $id) {
      id
      name
      status
      updatedAt
      deletable
      blockers {
        code
        count
      }
    }
  }
}`,
};

export const adminOrganizationUnitMembersQuery = {
  id: "adminOrganizationUnitMembersQuery" as const,
  op: "adminOrganizationUnitMembers",
  kind: "query" as const,
  query: `query adminOrganizationUnitMembers($unitId: ID!, $role: OrganizationUnitRoleEnum) {
  admin {
    organizationUnitMembers(unitId: $unitId, role: $role) {
      ...AdminOrganizationUnitMemberFragment
    }
  }
}
fragment AdminOrganizationUnitMemberFragment on OrganizationUnitMemberType {
  unitId
  userId
  userEmail
  userName
  userAvatarUrl
  role
  source
  metadata
  createdAt
  updatedAt
}`,
};

export const adminOrganizationUnitTypesQuery = {
  id: "adminOrganizationUnitTypesQuery" as const,
  op: "adminOrganizationUnitTypes",
  kind: "query" as const,
  query: `query adminOrganizationUnitTypes($includeInactive: Boolean) {
  admin {
    organizationUnitTypes(includeInactive: $includeInactive) {
      ...AdminOrganizationUnitTypeFragment
    }
  }
}
fragment AdminOrganizationUnitTypeFragment on OrganizationUnitTypeType {
  id
  organizationId
  key
  label
  description
  icon
  color
  isPreset
  isActive
  isStructural
  canHaveChildren
  canBeRootLevel
  canBeManagerCreated
  canHaveCrossUnitMembers
  canOwnWorkspaces
  canManageWorkspaces
  isStaffUnit
  requiresAdminApproval
  metadata
  createdAt
  updatedAt
}`,
};

export const adminOrganizationUnitWorkspacesQuery = {
  id: "adminOrganizationUnitWorkspacesQuery" as const,
  op: "adminOrganizationUnitWorkspaces",
  kind: "query" as const,
  query: `query adminOrganizationUnitWorkspaces($unitId: ID!) {
  admin {
    organizationUnitWorkspaces(unitId: $unitId) {
      unitId
      workspaceId
      workspaceName
      ownerUserId
      ownerEmail
      relationship
      storageUsedBytes
      effectiveQuotaBytes
      createdAt
      updatedAt
    }
  }
}`,
};

export const adminOrganizationUnitsQuery = {
  id: "adminOrganizationUnitsQuery" as const,
  op: "adminOrganizationUnits",
  kind: "query" as const,
  query: `query adminOrganizationUnits($status: OrganizationUnitStatusEnum) {
  admin {
    organizationUnits(status: $status) {
      ...AdminOrganizationUnitFragment
    }
  }
}
fragment AdminOrganizationUnitFragment on OrganizationUnitTypeOutput {
  id
  organizationId
  parentUnitId
  unitTypeId
  name
  slug
  description
  status
  maxMembers
  metadata
  createdBy
  childUnitCount
  memberCount
  workspaceCount
  createdAt
  updatedAt
}`,
};

export const adminOrganizationQuery = {
  id: "adminOrganizationQuery" as const,
  op: "adminOrganization",
  kind: "query" as const,
  query: `query adminOrganization {
  admin {
    organization {
      ...AdminOrganizationFragment
    }
  }
}
fragment AdminOrganizationFragment on OrganizationType {
  id
  key
  name
  slug
  metadata
  createdAt
  updatedAt
}`,
};

export const adminQueueStatusQuery = {
  id: "adminQueueStatusQuery" as const,
  op: "AdminQueueStatus",
  kind: "query" as const,
  query: `query AdminQueueStatus {
  admin {
    queueStatus {
      redisAvailable
      degraded
      queues {
        name
        displayName
        paused
        degraded
        history {
          timestamp
          pending
        }
        counts {
          waiting
          active
          completed
          failed
          delayed
          stalled
        }
      }
    }
  }
}`,
};

export const adminQueueJobsQuery = {
  id: "adminQueueJobsQuery" as const,
  op: "AdminQueueJobs",
  kind: "query" as const,
  query: `query AdminQueueJobs($queueName: String!, $status: String!, $cursor: Int!, $limit: Int!) {
  admin {
    queueJobs(
      queueName: $queueName
      status: $status
      cursor: $cursor
      limit: $limit
    ) {
      totalCount
      numOfPages
      nextCursor
      jobs {
        id
        name
        timestamp
        attemptsMade
        finishedOn
        failedReason
        data
        returnValue
        workspaceContentOperation {
          ...WorkspaceContentOperationProjection
        }
      }
    }
  }
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const adminPauseQueueMutation = {
  id: "adminPauseQueueMutation" as const,
  op: "AdminPauseQueue",
  kind: "mutation" as const,
  query: `mutation AdminPauseQueue($queueName: String!) {
  admin {
    pauseQueue(queueName: $queueName) {
      ok
      name
      error
    }
  }
}`,
};

export const adminResumeQueueMutation = {
  id: "adminResumeQueueMutation" as const,
  op: "AdminResumeQueue",
  kind: "mutation" as const,
  query: `mutation AdminResumeQueue($queueName: String!) {
  admin {
    resumeQueue(queueName: $queueName) {
      ok
      name
      error
    }
  }
}`,
};

export const adminPauseAllQueuesMutation = {
  id: "adminPauseAllQueuesMutation" as const,
  op: "AdminPauseAllQueues",
  kind: "mutation" as const,
  query: `mutation AdminPauseAllQueues {
  admin {
    pauseAllQueues {
      ok
      failed
      error
    }
  }
}`,
};

export const adminResumeAllQueuesMutation = {
  id: "adminResumeAllQueuesMutation" as const,
  op: "AdminResumeAllQueues",
  kind: "mutation" as const,
  query: `mutation AdminResumeAllQueues {
  admin {
    resumeAllQueues {
      ok
      failed
      error
    }
  }
}`,
};

export const adminCleanQueueMutation = {
  id: "adminCleanQueueMutation" as const,
  op: "AdminCleanQueue",
  kind: "mutation" as const,
  query: `mutation AdminCleanQueue($queueName: String!, $status: String!, $gracePeriodMs: Int!) {
  admin {
    cleanQueue(
      queueName: $queueName
      status: $status
      gracePeriodMs: $gracePeriodMs
    ) {
      ok
      name
      removed
      error
    }
  }
}`,
};

export const adminEmptyQueueMutation = {
  id: "adminEmptyQueueMutation" as const,
  op: "AdminEmptyQueue",
  kind: "mutation" as const,
  query: `mutation AdminEmptyQueue($queueName: String!) {
  admin {
    emptyQueue(queueName: $queueName) {
      ok
      name
      removed
      error
    }
  }
}`,
};

export const adminRetryQueueJobMutation = {
  id: "adminRetryQueueJobMutation" as const,
  op: "AdminRetryQueueJob",
  kind: "mutation" as const,
  query: `mutation AdminRetryQueueJob($queueName: String!, $jobId: String!) {
  admin {
    retryJob(queueName: $queueName, jobId: $jobId) {
      ok
      name
      jobId
      error
    }
  }
}`,
};

export const adminPromoteQueueJobMutation = {
  id: "adminPromoteQueueJobMutation" as const,
  op: "AdminPromoteQueueJob",
  kind: "mutation" as const,
  query: `mutation AdminPromoteQueueJob($queueName: String!, $jobId: String!) {
  admin {
    promoteJob(queueName: $queueName, jobId: $jobId) {
      ok
      name
      jobId
      error
    }
  }
}`,
};

export const adminRemoveWorkspaceMemberMutation = {
  id: "adminRemoveWorkspaceMemberMutation" as const,
  op: "adminRemoveWorkspaceMember",
  kind: "mutation" as const,
  query: `mutation adminRemoveWorkspaceMember($workspaceId: ID!, $userId: ID!) {
  admin {
    adminRemoveWorkspaceMember(workspaceId: $workspaceId, userId: $userId)
  }
}`,
};

export const adminMetricsStatusQuery = {
  id: "adminMetricsStatusQuery" as const,
  op: "AdminMetricsStatus",
  kind: "query" as const,
  query: `query AdminMetricsStatus {
  admin {
    metricsStatus {
      enabled
      prometheusEnabled
      persistenceEnabled
      categories
      flushIntervalSeconds
      retentionRawDays
      retentionDailyDays
      cardinalityLimitPerMetric
      labelWorkspaceIdEnabled
      activeSeries
      persisted24h
      dailyRollups7d
      lastFlushAt
      lastFlushCount
      counters {
        offeredTotal
        acceptedTotal
        rejectedDisabledTotal
        cardinalityDropsTotal
        snapshotsTotal
      }
      topSeries {
        category
        name
        labels
        value
      }
    }
  }
}`,
};

export const flushMetricsMutation = {
  id: "flushMetricsMutation" as const,
  op: "FlushMetrics",
  kind: "mutation" as const,
  query: `mutation FlushMetrics {
  admin {
    flushMetrics {
      buffered
      inserted
    }
  }
}`,
};

export const adminTelemetryStatusQuery = {
  id: "adminTelemetryStatusQuery" as const,
  op: "AdminTelemetryStatus",
  kind: "query" as const,
  query: `query AdminTelemetryStatus {
  admin {
    telemetryStatus {
      enabled
      categories
      samplingRates
      retentionRawDays
      retentionDailyDays
      flushIntervalSeconds
      batchMaxEvents
      dedupeTtlHours
      ingestRateLimitPerIpPerMin
      counters {
        offeredTotal
        acceptedTotal
        rejectedDisabledTotal
        rejectedCategoryTotal
        rejectedSampledTotal
        rejectedDuplicateTotal
        rejectedInvalidTotal
        bufferOverflowTotal
        flushedTotal
      }
      hotBufferLen
      persisted24h
      dailyRollups7d
      lastFlushAt
      lastFlushCount
      dedupeHitRate
    }
  }
}`,
};

export const flushTelemetryMutation = {
  id: "flushTelemetryMutation" as const,
  op: "FlushTelemetry",
  kind: "mutation" as const,
  query: `mutation FlushTelemetry {
  admin {
    flushTelemetry {
      buffered
      inserted
    }
  }
}`,
};

export const adminServerConfigQuery = {
  id: "adminServerConfigQuery" as const,
  op: "adminServerConfig",
  kind: "query" as const,
  query: `query adminServerConfig {
  admin {
    serverInfo {
      version
      baseUrl
      name
      features
      type
      deploymentType
      initialized
      i18n {
        defaultLocale
        availableLocales
      }
      credentialsRequirement {
        ...CredentialsRequirements
      }
      availableUpgrade {
        changelog
        version
        publishedAt
        url
      }
      availableUserFeatures
      availableWorkspaceFeatures
    }
  }
}
fragment CredentialsRequirements on CredentialsRequirementType {
  password {
    ...PasswordLimits
  }
}
fragment PasswordLimits on PasswordLimitsType {
  minLength
  maxLength
}`,
};

export const adminSetOrganizationUnitParentMutation = {
  id: "adminSetOrganizationUnitParentMutation" as const,
  op: "adminSetOrganizationUnitParent",
  kind: "mutation" as const,
  query: `mutation adminSetOrganizationUnitParent($unitId: ID!, $parentUnitId: ID) {
  admin {
    setOrganizationUnitParent(unitId: $unitId, parentUnitId: $parentUnitId)
  }
}`,
};

export const adminSetOrganizationUnitStatusMutation = {
  id: "adminSetOrganizationUnitStatusMutation" as const,
  op: "adminSetOrganizationUnitStatus",
  kind: "mutation" as const,
  query: `mutation adminSetOrganizationUnitStatus($id: ID!, $status: OrganizationUnitStatusEnum!) {
  admin {
    setOrganizationUnitStatus(id: $id, status: $status) {
      ...AdminOrganizationUnitFragment
    }
  }
}
fragment AdminOrganizationUnitFragment on OrganizationUnitTypeOutput {
  id
  organizationId
  parentUnitId
  unitTypeId
  name
  slug
  description
  status
  maxMembers
  metadata
  createdBy
  childUnitCount
  memberCount
  workspaceCount
  createdAt
  updatedAt
}`,
};

export const adminSetUserManagerFeatureMutation = {
  id: "adminSetUserManagerFeatureMutation" as const,
  op: "adminSetUserManagerFeature",
  kind: "mutation" as const,
  query: `mutation adminSetUserManagerFeature($userId: ID!, $enabled: Boolean!) {
  admin {
    setUserManagerFeature(userId: $userId, enabled: $enabled)
  }
}`,
};

export const adminTestOidcProviderMutation = {
  id: "adminTestOidcProviderMutation" as const,
  op: "adminTestOidcProvider",
  kind: "mutation" as const,
  query: `mutation adminTestOidcProvider($config: JSON!, $sampleClaims: JSON) {
  admin {
    testOidcProvider(config: $config, sampleClaims: $sampleClaims) {
      discoveryOk
      jwksOk
      issuer
      authorizationEndpointPresent
      tokenEndpointPresent
      userinfoEndpointPresent
      jwksKeyCount
      groupsClaimPresent
      groupsCount
      mappedGroupsCount
      unknownGroupsCount
      warnings
    }
  }
}`,
};

export const adminTranscriptionStatusQuery = {
  id: "adminTranscriptionStatusQuery" as const,
  op: "adminTranscriptionStatus",
  kind: "query" as const,
  query: `query adminTranscriptionStatus {
  admin {
    transcriptionStatus {
      capability {
        enabled
        configured
        status
      }
      lastConnectionCheck {
        successful
        catalogSupported
        modelListed
        error
      }
    }
  }
}`,
};

export const adminCheckTranscriptionConnectionMutation = {
  id: "adminCheckTranscriptionConnectionMutation" as const,
  op: "adminCheckTranscriptionConnection",
  kind: "mutation" as const,
  query: `mutation adminCheckTranscriptionConnection {
  admin {
    checkTranscriptionConnection {
      successful
      catalogSupported
      modelListed
      error
    }
  }
}`,
};

export const adminUnassignOrganizationManagerMutation = {
  id: "adminUnassignOrganizationManagerMutation" as const,
  op: "adminUnassignOrganizationManager",
  kind: "mutation" as const,
  query: `mutation adminUnassignOrganizationManager($unitId: ID!, $userId: ID!) {
  admin {
    unassignOrganizationManager(unitId: $unitId, userId: $userId)
  }
}`,
};

export const adminUnassignOrganizationUnitWorkspaceMutation = {
  id: "adminUnassignOrganizationUnitWorkspaceMutation" as const,
  op: "adminUnassignOrganizationUnitWorkspace",
  kind: "mutation" as const,
  query: `mutation adminUnassignOrganizationUnitWorkspace($unitId: ID!, $workspaceId: ID!, $relationship: OrganizationUnitWorkspaceRelationshipEnum!) {
  admin {
    unassignOrganizationUnitWorkspace(
      unitId: $unitId
      workspaceId: $workspaceId
      relationship: $relationship
    )
  }
}`,
};

export const adminUpdateOrganizationPolicyMutation = {
  id: "adminUpdateOrganizationPolicyMutation" as const,
  op: "adminUpdateOrganizationPolicy",
  kind: "mutation" as const,
  query: `mutation adminUpdateOrganizationPolicy($input: UpdateOrganizationPolicyInput!) {
  admin {
    updateOrganizationPolicy(input: $input) {
      ...AdminOrganizationPolicyFragment
    }
  }
}
fragment AdminOrganizationPolicyFragment on OrganizationPolicyType {
  organizationId
  managerRootProjectCreation
  managerUnitProjectCreation
  managerCanCreateWorkspaces
  managerCanManageOuMembers
  importExportEnabled
  updatedBy
  updatedAt
}`,
};

export const adminUpdateOrganizationMutation = {
  id: "adminUpdateOrganizationMutation" as const,
  op: "adminUpdateOrganization",
  kind: "mutation" as const,
  query: `mutation adminUpdateOrganization($input: UpdateOrganizationInput!) {
  admin {
    updateOrganization(input: $input) {
      ...AdminOrganizationFragment
    }
  }
}
fragment AdminOrganizationFragment on OrganizationType {
  id
  key
  name
  slug
  metadata
  createdAt
  updatedAt
}`,
};

export const adminUpdateWorkspaceMemberRoleMutation = {
  id: "adminUpdateWorkspaceMemberRoleMutation" as const,
  op: "adminUpdateWorkspaceMemberRole",
  kind: "mutation" as const,
  query: `mutation adminUpdateWorkspaceMemberRole($workspaceId: ID!, $userId: ID!, $role: Permission!) {
  admin {
    adminUpdateWorkspaceMemberRole(
      workspaceId: $workspaceId
      userId: $userId
      role: $role
    )
  }
}`,
};

export const adminUpdateWorkspaceMutation = {
  id: "adminUpdateWorkspaceMutation" as const,
  op: "adminUpdateWorkspace",
  kind: "mutation" as const,
  query: `mutation adminUpdateWorkspace($input: AdminUpdateWorkspaceInput!) {
  admin {
    adminUpdateWorkspace(input: $input) {
      id
      public
      createdAt
      name
      avatarKey
      enableAi
      enableSharing
      enableUrlPreview
      enableDocEmbedding
      features
      owner {
        id
        name
        email
        avatarUrl
      }
      memberCount
      publicPageCount
      snapshotCount
      snapshotSize
      blobCount
      blobSize
      storageQuotaBytes
      storageQuotaUsed
    }
  }
}`,
};

export const adminUpsertOrganizationUnitTypeMutation = {
  id: "adminUpsertOrganizationUnitTypeMutation" as const,
  op: "adminUpsertOrganizationUnitType",
  kind: "mutation" as const,
  query: `mutation adminUpsertOrganizationUnitType($input: UpsertOrganizationUnitTypeInput!) {
  admin {
    upsertOrganizationUnitType(input: $input) {
      ...AdminOrganizationUnitTypeFragment
    }
  }
}
fragment AdminOrganizationUnitTypeFragment on OrganizationUnitTypeType {
  id
  organizationId
  key
  label
  description
  icon
  color
  isPreset
  isActive
  isStructural
  canHaveChildren
  canBeRootLevel
  canBeManagerCreated
  canHaveCrossUnitMembers
  canOwnWorkspaces
  canManageWorkspaces
  isStaffUnit
  requiresAdminApproval
  metadata
  createdAt
  updatedAt
}`,
};

export const adminUpsertOrganizationUnitMutation = {
  id: "adminUpsertOrganizationUnitMutation" as const,
  op: "adminUpsertOrganizationUnit",
  kind: "mutation" as const,
  query: `mutation adminUpsertOrganizationUnit($input: UpsertOrganizationUnitInput!) {
  admin {
    upsertOrganizationUnit(input: $input) {
      ...AdminOrganizationUnitFragment
    }
  }
}
fragment AdminOrganizationUnitFragment on OrganizationUnitTypeOutput {
  id
  organizationId
  parentUnitId
  unitTypeId
  name
  slug
  description
  status
  maxMembers
  metadata
  createdBy
  childUnitCount
  memberCount
  workspaceCount
  createdAt
  updatedAt
}`,
};

export const adminWorkspaceOrganizationUnitWorkspacesQuery = {
  id: "adminWorkspaceOrganizationUnitWorkspacesQuery" as const,
  op: "adminWorkspaceOrganizationUnitWorkspaces",
  kind: "query" as const,
  query: `query adminWorkspaceOrganizationUnitWorkspaces($workspaceId: ID!) {
  admin {
    workspaceOrganizationUnitWorkspaces(workspaceId: $workspaceId) {
      unitId
      unitName
      unitSlug
      workspaceId
      workspaceName
      ownerUserId
      ownerEmail
      relationship
      storageUsedBytes
      effectiveQuotaBytes
      createdAt
      updatedAt
    }
  }
}`,
};

export const adminWorkspaceQuotaDetailsQuery = {
  id: "adminWorkspaceQuotaDetailsQuery" as const,
  op: "adminWorkspaceQuotaDetails",
  kind: "query" as const,
  query: `query adminWorkspaceQuotaDetails($workspaceId: ID!) {
  admin {
    adminWorkspaceQuotaDetails(workspaceId: $workspaceId) {
      source
      workspaceOverrideBytes
      configDefaultMb
      effectiveBytes
      usedBytes
    }
  }
}`,
};

export const adminWorkspaceQuery = {
  id: "adminWorkspaceQuery" as const,
  op: "adminWorkspace",
  kind: "query" as const,
  query: `query adminWorkspace($id: String!, $memberSkip: Int, $memberTake: Int, $memberQuery: String) {
  admin {
    adminWorkspace(id: $id) {
      id
      public
      createdAt
      name
      avatarKey
      isPersonal
      workspaceType
      ownerPrincipalType
      ownerPrincipalId
      ownerPrincipalName
      enableAi
      enableSharing
      enableUrlPreview
      enableDocEmbedding
      features
      owner {
        id
        name
        email
        avatarUrl
      }
      memberCount
      publicPageCount
      snapshotCount
      snapshotSize
      blobCount
      blobSize
      storageQuotaBytes
      storageQuotaUsed
      sharedLinks {
        workspaceId
        docId
        title
        publicMode
        status
        shareUrl
        publishedAt
      }
      members(skip: $memberSkip, take: $memberTake, query: $memberQuery) {
        id
        name
        email
        avatarUrl
        role
        status
      }
    }
  }
}`,
};

export const adminWorkspacesQuery = {
  id: "adminWorkspacesQuery" as const,
  op: "adminWorkspaces",
  kind: "query" as const,
  query: `query adminWorkspaces($filter: ListWorkspaceInput!) {
  admin {
    adminWorkspaces(filter: $filter) {
      id
      public
      createdAt
      name
      avatarKey
      enableAi
      enableSharing
      enableUrlPreview
      enableDocEmbedding
      features
      owner {
        id
        name
        email
        avatarUrl
      }
      ownerPrincipalType
      ownerPrincipalId
      ownerPrincipalName
      memberCount
      publicPageCount
      snapshotCount
      snapshotSize
      blobCount
      blobSize
      storageQuotaBytes
      storageQuotaUsed
      isPersonal
      workspaceType
      gitSyncEnabled
      gitSyncProfileId
      gitSyncLastStatus
      gitSyncTriggerMode
      gitSyncNextScheduledAt
      gitSyncTokenRotationProvider
      gitSyncTokenRotationEnabled
      gitSyncTokenRotationState
    }
  }
}`,
};

export const adminWorkspacesCountQuery = {
  id: "adminWorkspacesCountQuery" as const,
  op: "adminWorkspacesCount",
  kind: "query" as const,
  query: `query adminWorkspacesCount($filter: ListWorkspaceInput!) {
  admin {
    adminWorkspacesCount(filter: $filter)
  }
}`,
};

export const adminWorkspacesListQuery = {
  id: "adminWorkspacesListQuery" as const,
  op: "adminWorkspacesList",
  kind: "query" as const,
  query: `query adminWorkspacesList($filter: ListWorkspaceInput!) {
  admin {
    adminWorkspaces(filter: $filter) {
      id
      public
      createdAt
      name
      avatarKey
      enableAi
      enableSharing
      enableUrlPreview
      enableDocEmbedding
      features
      owner {
        id
        name
        email
        avatarUrl
      }
      ownerPrincipalType
      ownerPrincipalId
      ownerPrincipalName
      memberCount
      publicPageCount
      snapshotCount
      snapshotSize
      blobCount
      blobSize
      storageQuotaBytes
      storageQuotaUsed
      isPersonal
      workspaceType
      gitSyncEnabled
      gitSyncProfileId
      gitSyncLastStatus
      gitSyncTriggerMode
      gitSyncNextScheduledAt
      gitSyncTokenRotationProvider
      gitSyncTokenRotationEnabled
      gitSyncTokenRotationState
    }
    adminWorkspacesCount(filter: $filter)
  }
}`,
};

export const adminAppServerBrandingQuery = {
  id: "adminAppServerBrandingQuery" as const,
  op: "adminAppServerBranding",
  kind: "query" as const,
  query: `query adminAppServerBranding {
  admin {
    appServerBranding {
      logo {
        id
        slot
        variant
        qualityClass
        storageKind
        storageKey
        publicUrl
        mime
        sha256
        byteSize
        widthPx
        heightPx
      }
      productMark {
        id
        slot
        variant
        qualityClass
        storageKind
        storageKey
        publicUrl
        mime
        sha256
        byteSize
        widthPx
        heightPx
      }
      faviconPack {
        id
        slot
        variant
        qualityClass
        storageKind
        storageKey
        publicUrl
        mime
        sha256
        byteSize
        widthPx
        heightPx
      }
    }
  }
}`,
};

export const adminOrganizationIdentityQuery = {
  id: "adminOrganizationIdentityQuery" as const,
  op: "adminOrganizationIdentity",
  kind: "query" as const,
  query: `query adminOrganizationIdentity {
  admin {
    organizationIdentity {
      displayName
      legalName
      shortName
      jurisdiction
      websiteUrl
      contactEmail
      addressLines
      taxId
      registrationId
    }
  }
}`,
};

export const adminUpdateOrganizationIdentityMutation = {
  id: "adminUpdateOrganizationIdentityMutation" as const,
  op: "adminUpdateOrganizationIdentity",
  kind: "mutation" as const,
  query: `mutation adminUpdateOrganizationIdentity($input: UpdateOrganizationIdentityInput!) {
  admin {
    updateOrganizationIdentity(input: $input) {
      displayName
      legalName
      shortName
      jurisdiction
      websiteUrl
      contactEmail
      addressLines
      taxId
      registrationId
    }
  }
}`,
};

export const adminUpdateAppServerBrandingMutation = {
  id: "adminUpdateAppServerBrandingMutation" as const,
  op: "adminUpdateAppServerBranding",
  kind: "mutation" as const,
  query: `mutation adminUpdateAppServerBranding($input: UpdateAppServerBrandingInput!) {
  admin {
    updateAppServerBranding(input: $input) {
      logo {
        id
        slot
        variant
        qualityClass
        storageKind
        storageKey
        publicUrl
        mime
        sha256
        byteSize
        widthPx
        heightPx
      }
      productMark {
        id
        slot
        variant
        qualityClass
        storageKind
        storageKey
        publicUrl
        mime
        sha256
        byteSize
        widthPx
        heightPx
      }
      faviconPack {
        id
        slot
        variant
        qualityClass
        storageKind
        storageKey
        publicUrl
        mime
        sha256
        byteSize
        widthPx
        heightPx
      }
    }
  }
}`,
};

export const adminFlushDocSnapshotCacheMutation = {
  id: "adminFlushDocSnapshotCacheMutation" as const,
  op: "adminFlushDocSnapshotCache",
  kind: "mutation" as const,
  query: `mutation adminFlushDocSnapshotCache {
  admin {
    adminFlushDocSnapshotCache
  }
}`,
};

export const adminFlushDocMetadataCacheMutation = {
  id: "adminFlushDocMetadataCacheMutation" as const,
  op: "adminFlushDocMetadataCache",
  kind: "mutation" as const,
  query: `mutation adminFlushDocMetadataCache {
  admin {
    adminFlushDocMetadataCache
  }
}`,
};

export const adminFlushDocMetadataProjectionCacheMutation = {
  id: "adminFlushDocMetadataProjectionCacheMutation" as const,
  op: "adminFlushDocMetadataProjectionCache",
  kind: "mutation" as const,
  query: `mutation adminFlushDocMetadataProjectionCache {
  admin {
    adminFlushDocMetadataProjectionCache
  }
}`,
};

export const adminFlushAllDocCachesMutation = {
  id: "adminFlushAllDocCachesMutation" as const,
  op: "adminFlushAllDocCaches",
  kind: "mutation" as const,
  query: `mutation adminFlushAllDocCaches {
  admin {
    adminFlushAllDocCaches
  }
}`,
};

export const adminCacheTuningHistoryQuery = {
  id: "adminCacheTuningHistoryQuery" as const,
  op: "adminCacheTuningHistory",
  kind: "query" as const,
  query: `query adminCacheTuningHistory($cacheName: String!, $hours: Int) {
  admin {
    adminCacheTuningHistory(cacheName: $cacheName, hours: $hours) {
      bucket
      hitRate
      ttlSeconds
    }
  }
}`,
};

export const adminCacheTuningStatusQuery = {
  id: "adminCacheTuningStatusQuery" as const,
  op: "adminCacheTuningStatus",
  kind: "query" as const,
  query: `query adminCacheTuningStatus {
  admin {
    adminCacheTuningStatus {
      name
      currentTtlSeconds
      hitRate1H
      hitRate24H
      lastAction
      lastActionAt
      isFixedOverride
    }
  }
}`,
};

export const createChangePasswordUrlMutation = {
  id: "createChangePasswordUrlMutation" as const,
  op: "createChangePasswordUrl",
  kind: "mutation" as const,
  query: `mutation createChangePasswordUrl($userId: String!) {
  admin {
    createChangePasswordUrl(userId: $userId)
  }
}`,
};

export const adminConfigChangelogQuery = {
  id: "adminConfigChangelogQuery" as const,
  op: "adminConfigChangelog",
  kind: "query" as const,
  query: `query adminConfigChangelog($limit: Int, $offset: Int) {
  admin {
    configChangelog(limit: $limit, offset: $offset) {
      id
      configKey
      oldValue
      newValue
      changedBy {
        id
        name
        email
      }
      changedAt
    }
  }
}`,
};

export const adminConfigSchemaQuery = {
  id: "adminConfigSchemaQuery" as const,
  op: "adminConfigSchema",
  kind: "query" as const,
  query: `query adminConfigSchema {
  admin {
    adminConfigSchema {
      revision
      modules {
        module
        label
        groups {
          groupKey
          label
          helpText
          fields {
            key
            path
            groupKey
            label
            helpText
            databaseWritable
            sensitive
            immediate_apply: immediateApply
            restart_required: requiresRestart
            enum
            min
            max
            valueType
            defaultValue
          }
        }
      }
      effectiveFields {
        path
        winningSource
        runtimeEffectiveState
        requiresRestart
        sensitive
      }
    }
  }
}`,
};

export const adminUpdateConfigMutation = {
  id: "adminUpdateConfigMutation" as const,
  op: "adminUpdateConfig",
  kind: "mutation" as const,
  query: `mutation adminUpdateConfig($updates: [UpdateAppConfigInput!]!) {
  admin {
    adminUpdateConfig(updates: $updates) {
      applied
      writeback
      fieldErrors {
        module
        key
        path
        message
      }
      config {
        revision
        modules {
          module
          groups {
            fields {
              path
              value
            }
          }
        }
        effectiveFields {
          path
          runtimeEffectiveValue
          winningSource
          runtimeEffectiveState
          requiresRestart
          sensitive
        }
      }
    }
  }
}`,
};

export const adminConfigValuesQuery = {
  id: "adminConfigValuesQuery" as const,
  op: "adminConfigValues",
  kind: "query" as const,
  query: `query adminConfigValues {
  admin {
    adminConfigValues {
      revision
      modules {
        module
        groups {
          fields {
            path
            value
          }
        }
      }
      effectiveFields {
        path
        runtimeEffectiveValue
        winningSource
        runtimeEffectiveState
        requiresRestart
        sensitive
      }
    }
  }
}`,
};

export const createUserMutation = {
  id: "createUserMutation" as const,
  op: "createUser",
  kind: "mutation" as const,
  query: `mutation createUser($input: CreateUserInput!) {
  admin {
    createUser(input: $input) {
      id
    }
  }
}`,
};

export const deleteUserMutation = {
  id: "deleteUserMutation" as const,
  op: "deleteUser",
  kind: "mutation" as const,
  query: `mutation deleteUser($id: String!) {
  admin {
    deleteUser(id: $id) {
      success
    }
  }
}`,
};

export const disableUserMutation = {
  id: "disableUserMutation" as const,
  op: "disableUser",
  kind: "mutation" as const,
  query: `mutation disableUser($id: String!) {
  admin {
    banUser(id: $id) {
      email
      disabled
    }
  }
}`,
};

export const enableUserMutation = {
  id: "enableUserMutation" as const,
  op: "enableUser",
  kind: "mutation" as const,
  query: `mutation enableUser($id: String!) {
  admin {
    enableUser(id: $id) {
      email
      disabled
    }
  }
}`,
};

export const getUserByEmailQuery = {
  id: "getUserByEmailQuery" as const,
  op: "getUserByEmail",
  kind: "query" as const,
  query: `query getUserByEmail($email: String!) {
  admin {
    userByEmail(email: $email) {
      id
      name
      email
      features
      hasPassword
      emailVerified
      avatarUrl
      disabled
    }
  }
}`,
};

export const adminGitTokenRotationQuery = {
  id: "adminGitTokenRotationQuery" as const,
  op: "adminGitTokenRotation",
  kind: "query" as const,
  query: `query adminGitTokenRotation($profileId: String!) {
  admin {
    gitTokenRotationProviders
    gitTokenRotationStatus(profileId: $profileId) {
      profileId
      provider
      enabled
      state
      renewBeforeDays
      requestedLifetimeDays
      currentCredentialExpiresAt
      nextAttemptAt
      lastAttemptAt
      lastSuccessAt
      diagnosis
    }
  }
}`,
};

export const configureGitTokenRotationMutation = {
  id: "configureGitTokenRotationMutation" as const,
  op: "configureGitTokenRotation",
  kind: "mutation" as const,
  query: `mutation configureGitTokenRotation($input: ConfigureGitTokenRotationInput!) {
  admin {
    configureGitTokenRotation(input: $input) {
      profileId
      provider
      enabled
      state
      renewBeforeDays
      requestedLifetimeDays
      currentCredentialExpiresAt
      nextAttemptAt
      lastAttemptAt
      lastSuccessAt
      diagnosis
    }
  }
}`,
};

export const runGitTokenRotationNowMutation = {
  id: "runGitTokenRotationNowMutation" as const,
  op: "runGitTokenRotationNow",
  kind: "mutation" as const,
  query: `mutation runGitTokenRotationNow($profileId: String!) {
  admin {
    runGitTokenRotationNow(profileId: $profileId) {
      profileId
      provider
      enabled
      state
      renewBeforeDays
      requestedLifetimeDays
      currentCredentialExpiresAt
      nextAttemptAt
      lastAttemptAt
      lastSuccessAt
      diagnosis
    }
  }
}`,
};

export const importUsersMutation = {
  id: "importUsersMutation" as const,
  op: "ImportUsers",
  kind: "mutation" as const,
  query: `mutation ImportUsers($input: ImportUsersInput!) {
  admin {
    importUsers(input: $input) {
      __typename
      ... on UserType {
        id
        name
        email
      }
      ... on UserImportFailedType {
        email
        error
      }
    }
  }
}`,
};

export const listUsersQuery = {
  id: "listUsersQuery" as const,
  op: "listUsers",
  kind: "query" as const,
  query: `query listUsers($filter: ListUserInput!) {
  admin {
    users(filter: $filter) {
      id
      name
      email
      disabled
      features
      hasPassword
      emailVerified
      avatarUrl
    }
    usersCount(filter: $filter)
  }
}`,
};

export const loggingConfigQuery = {
  id: "loggingConfigQuery" as const,
  op: "loggingConfig",
  kind: "query" as const,
  query: `query loggingConfig {
  admin {
    loggingConfig {
      modules {
        group
        displayName
        level
        recommendedDefault
        description
        highVolumeWarning
      }
      output {
        filePath
        rotation
        maxFiles
        pathValid
        pathError
        requiresRestart
      }
      recentChanges {
        timestamp
        group
        previousLevel
        newLevel
        changedBy
        autoRevertAt
      }
      diskUsage {
        totalBytes
        fileCount
        freeBytes
      }
    }
  }
}`,
};

export const updateLogModuleLevelMutation = {
  id: "updateLogModuleLevelMutation" as const,
  op: "updateLogModuleLevel",
  kind: "mutation" as const,
  query: `mutation updateLogModuleLevel($input: UpdateLogModuleLevelInput!) {
  admin {
    updateLogModuleLevel(input: $input) {
      group
      displayName
      level
      recommendedDefault
      description
      highVolumeWarning
    }
  }
}`,
};

export const applyLogPresetMutation = {
  id: "applyLogPresetMutation" as const,
  op: "applyLogPreset",
  kind: "mutation" as const,
  query: `mutation applyLogPreset($preset: String!) {
  admin {
    applyLogPreset(preset: $preset) {
      group
      displayName
      level
      recommendedDefault
      description
      highVolumeWarning
    }
  }
}`,
};

export const resetLogLevelsMutation = {
  id: "resetLogLevelsMutation" as const,
  op: "resetLogLevels",
  kind: "mutation" as const,
  query: `mutation resetLogLevels {
  admin {
    resetLogLevels {
      group
      displayName
      level
      recommendedDefault
      description
      highVolumeWarning
    }
  }
}`,
};

export const updateLogOutputMutation = {
  id: "updateLogOutputMutation" as const,
  op: "updateLogOutput",
  kind: "mutation" as const,
  query: `mutation updateLogOutput($input: UpdateLogOutputInput!) {
  admin {
    updateLogOutput(input: $input) {
      filePath
      rotation
      maxFiles
      pathValid
      pathError
      requiresRestart
    }
  }
}`,
};

export const orphanedWorkspacesQuery = {
  id: "orphanedWorkspacesQuery" as const,
  op: "orphanedWorkspaces",
  kind: "query" as const,
  query: `query orphanedWorkspaces($skip: Int, $take: Int) {
  admin {
    orphanedWorkspaces(skip: $skip, take: $take) {
      id
      name
      createdAt
      enableAi
      enableSharing
      memberCount
    }
  }
}`,
};

export const orphanedWorkspacesCountQuery = {
  id: "orphanedWorkspacesCountQuery" as const,
  op: "orphanedWorkspacesCount",
  kind: "query" as const,
  query: `query orphanedWorkspacesCount {
  admin {
    orphanedWorkspacesCount
  }
}`,
};

export const reassignWorkspaceOwnerMutation = {
  id: "reassignWorkspaceOwnerMutation" as const,
  op: "reassignWorkspaceOwner",
  kind: "mutation" as const,
  query: `mutation reassignWorkspaceOwner($workspaceId: String!, $newOwnerId: String!) {
  admin {
    reassignWorkspaceOwner(workspaceId: $workspaceId, newOwnerId: $newOwnerId)
  }
}`,
};

export const adminDocumentBrandingProfileQuery = {
  id: "adminDocumentBrandingProfileQuery" as const,
  op: "adminDocumentBrandingProfile",
  kind: "query" as const,
  query: `query adminDocumentBrandingProfile($workspaceId: ID!) {
  admin {
    documentBrandingProfile(workspaceId: $workspaceId) {
      workspaceId
      logoLargeBlob
      logoSmallBlob
      footerText
      colorPolicy
      colorPaletteKey
      brandColorPrimary
      brandColorAccent
      brandColorRule
      brandColorText
      brandColorBackground
      updatedAt
      updatedBy
    }
  }
}`,
};

export const adminDocumentBrandColorPalettesQuery = {
  id: "adminDocumentBrandColorPalettesQuery" as const,
  op: "adminDocumentBrandColorPalettes",
  kind: "query" as const,
  query: `query adminDocumentBrandColorPalettes($workspaceId: ID!) {
  admin {
    documentBrandColorPalettes(workspaceId: $workspaceId) {
      themeSlug
      themeName
      paletteKey
      name
      primaryColor
      accentColor
      ruleColor
      textColor
      backgroundColor
      isDefault
    }
  }
}`,
};

export const adminPdfExportSettingsQuery = {
  id: "adminPdfExportSettingsQuery" as const,
  op: "adminPdfExportSettings",
  kind: "query" as const,
  query: `query adminPdfExportSettings($workspaceId: ID!) {
  admin {
    pdfExportSettings(workspaceId: $workspaceId) {
      workspaceId
      defaultTemplateId
      defaultPaperSize
      defaultLocale
      defaultColorProfile
      defaultImageQuality
      ligaturesEnabled
    }
  }
}`,
};

export const adminUploadDocumentBrandLogoMutation = {
  id: "adminUploadDocumentBrandLogoMutation" as const,
  op: "adminUploadDocumentBrandLogo",
  kind: "mutation" as const,
  query: `mutation adminUploadDocumentBrandLogo($workspaceId: ID!, $kind: BrandLogoKind!, $file: Upload!) {
  admin {
    uploadDocumentBrandLogo(workspaceId: $workspaceId, kind: $kind, file: $file) {
      workspaceId
      logoLargeBlob
      logoSmallBlob
      footerText
      colorPolicy
      colorPaletteKey
      brandColorPrimary
      brandColorAccent
      brandColorRule
      brandColorText
      brandColorBackground
      updatedAt
      updatedBy
    }
  }
}`,
  file: true,
};

export const adminDeleteDocumentBrandLogoMutation = {
  id: "adminDeleteDocumentBrandLogoMutation" as const,
  op: "adminDeleteDocumentBrandLogo",
  kind: "mutation" as const,
  query: `mutation adminDeleteDocumentBrandLogo($workspaceId: ID!, $kind: BrandLogoKind!) {
  admin {
    deleteDocumentBrandLogo(workspaceId: $workspaceId, kind: $kind) {
      workspaceId
      logoLargeBlob
      logoSmallBlob
      footerText
      colorPolicy
      colorPaletteKey
      brandColorPrimary
      brandColorAccent
      brandColorRule
      brandColorText
      brandColorBackground
      updatedAt
      updatedBy
    }
  }
}`,
};

export const adminResetWorkspaceDocumentBrandingMutation = {
  id: "adminResetWorkspaceDocumentBrandingMutation" as const,
  op: "adminResetWorkspaceDocumentBranding",
  kind: "mutation" as const,
  query: `mutation adminResetWorkspaceDocumentBranding($workspaceId: ID!) {
  admin {
    resetWorkspaceDocumentBranding(workspaceId: $workspaceId) {
      workspaceId
      logoLargeBlob
      logoSmallBlob
      footerText
      colorPolicy
      colorPaletteKey
      brandColorPrimary
      brandColorAccent
      brandColorRule
      brandColorText
      brandColorBackground
      updatedAt
      updatedBy
    }
  }
}`,
};

export const adminUpdateDocumentBrandingTextMutation = {
  id: "adminUpdateDocumentBrandingTextMutation" as const,
  op: "adminUpdateDocumentBrandingText",
  kind: "mutation" as const,
  query: `mutation adminUpdateDocumentBrandingText($workspaceId: ID!, $footerText: String) {
  admin {
    updateDocumentBrandingText(workspaceId: $workspaceId, footerText: $footerText) {
      workspaceId
      footerText
      updatedAt
      updatedBy
    }
  }
}`,
};

export const adminUpdateDocumentBrandingColorsMutation = {
  id: "adminUpdateDocumentBrandingColorsMutation" as const,
  op: "adminUpdateDocumentBrandingColors",
  kind: "mutation" as const,
  query: `mutation adminUpdateDocumentBrandingColors($workspaceId: ID!, $primary: String, $accent: String) {
  admin {
    updateDocumentBrandingColors(
      workspaceId: $workspaceId
      primary: $primary
      accent: $accent
    ) {
      workspaceId
      brandColorPrimary
      brandColorAccent
      brandColorRule
      brandColorText
      brandColorBackground
      colorPolicy
      colorPaletteKey
      updatedAt
      updatedBy
    }
  }
}`,
};

export const adminSetDocumentBrandingColorPolicyMutation = {
  id: "adminSetDocumentBrandingColorPolicyMutation" as const,
  op: "adminSetDocumentBrandingColorPolicy",
  kind: "mutation" as const,
  query: `mutation adminSetDocumentBrandingColorPolicy($workspaceId: ID!, $policy: DocumentBrandColorPolicy!, $paletteKey: String!) {
  admin {
    setDocumentBrandingColorPolicy(
      workspaceId: $workspaceId
      policy: $policy
      paletteKey: $paletteKey
    ) {
      workspaceId
      colorPolicy
      colorPaletteKey
      brandColorPrimary
      brandColorAccent
      brandColorRule
      brandColorText
      brandColorBackground
      updatedAt
      updatedBy
    }
  }
}`,
};

export const adminUpdatePdfExportSettingsMutation = {
  id: "adminUpdatePdfExportSettingsMutation" as const,
  op: "adminUpdatePdfExportSettings",
  kind: "mutation" as const,
  query: `mutation adminUpdatePdfExportSettings($workspaceId: ID!, $paperSize: String, $locale: String, $colorProfile: String, $imageQuality: String, $ligaturesEnabled: Boolean) {
  admin {
    updatePdfExportSettings(
      workspaceId: $workspaceId
      paperSize: $paperSize
      locale: $locale
      colorProfile: $colorProfile
      imageQuality: $imageQuality
      ligaturesEnabled: $ligaturesEnabled
    ) {
      workspaceId
      defaultTemplateId
      defaultPaperSize
      defaultLocale
      defaultColorProfile
      defaultImageQuality
      ligaturesEnabled
    }
  }
}`,
};

export const adminPdfExportJobsQuery = {
  id: "adminPdfExportJobsQuery" as const,
  op: "adminPdfExportJobs",
  kind: "query" as const,
  query: `query adminPdfExportJobs($filter: AdminPdfExportJobsFilterInput) {
  admin {
    pdfExportJobs(filter: $filter) {
      id
      workspaceId
      docId
      requestedBy
      requestedByEmail
      requestedByName
      templateId
      status
      syncOrAsync
      pageCount
      errorClass
      errorDetail
      createdAt
      startedAt
      finishedAt
      expiresAt
      durationMs
      unmappedFontFamilies
      audit {
        id
        templateVersion
        renderAppearanceHash
        locale
        classification
        l3Inputs
        createdAt
      }
    }
  }
}`,
};

export const adminCancelPdfExportJobMutation = {
  id: "adminCancelPdfExportJobMutation" as const,
  op: "adminCancelPdfExportJob",
  kind: "mutation" as const,
  query: `mutation adminCancelPdfExportJob($jobId: String!) {
  admin {
    cancelPdfExportJob(jobId: $jobId)
  }
}`,
};

export const adminPdfFontsQuery = {
  id: "adminPdfFontsQuery" as const,
  op: "adminPdfFonts",
  kind: "query" as const,
  query: `query adminPdfFonts($status: PdfFontLicenseStatusEnum) {
  admin {
    pdfFonts(status: $status) {
      id
      familyName
      style
      weight
      sha256
      license
      licenseStatus
      uploadedBy
      uploadedAt
      approvedBy
      approvedAt
    }
  }
}`,
};

export const adminPdfFontQuery = {
  id: "adminPdfFontQuery" as const,
  op: "adminPdfFont",
  kind: "query" as const,
  query: `query adminPdfFont($id: ID!) {
  admin {
    pdfFont(id: $id) {
      id
      familyName
      style
      weight
      sha256
      license
      licenseStatus
      uploadedBy
      uploadedAt
      approvedBy
      approvedAt
    }
  }
}`,
};

export const adminUploadPdfFontMutation = {
  id: "adminUploadPdfFontMutation" as const,
  op: "adminUploadPdfFont",
  kind: "mutation" as const,
  query: `mutation adminUploadPdfFont($file: Upload!, $license: String) {
  admin {
    uploadPdfFont(file: $file, license: $license) {
      id
      familyName
      style
      weight
      sha256
      license
      licenseStatus
      uploadedBy
      uploadedAt
      approvedBy
      approvedAt
    }
  }
}`,
  file: true,
};

export const adminApprovePdfFontMutation = {
  id: "adminApprovePdfFontMutation" as const,
  op: "adminApprovePdfFont",
  kind: "mutation" as const,
  query: `mutation adminApprovePdfFont($id: ID!) {
  admin {
    approvePdfFont(id: $id) {
      id
      familyName
      licenseStatus
      approvedBy
      approvedAt
    }
  }
}`,
};

export const adminRejectPdfFontMutation = {
  id: "adminRejectPdfFontMutation" as const,
  op: "adminRejectPdfFont",
  kind: "mutation" as const,
  query: `mutation adminRejectPdfFont($id: ID!, $reason: String!) {
  admin {
    rejectPdfFont(id: $id, reason: $reason) {
      id
      familyName
      licenseStatus
      approvedBy
      approvedAt
    }
  }
}`,
};

export const adminDeletePdfFontMutation = {
  id: "adminDeletePdfFontMutation" as const,
  op: "adminDeletePdfFont",
  kind: "mutation" as const,
  query: `mutation adminDeletePdfFont($id: ID!) {
  admin {
    deletePdfFont(id: $id)
  }
}`,
};

export const adminPdfIccProfilesQuery = {
  id: "adminPdfIccProfilesQuery" as const,
  op: "adminPdfIccProfiles",
  kind: "query" as const,
  query: `query adminPdfIccProfiles {
  admin {
    pdfIccProfiles {
      id
      name
      profileType
      sha256
      uploadedBy
      uploadedAt
    }
  }
}`,
};

export const adminPdfIccProfileQuery = {
  id: "adminPdfIccProfileQuery" as const,
  op: "adminPdfIccProfile",
  kind: "query" as const,
  query: `query adminPdfIccProfile($id: ID!) {
  admin {
    pdfIccProfile(id: $id) {
      id
      name
      profileType
      sha256
      uploadedBy
      uploadedAt
    }
  }
}`,
};

export const adminUploadIccProfileMutation = {
  id: "adminUploadIccProfileMutation" as const,
  op: "adminUploadIccProfile",
  kind: "mutation" as const,
  query: `mutation adminUploadIccProfile($name: String!, $profileType: PdfIccProfileTypeEnum!, $file: Upload!) {
  admin {
    uploadIccProfile(name: $name, profileType: $profileType, file: $file) {
      id
      name
      profileType
      sha256
      uploadedBy
      uploadedAt
    }
  }
}`,
  file: true,
};

export const adminDeleteIccProfileMutation = {
  id: "adminDeleteIccProfileMutation" as const,
  op: "adminDeleteIccProfile",
  kind: "mutation" as const,
  query: `mutation adminDeleteIccProfile($id: ID!) {
  admin {
    deleteIccProfile(id: $id)
  }
}`,
};

export const adminPdfWorkspaceAssignmentsQuery = {
  id: "adminPdfWorkspaceAssignmentsQuery" as const,
  op: "adminPdfWorkspaceAssignments",
  kind: "query" as const,
  query: `query adminPdfWorkspaceAssignments($workspaceId: ID!) {
  admin {
    pdfWorkspaceAssignments(workspaceId: $workspaceId) {
      workspaceId
      templateId
      isDefault
      assignedBy
      assignedAt
    }
  }
}`,
};

export const adminPdfTemplateAssignedWorkspacesQuery = {
  id: "adminPdfTemplateAssignedWorkspacesQuery" as const,
  op: "adminPdfTemplateAssignedWorkspaces",
  kind: "query" as const,
  query: `query adminPdfTemplateAssignedWorkspaces($templateId: ID!) {
  admin {
    pdfTemplateAssignedWorkspaces(templateId: $templateId) {
      workspaceId
      templateId
      isDefault
      assignedBy
      assignedAt
    }
  }
}`,
};

export const adminAssignPdfTemplateToWorkspaceMutation = {
  id: "adminAssignPdfTemplateToWorkspaceMutation" as const,
  op: "adminAssignPdfTemplateToWorkspace",
  kind: "mutation" as const,
  query: `mutation adminAssignPdfTemplateToWorkspace($workspaceId: ID!, $templateId: ID!) {
  admin {
    assignPdfTemplateToWorkspace(workspaceId: $workspaceId, templateId: $templateId) {
      workspaceId
      templateId
      isDefault
      assignedBy
      assignedAt
    }
  }
}`,
};

export const adminUnassignPdfTemplateFromWorkspaceMutation = {
  id: "adminUnassignPdfTemplateFromWorkspaceMutation" as const,
  op: "adminUnassignPdfTemplateFromWorkspace",
  kind: "mutation" as const,
  query: `mutation adminUnassignPdfTemplateFromWorkspace($workspaceId: ID!, $templateId: ID!) {
  admin {
    unassignPdfTemplateFromWorkspace(
      workspaceId: $workspaceId
      templateId: $templateId
    )
  }
}`,
};

export const adminSetWorkspaceDefaultPdfTemplateMutation = {
  id: "adminSetWorkspaceDefaultPdfTemplateMutation" as const,
  op: "adminSetWorkspaceDefaultPdfTemplate",
  kind: "mutation" as const,
  query: `mutation adminSetWorkspaceDefaultPdfTemplate($workspaceId: ID!, $templateId: ID!) {
  admin {
    setWorkspaceDefaultPdfTemplate(
      workspaceId: $workspaceId
      templateId: $templateId
    ) {
      workspaceId
      defaultTemplateId
    }
  }
}`,
};

export const adminPdfTemplatesQuery = {
  id: "adminPdfTemplatesQuery" as const,
  op: "adminPdfTemplates",
  kind: "query" as const,
  query: `query adminPdfTemplates($includeDeleted: Boolean) {
  admin {
    pdfTemplates(includeDeleted: $includeDeleted) {
      id
      slug
      name
      version
      schemaVersion
      manifest
      createdBy
      createdAt
      deletedAt
    }
  }
}`,
};

export const adminPdfTemplateQuery = {
  id: "adminPdfTemplateQuery" as const,
  op: "adminPdfTemplate",
  kind: "query" as const,
  query: `query adminPdfTemplate($id: ID!) {
  admin {
    pdfTemplate(id: $id) {
      id
      slug
      name
      version
      schemaVersion
      manifest
      createdBy
      createdAt
      deletedAt
    }
  }
}`,
};

export const adminPdfTemplateFilesQuery = {
  id: "adminPdfTemplateFilesQuery" as const,
  op: "adminPdfTemplateFiles",
  kind: "query" as const,
  query: `query adminPdfTemplateFiles($templateId: ID!) {
  admin {
    pdfTemplateFiles(templateId: $templateId) {
      templateId
      filePath
      blobKey
      contentHash
    }
  }
}`,
};

export const adminUploadPdfTemplateMutation = {
  id: "adminUploadPdfTemplateMutation" as const,
  op: "adminUploadPdfTemplate",
  kind: "mutation" as const,
  query: `mutation adminUploadPdfTemplate($manifest: JSON!, $filePaths: [String!]!, $files: [Upload!]!, $rightsConfirmed: Boolean!) {
  admin {
    uploadPdfTemplate(
      manifest: $manifest
      filePaths: $filePaths
      files: $files
      rightsConfirmed: $rightsConfirmed
    ) {
      id
      slug
      name
      version
      schemaVersion
      manifest
      createdBy
      createdAt
      deletedAt
    }
  }
}`,
  file: true,
};

export const adminReplacePdfTemplateBundleMutation = {
  id: "adminReplacePdfTemplateBundleMutation" as const,
  op: "adminReplacePdfTemplateBundle",
  kind: "mutation" as const,
  query: `mutation adminReplacePdfTemplateBundle($id: ID!, $manifest: JSON!, $filePaths: [String!]!, $files: [Upload!]!, $rightsConfirmed: Boolean!) {
  admin {
    replacePdfTemplateBundle(
      id: $id
      manifest: $manifest
      filePaths: $filePaths
      files: $files
      rightsConfirmed: $rightsConfirmed
    ) {
      id
      slug
      name
      version
      schemaVersion
      manifest
      createdBy
      createdAt
      deletedAt
    }
  }
}`,
  file: true,
};

export const adminDeletePdfTemplateMutation = {
  id: "adminDeletePdfTemplateMutation" as const,
  op: "adminDeletePdfTemplate",
  kind: "mutation" as const,
  query: `mutation adminDeletePdfTemplate($id: ID!) {
  admin {
    deletePdfTemplate(id: $id)
  }
}`,
};

export const adminUpdatePdfTemplateMetadataMutation = {
  id: "adminUpdatePdfTemplateMetadataMutation" as const,
  op: "adminUpdatePdfTemplateMetadata",
  kind: "mutation" as const,
  query: `mutation adminUpdatePdfTemplateMetadata($id: ID!, $name: String, $description: String) {
  admin {
    updatePdfTemplateMetadata(id: $id, name: $name, description: $description) {
      id
      slug
      name
      version
      schemaVersion
      manifest
      createdBy
      createdAt
      deletedAt
    }
  }
}`,
};

export const adminPdfTemplatePreviewPdfQuery = {
  id: "adminPdfTemplatePreviewPdfQuery" as const,
  op: "adminPdfTemplatePreviewPdf",
  kind: "query" as const,
  query: `query adminPdfTemplatePreviewPdf($templateId: String!, $locale: String) {
  admin {
    pdfTemplatePreviewPdf(templateId: $templateId, locale: $locale)
  }
}`,
};

export const adminCleanupTrashedDocEmbeddingsMutation = {
  id: "adminCleanupTrashedDocEmbeddingsMutation" as const,
  op: "adminCleanupTrashedDocEmbeddings",
  kind: "mutation" as const,
  query: `mutation adminCleanupTrashedDocEmbeddings {
  admin {
    triggerCleanupTrashedDocEmbeddings
  }
}`,
};

export const adminTriggerWorkspaceReindexMutation = {
  id: "adminTriggerWorkspaceReindexMutation" as const,
  op: "adminTriggerWorkspaceReindex",
  kind: "mutation" as const,
  query: `mutation adminTriggerWorkspaceReindex($workspaceId: ID!) {
  admin {
    triggerWorkspaceReindex(workspaceId: $workspaceId)
  }
}`,
};

export const adminTriggerFullReindexMutation = {
  id: "adminTriggerFullReindexMutation" as const,
  op: "adminTriggerFullReindex",
  kind: "mutation" as const,
  query: `mutation adminTriggerFullReindex {
  admin {
    triggerFullReindex
  }
}`,
};

export const sendTestEmailMutation = {
  id: "sendTestEmailMutation" as const,
  op: "sendTestEmail",
  kind: "mutation" as const,
  query: `mutation sendTestEmail($host: String!, $port: Int!, $name: String, $sender: String!, $username: String, $password: String, $transport: String!, $verifyCertificate: Boolean!) {
  admin {
    sendTestEmail(
      config: {host: $host, port: $port, name: $name, sender: $sender, username: $username, password: $password, transport: $transport, verifyCertificate: $verifyCertificate}
    )
  }
}`,
};

export const serverDirectoriesQuery = {
  id: "serverDirectoriesQuery" as const,
  op: "serverDirectories",
  kind: "query" as const,
  query: `query serverDirectories {
  admin {
    serverDirectories {
      name
      path
      exists
      totalBytes
      freeBytes
      capacityBytes
      entryCount
    }
  }
}`,
};

export const serverSetupStatusQuery = {
  id: "serverSetupStatusQuery" as const,
  op: "serverSetupStatus",
  kind: "query" as const,
  query: `query serverSetupStatus {
  serverSetupStatus {
    setupCompleted
    operationalReady
    bootstrapAvailable
    authMethods {
      method
      supported
      usable
      reasonCode
    }
    findings {
      code
      severity
    }
  }
}`,
};

export const templateAssignmentsQuery = {
  id: "templateAssignmentsQuery" as const,
  op: "templateAssignments",
  kind: "query" as const,
  query: `query templateAssignments($workspaceId: String!, $skip: Int, $take: Int) {
  admin {
    templateAssignments(workspaceId: $workspaceId, skip: $skip, take: $take) {
      id
      workspaceId
      templateId
      selectionMode
      selectedRevisionId
      provisioningMode
      isEnabled
      createdAt
      updatedAt
    }
  }
}`,
};

export const templateCatalogQuery = {
  id: "templateCatalogQuery" as const,
  op: "templateCatalog",
  kind: "query" as const,
  query: `query templateCatalog($skip: Int, $take: Int, $status: TemplateStatusType) {
  admin {
    templateCatalog(skip: $skip, take: $take, status: $status) {
      id
      slug
      title
      description
      category
      tags
      status
      source
      minClientVersion
      createdAt
      updatedAt
      archivedAt
    }
    templateCatalogCount(status: $status)
  }
}`,
};

export const templateDefaultPoliciesQuery = {
  id: "templateDefaultPoliciesQuery" as const,
  op: "templateDefaultPolicies",
  kind: "query" as const,
  query: `query templateDefaultPolicies {
  admin {
    templateDefaultPolicies {
      templateId
      applyToNewWorkspaces
      selectionMode
      provisioningMode
      createdAt
      updatedAt
    }
  }
}`,
};

export const adminExportRevisionMutation = {
  id: "adminExportRevisionMutation" as const,
  op: "adminExportRevision",
  kind: "mutation" as const,
  query: `mutation adminExportRevision($revisionId: ID!) {
  admin {
    exportRevision(revisionId: $revisionId) {
      id
      templateId
      version
      state
      checksum
      releaseNotes
      createdAt
      publishedAt
      createdBy
    }
  }
}`,
};

export const adminTriggerDriftScanMutation = {
  id: "adminTriggerDriftScanMutation" as const,
  op: "adminTriggerDriftScan",
  kind: "mutation" as const,
  query: `mutation adminTriggerDriftScan($workspaceId: String!) {
  admin {
    triggerDriftScan(workspaceId: $workspaceId)
  }
}`,
};

export const adminRetireTemplateAssignmentMutation = {
  id: "adminRetireTemplateAssignmentMutation" as const,
  op: "adminRetireTemplateAssignment",
  kind: "mutation" as const,
  query: `mutation adminRetireTemplateAssignment($policyId: ID!) {
  admin {
    retireTemplateAssignment(policyId: $policyId)
  }
}`,
};

export const workspaceTemplateInstancesQuery = {
  id: "workspaceTemplateInstancesQuery" as const,
  op: "workspaceTemplateInstances",
  kind: "query" as const,
  query: `query workspaceTemplateInstances($workspaceId: String!) {
  admin {
    workspaceTemplateInstances(workspaceId: $workspaceId) {
      id
      workspaceId
      templateId
      revisionId
      workspaceDocId
      state
      lastAppliedHash
      currentHash
      lastSyncedAt
      detachedAt
      retiredAt
      lastErrorCode
      lastErrorMessage
    }
  }
}`,
};

export const templateJobsQuery = {
  id: "templateJobsQuery" as const,
  op: "templateJobs",
  kind: "query" as const,
  query: `query templateJobs($skip: Int, $take: Int) {
  admin {
    templateJobs(skip: $skip, take: $take) {
      id
      jobType
      state
      templateId
      workspaceId
      startedAt
      finishedAt
      summaryJson
    }
  }
}`,
};

export const importTemplateMutation = {
  id: "importTemplateMutation" as const,
  op: "importTemplate",
  kind: "mutation" as const,
  query: `mutation importTemplate($file: Upload!) {
  admin {
    importTemplate(file: $file) {
      package
      jobId
      error
      documents {
        entry {
          id
          slug
          title
        }
        revision {
          id
          version
          state
        }
      }
      entry {
        id
        slug
        title
        description
        category
        tags
        status
        source
        minClientVersion
        createdAt
        updatedAt
        archivedAt
      }
      revision {
        id
        templateId
        version
        state
        checksum
        releaseNotes
        createdAt
        publishedAt
        createdBy
      }
      warnings {
        code
        message
        field
        severity
      }
    }
  }
}`,
  file: true,
};

export const publishRevisionMutation = {
  id: "publishRevisionMutation" as const,
  op: "publishRevision",
  kind: "mutation" as const,
  query: `mutation publishRevision($revisionId: ID!) {
  admin {
    publishRevision(revisionId: $revisionId) {
      id
      templateId
      version
      state
      checksum
      releaseNotes
      createdAt
      publishedAt
      createdBy
    }
  }
}`,
};

export const archiveTemplateMutation = {
  id: "archiveTemplateMutation" as const,
  op: "archiveTemplate",
  kind: "mutation" as const,
  query: `mutation archiveTemplate($templateId: ID!) {
  admin {
    archiveTemplate(templateId: $templateId) {
      id
      slug
      title
      status
      archivedAt
    }
  }
}`,
};

export const enableTemplateMutation = {
  id: "enableTemplateMutation" as const,
  op: "enableTemplate",
  kind: "mutation" as const,
  query: `mutation enableTemplate($templateId: ID!) {
  admin {
    enableTemplate(templateId: $templateId) {
      id
      slug
      title
      status
    }
  }
}`,
};

export const disableTemplateMutation = {
  id: "disableTemplateMutation" as const,
  op: "disableTemplate",
  kind: "mutation" as const,
  query: `mutation disableTemplate($templateId: ID!) {
  admin {
    disableTemplate(templateId: $templateId) {
      id
      slug
      title
      status
    }
  }
}`,
};

export const assignTemplateToWorkspaceMutation = {
  id: "assignTemplateToWorkspaceMutation" as const,
  op: "assignTemplateToWorkspace",
  kind: "mutation" as const,
  query: `mutation assignTemplateToWorkspace($workspaceId: String!, $templateId: ID!, $provisioningMode: ProvisioningModeType!, $selectionMode: SelectionModeType!, $selectedRevisionId: ID) {
  admin {
    assignTemplateToWorkspace(
      workspaceId: $workspaceId
      templateId: $templateId
      provisioningMode: $provisioningMode
      selectionMode: $selectionMode
      selectedRevisionId: $selectedRevisionId
    ) {
      id
      workspaceId
      templateId
      selectionMode
      selectedRevisionId
      provisioningMode
      isEnabled
      createdAt
      updatedAt
    }
  }
}`,
};

export const applyTemplateManualUpdateMutation = {
  id: "applyTemplateManualUpdateMutation" as const,
  op: "applyTemplateManualUpdate",
  kind: "mutation" as const,
  query: `mutation applyTemplateManualUpdate($workspaceId: String!, $templateId: ID!, $revisionId: ID!) {
  admin {
    applyTemplateManualUpdate(
      workspaceId: $workspaceId
      templateId: $templateId
      revisionId: $revisionId
    ) {
      id
      workspaceId
      templateId
      revisionId
      workspaceDocId
      state
      lastSyncedAt
      lastErrorCode
      lastErrorMessage
    }
  }
}`,
};

export const removeTemplateAssignmentMutation = {
  id: "removeTemplateAssignmentMutation" as const,
  op: "removeTemplateAssignment",
  kind: "mutation" as const,
  query: `mutation removeTemplateAssignment($assignmentId: ID!) {
  admin {
    removeTemplateAssignment(policyId: $assignmentId)
  }
}`,
};

export const triggerReconcileMutation = {
  id: "triggerReconcileMutation" as const,
  op: "triggerReconcile",
  kind: "mutation" as const,
  query: `mutation triggerReconcile($workspaceId: String!) {
  admin {
    triggerReconcile(workspaceId: $workspaceId)
  }
}`,
};

export const updateBuiltinTemplateMetadataMutation = {
  id: "updateBuiltinTemplateMetadataMutation" as const,
  op: "updateBuiltinTemplateMetadata",
  kind: "mutation" as const,
  query: `mutation updateBuiltinTemplateMetadata($templateId: ID!, $category: String, $tags: [String!]) {
  admin {
    updateBuiltinTemplateMetadata(
      templateId: $templateId
      category: $category
      tags: $tags
    ) {
      id
      slug
      title
      description
      category
      tags
      status
      source
      minClientVersion
      createdAt
      updatedAt
      archivedAt
    }
  }
}`,
};

export const setTemplateDefaultPolicyMutation = {
  id: "setTemplateDefaultPolicyMutation" as const,
  op: "setTemplateDefaultPolicy",
  kind: "mutation" as const,
  query: `mutation setTemplateDefaultPolicy($templateId: String!, $applyToNewWorkspaces: Boolean!, $selectionMode: SelectionModeType!, $provisioningMode: ProvisioningModeType!) {
  admin {
    setTemplateDefaultPolicy(
      input: {templateId: $templateId, applyToNewWorkspaces: $applyToNewWorkspaces, selectionMode: $selectionMode, provisioningMode: $provisioningMode}
    )
  }
}`,
};

export const setWorkspaceTemplateOverrideMutation = {
  id: "setWorkspaceTemplateOverrideMutation" as const,
  op: "setWorkspaceTemplateOverride",
  kind: "mutation" as const,
  query: `mutation setWorkspaceTemplateOverride($workspaceId: String!, $templateId: String!, $isEnabled: Boolean!, $provisioningMode: ProvisioningModeType) {
  admin {
    setWorkspaceTemplateOverride(
      input: {workspaceId: $workspaceId, templateId: $templateId, isEnabled: $isEnabled, provisioningMode: $provisioningMode}
    )
  }
}`,
};

export const templateRevisionsQuery = {
  id: "templateRevisionsQuery" as const,
  op: "templateRevisions",
  kind: "query" as const,
  query: `query templateRevisions($templateId: ID!, $skip: Int, $take: Int) {
  admin {
    templateRevisions(templateId: $templateId, skip: $skip, take: $take) {
      id
      templateId
      version
      state
      checksum
      manifest
      releaseNotes
      createdAt
      publishedAt
      createdBy
    }
  }
}`,
};

export const workspaceTemplateSourcesQuery = {
  id: "workspaceTemplateSourcesQuery" as const,
  op: "workspaceTemplateSources",
  kind: "query" as const,
  query: `query workspaceTemplateSources($workspaceId: ID!, $skip: Int = 0, $take: Int = 50) {
  admin {
    workspaceTemplateSources(workspaceId: $workspaceId, skip: $skip, take: $take) {
      sources {
        docId
        title
        documentRevision
        metadataRevision
        origin
        identifier
        version
        description
        category
        tags
        locale
        titlePolicy
      }
      nextOffset
    }
  }
}`,
};

export const adminThemeCatalogQuery = {
  id: "adminThemeCatalogQuery" as const,
  op: "adminThemeCatalog",
  kind: "query" as const,
  query: `query adminThemeCatalog {
  admin {
    themeCatalog {
      catalogHash
      themes {
        slug
        name
        category
        previewGroup
        previewOrder
        taglineKey
        descriptionKey
        origin
        locked
        isDefault
        colorSchemaSlug
        typographySlug
        colors
        typographyStyles {
          styleKey
          fontFamilySlug
          fontFamily
          cssFamily
          fontWeight
          fontStyle
          sizePx
          lineHeight
          letterSpacingEm
          textTransform
          decoration
          hoverDecoration
          fontFeatures
          fontVariations
          pdfRole
        }
      }
      fontFamilies {
        slug
        displayName
        cssFamily
        genericClass
        source
        licenseSpdx
        licenseStatus
        isSelectable
        assets {
          usage
          format
          style
          weightMin
          weightMax
          weightDefault
          assetKey
          sha256
          mime
          unicodeRanges
          subsetTags
        }
      }
    }
  }
}`,
};

export const adminEffectiveThemeProfileQuery = {
  id: "adminEffectiveThemeProfileQuery" as const,
  op: "adminEffectiveThemeProfile",
  kind: "query" as const,
  query: `query adminEffectiveThemeProfile($workspaceId: ID) {
  admin {
    effectiveThemeProfile(workspaceId: $workspaceId) {
      scope
      workspaceId
      themeMode
      theme {
        slug
        name
        category
        previewGroup
        previewOrder
        taglineKey
        descriptionKey
        origin
        locked
        isDefault
        colorSchemaSlug
        typographySlug
        colors
        typographyStyles {
          styleKey
          fontFamilySlug
          fontFamily
          cssFamily
          fontWeight
          fontStyle
          sizePx
          lineHeight
          letterSpacingEm
          textTransform
          decoration
          hoverDecoration
          fontFeatures
          fontVariations
          pdfRole
        }
      }
    }
  }
}`,
};

export const adminSetThemeProfileMutation = {
  id: "adminSetThemeProfileMutation" as const,
  op: "adminSetThemeProfile",
  kind: "mutation" as const,
  query: `mutation adminSetThemeProfile($input: SetThemeProfileInput!) {
  admin {
    setThemeProfile(input: $input) {
      scope
      workspaceId
      themeMode
      theme {
        slug
        name
        category
        previewGroup
        previewOrder
        taglineKey
        descriptionKey
        colors
        typographyStyles {
          styleKey
          fontFamily
          fontWeight
          pdfRole
        }
      }
    }
  }
}`,
};

export const adminSetTypographyStylesMutation = {
  id: "adminSetTypographyStylesMutation" as const,
  op: "adminSetTypographyStyles",
  kind: "mutation" as const,
  query: `mutation adminSetTypographyStyles($typographyInput: SetTypographyStylesInput!) {
  admin {
    setTypographyStyles(input: $typographyInput) {
      scope
      workspaceId
      themeMode
      theme {
        slug
        name
        category
        previewGroup
        previewOrder
        taglineKey
        descriptionKey
        origin
        locked
        isDefault
        colorSchemaSlug
        typographySlug
        colors
        typographyStyles {
          styleKey
          fontFamilySlug
          fontFamily
          cssFamily
          fontWeight
          fontStyle
          sizePx
          lineHeight
          letterSpacingEm
          textTransform
          decoration
          hoverDecoration
          fontFeatures
          fontVariations
          pdfRole
        }
      }
    }
  }
}`,
};

export const adminSetColorSchemaValuesMutation = {
  id: "adminSetColorSchemaValuesMutation" as const,
  op: "adminSetColorSchemaValues",
  kind: "mutation" as const,
  query: `mutation adminSetColorSchemaValues($colorInput: SetColorSchemaValuesInput!) {
  admin {
    setColorSchemaValues(input: $colorInput) {
      scope
      workspaceId
      themeMode
      theme {
        slug
        name
        category
        previewGroup
        previewOrder
        taglineKey
        descriptionKey
        origin
        locked
        isDefault
        colorSchemaSlug
        typographySlug
        colors
        typographyStyles {
          styleKey
          fontFamilySlug
          fontFamily
          cssFamily
          fontWeight
          fontStyle
          sizePx
          lineHeight
          letterSpacingEm
          textTransform
          decoration
          hoverDecoration
          fontFeatures
          fontVariations
          pdfRole
        }
      }
    }
  }
}`,
};

export const adminResetWorkspaceThemeProfileMutation = {
  id: "adminResetWorkspaceThemeProfileMutation" as const,
  op: "adminResetWorkspaceThemeProfile",
  kind: "mutation" as const,
  query: `mutation adminResetWorkspaceThemeProfile($resetInput: ResetWorkspaceThemeProfileInput!) {
  admin {
    resetWorkspaceThemeProfile(input: $resetInput) {
      scope
      workspaceId
      themeMode
      theme {
        slug
        name
        category
        previewGroup
        previewOrder
        taglineKey
        descriptionKey
        origin
        locked
        isDefault
        colorSchemaSlug
        typographySlug
        colors
        typographyStyles {
          styleKey
          fontFamilySlug
          fontFamily
          cssFamily
          fontWeight
          fontStyle
          sizePx
          lineHeight
          letterSpacingEm
          textTransform
          decoration
          hoverDecoration
          fontFeatures
          fontVariations
          pdfRole
        }
      }
    }
  }
}`,
};

export const updateAccountFeaturesMutation = {
  id: "updateAccountFeaturesMutation" as const,
  op: "updateAccountFeatures",
  kind: "mutation" as const,
  query: `mutation updateAccountFeatures($userId: String!, $features: [FeatureType!]!) {
  admin {
    updateUserFeatures(id: $userId, features: $features)
  }
}`,
};

export const updateAccountMutation = {
  id: "updateAccountMutation" as const,
  op: "updateAccount",
  kind: "mutation" as const,
  query: `mutation updateAccount($id: String!, $input: ManageUserInput!) {
  admin {
    updateUser(id: $id, input: $input) {
      id
      name
      email
    }
  }
}`,
};

export const adminSetUserAdminMutation = {
  id: "adminSetUserAdminMutation" as const,
  op: "adminSetUserAdmin",
  kind: "mutation" as const,
  query: `mutation adminSetUserAdmin($userId: ID!, $isAdmin: Boolean!) {
  admin {
    setUserAdmin(userId: $userId, isAdmin: $isAdmin)
  }
}`,
};

export const adminDeleteWorkspaceMutation = {
  id: "adminDeleteWorkspaceMutation" as const,
  op: "adminDeleteWorkspace",
  kind: "mutation" as const,
  query: `mutation adminDeleteWorkspace($id: ID!) {
  admin {
    deleteWorkspace(id: $id)
  }
}`,
};

export const adminAddWorkspaceFeatureMutation = {
  id: "adminAddWorkspaceFeatureMutation" as const,
  op: "adminAddWorkspaceFeature",
  kind: "mutation" as const,
  query: `mutation adminAddWorkspaceFeature($workspaceId: String!, $feature: FeatureType!) {
  admin {
    addWorkspaceFeature(workspaceId: $workspaceId, feature: $feature)
  }
}`,
};

export const adminRemoveWorkspaceFeatureMutation = {
  id: "adminRemoveWorkspaceFeatureMutation" as const,
  op: "adminRemoveWorkspaceFeature",
  kind: "mutation" as const,
  query: `mutation adminRemoveWorkspaceFeature($workspaceId: String!, $feature: FeatureType!) {
  admin {
    removeWorkspaceFeature(workspaceId: $workspaceId, feature: $feature)
  }
}`,
};

export const createMcpApiKeyMutation = {
  id: "createMcpApiKeyMutation" as const,
  op: "createMcpApiKey",
  kind: "mutation" as const,
  query: `mutation createMcpApiKey($name: String!, $scopes: [String!]!, $expiresInDays: Int) {
  apiKeys {
    createApiKey(name: $name, scopes: $scopes, expiresInDays: $expiresInDays) {
      id
      name
      key
      scopes
      expiresAt
    }
  }
}`,
};

export const listMcpApiKeysQuery = {
  id: "listMcpApiKeysQuery" as const,
  op: "listMcpApiKeys",
  kind: "query" as const,
  query: `query listMcpApiKeys {
  apiKeys {
    listApiKeys {
      id
      name
      scopes
      createdAt
      lastUsedAt
      expiresAt
    }
  }
}`,
};

export const revokeMcpApiKeyMutation = {
  id: "revokeMcpApiKeyMutation" as const,
  op: "revokeMcpApiKey",
  kind: "mutation" as const,
  query: `mutation revokeMcpApiKey($id: String!) {
  apiKeys {
    revokeApiKey(id: $id)
  }
}`,
};

export const audioTranscriptionCapabilityQuery = {
  id: "audioTranscriptionCapabilityQuery" as const,
  op: "audioTranscriptionCapability",
  kind: "query" as const,
  query: `query audioTranscriptionCapability($workspaceId: String!) {
  serverConfig {
    features
    transcription {
      enabled
      configured
      status
      maxInputBytes
      maxDurationSeconds
    }
  }
  workspace(id: $workspaceId) {
    permissions {
      Workspace_Transcription
    }
  }
}`,
};

export const deleteBlobMutation = {
  id: "deleteBlobMutation" as const,
  op: "deleteBlob",
  kind: "mutation" as const,
  query: `mutation deleteBlob($workspaceId: String!, $key: String!, $permanently: Boolean) {
  deleteBlob(workspaceId: $workspaceId, key: $key, permanently: $permanently)
}`,
};

export const listBlobsQuery = {
  id: "listBlobsQuery" as const,
  op: "listBlobs",
  kind: "query" as const,
  query: `query listBlobs($workspaceId: String!) {
  workspace(id: $workspaceId) {
    blobs {
      key
      size
      mime
      createdAt
    }
  }
}`,
};

export const releaseDeletedBlobsMutation = {
  id: "releaseDeletedBlobsMutation" as const,
  op: "releaseDeletedBlobs",
  kind: "mutation" as const,
  query: `mutation releaseDeletedBlobs($workspaceId: String!) {
  releaseDeletedBlobs(workspaceId: $workspaceId)
}`,
};

export const setBlobMutation = {
  id: "setBlobMutation" as const,
  op: "setBlob",
  kind: "mutation" as const,
  query: `mutation setBlob($workspaceId: String!, $blob: Upload!) {
  setBlob(workspaceId: $workspaceId, blob: $blob)
}`,
  file: true,
};

export const abortBlobUploadMutation = {
  id: "abortBlobUploadMutation" as const,
  op: "abortBlobUpload",
  kind: "mutation" as const,
  query: `mutation abortBlobUpload($workspaceId: String!, $key: String!, $uploadId: String!) {
  abortBlobUpload(workspaceId: $workspaceId, key: $key, uploadId: $uploadId)
}`,
};

export const completeBlobUploadMutation = {
  id: "completeBlobUploadMutation" as const,
  op: "completeBlobUpload",
  kind: "mutation" as const,
  query: `mutation completeBlobUpload($workspaceId: String!, $key: String!, $uploadId: String, $parts: [BlobUploadPartInput!]) {
  completeBlobUpload(
    workspaceId: $workspaceId
    key: $key
    uploadId: $uploadId
    parts: $parts
  )
}`,
};

export const createBlobUploadMutation = {
  id: "createBlobUploadMutation" as const,
  op: "createBlobUpload",
  kind: "mutation" as const,
  query: `mutation createBlobUpload($workspaceId: String!, $key: String!, $size: Int!, $mime: String!) {
  createBlobUpload(workspaceId: $workspaceId, key: $key, size: $size, mime: $mime) {
    method
    blobKey
    alreadyUploaded
    uploadUrl
    headers
    expiresAt
    uploadId
    partSize
    uploadedParts {
      partNumber
      etag
    }
  }
}`,
};

export const getBlobUploadPartUrlQuery = {
  id: "getBlobUploadPartUrlQuery" as const,
  op: "getBlobUploadPartUrl",
  kind: "query" as const,
  query: `query getBlobUploadPartUrl($workspaceId: String!, $key: String!, $uploadId: String!, $partNumber: Int!) {
  workspace(id: $workspaceId) {
    blobUploadPartUrl(key: $key, uploadId: $uploadId, partNumber: $partNumber) {
      uploadUrl
      headers
      expiresAt
    }
  }
}`,
};

export const calendarAccountsQuery = {
  id: "calendarAccountsQuery" as const,
  op: "calendarAccounts",
  kind: "query" as const,
  query: `query calendarAccounts {
  currentUser {
    calendarAccounts {
      id
      provider
      providerAccountId
      displayName
      email
      status
      lastError
      refreshIntervalMinutes
      calendarsCount
      createdAt
      updatedAt
      calendars {
        id
        accountId
        provider
        externalCalendarId
        displayName
        timezone
        color
        enabled
        lastSyncAt
      }
    }
  }
}`,
};

export const calendarEventTagsQuery = {
  id: "calendarEventTagsQuery" as const,
  op: "calendarEventTags",
  kind: "query" as const,
  query: `query calendarEventTags($workspaceId: String!) {
  calendarEventTags(workspaceId: $workspaceId) {
    id
    workspaceId
    name
    color
    createdAt
    updatedAt
  }
}`,
};

export const calendarEventQuery = {
  id: "calendarEventQuery" as const,
  op: "calendarEvent",
  kind: "query" as const,
  query: `query calendarEvent($workspaceId: String!, $eventId: String!) {
  calendarEvent(workspaceId: $workspaceId, eventId: $eventId) {
    id
    origin
    workspaceId
    title
    startsAt
    endsAt
    allDay
    allMembers
    tagId
    sourceExternalId
    descriptionDelta
    recurrenceParentId
    recurrenceId
    recurrence {
      ...CalendarRecurrenceFields
    }
    reminders {
      id
      channel
      minutesBefore
      scheduledFor
      deliveredAt
    }
  }
}
fragment CalendarRecurrenceFields on CalendarRecurrence {
  id
  revision
  zone
  lifecycle
  endsBefore
  pausedAt
  readOnly
  unsupportedReason
  sourceRrule
  rule {
    ...RecurrenceRuleFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`,
};

export const calendarEventsQuery = {
  id: "calendarEventsQuery" as const,
  op: "calendarEvents",
  kind: "query" as const,
  query: `query calendarEvents($workspaceId: String!, $from: DateTime!, $to: DateTime!) {
  workspace(id: $workspaceId) {
    calendars {
      id
      events(from: $from, to: $to) {
        id
        subscriptionId
        externalEventId
        recurrenceId
        status
        title
        description
        location
        startAtUtc
        endAtUtc
        originalTimezone
        allDay
        tagId
        reminders {
          id
          channel
          minutesBefore
          scheduledFor
          deliveredAt
        }
      }
    }
  }
}`,
};

export const calendarFreeBusyQuery = {
  id: "calendarFreeBusyQuery" as const,
  op: "calendarFreeBusy",
  kind: "query" as const,
  query: `query calendarFreeBusy($workspaceId: String!, $userIds: [String!]!, $from: DateTime!, $to: DateTime!) {
  calendarFreeBusy(
    workspaceId: $workspaceId
    userIds: $userIds
    from: $from
    to: $to
  ) {
    userId
    busyPeriods {
      start
      end
    }
  }
}`,
};

export const calendarProvidersQuery = {
  id: "calendarProvidersQuery" as const,
  op: "calendarProviders",
  kind: "query" as const,
  query: `query calendarProviders {
  serverConfig {
    calendarCalDAVProviders {
      id
      label
      requiresAppPassword
      docsUrl
    }
    calendarProviders
  }
}`,
};

export const controlWorkspaceEventRecurrenceMutation = {
  id: "controlWorkspaceEventRecurrenceMutation" as const,
  op: "controlWorkspaceEventRecurrence",
  kind: "mutation" as const,
  query: `mutation controlWorkspaceEventRecurrence($workspaceId: String!, $eventId: String!, $expectedRevision: Int!, $action: CalendarTimingAction!) {
  controlWorkspaceEventRecurrence(
    workspaceId: $workspaceId
    eventId: $eventId
    expectedRevision: $expectedRevision
    action: $action
  ) {
    id
    origin
    workspaceId
    title
    startsAt
    endsAt
    allDay
    allMembers
    tagId
    sourceExternalId
    descriptionDelta
    recurrenceParentId
    recurrenceId
    recurrence {
      ...CalendarRecurrenceFields
    }
    reminders {
      id
      channel
      minutesBefore
      scheduledFor
      deliveredAt
    }
  }
}
fragment CalendarRecurrenceFields on CalendarRecurrence {
  id
  revision
  zone
  lifecycle
  endsBefore
  pausedAt
  readOnly
  unsupportedReason
  sourceRrule
  rule {
    ...RecurrenceRuleFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`,
};

export const createEventTagMutation = {
  id: "createEventTagMutation" as const,
  op: "createEventTag",
  kind: "mutation" as const,
  query: `mutation createEventTag($input: CreateEventTagInput!) {
  createEventTag(input: $input) {
    id
    workspaceId
    name
    color
    createdAt
    updatedAt
  }
}`,
};

export const createWorkspaceEventMutation = {
  id: "createWorkspaceEventMutation" as const,
  op: "createWorkspaceEvent",
  kind: "mutation" as const,
  query: `mutation createWorkspaceEvent($input: CreateWorkspaceEventInput!) {
  createWorkspaceEvent(input: $input) {
    id
    origin
    workspaceId
    title
    startsAt
    endsAt
    allDay
    allMembers
    tagId
    sourceExternalId
    descriptionDelta
    recurrenceParentId
    recurrenceId
    recurrence {
      ...CalendarRecurrenceFields
    }
    reminders {
      id
      channel
      minutesBefore
      scheduledFor
      deliveredAt
    }
  }
}
fragment CalendarRecurrenceFields on CalendarRecurrence {
  id
  revision
  zone
  lifecycle
  endsBefore
  pausedAt
  readOnly
  unsupportedReason
  sourceRrule
  rule {
    ...RecurrenceRuleFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`,
};

export const deleteCalendarEventMutation = {
  id: "deleteCalendarEventMutation" as const,
  op: "deleteCalendarEvent",
  kind: "mutation" as const,
  query: `mutation deleteCalendarEvent($eventId: String!) {
  deleteCalendarEvent(eventId: $eventId)
}`,
};

export const deleteEventTagMutation = {
  id: "deleteEventTagMutation" as const,
  op: "deleteEventTag",
  kind: "mutation" as const,
  query: `mutation deleteEventTag($tagId: String!, $workspaceId: String!) {
  deleteEventTag(tagId: $tagId, workspaceId: $workspaceId)
}`,
};

export const deleteWorkspaceEventMutation = {
  id: "deleteWorkspaceEventMutation" as const,
  op: "deleteWorkspaceEvent",
  kind: "mutation" as const,
  query: `mutation deleteWorkspaceEvent($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!, $instanceStart: DateTime) {
  deleteWorkspaceEvent(
    eventId: $eventId
    workspaceId: $workspaceId
    scope: $scope
    instanceStart: $instanceStart
  )
}`,
};

export const exportWorkspaceCalendarIcsQuery = {
  id: "exportWorkspaceCalendarIcsQuery" as const,
  op: "exportWorkspaceCalendarIcs",
  kind: "query" as const,
  query: `query exportWorkspaceCalendarIcs($workspaceId: String!, $from: DateTime!, $to: DateTime!) {
  exportWorkspaceCalendarIcs(workspaceId: $workspaceId, from: $from, to: $to)
}`,
};

export const importWorkspaceCalendarIcsMutation = {
  id: "importWorkspaceCalendarIcsMutation" as const,
  op: "importWorkspaceCalendarIcs",
  kind: "mutation" as const,
  query: `mutation importWorkspaceCalendarIcs($workspaceId: String!, $icsBody: String!) {
  importWorkspaceCalendarIcs(workspaceId: $workspaceId, icsBody: $icsBody) {
    importedCount
    skippedCount
    errors
  }
}`,
};

export const linkCalDavAccountMutation = {
  id: "linkCalDavAccountMutation" as const,
  op: "linkCalDavAccount",
  kind: "mutation" as const,
  query: `mutation linkCalDavAccount($input: LinkCalDAVAccountInput!) {
  linkCalDAVAccount(input: $input) {
    id
    provider
    providerAccountId
    displayName
    email
    status
    lastError
    refreshIntervalMinutes
    calendarsCount
    createdAt
    updatedAt
  }
}`,
};

export const linkCalendarAccountMutation = {
  id: "linkCalendarAccountMutation" as const,
  op: "linkCalendarAccount",
  kind: "mutation" as const,
  query: `mutation linkCalendarAccount($input: LinkCalendarAccountInput!) {
  linkCalendarAccount(input: $input)
}`,
};

export const unlinkCalendarAccountMutation = {
  id: "unlinkCalendarAccountMutation" as const,
  op: "unlinkCalendarAccount",
  kind: "mutation" as const,
  query: `mutation unlinkCalendarAccount($accountId: String!) {
  unlinkCalendarAccount(accountId: $accountId)
}`,
};

export const updateCalendarAccountMutation = {
  id: "updateCalendarAccountMutation" as const,
  op: "updateCalendarAccount",
  kind: "mutation" as const,
  query: `mutation updateCalendarAccount($accountId: String!, $refreshIntervalMinutes: Int!) {
  updateCalendarAccount(
    accountId: $accountId
    refreshIntervalMinutes: $refreshIntervalMinutes
  ) {
    id
    provider
    providerAccountId
    displayName
    email
    status
    lastError
    refreshIntervalMinutes
    calendarsCount
    createdAt
    updatedAt
  }
}`,
};

export const updateCalendarEventRsvpMutation = {
  id: "updateCalendarEventRsvpMutation" as const,
  op: "updateCalendarEventRsvp",
  kind: "mutation" as const,
  query: `mutation updateCalendarEventRsvp($eventId: String!, $status: CalendarRsvpStatus!) {
  updateCalendarEventRsvp(eventId: $eventId, status: $status) {
    id
    accountId
    workspaceId
    remoteEventId
    startsAt
    endsAt
    title
    sourceExternalId
    participants {
      id
      userId
      email
      displayName
      responseStatus
      isOrganizer
    }
    reminders {
      id
      channel
      minutesBefore
      scheduledFor
      deliveredAt
    }
  }
}`,
};

export const updateCalendarReminderStatusMutation = {
  id: "updateCalendarReminderStatusMutation" as const,
  op: "updateCalendarReminderStatus",
  kind: "mutation" as const,
  query: `mutation updateCalendarReminderStatus($workspaceId: String!, $reminderId: String!, $delivered: Boolean!) {
  updateCalendarReminderStatus(
    workspaceId: $workspaceId
    reminderId: $reminderId
    delivered: $delivered
  ) {
    ok
  }
}`,
};

export const updateEventTagMutation = {
  id: "updateEventTagMutation" as const,
  op: "updateEventTag",
  kind: "mutation" as const,
  query: `mutation updateEventTag($tagId: String!, $input: UpdateEventTagInput!) {
  updateEventTag(tagId: $tagId, input: $input) {
    id
    workspaceId
    name
    color
    createdAt
    updatedAt
  }
}`,
};

export const updateWorkspaceCalendarSettingsMutation = {
  id: "updateWorkspaceCalendarSettingsMutation" as const,
  op: "updateWorkspaceCalendarSettings",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceCalendarSettings($input: UpdateWorkspaceCalendarSettingsInput!) {
  updateWorkspaceCalendarSettings(input: $input) {
    workspaceId
    writebackSubscriptionId
    defaultReminderOffsetMinutes
    updatedAt
  }
}`,
};

export const updateWorkspaceCalendarsMutation = {
  id: "updateWorkspaceCalendarsMutation" as const,
  op: "updateWorkspaceCalendars",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceCalendars($input: UpdateWorkspaceCalendarsInput!) {
  updateWorkspaceCalendars(input: $input) {
    id
    workspaceId
    createdByUserId
    displayNameOverride
    colorOverride
    enabled
    items {
      id
      subscriptionId
      sortOrder
      colorOverride
      enabled
    }
  }
}`,
};

export const updateWorkspaceEventMutation = {
  id: "updateWorkspaceEventMutation" as const,
  op: "updateWorkspaceEvent",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceEvent($eventId: String!, $workspaceId: String!, $scope: NativeEventScope!, $instanceStart: DateTime, $input: UpdateWorkspaceEventInput!) {
  updateWorkspaceEvent(
    eventId: $eventId
    workspaceId: $workspaceId
    scope: $scope
    instanceStart: $instanceStart
    input: $input
  ) {
    id
    origin
    workspaceId
    title
    startsAt
    endsAt
    allDay
    allMembers
    tagId
    sourceExternalId
    descriptionDelta
    recurrenceParentId
    recurrenceId
    recurrence {
      ...CalendarRecurrenceFields
    }
    reminders {
      id
      channel
      minutesBefore
      scheduledFor
      deliveredAt
    }
  }
}
fragment CalendarRecurrenceFields on CalendarRecurrence {
  id
  revision
  zone
  lifecycle
  endsBefore
  pausedAt
  readOnly
  unsupportedReason
  sourceRrule
  rule {
    ...RecurrenceRuleFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`,
};

export const upsertCalendarEventMutation = {
  id: "upsertCalendarEventMutation" as const,
  op: "upsertCalendarEvent",
  kind: "mutation" as const,
  query: `mutation upsertCalendarEvent($input: CalendarEventInput!) {
  upsertCalendarEvent(input: $input) {
    id
    accountId
    workspaceId
    remoteEventId
    startsAt
    endsAt
    title
    sourceExternalId
    participants {
      id
      userId
      email
      displayName
      responseStatus
      isOrganizer
    }
    reminders {
      id
      channel
      minutesBefore
      scheduledFor
      deliveredAt
    }
  }
}`,
};

export const workspaceCalendarSeriesQuery = {
  id: "workspaceCalendarSeriesQuery" as const,
  op: "workspaceCalendarSeries",
  kind: "query" as const,
  query: `query workspaceCalendarSeries($workspaceId: String!) {
  workspaceCalendarSeries(workspaceId: $workspaceId) {
    id
    title
    startsAt
    allDay
    recurrence {
      ...CalendarRecurrenceFields
    }
  }
}
fragment CalendarRecurrenceFields on CalendarRecurrence {
  id
  revision
  zone
  lifecycle
  endsBefore
  pausedAt
  readOnly
  unsupportedReason
  sourceRrule
  rule {
    ...RecurrenceRuleFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`,
};

export const workspaceCalendarSettingsQuery = {
  id: "workspaceCalendarSettingsQuery" as const,
  op: "workspaceCalendarSettings",
  kind: "query" as const,
  query: `query workspaceCalendarSettings($workspaceId: String!) {
  workspaceCalendarSettings(workspaceId: $workspaceId) {
    workspaceId
    writebackSubscriptionId
    defaultReminderOffsetMinutes
    updatedAt
  }
}`,
};

export const workspaceCalendarsQuery = {
  id: "workspaceCalendarsQuery" as const,
  op: "workspaceCalendars",
  kind: "query" as const,
  query: `query workspaceCalendars($workspaceId: String!) {
  workspace(id: $workspaceId) {
    calendars {
      id
      workspaceId
      createdByUserId
      displayNameOverride
      colorOverride
      enabled
      items {
        id
        subscriptionId
        sortOrder
        colorOverride
        enabled
      }
    }
  }
}`,
};

export const canCreateOrganizationProjectQuery = {
  id: "canCreateOrganizationProjectQuery" as const,
  op: "canCreateOrganizationProject",
  kind: "query" as const,
  query: `query canCreateOrganizationProject($unitId: ID) {
  canCreateOrganizationProject(unitId: $unitId)
}`,
};

export const canCreateWorkspaceInOrganizationUnitQuery = {
  id: "canCreateWorkspaceInOrganizationUnitQuery" as const,
  op: "canCreateWorkspaceInOrganizationUnit",
  kind: "query" as const,
  query: `query canCreateWorkspaceInOrganizationUnit($unitId: ID!) {
  canCreateWorkspaceInOrganizationUnit(unitId: $unitId)
}`,
};

export const cancelOrganizationProjectRequestMutation = {
  id: "cancelOrganizationProjectRequestMutation" as const,
  op: "cancelOrganizationProjectRequest",
  kind: "mutation" as const,
  query: `mutation cancelOrganizationProjectRequest($id: ID!) {
  cancelOrganizationProjectRequest(id: $id)
}`,
};

export const changeEmailMutation = {
  id: "changeEmailMutation" as const,
  op: "changeEmail",
  kind: "mutation" as const,
  query: `mutation changeEmail($token: String!, $email: String!) {
  changeEmail(token: $token, email: $email) {
    id
    email
  }
}`,
};

export const changePasswordMutation = {
  id: "changePasswordMutation" as const,
  op: "changePassword",
  kind: "mutation" as const,
  query: `mutation changePassword($token: String!, $userId: String!, $newPassword: String!) {
  changePassword(token: $token, userId: $userId, newPassword: $newPassword)
}`,
};

export const clientUpdateControlQuery = {
  id: "clientUpdateControlQuery" as const,
  op: "clientUpdateControl",
  kind: "query" as const,
  query: `query clientUpdateControl {
  clientUpdateControl {
    schemaVersion
    stateId
    phase
    operationId
    maxAttempts
    retryAfterMs
    completion {
      operationId
      action
    }
    requiredWebBuildId
    cacheEpoch
    updatedAt
  }
}`,
};

export const listCommentChangesQuery = {
  id: "listCommentChangesQuery" as const,
  op: "listCommentChanges",
  kind: "query" as const,
  query: `query listCommentChanges($workspaceId: String!, $docId: String!, $pagination: PaginationInput!) {
  workspace(id: $workspaceId) {
    commentChanges(docId: $docId, pagination: $pagination) {
      totalCount
      edges {
        cursor
        node {
          action
          id
          commentId
          item
        }
      }
      pageInfo {
        startCursor
        endCursor
        hasNextPage
        hasPreviousPage
      }
    }
  }
}`,
};

export const createCommentMutation = {
  id: "createCommentMutation" as const,
  op: "createComment",
  kind: "mutation" as const,
  query: `mutation createComment($input: CommentCreateInput!) {
  createComment(input: $input) {
    id
    content
    resolved
    createdAt
    updatedAt
    user {
      id
      name
      avatarUrl
    }
    replies {
      commentId
      id
      content
      createdAt
      updatedAt
      user {
        id
        name
        avatarUrl
      }
    }
  }
}`,
};

export const deleteCommentMutation = {
  id: "deleteCommentMutation" as const,
  op: "deleteComment",
  kind: "mutation" as const,
  query: `mutation deleteComment($id: String!) {
  deleteComment(id: $id)
}`,
};

export const listCommentsQuery = {
  id: "listCommentsQuery" as const,
  op: "listComments",
  kind: "query" as const,
  query: `query listComments($workspaceId: String!, $docId: String!, $pagination: PaginationInput) {
  workspace(id: $workspaceId) {
    comments(docId: $docId, pagination: $pagination) {
      totalCount
      edges {
        cursor
        node {
          id
          content
          resolved
          createdAt
          updatedAt
          user {
            id
            name
            avatarUrl
          }
          replies {
            commentId
            id
            content
            createdAt
            updatedAt
            user {
              id
              name
              avatarUrl
            }
          }
        }
      }
      pageInfo {
        startCursor
        endCursor
        hasNextPage
        hasPreviousPage
      }
    }
  }
}`,
};

export const createReplyMutation = {
  id: "createReplyMutation" as const,
  op: "createReply",
  kind: "mutation" as const,
  query: `mutation createReply($input: ReplyCreateInput!) {
  createReply(input: $input) {
    commentId
    id
    content
    createdAt
    updatedAt
    user {
      id
      name
      avatarUrl
    }
  }
}`,
};

export const deleteReplyMutation = {
  id: "deleteReplyMutation" as const,
  op: "deleteReply",
  kind: "mutation" as const,
  query: `mutation deleteReply($id: String!) {
  deleteReply(id: $id)
}`,
};

export const updateReplyMutation = {
  id: "updateReplyMutation" as const,
  op: "updateReply",
  kind: "mutation" as const,
  query: `mutation updateReply($input: ReplyUpdateInput!) {
  updateReply(input: $input)
}`,
};

export const resolveCommentMutation = {
  id: "resolveCommentMutation" as const,
  op: "resolveComment",
  kind: "mutation" as const,
  query: `mutation resolveComment($input: CommentResolveInput!) {
  resolveComment(input: $input)
}`,
};

export const updateCommentMutation = {
  id: "updateCommentMutation" as const,
  op: "updateComment",
  kind: "mutation" as const,
  query: `mutation updateComment($input: CommentUpdateInput!) {
  updateComment(input: $input)
}`,
};

export const uploadCommentAttachmentMutation = {
  id: "uploadCommentAttachmentMutation" as const,
  op: "uploadCommentAttachment",
  kind: "mutation" as const,
  query: `mutation uploadCommentAttachment($workspaceId: String!, $docId: String!, $attachment: Upload!) {
  uploadCommentAttachment(
    workspaceId: $workspaceId
    docId: $docId
    attachment: $attachment
  )
}`,
  file: true,
};

export const prepareContextDocumentsQuery = {
  id: "prepareContextDocumentsQuery" as const,
  op: "prepareContextDocuments",
  kind: "query" as const,
  query: `query prepareContextDocuments($workspaceId: String!, $input: PrepareContextDocumentsInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareContextDocuments(input: $input) {
      plan {
        ...PreparedContextDocumentsFragment
      }
      assistance {
        mode
        source
        userDefaultExplicit
        interactiveMode
      }
      context {
        containerTitle
        taskTitle
      }
    }
  }
}
fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`,
};

export const contextDocumentsQuery = {
  id: "contextDocumentsQuery" as const,
  op: "contextDocuments",
  kind: "query" as const,
  query: `query contextDocuments($workspaceId: String!, $requestId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    contextDocuments(requestId: $requestId) {
      ...ContextDocumentsFragment
    }
  }
}
fragment ContextDocumentsFragment on ContextDocuments {
  requestId
  status
  reasonCode
  folderId
  placementComplete
  run {
    ...WorkspaceAutomationRun
  }
  canRetry
  canStop
  acceptedPlan {
    ...PreparedContextDocumentsFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedContextDocumentsFragment
  }
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  assistance {
    mode
    source
    userDefaultExplicit
    interactiveMode
  }
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const applyContextDocumentsMutation = {
  id: "applyContextDocumentsMutation" as const,
  op: "applyContextDocuments",
  kind: "mutation" as const,
  query: `mutation applyContextDocuments($input: ApplyContextDocumentsInput!) {
  applyContextDocuments(input: $input) {
    ...ContextDocumentsFragment
  }
}
fragment ContextDocumentsFragment on ContextDocuments {
  requestId
  status
  reasonCode
  folderId
  placementComplete
  run {
    ...WorkspaceAutomationRun
  }
  canRetry
  canStop
  acceptedPlan {
    ...PreparedContextDocumentsFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedContextDocumentsFragment
  }
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  assistance {
    mode
    source
    userDefaultExplicit
    interactiveMode
  }
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const stopContextDocumentsMutation = {
  id: "stopContextDocumentsMutation" as const,
  op: "stopContextDocuments",
  kind: "mutation" as const,
  query: `mutation stopContextDocuments($input: StopContextDocumentsInput!) {
  stopContextDocuments(input: $input) {
    ...ContextDocumentsFragment
  }
}
fragment ContextDocumentsFragment on ContextDocuments {
  requestId
  status
  reasonCode
  folderId
  placementComplete
  run {
    ...WorkspaceAutomationRun
  }
  canRetry
  canStop
  acceptedPlan {
    ...PreparedContextDocumentsFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedContextDocumentsFragment
  }
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  assistance {
    mode
    source
    userDefaultExplicit
    interactiveMode
  }
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const retryContextDocumentsMutation = {
  id: "retryContextDocumentsMutation" as const,
  op: "retryContextDocuments",
  kind: "mutation" as const,
  query: `mutation retryContextDocuments($input: RetryContextDocumentsInput!) {
  retryContextDocuments(input: $input) {
    ...ContextDocumentsFragment
  }
}
fragment ContextDocumentsFragment on ContextDocuments {
  requestId
  status
  reasonCode
  folderId
  placementComplete
  run {
    ...WorkspaceAutomationRun
  }
  canRetry
  canStop
  acceptedPlan {
    ...PreparedContextDocumentsFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedContextDocumentsFragment
  }
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  assistance {
    mode
    source
    userDefaultExplicit
    interactiveMode
  }
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedContextDocumentsFragment on PreparedContextDocuments {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  folder {
    ...AssistantFolderDestinationFragment
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const applyDocUpdatesMutation = {
  id: "applyDocUpdatesMutation" as const,
  op: "applyDocUpdates",
  kind: "mutation" as const,
  query: `mutation applyDocUpdates($workspaceId: String!, $docId: String!, $op: String!, $updates: String!) {
  applyDocUpdates(
    workspaceId: $workspaceId
    docId: $docId
    op: $op
    updates: $updates
  )
}`,
};

export const addContextBlobMutation = {
  id: "addContextBlobMutation" as const,
  op: "addContextBlob",
  kind: "mutation" as const,
  query: `mutation addContextBlob($options: AddContextBlobInput!) {
  addContextBlob(options: $options) {
    id
    createdAt
    status
  }
}`,
};

export const removeContextBlobMutation = {
  id: "removeContextBlobMutation" as const,
  op: "removeContextBlob",
  kind: "mutation" as const,
  query: `mutation removeContextBlob($options: RemoveContextBlobInput!) {
  removeContextBlob(options: $options)
}`,
};

export const addContextCategoryMutation = {
  id: "addContextCategoryMutation" as const,
  op: "addContextCategory",
  kind: "mutation" as const,
  query: `mutation addContextCategory($options: AddContextCategoryInput!) {
  addContextCategory(options: $options) {
    id
    createdAt
    type
    docs {
      id
      createdAt
      status
    }
  }
}`,
};

export const removeContextCategoryMutation = {
  id: "removeContextCategoryMutation" as const,
  op: "removeContextCategory",
  kind: "mutation" as const,
  query: `mutation removeContextCategory($options: RemoveContextCategoryInput!) {
  removeContextCategory(options: $options)
}`,
};

export const createCopilotContextMutation = {
  id: "createCopilotContextMutation" as const,
  op: "createCopilotContext",
  kind: "mutation" as const,
  query: `mutation createCopilotContext($workspaceId: String!, $sessionId: String!) {
  createCopilotContext(workspaceId: $workspaceId, sessionId: $sessionId)
}`,
};

export const addContextDocMutation = {
  id: "addContextDocMutation" as const,
  op: "addContextDoc",
  kind: "mutation" as const,
  query: `mutation addContextDoc($options: AddContextDocInput!) {
  addContextDoc(options: $options) {
    id
    createdAt
    status
  }
}`,
};

export const removeContextDocMutation = {
  id: "removeContextDocMutation" as const,
  op: "removeContextDoc",
  kind: "mutation" as const,
  query: `mutation removeContextDoc($options: RemoveContextDocInput!) {
  removeContextDoc(options: $options)
}`,
};

export const addContextFileMutation = {
  id: "addContextFileMutation" as const,
  op: "addContextFile",
  kind: "mutation" as const,
  query: `mutation addContextFile($content: Upload!, $options: AddContextFileInput!) {
  addContextFile(content: $content, options: $options) {
    id
    createdAt
    name
    mimeType
    chunkSize
    error
    status
    blobId
  }
}`,
  file: true,
};

export const removeContextFileMutation = {
  id: "removeContextFileMutation" as const,
  op: "removeContextFile",
  kind: "mutation" as const,
  query: `mutation removeContextFile($options: RemoveContextFileInput!) {
  removeContextFile(options: $options)
}`,
};

export const retryContextFileMutation = {
  id: "retryContextFileMutation" as const,
  op: "retryContextFile",
  kind: "mutation" as const,
  query: `mutation retryContextFile($options: RemoveContextFileInput!) {
  retryContextFile(options: $options) {
    id
    createdAt
    name
    mimeType
    chunkSize
    error
    status
    blobId
  }
}`,
};

export const listContextObjectQuery = {
  id: "listContextObjectQuery" as const,
  op: "listContextObject",
  kind: "query" as const,
  query: `query listContextObject($workspaceId: String!, $sessionId: String!, $contextId: String!) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      contexts(sessionId: $sessionId, contextId: $contextId) {
        blobs {
          id
          status
          createdAt
        }
        docs {
          id
          status
          createdAt
        }
        files {
          id
          name
          mimeType
          blobId
          chunkSize
          error
          status
          createdAt
        }
        tags {
          type
          id
          docs {
            id
            status
            createdAt
          }
          createdAt
        }
        collections {
          type
          id
          docs {
            id
            status
            createdAt
          }
          createdAt
        }
      }
    }
  }
}`,
};

export const listContextQuery = {
  id: "listContextQuery" as const,
  op: "listContext",
  kind: "query" as const,
  query: `query listContext($workspaceId: String!, $sessionId: String!) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      contexts(sessionId: $sessionId) {
        id
        workspaceId
      }
    }
  }
}`,
};

export const matchContextQuery = {
  id: "matchContextQuery" as const,
  op: "matchContext",
  kind: "query" as const,
  query: `query matchContext($contextId: String, $workspaceId: String, $content: String!, $limit: Int, $scopedThreshold: Float, $threshold: Float) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      contexts(contextId: $contextId) {
        matchFiles(
          content: $content
          limit: $limit
          scopedThreshold: $scopedThreshold
          threshold: $threshold
        ) {
          fileId
          blobId
          name
          mimeType
          chunk
          content
          distance
        }
        matchWorkspaceDocs(
          content: $content
          limit: $limit
          scopedThreshold: $scopedThreshold
          threshold: $threshold
        ) {
          docId
          chunk
          content
          distance
        }
      }
    }
  }
}`,
};

export const matchWorkspaceDocsQuery = {
  id: "matchWorkspaceDocsQuery" as const,
  op: "matchWorkspaceDocs",
  kind: "query" as const,
  query: `query matchWorkspaceDocs($contextId: String, $workspaceId: String, $content: String!, $limit: Int, $scopedThreshold: Float, $threshold: Float) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      contexts(contextId: $contextId) {
        matchWorkspaceDocs(
          content: $content
          limit: $limit
          scopedThreshold: $scopedThreshold
          threshold: $threshold
        ) {
          docId
          chunk
          content
          distance
        }
      }
    }
  }
}`,
};

export const matchFilesQuery = {
  id: "matchFilesQuery" as const,
  op: "matchFiles",
  kind: "query" as const,
  query: `query matchFiles($contextId: String, $workspaceId: String, $content: String!, $limit: Int, $scopedThreshold: Float, $threshold: Float) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      contexts(contextId: $contextId) {
        matchFiles(
          content: $content
          limit: $limit
          scopedThreshold: $scopedThreshold
          threshold: $threshold
        ) {
          fileId
          blobId
          chunk
          content
          distance
        }
      }
    }
  }
}`,
};

export const getWorkspaceEmbeddingStatusQuery = {
  id: "getWorkspaceEmbeddingStatusQuery" as const,
  op: "getWorkspaceEmbeddingStatus",
  kind: "query" as const,
  query: `query getWorkspaceEmbeddingStatus($workspaceId: String!) {
  queryWorkspaceEmbeddingStatus(workspaceId: $workspaceId) {
    total
    embedded
    available
    status
    error
  }
}`,
};

export const queueWorkspaceEmbeddingMutation = {
  id: "queueWorkspaceEmbeddingMutation" as const,
  op: "queueWorkspaceEmbedding",
  kind: "mutation" as const,
  query: `mutation queueWorkspaceEmbedding($workspaceId: String!, $docId: [String!]!) {
  queueWorkspaceEmbedding(workspaceId: $workspaceId, docId: $docId)
}`,
};

export const getCopilotHistoryIdsQuery = {
  id: "getCopilotHistoryIdsQuery" as const,
  op: "getCopilotHistoryIds",
  kind: "query" as const,
  query: `query getCopilotHistoryIds($workspaceId: String!, $pagination: PaginationInput!, $docId: String, $options: QueryChatHistoriesInput) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(pagination: $pagination, docId: $docId, options: $options) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
          node {
            sessionId
            pinned
            messages {
              id
              role
              createdAt
            }
          }
        }
      }
    }
  }
}`,
};

export const getCopilotDocSessionsQuery = {
  id: "getCopilotDocSessionsQuery" as const,
  op: "getCopilotDocSessions",
  kind: "query" as const,
  query: `query getCopilotDocSessions($workspaceId: String!, $docId: String!, $pagination: PaginationInput!, $options: QueryChatHistoriesInput) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(pagination: $pagination, docId: $docId, options: $options) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const getCopilotPinnedSessionsQuery = {
  id: "getCopilotPinnedSessionsQuery" as const,
  op: "getCopilotPinnedSessions",
  kind: "query" as const,
  query: `query getCopilotPinnedSessions($workspaceId: String!, $docId: String, $messageOrder: ChatHistoryOrder, $withPrompt: Boolean) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(
        pagination: {first: 1}
        docId: $docId
        options: {pinned: true, messageOrder: $messageOrder, withPrompt: $withPrompt}
      ) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const getCopilotWorkspaceSessionsQuery = {
  id: "getCopilotWorkspaceSessionsQuery" as const,
  op: "getCopilotWorkspaceSessions",
  kind: "query" as const,
  query: `query getCopilotWorkspaceSessions($workspaceId: String!, $pagination: PaginationInput!, $options: QueryChatHistoriesInput) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(pagination: $pagination, docId: null, options: $options) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const getCopilotHistoriesQuery = {
  id: "getCopilotHistoriesQuery" as const,
  op: "getCopilotHistories",
  kind: "query" as const,
  query: `query getCopilotHistories($workspaceId: String!, $pagination: PaginationInput!, $docId: String, $options: QueryChatHistoriesInput) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(pagination: $pagination, docId: $docId, options: $options) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const submitAudioTranscriptionMutation = {
  id: "submitAudioTranscriptionMutation" as const,
  op: "submitAudioTranscription",
  kind: "mutation" as const,
  query: `mutation submitAudioTranscription($workspaceId: String!, $blobId: String!, $blob: Upload, $blobs: [Upload!]) {
  submitAudioTranscription(
    blob: $blob
    blobs: $blobs
    blobId: $blobId
    workspaceId: $workspaceId
  ) {
    id
    status
  }
}`,
  file: true,
};

export const claimAudioTranscriptionMutation = {
  id: "claimAudioTranscriptionMutation" as const,
  op: "claimAudioTranscription",
  kind: "mutation" as const,
  query: `mutation claimAudioTranscription($jobId: String!) {
  claimAudioTranscription(jobId: $jobId) {
    id
    status
    title
    summary
    actions
    text
    segments {
      text
      startSeconds
      endSeconds
      speaker
    }
    transcription {
      speaker
      start
      end
      transcription
    }
  }
}`,
};

export const getAudioTranscriptionQuery = {
  id: "getAudioTranscriptionQuery" as const,
  op: "getAudioTranscription",
  kind: "query" as const,
  query: `query getAudioTranscription($workspaceId: String!, $jobId: String, $blobId: String) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      audioTranscription(jobId: $jobId, blobId: $blobId) {
        id
        status
        errorMessage
        title
        summary
        actions
        text
        segments {
          text
          startSeconds
          endSeconds
          speaker
        }
        transcription {
          speaker
          start
          end
          transcription
        }
      }
    }
  }
}`,
};

export const retryAudioTranscriptionMutation = {
  id: "retryAudioTranscriptionMutation" as const,
  op: "retryAudioTranscription",
  kind: "mutation" as const,
  query: `mutation retryAudioTranscription($workspaceId: String!, $jobId: String!) {
  retryAudioTranscription(workspaceId: $workspaceId, jobId: $jobId) {
    id
    status
  }
}`,
};

export const createCopilotMessageMutation = {
  id: "createCopilotMessageMutation" as const,
  op: "createCopilotMessage",
  kind: "mutation" as const,
  query: `mutation createCopilotMessage($options: CreateChatMessageInput!) {
  createCopilotMessage(options: $options)
}`,
};

export const exportCopilotMessageMutation = {
  id: "exportCopilotMessageMutation" as const,
  op: "exportCopilotMessage",
  kind: "mutation" as const,
  query: `mutation exportCopilotMessage($messageId: ID!, $format: CopilotExportFormat!) {
  exportCopilotMessage(messageId: $messageId, format: $format) {
    id
    fileName
    mimeType
    sizeBytes
    format
    downloadUrl
  }
}`,
};

export const getPromptModelsQuery = {
  id: "getPromptModelsQuery" as const,
  op: "getPromptModels",
  kind: "query" as const,
  query: `query getPromptModels($promptName: String!) {
  currentUser {
    copilot {
      models(promptName: $promptName) {
        defaultModel
        optionalModels {
          id
          name
          reasoningAvailable
          supportsVision
        }
        proModels {
          id
          name
        }
      }
    }
  }
}`,
};

export const copilotQuotaQuery = {
  id: "copilotQuotaQuery" as const,
  op: "copilotQuota",
  kind: "query" as const,
  query: `query copilotQuota {
  currentUser {
    copilot {
      quota {
        limit
        used
      }
    }
  }
}`,
};

export const cleanupCopilotSessionMutation = {
  id: "cleanupCopilotSessionMutation" as const,
  op: "cleanupCopilotSession",
  kind: "mutation" as const,
  query: `mutation cleanupCopilotSession($input: DeleteSessionInput!) {
  cleanupCopilotSession(options: $input)
}`,
};

export const createCopilotSessionWithHistoryMutation = {
  id: "createCopilotSessionWithHistoryMutation" as const,
  op: "createCopilotSessionWithHistory",
  kind: "mutation" as const,
  query: `mutation createCopilotSessionWithHistory($options: CreateChatSessionInput!) {
  createCopilotSessionWithHistory(options: $options) {
    ...CopilotChatHistory
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const createCopilotSessionMutation = {
  id: "createCopilotSessionMutation" as const,
  op: "createCopilotSession",
  kind: "mutation" as const,
  query: `mutation createCopilotSession($options: CreateChatSessionInput!) {
  createCopilotSession(options: $options)
}`,
};

export const forkCopilotSessionMutation = {
  id: "forkCopilotSessionMutation" as const,
  op: "forkCopilotSession",
  kind: "mutation" as const,
  query: `mutation forkCopilotSession($options: ForkChatSessionInput!) {
  forkCopilotSession(options: $options)
}`,
};

export const getCopilotLatestDocSessionQuery = {
  id: "getCopilotLatestDocSessionQuery" as const,
  op: "getCopilotLatestDocSession",
  kind: "query" as const,
  query: `query getCopilotLatestDocSession($workspaceId: String!, $docId: String!) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(
        pagination: {first: 1}
        docId: $docId
        options: {sessionOrder: desc, action: false, fork: false, withMessages: true}
      ) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const getCopilotSessionQuery = {
  id: "getCopilotSessionQuery" as const,
  op: "getCopilotSession",
  kind: "query" as const,
  query: `query getCopilotSession($workspaceId: String!, $sessionId: String!) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(pagination: {first: 1}, options: {sessionId: $sessionId}) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const getCopilotRecentSessionsQuery = {
  id: "getCopilotRecentSessionsQuery" as const,
  op: "getCopilotRecentSessions",
  kind: "query" as const,
  query: `query getCopilotRecentSessions($workspaceId: String!, $limit: Int = 10, $offset: Int = 0) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(
        pagination: {first: $limit, offset: $offset}
        options: {action: false, fork: false, sessionOrder: desc, withMessages: false}
      ) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const updateCopilotSessionMutation = {
  id: "updateCopilotSessionMutation" as const,
  op: "updateCopilotSession",
  kind: "mutation" as const,
  query: `mutation updateCopilotSession($options: UpdateChatSessionInput!) {
  updateCopilotSession(options: $options)
}`,
};

export const getCopilotSessionsQuery = {
  id: "getCopilotSessionsQuery" as const,
  op: "getCopilotSessions",
  kind: "query" as const,
  query: `query getCopilotSessions($workspaceId: String!, $pagination: PaginationInput!, $docId: String, $options: QueryChatHistoriesInput) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      chats(pagination: $pagination, docId: $docId, options: $options) {
        ...PaginatedCopilotChats
      }
    }
  }
}
fragment PaginatedCopilotChats on PaginatedCopilotHistoriesType {
  pageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
  edges {
    cursor
    node {
      ...CopilotChatHistory
    }
  }
}
fragment CopilotChatHistory on CopilotHistories {
  sessionId
  workspaceId
  docId
  parentSessionId
  promptName
  model
  optionalModels
  action
  pinned
  title
  tokens
  messages {
    id
    role
    content
    params
    attachments
    generatedFiles {
      id
      fileName
      mimeType
      sizeBytes
      format
      downloadUrl
    }
    streamObjects {
      type
      textDelta
      toolCallId
      toolName
      args
      result
    }
    createdAt
  }
  createdAt
  updatedAt
}`,
};

export const enrichAudioTranscriptionMutation = {
  id: "enrichAudioTranscriptionMutation" as const,
  op: "enrichAudioTranscription",
  kind: "mutation" as const,
  query: `mutation enrichAudioTranscription($workspaceId: String!, $jobId: String!, $summary: Boolean!, $actions: Boolean!) {
  enrichAudioTranscription(
    workspaceId: $workspaceId
    jobId: $jobId
    summary: $summary
    actions: $actions
  ) {
    id
    status
    errorMessage
    summary
    actions
  }
}`,
};

export const getAudioTranscriptionEnrichmentQuery = {
  id: "getAudioTranscriptionEnrichmentQuery" as const,
  op: "getAudioTranscriptionEnrichment",
  kind: "query" as const,
  query: `query getAudioTranscriptionEnrichment($workspaceId: String!, $jobId: String!, $blobId: String!) {
  currentUser {
    copilot(workspaceId: $workspaceId) {
      audioTranscription(jobId: $jobId, blobId: $blobId) {
        enrichment {
          id
          status
          errorMessage
          summary
          actions
        }
      }
    }
  }
}`,
};

export const addWorkspaceEmbeddingFilesMutation = {
  id: "addWorkspaceEmbeddingFilesMutation" as const,
  op: "addWorkspaceEmbeddingFiles",
  kind: "mutation" as const,
  query: `mutation addWorkspaceEmbeddingFiles($workspaceId: String!, $blob: Upload!) {
  addWorkspaceEmbeddingFiles(workspaceId: $workspaceId, blob: $blob) {
    fileId
    fileName
    blobId
    mimeType
    size
    createdAt
  }
}`,
  file: true,
};

export const getWorkspaceEmbeddingFilesQuery = {
  id: "getWorkspaceEmbeddingFilesQuery" as const,
  op: "getWorkspaceEmbeddingFiles",
  kind: "query" as const,
  query: `query getWorkspaceEmbeddingFiles($workspaceId: String!, $pagination: PaginationInput!) {
  workspace(id: $workspaceId) {
    embedding {
      files(pagination: $pagination) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            fileId
            fileName
            blobId
            mimeType
            size
            createdAt
          }
        }
      }
    }
  }
}`,
};

export const removeWorkspaceEmbeddingFilesMutation = {
  id: "removeWorkspaceEmbeddingFilesMutation" as const,
  op: "removeWorkspaceEmbeddingFiles",
  kind: "mutation" as const,
  query: `mutation removeWorkspaceEmbeddingFiles($workspaceId: String!, $fileId: String!) {
  removeWorkspaceEmbeddingFiles(workspaceId: $workspaceId, fileId: $fileId)
}`,
};

export const addWorkspaceEmbeddingIgnoredDocsMutation = {
  id: "addWorkspaceEmbeddingIgnoredDocsMutation" as const,
  op: "addWorkspaceEmbeddingIgnoredDocs",
  kind: "mutation" as const,
  query: `mutation addWorkspaceEmbeddingIgnoredDocs($workspaceId: String!, $add: [String!]!) {
  updateWorkspaceEmbeddingIgnoredDocs(workspaceId: $workspaceId, add: $add)
}`,
};

export const getAllWorkspaceEmbeddingIgnoredDocsQuery = {
  id: "getAllWorkspaceEmbeddingIgnoredDocsQuery" as const,
  op: "getAllWorkspaceEmbeddingIgnoredDocs",
  kind: "query" as const,
  query: `query getAllWorkspaceEmbeddingIgnoredDocs($workspaceId: String!) {
  workspace(id: $workspaceId) {
    embedding {
      allIgnoredDocs {
        docId
        createdAt
      }
    }
  }
}`,
};

export const getWorkspaceEmbeddingIgnoredDocsQuery = {
  id: "getWorkspaceEmbeddingIgnoredDocsQuery" as const,
  op: "getWorkspaceEmbeddingIgnoredDocs",
  kind: "query" as const,
  query: `query getWorkspaceEmbeddingIgnoredDocs($workspaceId: String!, $pagination: PaginationInput!) {
  workspace(id: $workspaceId) {
    embedding {
      ignoredDocs(pagination: $pagination) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            docId
            createdAt
            docCreatedAt
            docUpdatedAt
            title
            createdBy
            createdByAvatar
            updatedBy
          }
        }
      }
    }
  }
}`,
};

export const removeWorkspaceEmbeddingIgnoredDocsMutation = {
  id: "removeWorkspaceEmbeddingIgnoredDocsMutation" as const,
  op: "removeWorkspaceEmbeddingIgnoredDocs",
  kind: "mutation" as const,
  query: `mutation removeWorkspaceEmbeddingIgnoredDocs($workspaceId: String!, $remove: [String!]!) {
  updateWorkspaceEmbeddingIgnoredDocs(workspaceId: $workspaceId, remove: $remove)
}`,
};

export const createCustomerPortalMutation = {
  id: "createCustomerPortalMutation" as const,
  op: "createCustomerPortal",
  kind: "mutation" as const,
  query: `mutation createCustomerPortal {
  createCustomerPortal
}`,
};

export const createOrganizationProjectMutation = {
  id: "createOrganizationProjectMutation" as const,
  op: "createOrganizationProject",
  kind: "mutation" as const,
  query: `mutation createOrganizationProject($input: CreateOrganizationProjectInput!) {
  createOrganizationProject(input: $input) {
    decision
    requestId
    createdUnitId
  }
}`,
};

export const createSelfhostCustomerPortalMutation = {
  id: "createSelfhostCustomerPortalMutation" as const,
  op: "createSelfhostCustomerPortal",
  kind: "mutation" as const,
  query: `mutation createSelfhostCustomerPortal($workspaceId: String!) {
  createSelfhostWorkspaceCustomerPortal(workspaceId: $workspaceId)
}`,
};

export const createWorkspaceInOrganizationUnitMutation = {
  id: "createWorkspaceInOrganizationUnitMutation" as const,
  op: "createWorkspaceInOrganizationUnit",
  kind: "mutation" as const,
  query: `mutation createWorkspaceInOrganizationUnit($input: CreateWorkspaceInOrganizationUnitInput!) {
  createWorkspaceInOrganizationUnit(input: $input) {
    id
    name
    initialized
    public
  }
}`,
};

export const createWorkspaceMutation = {
  id: "createWorkspaceMutation" as const,
  op: "createWorkspace",
  kind: "mutation" as const,
  query: `mutation createWorkspace($input: CreateWorkspaceInput) {
  createWorkspace(input: $input) {
    id
    name
    initialized
    role
    workspaceType
    owner {
      id
    }
    public
    createdAt
    initialContentPolicy
    creation {
      ...WorkspaceCreationResultFragment
    }
  }
}
fragment WorkspaceCreationResultFragment on WorkspaceCreationResultType {
  workspaceId
  requestId
  status
  rootReady
  tasksReady
  tasksDatabaseId
  assistanceSaved
  retryRequired
  reasonCode
  acceptedPlan {
    ...WorkspaceCreationPlanFragment
  }
  projectSetup {
    ...ProjectSetupFragment
  }
  setup {
    ...WorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment WorkspaceSetupFragment on WorkspaceSetup {
  requestId
  status
  canRetry
  canStop
  reasonCode
  acceptedPlan {
    ...PreparedWorkspaceSetupFragment
  }
  currentReview {
    ...PreparedWorkspaceSetupFragment
  }
  run {
    id
    status
  }
  components {
    componentId
    reservedId
    documentExternalId
    available
    result {
      kind
      databaseId
      documentId
      entryId
    }
  }
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}`,
};

export const databaseTaskDestinationsQuery = {
  id: "databaseTaskDestinationsQuery" as const,
  op: "databaseTaskDestinations",
  kind: "query" as const,
  query: `query databaseTaskDestinations($workspaceId: String!, $first: Int, $after: ID) {
  workspace(id: $workspaceId) {
    id
    databaseTaskDestinations(first: $first, after: $after) {
      defaultDestination {
        ...DatabaseTaskDestination
      }
      projects {
        ...DatabaseTaskDestination
      }
      nextCursor
      unavailableProjects {
        databaseId
        title
        reasonCode
      }
      coverageComplete
    }
  }
}
fragment DatabaseTaskDestination on DatabaseTaskDestination {
  databaseId
  title
  editRevision
  managedSchema {
    ...DatabaseManagedSchema
  }
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}`,
};

export const prepareDatabaseTaskMoveQuery = {
  id: "prepareDatabaseTaskMoveQuery" as const,
  op: "prepareDatabaseTaskMove",
  kind: "query" as const,
  query: `query prepareDatabaseTaskMove($workspaceId: String!, $input: DatabaseTaskMoveInput!) {
  workspace(id: $workspaceId) {
    id
    prepareDatabaseTaskMove(input: $input) {
      input {
        ...DatabaseTaskMovePlan
      }
      eligible
      reasons
      requiredRelatedTasks
      boundaries {
        rowId
        fieldId
        relatedRowId
        inbound
        recoverableTrash
      }
      allocatesDisplayIds
    }
  }
}
fragment DatabaseTaskMovePlan on DatabaseTaskMovePlan {
  workspaceId
  sourceDatabaseId
  targetDatabaseId
  sourceEditRevision
  targetEditRevision
  sourceSchemaRevision
  targetSchemaRevision
  selection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
  phaseRowId
  milestoneRowId
}`,
};

export const moveDatabaseTasksMutation = {
  id: "moveDatabaseTasksMutation" as const,
  op: "moveDatabaseTasks",
  kind: "mutation" as const,
  query: `mutation moveDatabaseTasks($input: DatabaseTaskMoveInput!) {
  moveDatabaseTasks(input: $input) {
    sourceDatabaseId
    targetDatabaseId
    rows {
      ...DatabaseRowRecord
    }
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const databasesQuery = {
  id: "databasesQuery" as const,
  op: "databases",
  kind: "query" as const,
  query: `query databases($workspaceId: String!, $first: Int, $offset: Int, $search: String, $profileKind: DatabaseProfileKind, $databaseIds: [ID!], $sort: DatabaseInventorySort) {
  workspace(id: $workspaceId) {
    databases(
      first: $first
      offset: $offset
      search: $search
      profileKind: $profileKind
      databaseIds: $databaseIds
      sort: $sort
    ) {
      ...DatabaseSummary
    }
  }
}
fragment DatabaseSummary on DatabaseSummary {
  id
  systemRole
  workspaceId
  profileKind
  profileStructurePreset
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
  rowCount
  fieldCount
  viewCount
}`,
};

export const databaseSearchQuery = {
  id: "databaseSearchQuery" as const,
  op: "databaseSearch",
  kind: "query" as const,
  query: `query databaseSearch($workspaceId: String!, $filter: DatabaseSearchFilterInput!) {
  workspace(id: $workspaceId) {
    databaseSearch(filter: $filter) {
      rowId
      databaseId
      title
      snippet
      hasContentDocument
      updatedAt
    }
  }
}`,
};

export const trashedDatabasesQuery = {
  id: "trashedDatabasesQuery" as const,
  op: "trashedDatabases",
  kind: "query" as const,
  query: `query trashedDatabases($workspaceId: String!, $first: Int, $offset: Int) {
  workspace(id: $workspaceId) {
    trashedDatabases(first: $first, offset: $offset) {
      ...DatabaseSummary
    }
  }
}
fragment DatabaseSummary on DatabaseSummary {
  id
  systemRole
  workspaceId
  profileKind
  profileStructurePreset
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
  rowCount
  fieldCount
  viewCount
}`,
};

export const databasePageIdentitiesQuery = {
  id: "databasePageIdentitiesQuery" as const,
  op: "databasePageIdentities",
  kind: "query" as const,
  query: `query databasePageIdentities($workspaceId: String!, $first: Int, $offset: Int) {
  workspace(id: $workspaceId) {
    databasePageIdentities(first: $first, offset: $offset) {
      ...DatabasePageIdentity
    }
  }
}
fragment DatabasePageIdentity on DatabasePageIdentity {
  id
  systemRole
  profileKind
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
}`,
};

export const trashedDatabasePageIdentitiesQuery = {
  id: "trashedDatabasePageIdentitiesQuery" as const,
  op: "trashedDatabasePageIdentities",
  kind: "query" as const,
  query: `query trashedDatabasePageIdentities($workspaceId: String!, $first: Int, $offset: Int) {
  workspace(id: $workspaceId) {
    trashedDatabasePageIdentities(first: $first, offset: $offset) {
      ...DatabasePageIdentity
    }
  }
}
fragment DatabasePageIdentity on DatabasePageIdentity {
  id
  systemRole
  profileKind
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
}`,
};

export const databaseSummaryQuery = {
  id: "databaseSummaryQuery" as const,
  op: "databaseSummary",
  kind: "query" as const,
  query: `query databaseSummary($workspaceId: String!, $databaseId: ID!) {
  workspace(id: $workspaceId) {
    databaseSummary(databaseId: $databaseId) {
      ...DatabaseSummary
    }
  }
}
fragment DatabaseSummary on DatabaseSummary {
  id
  systemRole
  workspaceId
  profileKind
  profileStructurePreset
  title
  description
  deletedAt
  editRevision
  createdAt
  updatedAt
  rowCount
  fieldCount
  viewCount
}`,
};

export const databaseQuery = {
  id: "databaseQuery" as const,
  op: "database",
  kind: "query" as const,
  query: `query database($workspaceId: String!, $databaseId: ID!) {
  workspace(id: $workspaceId) {
    database(databaseId: $databaseId) {
      ...DatabaseRecord
    }
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const databaseSchemaQuery = {
  id: "databaseSchemaQuery" as const,
  op: "databaseSchema",
  kind: "query" as const,
  query: `query databaseSchema($workspaceId: String!, $databaseId: ID!) {
  workspace(id: $workspaceId) {
    database(databaseId: $databaseId) {
      ...DatabaseSchemaRecord
    }
  }
}
fragment DatabaseSchemaRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const databaseViewsQuery = {
  id: "databaseViewsQuery" as const,
  op: "databaseViews",
  kind: "query" as const,
  query: `query databaseViews($workspaceId: String!, $databaseId: ID!) {
  workspace(id: $workspaceId) {
    database(databaseId: $databaseId) {
      ...DatabaseViewsRecord
    }
  }
}
fragment DatabaseViewsRecord on DatabaseRecord {
  views {
    ...DatabaseViewSummary
  }
}
fragment DatabaseViewSummary on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    kind
  }
  position
  editRevision
  createdAt
  updatedAt
}`,
};

export const databaseViewQuery = {
  id: "databaseViewQuery" as const,
  op: "databaseView",
  kind: "query" as const,
  query: `query databaseView($workspaceId: String!, $databaseId: ID!, $viewId: ID!) {
  workspace(id: $workspaceId) {
    databaseView(databaseId: $databaseId, viewId: $viewId) {
      ...DatabaseView
    }
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`,
};

export const databaseEffectiveViewStateQuery = {
  id: "databaseEffectiveViewStateQuery" as const,
  op: "databaseEffectiveViewState",
  kind: "query" as const,
  query: `query databaseEffectiveViewState($workspaceId: String!, $databaseId: ID!, $viewId: ID!) {
  workspace(id: $workspaceId) {
    databaseEffectiveViewState(databaseId: $databaseId, viewId: $viewId) {
      viewId
      savedSort {
        ...DatabaseSortRule
      }
      savedFilterTree {
        ...DatabaseFilterGroup
      }
      personalState {
        viewId
        searchText
        sort {
          ...DatabaseSortRule
        }
        filterTree {
          ...DatabaseFilterGroup
        }
        fieldWidthOverrides {
          fieldId
          width
        }
        collapsedGroupKeys
        editRevision
        updatedAt
      }
      effectiveSort {
        ...DatabaseSortRule
      }
      effectiveFilterTree {
        ...DatabaseFilterGroup
      }
      searchText
      effectiveFieldWidths {
        fieldId
        width
      }
      canEditShared
      canEditRows
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}`,
};

export const databaseRowsQuery = {
  id: "databaseRowsQuery" as const,
  op: "databaseRows",
  kind: "query" as const,
  query: `query databaseRows($workspaceId: String!, $databaseId: ID!, $first: Int, $offset: Int, $after: String, $viewId: ID, $search: String, $sort: [DatabaseSortRuleInput!], $filter: [DatabaseFilterRuleInput!], $filterTree: DatabaseFilterGroupInput, $scheduleWindow: DatabaseScheduleWindowInput) {
  workspace(id: $workspaceId) {
    databaseRows(
      databaseId: $databaseId
      first: $first
      offset: $offset
      after: $after
      viewId: $viewId
      search: $search
      sort: $sort
      filter: $filter
      filterTree: $filterTree
      scheduleWindow: $scheduleWindow
    ) {
      totalCount
      endCursor
      rows {
        ...DatabaseRowRecord
      }
    }
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const databaseRowQuery = {
  id: "databaseRowQuery" as const,
  op: "databaseRow",
  kind: "query" as const,
  query: `query databaseRow($workspaceId: String!, $databaseId: ID!, $rowId: ID!, $includeTrashed: Boolean = false) {
  workspace(id: $workspaceId) {
    databaseRow(
      databaseId: $databaseId
      rowId: $rowId
      includeTrashed: $includeTrashed
    ) {
      ...DatabaseRowRecord
    }
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const databaseTaskParentQuery = {
  id: "databaseTaskParentQuery" as const,
  op: "databaseTaskParent",
  kind: "query" as const,
  query: `query databaseTaskParent($workspaceId: String!, $databaseId: ID!, $rowId: ID!) {
  workspace(id: $workspaceId) {
    id
    databaseRow(databaseId: $databaseId, rowId: $rowId, includeTrashed: true) {
      row {
        id
        databaseId
        taskParent {
          available
          fieldId
          parentRowIds
          diagnostics
        }
      }
    }
  }
}`,
};

export const databaseTaskBlockedByQuery = {
  id: "databaseTaskBlockedByQuery" as const,
  op: "databaseTaskBlockedBy",
  kind: "query" as const,
  query: `query databaseTaskBlockedBy($workspaceId: String!, $databaseId: ID!, $rowId: ID!, $after: String) {
  workspace(id: $workspaceId) {
    id
    databaseRow(databaseId: $databaseId, rowId: $rowId, includeTrashed: true) {
      row {
        id
        databaseId
        taskBlockedBy(first: 50, after: $after) {
          available
          fieldId
          diagnostics
          retainedRowIds
          rows {
            rowId
            state
            task {
              ...DatabaseTaskSummary
            }
          }
          nextCursor
        }
      }
    }
  }
}
fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`,
};

export const databaseTaskBlocksQuery = {
  id: "databaseTaskBlocksQuery" as const,
  op: "databaseTaskBlocks",
  kind: "query" as const,
  query: `query databaseTaskBlocks($workspaceId: String!, $databaseId: ID!, $rowId: ID!, $after: String) {
  workspace(id: $workspaceId) {
    id
    databaseRow(databaseId: $databaseId, rowId: $rowId, includeTrashed: true) {
      row {
        id
        databaseId
        taskBlocks(first: 20, after: $after) {
          available
          fieldId
          diagnostics
          rows {
            rowId
            state
            task {
              ...DatabaseTaskSummary
            }
          }
          nextCursor
        }
      }
    }
  }
}
fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`,
};

export const databaseTaskChildrenQuery = {
  id: "databaseTaskChildrenQuery" as const,
  op: "databaseTaskChildren",
  kind: "query" as const,
  query: `query databaseTaskChildren($workspaceId: String!, $databaseId: ID!, $rowId: ID!, $first: Int, $after: String) {
  workspace(id: $workspaceId) {
    id
    databaseRow(databaseId: $databaseId, rowId: $rowId, includeTrashed: true) {
      row {
        id
        databaseId
        taskChildren(first: $first, after: $after) {
          available
          fieldId
          diagnostics
          rows {
            ...DatabaseTaskSummary
          }
          totalCount
          completeCount
          archivedCount
          nextCursor
        }
      }
    }
  }
}
fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`,
};

export const databaseRowRemindersQuery = {
  id: "databaseRowRemindersQuery" as const,
  op: "databaseRowReminders",
  kind: "query" as const,
  query: `query databaseRowReminders($workspaceId: String!, $databaseId: ID!, $rowId: ID!, $fieldId: ID!) {
  workspace(id: $workspaceId) {
    databaseRowReminders(databaseId: $databaseId, rowId: $rowId, fieldId: $fieldId) {
      id
      databaseId
      rowId
      fieldId
      offsetMinutes
      triggerAt
      status
      scheduleRevision
    }
  }
}`,
};

export const databaseProgressQuery = {
  id: "databaseProgressQuery" as const,
  op: "databaseProgress",
  kind: "query" as const,
  query: `query databaseProgress($workspaceId: String!, $databaseId: ID!, $viewId: ID!) {
  workspace(id: $workspaceId) {
    databaseProgress(databaseId: $databaseId, viewId: $viewId) {
      viewId
      progressFieldId
      groupFieldId
      totalCount
      completedCount
      incompleteCount
      blockedCount
      overdueCount
      averageProgress
      groups {
        key
        label
        totalCount
        completedCount
        incompleteCount
        blockedCount
        overdueCount
        averageProgress
      }
    }
  }
}`,
};

export const databaseRowGroupsQuery = {
  id: "databaseRowGroupsQuery" as const,
  op: "databaseRowGroups",
  kind: "query" as const,
  query: `query databaseRowGroups($workspaceId: String!, $databaseId: ID!, $viewId: ID!, $search: String, $scheduleWindow: DatabaseScheduleWindowInput, $locale: String) {
  workspace(id: $workspaceId) {
    databaseRowGroups(
      databaseId: $databaseId
      viewId: $viewId
      search: $search
      scheduleWindow: $scheduleWindow
      locale: $locale
    ) {
      ...DatabaseRowGroupSummary
    }
  }
}
fragment DatabaseRowGroupSummary on DatabaseRowGroupSummary {
  key
  label
  rowCount
  groups {
    key
    label
    rowCount
    groups {
      key
      label
      rowCount
    }
  }
}`,
};

export const databaseRowTemplatesQuery = {
  id: "databaseRowTemplatesQuery" as const,
  op: "databaseRowTemplates",
  kind: "query" as const,
  query: `query databaseRowTemplates($workspaceId: String!, $databaseId: ID!) {
  workspace(id: $workspaceId) {
    databaseRowTemplates(databaseId: $databaseId) {
      ...DatabaseRowTemplateBinding
    }
  }
}
fragment DatabaseRowTemplateBinding on DatabaseRowTemplateBinding {
  rowTemplate {
    ...DatabaseRowTemplate
  }
  templateAvailable
  reconcileRequired
  detached
  disabled
  archived
}
fragment DatabaseRowTemplate on DatabaseRowTemplate {
  editRevision
  id
  workspaceId
  databaseId
  templateId
  rowKind
  name
  description
  position
  enabled
  isDefault
  initialCellValues {
    ...DatabaseRowTemplateCellValue
  }
  createdBy
  updatedBy
  createdAt
  updatedAt
}
fragment DatabaseRowTemplateCellValue on DatabaseRowTemplateCellValue {
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const databaseStarterTemplatesQuery = {
  id: "databaseStarterTemplatesQuery" as const,
  op: "databaseStarterTemplates",
  kind: "query" as const,
  query: `query databaseStarterTemplates($workspaceId: String!) {
  workspace(id: $workspaceId) {
    databaseStarterTemplates {
      ...DatabaseStarterTemplate
    }
  }
}
fragment DatabaseStarterTemplate on DatabaseStarterTemplate {
  id
  version
  digest
  defaultVariant {
    priority
    complexity
    structure
  }
  selections {
    input {
      priority
      complexity
      structure
    }
    variant {
      priority
      complexity
      structure
    }
  }
  name
  nameKey
  description
  descriptionKey
  category
  profileKind
  defaultViewKinds
  sampleRowCount
  importMappings {
    key
    nameKey
    columnMappings {
      sourceHeader
      fieldKey
      required
    }
  }
}`,
};

export const createDatabaseMutation = {
  id: "createDatabaseMutation" as const,
  op: "createDatabase",
  kind: "mutation" as const,
  query: `mutation createDatabase($input: CreateDatabaseInput!) {
  createDatabase(input: $input) {
    ...DatabaseRecord
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const createDatabaseFromTemplateMutation = {
  id: "createDatabaseFromTemplateMutation" as const,
  op: "createDatabaseFromTemplate",
  kind: "mutation" as const,
  query: `mutation createDatabaseFromTemplate($input: CreateDatabaseFromTemplateInput!) {
  createDatabaseFromTemplate(input: $input) {
    initialViewId
    ...DatabaseRecord
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const createProjectMutation = {
  id: "createProjectMutation" as const,
  op: "createProject",
  kind: "mutation" as const,
  query: `mutation createProject($input: CreateProjectInput!) {
  createProject(input: $input) {
    ...DatabaseRecord
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const updateDatabaseMutation = {
  id: "updateDatabaseMutation" as const,
  op: "updateDatabase",
  kind: "mutation" as const,
  query: `mutation updateDatabase($input: UpdateDatabaseInput!) {
  updateDatabase(input: $input) {
    ...DatabaseRecord
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const trashDatabaseMutation = {
  id: "trashDatabaseMutation" as const,
  op: "trashDatabase",
  kind: "mutation" as const,
  query: `mutation trashDatabase($input: DatabaseLifecycleInput!) {
  trashDatabase(input: $input) {
    database {
      ...Database
    }
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}`,
};

export const restoreDatabaseMutation = {
  id: "restoreDatabaseMutation" as const,
  op: "restoreDatabase",
  kind: "mutation" as const,
  query: `mutation restoreDatabase($input: DatabaseLifecycleInput!) {
  restoreDatabase(input: $input) {
    database {
      ...Database
    }
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}`,
};

export const deleteDatabasePermanentlyMutation = {
  id: "deleteDatabasePermanentlyMutation" as const,
  op: "deleteDatabasePermanently",
  kind: "mutation" as const,
  query: `mutation deleteDatabasePermanently($input: DatabaseLifecycleInput!) {
  deleteDatabasePermanently(input: $input)
}`,
};

export const createDatabaseFieldMutation = {
  id: "createDatabaseFieldMutation" as const,
  op: "createDatabaseField",
  kind: "mutation" as const,
  query: `mutation createDatabaseField($input: CreateDatabaseFieldInput!) {
  createDatabaseField(input: $input) {
    ...DatabaseField
  }
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`,
};

export const updateDatabaseFieldMutation = {
  id: "updateDatabaseFieldMutation" as const,
  op: "updateDatabaseField",
  kind: "mutation" as const,
  query: `mutation updateDatabaseField($input: UpdateDatabaseFieldInput!) {
  updateDatabaseField(input: $input) {
    ...DatabaseField
  }
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`,
};

export const deleteDatabaseFieldMutation = {
  id: "deleteDatabaseFieldMutation" as const,
  op: "deleteDatabaseField",
  kind: "mutation" as const,
  query: `mutation deleteDatabaseField($input: DeleteDatabaseFieldInput!) {
  deleteDatabaseField(input: $input)
}`,
};

export const reorderDatabaseFieldsMutation = {
  id: "reorderDatabaseFieldsMutation" as const,
  op: "reorderDatabaseFields",
  kind: "mutation" as const,
  query: `mutation reorderDatabaseFields($input: ReorderDatabaseFieldsInput!) {
  reorderDatabaseFields(input: $input) {
    ...DatabaseField
  }
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`,
};

export const createDatabaseViewMutation = {
  id: "createDatabaseViewMutation" as const,
  op: "createDatabaseView",
  kind: "mutation" as const,
  query: `mutation createDatabaseView($input: CreateDatabaseViewInput!) {
  createDatabaseView(input: $input) {
    ...DatabaseView
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`,
};

export const updateDatabaseViewMutation = {
  id: "updateDatabaseViewMutation" as const,
  op: "updateDatabaseView",
  kind: "mutation" as const,
  query: `mutation updateDatabaseView($input: UpdateDatabaseViewInput!) {
  updateDatabaseView(input: $input) {
    ...DatabaseView
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`,
};

export const upsertDatabaseViewUserStateMutation = {
  id: "upsertDatabaseViewUserStateMutation" as const,
  op: "upsertDatabaseViewUserState",
  kind: "mutation" as const,
  query: `mutation upsertDatabaseViewUserState($input: UpsertDatabaseViewUserStateInput!) {
  upsertDatabaseViewUserState(input: $input) {
    viewId
    searchText
    sort {
      ...DatabaseSortRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    fieldWidthOverrides {
      fieldId
      width
    }
    collapsedGroupKeys
    editRevision
    updatedAt
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}`,
};

export const resetDatabaseViewUserStateMutation = {
  id: "resetDatabaseViewUserStateMutation" as const,
  op: "resetDatabaseViewUserState",
  kind: "mutation" as const,
  query: `mutation resetDatabaseViewUserState($input: ResetDatabaseViewUserStateInput!) {
  resetDatabaseViewUserState(input: $input)
}`,
};

export const saveDatabaseViewUserStateMutation = {
  id: "saveDatabaseViewUserStateMutation" as const,
  op: "saveDatabaseViewUserState",
  kind: "mutation" as const,
  query: `mutation saveDatabaseViewUserState($input: SaveDatabaseViewUserStateInput!) {
  saveDatabaseViewUserState(input: $input) {
    ...DatabaseView
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`,
};

export const deleteDatabaseViewMutation = {
  id: "deleteDatabaseViewMutation" as const,
  op: "deleteDatabaseView",
  kind: "mutation" as const,
  query: `mutation deleteDatabaseView($input: DeleteDatabaseViewInput!) {
  deleteDatabaseView(input: $input)
}`,
};

export const reorderDatabaseViewsMutation = {
  id: "reorderDatabaseViewsMutation" as const,
  op: "reorderDatabaseViews",
  kind: "mutation" as const,
  query: `mutation reorderDatabaseViews($input: ReorderDatabaseViewsInput!) {
  reorderDatabaseViews(input: $input) {
    ...DatabaseView
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}`,
};

export const createDatabaseRowMutation = {
  id: "createDatabaseRowMutation" as const,
  op: "createDatabaseRow",
  kind: "mutation" as const,
  query: `mutation createDatabaseRow($input: CreateDatabaseRowInput!) {
  createDatabaseRow(input: $input) {
    ...DatabaseRowRecord
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const createDatabaseRowContentDocumentMutation = {
  id: "createDatabaseRowContentDocumentMutation" as const,
  op: "createDatabaseRowContentDocument",
  kind: "mutation" as const,
  query: `mutation createDatabaseRowContentDocument($input: CreateDatabaseRowContentDocumentInput!) {
  createDatabaseRowContentDocument(input: $input) {
    ...DatabaseRowRecord
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const attachDatabaseRowContentDocumentMutation = {
  id: "attachDatabaseRowContentDocumentMutation" as const,
  op: "attachDatabaseRowContentDocument",
  kind: "mutation" as const,
  query: `mutation attachDatabaseRowContentDocument($input: AttachDatabaseRowContentDocumentInput!) {
  attachDatabaseRowContentDocument(input: $input) {
    ...DatabaseRowRecord
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const detachDatabaseRowContentDocumentMutation = {
  id: "detachDatabaseRowContentDocumentMutation" as const,
  op: "detachDatabaseRowContentDocument",
  kind: "mutation" as const,
  query: `mutation detachDatabaseRowContentDocument($input: DetachDatabaseRowContentDocumentInput!) {
  detachDatabaseRowContentDocument(input: $input) {
    ...DatabaseRowRecord
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const createDatabaseRowTemplateMutation = {
  id: "createDatabaseRowTemplateMutation" as const,
  op: "createDatabaseRowTemplate",
  kind: "mutation" as const,
  query: `mutation createDatabaseRowTemplate($input: CreateDatabaseRowTemplateInput!) {
  createDatabaseRowTemplate(input: $input) {
    ...DatabaseRowTemplateBinding
  }
}
fragment DatabaseRowTemplateBinding on DatabaseRowTemplateBinding {
  rowTemplate {
    ...DatabaseRowTemplate
  }
  templateAvailable
  reconcileRequired
  detached
  disabled
  archived
}
fragment DatabaseRowTemplate on DatabaseRowTemplate {
  editRevision
  id
  workspaceId
  databaseId
  templateId
  rowKind
  name
  description
  position
  enabled
  isDefault
  initialCellValues {
    ...DatabaseRowTemplateCellValue
  }
  createdBy
  updatedBy
  createdAt
  updatedAt
}
fragment DatabaseRowTemplateCellValue on DatabaseRowTemplateCellValue {
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const updateDatabaseRowTemplateMutation = {
  id: "updateDatabaseRowTemplateMutation" as const,
  op: "updateDatabaseRowTemplate",
  kind: "mutation" as const,
  query: `mutation updateDatabaseRowTemplate($input: UpdateDatabaseRowTemplateInput!) {
  updateDatabaseRowTemplate(input: $input) {
    ...DatabaseRowTemplateBinding
  }
}
fragment DatabaseRowTemplateBinding on DatabaseRowTemplateBinding {
  rowTemplate {
    ...DatabaseRowTemplate
  }
  templateAvailable
  reconcileRequired
  detached
  disabled
  archived
}
fragment DatabaseRowTemplate on DatabaseRowTemplate {
  editRevision
  id
  workspaceId
  databaseId
  templateId
  rowKind
  name
  description
  position
  enabled
  isDefault
  initialCellValues {
    ...DatabaseRowTemplateCellValue
  }
  createdBy
  updatedBy
  createdAt
  updatedAt
}
fragment DatabaseRowTemplateCellValue on DatabaseRowTemplateCellValue {
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const deleteDatabaseRowTemplateMutation = {
  id: "deleteDatabaseRowTemplateMutation" as const,
  op: "deleteDatabaseRowTemplate",
  kind: "mutation" as const,
  query: `mutation deleteDatabaseRowTemplate($input: DeleteDatabaseRowTemplateInput!) {
  deleteDatabaseRowTemplate(input: $input)
}`,
};

export const createDatabaseRowFromTemplateMutation = {
  id: "createDatabaseRowFromTemplateMutation" as const,
  op: "createDatabaseRowFromTemplate",
  kind: "mutation" as const,
  query: `mutation createDatabaseRowFromTemplate($input: CreateDatabaseRowFromTemplateInput!) {
  createDatabaseRowFromTemplate(input: $input) {
    ...DatabaseRowRecord
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const updateDatabaseRowTitleMutation = {
  id: "updateDatabaseRowTitleMutation" as const,
  op: "updateDatabaseRowTitle",
  kind: "mutation" as const,
  query: `mutation updateDatabaseRowTitle($input: UpdateDatabaseRowTitleInput!) {
  updateDatabaseRowTitle(input: $input) {
    ...DatabaseCellValue
  }
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const updateDatabaseRowPositionMutation = {
  id: "updateDatabaseRowPositionMutation" as const,
  op: "updateDatabaseRowPosition",
  kind: "mutation" as const,
  query: `mutation updateDatabaseRowPosition($input: UpdateDatabaseRowPositionInput!) {
  updateDatabaseRowPosition(input: $input) {
    ...DatabaseRowRecord
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const updateDatabaseCellValueMutation = {
  id: "updateDatabaseCellValueMutation" as const,
  op: "updateDatabaseCellValue",
  kind: "mutation" as const,
  query: `mutation updateDatabaseCellValue($input: UpdateDatabaseCellValueInput!) {
  updateDatabaseCellValue(input: $input) {
    ...DatabaseCellValue
  }
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const clearDatabaseCellValueMutation = {
  id: "clearDatabaseCellValueMutation" as const,
  op: "clearDatabaseCellValue",
  kind: "mutation" as const,
  query: `mutation clearDatabaseCellValue($input: ClearDatabaseCellValueInput!) {
  clearDatabaseCellValue(input: $input) {
    rowId
    fieldId
    editRevision
    hasValue
  }
}`,
};

export const deleteDatabaseRowMutation = {
  id: "deleteDatabaseRowMutation" as const,
  op: "deleteDatabaseRow",
  kind: "mutation" as const,
  query: `mutation deleteDatabaseRow($input: DeleteDatabaseRowInput!) {
  deleteDatabaseRow(input: $input)
}`,
};

export const setDatabaseRowReminderMutation = {
  id: "setDatabaseRowReminderMutation" as const,
  op: "setDatabaseRowReminder",
  kind: "mutation" as const,
  query: `mutation setDatabaseRowReminder($input: SetDatabaseRowReminderInput!) {
  setDatabaseRowReminder(input: $input) {
    id
    databaseId
    rowId
    fieldId
    offsetMinutes
    triggerAt
    status
    scheduleRevision
  }
}`,
};

export const deleteDatabaseRowReminderMutation = {
  id: "deleteDatabaseRowReminderMutation" as const,
  op: "deleteDatabaseRowReminder",
  kind: "mutation" as const,
  query: `mutation deleteDatabaseRowReminder($input: DeleteDatabaseRowReminderInput!) {
  deleteDatabaseRowReminder(input: $input)
}`,
};

export const bulkSetDatabaseCellValueMutation = {
  id: "bulkSetDatabaseCellValueMutation" as const,
  op: "bulkSetDatabaseCellValue",
  kind: "mutation" as const,
  query: `mutation bulkSetDatabaseCellValue($input: BulkSetDatabaseCellValueInput!) {
  bulkSetDatabaseCellValue(input: $input) {
    ...DatabaseBulkOperationResult
  }
}
fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`,
};

export const bulkClearDatabaseCellValueMutation = {
  id: "bulkClearDatabaseCellValueMutation" as const,
  op: "bulkClearDatabaseCellValue",
  kind: "mutation" as const,
  query: `mutation bulkClearDatabaseCellValue($input: BulkClearDatabaseCellValueInput!) {
  bulkClearDatabaseCellValue(input: $input) {
    ...DatabaseBulkOperationResult
  }
}
fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`,
};

export const bulkApplyDatabaseCellPatchesMutation = {
  id: "bulkApplyDatabaseCellPatchesMutation" as const,
  op: "bulkApplyDatabaseCellPatches",
  kind: "mutation" as const,
  query: `mutation bulkApplyDatabaseCellPatches($input: BulkApplyDatabaseCellPatchesInput!) {
  bulkApplyDatabaseCellPatches(input: $input) {
    ...DatabaseBulkOperationResult
  }
}
fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`,
};

export const bulkDeleteDatabaseRowsMutation = {
  id: "bulkDeleteDatabaseRowsMutation" as const,
  op: "bulkDeleteDatabaseRows",
  kind: "mutation" as const,
  query: `mutation bulkDeleteDatabaseRows($input: BulkDeleteDatabaseRowsInput!) {
  bulkDeleteDatabaseRows(input: $input) {
    ...DatabaseBulkOperationResult
  }
}
fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`,
};

export const bulkRestoreDatabaseRowsMutation = {
  id: "bulkRestoreDatabaseRowsMutation" as const,
  op: "bulkRestoreDatabaseRows",
  kind: "mutation" as const,
  query: `mutation bulkRestoreDatabaseRows($input: BulkRestoreDatabaseRowsInput!) {
  bulkRestoreDatabaseRows(input: $input) {
    ...DatabaseBulkOperationResult
  }
}
fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`,
};

export const bulkUpdateDatabaseRowPositionsMutation = {
  id: "bulkUpdateDatabaseRowPositionsMutation" as const,
  op: "bulkUpdateDatabaseRowPositions",
  kind: "mutation" as const,
  query: `mutation bulkUpdateDatabaseRowPositions($input: BulkUpdateDatabaseRowPositionsInput!) {
  bulkUpdateDatabaseRowPositions(input: $input) {
    ...DatabaseBulkOperationResult
  }
}
fragment DatabaseBulkOperationResult on DatabaseBulkOperationResult {
  succeeded
  failed {
    ...DatabaseBulkRowOutcome
  }
  total
  successCount
  failureCount
  transactionCommitted
}
fragment DatabaseBulkRowOutcome on DatabaseBulkRowOutcome {
  rowId
  success
  errorCode
  errorMessage
}`,
};

export const previewDatabaseCsvImportMutation = {
  id: "previewDatabaseCsvImportMutation" as const,
  op: "previewDatabaseCsvImport",
  kind: "mutation" as const,
  query: `mutation previewDatabaseCsvImport($file: Upload!, $input: PreviewDatabaseCsvImportInput!) {
  previewDatabaseCsvImport(file: $file, input: $input) {
    detectedDelimiter
    detectedDialect {
      delimiter
      customDelimiter
      quote
      escape
      doubleQuote
    }
    appliedDialect {
      delimiter
      customDelimiter
      quote
      escape
      doubleQuote
    }
    confidence
    detectedColumns {
      index
      sourceHeader
      fieldName
      fieldType
      isTitle
    }
    appliedMapping {
      sourceIndex
      importColumn
      sourceHeader
      fieldName
      fieldType
      isTitle
    }
    inferredFields {
      ...DatabaseField
    }
    rowCount
    errors {
      ...DatabaseCsvDiagnostic
    }
    warnings {
      ...DatabaseCsvDiagnostic
    }
    workspaceTagDiagnostics {
      ...DatabaseWorkspaceTagImportDiagnostic
    }
  }
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseCsvDiagnostic on DatabaseCsvDiagnostic {
  code
  source
  row
  field
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
  file: true,
};

export const importDatabaseCsvMutation = {
  id: "importDatabaseCsvMutation" as const,
  op: "importDatabaseCsv",
  kind: "mutation" as const,
  query: `mutation importDatabaseCsv($file: Upload!, $input: ImportDatabaseCsvInput!) {
  importDatabaseCsv(file: $file, input: $input) {
    database {
      ...DatabaseRecord
    }
    createdFieldCount
    createdRowCount
    createdDocCount
    skippedRowCount
    errors {
      ...DatabaseCsvDiagnostic
    }
    warnings {
      ...DatabaseCsvDiagnostic
    }
    workspaceTagDiagnostics {
      ...DatabaseWorkspaceTagImportDiagnostic
    }
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment DatabaseCsvDiagnostic on DatabaseCsvDiagnostic {
  code
  source
  row
  field
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
  file: true,
};

export const previewDatabaseJsonImportMutation = {
  id: "previewDatabaseJsonImportMutation" as const,
  op: "previewDatabaseJsonImport",
  kind: "mutation" as const,
  query: `mutation previewDatabaseJsonImport($file: Upload!, $input: PreviewDatabaseJsonImportInput!) {
  previewDatabaseJsonImport(file: $file, input: $input) {
    schemaVersion
    title
    fieldCount
    viewCount
    rowCount
    templateCount
    errors {
      ...DatabaseJsonDiagnostic
    }
    warnings {
      ...DatabaseJsonDiagnostic
    }
    workspaceTagDiagnostics {
      ...DatabaseWorkspaceTagImportDiagnostic
    }
  }
}
fragment DatabaseJsonDiagnostic on DatabaseJsonDiagnostic {
  code
  source
  path
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
  file: true,
};

export const importDatabaseJsonMutation = {
  id: "importDatabaseJsonMutation" as const,
  op: "importDatabaseJson",
  kind: "mutation" as const,
  query: `mutation importDatabaseJson($file: Upload!, $input: ImportDatabaseJsonInput!) {
  importDatabaseJson(file: $file, input: $input) {
    database {
      ...DatabaseRecord
    }
    createdFieldCount
    createdViewCount
    createdRowCount
    createdTemplateCount
    warnings {
      ...DatabaseJsonDiagnostic
    }
    workspaceTagDiagnostics {
      ...DatabaseWorkspaceTagImportDiagnostic
    }
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment DatabaseJsonDiagnostic on DatabaseJsonDiagnostic {
  code
  source
  path
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
  file: true,
};

export const previewDatabaseNotionImportMutation = {
  id: "previewDatabaseNotionImportMutation" as const,
  op: "previewDatabaseNotionImport",
  kind: "mutation" as const,
  query: `mutation previewDatabaseNotionImport($file: Upload!, $input: PreviewDatabaseJsonImportInput!) {
  previewDatabaseNotionImport(file: $file, input: $input) {
    schemaVersion
    title
    fieldCount
    viewCount
    rowCount
    templateCount
    matchedPageCount
    contentDocumentCount
    emptyPageCount
    bodyBlockCount
    rewrittenInternalLinkCount
    errors {
      ...DatabaseJsonDiagnostic
    }
    warnings {
      ...DatabaseJsonDiagnostic
    }
    workspaceTagDiagnostics {
      ...DatabaseWorkspaceTagImportDiagnostic
    }
  }
}
fragment DatabaseJsonDiagnostic on DatabaseJsonDiagnostic {
  code
  source
  path
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
  file: true,
};

export const importDatabaseNotionMutation = {
  id: "importDatabaseNotionMutation" as const,
  op: "importDatabaseNotion",
  kind: "mutation" as const,
  query: `mutation importDatabaseNotion($file: Upload!, $input: ImportDatabaseJsonInput!) {
  importDatabaseNotion(file: $file, input: $input) {
    database {
      ...DatabaseRecord
    }
    createdFieldCount
    createdViewCount
    createdRowCount
    createdTemplateCount
    warnings {
      ...DatabaseJsonDiagnostic
    }
    workspaceTagDiagnostics {
      ...DatabaseWorkspaceTagImportDiagnostic
    }
  }
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment DatabaseJsonDiagnostic on DatabaseJsonDiagnostic {
  code
  source
  path
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
  file: true,
};

export const databaseCsvExportQuery = {
  id: "databaseCsvExportQuery" as const,
  op: "databaseCsvExport",
  kind: "query" as const,
  query: `query databaseCsvExport($workspaceId: String!, $databaseId: ID!, $options: DatabaseCsvExportOptionsInput) {
  workspace(id: $workspaceId) {
    databaseCsvExport(databaseId: $databaseId, options: $options) {
      fileName
      contentType
      content
      rowCount
      columnCount
      databaseId
      viewId
      target
      warnings {
        ...DatabaseCsvDiagnostic
      }
      workspaceTagDiagnostics {
        ...DatabaseWorkspaceTagImportDiagnostic
      }
    }
  }
}
fragment DatabaseCsvDiagnostic on DatabaseCsvDiagnostic {
  code
  source
  row
  field
  message
}
fragment DatabaseWorkspaceTagImportDiagnostic on DatabaseWorkspaceTagImportDiagnostic {
  sourceId
  targetId
  name
  slug
  sourceColor
  colorRole
  action
  affectedRows
  affectedFields
  message
}`,
};

export const databaseJsonExportQuery = {
  id: "databaseJsonExportQuery" as const,
  op: "databaseJsonExport",
  kind: "query" as const,
  query: `query databaseJsonExport($workspaceId: String!, $databaseId: ID!) {
  workspace(id: $workspaceId) {
    databaseJsonExport(databaseId: $databaseId) {
      fileName
      contentType
      content
    }
  }
}`,
};

export const databaseAutomationsQuery = {
  id: "databaseAutomationsQuery" as const,
  op: "databaseAutomations",
  kind: "query" as const,
  query: `query databaseAutomations($workspaceId: String!, $first: Int, $offset: Int) {
  workspace(id: $workspaceId) {
    automations(first: $first, offset: $offset) {
      ...WorkspaceAutomation
    }
    automationRuns(includeDeadLetter: true, first: 50, offset: 0) {
      ...WorkspaceAutomationRun
    }
  }
}
fragment WorkspaceAutomation on WorkspaceAutomationType {
  id
  workspaceId
  name
  description
  status
  trigger {
    ...WorkspaceAutomationTrigger
  }
  actions {
    ...WorkspaceAutomationAction
  }
  createdAt
  updatedAt
}
fragment WorkspaceAutomationTrigger on WorkspaceAutomationTriggerType {
  triggerType
  databaseId
  fieldId
  selectOptionId
}
fragment WorkspaceAutomationAction on WorkspaceAutomationActionType {
  position
  actionType
  config
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}`,
};

export const databaseActivityQuery = {
  id: "databaseActivityQuery" as const,
  op: "databaseActivity",
  kind: "query" as const,
  query: `query databaseActivity($workspaceId: String!, $databaseId: ID!, $skip: Int, $take: Int) {
  workspace(id: $workspaceId) {
    databaseActivity(filter: {databaseId: $databaseId}, skip: $skip, take: $take) {
      ...DatabaseActivityEvent
    }
  }
}
fragment DatabaseActivityEvent on DatabaseActivityEvent {
  id
  workspaceId
  databaseId
  rowId
  eventType
  actorUserId
  actorDisplayName
  payload
  createdAt
}`,
};

export const databaseRowActivityQuery = {
  id: "databaseRowActivityQuery" as const,
  op: "databaseRowActivity",
  kind: "query" as const,
  query: `query databaseRowActivity($workspaceId: String!, $rowId: ID!, $skip: Int, $take: Int) {
  workspace(id: $workspaceId) {
    databaseRowActivity(rowId: $rowId, skip: $skip, take: $take) {
      ...DatabaseActivityEvent
    }
  }
}
fragment DatabaseActivityEvent on DatabaseActivityEvent {
  id
  workspaceId
  databaseId
  rowId
  eventType
  actorUserId
  actorDisplayName
  payload
  createdAt
}`,
};

export const createWorkspaceAutomationMutation = {
  id: "createWorkspaceAutomationMutation" as const,
  op: "createWorkspaceAutomation",
  kind: "mutation" as const,
  query: `mutation createWorkspaceAutomation($input: CreateWorkspaceAutomationInput!) {
  createWorkspaceAutomation(input: $input) {
    ...WorkspaceAutomation
  }
}
fragment WorkspaceAutomation on WorkspaceAutomationType {
  id
  workspaceId
  name
  description
  status
  trigger {
    ...WorkspaceAutomationTrigger
  }
  actions {
    ...WorkspaceAutomationAction
  }
  createdAt
  updatedAt
}
fragment WorkspaceAutomationTrigger on WorkspaceAutomationTriggerType {
  triggerType
  databaseId
  fieldId
  selectOptionId
}
fragment WorkspaceAutomationAction on WorkspaceAutomationActionType {
  position
  actionType
  config
}`,
};

export const disableWorkspaceAutomationMutation = {
  id: "disableWorkspaceAutomationMutation" as const,
  op: "disableWorkspaceAutomation",
  kind: "mutation" as const,
  query: `mutation disableWorkspaceAutomation($input: DisableWorkspaceAutomationInput!) {
  disableWorkspaceAutomation(input: $input) {
    ...WorkspaceAutomation
  }
}
fragment WorkspaceAutomation on WorkspaceAutomationType {
  id
  workspaceId
  name
  description
  status
  trigger {
    ...WorkspaceAutomationTrigger
  }
  actions {
    ...WorkspaceAutomationAction
  }
  createdAt
  updatedAt
}
fragment WorkspaceAutomationTrigger on WorkspaceAutomationTriggerType {
  triggerType
  databaseId
  fieldId
  selectOptionId
}
fragment WorkspaceAutomationAction on WorkspaceAutomationActionType {
  position
  actionType
  config
}`,
};

export const previewLegacyDatabaseMigrationQuery = {
  id: "previewLegacyDatabaseMigrationQuery" as const,
  op: "previewLegacyDatabaseMigration",
  kind: "query" as const,
  query: `query previewLegacyDatabaseMigration($input: LegacyDatabaseMigrationInput!) {
  previewLegacyDatabaseMigration(input: $input) {
    ...LegacyDatabaseMigrationPlan
  }
}
fragment LegacyDatabaseMigrationPlan on LegacyDatabaseMigrationPlanObjectType {
  databaseIds
  blockReferences {
    sourceDocumentId
    blockId
    targetDatabaseId
    targetViewId
    alreadyMigrated
  }
  fieldCount
  rowCount
  cellCount
  viewCount
  diagnostics {
    code
    severity
    message
    context
  }
  applyAllowed
}`,
};

export const applyLegacyDatabaseMigrationMutation = {
  id: "applyLegacyDatabaseMigrationMutation" as const,
  op: "applyLegacyDatabaseMigration",
  kind: "mutation" as const,
  query: `mutation applyLegacyDatabaseMigration($input: LegacyDatabaseMigrationInput!) {
  applyLegacyDatabaseMigration(input: $input) {
    plan {
      ...LegacyDatabaseMigrationPlan
    }
    createdDatabaseIds
    migratedBlockCount
  }
}
fragment LegacyDatabaseMigrationPlan on LegacyDatabaseMigrationPlanObjectType {
  databaseIds
  blockReferences {
    sourceDocumentId
    blockId
    targetDatabaseId
    targetViewId
    alreadyMigrated
  }
  fieldCount
  rowCount
  cellCount
  viewCount
  diagnostics {
    code
    severity
    message
    context
  }
  applyAllowed
}`,
};

export const databaseTasksQuery = {
  id: "databaseTasksQuery" as const,
  op: "databaseTasks",
  kind: "query" as const,
  query: `query databaseTasks($workspaceId: String!, $input: DatabaseTasksInput!, $first: Int, $after: String) {
  workspace(id: $workspaceId) {
    id
    databaseTasks(input: $input, first: $first, after: $after) {
      statusOptions {
        ...DatabaseStatusOption
      }
      coverageComplete
      unavailableProjects {
        databaseId
        title
        reasonCode
      }
      rows {
        ...DatabaseTaskSummary
        blockers {
          available
          activeCount
          unresolvedCount
          diagnostics
        }
      }
      totalCount
      projectCount
      nextCursor
    }
  }
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`,
};

export const createDatabaseTaskFromSourceMutation = {
  id: "createDatabaseTaskFromSourceMutation" as const,
  op: "createDatabaseTaskFromSource",
  kind: "mutation" as const,
  query: `mutation createDatabaseTaskFromSource($input: CreateDatabaseTaskFromSourceInput!) {
  createDatabaseTaskFromSource(input: $input) {
    ...DatabaseTaskCaptureResult
  }
}
fragment DatabaseTaskCaptureResult on DatabaseTaskCaptureResult {
  requestId
  databaseId
  rowId
  editRevision
  state
  replayed
  record {
    ...DatabaseRowRecord
  }
  source {
    ...DatabaseTaskSource
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseTaskSource on DatabaseTaskSource {
  sourceWorkspaceId
  documentId
  externalId
  blockId
  selectionAnchor
  state
  title
}`,
};

export const databaseTaskCaptureReceiptQuery = {
  id: "databaseTaskCaptureReceiptQuery" as const,
  op: "databaseTaskCaptureReceipt",
  kind: "query" as const,
  query: `query databaseTaskCaptureReceipt($workspaceId: String!, $requestId: ID!) {
  workspace(id: $workspaceId) {
    id
    databaseTaskCaptureReceipt(requestId: $requestId) {
      ...DatabaseTaskCaptureResult
    }
  }
}
fragment DatabaseTaskCaptureResult on DatabaseTaskCaptureResult {
  requestId
  databaseId
  rowId
  editRevision
  state
  replayed
  record {
    ...DatabaseRowRecord
  }
  source {
    ...DatabaseTaskSource
  }
}
fragment DatabaseRowRecord on DatabaseRowRecord {
  row {
    ...DatabaseRow
  }
  cells {
    ...DatabaseCellValue
  }
  cellRevisions {
    rowId
    fieldId
    editRevision
    hasValue
  }
  redacted
  groupKeys
}
fragment DatabaseRow on DatabaseRowType {
  id
  databaseId
  contentDocument {
    documentId
    externalId
    workspaceId
    state
    title
  }
  rowKind
  title
  position
  createdBy
  updatedBy
  editRevision
  createdAt
  updatedAt
  deletedAt
}
fragment DatabaseCellValue on DatabaseCellValueType {
  rowId
  fieldId
  fieldType
  value {
    ...DatabaseCellValueData
  }
  updatedBy
  editRevision
  updatedAt
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseTaskSource on DatabaseTaskSource {
  sourceWorkspaceId
  documentId
  externalId
  blockId
  selectionAnchor
  state
  title
}`,
};

export const databaseRowSourceQuery = {
  id: "databaseRowSourceQuery" as const,
  op: "databaseRowSource",
  kind: "query" as const,
  query: `query databaseRowSource($workspaceId: String!, $databaseId: ID!, $rowId: ID!) {
  workspace(id: $workspaceId) {
    id
    databaseRow(databaseId: $databaseId, rowId: $rowId, includeTrashed: true) {
      row {
        id
        source {
          ...DatabaseTaskSource
        }
      }
    }
  }
}
fragment DatabaseTaskSource on DatabaseTaskSource {
  sourceWorkspaceId
  documentId
  externalId
  blockId
  selectionAnchor
  state
  title
}`,
};

export const databaseTaskReferencesQuery = {
  id: "databaseTaskReferencesQuery" as const,
  op: "databaseTaskReferences",
  kind: "query" as const,
  query: `query databaseTaskReferences($workspaceId: String!, $targets: [DatabaseTaskReferenceInput!]!) {
  workspace(id: $workspaceId) {
    id
    databaseTaskReferences(targets: $targets) {
      ...DatabaseTaskReference
    }
  }
}
fragment DatabaseTaskReference on DatabaseTaskReference {
  workspaceId
  databaseId
  rowId
  state
  task {
    ...DatabaseTaskSummary
  }
}
fragment DatabaseTaskSummary on DatabaseTaskSummary {
  workspaceId
  databaseId
  rowId
  projectTitle
  title
  descriptionPreview
  editRevision
  updatedAt
  deletedAt
  status {
    ...DatabaseStatusOption
  }
  assignees {
    id
    name
  }
  due {
    start
    end
    allDay
    timeZone
  }
  priority {
    ...DatabaseSelectOption
  }
  canEdit
  hasAssignees
  hasDue
  hasPriority
  isSubtask
  hasDependencies
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}`,
};

export const databaseRowTemplateBodyInputsQuery = {
  id: "databaseRowTemplateBodyInputsQuery" as const,
  op: "databaseRowTemplateBodyInputs",
  kind: "query" as const,
  query: `query databaseRowTemplateBodyInputs($workspaceId: String!, $databaseId: ID!, $rowTemplateId: ID!) {
  workspace(id: $workspaceId) {
    id
    databaseRowTemplateBodyInputs(
      databaseId: $databaseId
      rowTemplateId: $rowTemplateId
    ) {
      requiredInputs
      sourceRevision
    }
  }
}`,
};

export const assistantDocumentSourceQuery = {
  id: "assistantDocumentSourceQuery" as const,
  op: "assistantDocumentSource",
  kind: "query" as const,
  query: `query assistantDocumentSource($workspaceId: String!, $input: AssistantDocumentSourceInput!) {
  workspace(id: $workspaceId) {
    id
    assistantDocumentSource(input: $input) {
      ...TemplateSuggestionItemFields
    }
  }
}
fragment TemplateSuggestionItemFields on TemplateSuggestionItem {
  templateId
  templateDocId
  slug
  title
  description
  source
  updatedAt
  category
  titlePolicy
  sourceRevisionId
  tags
  score
  reasons
  instanceState
  available
  protectedSource
}`,
};

export const assistantPackagesQuery = {
  id: "assistantPackagesQuery" as const,
  op: "assistantPackages",
  kind: "query" as const,
  query: `query assistantPackages($workspaceId: String!, $context: AssistantContext!) {
  workspace(id: $workspaceId) {
    id
    assistantPackages(context: $context) {
      ...AssistantPackageFragment
    }
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const assistantPresentationQuery = {
  id: "assistantPresentationQuery" as const,
  op: "assistantPresentation",
  kind: "query" as const,
  query: `query assistantPresentation($workspaceId: String!, $context: AssistantContext!, $databaseId: ID, $rowId: ID) {
  workspace(id: $workspaceId) {
    id
    assistantPresentation(context: $context, databaseId: $databaseId, rowId: $rowId) {
      descriptor {
        ...AssistantPackageFragment
      }
      databaseId
      rowId
      unavailableReason
      managedSchema {
        readiness
        reasonCode
        templateId
        templateVersion
        templateDigest
        schemaRevision
        canEditStructure
        canEditMetadata
        canManageLifecycle
        variant {
          priority
          complexity
          structure
          currency
        }
        taskBindings {
          roleKey
          fieldId
        }
      }
      fields {
        ...AssistantResolvedFieldFragment
      }
    }
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment AssistantResolvedFieldFragment on AssistantResolvedField {
  binding {
    kind
    roleKey
    fieldKey
  }
  fieldId
  name
  fieldType
  required
  config {
    ...DatabaseFieldConfig
  }
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}`,
};

export const prepareProjectAssistantQuery = {
  id: "prepareProjectAssistantQuery" as const,
  op: "prepareProjectAssistant",
  kind: "query" as const,
  query: `query prepareProjectAssistant($workspaceId: String!, $input: PrepareProjectAssistantInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareProjectAssistant(input: $input) {
      ...PreparedProjectAssistantFragment
    }
  }
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}`,
};

export const projectSetupQuery = {
  id: "projectSetupQuery" as const,
  op: "projectSetup",
  kind: "query" as const,
  query: `query projectSetup($workspaceId: String!, $requestId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    projectSetup(requestId: $requestId) {
      ...ProjectSetupFragment
    }
  }
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const stopProjectSetupMutation = {
  id: "stopProjectSetupMutation" as const,
  op: "stopProjectSetup",
  kind: "mutation" as const,
  query: `mutation stopProjectSetup($input: StopProjectSetupInput!) {
  stopProjectSetup(input: $input) {
    ...ProjectSetupFragment
  }
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}`,
};

export const deleteAccountMutation = {
  id: "deleteAccountMutation" as const,
  op: "deleteAccount",
  kind: "mutation" as const,
  query: `mutation deleteAccount {
  deleteAccount {
    success
  }
}`,
};

export const deleteDocumentPermanentlyMutation = {
  id: "deleteDocumentPermanentlyMutation" as const,
  op: "deleteDocumentPermanently",
  kind: "mutation" as const,
  query: `mutation deleteDocumentPermanently($input: DeleteDocumentPermanentlyInput!) {
  deleteDocumentPermanently(input: $input) {
    requested
    deleted
    notFound
    forbidden
    alreadyDeleted
    notTrashed
    failed
    rootMetaRemoved
    documents {
      clientDocId
      resolvedDocId
      title
      status
      reason
    }
  }
}`,
};

export const deleteDocumentsPermanentlyMutation = {
  id: "deleteDocumentsPermanentlyMutation" as const,
  op: "deleteDocumentsPermanently",
  kind: "mutation" as const,
  query: `mutation deleteDocumentsPermanently($input: DeleteDocumentsPermanentlyInput!) {
  deleteDocumentsPermanently(input: $input) {
    requested
    deleted
    notFound
    forbidden
    alreadyDeleted
    notTrashed
    failed
    rootMetaRemoved
    documents {
      clientDocId
      resolvedDocId
      title
      status
      reason
    }
  }
}`,
};

export const deleteWorkspaceMutation = {
  id: "deleteWorkspaceMutation" as const,
  op: "deleteWorkspace",
  kind: "mutation" as const,
  query: `mutation deleteWorkspace($id: String!) {
  deleteWorkspace(id: $id)
}`,
};

export const getDocRolePermissionsQuery = {
  id: "getDocRolePermissionsQuery" as const,
  op: "getDocRolePermissions",
  kind: "query" as const,
  query: `query getDocRolePermissions($workspaceId: String!, $docId: String!) {
  workspace(id: $workspaceId) {
    doc(docId: $docId) {
      permissions {
        Doc_Copy
        Doc_Delete
        Doc_Duplicate
        Doc_Properties_Read
        Doc_Properties_Update
        Doc_Publish
        Doc_Read
        Doc_Restore
        Doc_TransferOwner
        Doc_Trash
        Doc_Update
        Doc_Users_Manage
        Doc_Users_Read
        Doc_Comments_Create
        Doc_Comments_Delete
        Doc_Comments_Read
        Doc_Comments_Resolve
      }
    }
  }
}`,
};

export const documentFieldCatalogQuery = {
  id: "documentFieldCatalogQuery" as const,
  op: "documentFieldCatalog",
  kind: "query" as const,
  query: `query documentFieldCatalog {
  documentFieldCatalog {
    metadata {
      key
      formats
    }
    inputKinds {
      kind
      multiple
      hasOptions
    }
    maxOptions
    maxStringBytes
    maxIdBytes
  }
}`,
};

export const documentFieldOutputQuery = {
  id: "documentFieldOutputQuery" as const,
  op: "documentFieldOutput",
  kind: "query" as const,
  query: `query documentFieldOutput($workspaceId: ID!, $docId: ID!, $fields: JSON!) {
  documentFieldOutput(workspaceId: $workspaceId, docId: $docId, fields: $fields)
}`,
};

export const documentFieldPresentationsQuery = {
  id: "documentFieldPresentationsQuery" as const,
  op: "documentFieldPresentations",
  kind: "query" as const,
  query: `query documentFieldPresentations($workspaceId: ID!, $docId: ID!, $fields: JSON!) {
  documentFieldPresentations(
    workspaceId: $workspaceId
    docId: $docId
    fields: $fields
  ) {
    state
    text
    complete
  }
}`,
};

export const documentGraphQuery = {
  id: "documentGraphQuery" as const,
  op: "documentGraph",
  kind: "query" as const,
  query: `query documentGraph($workspaceId: String!, $input: DocumentGraphInput!) {
  workspace(id: $workspaceId) {
    id
    documentGraph(input: $input) {
      nodes {
        ...DocumentGraphNodeFields
      }
      edges {
        ...DocumentGraphEdgeFields
      }
      databaseReferences {
        ...DatabaseDocumentReferenceFields
      }
      indexStatus {
        ...DocumentGraphIndexStatusFields
      }
    }
  }
}
fragment DocumentGraphNodeFields on DocumentGraphNodeType {
  workspaceId
  docId
  rawDocId
  title
  documentType
  status
  classification
  deleted
  redacted
}
fragment DocumentGraphEdgeFields on DocumentGraphEdgeType {
  sourceDocId
  targetDocId
  rawTargetDocId
  targetWorkspaceId
  targetState
  linkKind
  occurrenceCount
  firstOccurrencePreview
  staleState
  occurrences {
    ...DocumentGraphOccurrenceFields
  }
}
fragment DocumentGraphOccurrenceFields on DocumentGraphOccurrenceType {
  id
  sourceDocId
  sourceBlockId
  sourceParentBlockId
  sourceParentFlavour
  rawTargetDocId
  targetWorkspaceId
  targetDocId
  linkKind
  paramsJson
  markdownPreview
  targetState
  extractedAt
  sourceUpdatedAt
}
fragment DatabaseDocumentReferenceFields on DatabaseDocumentReferenceType {
  databaseId
  databaseTitle
  rowId
  rowTitle
  fieldId
  fieldName
  referenceKind
  rawTargetDocId
  targetDocId
  targetWorkspaceId
  refreshedAt
}
fragment DocumentGraphIndexStatusFields on DocumentGraphIndexStatusType {
  staleState
  indexedAt
  queuedAt
  startedAt
  failedAt
  errorCode
  errorMessage
  attemptCount
  occurrenceCount
  currentCount
  staleCount
  queuedCount
  extractingCount
  failedCount
  deletedCount
  missingStateCount
}`,
};

export const documentLinksQuery = {
  id: "documentLinksQuery" as const,
  op: "documentLinks",
  kind: "query" as const,
  query: `query documentLinks($workspaceId: String!, $input: DocumentLinksInput!) {
  workspace(id: $workspaceId) {
    id
    documentLinks(input: $input) {
      nodes {
        ...DocumentGraphNodeFields
      }
      edges {
        ...DocumentGraphEdgeFields
      }
      databaseReferences {
        ...DatabaseDocumentReferenceFields
      }
      indexStatus {
        ...DocumentGraphIndexStatusFields
      }
    }
  }
}
fragment DocumentGraphNodeFields on DocumentGraphNodeType {
  workspaceId
  docId
  rawDocId
  title
  documentType
  status
  classification
  deleted
  redacted
}
fragment DocumentGraphEdgeFields on DocumentGraphEdgeType {
  sourceDocId
  targetDocId
  rawTargetDocId
  targetWorkspaceId
  targetState
  linkKind
  occurrenceCount
  firstOccurrencePreview
  staleState
  occurrences {
    ...DocumentGraphOccurrenceFields
  }
}
fragment DocumentGraphOccurrenceFields on DocumentGraphOccurrenceType {
  id
  sourceDocId
  sourceBlockId
  sourceParentBlockId
  sourceParentFlavour
  rawTargetDocId
  targetWorkspaceId
  targetDocId
  linkKind
  paramsJson
  markdownPreview
  targetState
  extractedAt
  sourceUpdatedAt
}
fragment DatabaseDocumentReferenceFields on DatabaseDocumentReferenceType {
  databaseId
  databaseTitle
  rowId
  rowTitle
  fieldId
  fieldName
  referenceKind
  rawTargetDocId
  targetDocId
  targetWorkspaceId
  refreshedAt
}
fragment DocumentGraphIndexStatusFields on DocumentGraphIndexStatusType {
  staleState
  indexedAt
  queuedAt
  startedAt
  failedAt
  errorCode
  errorMessage
  attemptCount
  occurrenceCount
  currentCount
  staleCount
  queuedCount
  extractingCount
  failedCount
  deletedCount
  missingStateCount
}`,
};

export const documentGraphIndexStatusQuery = {
  id: "documentGraphIndexStatusQuery" as const,
  op: "documentGraphIndexStatus",
  kind: "query" as const,
  query: `query documentGraphIndexStatus($workspaceId: String!, $docId: ID) {
  workspace(id: $workspaceId) {
    id
    documentGraphIndexStatus(docId: $docId) {
      ...DocumentGraphIndexStatusFields
    }
  }
}
fragment DocumentGraphIndexStatusFields on DocumentGraphIndexStatusType {
  staleState
  indexedAt
  queuedAt
  startedAt
  failedAt
  errorCode
  errorMessage
  attemptCount
  occurrenceCount
  currentCount
  staleCount
  queuedCount
  extractingCount
  failedCount
  deletedCount
  missingStateCount
}`,
};

export const documentMetadataIndexQuery = {
  id: "documentMetadataIndexQuery" as const,
  op: "documentMetadataIndex",
  kind: "query" as const,
  query: `query documentMetadataIndex($workspaceId: ID!, $tagWorkspaceId: String!) {
  documentMetadataIndex(workspaceId: $workspaceId) {
    ...DocumentMetadataIndexFields
  }
  workspace(id: $tagWorkspaceId) {
    id
    workspaceTags(includeArchived: true) {
      ...WorkspaceTagFields
    }
  }
}
fragment DocumentMetadataIndexFields on DocumentMetadataIndexRowType {
  docId
  externalId
  createdBy
  updatedBy
  journalDate
  isTemplate
  templateState
  templateOrigin
  templateCategory
  templateTags
  primaryMode
  pageWidth
  edgelessColorTheme
  integrationType
  canPublish
  statusId
  documentTypeId
  currentVersionId
  dirtySinceCurrentVersion
  reviewDueAt
  validUntil
  classificationId
  tagIds
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const documentMetadataFieldDefinitionsQuery = {
  id: "documentMetadataFieldDefinitionsQuery" as const,
  op: "documentMetadataFieldDefinitions",
  kind: "query" as const,
  query: `query documentMetadataFieldDefinitions {
  documentMetadataFieldDefinitions {
    ...DocumentMetadataFieldDefinitionFields
  }
}
fragment DocumentMetadataFieldDefinitionFields on DocumentMetadataFieldDefinitionType {
  key
  label
  enabled
  requiredMode
  editableBy
  visibleInHeader
  visibleInProperties
  visibleInLists
  exportMode
  validationConfig
  metadata
  updatedBy
  updatedAt
}`,
};

export const documentMetadataValueDefinitionsQuery = {
  id: "documentMetadataValueDefinitionsQuery" as const,
  op: "documentMetadataValueDefinitions",
  kind: "query" as const,
  query: `query documentMetadataValueDefinitions($fieldKey: String!) {
  documentMetadataValueDefinitions(fieldKey: $fieldKey) {
    id
    fieldKey
    key
    label
    description
    color
    icon
    sortOrder
    isActive
    metadata
  }
}`,
};

export const documentStatusSchemasQuery = {
  id: "documentStatusSchemasQuery" as const,
  op: "documentStatusSchemas",
  kind: "query" as const,
  query: `query documentStatusSchemas {
  documentStatusSchemas {
    id
    key
    label
    description
    complexity
    isPreset
    isActive
    metadata
  }
}`,
};

export const documentStatusValuesQuery = {
  id: "documentStatusValuesQuery" as const,
  op: "documentStatusValues",
  kind: "query" as const,
  query: `query documentStatusValues($schemaKey: String!) {
  documentStatusValues(schemaKey: $schemaKey) {
    ...DocumentStatusValueFields
  }
}
fragment DocumentStatusValueFields on DocumentStatusValueType {
  id
  schemaId
  key
  label
  description
  color
  icon
  sortOrder
  terminal
  okfStatus
  isActive
  metadata
}`,
};

export const documentTypesQuery = {
  id: "documentTypesQuery" as const,
  op: "documentTypes",
  kind: "query" as const,
  query: `query documentTypes {
  documentTypes {
    ...DocumentTypeDefinitionFields
  }
}
fragment DocumentTypeDefinitionFields on DocumentTypeDefinitionType {
  id
  key
  label
  description
  icon
  color
  isActive
  isSuggested
}`,
};

export const documentVersionPoliciesQuery = {
  id: "documentVersionPoliciesQuery" as const,
  op: "documentVersionPolicies",
  kind: "query" as const,
  query: `query documentVersionPolicies($workspaceId: ID!) {
  documentVersionPolicies(workspaceId: $workspaceId) {
    id
    scope
    workspaceId
    name
    isDefault
    enabledByDefault
    schemePreset
    customPattern
    timezoneMode
    autoVersionOn
    retentionCount
    pinManualVersions
    pinPublishVersions
    publishedVersionsProtected
    exportVersionsProtected
    metadataSchema
    createdBy
    createdAt
    updatedBy
    updatedAt
  }
}`,
};

export const workspaceDocumentSettingsQuery = {
  id: "workspaceDocumentSettingsQuery" as const,
  op: "workspaceDocumentSettings",
  kind: "query" as const,
  query: `query workspaceDocumentSettings($workspaceId: ID!) {
  workspaceDocumentSettings(workspaceId: $workspaceId) {
    workspaceId
    statusSchemaId
    defaultStatusId
    versionPolicyId
    defaultDocumentTypeId
    defaultClassificationId
    defaultRetentionPolicyId
    updatedBy
    updatedAt
  }
}`,
};

export const workspaceHistorySettingsQuery = {
  id: "workspaceHistorySettingsQuery" as const,
  op: "workspaceHistorySettings",
  kind: "query" as const,
  query: `query workspaceHistorySettings($workspaceId: ID!) {
  workspaceHistorySettings(workspaceId: $workspaceId) {
    workspaceId
    namedVersioningEnabled
    autoVersionOn
    retentionCount
    editCaptureEnabled
    editCaptureIntervalMs
    effectiveNamedVersioningEnabled
    effectiveAutoVersionOn
    effectiveRetentionCount
    effectiveEditCaptureEnabled
    effectiveEditCaptureIntervalMs
    enabledSource
    intervalSource
    legacyIntervalNormalized
    runtimeAvailable
    lastEditCaptureAt
    revision
    updatedAt
  }
}`,
};

export const updateWorkspaceHistorySettingsMutation = {
  id: "updateWorkspaceHistorySettingsMutation" as const,
  op: "updateWorkspaceHistorySettings",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceHistorySettings($workspaceId: ID!, $input: UpdateWorkspaceHistorySettingsInput!) {
  updateWorkspaceHistorySettings(workspaceId: $workspaceId, input: $input) {
    workspaceId
    namedVersioningEnabled
    autoVersionOn
    retentionCount
    editCaptureEnabled
    editCaptureIntervalMs
    effectiveNamedVersioningEnabled
    effectiveAutoVersionOn
    effectiveRetentionCount
    effectiveEditCaptureEnabled
    effectiveEditCaptureIntervalMs
    enabledSource
    intervalSource
    legacyIntervalNormalized
    runtimeAvailable
    lastEditCaptureAt
    revision
    updatedAt
  }
}`,
};

export const transitionDocumentStatusMutation = {
  id: "transitionDocumentStatusMutation" as const,
  op: "transitionDocumentStatus",
  kind: "mutation" as const,
  query: `mutation transitionDocumentStatus($workspaceId: ID!, $docId: ID!, $input: TransitionDocumentStatusInput!) {
  transitionDocumentStatus(
    workspaceId: $workspaceId
    docId: $docId
    input: $input
  ) {
    metadata {
      ...DocumentMetadataFields
    }
    validation {
      ...DocumentMetadataValidationFields
    }
  }
}
fragment DocumentMetadataFields on DocumentMetadataType {
  docId
  workspaceId
  projectionMode
  projectionVersion
  metadataRevision
  metadataUpdatedAt
  metadataUpdatedBy
  system {
    createdAt
    updatedAt
    createdBy
    updatedBy
    metadataUpdatedAt
    metadataUpdatedBy
  }
  fields {
    ...DocumentMetadataFieldValueFields
  }
  audience {
    ...DocumentMetadataAudienceFields
  }
  template {
    state
    origin
    category
    tags
    templateId
    revisionId
    instanceId
  }
  journal {
    journalDate
  }
  presentation {
    primaryMode
    pageWidth
    edgelessColorTheme
  }
  integration {
    integrationType
  }
  policy {
    locks {
      key
      inheritanceMode
      editable
      reason
    }
  }
  legacy
}
fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}
fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}
fragment DocumentMetadataValidationFields on DocumentMetadataValidationType {
  valid
  missingRequiredMetadataFields
  blockedActions
  errors {
    ...DocumentMetadataValidationIssueFields
  }
  warnings {
    ...DocumentMetadataValidationIssueFields
  }
}
fragment DocumentMetadataValidationIssueFields on DocumentMetadataValidationIssueType {
  code
  key
  message
  severity
  blockedActions
  details
}`,
};

export const updateWorkspaceDocumentSettingsMutation = {
  id: "updateWorkspaceDocumentSettingsMutation" as const,
  op: "updateWorkspaceDocumentSettings",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceDocumentSettings($workspaceId: ID!, $input: UpdateWorkspaceDocumentSettingsInput!) {
  updateWorkspaceDocumentSettings(workspaceId: $workspaceId, input: $input) {
    workspaceId
    statusSchemaId
    defaultStatusId
    versionPolicyId
    defaultDocumentTypeId
    defaultClassificationId
    defaultRetentionPolicyId
    updatedBy
    updatedAt
  }
}`,
};

export const documentMetadataQuery = {
  id: "documentMetadataQuery" as const,
  op: "documentMetadata",
  kind: "query" as const,
  query: `query documentMetadata($workspaceId: ID!, $docId: ID!, $requestedProjectionMode: DocumentMetadataProjectionModeType) {
  documentMetadata(
    workspaceId: $workspaceId
    docId: $docId
    requestedProjectionMode: $requestedProjectionMode
  ) {
    ...DocumentMetadataFields
  }
}
fragment DocumentMetadataFields on DocumentMetadataType {
  docId
  workspaceId
  projectionMode
  projectionVersion
  metadataRevision
  metadataUpdatedAt
  metadataUpdatedBy
  system {
    createdAt
    updatedAt
    createdBy
    updatedBy
    metadataUpdatedAt
    metadataUpdatedBy
  }
  fields {
    ...DocumentMetadataFieldValueFields
  }
  audience {
    ...DocumentMetadataAudienceFields
  }
  template {
    state
    origin
    category
    tags
    templateId
    revisionId
    instanceId
  }
  journal {
    journalDate
  }
  presentation {
    primaryMode
    pageWidth
    edgelessColorTheme
  }
  integration {
    integrationType
  }
  policy {
    locks {
      key
      inheritanceMode
      editable
      reason
    }
  }
  legacy
}
fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}
fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}`,
};

export const documentMetadataValidationQuery = {
  id: "documentMetadataValidationQuery" as const,
  op: "documentMetadataValidation",
  kind: "query" as const,
  query: `query documentMetadataValidation($workspaceId: ID!, $docId: ID!, $action: DocumentMetadataValidationActionType) {
  documentMetadataValidation(
    workspaceId: $workspaceId
    docId: $docId
    action: $action
  ) {
    ...DocumentMetadataValidationFields
  }
}
fragment DocumentMetadataValidationFields on DocumentMetadataValidationType {
  valid
  missingRequiredMetadataFields
  blockedActions
  errors {
    ...DocumentMetadataValidationIssueFields
  }
  warnings {
    ...DocumentMetadataValidationIssueFields
  }
}
fragment DocumentMetadataValidationIssueFields on DocumentMetadataValidationIssueType {
  code
  key
  message
  severity
  blockedActions
  details
}`,
};

export const setDocumentMetadataMutation = {
  id: "setDocumentMetadataMutation" as const,
  op: "setDocumentMetadata",
  kind: "mutation" as const,
  query: `mutation setDocumentMetadata($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!) {
  setDocumentMetadata(workspaceId: $workspaceId, docId: $docId, input: $input) {
    metadata {
      ...DocumentMetadataFields
    }
  }
}
fragment DocumentMetadataFields on DocumentMetadataType {
  docId
  workspaceId
  projectionMode
  projectionVersion
  metadataRevision
  metadataUpdatedAt
  metadataUpdatedBy
  system {
    createdAt
    updatedAt
    createdBy
    updatedBy
    metadataUpdatedAt
    metadataUpdatedBy
  }
  fields {
    ...DocumentMetadataFieldValueFields
  }
  audience {
    ...DocumentMetadataAudienceFields
  }
  template {
    state
    origin
    category
    tags
    templateId
    revisionId
    instanceId
  }
  journal {
    journalDate
  }
  presentation {
    primaryMode
    pageWidth
    edgelessColorTheme
  }
  integration {
    integrationType
  }
  policy {
    locks {
      key
      inheritanceMode
      editable
      reason
    }
  }
  legacy
}
fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}
fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}`,
};

export const documentReviewPlanningQuery = {
  id: "documentReviewPlanningQuery" as const,
  op: "documentReviewPlanning",
  kind: "query" as const,
  query: `query documentReviewPlanning($workspaceId: ID!, $docId: ID!) {
  documentReviewPlanning(workspaceId: $workspaceId, docId: $docId) {
    ...DocumentReviewPlanningFields
  }
}
fragment DocumentReviewPlanningFields on DocumentReviewPlanningType {
  enabled
  metadataRevision
  responsibleId
  sourceDeadline
  nextStart
  processDeadline
  zone
  leadDays
  ready
  blockedReason
  runId
}`,
};

export const configureDocumentReviewPlanningMutation = {
  id: "configureDocumentReviewPlanningMutation" as const,
  op: "configureDocumentReviewPlanning",
  kind: "mutation" as const,
  query: `mutation configureDocumentReviewPlanning($workspaceId: ID!, $docId: ID!, $enabled: Boolean!, $expectedMetadataRevision: Int!) {
  configureDocumentReviewPlanning(
    workspaceId: $workspaceId
    docId: $docId
    enabled: $enabled
    expectedMetadataRevision: $expectedMetadataRevision
  ) {
    ...DocumentReviewPlanningFields
  }
}
fragment DocumentReviewPlanningFields on DocumentReviewPlanningType {
  enabled
  metadataRevision
  responsibleId
  sourceDeadline
  nextStart
  processDeadline
  zone
  leadDays
  ready
  blockedReason
  runId
}`,
};

export const prepareDocumentReviewQuery = {
  id: "prepareDocumentReviewQuery" as const,
  op: "prepareDocumentReview",
  kind: "query" as const,
  query: `query prepareDocumentReview($workspaceId: String!, $input: PrepareDocumentReviewInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareDocumentReview(input: $input) {
      ...PreparedDocumentReviewFragment
    }
  }
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`,
};

export const documentReviewQuery = {
  id: "documentReviewQuery" as const,
  op: "documentReview",
  kind: "query" as const,
  query: `query documentReview($workspaceId: String!, $runId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    documentReview(runId: $runId) {
      ...DocumentReviewFragment
    }
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const documentReviewRequestQuery = {
  id: "documentReviewRequestQuery" as const,
  op: "documentReviewRequest",
  kind: "query" as const,
  query: `query documentReviewRequest($workspaceId: String!, $requestId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    documentReviewRequest(requestId: $requestId) {
      ...DocumentReviewFragment
    }
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const documentReviewForTaskQuery = {
  id: "documentReviewForTaskQuery" as const,
  op: "documentReviewForTask",
  kind: "query" as const,
  query: `query documentReviewForTask($workspaceId: String!, $databaseId: ID!, $rowId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    documentReviewForTask(databaseId: $databaseId, rowId: $rowId) {
      ...DocumentReviewFragment
    }
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const startDocumentReviewMutation = {
  id: "startDocumentReviewMutation" as const,
  op: "startDocumentReview",
  kind: "mutation" as const,
  query: `mutation startDocumentReview($input: StartDocumentReviewInput!) {
  startDocumentReview(input: $input) {
    ...DocumentReviewFragment
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const decideDocumentReviewMutation = {
  id: "decideDocumentReviewMutation" as const,
  op: "decideDocumentReview",
  kind: "mutation" as const,
  query: `mutation decideDocumentReview($input: DecideDocumentReviewInput!) {
  decideDocumentReview(input: $input) {
    ...DocumentReviewFragment
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const stopDocumentReviewMutation = {
  id: "stopDocumentReviewMutation" as const,
  op: "stopDocumentReview",
  kind: "mutation" as const,
  query: `mutation stopDocumentReview($input: DocumentReviewRunInput!) {
  stopDocumentReview(input: $input) {
    ...DocumentReviewFragment
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const retryDocumentReviewMutation = {
  id: "retryDocumentReviewMutation" as const,
  op: "retryDocumentReview",
  kind: "mutation" as const,
  query: `mutation retryDocumentReview($input: DocumentReviewRunInput!) {
  retryDocumentReview(input: $input) {
    ...DocumentReviewFragment
  }
}
fragment DocumentReviewFragment on DocumentReview {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedDocumentReviewFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  waitId
  expectedTaskEditRevision
  expectedStatusEditRevision
  sourceAvailable
  currentSourceRevision
  reviewTaskId
  followUpTaskId
  reviewTaskAvailable
  followUpTaskAvailable
  decision
  reason
  canApprove
  canRequestChanges
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedDocumentReviewFragment on PreparedDocumentReview {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  sourceRevision
  reviewerId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const documentSnippetsQuery = {
  id: "documentSnippetsQuery" as const,
  op: "documentSnippets",
  kind: "query" as const,
  query: `query documentSnippets($workspaceId: String!, $docIds: [ID!]!) {
  workspace(id: $workspaceId) {
    documentSnippets(docIds: $docIds) {
      docId
      snippet
      indexedAt
    }
  }
}`,
};

export const documentVersioningOverviewQuery = {
  id: "documentVersioningOverviewQuery" as const,
  op: "documentVersioningOverview",
  kind: "query" as const,
  query: `query documentVersioningOverview($workspaceId: ID!, $docId: ID!) {
  workspaceHistorySettings(workspaceId: $workspaceId) {
    effectiveEditCaptureEnabled
    effectiveEditCaptureIntervalMs
    runtimeAvailable
    lastEditCaptureAt
  }
  documentMetadata(workspaceId: $workspaceId, docId: $docId) {
    ...DocumentMetadataFields
  }
  documentMetadataValidation(workspaceId: $workspaceId, docId: $docId) {
    ...DocumentMetadataValidationFields
  }
  documentVersions(workspaceId: $workspaceId, docId: $docId) {
    ...DocumentVersionFields
  }
}
fragment DocumentMetadataFields on DocumentMetadataType {
  docId
  workspaceId
  projectionMode
  projectionVersion
  metadataRevision
  metadataUpdatedAt
  metadataUpdatedBy
  system {
    createdAt
    updatedAt
    createdBy
    updatedBy
    metadataUpdatedAt
    metadataUpdatedBy
  }
  fields {
    ...DocumentMetadataFieldValueFields
  }
  audience {
    ...DocumentMetadataAudienceFields
  }
  template {
    state
    origin
    category
    tags
    templateId
    revisionId
    instanceId
  }
  journal {
    journalDate
  }
  presentation {
    primaryMode
    pageWidth
    edgelessColorTheme
  }
  integration {
    integrationType
  }
  policy {
    locks {
      key
      inheritanceMode
      editable
      reason
    }
  }
  legacy
}
fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}
fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}
fragment DocumentMetadataValidationFields on DocumentMetadataValidationType {
  valid
  missingRequiredMetadataFields
  blockedActions
  errors {
    ...DocumentMetadataValidationIssueFields
  }
  warnings {
    ...DocumentMetadataValidationIssueFields
  }
}
fragment DocumentMetadataValidationIssueFields on DocumentMetadataValidationIssueType {
  code
  key
  message
  severity
  blockedActions
  details
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const createDocumentVersionMutation = {
  id: "createDocumentVersionMutation" as const,
  op: "createDocumentVersion",
  kind: "mutation" as const,
  query: `mutation createDocumentVersion($workspaceId: ID!, $docId: ID!, $label: String!, $description: String) {
  createDocumentVersion(
    workspaceId: $workspaceId
    docId: $docId
    label: $label
    description: $description
  ) {
    ...DocumentVersionFields
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const captureDocumentHistoryMutation = {
  id: "captureDocumentHistoryMutation" as const,
  op: "captureDocumentHistory",
  kind: "mutation" as const,
  query: `mutation captureDocumentHistory($workspaceId: ID!, $docId: ID!, $requestKey: ID!, $name: String, $description: String) {
  captureDocumentHistory(
    workspaceId: $workspaceId
    docId: $docId
    requestKey: $requestKey
    name: $name
    description: $description
  ) {
    historyId
    version {
      ...DocumentVersionFields
    }
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const nameDocumentHistoryStateMutation = {
  id: "nameDocumentHistoryStateMutation" as const,
  op: "nameDocumentHistoryState",
  kind: "mutation" as const,
  query: `mutation nameDocumentHistoryState($workspaceId: ID!, $docId: ID!, $historyId: ID!, $expectedVersionIds: [ID!]!, $name: String!, $description: String) {
  nameDocumentHistoryState(
    workspaceId: $workspaceId
    docId: $docId
    historyId: $historyId
    expectedVersionIds: $expectedVersionIds
    name: $name
    description: $description
  ) {
    ...DocumentVersionFields
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const updateDocumentVersionMutation = {
  id: "updateDocumentVersionMutation" as const,
  op: "updateDocumentVersion",
  kind: "mutation" as const,
  query: `mutation updateDocumentVersion($id: ID!, $label: String!, $description: String) {
  updateDocumentVersion(id: $id, label: $label, description: $description) {
    ...DocumentVersionFields
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const pinDocumentVersionMutation = {
  id: "pinDocumentVersionMutation" as const,
  op: "pinDocumentVersion",
  kind: "mutation" as const,
  query: `mutation pinDocumentVersion($id: ID!) {
  pinDocumentVersion(id: $id) {
    ...DocumentVersionFields
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const unpinDocumentVersionMutation = {
  id: "unpinDocumentVersionMutation" as const,
  op: "unpinDocumentVersion",
  kind: "mutation" as const,
  query: `mutation unpinDocumentVersion($id: ID!) {
  unpinDocumentVersion(id: $id) {
    ...DocumentVersionFields
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const documentHistoryRevisionQuery = {
  id: "documentHistoryRevisionQuery" as const,
  op: "documentHistoryRevision",
  kind: "query" as const,
  query: `query documentHistoryRevision($workspaceId: ID!, $docId: ID!) {
  documentHistoryRevision(workspaceId: $workspaceId, docId: $docId)
}`,
};

export const restoreDocumentVersionMutation = {
  id: "restoreDocumentVersionMutation" as const,
  op: "restoreDocumentVersion",
  kind: "mutation" as const,
  query: `mutation restoreDocumentVersion($id: ID!, $expectedRevision: String) {
  restoreDocumentVersion(id: $id, expectedRevision: $expectedRevision) {
    ...DocumentVersionFields
  }
}
fragment DocumentVersionFields on DocumentVersionType {
  id
  docId
  workspaceId
  docHistoryId
  versionNo
  label
  description
  createdBy
  createdAt
  isPinned
  event
  kind
  isProtected
  policyId
  contentHash
}`,
};

export const documentVersionDiffQuery = {
  id: "documentVersionDiffQuery" as const,
  op: "documentVersionDiff",
  kind: "query" as const,
  query: `query documentVersionDiff($fromId: ID!, $toId: ID!) {
  documentVersionDiff(fromId: $fromId, toId: $toId) {
    fromBlockCount
    toBlockCount
    extractionPartial
    stateVector {
      fromStateVectorSha256
      toStateVectorSha256
      changed
    }
    blockDiffs {
      blockId
      kind
      fromFlavour
      toFlavour
      fromText
      toText
      fromChildren
      toChildren
    }
    textDiffs {
      blockId
      fromText
      toText
      removedLines
      addedLines
      removedWords
      addedWords
    }
  }
}`,
};

export const emptyWorkspaceTrashMutation = {
  id: "emptyWorkspaceTrashMutation" as const,
  op: "emptyWorkspaceTrash",
  kind: "mutation" as const,
  query: `mutation emptyWorkspaceTrash($input: EmptyWorkspaceTrashInput!) {
  emptyWorkspaceTrash(input: $input) {
    requested
    deleted
    notFound
    forbidden
    alreadyDeleted
    notTrashed
    failed
    rootMetaRemoved
    documents {
      clientDocId
      resolvedDocId
      title
      status
      reason
    }
  }
}`,
};

export const getCurrentUserFeaturesQuery = {
  id: "getCurrentUserFeaturesQuery" as const,
  op: "getCurrentUserFeatures",
  kind: "query" as const,
  query: `query getCurrentUserFeatures {
  currentUser {
    id
    name
    email
    emailVerified
    avatarUrl
    features
  }
}`,
};

export const getCurrentUserProfileQuery = {
  id: "getCurrentUserProfileQuery" as const,
  op: "getCurrentUserProfile",
  kind: "query" as const,
  query: `query getCurrentUserProfile {
  currentUser {
    ...CurrentUserProfile
  }
}
fragment CurrentUserProfile on UserType {
  id
  name
  email
  avatarUrl
  emailVerified
  features
  preferences {
    updatedAt
    values {
      locale
      defaultDocumentLanguage
      timezone
      dateFormat
      timeFormat
      receiveInvitationEmail
      receiveMentionEmail
      receiveCommentEmail
      journalFirstDayOfWeek
      journalShowCalendarWeeks
      colorMode
      showLinkedDocuments
      imageAntialiasing
      noisyBackground
      editorFontFamily
      editorCustomFontFamily
      editorFontSize
      newDocumentMode
      fullWidthLayout
      openDocumentMode
      edgelessDefaultTheme
      telemetryEnabled
      aiModelId
      aiReasoningEnabled
      documentMetadataHeaderVisibility {
        workspaceId
        fields {
          field
          visible
        }
      }
    }
    effectiveValues {
      locale
      defaultDocumentLanguage
      timezone
      dateFormat
      timeFormat
      receiveInvitationEmail
      receiveMentionEmail
      receiveCommentEmail
      journalFirstDayOfWeek
      journalShowCalendarWeeks
      colorMode
      showLinkedDocuments
      imageAntialiasing
      noisyBackground
      editorFontFamily
      editorCustomFontFamily
      editorFontSize
      newDocumentMode
      fullWidthLayout
      openDocumentMode
      edgelessDefaultTheme
      telemetryEnabled
      aiModelId
      aiReasoningEnabled
      documentMetadataHeaderVisibility {
        workspaceId
        fields {
          field
          visible
        }
      }
    }
  }
  quota {
    name
    blobLimit
    storageQuota
    historyPeriod
    memberLimit
    humanReadable {
      name
      blobLimit
      storageQuota
      historyPeriod
      memberLimit
    }
  }
  quotaUsage {
    storageQuota
  }
  copilot {
    quota {
      limit
      used
    }
  }
}`,
};

export const getCurrentUserQuery = {
  id: "getCurrentUserQuery" as const,
  op: "getCurrentUser",
  kind: "query" as const,
  query: `query getCurrentUser {
  currentUser {
    id
    name
    email
    emailVerified
    avatarUrl
    token {
      sessionToken
    }
  }
}`,
  deprecations: [
    "'token' is deprecated: use [/api/auth/sign-in?native=true] instead",
  ],
};

export const getDocCreatedByUpdatedByListQuery = {
  id: "getDocCreatedByUpdatedByListQuery" as const,
  op: "getDocCreatedByUpdatedByList",
  kind: "query" as const,
  query: `query getDocCreatedByUpdatedByList($workspaceId: String!, $pagination: PaginationInput!) {
  workspace(id: $workspaceId) {
    docs(pagination: $pagination) {
      totalCount
      pageInfo {
        endCursor
        hasNextPage
      }
      edges {
        node {
          id
          creatorId
          lastUpdaterId
        }
      }
    }
  }
}`,
};

export const getDocDefaultRoleQuery = {
  id: "getDocDefaultRoleQuery" as const,
  op: "getDocDefaultRole",
  kind: "query" as const,
  query: `query getDocDefaultRole($workspaceId: String!, $docId: String!) {
  workspace(id: $workspaceId) {
    doc(docId: $docId) {
      defaultRole
    }
  }
}`,
};

export const getDocLastAccessedMembersQuery = {
  id: "getDocLastAccessedMembersQuery" as const,
  op: "getDocLastAccessedMembers",
  kind: "query" as const,
  query: `query getDocLastAccessedMembers($workspaceId: String!, $docId: String!, $pagination: PaginationInput!, $query: String, $includeTotal: Boolean) {
  workspace(id: $workspaceId) {
    doc(docId: $docId) {
      lastAccessedMembers(
        pagination: $pagination
        query: $query
        includeTotal: $includeTotal
      ) {
        totalCount
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
          node {
            user {
              name
              avatarUrl
            }
            lastAccessedAt
            lastDocId
          }
        }
      }
    }
  }
}`,
};

export const getDocPageAnalyticsQuery = {
  id: "getDocPageAnalyticsQuery" as const,
  op: "getDocPageAnalytics",
  kind: "query" as const,
  query: `query getDocPageAnalytics($workspaceId: String!, $docId: String!, $input: DocPageAnalyticsInput) {
  workspace(id: $workspaceId) {
    doc(docId: $docId) {
      analytics(input: $input) {
        window {
          from
          to
          timezone
          bucket
          requestedSize
          effectiveSize
        }
        series {
          date
          totalViews
          uniqueViews
          guestViews
        }
        summary {
          totalViews
          uniqueViews
          guestViews
          lastAccessedAt
        }
        generatedAt
      }
    }
  }
}`,
};

export const getDocSummaryQuery = {
  id: "getDocSummaryQuery" as const,
  op: "getDocSummary",
  kind: "query" as const,
  query: `query getDocSummary($workspaceId: String!, $docId: String!) {
  workspace(id: $workspaceId) {
    doc(docId: $docId) {
      summary
    }
  }
}`,
};

export const getInviteInfoQuery = {
  id: "getInviteInfoQuery" as const,
  op: "getInviteInfo",
  kind: "query" as const,
  query: `query getInviteInfo($inviteId: String!) {
  getInviteInfo(inviteId: $inviteId) {
    workspace {
      id
      name
      avatar
    }
    user {
      id
      name
      avatarUrl
    }
    status
    invitee {
      id
      name
      email
      avatarUrl
    }
  }
}`,
};

export const getMemberCountByWorkspaceIdQuery = {
  id: "getMemberCountByWorkspaceIdQuery" as const,
  op: "getMemberCountByWorkspaceId",
  kind: "query" as const,
  query: `query getMemberCountByWorkspaceId($workspaceId: String!) {
  workspace(id: $workspaceId) {
    memberCount
  }
}`,
};

export const getMembersByWorkspaceIdQuery = {
  id: "getMembersByWorkspaceIdQuery" as const,
  op: "getMembersByWorkspaceId",
  kind: "query" as const,
  query: `query getMembersByWorkspaceId($workspaceId: String!, $skip: Int, $take: Int, $query: String) {
  workspace(id: $workspaceId) {
    memberCount
    members(skip: $skip, take: $take, query: $query) {
      id
      name
      email
      avatarUrl
      permission
      inviteId
      emailVerified
      status
    }
  }
}`,
};

export const oauthProvidersQuery = {
  id: "oauthProvidersQuery" as const,
  op: "oauthProviders",
  kind: "query" as const,
  query: `query oauthProviders {
  serverConfig {
    oauthProviders
  }
}`,
};

export const getPageGrantedUsersListQuery = {
  id: "getPageGrantedUsersListQuery" as const,
  op: "getPageGrantedUsersList",
  kind: "query" as const,
  query: `query getPageGrantedUsersList($pagination: PaginationInput!, $docId: String!, $workspaceId: String!) {
  workspace(id: $workspaceId) {
    doc(docId: $docId) {
      grantedUsersList(pagination: $pagination) {
        totalCount
        pageInfo {
          endCursor
          hasNextPage
        }
        edges {
          node {
            role
            user {
              id
              name
              email
              avatarUrl
            }
          }
        }
      }
    }
  }
}`,
};

export const getPublicUserByIdQuery = {
  id: "getPublicUserByIdQuery" as const,
  op: "getPublicUserById",
  kind: "query" as const,
  query: `query getPublicUserById($id: String!) {
  publicUserById(id: $id) {
    id
    avatarUrl
    name
  }
}`,
};

export const getRecentlyUpdatedDocsQuery = {
  id: "getRecentlyUpdatedDocsQuery" as const,
  op: "getRecentlyUpdatedDocs",
  kind: "query" as const,
  query: `query getRecentlyUpdatedDocs($workspaceId: String!, $pagination: PaginationInput!) {
  workspace(id: $workspaceId) {
    recentlyUpdatedDocs(pagination: $pagination) {
      totalCount
      pageInfo {
        endCursor
        hasNextPage
      }
      edges {
        node {
          id
          title
          createdAt
          updatedAt
          creatorId
          lastUpdaterId
        }
      }
    }
  }
}`,
};

export const getUserAssistanceQuery = {
  id: "getUserAssistanceQuery" as const,
  op: "getUserAssistance",
  kind: "query" as const,
  query: `query getUserAssistance($workspaceId: ID, $projectId: ID) {
  currentUser {
    id
    preferences {
      assistance(workspaceId: $workspaceId, projectId: $projectId) {
        mode
        source
        userDefaultExplicit
        interactiveMode
      }
    }
  }
}`,
};

export const getUserFeaturesQuery = {
  id: "getUserFeaturesQuery" as const,
  op: "getUserFeatures",
  kind: "query" as const,
  query: `query getUserFeatures {
  currentUser {
    id
    features
  }
}`,
};

export const getUserPreferencesQuery = {
  id: "getUserPreferencesQuery" as const,
  op: "getUserPreferences",
  kind: "query" as const,
  query: `query getUserPreferences {
  currentUser {
    preferences {
      updatedAt
      values {
        assistanceMode
        workspaceAssistanceOverrides {
          workspaceId
          mode
        }
        projectAssistanceOverrides {
          workspaceId
          projectId
          mode
        }
        locale
        defaultDocumentLanguage
        timezone
        dateFormat
        timeFormat
        receiveInvitationEmail
        receiveMentionEmail
        receiveCommentEmail
        notifyCreatedDocuments
        journalFirstDayOfWeek
        journalShowCalendarWeeks
        colorMode
        showLinkedDocuments
        imageAntialiasing
        noisyBackground
        editorFontFamily
        editorCustomFontFamily
        editorFontSize
        newDocumentMode
        fullWidthLayout
        openDocumentMode
        edgelessDefaultTheme
        telemetryEnabled
        aiModelId
        templateCatalogViews {
          workspaceId
          view
        }
        aiReasoningEnabled
        documentMetadataHeaderVisibility {
          workspaceId
          fields {
            field
            visible
          }
        }
        workbenchToolLayouts {
          workspaceId
          viewFamily
          orderedToolIds
          visibleToolIds
          collapsedToolIds
        }
        workspaceDashboardLayouts {
          workspaceId
          orderedDashletIds
          dashletSizes {
            dashletId
            size
          }
        }
      }
      effectiveValues {
        assistanceMode
        locale
        defaultDocumentLanguage
        timezone
        dateFormat
        timeFormat
        receiveInvitationEmail
        receiveMentionEmail
        receiveCommentEmail
        notifyCreatedDocuments
        journalFirstDayOfWeek
        journalShowCalendarWeeks
        colorMode
        showLinkedDocuments
        imageAntialiasing
        noisyBackground
        editorFontFamily
        editorCustomFontFamily
        editorFontSize
        newDocumentMode
        fullWidthLayout
        openDocumentMode
        edgelessDefaultTheme
        telemetryEnabled
        aiModelId
        templateCatalogViews {
          workspaceId
          view
        }
        aiReasoningEnabled
        documentMetadataHeaderVisibility {
          workspaceId
          fields {
            field
            visible
          }
        }
        workbenchToolLayouts {
          workspaceId
          viewFamily
          orderedToolIds
          visibleToolIds
          collapsedToolIds
        }
        workspaceDashboardLayouts {
          workspaceId
          orderedDashletIds
          dashletSizes {
            dashletId
            size
          }
        }
      }
    }
  }
}`,
};

export const getUserQuery = {
  id: "getUserQuery" as const,
  op: "getUser",
  kind: "query" as const,
  query: `query getUser($email: String!) {
  user(email: $email) {
    __typename
    ... on UserType {
      id
      name
      avatarUrl
      email
      hasPassword
    }
    ... on LimitedUserType {
      email
      hasPassword
    }
  }
}`,
};

export const getWorkspaceInfoQuery = {
  id: "getWorkspaceInfoQuery" as const,
  op: "getWorkspaceInfo",
  kind: "query" as const,
  query: `query getWorkspaceInfo($workspaceId: String!) {
  workspace(id: $workspaceId) {
    name
    initialContentPolicy
    permissions {
      Workspace_Administrators_Manage
      Workspace_Blobs_List
      Workspace_Blobs_Read
      Workspace_Blobs_Write
      Workspace_Copilot
      Workspace_CreateDoc
      Workspace_Delete
      Workspace_Organize_Read
      Workspace_Properties_Create
      Workspace_Properties_Delete
      Workspace_Properties_Read
      Workspace_Properties_Update
      Workspace_Read
      Workspace_Settings_Read
      Workspace_Settings_Update
      Workspace_Sync
      Workspace_TransferOwner
      Workspace_Users_Manage
      Workspace_Users_Read
    }
    role
    workspaceType
  }
}`,
};

export const getWorkspacePageByIdQuery = {
  id: "getWorkspacePageByIdQuery" as const,
  op: "getWorkspacePageById",
  kind: "query" as const,
  query: `query getWorkspacePageById($workspaceId: String!, $pageId: String!) {
  workspace(id: $workspaceId) {
    doc(docId: $pageId) {
      id
      mode
      defaultRole
      public
      title
      summary
    }
  }
}`,
};

export const getWorkspacePageMetaByIdQuery = {
  id: "getWorkspacePageMetaByIdQuery" as const,
  op: "getWorkspacePageMetaById",
  kind: "query" as const,
  query: `query getWorkspacePageMetaById($id: String!, $pageId: String!) {
  workspace(id: $id) {
    pageMeta(pageId: $pageId) {
      createdAt
      updatedAt
      createdBy {
        name
        avatarUrl
      }
      updatedBy {
        name
        avatarUrl
      }
    }
  }
}`,
};

export const getWorkspacePublicByIdQuery = {
  id: "getWorkspacePublicByIdQuery" as const,
  op: "getWorkspacePublicById",
  kind: "query" as const,
  query: `query getWorkspacePublicById($id: String!) {
  workspace(id: $id) {
    public
  }
}`,
};

export const getWorkspacePublicPagesQuery = {
  id: "getWorkspacePublicPagesQuery" as const,
  op: "getWorkspacePublicPages",
  kind: "query" as const,
  query: `query getWorkspacePublicPages($workspaceId: String!) {
  workspace(id: $workspaceId) {
    publicDocs {
      id
      mode
    }
  }
}`,
};

export const getWorkspaceShareInviteLinkQuery = {
  id: "getWorkspaceShareInviteLinkQuery" as const,
  op: "getWorkspaceShareInviteLink",
  kind: "query" as const,
  query: `query getWorkspaceShareInviteLink($id: String!) {
  workspace(id: $id) {
    inviteLink {
      link
      expireTime
    }
  }
}`,
};

export const getWorkspaceQuery = {
  id: "getWorkspaceQuery" as const,
  op: "getWorkspace",
  kind: "query" as const,
  query: `query getWorkspace($id: String!) {
  workspace(id: $id) {
    id
  }
}`,
};

export const getWorkspacesQuery = {
  id: "getWorkspacesQuery" as const,
  op: "getWorkspaces",
  kind: "query" as const,
  query: `query getWorkspaces {
  workspaces {
    id
    name
    initialized
    initialContentPolicy
    role
    workspaceType
    owner {
      id
    }
  }
}`,
};

export const getGitSyncBindingsQuery = {
  id: "getGitSyncBindingsQuery" as const,
  op: "getGitSyncBindings",
  kind: "query" as const,
  query: `query getGitSyncBindings($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncBindings {
      id
      docId
      syncId
      repoPath
      tombstone
    }
  }
}`,
};

export const getGitSyncConflictsQuery = {
  id: "getGitSyncConflictsQuery" as const,
  op: "getGitSyncConflicts",
  kind: "query" as const,
  query: `query getGitSyncConflicts($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncConflicts {
      id
      repoPath
      conflictType
      resolution
      myoxusContent
      gitContent
      createdAt
    }
  }
}`,
};

export const createGitSyncProfileMutation = {
  id: "createGitSyncProfileMutation" as const,
  op: "createGitSyncProfile",
  kind: "mutation" as const,
  query: `mutation createGitSyncProfile($workspaceId: String!, $input: GitSyncProfileInput!) {
  createGitSyncProfile(workspaceId: $workspaceId, input: $input) {
    id
    repoUrl
    branch
  }
}`,
};

export const deleteGitSyncProfileMutation = {
  id: "deleteGitSyncProfileMutation" as const,
  op: "deleteGitSyncProfile",
  kind: "mutation" as const,
  query: `mutation deleteGitSyncProfile($profileId: String!) {
  deleteGitSyncProfile(profileId: $profileId)
}`,
};

export const deleteGitSyncSshHostKeyMutation = {
  id: "deleteGitSyncSshHostKeyMutation" as const,
  op: "deleteGitSyncSshHostKey",
  kind: "mutation" as const,
  query: `mutation deleteGitSyncSshHostKey($host: String!, $port: Int!, $keyType: String!) {
  deleteGitSyncSshHostKey(host: $host, port: $port, keyType: $keyType)
}`,
};

export const disableGitSyncSshHostKeyMutation = {
  id: "disableGitSyncSshHostKeyMutation" as const,
  op: "disableGitSyncSshHostKey",
  kind: "mutation" as const,
  query: `mutation disableGitSyncSshHostKey($host: String!, $port: Int!, $keyType: String!) {
  disableGitSyncSshHostKey(host: $host, port: $port, keyType: $keyType)
}`,
};

export const getGitSyncFileBindingsQuery = {
  id: "getGitSyncFileBindingsQuery" as const,
  op: "getGitSyncFileBindings",
  kind: "query" as const,
  query: `query getGitSyncFileBindings($workspaceId: String!, $includeTombstoned: Boolean) {
  workspace(id: $workspaceId) {
    gitSyncFileBindings(includeTombstoned: $includeTombstoned) {
      id
      blobKey
      repoPath
      contentHash
      mimeType
      fileSize
      tombstoned
      createdAt
      updatedAt
    }
  }
}`,
};

export const getGitSyncFileConflictsQuery = {
  id: "getGitSyncFileConflictsQuery" as const,
  op: "getGitSyncFileConflicts",
  kind: "query" as const,
  query: `query getGitSyncFileConflicts($workspaceId: String!, $resolved: Boolean) {
  workspace(id: $workspaceId) {
    gitSyncFileConflicts(resolved: $resolved) {
      id
      runId
      bindingId
      blobKey
      repoPath
      conflictType
      resolution
      gitHash
      myoxusHash
      baselineHash
      createdAt
      resolvedAt
      resolvedBy
    }
  }
}`,
};

export const getGitSyncPoliciesQuery = {
  id: "getGitSyncPoliciesQuery" as const,
  op: "getGitSyncPolicies",
  kind: "query" as const,
  query: `query getGitSyncPolicies {
  serverConfig {
    gitSync {
      allowedAuthMethods
      allowedDirections
      autoSyncAllowed
      defaultBranch
      enabled
      maxMirrorStorageMb
      sshHostKeyPolicy
      webhookAllowed
    }
  }
}`,
};

export const getGitSyncProfileQuery = {
  id: "getGitSyncProfileQuery" as const,
  op: "getGitSyncProfile",
  kind: "query" as const,
  query: `query getGitSyncProfile($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncProfile {
      id
      repoUrl
      branch
      rootPath
      manifestPath
      credentialInherited
      syncDirection
      triggerMode
      pollingIntervalSecs
      cronExpression
      cronTimezone
      cronMisfirePolicy
      cronNextScheduledAt
      cronPendingMisfireScheduledFor
      authMethod
      enabled
      createdAt
      updatedAt
      credentialExpiresAt
    }
  }
}`,
};

export const resolveGitSyncConflictMutation = {
  id: "resolveGitSyncConflictMutation" as const,
  op: "resolveGitSyncConflict",
  kind: "mutation" as const,
  query: `mutation resolveGitSyncConflict($input: ResolveConflictInput!) {
  resolveGitSyncConflict(input: $input)
}`,
};

export const resolveGitSyncFileConflictMutation = {
  id: "resolveGitSyncFileConflictMutation" as const,
  op: "resolveGitSyncFileConflict",
  kind: "mutation" as const,
  query: `mutation resolveGitSyncFileConflict($input: ResolveFileConflictInput!) {
  resolveGitSyncFileConflict(input: $input)
}`,
};

export const getGitSyncRunsQuery = {
  id: "getGitSyncRunsQuery" as const,
  op: "getGitSyncRuns",
  kind: "query" as const,
  query: `query getGitSyncRuns($workspaceId: String!, $take: Int) {
  workspace(id: $workspaceId) {
    gitSyncRuns(take: $take) {
      id
      direction
      triggerSource
      scheduledFor
      status
      startedAt
      finishedAt
      jobId
      commitBefore
      commitAfter
      observedRemoteOid
      reconciliationRequired
      reconciliationReason
      docsCreated
      docsUpdated
      docsDeleted
      conflictsFound
      errorMessage
      errorClass
    }
  }
}`,
};

export const gitSyncSchedulePreviewQuery = {
  id: "gitSyncSchedulePreviewQuery" as const,
  op: "gitSyncSchedulePreview",
  kind: "query" as const,
  query: `query gitSyncSchedulePreview($cron: String!, $cronTimezone: String!, $count: Int) {
  gitSyncSchedulePreview(cron: $cron, cronTimezone: $cronTimezone, count: $count) {
    scheduledAtUtc
    localDateTime
    utcOffsetSeconds
  }
}`,
};

export const getGitSyncSshHostKeysQuery = {
  id: "getGitSyncSshHostKeysQuery" as const,
  op: "getGitSyncSshHostKeys",
  kind: "query" as const,
  query: `query getGitSyncSshHostKeys {
  gitSyncSshHostKeys {
    host
    port
    keyType
    fingerprintSha256
    firstSeenAt
    lastSeenAt
    source
    createdBy
    enabled
  }
}`,
};

export const getGitSyncStatusQuery = {
  id: "getGitSyncStatusQuery" as const,
  op: "getGitSyncStatus",
  kind: "query" as const,
  query: `query getGitSyncStatus($workspaceId: String!) {
  workspace(id: $workspaceId) {
    pendingGitContentOperations {
      ...WorkspaceContentOperationProjection
    }
    gitSyncStatus {
      profile {
        id
        repoUrl
        branch
        syncDirection
        triggerMode
        cronExpression
        cronTimezone
        cronMisfirePolicy
        cronNextScheduledAt
        cronPendingMisfireScheduledFor
        enabled
      }
      lastRun {
        id
        direction
        triggerSource
        scheduledFor
        status
        startedAt
        finishedAt
        jobId
        commitBefore
        commitAfter
        observedRemoteOid
        reconciliationRequired
        reconciliationReason
        docsCreated
        docsUpdated
        docsDeleted
        conflictsFound
        errorMessage
        errorClass
      }
      openConflicts
      totalBindings
      openDocConflicts
      openFileConflicts
      totalDocBindings
      totalFileBindings
      partialSessionId
      partialStatus
      partialHasMore
      partialTotalItems
      partialProcessedItems
      partialFailedItems
    }
  }
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const testGitConnectionMutation = {
  id: "testGitConnectionMutation" as const,
  op: "testGitConnection",
  kind: "mutation" as const,
  query: `mutation testGitConnection($repoUrl: String!, $branch: String, $authMethod: GitSyncAuthMethod!, $token: String, $username: String, $password: String, $sshPrivateKey: String, $sshPassphrase: String) {
  testGitConnection(
    repoUrl: $repoUrl
    branch: $branch
    authMethod: $authMethod
    token: $token
    username: $username
    password: $password
    sshPrivateKey: $sshPrivateKey
    sshPassphrase: $sshPassphrase
  )
}`,
};

export const gitSyncTimezonesQuery = {
  id: "gitSyncTimezonesQuery" as const,
  op: "gitSyncTimezones",
  kind: "query" as const,
  query: `query gitSyncTimezones {
  gitSyncTimezones
}`,
};

export const triggerGitSyncMutation = {
  id: "triggerGitSyncMutation" as const,
  op: "triggerGitSync",
  kind: "mutation" as const,
  query: `mutation triggerGitSync($workspaceId: String!, $direction: GitSyncDirection) {
  triggerGitSync(workspaceId: $workspaceId, direction: $direction) {
    id
    status
    startedAt
  }
}`,
};

export const updateGitSyncProfileMutation = {
  id: "updateGitSyncProfileMutation" as const,
  op: "updateGitSyncProfile",
  kind: "mutation" as const,
  query: `mutation updateGitSyncProfile($profileId: String!, $input: UpdateGitSyncProfileInput!) {
  updateGitSyncProfile(profileId: $profileId, input: $input) {
    id
    repoUrl
    branch
    rootPath
    syncDirection
    triggerMode
    pollingIntervalSecs
    cronExpression
    cronTimezone
    cronMisfirePolicy
    cronNextScheduledAt
    cronPendingMisfireScheduledFor
    authMethod
    enabled
    createdAt
    updatedAt
    credentialExpiresAt
  }
}`,
};

export const grantDocUserRolesMutation = {
  id: "grantDocUserRolesMutation" as const,
  op: "grantDocUserRoles",
  kind: "mutation" as const,
  query: `mutation grantDocUserRoles($input: GrantDocUserRolesInput!) {
  grantDocUserRoles(input: $input)
}`,
};

export const listHistoryQuery = {
  id: "listHistoryQuery" as const,
  op: "listHistory",
  kind: "query" as const,
  query: `query listHistory($workspaceId: String!, $pageDocId: String!, $take: Int, $before: DateTime, $cursor: String, $namedOnly: Boolean) {
  workspace(id: $workspaceId) {
    histories(
      guid: $pageDocId
      take: $take
      before: $before
      cursor: $cursor
      namedOnly: $namedOnly
    ) {
      id
      snapshotId
      cursor
      timestamp
      origin
      editor {
        name
        avatarUrl
      }
    }
  }
}`,
};

export const historyMetadataQuery = {
  id: "historyMetadataQuery" as const,
  op: "historyMetadata",
  kind: "query" as const,
  query: `query historyMetadata($workspaceId: String!, $pageDocId: String!, $snapshotId: ID!) {
  workspace(id: $workspaceId) {
    history(guid: $pageDocId, snapshotId: $snapshotId) {
      id
      snapshotId
      cursor
      timestamp
      origin
      editor {
        name
        avatarUrl
      }
    }
  }
}`,
};

export const historyDiffQuery = {
  id: "historyDiffQuery" as const,
  op: "historyDiff",
  kind: "query" as const,
  query: `query historyDiff($workspaceId: String!, $pageDocId: String!, $snapshotId: ID!) {
  workspace(id: $workspaceId) {
    id
    historyDiff(guid: $pageDocId, snapshotId: $snapshotId) {
      snapshotId
      currentRevision
      readAt
      extractionPartial
      comparisonBlocks {
        blockId
        kind
        flavour
        placementKnown
        runs {
          kind
          text
        }
      }
      notices {
        kind
        blockId
      }
    }
  }
}`,
};

export const indexerAggregateQuery = {
  id: "indexerAggregateQuery" as const,
  op: "indexerAggregate",
  kind: "query" as const,
  query: `query indexerAggregate($id: String!, $input: AggregateInput!) {
  workspace(id: $id) {
    aggregate(input: $input) {
      buckets {
        key
        count
        hits {
          nodes {
            fields
            highlights
          }
        }
      }
      pagination {
        count
        hasMore
        nextCursor
      }
    }
  }
}`,
};

export const indexerSearchDocsQuery = {
  id: "indexerSearchDocsQuery" as const,
  op: "indexerSearchDocs",
  kind: "query" as const,
  query: `query indexerSearchDocs($id: String!, $input: SearchDocsInput!) {
  workspace(id: $id) {
    searchDocs(input: $input) {
      docId
      externalId
      title
      blockId
      highlight
      createdAt
      updatedAt
      databaseContexts {
        ...DatabaseDocumentReferenceFields
      }
      createdByUser {
        id
        name
        avatarUrl
      }
      updatedByUser {
        id
        name
        avatarUrl
      }
    }
  }
}
fragment DatabaseDocumentReferenceFields on DatabaseDocumentReferenceType {
  databaseId
  databaseTitle
  rowId
  rowTitle
  fieldId
  fieldName
  referenceKind
  rawTargetDocId
  targetDocId
  targetWorkspaceId
  refreshedAt
}`,
};

export const indexerSearchQuery = {
  id: "indexerSearchQuery" as const,
  op: "indexerSearch",
  kind: "query" as const,
  query: `query indexerSearch($id: String!, $input: SearchInput!) {
  workspace(id: $id) {
    search(input: $input) {
      nodes {
        fields
        highlights
      }
      pagination {
        count
        hasMore
        nextCursor
      }
    }
  }
}`,
};

export const inviteServerUserByIdMutation = {
  id: "inviteServerUserByIdMutation" as const,
  op: "InviteServerUserById",
  kind: "mutation" as const,
  query: `mutation InviteServerUserById($workspaceId: String!, $userId: String!, $role: String) {
  inviteServerUserById(workspaceId: $workspaceId, userId: $userId, role: $role)
}`,
};

export const leaveWorkspaceMutation = {
  id: "leaveWorkspaceMutation" as const,
  op: "leaveWorkspace",
  kind: "mutation" as const,
  query: `mutation leaveWorkspace($workspaceId: String!, $sendLeaveMail: Boolean) {
  leaveWorkspace(workspaceId: $workspaceId, sendLeaveMail: $sendLeaveMail)
}`,
};

export const listNotificationsQuery = {
  id: "listNotificationsQuery" as const,
  op: "listNotifications",
  kind: "query" as const,
  query: `query listNotifications($pagination: PaginationInput!, $filter: NotificationListFilterInput) {
  currentUser {
    notifications(pagination: $pagination, filter: $filter) {
      totalCount
      edges {
        cursor
        node {
          id
          type
          level
          read
          createdAt
          updatedAt
          body
        }
      }
      pageInfo {
        startCursor
        endCursor
        hasNextPage
        hasPreviousPage
      }
    }
  }
}`,
};

export const managerSearchUsersQuery = {
  id: "managerSearchUsersQuery" as const,
  op: "managerSearchUsers",
  kind: "query" as const,
  query: `query managerSearchUsers($query: String!, $unitId: ID!, $limit: Int) {
  managerSearchUsers(query: $query, unitId: $unitId, limit: $limit) {
    id
    email
    name
    features
  }
}`,
};

export const mentionUserMutation = {
  id: "mentionUserMutation" as const,
  op: "mentionUser",
  kind: "mutation" as const,
  query: `mutation mentionUser($input: MentionInput!) {
  mentionUser(input: $input)
}`,
};

export const myOrganizationAuditLogQuery = {
  id: "myOrganizationAuditLogQuery" as const,
  op: "myOrganizationAuditLog",
  kind: "query" as const,
  query: `query myOrganizationAuditLog($unitId: ID!, $skip: Int, $take: Int) {
  myOrganizationAuditLog(unitId: $unitId, skip: $skip, take: $take) {
    id
    eventKey
    category
    targetUnitId
    target {
      type
      id
      label
    }
    actor {
      id
      label
      kind
      credentialType
      credentialId
    }
    oldValue
    newValue
    metadata
    createdAt
  }
}`,
};

export const myOrganizationUnitMembersQuery = {
  id: "myOrganizationUnitMembersQuery" as const,
  op: "myOrganizationUnitMembers",
  kind: "query" as const,
  query: `query myOrganizationUnitMembers($unitId: ID!) {
  myOrganizationUnitMembers(unitId: $unitId) {
    unitId
    userId
    userEmail
    userName
    userAvatarUrl
    role
    source
    createdAt
    updatedAt
  }
}`,
};

export const myOrganizationUnitWorkspacesQuery = {
  id: "myOrganizationUnitWorkspacesQuery" as const,
  op: "myOrganizationUnitWorkspaces",
  kind: "query" as const,
  query: `query myOrganizationUnitWorkspaces {
  myOrganizationUnitWorkspaces {
    unitId
    unitName
    unitSlug
    workspaceId
    workspaceName
    relationship
  }
}`,
};

export const myOrganizationUnitsQuery = {
  id: "myOrganizationUnitsQuery" as const,
  op: "myOrganizationUnits",
  kind: "query" as const,
  query: `query myOrganizationUnits {
  myOrganizationUnits {
    id
    organizationId
    parentUnitId
    unitTypeId
    name
    slug
    description
    status
    createdAt
    updatedAt
  }
}`,
};

export const notificationCountQuery = {
  id: "notificationCountQuery" as const,
  op: "notificationCount",
  kind: "query" as const,
  query: `query notificationCount {
  currentUser {
    notifications(pagination: {first: 1}) {
      totalCount
    }
  }
}`,
};

export const pdfExportDialogBootstrapQuery = {
  id: "pdfExportDialogBootstrapQuery" as const,
  op: "pdfExportDialogBootstrap",
  kind: "query" as const,
  query: `query pdfExportDialogBootstrap($workspaceId: ID!, $docId: ID!, $locale: String) {
  availablePdfTemplates(workspaceId: $workspaceId, locale: $locale) {
    id
    slug
    name
    version
    schemaVersion
    capabilities
    inputsSchema
    isDefault
  }
  pdfExportSettings(workspaceId: $workspaceId) {
    workspaceId
    defaultTemplateId
    defaultLocale
    defaultPaperSize
    defaultColorProfile
    defaultImageQuality
    ligaturesEnabled
  }
  documentBrandingProfile(workspaceId: $workspaceId) {
    workspaceId
    logoLargeBlob
    logoSmallBlob
    footerText
    brandColorPrimary
    brandColorAccent
  }
  documentVersioningSettings(workspaceId: $workspaceId, docId: $docId) {
    docId
    enabled
    retentionCount
    autoVersionOn
  }
  documentVersions(workspaceId: $workspaceId, docId: $docId) {
    id
    label
    description
    createdAt
    isPinned
  }
  documentMetadataValidation(
    workspaceId: $workspaceId
    docId: $docId
    action: export_pdf
  ) {
    ...DocumentMetadataValidationFields
  }
  documentMetadata(workspaceId: $workspaceId, docId: $docId) {
    ...DocumentMetadataFields
  }
}
fragment DocumentMetadataValidationFields on DocumentMetadataValidationType {
  valid
  missingRequiredMetadataFields
  blockedActions
  errors {
    ...DocumentMetadataValidationIssueFields
  }
  warnings {
    ...DocumentMetadataValidationIssueFields
  }
}
fragment DocumentMetadataValidationIssueFields on DocumentMetadataValidationIssueType {
  code
  key
  message
  severity
  blockedActions
  details
}
fragment DocumentMetadataFields on DocumentMetadataType {
  docId
  workspaceId
  projectionMode
  projectionVersion
  metadataRevision
  metadataUpdatedAt
  metadataUpdatedBy
  system {
    createdAt
    updatedAt
    createdBy
    updatedBy
    metadataUpdatedAt
    metadataUpdatedBy
  }
  fields {
    ...DocumentMetadataFieldValueFields
  }
  audience {
    ...DocumentMetadataAudienceFields
  }
  template {
    state
    origin
    category
    tags
    templateId
    revisionId
    instanceId
  }
  journal {
    journalDate
  }
  presentation {
    primaryMode
    pageWidth
    edgelessColorTheme
  }
  integration {
    integrationType
  }
  policy {
    locks {
      key
      inheritanceMode
      editable
      reason
    }
  }
  legacy
}
fragment DocumentMetadataFieldValueFields on DocumentMetadataFieldValueType {
  key
  source
  reference {
    ...DocumentMetadataReferenceValueFields
  }
  textValue
  timestampValue
  dateValue
  userId
}
fragment DocumentMetadataReferenceValueFields on DocumentMetadataReferenceValueType {
  id
  key
  label
  isActive
}
fragment DocumentMetadataAudienceFields on DocumentMetadataAudienceType {
  source
  value {
    ...DocumentMetadataReferenceValueFields
  }
}`,
};

export const pdfExportJobQuery = {
  id: "pdfExportJobQuery" as const,
  op: "pdfExportJob",
  kind: "query" as const,
  query: `query pdfExportJob($jobId: String!) {
  pdfExportJob(jobId: $jobId) {
    id
    workspaceId
    docId
    status
    downloadUrl
    errorClass
    errorDetail
    createdAt
    expiresAt
    unmappedFontFamilies
  }
}`,
};

export const cancelPdfExportJobMutation = {
  id: "cancelPdfExportJobMutation" as const,
  op: "cancelPdfExportJob",
  kind: "mutation" as const,
  query: `mutation cancelPdfExportJob($jobId: String!) {
  cancelPdfExportJob(jobId: $jobId)
}`,
};

export const exportPdfMutation = {
  id: "exportPdfMutation" as const,
  op: "exportPdf",
  kind: "mutation" as const,
  query: `mutation exportPdf($input: PdfExportInputV2Input!) {
  exportPdf(input: $input) {
    id
    workspaceId
    docId
    status
    downloadUrl
    errorClass
    errorDetail
    createdAt
    expiresAt
    unmappedFontFamilies
  }
}`,
};

export const pdfTemplatePreviewPdfQuery = {
  id: "pdfTemplatePreviewPdfQuery" as const,
  op: "pdfTemplatePreviewPdf",
  kind: "query" as const,
  query: `query pdfTemplatePreviewPdf($templateId: String!, $locale: String, $workspaceId: String) {
  pdfTemplatePreviewPdf(
    templateId: $templateId
    locale: $locale
    workspaceId: $workspaceId
  )
}`,
};

export const personalWorkspaceThemeQuery = {
  id: "personalWorkspaceThemeQuery" as const,
  op: "personalWorkspaceTheme",
  kind: "query" as const,
  query: `query personalWorkspaceTheme($workspaceId: ID!) {
  personalWorkspaceThemeCatalog(workspaceId: $workspaceId) {
    slug
    name
    isDefault
  }
  personalWorkspaceThemeSelection(workspaceId: $workspaceId) {
    workspaceId
    themeSlug
    themeName
    inheritsGlobal
  }
}`,
};

export const setPersonalWorkspaceThemeMutation = {
  id: "setPersonalWorkspaceThemeMutation" as const,
  op: "setPersonalWorkspaceTheme",
  kind: "mutation" as const,
  query: `mutation setPersonalWorkspaceTheme($input: SetPersonalWorkspaceThemeInput!) {
  setPersonalWorkspaceTheme(input: $input) {
    workspaceId
    themeSlug
    themeName
    inheritsGlobal
  }
}`,
};

export const resetPersonalWorkspaceThemeMutation = {
  id: "resetPersonalWorkspaceThemeMutation" as const,
  op: "resetPersonalWorkspaceTheme",
  kind: "mutation" as const,
  query: `mutation resetPersonalWorkspaceTheme($workspaceId: ID!) {
  resetPersonalWorkspaceTheme(workspaceId: $workspaceId) {
    workspaceId
    themeSlug
    themeName
    inheritsGlobal
  }
}`,
};

export const pricesQuery = {
  id: "pricesQuery" as const,
  op: "prices",
  kind: "query" as const,
  query: `query prices {
  prices {
    type
    plan
    currency
    amount
    yearlyAmount
    lifetimeAmount
  }
}`,
};

export const publishPageMutation = {
  id: "publishPageMutation" as const,
  op: "publishPage",
  kind: "mutation" as const,
  query: `mutation publishPage($workspaceId: String!, $pageId: String!, $mode: PublicDocMode = Page) {
  publishDoc(workspaceId: $workspaceId, docId: $pageId, mode: $mode) {
    id
    mode
  }
}`,
};

export const quotaQuery = {
  id: "quotaQuery" as const,
  op: "quota",
  kind: "query" as const,
  query: `query quota {
  currentUser {
    id
    quota {
      name
      blobLimit
      storageQuota
      historyPeriod
      memberLimit
      humanReadable {
        name
        blobLimit
        storageQuota
        historyPeriod
        memberLimit
      }
    }
    quotaUsage {
      storageQuota
    }
  }
}`,
};

export const readAllNotificationsMutation = {
  id: "readAllNotificationsMutation" as const,
  op: "readAllNotifications",
  kind: "mutation" as const,
  query: `mutation readAllNotifications {
  readAllNotifications
}`,
};

export const readNotificationMutation = {
  id: "readNotificationMutation" as const,
  op: "readNotification",
  kind: "mutation" as const,
  query: `mutation readNotification($id: String!) {
  readNotification(id: $id)
}`,
};

export const recoverDocMutation = {
  id: "recoverDocMutation" as const,
  op: "recoverDoc",
  kind: "mutation" as const,
  query: `mutation recoverDoc($workspaceId: String!, $docId: String!, $timestamp: DateTime, $snapshotId: ID, $expectedRevision: String) {
  recoverDoc(
    workspaceId: $workspaceId
    guid: $docId
    timestamp: $timestamp
    snapshotId: $snapshotId
    expectedRevision: $expectedRevision
  )
}`,
};

export const taskRecurrenceQuery = {
  id: "taskRecurrenceQuery" as const,
  op: "taskRecurrence",
  kind: "query" as const,
  query: `query taskRecurrence($workspaceId: String!, $input: TaskRecurrenceLookupInput!) {
  workspace(id: $workspaceId) {
    id
    taskRecurrence(input: $input) {
      ...TaskRecurrenceFields
    }
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const taskRecurrencesQuery = {
  id: "taskRecurrencesQuery" as const,
  op: "taskRecurrences",
  kind: "query" as const,
  query: `query taskRecurrences($workspaceId: String!, $after: ID, $first: Int) {
  workspace(id: $workspaceId) {
    id
    taskRecurrences(after: $after, first: $first) {
      ...TaskRecurrenceFields
    }
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const recurrencePreviewQuery = {
  id: "recurrencePreviewQuery" as const,
  op: "recurrencePreview",
  kind: "query" as const,
  query: `query recurrencePreview($workspaceId: String!, $input: RecurrencePreviewInput!) {
  workspace(id: $workspaceId) {
    id
    recurrencePreview(input: $input) {
      occurrence {
        ...RecurrenceOccurrenceFields
      }
      completionReference {
        ...RecurrenceValueFields
      }
    }
  }
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}`,
};

export const configureTaskRecurrenceMutation = {
  id: "configureTaskRecurrenceMutation" as const,
  op: "configureTaskRecurrence",
  kind: "mutation" as const,
  query: `mutation configureTaskRecurrence($input: ConfigureTaskRecurrenceInput!) {
  configureTaskRecurrence(input: $input) {
    ...TaskRecurrenceFields
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const updateTaskRecurrenceMutation = {
  id: "updateTaskRecurrenceMutation" as const,
  op: "updateTaskRecurrence",
  kind: "mutation" as const,
  query: `mutation updateTaskRecurrence($input: UpdateTaskRecurrenceInput!) {
  updateTaskRecurrence(input: $input) {
    ...TaskRecurrenceFields
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const skipTaskRecurrenceMutation = {
  id: "skipTaskRecurrenceMutation" as const,
  op: "skipTaskRecurrence",
  kind: "mutation" as const,
  query: `mutation skipTaskRecurrence($input: SkipTaskRecurrenceInput!) {
  skipTaskRecurrence(input: $input) {
    ...TaskRecurrenceFields
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const pauseTaskRecurrenceMutation = {
  id: "pauseTaskRecurrenceMutation" as const,
  op: "pauseTaskRecurrence",
  kind: "mutation" as const,
  query: `mutation pauseTaskRecurrence($input: TaskRecurrenceControlInput!) {
  pauseTaskRecurrence(input: $input) {
    ...TaskRecurrenceFields
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const resumeTaskRecurrenceMutation = {
  id: "resumeTaskRecurrenceMutation" as const,
  op: "resumeTaskRecurrence",
  kind: "mutation" as const,
  query: `mutation resumeTaskRecurrence($input: TaskRecurrenceControlInput!) {
  resumeTaskRecurrence(input: $input) {
    ...TaskRecurrenceFields
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const endTaskRecurrenceMutation = {
  id: "endTaskRecurrenceMutation" as const,
  op: "endTaskRecurrence",
  kind: "mutation" as const,
  query: `mutation endTaskRecurrence($input: TaskRecurrenceControlInput!) {
  endTaskRecurrence(input: $input) {
    ...TaskRecurrenceFields
  }
}
fragment TaskRecurrenceFields on TaskRecurrence {
  id
  workspaceId
  actorId
  currentMemberId
  revision
  generation
  lifecycle
  rule {
    ...RecurrenceRuleFields
  }
  recipe {
    databaseId
    title
    description {
      plainText
      document
    }
    assignees
    priority
  }
  pausedAt
  blockedReason
  next {
    ...RecurrenceOccurrenceFields
  }
  pending {
    ...RecurrenceOccurrenceFields
  }
  preservedNext {
    ...TaskRecurrenceMemberFields
  }
  effectiveAfter {
    ...TaskRecurrenceMemberFields
  }
  members {
    ...TaskRecurrenceMemberFields
  }
}
fragment RecurrenceRuleFields on RecurrenceRule {
  mode
  zone
  interval
  frequency
  start {
    ...RecurrenceValueFields
  }
  end {
    ...RecurrenceValueFields
  }
  weekdays
  day
  lastDay
  month
  relativeUnit
  dateOnly
}
fragment RecurrenceValueFields on RecurrenceValue {
  date
  localDateTime
}
fragment RecurrenceOccurrenceFields on RecurrenceOccurrence {
  nominal {
    ...RecurrenceValueFields
  }
  dueAt
}
fragment TaskRecurrenceMemberFields on TaskRecurrenceMember {
  id
  occurrenceId
  rowId
  capturedDatabaseId
  slot {
    ...RecurrenceOccurrenceFields
  }
  advancedAt
  advanceKind
  successorOccurrenceId
}`,
};

export const removeAvatarMutation = {
  id: "removeAvatarMutation" as const,
  op: "removeAvatar",
  kind: "mutation" as const,
  query: `mutation removeAvatar {
  removeAvatar {
    success
  }
}`,
};

export const removeOrganizationUnitMemberAsManagerMutation = {
  id: "removeOrganizationUnitMemberAsManagerMutation" as const,
  op: "removeOrganizationUnitMemberAsManager",
  kind: "mutation" as const,
  query: `mutation removeOrganizationUnitMemberAsManager($unitId: ID!, $userId: ID!) {
  removeOrganizationUnitMemberAsManager(unitId: $unitId, userId: $userId)
}`,
};

export const revokeDocUserRolesMutation = {
  id: "revokeDocUserRolesMutation" as const,
  op: "revokeDocUserRoles",
  kind: "mutation" as const,
  query: `mutation revokeDocUserRoles($input: RevokeDocUserRoleInput!) {
  revokeDocUserRoles(input: $input)
}`,
};

export const revokeMemberPermissionMutation = {
  id: "revokeMemberPermissionMutation" as const,
  op: "revokeMemberPermission",
  kind: "mutation" as const,
  query: `mutation revokeMemberPermission($workspaceId: String!, $userId: String!) {
  revokeMember(workspaceId: $workspaceId, userId: $userId)
}`,
};

export const revokePublicPageMutation = {
  id: "revokePublicPageMutation" as const,
  op: "revokePublicPage",
  kind: "mutation" as const,
  query: `mutation revokePublicPage($workspaceId: String!, $pageId: String!) {
  revokePublicDoc(workspaceId: $workspaceId, docId: $pageId) {
    id
    mode
    public
  }
}`,
};

export const savedAssistantSetupsQuery = {
  id: "savedAssistantSetupsQuery" as const,
  op: "savedAssistantSetups",
  kind: "query" as const,
  query: `query savedAssistantSetups {
  currentUser {
    id
    preferences {
      ...SavedSetupPreferencesFragment
    }
  }
}
fragment SavedSetupPreferencesFragment on UserPreferencesType {
  updatedAt
  values {
    savedSetups {
      ...SavedSetupConfigurationFragment
    }
  }
}
fragment SavedSetupConfigurationFragment on SavedSetupConfiguration {
  id
  name
  context
  assistanceMode
  package {
    ...SavedAssistantSelectionFragment
  }
  project {
    ...SavedAssistantSelectionFragment
  }
  setup {
    ...SavedAssistantSelectionFragment
  }
}
fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`,
};

export const saveAssistantSetupMutation = {
  id: "saveAssistantSetupMutation" as const,
  op: "saveAssistantSetup",
  kind: "mutation" as const,
  query: `mutation saveAssistantSetup($expectedUserId: ID!, $input: SaveAssistantSetupInput!) {
  saveAssistantSetup(expectedUserId: $expectedUserId, input: $input) {
    ...SavedSetupPreferencesFragment
  }
}
fragment SavedSetupPreferencesFragment on UserPreferencesType {
  updatedAt
  values {
    savedSetups {
      ...SavedSetupConfigurationFragment
    }
  }
}
fragment SavedSetupConfigurationFragment on SavedSetupConfiguration {
  id
  name
  context
  assistanceMode
  package {
    ...SavedAssistantSelectionFragment
  }
  project {
    ...SavedAssistantSelectionFragment
  }
  setup {
    ...SavedAssistantSelectionFragment
  }
}
fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`,
};

export const deleteAssistantSetupMutation = {
  id: "deleteAssistantSetupMutation" as const,
  op: "deleteAssistantSetup",
  kind: "mutation" as const,
  query: `mutation deleteAssistantSetup($expectedUserId: ID!, $id: ID!) {
  deleteAssistantSetup(expectedUserId: $expectedUserId, id: $id) {
    ...SavedSetupPreferencesFragment
  }
}
fragment SavedSetupPreferencesFragment on UserPreferencesType {
  updatedAt
  values {
    savedSetups {
      ...SavedSetupConfigurationFragment
    }
  }
}
fragment SavedSetupConfigurationFragment on SavedSetupConfiguration {
  id
  name
  context
  assistanceMode
  package {
    ...SavedAssistantSelectionFragment
  }
  project {
    ...SavedAssistantSelectionFragment
  }
  setup {
    ...SavedAssistantSelectionFragment
  }
}
fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`,
};

export const resolveSavedAssistantSetupQuery = {
  id: "resolveSavedAssistantSetupQuery" as const,
  op: "resolveSavedAssistantSetup",
  kind: "query" as const,
  query: `query resolveSavedAssistantSetup($id: ID!) {
  currentUser {
    id
    resolveSavedAssistantSetup(id: $id) {
      configuration {
        ...SavedSetupConfigurationFragment
      }
      package {
        ...ResolvedSavedAssistantSelectionFragment
      }
      project {
        ...ResolvedSavedAssistantSelectionFragment
      }
      setup {
        ...ResolvedSavedAssistantSelectionFragment
      }
      unavailable
    }
  }
}
fragment SavedSetupConfigurationFragment on SavedSetupConfiguration {
  id
  name
  context
  assistanceMode
  package {
    ...SavedAssistantSelectionFragment
  }
  project {
    ...SavedAssistantSelectionFragment
  }
  setup {
    ...SavedAssistantSelectionFragment
  }
}
fragment SavedAssistantSelectionFragment on SavedAssistantSelection {
  packageId
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  documentSources {
    componentId
    templateId
    version
    digest
  }
  databaseSources {
    componentId
    definitionId
  }
  workflow {
    id
    version
    digest
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment ResolvedSavedAssistantSelectionFragment on ResolvedSavedAssistantSelection {
  descriptor {
    identity {
      ...AssistantPackageIdentityFragment
    }
    contexts
  }
  defaults {
    input
    value {
      ...AssistantValueFragment
    }
  }
  cleared {
    inputId
    componentId
    reason
  }
  unavailable
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}`,
};

export const searchOrganizationUnitsQuery = {
  id: "searchOrganizationUnitsQuery" as const,
  op: "searchOrganizationUnits",
  kind: "query" as const,
  query: `query searchOrganizationUnits($query: String!, $limit: Int) {
  searchOrganizationUnits(query: $query, limit: $limit) {
    id
    name
    slug
    parentBreadcrumb
  }
}`,
};

export const sendChangeEmailMutation = {
  id: "sendChangeEmailMutation" as const,
  op: "sendChangeEmail",
  kind: "mutation" as const,
  query: `mutation sendChangeEmail($callbackUrl: String!) {
  sendChangeEmail(callbackUrl: $callbackUrl)
}`,
};

export const sendChangePasswordEmailMutation = {
  id: "sendChangePasswordEmailMutation" as const,
  op: "sendChangePasswordEmail",
  kind: "mutation" as const,
  query: `mutation sendChangePasswordEmail($callbackUrl: String!) {
  sendChangePasswordEmail(callbackUrl: $callbackUrl)
}`,
};

export const sendSetPasswordEmailMutation = {
  id: "sendSetPasswordEmailMutation" as const,
  op: "sendSetPasswordEmail",
  kind: "mutation" as const,
  query: `mutation sendSetPasswordEmail($callbackUrl: String!) {
  sendSetPasswordEmail(callbackUrl: $callbackUrl)
}`,
};

export const sendVerifyChangeEmailMutation = {
  id: "sendVerifyChangeEmailMutation" as const,
  op: "sendVerifyChangeEmail",
  kind: "mutation" as const,
  query: `mutation sendVerifyChangeEmail($token: String!, $email: String!, $callbackUrl: String!) {
  sendVerifyChangeEmail(token: $token, email: $email, callbackUrl: $callbackUrl)
}`,
};

export const sendVerifyEmailMutation = {
  id: "sendVerifyEmailMutation" as const,
  op: "sendVerifyEmail",
  kind: "mutation" as const,
  query: `mutation sendVerifyEmail($callbackUrl: String!) {
  sendVerifyEmail(callbackUrl: $callbackUrl)
}`,
};

export const serverConfigQuery = {
  id: "serverConfigQuery" as const,
  op: "serverConfig",
  kind: "query" as const,
  query: `query serverConfig {
  serverConfig {
    version
    baseUrl
    name
    features
    type
    deploymentType
    initialized
    calendarProviders
    credentialsRequirement {
      ...CredentialsRequirements
    }
    client {
      downloadUrl
      clipboardHttpFallback
    }
    transcription {
      enabled
      configured
      status
      maxInputBytes
      maxDurationSeconds
    }
    preview {
      maxConcurrentRequests
      requestTimeoutMs
      retryCount
    }
    i18n {
      availableLocales
      defaultLocale
    }
  }
}
fragment CredentialsRequirements on CredentialsRequirementType {
  password {
    ...PasswordLimits
  }
}
fragment PasswordLimits on PasswordLimitsType {
  minLength
  maxLength
}`,
};

export const serverUsersQuery = {
  id: "serverUsersQuery" as const,
  op: "ServerUsers",
  kind: "query" as const,
  query: `query ServerUsers($search: String!, $skip: Int, $take: Int) {
  serverUsers(search: $search, skip: $skip, take: $take) {
    id
    name
    avatarUrl
  }
}`,
};

export const setWorkspacePublicByIdMutation = {
  id: "setWorkspacePublicByIdMutation" as const,
  op: "setWorkspacePublicById",
  kind: "mutation" as const,
  query: `mutation setWorkspacePublicById($id: String!, $public: Boolean!) {
  updateWorkspace(input: {id: $id, public: $public}) {
    id
  }
}`,
};

export const prepareTaskHandoverQuery = {
  id: "prepareTaskHandoverQuery" as const,
  op: "prepareTaskHandover",
  kind: "query" as const,
  query: `query prepareTaskHandover($workspaceId: String!, $input: PrepareTaskHandoverInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareTaskHandover(input: $input) {
      ...PreparedTaskHandoverFragment
    }
  }
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}`,
};

export const taskHandoverQuery = {
  id: "taskHandoverQuery" as const,
  op: "taskHandover",
  kind: "query" as const,
  query: `query taskHandover($workspaceId: String!, $runId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskHandover(runId: $runId) {
      ...TaskHandoverFragment
    }
  }
}
fragment TaskHandoverFragment on TaskHandover {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskHandoverFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  resultTaskId
  resultTask {
    databaseId
    rowId
  }
  resultAvailable
  sourceAvailable
  prerequisites {
    reference {
      databaseId
      rowId
    }
    available
    title
    complete
  }
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const taskHandoverRequestQuery = {
  id: "taskHandoverRequestQuery" as const,
  op: "taskHandoverRequest",
  kind: "query" as const,
  query: `query taskHandoverRequest($workspaceId: String!, $requestId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskHandoverRequest(requestId: $requestId) {
      ...TaskHandoverFragment
    }
  }
}
fragment TaskHandoverFragment on TaskHandover {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskHandoverFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  resultTaskId
  resultTask {
    databaseId
    rowId
  }
  resultAvailable
  sourceAvailable
  prerequisites {
    reference {
      databaseId
      rowId
    }
    available
    title
    complete
  }
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const startTaskHandoverMutation = {
  id: "startTaskHandoverMutation" as const,
  op: "startTaskHandover",
  kind: "mutation" as const,
  query: `mutation startTaskHandover($input: StartTaskHandoverInput!) {
  startTaskHandover(input: $input) {
    ...TaskHandoverFragment
  }
}
fragment TaskHandoverFragment on TaskHandover {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskHandoverFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  resultTaskId
  resultTask {
    databaseId
    rowId
  }
  resultAvailable
  sourceAvailable
  prerequisites {
    reference {
      databaseId
      rowId
    }
    available
    title
    complete
  }
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const stopTaskHandoverMutation = {
  id: "stopTaskHandoverMutation" as const,
  op: "stopTaskHandover",
  kind: "mutation" as const,
  query: `mutation stopTaskHandover($input: TaskHandoverRunInput!) {
  stopTaskHandover(input: $input) {
    ...TaskHandoverFragment
  }
}
fragment TaskHandoverFragment on TaskHandover {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskHandoverFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  resultTaskId
  resultTask {
    databaseId
    rowId
  }
  resultAvailable
  sourceAvailable
  prerequisites {
    reference {
      databaseId
      rowId
    }
    available
    title
    complete
  }
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const retryTaskHandoverMutation = {
  id: "retryTaskHandoverMutation" as const,
  op: "retryTaskHandover",
  kind: "mutation" as const,
  query: `mutation retryTaskHandover($input: TaskHandoverRunInput!) {
  retryTaskHandover(input: $input) {
    ...TaskHandoverFragment
  }
}
fragment TaskHandoverFragment on TaskHandover {
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskHandoverFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  resultTaskId
  resultTask {
    databaseId
    rowId
  }
  resultAvailable
  sourceAvailable
  prerequisites {
    reference {
      databaseId
      rowId
    }
    available
    title
    complete
  }
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskHandoverFragment on PreparedTaskHandover {
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  sourceDocumentId
  sourceExternalId
  prerequisites {
    databaseId
    rowId
  }
  responsibleId
  destinationDatabaseId
  title
  deadlineAt
  deadlineTimeZone
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const prepareTaskMaintenanceQuery = {
  id: "prepareTaskMaintenanceQuery" as const,
  op: "prepareTaskMaintenance",
  kind: "query" as const,
  query: `query prepareTaskMaintenance($workspaceId: String!, $input: PrepareTaskMaintenanceInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareTaskMaintenance(input: $input) {
      ...PreparedTaskMaintenanceFragment
    }
  }
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const taskMaintenanceQuery = {
  id: "taskMaintenanceQuery" as const,
  op: "taskMaintenance",
  kind: "query" as const,
  query: `query taskMaintenance($workspaceId: String!, $runId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskMaintenance(runId: $runId) {
      ...TaskMaintenanceFragment
    }
  }
}
fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const taskMaintenanceRequestQuery = {
  id: "taskMaintenanceRequestQuery" as const,
  op: "taskMaintenanceRequest",
  kind: "query" as const,
  query: `query taskMaintenanceRequest($workspaceId: String!, $requestId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskMaintenanceRequest(requestId: $requestId) {
      ...TaskMaintenanceFragment
    }
  }
}
fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const startTaskMaintenanceMutation = {
  id: "startTaskMaintenanceMutation" as const,
  op: "startTaskMaintenance",
  kind: "mutation" as const,
  query: `mutation startTaskMaintenance($input: StartTaskMaintenanceInput!) {
  startTaskMaintenance(input: $input) {
    ...TaskMaintenanceFragment
  }
}
fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const stopTaskMaintenanceMutation = {
  id: "stopTaskMaintenanceMutation" as const,
  op: "stopTaskMaintenance",
  kind: "mutation" as const,
  query: `mutation stopTaskMaintenance($input: TaskMaintenanceRunInput!) {
  stopTaskMaintenance(input: $input) {
    ...TaskMaintenanceFragment
  }
}
fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const retryTaskMaintenanceMutation = {
  id: "retryTaskMaintenanceMutation" as const,
  op: "retryTaskMaintenance",
  kind: "mutation" as const,
  query: `mutation retryTaskMaintenance($input: TaskMaintenanceRunInput!) {
  retryTaskMaintenance(input: $input) {
    ...TaskMaintenanceFragment
  }
}
fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const confirmTaskCorrectionsMutation = {
  id: "confirmTaskCorrectionsMutation" as const,
  op: "confirmTaskCorrections",
  kind: "mutation" as const,
  query: `mutation confirmTaskCorrections($input: ConfirmTaskCorrectionsInput!) {
  confirmTaskCorrections(input: $input) {
    ...TaskMaintenanceFragment
  }
}
fragment TaskMaintenanceFragment on TaskMaintenance {
  requestId
  run {
    ...WorkspaceAutomationRun
  }
  acceptedPlan {
    ...PreparedTaskMaintenanceFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  confirmation {
    requestId
    waitId
    proposalDigest
    outcome
    acceptedAt
  }
  waitId
  canConfirm
  canApply
  canDecline
  canRetry
  canStop
  reasonCode
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const taskPreparationRunQuery = {
  id: "taskPreparationRunQuery" as const,
  op: "taskPreparationRun",
  kind: "query" as const,
  query: `query taskPreparationRun($workspaceId: String!, $runId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskPreparationRun(runId: $runId) {
      ...TaskPreparationRunFragment
    }
  }
}
fragment TaskPreparationRunFragment on TaskPreparationRun {
  run {
    ...WorkspaceAutomationRun
  }
  target {
    databaseId
    rowId
  }
  documentId
  documentExternalId
  canRetry
  canStop
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}`,
};

export const retryTaskPreparationRunMutation = {
  id: "retryTaskPreparationRunMutation" as const,
  op: "retryTaskPreparationRun",
  kind: "mutation" as const,
  query: `mutation retryTaskPreparationRun($runId: ID!) {
  retryTaskPreparationRun(runId: $runId) {
    ...TaskPreparationRunFragment
  }
}
fragment TaskPreparationRunFragment on TaskPreparationRun {
  run {
    ...WorkspaceAutomationRun
  }
  target {
    databaseId
    rowId
  }
  documentId
  documentExternalId
  canRetry
  canStop
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}`,
};

export const stopTaskPreparationRunMutation = {
  id: "stopTaskPreparationRunMutation" as const,
  op: "stopTaskPreparationRun",
  kind: "mutation" as const,
  query: `mutation stopTaskPreparationRun($runId: ID!) {
  stopTaskPreparationRun(runId: $runId) {
    ...TaskPreparationRunFragment
  }
}
fragment TaskPreparationRunFragment on TaskPreparationRun {
  run {
    ...WorkspaceAutomationRun
  }
  target {
    databaseId
    rowId
  }
  documentId
  documentExternalId
  canRetry
  canStop
}
fragment WorkspaceAutomationRun on WorkspaceAutomationRunType {
  id
  automationId
  origin
  requestId
  workspaceId
  triggerType
  triggerEvent
  idempotencyKey
  status
  attemptCount
  errorCode
  errorMessage
  deadLetter
  queuedAt
  startedAt
  finishedAt
}`,
};

export const prepareTaskPreparationQuery = {
  id: "prepareTaskPreparationQuery" as const,
  op: "prepareTaskPreparation",
  kind: "query" as const,
  query: `query prepareTaskPreparation($workspaceId: String!, $input: PrepareTaskPreparationInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareTaskPreparation(input: $input) {
      ...PreparedTaskPreparationFragment
    }
  }
}
fragment PreparedTaskPreparationFragment on PreparedTaskPreparation {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`,
};

export const taskPreparationQuery = {
  id: "taskPreparationQuery" as const,
  op: "taskPreparation",
  kind: "query" as const,
  query: `query taskPreparation($workspaceId: String!, $databaseId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskPreparation(databaseId: $databaseId) {
      ...TaskPreparationConfigurationFragment
    }
  }
}
fragment TaskPreparationConfigurationFragment on TaskPreparationConfiguration {
  id
  actorId
  workspaceId
  databaseId
  executionRevision
  planDigest
  status
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`,
};

export const configureTaskPreparationMutation = {
  id: "configureTaskPreparationMutation" as const,
  op: "configureTaskPreparation",
  kind: "mutation" as const,
  query: `mutation configureTaskPreparation($input: ConfigureTaskPreparationInput!) {
  configureTaskPreparation(input: $input) {
    ...TaskPreparationConfigurationFragment
  }
}
fragment TaskPreparationConfigurationFragment on TaskPreparationConfiguration {
  id
  actorId
  workspaceId
  databaseId
  executionRevision
  planDigest
  status
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`,
};

export const prepareTaskMaintenanceRuleQuery = {
  id: "prepareTaskMaintenanceRuleQuery" as const,
  op: "prepareTaskMaintenanceRule",
  kind: "query" as const,
  query: `query prepareTaskMaintenanceRule($workspaceId: String!, $input: PrepareTaskMaintenanceInput!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    prepareTaskMaintenanceRule(input: $input) {
      ...PreparedTaskMaintenanceFragment
    }
  }
}
fragment PreparedTaskMaintenanceFragment on PreparedTaskMaintenance {
  actorId
  workspaceId
  target {
    databaseId
    taskId
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  planDigest
  proposal {
    actorId
    workspaceId
    databaseId
    digest
    tasks {
      databaseId
      rowId
    }
    findings {
      task {
        databaseId
        rowId
      }
      fieldId
      kind
    }
    patches {
      rowId
      fieldId
      oldValue {
        ...DatabaseCellValueData
      }
      value {
        ...DatabaseCellValueData
      }
      clear
      expectedEditRevision
    }
    rowPreconditions {
      rowId
      expectedEditRevision
    }
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment DatabaseCellValueData on DatabaseCellValueDataType {
  kind
  text
  richText {
    plainText
    document
  }
  number
  percent
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  files {
    files {
      blobKey
      name
      mime
      size
      caption
      cover
    }
  }
  uniqueId {
    prefix
    sequence
    display
  }
  select
  multiSelect
  tags
  status
  user
  users
  documentLink {
    docId
    workspaceId
    target {
      documentId
      externalId
      workspaceId
      state
      title
    }
  }
  relation
  relationTargets {
    rowId
    contentDocument {
      documentId
      externalId
      workspaceId
      state
      title
    }
    title
    redacted
    deleted
  }
  url
  email
  phone
  createdTime
  createdBy
  updatedTime
  updatedBy
  rollup {
    value {
      ...DatabaseRollupScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
  formula {
    value {
      ...DatabaseFormulaScalarValue
    }
    staleState
    computedAt
    failedAt
    errorCode
    errorMessage
  }
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseFormulaScalarValue on DatabaseFormulaScalarValueType {
  kind
  number
  text
  checkbox
  date {
    start
    end
  }
}`,
};

export const taskMaintenanceRuleQuery = {
  id: "taskMaintenanceRuleQuery" as const,
  op: "taskMaintenanceRule",
  kind: "query" as const,
  query: `query taskMaintenanceRule($workspaceId: String!, $databaseId: ID!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    taskMaintenanceRule(databaseId: $databaseId) {
      ...TaskPreparationConfigurationFragment
    }
  }
}
fragment TaskPreparationConfigurationFragment on TaskPreparationConfiguration {
  id
  actorId
  workspaceId
  databaseId
  executionRevision
  planDigest
  status
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`,
};

export const configureTaskMaintenanceMutation = {
  id: "configureTaskMaintenanceMutation" as const,
  op: "configureTaskMaintenance",
  kind: "mutation" as const,
  query: `mutation configureTaskMaintenance($input: ConfigureTaskPreparationInput!) {
  configureTaskMaintenance(input: $input) {
    ...TaskPreparationConfigurationFragment
  }
}
fragment TaskPreparationConfigurationFragment on TaskPreparationConfiguration {
  id
  actorId
  workspaceId
  databaseId
  executionRevision
  planDigest
  status
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  source {
    ...TaskPreparationSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment TaskPreparationSourceFragment on TaskPreparationSource {
  source {
    componentId
    templateId
    version
    digest
  }
  sourceRevisionId
  sourceRevisionDigest
  sourceContentDigest
  locale
  title
  variables {
    name
    value
  }
}`,
};

export const workspaceTemplateReconcileSlugsMutation = {
  id: "workspaceTemplateReconcileSlugsMutation" as const,
  op: "workspaceTemplateReconcileSlugs",
  kind: "mutation" as const,
  query: `mutation workspaceTemplateReconcileSlugs($workspaceId: String!, $locale: String!, $provisionSources: Boolean) {
  workspaceTemplateReconcileSlugs(
    workspaceId: $workspaceId
    locale: $locale
    provisionSources: $provisionSources
  ) {
    slug
    provisioningMode
    workspaceDocId
    instanceState
    hasInstance
  }
}`,
};

export const templateSuggestionsQuery = {
  id: "templateSuggestionsQuery" as const,
  op: "templateSuggestions",
  kind: "query" as const,
  query: `query templateSuggestions($workspaceId: String!, $input: TemplateSuggestionInput!) {
  workspace(id: $workspaceId) {
    templateSuggestions(input: $input) {
      items {
        ...TemplateSuggestionItemFields
      }
      guideDeliveries {
        slug
        documentId
        pending
      }
      pageDefaultReplacements {
        retiredSourceDocId
        replacementSourceDocId
      }
      emptyDocumentAllowed
      reconcileRequired
      stale
      hasNextPage
      endCursor
    }
  }
}
fragment TemplateSuggestionItemFields on TemplateSuggestionItem {
  templateId
  templateDocId
  slug
  title
  description
  source
  updatedAt
  category
  titlePolicy
  sourceRevisionId
  tags
  score
  reasons
  instanceState
  available
  protectedSource
}`,
};

export const updateDocDefaultRoleMutation = {
  id: "updateDocDefaultRoleMutation" as const,
  op: "updateDocDefaultRole",
  kind: "mutation" as const,
  query: `mutation updateDocDefaultRole($input: UpdateDocDefaultRoleInput!) {
  updateDocDefaultRole(input: $input)
}`,
};

export const updateDocUserRoleMutation = {
  id: "updateDocUserRoleMutation" as const,
  op: "updateDocUserRole",
  kind: "mutation" as const,
  query: `mutation updateDocUserRole($input: UpdateDocUserRoleInput!) {
  updateDocUserRole(input: $input)
}`,
};

export const updateUserPreferencesMutation = {
  id: "updateUserPreferencesMutation" as const,
  op: "updateUserPreferences",
  kind: "mutation" as const,
  query: `mutation updateUserPreferences($input: UpdateUserPreferencesInput!) {
  updatePreferences(input: $input) {
    updatedAt
    values {
      assistanceMode
      workspaceAssistanceOverrides {
        workspaceId
        mode
      }
      projectAssistanceOverrides {
        workspaceId
        projectId
        mode
      }
      locale
      defaultDocumentLanguage
      timezone
      dateFormat
      timeFormat
      receiveInvitationEmail
      receiveMentionEmail
      receiveCommentEmail
      notifyCreatedDocuments
      journalFirstDayOfWeek
      journalShowCalendarWeeks
      colorMode
      showLinkedDocuments
      imageAntialiasing
      noisyBackground
      editorFontFamily
      editorCustomFontFamily
      editorFontSize
      newDocumentMode
      fullWidthLayout
      openDocumentMode
      edgelessDefaultTheme
      telemetryEnabled
      aiModelId
      templateCatalogViews {
        workspaceId
        view
      }
      aiReasoningEnabled
      documentMetadataHeaderVisibility {
        workspaceId
        fields {
          field
          visible
        }
      }
      workbenchToolLayouts {
        workspaceId
        viewFamily
        orderedToolIds
        visibleToolIds
        collapsedToolIds
      }
      workspaceDashboardLayouts {
        workspaceId
        orderedDashletIds
        dashletSizes {
          dashletId
          size
        }
      }
    }
    effectiveValues {
      assistanceMode
      locale
      defaultDocumentLanguage
      timezone
      dateFormat
      timeFormat
      receiveInvitationEmail
      receiveMentionEmail
      receiveCommentEmail
      notifyCreatedDocuments
      journalFirstDayOfWeek
      journalShowCalendarWeeks
      colorMode
      showLinkedDocuments
      imageAntialiasing
      noisyBackground
      editorFontFamily
      editorCustomFontFamily
      editorFontSize
      newDocumentMode
      fullWidthLayout
      openDocumentMode
      edgelessDefaultTheme
      telemetryEnabled
      aiModelId
      templateCatalogViews {
        workspaceId
        view
      }
      aiReasoningEnabled
      documentMetadataHeaderVisibility {
        workspaceId
        fields {
          field
          visible
        }
      }
      workbenchToolLayouts {
        workspaceId
        viewFamily
        orderedToolIds
        visibleToolIds
        collapsedToolIds
      }
      workspaceDashboardLayouts {
        workspaceId
        orderedDashletIds
        dashletSizes {
          dashletId
          size
        }
      }
    }
  }
}`,
};

export const updateUserProfileMutation = {
  id: "updateUserProfileMutation" as const,
  op: "updateUserProfile",
  kind: "mutation" as const,
  query: `mutation updateUserProfile($input: UpdateUserInput!) {
  updateProfile(input: $input) {
    id
    name
  }
}`,
};

export const updateWorkspaceDescriptionMutation = {
  id: "updateWorkspaceDescriptionMutation" as const,
  op: "updateWorkspaceDescription",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceDescription($id: String!, $description: String!) {
  updateWorkspace(input: {id: $id, description: $description}) {
    id
    description
  }
}`,
};

export const updateWorkspaceNameMutation = {
  id: "updateWorkspaceNameMutation" as const,
  op: "updateWorkspaceName",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceName($id: String!, $name: String!) {
  updateWorkspace(input: {id: $id, name: $name}) {
    id
    name
  }
}`,
};

export const uploadAvatarMutation = {
  id: "uploadAvatarMutation" as const,
  op: "uploadAvatar",
  kind: "mutation" as const,
  query: `mutation uploadAvatar($avatar: Upload!) {
  uploadAvatar(avatar: $avatar) {
    id
    name
    avatarUrl
    email
  }
}`,
  file: true,
};

export const userLastLoginAtQuery = {
  id: "userLastLoginAtQuery" as const,
  op: "userLastLoginAt",
  kind: "query" as const,
  query: `query userLastLoginAt($userId: ID!) {
  admin {
    userLastLoginAt(userId: $userId)
  }
}`,
};

export const userOrganizationMembershipsQuery = {
  id: "userOrganizationMembershipsQuery" as const,
  op: "userOrganizationMemberships",
  kind: "query" as const,
  query: `query userOrganizationMemberships($userId: ID!) {
  admin {
    userOrganizationMemberships(userId: $userId) {
      unitId
      unitName
      unitSlug
      role
      source
      joinedAt
    }
  }
}`,
};

export const verifyEmailMutation = {
  id: "verifyEmailMutation" as const,
  op: "verifyEmail",
  kind: "mutation" as const,
  query: `mutation verifyEmail($token: String!) {
  verifyEmail(token: $token)
}`,
};

export const workspaceAssistantPackagesQuery = {
  id: "workspaceAssistantPackagesQuery" as const,
  op: "workspaceAssistantPackages",
  kind: "query" as const,
  query: `query workspaceAssistantPackages {
  currentUser {
    id
    assistantPackages(context: WorkspaceCreation) {
      ...AssistantPackageFragment
    }
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const prepareWorkspaceAssistantQuery = {
  id: "prepareWorkspaceAssistantQuery" as const,
  op: "prepareWorkspaceAssistant",
  kind: "query" as const,
  query: `query prepareWorkspaceAssistant($input: PrepareWorkspaceAssistantInput!) {
  currentUser {
    id
    prepareWorkspaceAssistant(input: $input) {
      ...PreparedWorkspaceAssistantFragment
    }
  }
}
fragment PreparedWorkspaceAssistantFragment on PreparedWorkspaceAssistant {
  ...WorkspaceCreationPlanFragment
  setup {
    ...PreparedWorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}`,
};

export const workspaceCreationQuery = {
  id: "workspaceCreationQuery" as const,
  op: "workspaceCreation",
  kind: "query" as const,
  query: `query workspaceCreation($requestId: ID!) {
  currentUser {
    id
    workspaceCreation(requestId: $requestId) {
      ...WorkspaceCreationResultFragment
    }
  }
}
fragment WorkspaceCreationResultFragment on WorkspaceCreationResultType {
  workspaceId
  requestId
  status
  rootReady
  tasksReady
  tasksDatabaseId
  assistanceSaved
  retryRequired
  reasonCode
  acceptedPlan {
    ...WorkspaceCreationPlanFragment
  }
  projectSetup {
    ...ProjectSetupFragment
  }
  setup {
    ...WorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment WorkspaceSetupFragment on WorkspaceSetup {
  requestId
  status
  canRetry
  canStop
  reasonCode
  acceptedPlan {
    ...PreparedWorkspaceSetupFragment
  }
  currentReview {
    ...PreparedWorkspaceSetupFragment
  }
  run {
    id
    status
  }
  components {
    componentId
    reservedId
    documentExternalId
    available
    result {
      kind
      databaseId
      documentId
      entryId
    }
  }
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}`,
};

export const stopWorkspaceCreationMutation = {
  id: "stopWorkspaceCreationMutation" as const,
  op: "stopWorkspaceCreation",
  kind: "mutation" as const,
  query: `mutation stopWorkspaceCreation($input: StopWorkspaceCreationInput!) {
  stopWorkspaceCreation(input: $input) {
    ...WorkspaceCreationResultFragment
  }
}
fragment WorkspaceCreationResultFragment on WorkspaceCreationResultType {
  workspaceId
  requestId
  status
  rootReady
  tasksReady
  tasksDatabaseId
  assistanceSaved
  retryRequired
  reasonCode
  acceptedPlan {
    ...WorkspaceCreationPlanFragment
  }
  projectSetup {
    ...ProjectSetupFragment
  }
  setup {
    ...WorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment WorkspaceSetupFragment on WorkspaceSetup {
  requestId
  status
  canRetry
  canStop
  reasonCode
  acceptedPlan {
    ...PreparedWorkspaceSetupFragment
  }
  currentReview {
    ...PreparedWorkspaceSetupFragment
  }
  run {
    id
    status
  }
  components {
    componentId
    reservedId
    documentExternalId
    available
    result {
      kind
      databaseId
      documentId
      entryId
    }
  }
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}`,
};

export const retryWorkspaceCreationMutation = {
  id: "retryWorkspaceCreationMutation" as const,
  op: "retryWorkspaceCreation",
  kind: "mutation" as const,
  query: `mutation retryWorkspaceCreation($input: RetryWorkspaceCreationInput!) {
  retryWorkspaceCreation(input: $input) {
    ...WorkspaceCreationResultFragment
  }
}
fragment WorkspaceCreationResultFragment on WorkspaceCreationResultType {
  workspaceId
  requestId
  status
  rootReady
  tasksReady
  tasksDatabaseId
  assistanceSaved
  retryRequired
  reasonCode
  acceptedPlan {
    ...WorkspaceCreationPlanFragment
  }
  projectSetup {
    ...ProjectSetupFragment
  }
  setup {
    ...WorkspaceSetupFragment
  }
}
fragment WorkspaceCreationPlanFragment on PreparedWorkspaceAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  name
  initialContent
  assistanceMode
  project {
    ...PreparedProjectAssistantFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment PreparedProjectAssistantFragment on PreparedProjectAssistant {
  package {
    ...AssistantPackageIdentityFragment
  }
  planDigest
  templateId
  templateVersion
  templateDigest
  locale
  clientVersion
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  title
  description
  priority
  complexity
  structure
  defaultCurrency
  includeSampleRows
  initialViewKey
  initialViewKind
  folder {
    ...AssistantFolderDestinationFragment
  }
  setup {
    goal
    scope
    startDate {
      start
      end
    }
    endDate {
      start
      end
    }
    people
    scaffold {
      id
      kind
      title {
        ...AssistantLocalizedTextFragment
      }
    }
  }
  counts {
    phases
    milestones
    sampleRows
    explicitTasks
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  executionAvailable
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment ProjectSetupFragment on ProjectSetup {
  requestId
  status
  reservedDatabaseId
  reasonCode
  folderId
  placementComplete
  documents {
    componentId
    reservedDocumentId
    externalId
    created
    placed
  }
  acceptedPlan {
    ...PreparedProjectAssistantFragment
  }
  acceptedDescriptor {
    ...AssistantPackageFragment
  }
  currentReview {
    ...PreparedProjectAssistantFragment
  }
  database {
    ...DatabaseRecord
    initialViewId
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}
fragment DatabaseRecord on DatabaseRecord {
  managedSchema {
    ...DatabaseManagedSchema
  }
  database {
    ...Database
  }
  fields {
    ...DatabaseField
  }
  views {
    ...DatabaseView
  }
  fieldRoles {
    ...DatabaseFieldRole
  }
  viewRoles {
    ...DatabaseViewRole
  }
  rowCount
}
fragment DatabaseManagedSchema on DatabaseManagedSchema {
  readiness
  reasonCode
  templateId
  templateVersion
  templateDigest
  variant {
    priority
    complexity
    structure
    currency
  }
  schemaRevision
  canEditStructure
  canEditMetadata
  canManageLifecycle
  taskBindings {
    roleKey
    fieldId
  }
}
fragment Database on DatabaseType {
  systemRole
  id
  workspaceId
  profileKind
  profileStructurePreset
  profileConfig
  title
  description
  createdBy
  updatedBy
  deletedAt
  deletedBy
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseField on DatabaseFieldType {
  id
  databaseId
  name
  fieldType
  config {
    ...DatabaseFieldConfig
  }
  position
  required
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseFieldConfig on DatabaseFieldConfigType {
  kind
  text {
    multiline
  }
  richText {
    maxPlainTextBytes
  }
  number {
    format
  }
  percent {
    minValue
    maxValue
  }
  currency {
    defaultCurrency
    allowCurrencyOverride
    minValue
    maxValue
  }
  duration {
    displayUnit
    minMinutes
    maxMinutes
  }
  users {
    minCount
    maxCount
  }
  date {
    includeTime
  }
  dateTime {
    defaultTimeZone
    allowReminders
  }
  files {
    allowedMimeCategories
    maxItemCount
    maxItemSize
    previewPolicy
  }
  uniqueId {
    prefix
    startNumber
    padding
  }
  select {
    options {
      ...DatabaseSelectOption
    }
  }
  multiSelect {
    options {
      ...DatabaseSelectOption
    }
  }
  tags {
    maxCount
  }
  status {
    options {
      ...DatabaseStatusOption
    }
    defaultOptionId
  }
  relation {
    targetDatabaseId
    allowMultiple
    reciprocalFieldId
    maxTargets
  }
  rollup {
    sourceRelationFieldId
    targetFieldId
    aggregate
    emptyValue {
      ...DatabaseRollupScalarValue
    }
    stalePolicy
  }
  formula {
    expression
    resultType
    dependencyFieldIds
    stalePolicy
    format
  }
}
fragment DatabaseSelectOption on DatabaseSelectOptionType {
  id
  name
  position
  colorRole
}
fragment DatabaseStatusOption on DatabaseStatusOptionType {
  id
  name
  position
  colorRole
  group
}
fragment DatabaseRollupScalarValue on DatabaseRollupScalarValueType {
  kind
  number
  text
  currency {
    amount
    currencyCode
  }
  duration {
    minutes
  }
  checkbox
  date {
    start
    end
  }
}
fragment DatabaseView on DatabaseViewType {
  id
  databaseId
  name
  viewKind
  icon {
    system
    emoji
  }
  config {
    ...DatabaseViewConfig
  }
  position
  editRevision
  createdAt
  updatedAt
}
fragment DatabaseViewConfig on DatabaseViewConfigType {
  kind
  table {
    titleFieldId
    visibleFieldIds
    fieldWidths {
      fieldId
      width
    }
    searchFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  kanban {
    titleFieldId
    groupFieldId
    visibleFieldIds
    coverFieldId
    cardDensity
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
  list {
    titleFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    density
    showFieldLabels
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  gallery {
    titleFieldId
    visibleFieldIds
    coverFieldId
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    cardDensity
    showEmptyCover
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  calendar {
    titleFieldId
    dateFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    dateMode
    initialRange
    group {
      ...DatabaseGroupRule
    }
    subgroup {
      ...DatabaseGroupRule
    }
  }
  timeline {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    groupBy
    order
    zoom
  }
  gantt {
    titleFieldId
    startFieldId
    endFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
    group {
      ...DatabaseGroupRule
    }
    zoom
    dependencyFieldId
  }
  progress {
    titleFieldId
    progressFieldId
    groupFieldId
    visibleFieldIds
    sort {
      ...DatabaseSortRule
    }
    filter {
      ...DatabaseFilterRule
    }
    filterTree {
      ...DatabaseFilterGroup
    }
  }
}
fragment DatabaseSortRule on DatabaseSortRuleType {
  fieldId
  direction
}
fragment DatabaseFilterRule on DatabaseFilterRuleType {
  fieldId
  operator
  value {
    kind
    value
  }
}
fragment DatabaseFilterGroup on DatabaseFilterGroupType {
  conjunction
  rules {
    ...DatabaseFilterRule
  }
  groups {
    conjunction
    rules {
      ...DatabaseFilterRule
    }
    groups {
      conjunction
      rules {
        ...DatabaseFilterRule
      }
    }
  }
}
fragment DatabaseGroupRule on DatabaseGroupRuleType {
  fieldId
  descending
  showEmptyGroups
}
fragment DatabaseFieldRole on DatabaseFieldRole {
  databaseId
  profileKind
  roleKey
  rowKindScope
  fieldId
  required
  config
  createdAt
  updatedAt
}
fragment DatabaseViewRole on DatabaseViewRole {
  databaseId
  profileKind
  roleKey
  viewId
  required
  createdAt
  updatedAt
}
fragment WorkspaceSetupFragment on WorkspaceSetup {
  requestId
  status
  canRetry
  canStop
  reasonCode
  acceptedPlan {
    ...PreparedWorkspaceSetupFragment
  }
  currentReview {
    ...PreparedWorkspaceSetupFragment
  }
  run {
    id
    status
  }
  components {
    componentId
    reservedId
    documentExternalId
    available
    result {
      kind
      databaseId
      documentId
      entryId
    }
  }
}
fragment PreparedWorkspaceSetupFragment on PreparedWorkspaceSetup {
  folder {
    ...AssistantFolderDestinationFragment
  }
  package {
    ...AssistantPackageIdentityFragment
  }
  answers {
    input
    value {
      ...AssistantValueFragment
    }
  }
  locale
  clientVersion
  executionAvailable
  workflow {
    id
    version
    digest
  }
  components {
    id
    action {
      kind
      definitionId
      templateId
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      target {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  definitions {
    componentId
    definitionId
    version
    digest
    title
    description
    includeSampleRows
    defaultCurrency
    priority
    complexity
    structure
  }
  documentMetadata {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
  documents {
    source {
      componentId
      templateId
      version
      digest
    }
    sourceRevisionId
    sourceContentDigest
    locale
    title
    folder {
      ...AssistantFolderDestinationFragment
    }
  }
}`,
};

export const workspaceSetupAssistanceQuery = {
  id: "workspaceSetupAssistanceQuery" as const,
  op: "workspaceSetupAssistance",
  kind: "query" as const,
  query: `query workspaceSetupAssistance($workspaceId: String!) {
  currentUser {
    id
  }
  workspace(id: $workspaceId) {
    id
    workspaceSetupAssistance {
      descriptor {
        ...AssistantPackageFragment
      }
      documentTargets {
        step
        group
        sourceDigest
        componentId
        documentId
        documentExternalId
      }
    }
  }
}
fragment AssistantPackageFragment on AssistantPackage {
  identity {
    ...AssistantPackageIdentityFragment
  }
  name {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  contexts
  defaultFor
  inputs {
    ...AssistantInputFragment
  }
  components {
    id
    action {
      kind
      templateId
      definitionId
      target {
        ...AssistantValueBindingFragment
      }
      inputs {
        target
        binding {
          ...AssistantValueBindingFragment
        }
      }
      selected {
        ...AssistantValueBindingFragment
      }
      tasks {
        ...AssistantValueBindingFragment
      }
      proposal {
        ...AssistantValueBindingFragment
      }
      folder {
        ...AssistantValueBindingFragment
      }
      variables {
        name
        binding {
          ...AssistantValueBindingFragment
        }
      }
    }
  }
  documentComponents {
    componentId
    templateId
    version
    digest
  }
  presentation {
    guidedHelp {
      ...AssistantStepFragment
    }
    steps {
      ...AssistantStepFragment
    }
    dialogs {
      ...AssistantDialogFragment
    }
  }
  artwork {
    ...AssistantArtworkFragment
  }
  documentSources {
    ...AssistantDocumentSourceFragment
  }
}
fragment AssistantPackageIdentityFragment on AssistantPackageIdentity {
  id
  version
  digest
}
fragment AssistantLocalizedTextFragment on AssistantLocalizedText {
  en
  de
  fr
  es
}
fragment AssistantInputFragment on AssistantInput {
  id
  target
  label {
    ...AssistantLocalizedTextFragment
  }
  description {
    ...AssistantLocalizedTextFragment
  }
  valueType
  required
  defaultValue {
    ...AssistantValueFragment
  }
  choices {
    id
    label {
      ...AssistantLocalizedTextFragment
    }
    value {
      ...AssistantValueFragment
    }
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantValueFragment on AssistantValue {
  kind
  text
  boolean
  choice
  choices
  date {
    start
    end
  }
  dateTime {
    start
    end
    allDay
    timeZone
  }
  memberIds
  databaseId
  rowId
  rowTemplateId
  documentId
  taskReferences {
    databaseId
    rowId
  }
  folder {
    ...AssistantFolderDestinationFragment
  }
  rowSelection {
    rowId
    expectedEditRevision
    cellRevisions {
      fieldId
      expectedEditRevision
    }
  }
}
fragment AssistantFolderDestinationFragment on AssistantFolderDestination {
  kind
  id
  name
  parent
}
fragment AssistantVisibilityFragment on AssistantVisibility {
  kind
  input
  value {
    ...AssistantValueFragment
  }
}
fragment AssistantValueBindingFragment on AssistantValueBinding {
  kind
  input
  context
  component
  result
  localizedText {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantStepFragment on AssistantStep {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantGroupFragment on AssistantGroup {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  role
  controls {
    ...AssistantControlFragment
  }
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantControlFragment on AssistantControl {
  kind
  input
  control
  presence
  binding {
    kind
    roleKey
    fieldKey
  }
  offsetsMinutes
  defaultOffsetMinutes
  allowCustomOffset
  value
  filter
  search
}
fragment AssistantActionFragment on AssistantAction {
  id
  label {
    ...AssistantLocalizedTextFragment
  }
  action
  component
  targetStep
  dialog
  visibleWhen {
    ...AssistantVisibilityFragment
  }
}
fragment AssistantDialogFragment on AssistantDialog {
  id
  title {
    ...AssistantLocalizedTextFragment
  }
  groups {
    ...AssistantGroupFragment
  }
  actions {
    ...AssistantActionFragment
  }
}
fragment AssistantArtworkFragment on AssistantArtwork {
  step
  group
  url
  digest
  mediaType
  width
  height
  role
  alternative {
    ...AssistantLocalizedTextFragment
  }
  caption {
    ...AssistantLocalizedTextFragment
  }
}
fragment AssistantDocumentSourceFragment on AssistantDocumentSource {
  step
  group
  templateId
  version
  digest
}`,
};

export const workspaceBlobQuotaQuery = {
  id: "workspaceBlobQuotaQuery" as const,
  op: "workspaceBlobQuota",
  kind: "query" as const,
  query: `query workspaceBlobQuota($id: String!) {
  workspace(id: $id) {
    quota {
      blobLimit
      humanReadable {
        blobLimit
      }
    }
  }
}`,
};

export const getWorkspaceConfigQuery = {
  id: "getWorkspaceConfigQuery" as const,
  op: "getWorkspaceConfig",
  kind: "query" as const,
  query: `query getWorkspaceConfig($id: String!) {
  workspace(id: $id) {
    name
    description
    public
    publicDeliveryEnabled
    publiclyAccessible
    publicDocumentSelectionCount
    enableAi
    enableSharing
    enableUrlPreview
    enableDocEmbedding
  }
}`,
};

export const workspaceContentOperationCapabilitiesQuery = {
  id: "workspaceContentOperationCapabilitiesQuery" as const,
  op: "workspaceContentOperationCapabilities",
  kind: "query" as const,
  query: `query workspaceContentOperationCapabilities($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncProfile {
      id
    }
    permissions {
      Workspace_Read
      Workspace_Organize_Update
      Workspace_Content_Transfer
    }
  }
}`,
};

export const workspaceContentPreflightMutation = {
  id: "workspaceContentPreflightMutation" as const,
  op: "workspaceContentPreflight",
  kind: "mutation" as const,
  query: `mutation workspaceContentPreflight($input: WorkspaceContentPreflightInput!) {
  workspaceContentPreflight(input: $input) {
    ...WorkspaceContentPreflightProjection
  }
}
fragment WorkspaceContentPreflightProjection on WorkspaceContentPreflightType {
  operation {
    ...WorkspaceContentOperationProjection
  }
  revision
  blockers
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
  missingResources {
    workspaceId
    kind
    id
  }
  requiredConfirmations {
    kind
    userId
    role
    resource {
      workspaceId
      kind
      id
    }
  }
  membershipImpacts {
    userId
    currentRole
    requiredRole
    requiredCapability
  }
  conflicts {
    kind
    resource {
      workspaceId
      kind
      id
    }
    suggestedName
  }
  resourceCounts {
    kind
    count
  }
  resourceCount
  membershipImpactCount
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const executeWorkspaceContentOperationMutation = {
  id: "executeWorkspaceContentOperationMutation" as const,
  op: "executeWorkspaceContentOperation",
  kind: "mutation" as const,
  query: `mutation executeWorkspaceContentOperation($input: WorkspaceContentExecuteInput!) {
  executeWorkspaceContentOperation(input: $input) {
    ...WorkspaceContentOperationProjection
  }
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const workspaceContentOperationQuery = {
  id: "workspaceContentOperationQuery" as const,
  op: "workspaceContentOperation",
  kind: "query" as const,
  query: `query workspaceContentOperation($operationId: UUID!) {
  workspaceContentOperation(operationId: $operationId) {
    ...WorkspaceContentOperationProjection
  }
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const cancelWorkspaceContentOperationMutation = {
  id: "cancelWorkspaceContentOperationMutation" as const,
  op: "cancelWorkspaceContentOperation",
  kind: "mutation" as const,
  query: `mutation cancelWorkspaceContentOperation($operationId: UUID!) {
  cancelWorkspaceContentOperation(operationId: $operationId) {
    ...WorkspaceContentOperationProjection
  }
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const retryWorkspaceContentOperationMutation = {
  id: "retryWorkspaceContentOperationMutation" as const,
  op: "retryWorkspaceContentOperation",
  kind: "mutation" as const,
  query: `mutation retryWorkspaceContentOperation($operationId: UUID!) {
  retryWorkspaceContentOperation(operationId: $operationId) {
    ...WorkspaceContentOperationProjection
  }
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const undoWorkspaceContentOperationMutation = {
  id: "undoWorkspaceContentOperationMutation" as const,
  op: "undoWorkspaceContentOperation",
  kind: "mutation" as const,
  query: `mutation undoWorkspaceContentOperation($originOperationId: UUID!, $idempotencyId: UUID!) {
  undoWorkspaceContentOperation(
    originOperationId: $originOperationId
    idempotencyId: $idempotencyId
  ) {
    ...WorkspaceContentPreflightProjection
  }
}
fragment WorkspaceContentPreflightProjection on WorkspaceContentPreflightType {
  operation {
    ...WorkspaceContentOperationProjection
  }
  revision
  blockers
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
  missingResources {
    workspaceId
    kind
    id
  }
  requiredConfirmations {
    kind
    userId
    role
    resource {
      workspaceId
      kind
      id
    }
  }
  membershipImpacts {
    userId
    currentRole
    requiredRole
    requiredCapability
  }
  conflicts {
    kind
    resource {
      workspaceId
      kind
      id
    }
    suggestedName
  }
  resourceCounts {
    kind
    count
  }
  resourceCount
  membershipImpactCount
}
fragment WorkspaceContentOperationProjection on WorkspaceContentOperationType {
  id
  kind
  sourceWorkspaceId
  targetWorkspaceId
  status
  revision
  errorCode
  errorMessage
  errorPhase
  originOperationId
  gitSyncPending
  gitSyncErrorCode
  gitSyncRetryExhausted
  gitSync {
    ...WorkspaceContentGitSyncProjection
  }
}
fragment WorkspaceContentGitSyncProjection on WorkspaceContentGitSyncPreflightType {
  choice
  isUndo
  repository
  branch
  sourceProfileId
  newRoot
  ownManifest
  intendedEnabled
}`,
};

export const workspaceContentRedirectQuery = {
  id: "workspaceContentRedirectQuery" as const,
  op: "workspaceContentRedirect",
  kind: "query" as const,
  query: `query workspaceContentRedirect($input: WorkspaceContentRedirectInput!) {
  workspaceContentRedirect(input: $input) {
    workspaceId
    kind
    id
  }
}`,
};

export const setEnableAiMutation = {
  id: "setEnableAiMutation" as const,
  op: "setEnableAi",
  kind: "mutation" as const,
  query: `mutation setEnableAi($id: String!, $enableAi: Boolean!) {
  updateWorkspace(input: {id: $id, enableAi: $enableAi}) {
    id
  }
}`,
};

export const setEnableDocEmbeddingMutation = {
  id: "setEnableDocEmbeddingMutation" as const,
  op: "setEnableDocEmbedding",
  kind: "mutation" as const,
  query: `mutation setEnableDocEmbedding($id: String!, $enableDocEmbedding: Boolean!) {
  updateWorkspace(input: {id: $id, enableDocEmbedding: $enableDocEmbedding}) {
    id
  }
}`,
};

export const setEnableSharingMutation = {
  id: "setEnableSharingMutation" as const,
  op: "setEnableSharing",
  kind: "mutation" as const,
  query: `mutation setEnableSharing($id: String!, $enableSharing: Boolean!) {
  updateWorkspace(input: {id: $id, enableSharing: $enableSharing}) {
    id
  }
}`,
};

export const setEnableUrlPreviewMutation = {
  id: "setEnableUrlPreviewMutation" as const,
  op: "setEnableUrlPreview",
  kind: "mutation" as const,
  query: `mutation setEnableUrlPreview($id: String!, $enableUrlPreview: Boolean!) {
  updateWorkspace(input: {id: $id, enableUrlPreview: $enableUrlPreview}) {
    id
  }
}`,
};

export const workspaceImportQuery = {
  id: "workspaceImportQuery" as const,
  op: "workspaceImport",
  kind: "query" as const,
  query: `query workspaceImport($workspaceImportId: ID!) {
  workspaceImport(workspaceImportId: $workspaceImportId) {
    ...WorkspaceImportProjection
  }
}
fragment WorkspaceImportProjection on WorkspaceImportType {
  id
  status
  queuedOperation
  progressStage
  progressCurrent
  progressTotal
  cancelRequested
  preview {
    detectedFormat
    sourceRoot
    proposedWorkspaceTitle
    counts {
      documents
      assets
      databases
      fields
      rows
      cells
      views
    }
    omittedCounts
    targetPlan {
      workspaceId
      documentIds
      assetIds
      databaseIds
      tagIds
      vault
    }
    diagnostics {
      code
      severity
      message
      context
    }
    sourceHash
    configFingerprint
    planFingerprint
    applyAllowed
  }
  targetWorkspaceId
  errorCode
  errorMessage
  createdAt
  updatedAt
  expiresAt
}`,
};

export const createWorkspaceImportUploadMutation = {
  id: "createWorkspaceImportUploadMutation" as const,
  op: "createWorkspaceImportUpload",
  kind: "mutation" as const,
  query: `mutation createWorkspaceImportUpload($sourceSizeBytes: Int!, $sourceHash: String!, $parts: [WorkspaceImportPartManifestInput!]!, $sourceFormat: WorkspaceImportSourceFormatInput) {
  createWorkspaceImportUpload(
    sourceSizeBytes: $sourceSizeBytes
    sourceHash: $sourceHash
    parts: $parts
    sourceFormat: $sourceFormat
  ) {
    workspaceImportId
    partSizeBytes
    expiresAt
    parts {
      partNumber
      sizeBytes
      contentHash
      uploadUrl
    }
  }
}`,
};

export const completeWorkspaceImportUploadMutation = {
  id: "completeWorkspaceImportUploadMutation" as const,
  op: "completeWorkspaceImportUpload",
  kind: "mutation" as const,
  query: `mutation completeWorkspaceImportUpload($workspaceImportId: ID!, $sourceSizeBytes: Int!, $sourceHash: String!) {
  completeWorkspaceImportUpload(
    workspaceImportId: $workspaceImportId
    sourceSizeBytes: $sourceSizeBytes
    sourceHash: $sourceHash
  ) {
    ...WorkspaceImportProjection
  }
}
fragment WorkspaceImportProjection on WorkspaceImportType {
  id
  status
  queuedOperation
  progressStage
  progressCurrent
  progressTotal
  cancelRequested
  preview {
    detectedFormat
    sourceRoot
    proposedWorkspaceTitle
    counts {
      documents
      assets
      databases
      fields
      rows
      cells
      views
    }
    omittedCounts
    targetPlan {
      workspaceId
      documentIds
      assetIds
      databaseIds
      tagIds
      vault
    }
    diagnostics {
      code
      severity
      message
      context
    }
    sourceHash
    configFingerprint
    planFingerprint
    applyAllowed
  }
  targetWorkspaceId
  errorCode
  errorMessage
  createdAt
  updatedAt
  expiresAt
}`,
};

export const previewWorkspaceImportMutation = {
  id: "previewWorkspaceImportMutation" as const,
  op: "previewWorkspaceImport",
  kind: "mutation" as const,
  query: `mutation previewWorkspaceImport($workspaceImportId: ID!) {
  previewWorkspaceImport(workspaceImportId: $workspaceImportId) {
    ...WorkspaceImportProjection
  }
}
fragment WorkspaceImportProjection on WorkspaceImportType {
  id
  status
  queuedOperation
  progressStage
  progressCurrent
  progressTotal
  cancelRequested
  preview {
    detectedFormat
    sourceRoot
    proposedWorkspaceTitle
    counts {
      documents
      assets
      databases
      fields
      rows
      cells
      views
    }
    omittedCounts
    targetPlan {
      workspaceId
      documentIds
      assetIds
      databaseIds
      tagIds
      vault
    }
    diagnostics {
      code
      severity
      message
      context
    }
    sourceHash
    configFingerprint
    planFingerprint
    applyAllowed
  }
  targetWorkspaceId
  errorCode
  errorMessage
  createdAt
  updatedAt
  expiresAt
}`,
};

export const applyWorkspaceImportMutation = {
  id: "applyWorkspaceImportMutation" as const,
  op: "applyWorkspaceImport",
  kind: "mutation" as const,
  query: `mutation applyWorkspaceImport($workspaceImportId: ID!) {
  applyWorkspaceImport(workspaceImportId: $workspaceImportId) {
    ...WorkspaceImportProjection
  }
}
fragment WorkspaceImportProjection on WorkspaceImportType {
  id
  status
  queuedOperation
  progressStage
  progressCurrent
  progressTotal
  cancelRequested
  preview {
    detectedFormat
    sourceRoot
    proposedWorkspaceTitle
    counts {
      documents
      assets
      databases
      fields
      rows
      cells
      views
    }
    omittedCounts
    targetPlan {
      workspaceId
      documentIds
      assetIds
      databaseIds
      tagIds
      vault
    }
    diagnostics {
      code
      severity
      message
      context
    }
    sourceHash
    configFingerprint
    planFingerprint
    applyAllowed
  }
  targetWorkspaceId
  errorCode
  errorMessage
  createdAt
  updatedAt
  expiresAt
}`,
};

export const cancelWorkspaceImportMutation = {
  id: "cancelWorkspaceImportMutation" as const,
  op: "cancelWorkspaceImport",
  kind: "mutation" as const,
  query: `mutation cancelWorkspaceImport($workspaceImportId: ID!) {
  cancelWorkspaceImport(workspaceImportId: $workspaceImportId) {
    ...WorkspaceImportProjection
  }
}
fragment WorkspaceImportProjection on WorkspaceImportType {
  id
  status
  queuedOperation
  progressStage
  progressCurrent
  progressTotal
  cancelRequested
  preview {
    detectedFormat
    sourceRoot
    proposedWorkspaceTitle
    counts {
      documents
      assets
      databases
      fields
      rows
      cells
      views
    }
    omittedCounts
    targetPlan {
      workspaceId
      documentIds
      assetIds
      databaseIds
      tagIds
      vault
    }
    diagnostics {
      code
      severity
      message
      context
    }
    sourceHash
    configFingerprint
    planFingerprint
    applyAllowed
  }
  targetWorkspaceId
  errorCode
  errorMessage
  createdAt
  updatedAt
  expiresAt
}`,
};

export const inviteByEmailsMutation = {
  id: "inviteByEmailsMutation" as const,
  op: "inviteByEmails",
  kind: "mutation" as const,
  query: `mutation inviteByEmails($workspaceId: String!, $emails: [String!]!) {
  inviteMembers(workspaceId: $workspaceId, emails: $emails) {
    email
    inviteId
    sentSuccess
  }
}`,
};

export const acceptInviteByInviteIdMutation = {
  id: "acceptInviteByInviteIdMutation" as const,
  op: "acceptInviteByInviteId",
  kind: "mutation" as const,
  query: `mutation acceptInviteByInviteId($workspaceId: String!, $inviteId: String!) {
  acceptInviteById(workspaceId: $workspaceId, inviteId: $inviteId)
}`,
};

export const createInviteLinkMutation = {
  id: "createInviteLinkMutation" as const,
  op: "createInviteLink",
  kind: "mutation" as const,
  query: `mutation createInviteLink($workspaceId: String!, $expireTime: WorkspaceInviteLinkExpireTime!) {
  createInviteLink(workspaceId: $workspaceId, expireTime: $expireTime) {
    link
    expireTime
  }
}`,
};

export const revokeInviteLinkMutation = {
  id: "revokeInviteLinkMutation" as const,
  op: "revokeInviteLink",
  kind: "mutation" as const,
  query: `mutation revokeInviteLink($workspaceId: String!) {
  revokeInviteLink(workspaceId: $workspaceId)
}`,
};

export const approveWorkspaceMemberMutation = {
  id: "approveWorkspaceMemberMutation" as const,
  op: "approveWorkspaceMember",
  kind: "mutation" as const,
  query: `mutation approveWorkspaceMember($workspaceId: String!, $userId: String!) {
  approveMember(workspaceId: $workspaceId, userId: $userId)
}`,
};

export const grantWorkspaceMemberMutation = {
  id: "grantWorkspaceMemberMutation" as const,
  op: "grantWorkspaceMember",
  kind: "mutation" as const,
  query: `mutation grantWorkspaceMember($workspaceId: String!, $userId: String!, $permission: Permission!) {
  grantMember(workspaceId: $workspaceId, userId: $userId, permission: $permission)
}`,
};

export const workspaceOverviewQuery = {
  id: "workspaceOverviewQuery" as const,
  op: "workspaceOverview",
  kind: "query" as const,
  query: `query workspaceOverview($id: String!, $folderId: String, $first: Int = 50, $offset: Int = 0) {
  workspace(id: $id) {
    id
    overview(folderId: $folderId, first: $first, offset: $offset) {
      registerPresentation {
        ...workspaceOverviewRegisterPresentationFields
      }
      documentCount
      limit
      offset
      hasMore
      folder {
        id
        name
      }
      breadcrumbs {
        id
        name
      }
      children {
        id
        name
      }
      introduction {
        resource {
          workspaceId
          kind
          id
        }
        title
        updatedAt
        canEdit
      }
      introductionUnavailable
      documents {
        metadata {
          ...DocumentMetadataIndexFields
        }
        metadataLabels {
          statusLabel
          documentTypeLabel
          versionLabel
          classificationLabel
        }
        createdAt
        createdByName
        tags {
          ...WorkspaceTagFields
        }
        resource {
          workspaceId
          kind
          id
        }
        title
        updatedAt
        canEdit
      }
    }
  }
}
fragment workspaceOverviewRegisterPresentationFields on WorkspaceOverviewRegisterPresentationType {
  displayProperties
  orderBy {
    type
    key
    desc
  }
}
fragment DocumentMetadataIndexFields on DocumentMetadataIndexRowType {
  docId
  externalId
  createdBy
  updatedBy
  journalDate
  isTemplate
  templateState
  templateOrigin
  templateCategory
  templateTags
  primaryMode
  pageWidth
  edgelessColorTheme
  integrationType
  canPublish
  statusId
  documentTypeId
  currentVersionId
  dirtySinceCurrentVersion
  reviewDueAt
  validUntil
  classificationId
  tagIds
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const workspaceOverviewSettingsQuery = {
  id: "workspaceOverviewSettingsQuery" as const,
  op: "workspaceOverviewSettings",
  kind: "query" as const,
  query: `query workspaceOverviewSettings($id: String!) {
  workspace(id: $id) {
    id
    overviewSettings {
      ...workspaceOverviewSettingsFields
    }
  }
}
fragment workspaceOverviewSettingsFields on WorkspaceOverviewSettingsType {
  revision
  introduction {
    workspaceId
    kind
    id
  }
  folderIds
  registerPresentation {
    ...workspaceOverviewRegisterPresentationFields
  }
  folders {
    folderId
    introduction {
      workspaceId
      kind
      id
    }
    registerPresentation {
      ...workspaceOverviewRegisterPresentationFields
    }
  }
}
fragment workspaceOverviewRegisterPresentationFields on WorkspaceOverviewRegisterPresentationType {
  displayProperties
  orderBy {
    type
    key
    desc
  }
}`,
};

export const updateWorkspaceOverviewMutation = {
  id: "updateWorkspaceOverviewMutation" as const,
  op: "updateWorkspaceOverview",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceOverview($input: UpdateWorkspaceInput!) {
  updateWorkspace(input: $input) {
    id
    overviewSettings {
      ...workspaceOverviewSettingsFields
    }
  }
}
fragment workspaceOverviewSettingsFields on WorkspaceOverviewSettingsType {
  revision
  introduction {
    workspaceId
    kind
    id
  }
  folderIds
  registerPresentation {
    ...workspaceOverviewRegisterPresentationFields
  }
  folders {
    folderId
    introduction {
      workspaceId
      kind
      id
    }
    registerPresentation {
      ...workspaceOverviewRegisterPresentationFields
    }
  }
}
fragment workspaceOverviewRegisterPresentationFields on WorkspaceOverviewRegisterPresentationType {
  displayProperties
  orderBy {
    type
    key
    desc
  }
}`,
};

export const workspaceQuotaQuery = {
  id: "workspaceQuotaQuery" as const,
  op: "workspaceQuota",
  kind: "query" as const,
  query: `query workspaceQuota($id: String!) {
  workspace(id: $id) {
    quota {
      name
      blobLimit
      storageQuota
      usedStorageQuota
      historyPeriod
      memberLimit
      memberCount
      overcapacityMemberCount
      humanReadable {
        name
        blobLimit
        storageQuota
        historyPeriod
        memberLimit
        memberCount
        overcapacityMemberCount
      }
    }
  }
}`,
};

export const getWorkspaceRolePermissionsQuery = {
  id: "getWorkspaceRolePermissionsQuery" as const,
  op: "getWorkspaceRolePermissions",
  kind: "query" as const,
  query: `query getWorkspaceRolePermissions($id: String!) {
  workspaceRolePermissions(id: $id) {
    permissions {
      Workspace_Administrators_Manage
      Workspace_Blobs_List
      Workspace_Blobs_Read
      Workspace_Blobs_Write
      Workspace_Copilot
      Workspace_CreateDoc
      Workspace_Delete
      Workspace_Organize_Read
      Workspace_Properties_Create
      Workspace_Properties_Delete
      Workspace_Properties_Read
      Workspace_Properties_Update
      Workspace_Read
      Workspace_Settings_Read
      Workspace_Settings_Update
      Workspace_Sync
      Workspace_TransferOwner
      Workspace_Users_Manage
      Workspace_Users_Read
    }
  }
}`,
};

export const workspaceTagCatalogQuery = {
  id: "workspaceTagCatalogQuery" as const,
  op: "workspaceTagCatalog",
  kind: "query" as const,
  query: `query workspaceTagCatalog($workspaceId: String!, $includeArchived: Boolean) {
  workspace(id: $workspaceId) {
    workspaceTagCatalog(includeArchived: $includeArchived) {
      tag {
        ...WorkspaceTagFields
      }
      documentCount
      databaseRowCount
    }
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const workspaceTagsQuery = {
  id: "workspaceTagsQuery" as const,
  op: "workspaceTags",
  kind: "query" as const,
  query: `query workspaceTags($workspaceId: String!, $includeArchived: Boolean) {
  workspace(id: $workspaceId) {
    workspaceTags(includeArchived: $includeArchived) {
      ...WorkspaceTagFields
    }
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const workspaceTagQuery = {
  id: "workspaceTagQuery" as const,
  op: "workspaceTag",
  kind: "query" as const,
  query: `query workspaceTag($workspaceId: String!, $tagId: ID!) {
  workspace(id: $workspaceId) {
    workspaceTag(tagId: $tagId) {
      ...WorkspaceTagFields
    }
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const resolveWorkspaceTagsQuery = {
  id: "resolveWorkspaceTagsQuery" as const,
  op: "resolveWorkspaceTags",
  kind: "query" as const,
  query: `query resolveWorkspaceTags($workspaceId: String!, $tagIds: [ID!]!) {
  workspace(id: $workspaceId) {
    resolveWorkspaceTags(tagIds: $tagIds) {
      ...WorkspaceTagFields
    }
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const documentWorkspaceTagIdsQuery = {
  id: "documentWorkspaceTagIdsQuery" as const,
  op: "documentWorkspaceTagIds",
  kind: "query" as const,
  query: `query documentWorkspaceTagIds($workspaceId: String!, $docId: ID!) {
  workspace(id: $workspaceId) {
    documentWorkspaceTagIds(docId: $docId)
  }
}`,
};

export const workspaceTagDatabaseRowUsagesQuery = {
  id: "workspaceTagDatabaseRowUsagesQuery" as const,
  op: "workspaceTagDatabaseRowUsages",
  kind: "query" as const,
  query: `query workspaceTagDatabaseRowUsages($workspaceId: String!, $tagId: ID!, $first: Int, $offset: Int) {
  workspace(id: $workspaceId) {
    workspaceTagDatabaseRowUsages(tagId: $tagId, first: $first, offset: $offset) {
      databaseId
      databaseTitle
      rowId
      rowTitle
      updatedAt
    }
  }
}`,
};

export const createWorkspaceTagMutation = {
  id: "createWorkspaceTagMutation" as const,
  op: "createWorkspaceTag",
  kind: "mutation" as const,
  query: `mutation createWorkspaceTag($input: CreateWorkspaceTagInput!) {
  createWorkspaceTag(input: $input) {
    ...WorkspaceTagFields
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const renameWorkspaceTagMutation = {
  id: "renameWorkspaceTagMutation" as const,
  op: "renameWorkspaceTag",
  kind: "mutation" as const,
  query: `mutation renameWorkspaceTag($input: RenameWorkspaceTagInput!) {
  renameWorkspaceTag(input: $input) {
    ...WorkspaceTagFields
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const recolorWorkspaceTagMutation = {
  id: "recolorWorkspaceTagMutation" as const,
  op: "recolorWorkspaceTag",
  kind: "mutation" as const,
  query: `mutation recolorWorkspaceTag($input: RecolorWorkspaceTagInput!) {
  recolorWorkspaceTag(input: $input) {
    ...WorkspaceTagFields
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const updateWorkspaceTagDescriptionMutation = {
  id: "updateWorkspaceTagDescriptionMutation" as const,
  op: "updateWorkspaceTagDescription",
  kind: "mutation" as const,
  query: `mutation updateWorkspaceTagDescription($input: UpdateWorkspaceTagDescriptionInput!) {
  updateWorkspaceTagDescription(input: $input) {
    ...WorkspaceTagFields
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const archiveWorkspaceTagMutation = {
  id: "archiveWorkspaceTagMutation" as const,
  op: "archiveWorkspaceTag",
  kind: "mutation" as const,
  query: `mutation archiveWorkspaceTag($input: WorkspaceTagLifecycleInput!) {
  archiveWorkspaceTag(input: $input) {
    ...WorkspaceTagFields
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const restoreWorkspaceTagMutation = {
  id: "restoreWorkspaceTagMutation" as const,
  op: "restoreWorkspaceTag",
  kind: "mutation" as const,
  query: `mutation restoreWorkspaceTag($input: WorkspaceTagLifecycleInput!) {
  restoreWorkspaceTag(input: $input) {
    ...WorkspaceTagFields
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const deleteWorkspaceTagPermanentlyMutation = {
  id: "deleteWorkspaceTagPermanentlyMutation" as const,
  op: "deleteWorkspaceTagPermanently",
  kind: "mutation" as const,
  query: `mutation deleteWorkspaceTagPermanently($input: WorkspaceTagLifecycleInput!) {
  deleteWorkspaceTagPermanently(input: $input)
}`,
};

export const setDocumentWorkspaceTagsMutation = {
  id: "setDocumentWorkspaceTagsMutation" as const,
  op: "setDocumentWorkspaceTags",
  kind: "mutation" as const,
  query: `mutation setDocumentWorkspaceTags($input: SetDocumentWorkspaceTagsInput!) {
  setDocumentWorkspaceTags(input: $input)
}`,
};

export const bootstrapWorkspaceTagsMutation = {
  id: "bootstrapWorkspaceTagsMutation" as const,
  op: "bootstrapWorkspaceTags",
  kind: "mutation" as const,
  query: `mutation bootstrapWorkspaceTags($input: BootstrapWorkspaceTagsInput!) {
  bootstrapWorkspaceTags(input: $input) {
    tags {
      ...WorkspaceTagFields
    }
    legacyIdMappings {
      legacyId
      tagId
    }
    colorNormalizations {
      legacyId
      sourceColor
      colorRole
      normalized
    }
    importedTags
    reusedTags
    importedAssignments
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const documentWorkspaceTagAssignmentsQuery = {
  id: "documentWorkspaceTagAssignmentsQuery" as const,
  op: "documentWorkspaceTagAssignments",
  kind: "query" as const,
  query: `query documentWorkspaceTagAssignments($workspaceId: String!, $externalIds: [ID!]!) {
  workspace(id: $workspaceId) {
    id
    documentWorkspaceTagAssignments(externalIds: $externalIds) {
      externalId
      tagIds
    }
  }
}`,
};

export const workspaceTagDocumentUsagesQuery = {
  id: "workspaceTagDocumentUsagesQuery" as const,
  op: "workspaceTagDocumentUsages",
  kind: "query" as const,
  query: `query workspaceTagDocumentUsages($workspaceId: String!, $tagId: ID!, $first: Int, $offset: Int) {
  workspace(id: $workspaceId) {
    id
    workspaceTagDocumentUsages(tagId: $tagId, first: $first, offset: $offset) {
      items {
        externalId
        title
      }
      nextOffset
    }
  }
}`,
};

export const importWorkspaceTagsMutation = {
  id: "importWorkspaceTagsMutation" as const,
  op: "importWorkspaceTags",
  kind: "mutation" as const,
  query: `mutation importWorkspaceTags($input: ImportWorkspaceTagsInput!) {
  importWorkspaceTags(input: $input) {
    tags {
      ...WorkspaceTagFields
    }
    mappings
    diagnostics
  }
}
fragment WorkspaceTagFields on WorkspaceTag {
  id
  workspaceId
  name
  slug
  colorRole
  description
  archived
  archivedAt
  createdAt
  updatedAt
}`,
};

export const exportWorkspaceTagsQuery = {
  id: "exportWorkspaceTagsQuery" as const,
  op: "exportWorkspaceTags",
  kind: "query" as const,
  query: `query exportWorkspaceTags($workspaceId: String!, $externalIds: [ID!]!) {
  workspace(id: $workspaceId) {
    id
    exportWorkspaceTags(externalIds: $externalIds)
  }
}`,
};

export const workspaceTemplateContextQuery = {
  id: "workspaceTemplateContextQuery" as const,
  op: "workspaceTemplateContext",
  kind: "query" as const,
  query: `query workspaceTemplateContext($workspaceId: String!, $organization: Boolean!, $ownerUnit: Boolean!) {
  workspace(id: $workspaceId) {
    id
    templateContext {
      organizationName @include(if: $organization)
      organizationUnitName @include(if: $ownerUnit)
    }
  }
}`,
};

export const workspaceTemplateValuesQuery = {
  id: "workspaceTemplateValuesQuery" as const,
  op: "workspaceTemplateValues",
  kind: "query" as const,
  query: `query workspaceTemplateValues($workspaceId: String!, $requested: [String!]!, $targetDocId: String, $folderId: String, $parentDocId: String, $deferCreation: Boolean! = false) {
  workspace(id: $workspaceId) {
    templateContext {
      requestedValues(
        requested: $requested
        targetDocId: $targetDocId
        folderId: $folderId
        parentDocId: $parentDocId
        deferCreation: $deferCreation
      )
    }
  }
}`,
};
