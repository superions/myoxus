#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# One-command validation for a coherent Mantine/Facade/CSS/Typography migration
# slice. Keep repeated local checks here so agents do not rebuild containers or
# reassemble fragile command sequences by hand while the long-running migration
# is in progress.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RUN_GATES=1
RUN_PRETTIER=1
RUN_FACADE_TYPECHECK=1
RUN_CORE_TYPECHECK=0
RUN_FULL_TYPECHECK=0
RUN_CHANGED_SPECS=1
VITEST_ARGS=()
PRESETS=()

usage() {
  cat <<'EOF'
Usage: build/scripts/server/frontend-migration-slice-check.sh [options]

Defaults:
  - syntax-check changed shell and JS/MJS scripts;
  - run Prettier on changed parsable files;
  - run changed Vitest specs plus explicit --vitest paths;
  - build/typecheck @myoxus/ui-facade when changed so composite
    declarations used by downstream projects cannot stay stale;
  - run yarn frontend:migration:gates --quick;
  - run git diff --check.

Options:
  --preset <name>          Add a reviewed test/check preset. Repeatable.
  --preset=<name>         Same as --preset <name>.
                          Known presets: admin-global, app-container,
                          editor-backlinks-panel,
                          document-header,
                          editor-starter-bar,
                          error-boundary,
                          legacy-header,
                          electron-onboarding, auth-pages, find-in-page,
                          import-dialogs, mobile-doc-card, mobile-doc-rail,
                          mobile-navigation, mobile-selector,
                          mobile-config-modal, mobile-search,
                          workspace-detail-journal,
                          page-list-residual, pdf-views, peek-view-media,
                          workspace-preference-share,
                          properties, split-view,
                          workspace-transfer-dialogs.
                          notifications.
  --vitest <path>          Add a focused Vitest file or glob. Repeatable.
  --vitest=<path>         Same as --vitest <path>.
  --no-changed-specs      Do not auto-run changed *.spec/test files.
  --no-prettier           Skip changed-file Prettier check.
  --no-gates              Skip yarn frontend:migration:gates --quick.
  --no-facade-typecheck   Skip automatic ui-facade typecheck.
  --core-typecheck        Also run client/libs/core typecheck.
  --full-typecheck        Also run root yarn typecheck.

Core typecheck is intentionally opt-in because parallel editor/Mermaid work can
break that project while a frontend migration slice is otherwise valid. Use it
as soon as the touched slice or current repo state makes it meaningful.
EOF
}

add_vitest_arg() {
  local value="$1"
  if [[ -z "$value" ]]; then
    echo "[FAIL] --vitest requires a path or glob" >&2
    exit 2
  fi
  add_unique_vitest_arg "$value"
}

add_unique_vitest_arg() {
  local value="$1"
  local existing
  if [[ "${#VITEST_ARGS[@]}" -gt 0 ]]; then
    for existing in "${VITEST_ARGS[@]}"; do
      [[ "$existing" == "$value" ]] && return 0
    done
  fi
  VITEST_ARGS+=("$value")
}

add_preset() {
  local value="$1"
  if [[ -z "$value" ]]; then
    echo "[FAIL] --preset requires a name" >&2
    exit 2
  fi
  PRESETS+=("$value")
}

