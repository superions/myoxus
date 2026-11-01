#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Named-slice orchestrator for the Mantine/Facade/CSS/Typography migration.
# Keep repeated path lists, focused test presets and stable visual harness
# arguments here so migration work uses reviewed slice names instead of
# reassembling long, error-prone command lines by hand.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

ACTION="audit"
SLICE=""
TOP_LIMIT="${MYOXUS_FRONTEND_MIGRATION_SCOPE_TOP_LIMIT:-40}"
REVIEW_LOOPS="${MYOXUS_FRONTEND_MIGRATION_REVIEW_LOOPS:-3}"
EXTRA_ARGS=()

SCOPE_PATHS=()
CHECK_ARGS=()
VISUAL_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-slice.sh --slice <name> [--action <action>] [options]
  build/scripts/server/frontend-migration-slice.sh --action audit
  build/scripts/server/frontend-migration-slice.sh --action status
  build/scripts/server/frontend-migration-slice.sh --list

Actions:
  status      Print the global migration status snapshot.
  audit       Run the reviewed CSS/typography/import scope audit for the slice,
              or the global migration status snapshot when no slice is given.
  check       Run the reviewed focused tests and shared migration gates.
  visual      Run the stable visual harness configured for the slice.
  context     Print bounded context for the slice before editing.
  cycle       Run status, focused checks, optional stable visual evidence and status.
  review      Run audit/check/visual review loops for the named slice.
  paths       Print the reviewed scope paths for the named slice.
  all         Run audit, then cycle.

Options:
  --slice <name>       Named migration slice. Required for slice actions.
                       Global status/audit intentionally work without it.
  --action <action>    One of status, audit, check, visual, context, cycle,
                       review, paths or all. Default: audit.
  --top-limit <n>      Forwarded to status/audit output where supported.
  --loops <n>          Review loop count for --action review. Default: 3.
  --list               Print known slices and exit.
  --help, -h           Show this help.
  --                   Forward remaining arguments to the selected low-level
                       helper. Use this for temporary extra vitest/visual flags
                       after the named slice already supplies the stable core.

Known slices:
  admin-global        Admin global CSS, shared font import, Facade toast and
                       PageContentRail motion ownership.
  properties           Database/property editor and workspace-property cluster.
  import-dialogs       Workspace import and import-template dialog cluster.
  workspace-transfer-dialogs
                       Enable-cloud dialog and server-selector cluster.
  auth-pages           Auth routes and sign-in form/page cluster.
  app-container        App shell root, main region and workbench root chrome.
  document-header      Workspace document detail header chrome and responsive
                       priority facade slice.
  editor-backlinks-panel
                       Editor bidirectional links/backlinks panel facade slice.
  editor-starter-bar   Empty document starter action bar facade slice.
  legacy-header        Retired pure/header and header-drop-down wrapper cleanup
                       with direct Facade IconButton document-menu trigger.
  electron-onboarding  Electron first-run onboarding visual and contract slice.
  error-boundary       Core error detail facade slice and retired HelpIsland
                       cleanup guard.
  page-list-residual   Residual page-list virtualized row/link/action chrome.
  peek-view-media      Peek modal, image lightbox and attachment viewer media chrome.
  workspace-detail-journal
                       Workspace detail, right-sidebar journal and mobile
                       detail chrome cluster.
  workspace-preference-share
                       Workspace settings preference and public share chrome.
  pdf-views            Shared PDF renderer views and PDF preview facade roles.
  split-view           Workbench split-view chrome slice.
  find-in-page         Electron Find-in-Page overlay slice.
  mobile-doc-card     Mobile document card and tag chip facade slice.
  mobile-doc-rail     Shared mobile horizontal document rail facade slice.
  mobile-navigation   Desktop/mobile navigation tree, section and add-item
                       facade slice.
  mobile-search       Mobile Search route/input/result chrome facade slice.
  mobile-selector      Mobile generic selector facade slice.
  mobile-config-modal  Shared mobile ConfigModal shell and row/group chrome.
  notifications        Transient toast notifications consolidated on Mantine
                       Notifications via @myoxus/ui-facade. Owns the Facade
                       notify bridge, the editor NotificationService bridge,
                       and the deletion of the legacy React toaster and the
                       Virgultum Lit toast renderer.

