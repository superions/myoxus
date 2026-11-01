// SPDX-License-Identifier: MIT
import {
  audioTranscriptionCapabilityQuery,
  claimAudioTranscriptionMutation,
  getAudioTranscriptionQuery,
  getAudioTranscriptionEnrichmentQuery,
  enrichAudioTranscriptionMutation,
  ServerFeature,
  retryAudioTranscriptionMutation,
  submitAudioTranscriptionMutation,
} from "@myoxus/graphql";
import { Entity } from "@myoxus/infra";

import type { WorkspaceServerService } from "../../server";
import type { WorkspaceService } from "../../workspace";

/** All requests stay on the attachment workspace's authenticated server. */
export class AudioTranscriptionJobStore extends Entity<{
  readonly blobId: string;
}> {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
  ) {
    super();
  }

  private get server() {
    const server = this.workspaceServerService.server;
    if (!server) throw new Error("No workspace server available");
    return server;
  }

  get workspaceId() {
    return this.workspaceService.workspace.id;
  }

  async capability(signal: AbortSignal) {
    const response = await this.server.gql({
      query: audioTranscriptionCapabilityQuery,
      variables: { workspaceId: this.workspaceId },
      context: { signal },
      timeout: 15000,
    });
    return {
      ...response.serverConfig.transcription,
      copilot: response.serverConfig.features.includes(ServerFeature.Copilot),
      allowed: response.workspace?.permissions.Workspace_Transcription ?? false,
    };
  }

  async submitAudioTranscription(signal: AbortSignal) {
    // The server consumes the completed canonical blob. No decoding, re-encoding
    // or redundant multipart copy is performed by the viewer.
    const response = await this.server.gql({
      query: submitAudioTranscriptionMutation,
      variables: { workspaceId: this.workspaceId, blobId: this.props.blobId },
      timeout: 30000,
      context: { signal },
    });
    return response.submitAudioTranscription;
  }

  async retryAudioTranscription(jobId: string, signal: AbortSignal) {
    const response = await this.server.gql({
      query: retryAudioTranscriptionMutation,
      variables: { workspaceId: this.workspaceId, jobId },
      timeout: 30000,
      context: { signal },
    });
    return response.retryAudioTranscription;
  }

  async getAudioTranscription(signal: AbortSignal, jobId?: string) {
    const response = await this.server.gql({
      query: getAudioTranscriptionQuery,
      variables: {
        workspaceId: this.workspaceId,
        blobId: this.props.blobId,
        jobId,
      },
      timeout: 15000,
      context: { signal },
    });
    return response.currentUser?.copilot?.audioTranscription[0] ?? null;
  }

  async getEnrichment(jobId: string, signal: AbortSignal) {
    const response = await this.server.gql({
      query: getAudioTranscriptionEnrichmentQuery,
      variables: {
        workspaceId: this.workspaceId,
        blobId: this.props.blobId,
        jobId,
      },
      timeout: 15000,
      context: { signal },
    });
    return (
      response.currentUser?.copilot?.audioTranscription[0]?.enrichment ?? null
    );
  }

  async enrichAudioTranscription(
    jobId: string,
    requested: { summary: boolean; actions: boolean },
    signal: AbortSignal,
  ) {
    const response = await this.server.gql({
      query: enrichAudioTranscriptionMutation,
      variables: { workspaceId: this.workspaceId, jobId, ...requested },
      timeout: 130000,
      context: { signal },
    });
    return response.enrichAudioTranscription;
  }

  async claimAudioTranscription(jobId: string, signal: AbortSignal) {
    const response = await this.server.gql({
      query: claimAudioTranscriptionMutation,
      variables: { jobId },
      timeout: 15000,
      context: { signal },
    });
    return response.claimAudioTranscription;
  }
}
