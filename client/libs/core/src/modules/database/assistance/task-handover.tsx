// SPDX-License-Identifier: AGPL-3.0-or-later
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import type { TaskHandoverFragmentFragment } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import {
  Button,
  MyoxusText,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@myoxus/ui-facade";

/** Progress and links use the current authorized native projection, not answers. */
export function TaskHandoverProgress({
  view,
  current,
}: {
  view: TaskHandoverFragmentFragment;
  current: () => boolean;
}) {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  return (
    <Stack>
      <MyoxusText>
        {t["com.myoxus.database.handover.progress"]({
          complete: String(
            view.prerequisites.filter((item) => item.available && item.complete)
              .length,
          ),
          total: String(view.prerequisites.length),
        })}
      </MyoxusText>
      <Table>
        <TableBody>
          {view.prerequisites.map((item) => (
            <TableRow key={item.reference.rowId}>
              <TableCell>
                {item.available && item.title ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (current())
                        workbench.open(
                          `/tasks?${new URLSearchParams({ databaseId: item.reference.databaseId, rowId: item.reference.rowId })}`,
                          { at: "tail" },
                        );
                    }}
                  >
                    {item.title}
                  </Button>
                ) : (
                  t["com.myoxus.database.row_detail.unavailable"]()
                )}
              </TableCell>
              <TableCell>
                {!item.available
                  ? t["com.myoxus.database.row_detail.unavailable"]()
                  : item.complete
                    ? t["com.myoxus.database.progress.completed"]()
                    : t["com.myoxus.database.progress.incomplete"]()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  );
}
export function TaskHandoverResults({
  view,
  current,
}: {
  view: TaskHandoverFragmentFragment;
  current: () => boolean;
}) {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const target = view.resultAvailable ? view.resultTask : null;
  return target && target.rowId === view.resultTaskId ? (
    <Button
      onClick={() => {
        if (current())
          workbench.open(
            `/tasks?${new URLSearchParams({ databaseId: target.databaseId, rowId: target.rowId })}`,
            { at: "tail" },
          );
      }}
    >
      {t["com.myoxus.database.tasks.open-task"]()}
    </Button>
  ) : null;
}