Examples:
  yarn frontend:migration:slice --slice properties --action audit --top-limit=30
  yarn frontend:migration:slice --slice properties --action context
  yarn frontend:migration:slice --slice admin-global --action review --loops=3
  yarn frontend:migration:slice --slice properties --action check
  yarn frontend:migration:slice --slice auth-pages --action review --loops=3
  yarn frontend:migration:slice --slice app-container --action check
  yarn frontend:migration:slice --slice editor-backlinks-panel --action check
  yarn frontend:migration:slice --slice editor-starter-bar --action check
  yarn frontend:migration:slice --slice electron-onboarding --action cycle
  yarn frontend:migration:slice --slice error-boundary --action check
  yarn frontend:migration:slice --slice mobile-config-modal --action check
  yarn frontend:migration:slice --slice mobile-doc-card --action check
  yarn frontend:migration:slice --slice mobile-doc-rail --action check
  yarn frontend:migration:slice --slice mobile-search --action check
  yarn frontend:migration:slice --slice page-list-residual --action review --loops=3
  yarn frontend:migration:slice --slice workspace-detail-journal --action audit
  yarn frontend:migration:slice --slice peek-view-media --action check
  yarn frontend:migration:slice --slice pdf-views --action review --loops=3

If a migration step starts repeating but is not covered by a known slice, add
the slice here first. The lower-level wrappers remain the source of truth for
actual checks; this file owns only stable orchestration metadata.
EOF
}

fail() {
  echo "[FAIL] $*" >&2
  exit 2
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || fail "$option requires a value"
}

list_slices() {
  cat <<'EOF'
admin-global
properties
import-dialogs
workspace-transfer-dialogs
auth-pages
app-container
document-header
editor-backlinks-panel
editor-starter-bar
legacy-header
electron-onboarding
error-boundary
page-list-residual
peek-view-media
workspace-detail-journal
workspace-preference-share
pdf-views
split-view
find-in-page
mobile-doc-card
mobile-doc-rail
mobile-navigation
mobile-search
mobile-selector
mobile-config-modal
notifications
EOF
}

