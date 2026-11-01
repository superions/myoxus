// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  canPreserveBpmnSource,
  inspectBpmnBytes,
  type BpmnByteInspection,
} from "@myoxus/bpmn-editor/source";
import type {
  DiagramCreationResult,
  MermaidDiagramsService,
} from "./mermaid-diagrams";

export type BpmnImportEntry = {
  /** Retained only by the visible import attempt, including rejected bytes. */
  file: File;
  inspection: BpmnByteInspection;
  creation?: DiagramCreationResult;
};
export type BpmnImportResult = { entries: BpmnImportEntry[]; docIds: string[] };

export function isPreservableBpmnImport(entry: BpmnImportEntry) {
  return (
    entry.inspection.source !== undefined &&
    canPreserveBpmnSource(entry.inspection)
  );
}

/** Preflight original bytes with the fork before creation. No XML/Markdown
 * parser, line-ending conversion or editor host belongs in this orchestration. */
export async function prepareBpmnImport(
  files: File[],
): Promise<BpmnImportResult> {
  const entries = await Promise.all(
    files.map(async (file) => ({
      file,
      inspection: inspectBpmnBytes(new Uint8Array(await file.arrayBuffer())),
    })),
  );
  return { entries, docIds: [] };
}

/** Resume failed original IDs, skip completed files, and stop at a retained
 * creation failure. Later files stay queued with their original bytes. Once
 * created, persisted block source—not this transient File—is authoritative. */
export async function runBpmnImport(
  registry: MermaidDiagramsService,
  attempt: BpmnImportResult,
): Promise<BpmnImportResult> {
  const entries = attempt.entries.map((entry) => ({ ...entry }));
  for (const entry of entries) {
    if (!isPreservableBpmnImport(entry) || entry.creation?.status === "ready")
      continue;
    const active = registry.creation$.value;
    // Never associate a selected file with an unrelated retained catalog target.
    if (
      (active?.busy || active?.failed) &&
      active.docId !== entry.creation?.docId
    )
      break;
    entry.creation = entry.creation
      ? await registry.retryCreation(entry.creation.docId)
      : await registry.createDiagram(
          {
            format: "bpmn",
            type: "bpmn",
            title: entry.file.name.replace(/\.bpmn$/i, ""),
            source: entry.inspection.source!,
            preserveUnsupported: true,
          },
          { origin: "import" },
        );
    if (entry.creation.status === "failed") break;
  }
  return {
    entries,
    docIds: entries.flatMap((entry) =>
      entry.creation?.status === "ready" ? [entry.creation.docId] : [],
    ),
  };
}
