// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import {
  AiJobStatus,
  getAudioTranscriptionQuery,
  getAudioTranscriptionEnrichmentQuery,
  enrichAudioTranscriptionMutation,
  retryAudioTranscriptionMutation,
  submitAudioTranscriptionMutation,
} from "@myoxus/graphql";
import { afterEach, describe, expect, test, vi } from "vitest";
import { audioJobHarness } from "./audio-transcription-test-harness";

afterEach(() => vi.useRealTimers());

describe("audio transcription consumer", () => {
  test("a viewer restore cannot swallow a concurrent native submit", async () => {
    const h = audioJobHarness();
    const job = h.create();
    await Promise.all([job.restore(), job.start(), job.start()]);
    expect(job.status$.value.status).toBe("claimed");
    expect(job.result$.value?.text).toBe(h.finished.text);
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === submitAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    job.dispose();
  });

  test("submits canonical input once, restores after reload and never calls a foreign server", async () => {
    const h = audioJobHarness();
    const job = h.create();
    await Promise.all([job.start(), job.start()]);
    expect(job.result$.value?.text).toBe(h.finished.text);
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === submitAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    expect(
      h.gql.mock.calls.every(
        ([r]) => r.timeout > 0 && r.context.signal instanceof AbortSignal,
      ),
    ).toBe(true);
    job.dispose();
    const reload = h.create();
    await reload.restore();
    expect(reload.result$.value?.segments[0].startSeconds).toBe(0);
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === submitAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    expect(h.foreignGql).not.toHaveBeenCalled();
    reload.dispose();
  });

  test("restoring failure preserves its text and only explicit retry adopts the same job", async () => {
    const h = audioJobHarness();
    h.setState({
      ...h.finished,
      status: AiJobStatus.Failed,
      errorMessage: "No speech was recognized",
    });
    const job = h.create();
    await job.restore();
    expect(job.error$.value?.message).toBe("No speech was recognized");
    expect(job.result$.value?.text).toBe(h.finished.text);
    expect(
      h.gql.mock.calls.some(
        ([r]) => r.query === retryAudioTranscriptionMutation,
      ),
    ).toBe(false);
    await job.start();
    expect(job.status$.value.status).toBe("claimed");
    expect(job.id).toBe(h.finished.id);
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === retryAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    job.dispose();
  });

  test("dispose aborts the actual request and rejects a late publication", async () => {
    const h = audioJobHarness();
    let finish!: (value: any) => void;
    h.gql.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const job = h.create();
    const operation = job.restore();
    const request = h.gql.mock.calls[0][0];
    job.dispose();
    expect(request.context.signal.aborted).toBe(true);
    finish({
      serverConfig: { transcription: {} },
      workspace: { permissions: {} },
    });
    await operation;
    expect(job.capability$.value).toBeNull();
    expect(job.result$.value).toBeNull();
    expect(h.gql).toHaveBeenCalledTimes(1);
  });

  test("network polling is bounded and resume reads the existing source without another submission", async () => {
    vi.useFakeTimers();
    const h = audioJobHarness();
    const actual = h.gql.getMockImplementation()!;
    let reads = 0;
    h.gql.mockImplementation(async (request) => {
      if (request.query === getAudioTranscriptionQuery && ++reads > 1)
        throw new Error("Network unavailable");
      return actual(request);
    });
    const job = h.create();
    const operation = job.start();
    await vi.advanceTimersByTimeAsync(90000);
    await operation;
    expect(job.status$.value.status).toBe("paused");
    expect(job.error$.value?.message).toBe("Network unavailable");
    h.gql.mockImplementation(actual);
    await job.restore();
    expect(job.status$.value.status).toBe("claimed");
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === submitAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    job.dispose();
  });
});

describe("optional audio enrichment", () => {
  test("explicit generation, LLM failure and reload preserve speech and prior optional output", async () => {
    const h = audioJobHarness();
    const actual = h.gql.getMockImplementation()!;
    let enriched: any = null;
    h.gql.mockImplementation(async (request) => {
      if (request.query === enrichAudioTranscriptionMutation) {
        expect(request.variables).toEqual({
          workspaceId: "source-workspace",
          jobId: "job-1",
          summary: true,
          actions: false,
        });
        enriched = {
          id: "enrichment-1",
          status: AiJobStatus.Failed,
          summary: "Retained summary",
          actions: "Retained actions",
          errorMessage: "LLM unavailable",
        };
        h.setState({ ...h.finished, enrichment: enriched });
        return { enrichAudioTranscription: enriched };
      }
      return actual(request);
    });
    const job = h.create();
    await job.start();
    const speech = job.result$.value;
    await Promise.all([
      job.enrich({ summary: true, actions: false }),
      job.enrich({ summary: true, actions: false }),
    ]);
    expect(job.status$.value.status).toBe("claimed");
    expect(job.result$.value).toBe(speech);
    expect(job.enrichment$.value?.status).toBe(AiJobStatus.Failed);
    expect(job.enrichment$.value?.summary).toBe("Retained summary");
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === enrichAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === retryAudioTranscriptionMutation,
      ),
    ).toHaveLength(0);
    job.dispose();
    const reload = h.create();
    await reload.restore();
    expect(reload.result$.value?.text).toBe(h.finished.text);
    expect(reload.enrichment$.value).toEqual(enriched);
    expect(
      h.gql.mock.calls.filter(
        ([r]) => r.query === enrichAudioTranscriptionMutation,
      ),
    ).toHaveLength(1);
    reload.dispose();
  });

  test("generation transport errors stay local and disposal fences late output", async () => {
    const h = audioJobHarness();
    const actual = h.gql.getMockImplementation()!;
    let finish!: (value: any) => void;
    h.gql.mockImplementation(async (request) => {
      if (request.query === enrichAudioTranscriptionMutation)
        throw new Error("Network failure");
      return actual(request);
    });
    const job = h.create();
    await job.start();
    const speech = job.result$.value;
    await job.enrich({ summary: true, actions: false });
    expect(job.status$.value.status).toBe("claimed");
    expect(job.error$.value).toBeNull();
    expect(job.result$.value).toBe(speech);
    expect(job.enrichmentError$.value?.message).toBe("Network failure");
    expect(job.enrichmentBusy$.value).toBe(false);
    h.gql.mockImplementation(async (request) => {
      if (request.query === enrichAudioTranscriptionMutation)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return actual(request);
    });
    const generating = job.enrich({ summary: false, actions: true });
    job.dispose();
    finish({
      enrichAudioTranscription: {
        id: "late",
        status: AiJobStatus.Finished,
        summary: "Late text",
      },
    });
    await generating;
    expect(job.enrichment$.value).toBeNull();
    expect(job.result$.value).toBe(speech);
  });
});

test("optional result readback failure cannot pause completed speech", async () => {
  const h = audioJobHarness();
  const actual = h.gql.getMockImplementation()!;
  h.gql.mockImplementation(async (request) => {
    if (request.query === getAudioTranscriptionEnrichmentQuery)
      throw new Error("Optional read unavailable");
    return actual(request);
  });
  const job = h.create();
  await job.start();
  expect(job.status$.value.status).toBe("claimed");
  expect(job.result$.value?.text).toBe(h.finished.text);
  expect(job.error$.value).toBeNull();
  expect(job.enrichmentError$.value?.message).toBe("Optional read unavailable");
  job.dispose();
});