set_slice() {
  case "$1" in
    admin-global|admin-global-css)
      SCOPE_PATHS=(
        "client/admin/workspaces/admin/src/global.css"
        "client/admin/workspaces/admin/src/setup.ts"
        "client/admin/workspaces/admin/src/__tests__"
        "client/admin/workspaces/admin/src/modules/admin-facade-usage-contract.spec.ts"
        "client/admin/workspaces/admin/src/modules/admin-retired-css-contract.spec.ts"
        "client/admin/workspaces/admin/src/modules/admin-visual-contract.spec.ts"
        "client/admin/workspaces/admin/src/modules/dashboard/index.spec.tsx"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/page-shell.css"
        "client/libs/ui-facade/src/toast.css"
        "client/libs/theme/src/style.css"
      )
      CHECK_ARGS=(--preset admin-global)
      VISUAL_ARGS=(
        --url=/adminfrontend/
        --name=admin-global-facade
        '--wait-selector=[data-admin-shell]'
        '--require-probe=shell=[data-admin-shell]'
        '--require-probe=scrollRail=[data-myoxus-ui-role="admin-page-scroll-rail"]'
        '--require-probe=metricCards=[data-myoxus-ui-role="dashboard-metric-card"]'
        '--expect-zero=legacyOrgClasses=[class*="org-"]'
        '--expect-zero=adminUiUtilityClasses=[class*="admin-ui-"]'
      )
      ;;
    properties|property-cluster)
      SCOPE_PATHS=(
        "client/libs/core/src/editor/database-block/properties"
        "client/libs/core/src/components/properties"
        "client/libs/core/src/components/workspace-property-types"
      )
      CHECK_ARGS=(--preset properties)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/settings?tab=workspace:properties
        --name=workspace-properties-facade
        --wait-selector='[data-testid="workspace-properties-panel"]'
        '--probe=panel=[data-testid="workspace-properties-panel"]'
        '--probe=rows=[data-testid="doc-property-manager-item"]'
        '--probe=dialog=[role="dialog"]'
        '--expect-zero=legacyWorkspacePropertyCss=[class*="workspace-property-types"]'
        '--expect-zero=legacyPropertyManagerCss=[class*="properties-manager-styles"]'
        '--expect-zero=legacyPropertyIconCss=[class*="properties-icons-icons-selector"]'
        '--expect-zero=legacyPropertyRadioCss=[class*="properties-widgets-radio-group"]'
        '--expect-zero=legacyDatabasePropertyCss=[class*="database-block-properties"]'
      )
      ;;
    import-dialogs|import-dialog-cluster)
      SCOPE_PATHS=(
        "client/libs/core/src/desktop/dialogs/import"
        "client/libs/core/src/desktop/dialogs/import-template"
        "client/libs/core/src/desktop/dialogs/import-workspace"
      )
      CHECK_ARGS=(--preset import-dialogs)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/all
        --name=import-dialogs-facade
        '--wait-selector=[data-testid="new-page-button-menu-trigger"]'
        '--click-selector=[data-testid="new-page-button-menu-trigger"]'
        '--click-selector=[data-testid="import-button-in-all-page"]'
        '--post-interaction-wait-selector=[data-testid="import-dialog"]'
        '--probe=importDialog=[data-testid="import-dialog"]'
        '--probe=importRows=[data-testid^="editor-option-menu-import-"]'
        '--expect-zero=legacyImportDialogCss=[class*="desktop-dialogs-import"]'
      )
      ;;
    workspace-transfer-dialogs|workspace-transfer-dialog-cluster)
      SCOPE_PATHS=(
        "client/libs/core/src/components/server-selector"
        "client/libs/core/src/desktop/dialogs/enable-cloud"
      )
      CHECK_ARGS=(--preset workspace-transfer-dialogs)
      ;;
    auth-pages|auth-page-cluster)
      SCOPE_PATHS=(
        "client/libs/core/src/components/sign-in"
        "client/libs/core/src/desktop/pages/auth"
      )
      CHECK_ARGS=(--preset auth-pages)
      VISUAL_ARGS=(
        --url=/auth/onboarding
        --name=auth-questionnaire-facade
        --auth
        '--wait-selector=[data-myoxus-ui-role="auth-questionnaire-shell"]'
        '--probe=shell=[data-myoxus-ui-role="auth-questionnaire-shell"]'
        '--probe=step=[data-myoxus-ui-role="auth-questionnaire-step"],[data-myoxus-ui-role="auth-questionnaire-thanks"]'
        '--probe=actions=[data-myoxus-ui-role="auth-questionnaire-actions"]'
        '--expect-zero=legacyAuthCss=[class*="myoxus-auth-onboarding"],[class*="myoxus-auth-flow"]'
      )
      ;;
    app-container|app-shell-container)
      SCOPE_PATHS=(
        "client/libs/core/src/desktop/components/app-container"
        "client/libs/core/src/modules/workbench/view/workbench-root.tsx"
        "client/libs/core/src/modules/workbench/view/workbench-root.css"
        "client/libs/core/src/modules/workbench/view/workbench-root.styles.ts"
        "client/libs/ui-facade/src/app-shell.spec.tsx"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/page-shell.css"
        "client/libs/ui-facade/src/split-view.css"
      )
      CHECK_ARGS=(--preset app-container)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/all
        --name=app-container-facade
        '--wait-selector=[data-testid="main-container"]'
        '--require-probe=appRoot=[data-myoxus-ui-role="app-container-root"]'
        '--require-probe=main=[data-testid="main-container"][data-myoxus-ui-role="app-main"]'
        '--require-probe=workbenchRoot=[data-myoxus-ui-role="workbench-root-container"]'
        '--expect-zero=legacyAppContainerCss=[class*="desktop-components-app-container-styles"]'
        '--expect-zero=legacyWorkbenchRootCss=[class*="workbench-view-workbench-root"]'
      )
      ;;
    document-header|workspace-document-header)
      SCOPE_PATHS=(
        "client/libs/core/src/desktop/pages/workspace/detail-page"
        "client/libs/core/src/editor/virgultum/doc-header/menu/index.tsx"
        "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
        "client/libs/core/src/desktop/pages/workspace/workspace-page-header-facade-contract.spec.ts"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/page-shell.css"
      )
      CHECK_ARGS=(--preset document-header)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/22e7f897-09d8-5fbe-ae85-80b8e2148561
        --name=document-header-facade
        '--wait-selector=[data-myoxus-ui-role="workbench-document-header-bar"]'
        '--require-probe=header=[data-myoxus-ui-role="workbench-document-header-bar"]'
        '--require-probe=dragRoot=[data-myoxus-ui-role="workbench-document-header-root"]'
        '--probe=templateBadge=[data-myoxus-ui-role="workbench-document-template-badge"]'
        '--expect-zero=legacyDetailHeaderCss=[class*="detail-page-detail-page-h"]'
      )
      ;;
    editor-starter-bar)
      SCOPE_PATHS=(
        "client/libs/core/src/editor/virgultum/doc-editor/starter-bar.tsx"
        "client/libs/core/src/editor/virgultum/doc-editor/starter-bar.css"
        "client/libs/core/src/editor/virgultum/doc-editor/starter-bar.styles.ts"
        "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
        "client/libs/ui-facade/src/index.tsx"
      )
      CHECK_ARGS=(--preset editor-starter-bar)
      ;;
    editor-backlinks-panel)
      SCOPE_PATHS=(
        "client/libs/core/src/editor/virgultum/doc-editor/bi-directional-link-panel.tsx"
        "client/libs/core/src/editor/virgultum/doc-editor/bi-directional-link-panel.css"
        "client/libs/core/src/editor/virgultum/doc-editor/bi-directional-link-panel.styles.ts"
        "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
        "client/libs/ui-facade/src/card.spec.tsx"
      )
      CHECK_ARGS=(--preset editor-backlinks-panel)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/all
        --name=editor-backlinks-panel-facade
        '--wait-selector=body'
        '--click-selector=a:has-text("Untitled")'
        '--post-interaction-wait-selector=body'
        '--probe=backlinks=[data-myoxus-ui-role="editor-bidirectional-links-panel"]'
        '--probe=backlinkRail=[data-myoxus-ui-role="editor-bidirectional-links-rail"]'
        '--expect-zero=legacyBacklinksCss=[class*="bi-directional-link-p"]'
      )
      ;;
    legacy-header|retired-header)
      SCOPE_PATHS=(
        "client/libs/core/src/editor/virgultum/doc-header/info/index.tsx"
        "client/libs/core/src/editor/virgultum/doc-header/menu/index.tsx"
        "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
        "client/apps/electron-renderer/src/windows-app-controls.tsx"
        "client/apps/electron-renderer/src/app/app.tsx"
        "client/apps/electron-renderer/src/shell/app.tsx"
        "client/libs/ui-facade/src/app-tab-strip.css"
        "client/libs/ui-facade/src/app-tab-strip.spec.tsx"
        "client/libs/ui-facade/src/index.tsx"
        "docs/dev/app/desktop-os-integration.md"
      )
      CHECK_ARGS=(--preset legacy-header)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/22e7f897-09d8-5fbe-ae85-80b8e2148561
        --name=legacy-header-facade
        '--wait-selector=[data-myoxus-ui-role="workbench-document-header-bar"]'
        '--require-probe=header=[data-myoxus-ui-role="workbench-document-header-bar"]'
        '--probe=menuButton=[data-testid="header-dropDownButton"]'
        '--expect-zero=legacyPureHeaderCss=[class*="components-pure-header-style"]'
        '--expect-zero=legacyHeaderDropdownCss=[class*="components-pure-header-drop-down-button"]'
      )
      ;;
    electron-onboarding)
      SCOPE_PATHS=(
        "client/libs/core/src/components/myoxus/onboarding"
      )
      CHECK_ARGS=(--preset electron-onboarding)
      VISUAL_ARGS=(
        --url=/onboarding
        --name=electron-onboarding
        '--local-storage=app_config={"onBoarding":true}'
        --wait-selector=.myoxus-onboarding-main
        '--expect-zero=legacyPaper=.myoxus-onboarding__paper'
      )
      ;;
    error-boundary)
      SCOPE_PATHS=(
        "client/libs/core/src/components/myoxus/myoxus-error-boundary"
        "client/libs/core/src/components/pure/help-island"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/exception-boundary.css"
      )
      CHECK_ARGS=(--preset error-boundary)
      ;;
    page-list-residual|page-list-list)
      SCOPE_PATHS=(
        "client/libs/core/src/components/page-list/list.tsx"
        "client/libs/core/src/components/page-list/utils.tsx"
        "client/libs/core/src/components/page-list/virtualized-list.tsx"
        "client/libs/core/src/components/page-list/collections/collection-list-item.tsx"
        "client/libs/core/src/components/page-list/tags/tag-list-item.tsx"
        "client/libs/core/src/components/page-list/explorer-page-list-facade-contract.spec.ts"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/surface-list.css"
      )
      CHECK_ARGS=(--preset page-list-residual)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/collection
        --name=page-list-residual
        '--wait-selector=[data-myoxus-ui-role="all-collections-content-rail"]'
        '--require-probe=rail=[data-myoxus-ui-role="all-collections-content-rail"]'
        '--probe=virtualizedList=[data-testid="virtualized-page-list"]'
        '--probe=surfaceRows=[data-page-list-surface-row="true"]'
        '--expect-zero=legacyPageListCss=[class*="components-page-list-list"]'
      )
      ;;
    peek-view-media|peek-media)
      SCOPE_PATHS=(
        "client/libs/core/src/modules/peek-view"
        "client/libs/core/src/editor/attachment-viewer"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/media-lightbox.css"
      )
      CHECK_ARGS=(--preset peek-view-media)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/all
        --name=peek-view-media
        '--wait-selector=[data-testid="main-container"]'
        '--require-probe=main=[data-testid="main-container"]'
        '--probe=peekModal=[data-testid="peek-view-modal"]'
        '--probe=attachmentViewer=[data-myoxus-ui-role="attachment-viewer-root"]'
        '--expect-zero=legacyPeekModalCss=[class*="modules-peek-view-view-modal-container"]'
        '--expect-zero=legacyAttachmentViewerCss=[class*="editor-attachment-viewer-viewer"]'
        '--expect-zero=legacyAttachmentErrorCss=[class*="editor-attachment-viewer-error"]'
      )
      ;;
    workspace-detail-journal|detail-journal)
      SCOPE_PATHS=(
        "client/libs/core/src/desktop/pages/workspace/detail-page"
        "client/libs/core/src/desktop/pages/workspace/journals"
        "client/libs/core/src/mobile/pages/workspace/detail"
        "client/libs/core/src/mobile/pages/workspace/journals.tsx"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/date-picker.css"
      )
      CHECK_ARGS=(--preset workspace-detail-journal)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/journals
        --name=workspace-detail-journal
        '--wait-selector=[data-testid="confirm-create-journal-button"]'
        '--require-probe=journalWeekPicker=[data-testid="journal-week-picker"]'
        '--require-probe=createJournalButton=[data-testid="confirm-create-journal-button"]'
        '--probe=rightSidebarCalendar=[data-testid="date-picker-calendar"]'
        '--expect-zero=legacyJournalsCss=[class*="desktop-pages-workspace-journals-index"]'
        '--expect-zero=legacyDetailPageCss=[class*="desktop-pages-workspace-detail-page-detail-page"],[class*="mobile-pages-workspace-detail-mobile-detail-page"],[class*="mobile-pages-workspace-journals"]'
        '--expect-zero=legacyMobileMenuCss=[class*="mobile-pages-workspace-detail-menu-journal"],[class*="mobile-pages-workspace-detail-menu-mode-switch"],[class*="mobile-pages-workspace-detail-page-header-more-button"],[class*="mobile-pages-workspace-detail-page-header-share-button"],[class*="mobile-pages-workspace-detail-journal-conflict-block"],[class*="mobile-pages-workspace-detail-journal-date-picker"]'
      )
      ;;
    workspace-preference-share|preference-share)
      SCOPE_PATHS=(
        "client/libs/core/src/desktop/dialogs/setting/workspace-setting/preference"
        "client/libs/core/src/desktop/pages/workspace/share"
        "client/libs/ui-facade/src/index.tsx"
      )
      CHECK_ARGS=(--preset workspace-preference-share)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/settings?tab=workspace:preference
        --name=workspace-preference-share
        '--wait-selector=[data-testid="workspace-setting-modal"],[data-testid="setting-modal"],[data-myoxus-ui-role="settings-dialog-content-panel"]'
        '--probe=settingsPanel=[data-myoxus-ui-role="settings-dialog-content-panel"]'
        '--require-probe=workspaceProfile=[data-myoxus-ui-role="workspace-preference-profile"]'
        '--expect-zero=legacyWorkspacePreferenceCss=[class*="workspace-setting-prefere"]'
        '--expect-zero=legacySharePageCss=[class*="desktop-pages-workspace-share"]'
      )
      ;;
    pdf-views|pdf-renderer-views)
      SCOPE_PATHS=(
        "client/libs/core/src/modules/pdf/views"
        "client/libs/core/src/__tests__/pdf-viewer-component.spec.tsx"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/pdf-preview.css"
      )
      CHECK_ARGS=(--preset pdf-views)
      ;;
    split-view)
      SCOPE_PATHS=("client/libs/core/src/modules/workbench/view/split-view")
      CHECK_ARGS=(--preset split-view)
      ;;
    find-in-page)
      SCOPE_PATHS=("client/libs/core/src/desktop/pages/root/find-in-page")
      CHECK_ARGS=(--preset find-in-page)
      ;;
    mobile-navigation)
      SCOPE_PATHS=(
        "client/libs/core/src/desktop/components/navigation-panel/tree"
        "client/libs/core/src/desktop/components/navigation-panel/layouts"
        "client/libs/core/src/desktop/components/navigation-panel/nodes/folder/empty.tsx"
        "client/libs/core/src/desktop/components/navigation-panel/sections/tags/index.tsx"
        "client/libs/core/src/desktop/components/navigation-panel/navigation-panel-facade-contract.spec.ts"
        "client/libs/core/src/mobile/components/navigation/tree"
        "client/libs/core/src/mobile/components/navigation/layouts"
        "client/libs/core/src/mobile/components/navigation/mobile-navigation-facade-contract.spec.ts"
        "client/libs/ui-facade/src/navigation-tree.css"
        "client/libs/ui-facade/src/navigation-tree.spec.tsx"
        "client/libs/ui-facade/src/index.tsx"
      )
      CHECK_ARGS=(--preset mobile-navigation)
      VISUAL_ARGS=(
        --url=/workspace/2c0a876c-9965-486c-87f5-6ab791aed14c/all
        --name=mobile-navigation-facade
        '--wait-selector=[data-testid="main-container"]'
        '--require-probe=appRoot=[data-myoxus-ui-role="app-container-root"]'
        '--probe=navigationTree=[data-myoxus-ui-role="navigation-tree"]'
        '--probe=treeRows=[data-myoxus-ui-role="navigation-tree-row"]'
        '--probe=treeLinks=[data-myoxus-ui-role="navigation-tree-link"]'
        '--probe=treeEmptySections=[data-myoxus-ui-role="navigation-tree-empty-section"]'
        '--expect-zero=legacyDesktopNavigationCss=[class*="desktop-components-navigation-panel"]'
        '--expect-zero=legacyMobileNavigationCss=[class*="mobile-components-navigation"]'
      )
      ;;
    mobile-doc-card)
      SCOPE_PATHS=(
        "client/libs/core/src/mobile/components/doc-card"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/card.spec.tsx"
      )
      CHECK_ARGS=(--preset mobile-doc-card)
      ;;
    mobile-doc-rail)
      SCOPE_PATHS=(
        "client/libs/core/src/mobile/views/recent-docs"
        "client/libs/core/src/mobile/views/search/search-results.tsx"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/mobile-search.css"
      )
      CHECK_ARGS=(--preset mobile-doc-rail)
      ;;
    mobile-search)
      SCOPE_PATHS=(
        "client/libs/core/src/mobile/components/search-input"
        "client/libs/core/src/mobile/pages/workspace/search.tsx"
        "client/libs/core/src/mobile/views/search"
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/mobile-search.css"
      )
      CHECK_ARGS=(--preset mobile-search)
      ;;
    mobile-selector)
      SCOPE_PATHS=("client/libs/core/src/mobile/dialogs/selectors")
      CHECK_ARGS=(--preset mobile-selector)
      ;;
    mobile-config-modal)
      SCOPE_PATHS=(
        "client/libs/core/src/components/mobile/config-modal"
        "client/libs/core/src/components/tags/tag-edit-menu.spec.tsx"
        "client/libs/ui-facade/src/index.tsx"
      )
      CHECK_ARGS=(--preset mobile-config-modal)
      ;;
    notifications)
      # The notifications slice intentionally crosses the React Facade, the
      # Core editor bridge and the Virgultum Lit renderer so that all
      # transient toast surfaces are reviewed in one audit cycle.
      #
      # The visual harness cannot capture a *rendered* toast (transient and
      # auto-dismissing); runtime coverage of `notify.show()`/`notify.dismiss()`
      # lives in `client/libs/ui-facade/src/notify-bridge.spec.tsx`. The
      # harness instead verifies the structural invariant of the migration:
      # the Mantine `<Notifications />` portal is mounted at every reviewed
      # entry point (admin + desktop + mobile) and no legacy toast DOM from
      # the deleted `MyoxusToaster` lingers anywhere in the rendered shell.
      SCOPE_PATHS=(
        "client/libs/ui-facade/src/index.tsx"
        "client/libs/ui-facade/src/provider.tsx"
        "client/libs/ui-facade/src/notify-bridge.spec.tsx"
        "client/libs/ui-facade/package.json"
        "client/libs/notifications/src/index.ts"
        "client/libs/notifications/src/index.spec.ts"
        "client/libs/notifications/package.json"
        "client/libs/core/src/editor/view-extensions/editor-view/notification-service.tsx"
        "client/libs/core/src/editor/view-extensions/editor-view/notification-service-facade-contract.spec.ts"
        "client/libs/core/src/editor/view-extensions/editor-config/toolbar/index.ts"
        "client/admin/workspaces/admin/src/app.tsx"
        "client/libs/core/src/desktop/pages/root/index.tsx"
        "client/libs/core/src/mobile/pages/root/index.tsx"
        "virgultum/editor/components/src/notification"
        "virgultum/editor/shared/src/utils/editor-toast.ts"
        "virgultum/editor/shared/src/utils/index.ts"
        "virgultum/editor/components/package.json"
        "virgultum/editor/components/src/embed-card-modal"
      )
      CHECK_ARGS=(--preset notifications)
      VISUAL_ARGS=(
        --url=/adminfrontend/
        --name=notifications-mantine-portal
        --theme=light
        --theme=dark
        --viewport=desktop:1440x1000
        --wait-selector='[data-admin-shell]'
        # Mantine `<Notifications />` always renders 6 portal `Box` containers,
        # one per supported position. Empty portal containers have zero height
        # until a notification is shown, so this slice asserts DOM existence
        # instead of visible geometry for the portal itself.
        '--require-exists=mantinePortalBottomRight=[data-position="bottom-right"]'
        '--require-exists=mantinePortalTopRight=[data-position="top-right"]'
        '--require-exists=mantineRootClass=[class*="mantine-Notifications-root"]'
        # The legacy `MyoxusToaster` rendered `.myoxus-toast` cards inside a
        # `.myoxus-toast-viewport`. Both must be absent on every capture.
        # Notification actions are native Mantine Button/Group components
        # through the Facade bridge, so neither legacy toast classes nor
        # Facade-local `myoxus-notification-*` CSS classes are allowed.
        '--expect-zero=legacyToastCard=[class*="myoxus-toast"]'
        '--expect-zero=legacyToastViewport=[class*="myoxus-toast-viewport"]'
        '--expect-zero=legacyToastDismissButton=[class*="myoxus-toast-dismiss"]'
        '--expect-zero=legacyToastTitle=[class*="myoxus-toast-title"]'
        '--expect-zero=localNotificationActionClass=[class*="myoxus-notification"]'
      )
      ;;
    *)
      fail "unknown frontend migration slice: $1. Use --list."
      ;;
  esac
}

