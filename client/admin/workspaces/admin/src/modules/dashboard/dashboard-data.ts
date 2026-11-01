// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

const number = z.number().finite();
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const window = z.object({
  from: date,
  to: date,
  timezone: z.string().min(1),
  bucket: z.string().min(1),
  requestedSize: number,
  effectiveSize: number,
});
const storagePoint = z.object({ date, value: number });

// Validate the consumed projection without supplying product defaults. A missing
// counter, window or collection must never turn into a healthy-looking zero.
export const dashboardOverviewSchema = z.object({
  syncActiveUsers: number,
  syncActiveUsersTimeline: z.array(
    z.object({ minute: date, activeUsers: number }),
  ),
  syncWindow: window,
  copilotConversations: number,
  workspaceStorageBytes: number,
  blobStorageBytes: number,
  workspaceStorageHistory: z.array(storagePoint),
  blobStorageHistory: z.array(storagePoint),
  storageWindow: window,
  topSharedLinksWindow: window,
  runtime: z.object({
    processUptimeSeconds: number,
    requestsTotal: number,
    requestsErrorTotal: number,
    requestErrorRate: number,
    requestThroughputRps: number,
    requestLatencyAvgMs: number,
    requestLatencyMaxMs: number,
  }),
  queueSummary: z.object({
    pendingReadyTotal: number,
    failedTotal: number,
    queues: z.array(
      z.object({
        queue: z.string(),
        pendingReady: number,
        failed: number,
        deadLetter: number,
        queueLagSeconds: number,
      }),
    ),
  }),
  metricsPipeline: z.object({
    enabled: z.boolean(),
    prometheusEnabled: z.boolean(),
    persistenceEnabled: z.boolean(),
    activeSeries: number,
    persisted24H: number.nullable(),
    dailyRollups7D: number.nullable(),
    lastFlushAt: date.nullable(),
    lastFlushCount: number,
    flushIntervalSeconds: number,
    offeredTotal: number,
    acceptedTotal: number,
    rejectedDisabledTotal: number,
    cardinalityDropsTotal: number,
  }),
  telemetryPipeline: z.object({
    enabled: z.boolean(),
    hotBufferLen: number,
    persisted24H: number.nullable(),
    dailyRollups7D: number.nullable(),
    lastFlushAt: date.nullable(),
    lastFlushCount: number,
    offeredTotal: number,
    acceptedTotal: number,
    rejectedTotal: number,
    bufferOverflowTotal: number,
    dedupeHitRate: number,
  }),
  captcha: z.object({
    enabled: z.boolean(),
    hmacKeyConfigured: z.boolean(),
    verifiedTotal: number,
    rejectedTotal: number,
    honeypotTotal: number,
  }),
  dbPool: z
    .object({
      active: number,
      idle: number,
      max: number,
      userCount: number.nullable(),
      workspaceCount: number.nullable(),
    })
    .nullable(),
  cacheMetrics: z.array(
    z.object({
      name: z.string(),
      hitsTotal: number,
      missesTotal: number,
      hitRate: number,
      invalidationsLocalTotal: number,
      invalidationsRemoteTotal: number,
      entryCount: number,
    }),
  ),
  generatedAt: date,
});

export const dashboardSharedLinksSchema = z.object({
  topSharedLinks: z.array(
    z.object({
      workspaceId: z.string(),
      docId: z.string(),
      title: z.string().nullable(),
      shareUrl: z.string(),
      publishedAt: date.nullable(),
      views: number,
      uniqueViews: number,
      guestViews: number,
      lastAccessedAt: date.nullable(),
    }),
  ),
  topSharedLinksWindow: window,
});

export type DashboardModel = z.infer<typeof dashboardOverviewSchema>;
export type DashboardSharedLinksModel = z.infer<
  typeof dashboardSharedLinksSchema
>;