apply_preset() {
  case "$1" in
    admin-global)
      add_unique_vitest_arg "client/admin/workspaces/admin/src/global.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/__tests__/admin-facade-typography-contract.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/__tests__/admin-global-css-token-literals.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/__tests__/admin-theme-bridge.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/__tests__/no-web-fonts.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/modules/admin-facade-usage-contract.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/modules/admin-retired-css-contract.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/modules/admin-visual-contract.spec.ts"
      add_unique_vitest_arg "client/admin/workspaces/admin/src/modules/dashboard/index.spec.tsx"
      add_unique_vitest_arg "client/libs/ui-facade/src/card.spec.tsx"
      add_unique_vitest_arg "client/libs/ui-facade/src/toast.spec.ts"
      ;;
    app-container)
      add_unique_vitest_arg "client/libs/ui-facade/src/app-shell.spec.tsx"
      ;;
    auth-pages)
      add_unique_vitest_arg "client/libs/core/src/components/sign-in/sign-in-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/auth-shell.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/auth/__tests__/auth-redirect.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/auth/__tests__/oauth-login.spec.ts"
      ;;
    electron-onboarding)
      add_unique_vitest_arg "client/libs/core/src/components/myoxus/onboarding/onboarding.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/components/myoxus/onboarding/onboarding-facade-contract.spec.ts"
      ;;
    editor-backlinks-panel)
      add_unique_vitest_arg "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/card.spec.tsx"
      ;;
    editor-starter-bar)
      add_unique_vitest_arg "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
      ;;
    error-boundary)
      add_unique_vitest_arg "client/libs/core/src/components/myoxus/myoxus-error-boundary/error-basic/error-detail.spec.tsx"
      ;;
    document-header)
      add_unique_vitest_arg "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/workspace-page-header-facade-contract.spec.ts"
      ;;
    legacy-header)
      add_unique_vitest_arg "client/libs/core/src/editor/virgultum/doc-editor/editor-polish-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/app-tab-strip.spec.tsx"
      ;;
    mobile-selector)
      add_unique_vitest_arg "client/libs/ui-facade/src/mobile-selector.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/mobile/dialogs/selectors/generic-selector-facade.spec.tsx"
      ;;
    mobile-navigation)
      add_unique_vitest_arg "client/libs/core/src/desktop/components/navigation-panel/navigation-panel-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/mobile/components/navigation/mobile-navigation-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/navigation-tree.spec.tsx"
      ;;
    mobile-doc-card)
      add_unique_vitest_arg "client/libs/core/src/mobile/components/doc-card/mobile-doc-card-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/card.spec.tsx"
      ;;
    mobile-doc-rail)
      add_unique_vitest_arg "client/libs/core/src/mobile/views/recent-docs/mobile-doc-rail-facade-contract.spec.ts"
      ;;
    mobile-config-modal)
      add_unique_vitest_arg "client/libs/core/src/components/mobile/config-modal/config-modal-facade.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/components/tags/tag-edit-menu.spec.tsx"
      add_unique_vitest_arg "client/libs/ui-facade/src/card.spec.tsx"
      ;;
    mobile-search)
      ;;
    workspace-detail-journal)
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/detail-page/detail-page-scroll-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/detail-page/tabs/chat-panel-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/detail-page/tabs/chat-loading-state.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/detail-page/tabs/chat-panel-session.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/components/ai-island/ai-island-responsive-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/detail-page/tabs/journal/journal-sidebar-layout-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/workspace/journals/journals-page-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/mobile/pages/workspace/mobile-workspace-page-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/mobile/pages/workspace/detail/mobile-detail-menu-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/mobile/pages/workspace/detail/mobile-journal-date-picker-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/date-picker.spec.tsx"
      ;;
    page-list-residual)
      add_unique_vitest_arg "client/libs/core/src/components/page-list/explorer-page-list-facade-contract.spec.ts"
      ;;
    pdf-views)
      add_unique_vitest_arg "client/libs/core/src/__tests__/pdf-viewer-component.spec.tsx"
      ;;
    peek-view-media)
      add_unique_vitest_arg "client/libs/core/src/modules/peek-view/view/image-preview/image-preview-facade.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/modules/peek-view/view/peek-view-media-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/__tests__/pdf-viewer-component.spec.tsx"
      ;;
    workspace-preference-share)
      ;;
    properties)
      add_unique_vitest_arg "client/libs/core/src/components/workspace-property-types/workspace-property-types-facade-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/typography.spec.tsx"
      ;;
    find-in-page)
      add_unique_vitest_arg "client/libs/ui-facade/src/find-in-page.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/desktop/pages/root/find-in-page/find-in-page-popup-facade.spec.tsx"
      ;;
    import-dialogs)
      add_unique_vitest_arg "client/libs/core/src/desktop/dialogs/import/import-dialog-ui-contract.spec.ts"
      add_unique_vitest_arg "client/libs/ui-facade/src/typography.spec.tsx"
      ;;
    split-view)
      add_unique_vitest_arg "client/libs/ui-facade/src/split-view.spec.tsx"
      add_unique_vitest_arg "client/libs/core/src/modules/workbench/view/split-view/split-view-facade.spec.ts"
      ;;
    workspace-transfer-dialogs)
      add_unique_vitest_arg "client/libs/ui-facade/src/typography.spec.tsx"
      ;;
    notifications)
      add_unique_vitest_arg "client/libs/ui-facade/src/notify-bridge.spec.tsx"
      add_unique_vitest_arg "client/libs/notifications/src/index.spec.ts"
      add_unique_vitest_arg "client/libs/core/src/editor/view-extensions/editor-view/notification-service-facade-contract.spec.ts"
      ;;
    *)
      echo "[FAIL] unknown frontend migration preset: $1" >&2
      echo "Known presets: admin-global, app-container, auth-pages, document-header, editor-backlinks-panel, editor-starter-bar, electron-onboarding, error-boundary, find-in-page, import-dialogs, legacy-header, mobile-config-modal, mobile-doc-card, mobile-doc-rail, mobile-navigation, mobile-search, mobile-selector, notifications, page-list-residual, pdf-views, peek-view-media, properties, split-view, workspace-detail-journal, workspace-preference-share, workspace-transfer-dialogs" >&2
      exit 2
      ;;
  esac
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --preset)
      shift
      add_preset "${1:-}"
      ;;
    --preset=*)
      add_preset "${1#*=}"
      ;;
    --vitest)
      shift
      add_vitest_arg "${1:-}"
      ;;
    --vitest=*)
      add_vitest_arg "${1#*=}"
      ;;
    --no-changed-specs)
      RUN_CHANGED_SPECS=0
      ;;
    --no-prettier)
      RUN_PRETTIER=0
      ;;
    --no-gates)
      RUN_GATES=0
      ;;
    --no-facade-typecheck)
      RUN_FACADE_TYPECHECK=0
      ;;
    --core-typecheck)
      RUN_CORE_TYPECHECK=1
      ;;
    --full-typecheck)
      RUN_FULL_TYPECHECK=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[FAIL] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