run_audit() {
  local audit_args=(--top-limit "$TOP_LIMIT")
  if [[ "${#EXTRA_ARGS[@]}" -gt 0 ]]; then
    audit_args+=("${EXTRA_ARGS[@]}")
  fi
  if [[ "${#SCOPE_PATHS[@]}" -gt 0 ]]; then
    audit_args+=("${SCOPE_PATHS[@]}")
  fi
  "$SCRIPT_DIR/frontend-migration-scope-audit.sh" \
    "${audit_args[@]}"
}

run_check() {
  local check_args=()
  if [[ "${#CHECK_ARGS[@]}" -gt 0 ]]; then
    check_args+=("${CHECK_ARGS[@]}")
  fi
  if [[ "${#EXTRA_ARGS[@]}" -gt 0 ]]; then
    check_args+=("${EXTRA_ARGS[@]}")
  fi
  "$SCRIPT_DIR/frontend-migration-slice-check.sh" \
    "${check_args[@]}"
}

run_visual() {
  if [[ "${#VISUAL_ARGS[@]}" -eq 0 ]]; then
    fail "slice '$SLICE' has no stable visual harness yet; add one here before using --action visual"
  fi
  local visual_args=("${VISUAL_ARGS[@]}")
  if [[ "${#EXTRA_ARGS[@]}" -gt 0 ]]; then
    visual_args+=("${EXTRA_ARGS[@]}")
  fi
  "$SCRIPT_DIR/frontend-migration-visual.sh" \
    "${visual_args[@]}"
}

