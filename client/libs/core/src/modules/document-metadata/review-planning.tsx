// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRegionalPreferences } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { DocumentReviewTask } from "@myoxus/core/modules/database/assistance/document-review";
import { useTaskIdentity } from "@myoxus/core/modules/database/tasks/use-workspace-tasks";
import { formatRegionalDateTime } from "@myoxus/core/modules/i18n";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench/services/workbench";
import {
  configureDocumentReviewPlanningMutation,
  documentReviewPlanningQuery,
  documentReviewQuery,
  type DocumentReviewPlanningFieldsFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServiceOptional } from "@myoxus/infra";
import {
  Button,
  Group,
  Loading,
  Modal,
  MyoxusText,
  Notice,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentMetadataModel } from "./types";

type Props = {
  docId: string;
  model: DocumentMetadataModel;
  readonly?: boolean;
  onChanged: () => Promise<void>;
};

/** The existing metadata readonly capability and native Task-start guard own
 * entry. No local workspace or anonymous fallback can create standing consent. */
export function DocumentReviewPlanningAction(props: Props) {
  const server = useLiveData(
    useServiceOptional(WorkspaceServerService)?.server$,
  );
  const account = useLiveData(server?.account$);
  const canStart = useLiveData(
    useServiceOptional(GuardService)?.can$("Workspace_CreateDoc"),
  );
  if (props.readonly || !canStart || !server || !account) return null;
  return (
    <ReviewPlanningOwner
      key={JSON.stringify([server.id, server.baseUrl, account.id, props.docId])}
      {...props}
    />
  );
}

