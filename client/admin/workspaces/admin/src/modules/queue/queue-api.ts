import {
  adminCleanQueueMutation,
  adminEmptyQueueMutation,
  adminPauseAllQueuesMutation,
  adminPauseQueueMutation,
  adminPromoteQueueJobMutation,
  type AdminQueueJobsQuery,
  adminQueueJobsQuery,
  type AdminQueueStatusQuery,
  type WorkspaceContentOperationProjectionFragment,
  adminQueueStatusQuery,
  adminResumeAllQueuesMutation,
  adminResumeQueueMutation,
  adminRetryQueueJobMutation,
} from "@myoxus/graphql";

import { gqlFetcher } from "../../use-query";
import type { QueueHistoryPoint } from "./queue-history";

export type QueueCounts = {
  active: number;
  completed: number;
  delayed: number;
  failed: number;
  stalled: number;
  waiting: number;
};

export type QueueWithCounts = {
  name: string;
  displayName: string;
  paused: boolean;
  degraded: boolean;
  counts: QueueCounts;
  history: QueueHistoryPoint[] | null;
};

export type QueueStatusSnapshot = {
  redisAvailable: boolean;
  degraded: boolean;
  queues: QueueWithCounts[];
};

export type QueueJobStatus =
  "waiting" | "active" | "completed" | "failed" | "delayed";

export type QueueJobEntry = {
  id: string;
  name: string;
  timestamp?: number | null;
  attemptsMade?: number;
  finishedOn?: number | null;
  failedReason?: string | null;
  data?: unknown;
  returnValue?: unknown;
  workspaceContentOperation?: WorkspaceContentOperationProjectionFragment | null;
};

export type QueueJobListResponse = {
  totalCount: number;
  numOfPages: number;
  nextCursor: number | null;
  jobs: QueueJobEntry[];
};

type QueueMutationResult = {
  ok?: boolean;
  error?: string | null;
};

type QueueFromGraphQL = NonNullable<
  NonNullable<AdminQueueStatusQuery["admin"]>["queueStatus"]
>["queues"][number];

type JobFromGraphQL = NonNullable<
  NonNullable<NonNullable<AdminQueueJobsQuery["admin"]>["queueJobs"]>["jobs"]
>[number];

function requireResult<T>(value: T | null | undefined, label: string): T {
  if (!value) {
    throw new Error(`GraphQL response missing ${label}`);
  }
  return value;
}

function mapQueue(queue: QueueFromGraphQL): QueueWithCounts {
  return {
    name: queue.name,
    displayName: queue.displayName,
    paused: queue.paused,
    degraded: queue.degraded,
    history: queue.history ?? null,
    counts: {
      active: queue.counts.active,
      completed: queue.counts.completed,
      delayed: queue.counts.delayed,
      failed: queue.counts.failed,
      stalled: queue.counts.stalled,
      waiting: queue.counts.waiting,
    },
  };
}

function mapJob(job: JobFromGraphQL): QueueJobEntry {
  return {
    id: job.id,
    name: job.name,
    timestamp: job.timestamp,
    attemptsMade: job.attemptsMade,
    finishedOn: job.finishedOn,
    failedReason: job.failedReason,
    data: job.data,
    returnValue: job.returnValue,
    workspaceContentOperation: job.workspaceContentOperation,
  };
}

function assertQueueMutation(result: QueueMutationResult | null | undefined) {
  if (!result) {
    throw new Error("GraphQL response missing queue mutation result");
  }
  if (result.ok !== true) {
    throw new Error(result.error ?? "Queue operation failed");
  }
}

/** Read all known worker queues through the canonical AdminRoot GraphQL API. */
export async function fetchQueueStatus(): Promise<QueueStatusSnapshot> {
  const response = await gqlFetcher({ query: adminQueueStatusQuery });
  const status = requireResult(
    response.admin?.queueStatus,
    "admin.queueStatus",
  );
  return {
    redisAvailable: status.redisAvailable,
    degraded: status.degraded,
    queues: status.queues.map(mapQueue),
  };
}

/** Read one paginated queue job list through AdminRoot GraphQL. */
export async function fetchQueueJobs(args: {
  queueName: string;
  status: QueueJobStatus;
  cursor: number;
  limit: number;
}): Promise<QueueJobListResponse> {
  const response = await gqlFetcher({
    query: adminQueueJobsQuery,
    variables: args,
  });
  const page = requireResult(response.admin?.queueJobs, "admin.queueJobs");
  return {
    totalCount: page.totalCount,
    numOfPages: page.numOfPages,
    nextCursor: page.nextCursor ?? null,
    jobs: page.jobs.map(mapJob),
  };
}

export async function pauseQueue(queueName: string): Promise<void> {
  const response = await gqlFetcher({
    query: adminPauseQueueMutation,
    variables: { queueName },
  });
  assertQueueMutation(response.admin?.pauseQueue);
}

export async function resumeQueue(queueName: string): Promise<void> {
  const response = await gqlFetcher({
    query: adminResumeQueueMutation,
    variables: { queueName },
  });
  assertQueueMutation(response.admin?.resumeQueue);
}

export async function pauseAllQueues(): Promise<void> {
  const response = await gqlFetcher({ query: adminPauseAllQueuesMutation });
  assertQueueMutation(response.admin?.pauseAllQueues);
}

export async function resumeAllQueues(): Promise<void> {
  const response = await gqlFetcher({ query: adminResumeAllQueuesMutation });
  assertQueueMutation(response.admin?.resumeAllQueues);
}

export async function cleanQueue(
  queueName: string,
  status: "completed" | "failed" = "completed",
  gracePeriodMs = 3_600_000,
): Promise<void> {
  const response = await gqlFetcher({
    query: adminCleanQueueMutation,
    variables: { queueName, status, gracePeriodMs },
  });
  assertQueueMutation(response.admin?.cleanQueue);
}

export async function emptyQueue(queueName: string): Promise<void> {
  const response = await gqlFetcher({
    query: adminEmptyQueueMutation,
    variables: { queueName },
  });
  assertQueueMutation(response.admin?.emptyQueue);
}

export async function retryQueueJob(
  queueName: string,
  jobId: string,
): Promise<void> {
  const response = await gqlFetcher({
    query: adminRetryQueueJobMutation,
    variables: { queueName, jobId },
  });
  assertQueueMutation(response.admin?.retryJob);
}

export async function promoteQueueJob(
  queueName: string,
  jobId: string,
): Promise<void> {
  const response = await gqlFetcher({
    query: adminPromoteQueueJobMutation,
    variables: { queueName, jobId },
  });
  assertQueueMutation(response.admin?.promoteJob);
}
