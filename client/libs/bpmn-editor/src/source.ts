// SPDX-License-Identifier: AGPL-3.0-or-later

// Keep this entry independent of the modeller: document workers load source
// contracts without React, browser globals, stylesheets or canvas initialization.
export {
  BPMN_LATEST_VERSION,
  getMarshaller,
  type BpmnLatestModel,
  type BpmnMarshaller,
} from "./marshaller";
export type * from "./schemas/bpmn-2_0/ts-gen/types";
export {
  createBlankBpmnSource,
  BpmnSourceError,
  type BpmnSourceErrorCode,
} from "./process-source";
export { inspectBpmnSource, type BpmnSourceInspection } from "./process-source";
export { inspectBpmnBytes, type BpmnByteInspection } from "./process-source";
export { canPreserveBpmnSource } from "./process-source";
