#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Prevent removed preference authorities and API contracts from returning.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

SCOPES=(
  client/libs/core/src
  client/libs/graphql/src
  client/libs/infra/src
  client/apps/ios/App/Packages/AffineGraphQL/Sources
  client/apps/ios/App/Packages/Intelligents/Sources
  server/crates/api/src
  server/crates/application/src
  server/crates/domain/src
  server/crates/infrastructure/src
  server/crates/yjs/src
  tests/client/adminfrontend
  tests/client/webfrontend
)

FORBIDDEN=(
  'getUserSettings'
  'updateUserSettings'
  'UpdateUserSettingsInput'
  'UserSettingsType'
  'appSettingAtom'
  'global-state:editor-setting'
  'i18nextLng'
  '"i18n_lng"'
  '"myoxus-settings"'
)

failed=0
for pattern in "${FORBIDDEN[@]}"; do
  if matches="$(rg -n --fixed-strings -- "$pattern" "${SCOPES[@]}" 2>/dev/null)"; then
    printf 'Removed user-preference contract returned: %s\n%s\n' "$pattern" "$matches" >&2
    failed=1
  fi
done

# Reject the removed storage key, while allowing the live projection's
# data-myoxus-theme-source DOM attribute in consuming browser assertions.
if matches="$(rg -n -- '(^|[^[:alnum:]_-])myoxus-theme([^[:alnum:]_-]|$)' tests/client/webfrontend 2>/dev/null)"; then
  printf 'Removed Web color-mode storage authority returned:\n%s\n' "$matches" >&2
  failed=1
fi

# Theme catalog selection belongs to the canonical personal workspace profile,
# never to the account preference operation or its generated iOS consumer.
THEME_PREFERENCE_SCOPES=(
  client/libs/graphql/src/graphql/get-user-preferences.gql
  client/libs/graphql/src/graphql/update-user-preferences.gql
  client/libs/graphql/src/graphql/fragments/current-user-profile.gql
  client/apps/ios/App/Packages/AffineGraphQL/Sources/Operations/Queries/GetUserPreferencesQuery.graphql.swift
)
if matches="$(rg -n --fixed-strings -- 'themeSlug' "${THEME_PREFERENCE_SCOPES[@]}" 2>/dev/null)"; then
  printf 'Account-level themeSlug contract returned:\n%s\n' "$matches" >&2
  failed=1
fi

exit "$failed"