run_context() {
  local context_args=(--slice "$SLICE" --top-limit "$TOP_LIMIT")
  if [[ "${#EXTRA_ARGS[@]}" -gt 0 ]]; then
    context_args+=("${EXTRA_ARGS[@]}")
  fi
  "$SCRIPT_DIR/frontend-migration-context.sh" \
    "${context_args[@]}"
}

run_cycle() {
  local cycle_args=(--top-limit "$TOP_LIMIT")
  if [[ "${#CHECK_ARGS[@]}" -gt 0 ]]; then
    cycle_args+=("${CHECK_ARGS[@]}")
  fi
  if [[ "${#VISUAL_ARGS[@]}" -gt 0 ]]; then
    cycle_args+=("${VISUAL_ARGS[@]}")
  fi
  if [[ "${#EXTRA_ARGS[@]}" -gt 0 ]]; then
    cycle_args+=("${EXTRA_ARGS[@]}")
  fi
  "$SCRIPT_DIR/frontend-migration-cycle.sh" \
    "${cycle_args[@]}"
}

run_status() {
  MYOXUS_FRONTEND_MIGRATION_TOP_LIMIT="$TOP_LIMIT" \
    "$SCRIPT_DIR/frontend-migration-status.sh"
}

run_paths() {
  printf '%s\n' "${SCOPE_PATHS[@]}"
}

