// SPDX-License-Identifier: MIT
import { DebugLogger } from "@myoxus/debug";
import { UserFriendlyError } from "@myoxus/error";
import { AiJobStatus } from "@myoxus/graphql";
import { Entity, LiveData } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";
import { AudioTranscriptionJobStore } from "./audio-transcription-job-store";
import type {
  TranscriptionResult,
  TranscriptionEnrichmentResult,
} from "./types";

export const TRANSCRIPTION_STATUS_CLAIMED = "claimed" as const;
export type TranscriptionStatus =
  | {
      status:
        | "waiting-for-job"
        | "started"
        | "paused"
        | AiJobStatus.Pending
        | AiJobStatus.Running;
    }
  | { status: AiJobStatus.Failed; error: UserFriendlyError }
  | {
      status: typeof TRANSCRIPTION_STATUS_CLAIMED;
      result: TranscriptionResult;
    };

const logger = new DebugLogger("audio-transcription-job");
type Capability = Awaited<ReturnType<AudioTranscriptionJobStore["capability"]>>;

/** A viewer owns only cancellable readback state. Durable jobs live on the server;
 * neither restore nor polling writes job metadata or transcript text into Yjs. */
export class AudioTranscriptionJob extends Entity<{ readonly blobId: string }> {
  constructor(private readonly workspaceServerService: WorkspaceServerService) {
    super();
    this.disposables.push(() => this.controller.abort());
    this.disposables.push(() => this.store.dispose());
  }

  private readonly store = this.framework.createEntity(
    AudioTranscriptionJobStore,
    this.props,
  );
  private readonly controller = new AbortController();
  private operation?: Promise<void>;
  private operationSubmits = false;
  private queuedSubmission?: Promise<void>;
  private jobId?: string;
  readonly status$ = new LiveData<TranscriptionStatus>({
    status: "waiting-for-job",
  });
  readonly result$ = new LiveData<TranscriptionResult | null>(null);
  readonly enrichment$ = new LiveData<TranscriptionEnrichmentResult | null>(
    null,
  );
  readonly enrichmentBusy$ = new LiveData(false);
  readonly enrichmentError$ = new LiveData<UserFriendlyError | null>(null);
  private enrichmentOperation?: Promise<void>;
  readonly capability$ = new LiveData<Capability | null>(null);
  readonly error$ = new LiveData<UserFriendlyError | null>(null);
  readonly transcribing$ = this.status$.map(
    ({ status }) =>
      status === "started" ||
      status === AiJobStatus.Pending ||
      status === AiJobStatus.Running,
  );

  get id() {
    return this.jobId;
  }

  get currentUserId() {
    return this.workspaceServerService.server?.account$.value?.id;
  }

  private publish(status: TranscriptionStatus) {
    if (!this.controller.signal.aborted) this.status$.value = status;
  }

  /** Mount and resume are reads only, including when a previous request lost its response. */
  restore = () => this.run(false);
  start = () => this.run(true);

