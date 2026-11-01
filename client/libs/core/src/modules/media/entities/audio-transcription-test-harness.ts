// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import {
  AiJobStatus,
  audioTranscriptionCapabilityQuery,
  claimAudioTranscriptionMutation,
  getAudioTranscriptionQuery,
  getAudioTranscriptionEnrichmentQuery,
  retryAudioTranscriptionMutation,
  submitAudioTranscriptionMutation,
} from "@myoxus/graphql";
import { Framework, LiveData } from "@myoxus/infra";
import { expect, vi } from "vitest";

import { DefaultServerService, WorkspaceServerService } from "../../server";
import { WorkspaceService } from "../../workspace";
import { AudioTranscriptionJob } from "./audio-transcription-job";
import { AudioTranscriptionJobStore } from "./audio-transcription-job-store";

export function audioJobHarness(configure?: (framework: Framework) => void) {
  let state: any = null;
  let denied = false;
  const finished = {
    id: "job-1",
    status: AiJobStatus.Finished,
    text: "Am Montag planen wir die Arbeit.",
    segments: [
      {
        text: "Am Montag planen wir die Arbeit.",
        startSeconds: 0,
        endSeconds: 2,
        speaker: null,
      },
    ],
  };
  const gql = vi.fn(async ({ query, variables }: any): Promise<any> => {
    if (query === audioTranscriptionCapabilityQuery)
      return {
        serverConfig: {
          features: [],
          transcription: {
            enabled: true,
            configured: true,
            status: "available",
            maxInputBytes: 10000,
            maxDurationSeconds: 60,
          },
        },
        workspace: { permissions: { Workspace_Transcription: !denied } },
      };
    if (query === getAudioTranscriptionQuery) {
      expect(variables.workspaceId).toBe("source-workspace");
      expect(variables.blobId).toBe("canonical-audio");
      return {
        currentUser: { copilot: { audioTranscription: state ? [state] : [] } },
      };
    }
    if (query === getAudioTranscriptionEnrichmentQuery) {
      expect(variables).toEqual({
        workspaceId: "source-workspace",
        blobId: "canonical-audio",
        jobId: "job-1",
      });
      return {
        currentUser: {
          copilot: {
            audioTranscription: state
              ? [{ enrichment: state.enrichment ?? null }]
              : [],
          },
        },
      };
    }
    if (query === submitAudioTranscriptionMutation) {
      expect(variables).toEqual({
        workspaceId: "source-workspace",
        blobId: "canonical-audio",
      });
      state = finished;
      return {
        submitAudioTranscription: {
          id: finished.id,
          status: AiJobStatus.Pending,
        },
      };
    }
    if (query === retryAudioTranscriptionMutation) {
      expect(variables).toEqual({
        workspaceId: "source-workspace",
        jobId: finished.id,
      });
      state = finished;
      return {
        retryAudioTranscription: {
          id: finished.id,
          status: AiJobStatus.Pending,
        },
      };
    }
    if (query === claimAudioTranscriptionMutation) {
      expect(variables.jobId).toBe(finished.id);
      return { claimAudioTranscription: state };
    }
    throw new Error("Unexpected request");
  });
  const foreignGql = vi.fn();
  const framework = new Framework();
  framework
    .service(WorkspaceService, {
      workspace: { id: "source-workspace" },
    } as unknown as WorkspaceService)
    .service(WorkspaceServerService, {
      server: { gql, account$: new LiveData({ id: "actor" }) },
    } as unknown as WorkspaceServerService)
    .service(DefaultServerService, {
      server: { gql: foreignGql },
    } as unknown as DefaultServerService)
    .entity(AudioTranscriptionJobStore, [
      WorkspaceService,
      WorkspaceServerService,
    ])
    .entity(AudioTranscriptionJob, [WorkspaceServerService]);
  configure?.(framework);
  const provider = framework.provider();
  const create = () =>
    provider.createEntity(AudioTranscriptionJob, { blobId: "canonical-audio" });
  return {
    framework,
    provider,
    create,
    gql,
    foreignGql,
    finished,
    setState: (value: any) => {
      state = value;
    },
    deny: () => {
      denied = true;
    },
  };
}