run_step() {
  local label="$1"
  shift
  echo
  echo "==> $label"
  "$@"
}

changed_files() {
  {
    git diff --name-only --diff-filter=ACMRT HEAD --
    git ls-files --others --exclude-standard
  } | sort -u
}

matches_any_changed() {
  local pattern="$1"
  shift
  local file
  for file in "$@"; do
    [[ "$file" =~ $pattern ]] && return 0
  done
  return 1
}

CHANGED_FILES=()
while IFS= read -r changed_file; do
  [[ -n "$changed_file" ]] && CHANGED_FILES+=("$changed_file")
done < <(changed_files)

if [[ "${#PRESETS[@]}" -gt 0 ]]; then
  for preset in "${PRESETS[@]}"; do
    apply_preset "$preset"
  done
fi

if [[ "${#CHANGED_FILES[@]}" -eq 0 ]]; then
  echo "[INFO] no changed or untracked files detected; running repository gates only."
else
  echo "==> changed files"
  printf '%s\n' "${CHANGED_FILES[@]}"
fi

SHELL_FILES=()
NODE_SCRIPT_FILES=()
PARSABLE_FILES=()
SPEC_FILES=()

for file in "${CHANGED_FILES[@]}"; do
  [[ -f "$file" ]] || continue
  case "$file" in
    *.sh)
      SHELL_FILES+=("$file")
      ;;
    build/scripts/*.js|build/scripts/*.mjs|build/scripts/*/*.js|build/scripts/*/*.mjs)
      NODE_SCRIPT_FILES+=("$file")
      ;;
  esac

  case "$file" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.css)
      PARSABLE_FILES+=("$file")
      ;;
  esac

  case "$file" in
    *.spec.ts|*.spec.tsx|*.test.ts|*.test.tsx)
      SPEC_FILES+=("$file")
      ;;
  esac
done

if [[ "${#SHELL_FILES[@]}" -gt 0 ]]; then
  for file in "${SHELL_FILES[@]}"; do
    run_step "shell syntax: $file" bash -n "$file"
  done
fi

if [[ "${#NODE_SCRIPT_FILES[@]}" -gt 0 ]]; then
  for file in "${NODE_SCRIPT_FILES[@]}"; do
    run_step "node script syntax: $file" node --check "$file"
  done
fi

if [[ "$RUN_PRETTIER" -eq 1 && "${#PARSABLE_FILES[@]}" -gt 0 ]]; then
  run_step "prettier changed files" \
    yarn prettier --check --ignore-unknown "${PARSABLE_FILES[@]}"
fi

if [[ "$RUN_CHANGED_SPECS" -eq 1 ]]; then
  if [[ "${#SPEC_FILES[@]}" -gt 0 ]]; then
    for file in "${SPEC_FILES[@]}"; do
      add_unique_vitest_arg "$file"
    done
  fi
fi

if [[ "${#VITEST_ARGS[@]}" -gt 0 ]]; then
  run_step "focused vitest" yarn vitest run "${VITEST_ARGS[@]}"
fi

if [[ "$RUN_FACADE_TYPECHECK" -eq 1 ]] &&
  [[ "${#CHANGED_FILES[@]}" -gt 0 ]] &&
  matches_any_changed '^client/libs/ui-facade/' "${CHANGED_FILES[@]}"; then
  rm -f client/libs/ui-facade/dist/tsconfig.tsbuildinfo
  run_step "ui-facade build/typecheck" \
    yarn tsc -p client/libs/ui-facade/tsconfig.json --pretty false
fi

if [[ "$RUN_CORE_TYPECHECK" -eq 1 ]]; then
  run_step "core typecheck" \
    yarn tsc -p client/libs/core/tsconfig.json --noEmit --pretty false
elif [[ "${#CHANGED_FILES[@]}" -gt 0 ]] &&
  matches_any_changed '^client/libs/core/' "${CHANGED_FILES[@]}"; then
  echo
  echo "[INFO] core files changed; core typecheck not run. Use --core-typecheck when parallel Mermaid changes are clean enough for that gate."
fi

if [[ "$RUN_FULL_TYPECHECK" -eq 1 ]]; then
  run_step "root typecheck" yarn typecheck
fi

if [[ "$RUN_GATES" -eq 1 ]]; then
  run_step "frontend migration gates" yarn frontend:migration:gates --quick
fi

run_step "git diff whitespace" git diff --check

echo
echo "Frontend migration slice check passed."