run_review() {
  local index
  for ((index = 1; index <= REVIEW_LOOPS; index += 1)); do
    echo
    echo "==> frontend migration review loop ${index}/${REVIEW_LOOPS}: $SLICE"
    run_audit
    run_check
    if [[ "${#VISUAL_ARGS[@]}" -gt 0 ]]; then
      run_visual
    else
      echo
      echo "[INFO] slice '$SLICE' has no stable visual harness; review loop used audit/check only."
    fi
  done
  run_status
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --list)
      list_slices
      exit 0
      ;;
    --slice)
      require_value "$1" "${2:-}"
      SLICE="$2"
      shift
      ;;
    --slice=*)
      SLICE="${1#*=}"
      ;;
    --action)
      require_value "$1" "${2:-}"
      ACTION="$2"
      shift
      ;;
    --action=*)
      ACTION="${1#*=}"
      ;;
    --top-limit)
      require_value "$1" "${2:-}"
      TOP_LIMIT="$2"
      shift
      ;;
    --top-limit=*)
      TOP_LIMIT="${1#*=}"
      ;;
    --loops|--review-loops)
      require_value "$1" "${2:-}"
      REVIEW_LOOPS="$2"
      shift
      ;;
    --loops=*|--review-loops=*)
      REVIEW_LOOPS="${1#*=}"
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    --*)
      fail "unknown argument: $1"
      ;;
    status|audit|check|visual|context|cycle|review|paths|all)
      ACTION="$1"
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
  shift
done

[[ "$TOP_LIMIT" =~ ^[0-9]+$ ]] || fail "--top-limit must be a non-negative integer"
[[ "$REVIEW_LOOPS" =~ ^[1-9][0-9]*$ ]] || fail "--loops must be a positive integer"

if [[ -z "$SLICE" ]]; then
  case "$ACTION" in
    status|audit)
      run_status
      echo
      echo "Frontend migration global action '$ACTION' passed."
      exit 0
      ;;
    *)
      fail "--slice is required for action '$ACTION'. Use --list to see known slices."
      ;;
  esac
fi

set_slice "$SLICE"

case "$ACTION" in
  status)
    run_status
    ;;
  audit)
    run_audit
    ;;
  check)
    run_check
    ;;
  visual)
    run_visual
    ;;
  context)
    run_context
    ;;
  cycle)
    run_cycle
    ;;
  review)
    run_review
    ;;
  paths)
    run_paths
    ;;
  all)
    run_audit
    run_cycle
    ;;
  *)
    fail "unknown action: $ACTION"
    ;;
esac

if [[ "$ACTION" != "paths" ]]; then
  echo
  echo "Frontend migration slice '$SLICE' action '$ACTION' passed."
fi
