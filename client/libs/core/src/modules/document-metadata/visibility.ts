export interface DocumentMetadataVisibilityInput {
  shared?: boolean;
  isJournal?: boolean;
  workspaceFlavour?: string | null;
}

export function shouldShowDocumentMetadata({
  shared,
  isJournal,
  workspaceFlavour,
}: DocumentMetadataVisibilityInput) {
  // Canonical document metadata are server-governed metadata. Local/offline
  // docs do not have a server metadata projection and must not trigger GraphQL probes.
  const isServerBackedWorkspace =
    typeof workspaceFlavour === "string" && workspaceFlavour !== "local";
  return isServerBackedWorkspace && !shared && !isJournal;
}
