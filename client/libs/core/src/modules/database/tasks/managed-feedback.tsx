// SPDX-License-Identifier: AGPL-3.0-or-later

import type { databaseTasksQuery, QueryResponse } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  MenuItem,
  MenuPanel,
  MenuScrollableSection,
  MenuSub,
  MyoxusText,
  Popover,
  Stack,
} from "@myoxus/ui-facade";

type Copy = ReturnType<typeof useI18n>;

/** Server diagnostics are finite product states, never raw UI copy. */
export function managedTaskUnavailableLabel(t: Copy, reason?: string | null) {
  switch (reason) {
    case "MANAGED_SCHEMA_NOT_INSTALLED":
    case "MANAGED_SOURCE_UNAVAILABLE":
      return t["com.myoxus.database.tasks.source-unavailable"]();
    case "MANAGED_SOURCE_UNAVAILABLE_ON_NODE":
      return t["com.myoxus.database.tasks.source-unavailable-on-node"]();
    case "MANAGED_SOURCE_DIGEST_MISMATCH":
    case "MANAGED_STRUCTURE_MISMATCH":
      return t["com.myoxus.database.tasks.schema-changed"]();
    case "MANAGED_TRANSITION_UNSUPPORTED":
    case "MANAGED_TRANSITION_REQUIRES_REVIEWED_CONVERSION":
      return t["com.myoxus.database.tasks.update-required"]();
    default:
      return t["com.myoxus.database.tasks.managed-unavailable"]();
  }
}

type Coverage = Pick<
  NonNullable<
    QueryResponse<typeof databaseTasksQuery>["workspace"]
  >["databaseTasks"],
  "coverageComplete" | "unavailableProjects"
>;

export function TaskCoverageNotice({
  coverageComplete,
  unavailableProjects,
  onRetry,
  menu = false,
}: Coverage & { onRetry?: () => void; menu?: boolean }) {
  const t = useI18n();
  if (coverageComplete) return null;
  const details = (
    <>
      <MyoxusText>
        {t["com.myoxus.database.tasks.coverage-incomplete"]()}
      </MyoxusText>
      {unavailableProjects.map((project) => (
        <MyoxusText key={project.databaseId}>
          {project.title}: {managedTaskUnavailableLabel(t, project.reasonCode)}
        </MyoxusText>
      ))}
    </>
  );
  if (menu)
    return (
      <MenuSub
        items={
          <MenuPanel panelWidth="display">
            <MenuScrollableSection>
              <Stack>{details}</Stack>
            </MenuScrollableSection>
            {onRetry ? (
              <MenuItem onSelect={onRetry}>{t.Retry()}</MenuItem>
            ) : null}
          </MenuPanel>
        }
      >
        {t["com.myoxus.database.tasks.coverage-details"]()}
      </MenuSub>
    );
  return (
    <Popover
      trapFocus
      returnFocus
      closeOnEscape
      content={
        <Stack>
          {details}
          {onRetry ? <Button onClick={onRetry}>{t.Retry()}</Button> : null}
        </Stack>
      }
    >
      <Button
        variant="plain"
        aria-label={t["com.myoxus.database.tasks.coverage-details"]()}
      >
        {t["com.myoxus.database.tasks.coverage-details"]()}
      </Button>
    </Popover>
  );
}
