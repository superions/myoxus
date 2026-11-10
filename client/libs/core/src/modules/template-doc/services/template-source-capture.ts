// SPDX-License-Identifier: AGPL-3.0-or-later

import { Slice, type SliceSnapshot, type Transformer } from "@virgultum/store";
import { encodeStateAsUpdate } from "yjs";

import type { Doc } from "../../doc/entities/doc";
import { removeUnboundTemplateReferences } from "../../doc/services/native-template-references";
import { inspectTemplateSnapshot } from "../../doc/services/template-repeat";
import {
  templateInputNames,
  validateTemplateDocumentFields,
} from "./template-inputs";
import { prepareTemplateTextProtection } from "./template-text-protection";

export interface TemplateSourceCapture {
  readonly sourceDocId: string;
  /** Native state, including deletions, at the same capture as the body. */
  readonly revision: Uint8Array;
  /** Detached root children. Consumers clone this snapshot before transforming it. */
  readonly body: SliceSnapshot;
  readonly sourceTitle: string;
  readonly title: string | undefined;
  readonly properties: ReturnType<Doc["getProperties"]>;
  readonly inspection: ReturnType<typeof inspectTemplateSnapshot>;
  readonly inputNames: readonly string[];
  readonly release: () => void;
}

/**
 * Capture an already-synchronized source without resolving values or writing a
 * destination. Title policy, properties and body are read synchronously once.
 * The result exposes the caller's existing source lifetime; capture failures
 * leave its cleanup with the caller as well.
 */
export function captureTemplateSource(
  source: { doc: Doc; release: () => void },
  transformer: Transformer,
  titleInput?: string | ((sourceTitle: string) => string | undefined),
): TemplateSourceCapture {
  const { doc } = source;
  const native = doc.virgultumDoc;
  const body = transformer.sliceToSnapshot(
    Slice.fromModels(native, [...(native.root?.children ?? [])]),
  );
  if (!body) throw new Error(`Failed to snapshot document: ${doc.id}`);
  removeUnboundTemplateReferences(body);
  validateTemplateDocumentFields(body);
  prepareTemplateTextProtection(body);
  const sourceTitle = doc.title$.value;
  const title =
    typeof titleInput === "function" ? titleInput(sourceTitle) : titleInput;
  const properties = { ...doc.getProperties() };
  const inspection = inspectTemplateSnapshot(body, title);
  return {
    sourceDocId: doc.id,
    revision: encodeStateAsUpdate(doc.yDoc),
    body,
    sourceTitle,
    title,
    properties,
    inspection,
    inputNames: templateInputNames(inspection.required),
    release: source.release,
  };
}
