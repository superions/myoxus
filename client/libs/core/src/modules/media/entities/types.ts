import type { AiJobStatus } from "@myoxus/graphql";

export interface TranscriptionResult {
  text: string;
  segments: {
    text: string;
    startSeconds?: number;
    endSeconds?: number;
    speaker?: string;
  }[];
}

/** Optional generative content has its own persisted outcome. A failure retains
 * earlier output and never transitions or clears the speech result. */
export interface TranscriptionEnrichmentResult {
  id: string;
  status: AiJobStatus;
  summary?: string | null;
  actions?: string | null;
  errorMessage?: string | null;
}
