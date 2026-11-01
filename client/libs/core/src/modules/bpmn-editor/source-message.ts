// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BpmnSourceErrorCode } from "@myoxus/bpmn-editor/source";
import type { useI18n } from "@myoxus/i18n";

/** Presentation only: the fork's inspector owns decisions, never a host allowlist. */
export function bpmnSourceErrorText(
  t: ReturnType<typeof useI18n>,
  code: BpmnSourceErrorCode,
): string {
  switch (code) {
    case "BPMN_UNSUPPORTED_XML_VERSION":
      return t["com.myoxus.editor.bpmn.error.xml-version"]();
    case "BPMN_INVALID_UTF8":
    case "BPMN_XML_ENCODING":
      return t["com.myoxus.editor.bpmn.error.encoding"]();
    case "BPMN_UNSAFE_XML":
      return t["com.myoxus.editor.bpmn.error.unsafe"]();
    case "BPMN_XML_DEPTH":
      return t["com.myoxus.editor.bpmn.error.depth"]();
    case "BPMN_XML_ATTRIBUTES":
      return t["com.myoxus.editor.bpmn.error.attributes"]();
    case "BPMN_XML_ATTRIBUTE_LENGTH":
      return t["com.myoxus.editor.bpmn.error.attribute-length"]();
    case "BPMN_XML_WORK":
      return t["com.myoxus.editor.bpmn.error.work"]();
    case "BPMN_XML_TOKENS":
      return t["com.myoxus.editor.bpmn.error.tokens"]();
    case "BPMN_RENDER_OBJECTS":
      return t["com.myoxus.editor.bpmn.error.render-objects"]();
    case "BPMN_UNKNOWN_ROOT":
    case "BPMN_UNKNOWN_NAMESPACE":
      return t["com.myoxus.editor.bpmn.error.not-bpmn"]();
    case "BPMN_MALFORMED_XML":
      return t["com.myoxus.editor.bpmn.error.malformed"]();
    case "BPMN_PARSER_FAILURE":
      return t["com.myoxus.editor.bpmn.error.internal"]();
    case "BPMN_MISSING_DI":
    case "BPMN_INCOMPLETE_DI":
    case "BPMN_PLANE_OWNER":
      return t["com.myoxus.editor.bpmn.error.geometry"]();
    default:
      return t["com.myoxus.editor.bpmn.error.unsupported"]();
  }
}