function ReviewPlanningOwner({ docId, model, onChanged }: Props) {
  const owner = useTaskIdentity();
  const t = useI18n();
  const regional = useRegionalPreferences();
  const workbench = useServiceOptional(WorkbenchService)?.workbench;
  const [open, setOpen] = useState(false);
  const [returnFocus, setReturnFocus] = useState(true);
  const [plan, setPlan] = useState<DocumentReviewPlanningFieldsFragment>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [review, setReview] = useState<{
    databaseId: string;
    rowId: string;
    revision: string;
  }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const flight = useRef(false);
  const sequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // This owner is keyed by server/account/document. Late read or mutation replies
  // cannot replace a different owner's draft, and no date/readiness is derived here.
  const read = useCallback(async () => {
    const epoch = ++sequence.current;
    const response = await owner.server!.gql({
      query: documentReviewPlanningQuery,
      variables: { workspaceId: owner.workspace.id, docId },
    });
    if (!alive.current || epoch !== sequence.current) return;
    setPlan(response.documentReviewPlanning);
    setEnabled(response.documentReviewPlanning.enabled);
  }, [docId, owner.server, owner.workspace.id]);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (flight.current || !alive.current) return;
    flight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (open) void run(read);
  }, [open, read, run]);
  useEffect(() => {
    if (!open || !workbench) return;
    const origin = workbench.location$.value;
    // Workbench retains old document views. A Review's native Task/source link
    // must release this overlay, not leave it covering the new active view.
    const sub = workbench.location$.subscribe((location) => {
      if (
        location.pathname !== origin.pathname ||
        location.search !== origin.search
      ) {
        setReturnFocus(false);
        setOpen(false);
      }
    });
    return () => sub.unsubscribe();
  }, [open, workbench]);
  const save = () =>
    void run(async () => {
      if (!plan) return;
      const response = await owner.server!.gql({
        query: configureDocumentReviewPlanningMutation,
        variables: {
          workspaceId: owner.workspace.id,
          docId,
          enabled,
          expectedMetadataRevision: plan.metadataRevision,
        },
      });
      if (!alive.current) return;
      setPlan(response.configureDocumentReviewPlanning);
      setEnabled(response.configureDocumentReviewPlanning.enabled);
      await onChanged();
    });
  const openReview = () =>
    void run(async () => {
      if (!plan?.runId) return;
      const response = await owner.server!.gql({
        query: documentReviewQuery,
        variables: { workspaceId: owner.workspace.id, runId: plan.runId },
      });
      if (!alive.current) return;
      const view = response.workspace?.documentReview;
      if (
        response.currentUser?.id !== owner.account?.id ||
        response.workspace?.id !== owner.workspace.id ||
        !view ||
        view.run.id !== plan.runId
      )
        throw new Error("Review owner unavailable");
      setReview({
        databaseId: view.acceptedPlan.destinationDatabaseId,
        rowId: view.reviewTaskId,
        revision: view.acceptedPlan.sourceRevision,
      });
    });
  const empty = t["com.myoxus.document-metadata.value.not-set"]();
  const date = (value: string | null | undefined) =>
    value && plan
      ? formatRegionalDateTime(value, { ...regional, timezone: plan.zone })
      : empty;
  const responsible = model.lookup.workspaceMembers.find(
    (member) => member.id === plan?.responsibleId,
  );
  const reasons = new Map([
    [
      "documentUnavailable",
      t["com.myoxus.document-review.planning.source-unavailable"](),
    ],
    [
      "reviewSourceUnavailable",
      t["com.myoxus.document-review.planning.source-unavailable"](),
    ],
    [
      "reviewerUnavailable",
      t["com.myoxus.document-review.planning.reviewer-unavailable"](),
    ],
    [
      "reviewerSourceForbidden",
      t["com.myoxus.document-review.planning.reviewer-unavailable"](),
    ],
    [
      "reviewerDecisionUnavailable",
      t["com.myoxus.document-review.planning.reviewer-unavailable"](),
    ],
    [
      "formalReviewUnavailable",
      t["com.myoxus.document-review.planning.formal-unavailable"](),
    ],
    [
      "formalReviewSourceUnavailable",
      t["com.myoxus.document-review.planning.formal-unavailable"](),
    ],
    [
      "reviewDestinationUnavailable",
      t["com.myoxus.document-review.planning.destination-unavailable"](),
    ],
    ["notEnabled", t["com.myoxus.document-review.planning.disabled"]()],
    [
      "missingDeadline",
      t["com.myoxus.document-review.planning.missing-deadline"](),
    ],
    [
      "missingResponsible",
      t["com.myoxus.document-review.planning.missing-responsible"](),
    ],
    [
      "previousReviewPending",
      t["com.myoxus.document-review.planning.pending"](),
    ],
    [
      "cycleAlreadyAccepted",
      t["com.myoxus.document-review.planning.accepted"](),
    ],
    [
      "reviewActorUnavailable",
      t["com.myoxus.document-review.planning.actor-unavailable"](),
    ],
  ]);
  const reason =
    reasons.get(plan?.blockedReason ?? "") ??
    t["com.myoxus.document-review.planning.unavailable"]();
  const facts = plan
    ? [
        [
          t["com.myoxus.document-metadata.field.responsible"](),
          responsible?.name ||
            responsible?.email ||
            plan.responsibleId ||
            empty,
        ],
        [
          t["com.myoxus.document-review.planning.source-deadline"](),
          date(plan.sourceDeadline),
        ],
        [
          t["com.myoxus.document-review.planning.lead"](),
          t["com.myoxus.document-review.planning.lead-days"]({
            days: String(plan.leadDays),
          }),
        ],
        [
          t["com.myoxus.document-review.planning.next-start"](),
          date(plan.nextStart),
        ],
        ...(plan.processDeadline
          ? [
              [
                t["com.myoxus.document-review.planning.process-deadline"](),
                date(plan.processDeadline),
              ],
            ]
          : []),
      ]
    : [];
  return (
    <>
      <Button
        ref={trigger}
        variant="secondary"
        type="button"
        onClick={() => {
          setReturnFocus(true);
          setReview(undefined);
          setOpen(true);
        }}
      >
        {t["com.myoxus.document-review.planning.title"]()}
      </Button>
      <Modal
        open={open}
        title={
          review
            ? t["com.myoxus.database.review.details"]()
            : t["com.myoxus.document-review.planning.title"]()
        }
        onOpenChange={(value) => {
          if (!flight.current) setOpen(value);
        }}
        persistent={busy}
        returnFocusRef={trigger}
        returnFocus={returnFocus}
        scrollable
      >
        {review ? (
          <Stack>
            <DocumentReviewTask
              showSource={false}
              databaseId={review.databaseId}
              rowId={review.rowId}
              revision={review.revision}
              onChanged={async () => {
                await read();
                await onChanged();
              }}
            />
            <Group>
              <Button
                onClick={() => {
                  setReview(undefined);
                  void run(read);
                }}
              >
                {t["com.myoxus.backButton"]()}
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack>
            {failed ? (
              <Notice tone="warning">
                {t["com.myoxus.document-review.planning.failed"]()}
              </Notice>
            ) : null}
            {!plan && busy ? <Loading /> : null}
            {plan ? (
              <>
                <Switch checked={enabled} onChange={setEnabled} disabled={busy}>
                  {t["com.myoxus.document-review.planning.enable"]()}
                </Switch>
                {!failed ? (
                  <Notice
                    tone={
                      plan.ready && enabled === plan.enabled
                        ? undefined
                        : "warning"
                    }
                  >
                    {enabled !== plan.enabled
                      ? t["com.myoxus.document-review.planning.draft"]()
                      : plan.ready
                        ? t["com.myoxus.document-review.planning.ready"]()
                        : reason}
                  </Notice>
                ) : null}
                <Table>
                  <TableBody>
                    {facts.map(([label, value]) => (
                      <TableRow key={label}>
                        <TableHead scope="row">{label}</TableHead>
                        <TableCell>{value}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <MyoxusText>
                  {t["com.myoxus.common.timezone.value"]({
                    timeZone: plan.zone,
                  })}
                </MyoxusText>
              </>
            ) : null}
            <Group>
              <Button
                disabled={busy || failed || !plan || enabled === plan.enabled}
                onClick={save}
              >
                {t.Save()}
              </Button>
              <Button disabled={busy} onClick={() => void run(read)}>
                {t["com.myoxus.document-metadata.action.refresh"]()}
              </Button>
              {plan?.runId ? (
                <Button disabled={busy} onClick={openReview}>
                  {t["com.myoxus.database.review.details"]()}
                </Button>
              ) : null}
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