  private run(submit: boolean): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.operation) {
      if (!submit || this.operationSubmits) return this.operation;
      // A viewer mount can already be restoring when native delivery requests
      // transcription. Preserve that submit intent without concurrent work.
      return (this.queuedSubmission ??= this.operation.then(() => {
        this.queuedSubmission = undefined;
        return this.run(true);
      }));
    }
    this.operationSubmits = submit;
    this.operation = this.execute(submit).finally(() => {
      this.operation = undefined;
      this.operationSubmits = false;
    });
    return this.operation;
  }

  private async execute(submit: boolean) {
    const signal = this.controller.signal;
    this.error$.value = null;
    this.publish({ status: "started" });
    try {
      const capability = await this.store.capability(signal);
      if (signal.aborted) return;
      this.capability$.value = capability;
      let job: { id: string; status: AiJobStatus } | null =
        await this.store.getAudioTranscription(signal, this.jobId);
      if (signal.aborted) return;
      if (
        submit &&
        capability.enabled &&
        capability.configured &&
        capability.allowed
      ) {
        if (!job) job = await this.store.submitAudioTranscription(signal);
        else if (job.status === AiJobStatus.Failed)
          job = await this.store.retryAudioTranscription(job.id, signal);
      }
      if (!job) {
        this.publish({ status: "waiting-for-job" });
        return;
      }
      this.jobId = job.id;
      if (
        job.status === AiJobStatus.Pending ||
        job.status === AiJobStatus.Running
      )
        this.publish({ status: job.status });
      // A bounded viewer session can be resumed without resubmitting the source.
      const until = Date.now() + 10 * 60 * 1000;
      let failures = 0;
      while (!signal.aborted && Date.now() < until) {
        const current = await this.store
          .getAudioTranscription(signal, this.jobId)
          .catch((error) => {
            if (signal.aborted) throw error;
            failures++;
            this.error$.value = UserFriendlyError.fromAny(error);
            return null;
          });
        if (signal.aborted) return;
        if (current) {
          failures = 0;
          this.error$.value = null;
          // Failed refreshes retain the prior readable result; never erase it.
          if (current.text || current.transcription?.length) {
            this.result$.value = this.toResult(current);
          }
          if (current.status === AiJobStatus.Failed) {
            const error = UserFriendlyError.fromAny(
              current.errorMessage || "Transcription job failed",
            );
            this.error$.value = error;
            this.publish({ status: AiJobStatus.Failed, error });
            return;
          }
          if (current.status === AiJobStatus.Finished) {
            const claimed = await this.store.claimAudioTranscription(
              current.id,
              signal,
            );
            if (signal.aborted) return;
            const result = this.toResult(claimed);
            this.result$.value = result;
            this.publish({ status: TRANSCRIPTION_STATUS_CLAIMED, result });
            // Optional readback is a separate request: its failure cannot turn
            // an already completed speech result into a paused/failed job.
            try {
              const extra = await this.store.getEnrichment(this.jobId!, signal);
              if (signal.aborted) return;
              if (extra) this.enrichment$.value = extra;
            } catch (error) {
              if (signal.aborted) return;
              this.enrichmentError$.value = UserFriendlyError.fromAny(error);
            }
            if (
              this.enrichment$.value?.status === AiJobStatus.Running &&
              !this.enrichmentOperation
            ) {
              this.enrichmentBusy$.value = true;
              this.enrichmentOperation = this.readEnrichmentUntilTerminal()
                .catch((error) => {
                  if (!signal.aborted)
                    this.enrichmentError$.value =
                      UserFriendlyError.fromAny(error);
                })
                .finally(() => {
                  this.enrichmentOperation = undefined;
                  this.enrichmentBusy$.value = false;
                });
            }
            return;
          }
          this.publish({ status: current.status });
        }
        if (failures >= 4) break;
        await this.delay(Math.min(3000 * 2 ** failures, 24000), signal);
      }
      this.publish({ status: "paused" });
    } catch (error) {
      if (signal.aborted) return;
      logger.error("Audio transcription request failed", error);
      this.error$.value = UserFriendlyError.fromAny(error);
      this.publish({ status: "paused" });
    }
  }

  /** Only a current explicit selection transfers text to the generative provider.
   * Restore and native recording preferences never call this operation. */
  enrich = (requested: { summary: boolean; actions: boolean }) => {
    if (this.enrichmentOperation) return this.enrichmentOperation;
    if (
      !this.jobId ||
      this.status$.value.status !== TRANSCRIPTION_STATUS_CLAIMED ||
      this.controller.signal.aborted ||
      (!requested.summary && !requested.actions)
    )
      return Promise.resolve();
    this.enrichmentOperation = this.generateEnrichment(
      this.jobId,
      requested,
    ).finally(() => {
      this.enrichmentOperation = undefined;
      this.enrichmentBusy$.value = false;
    });
    return this.enrichmentOperation;
  };

  private async generateEnrichment(
    jobId: string,
    requested: { summary: boolean; actions: boolean },
  ) {
    this.enrichmentBusy$.value = true;
    this.enrichmentError$.value = null;
    const signal = this.controller.signal;
    try {
      const result = await this.store.enrichAudioTranscription(
        jobId,
        requested,
        signal,
      );
      if (signal.aborted) return;
      this.enrichment$.value = result;
      await this.readEnrichmentUntilTerminal();
    } catch (error) {
      if (signal.aborted) return;
      logger.error("Audio enrichment request failed", error);
      this.enrichmentError$.value = UserFriendlyError.fromAny(error);
    }
  }

  /** Poll only the already admitted operation. Network failure never retries
   * speech or generation; readback after remount can resume its own status. */
  private async readEnrichmentUntilTerminal() {
    const signal = this.controller.signal;
    const until = Date.now() + 135000;
    while (
      !signal.aborted &&
      this.enrichment$.value?.status === AiJobStatus.Running &&
      Date.now() < until
    ) {
      await this.delay(3000, signal);
      if (signal.aborted) return;
      const current = await this.store.getEnrichment(this.jobId!, signal);
      if (signal.aborted) return;
      this.enrichment$.value = current;
    }
    if (this.enrichment$.value?.status === AiJobStatus.Running)
      throw new Error("Enrichment status updates paused");
  }

  private toResult(job: {
    text?: string | null;
    segments?:
      | {
          text: string;
          startSeconds?: number | null;
          endSeconds?: number | null;
          speaker?: string | null;
        }[]
      | null;
    transcription?: { transcription: string }[] | null;
    summary?: string | null;
    actions?: string | null;
    enrichment?: TranscriptionEnrichmentResult | null;
  }): TranscriptionResult {
    // Historical summaries/actions remain readable without adding document
    // placeholders or treating old preferences as new generation authority.
    this.enrichment$.value =
      job.enrichment ??
      (job.summary || job.actions
        ? {
            id: this.jobId ?? "",
            status: AiJobStatus.Finished,
            summary: job.summary,
            actions: job.actions,
          }
        : null);
    return {
      text:
        job.text ??
        job.transcription?.map((segment) => segment.transcription).join("\n") ??
        "",
      segments:
        job.segments?.map((segment) => ({
          text: segment.text,
          startSeconds: segment.startSeconds ?? undefined,
          endSeconds: segment.endSeconds ?? undefined,
          speaker: segment.speaker ?? undefined,
        })) ?? [],
    };
  }

  private delay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
