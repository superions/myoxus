// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-OMG-BPMN
// Generated from unmodified OMG BPMN 2.0.2 schemas by the adapted Apache KIE generator.
// See provenance.json and THIRD-PARTY-NOTICES. Do not edit; run yarn workspace @myoxus/bpmn-editor generate.

import type { XmlParserTsRootElementBaseType } from "../../../xml-parser";

export type BPMN20__tAdHocOrdering = "Parallel" | "Sequential";

export type BPMN20__tAssociationDirection = "None" | "One" | "Both";

export type BPMN20__tChoreographyLoopType =
  "None" | "Standard" | "MultiInstanceSequential" | "MultiInstanceParallel";

export type BPMN20__tEventBasedGatewayType = "Exclusive" | "Parallel";

export type BPMN20__tGatewayDirection =
  "Unspecified" | "Converging" | "Diverging" | "Mixed";

export type BPMN20__tImplementation = string; // xsd:anyURI

export type BPMN20__tItemKind = "Information" | "Physical";

export type BPMN20__tMultiInstanceFlowCondition =
  "None" | "One" | "All" | "Complex";

export type BPMN20__tProcessType = "None" | "Public" | "Private";

export type BPMN20__tRelationshipDirection =
  "None" | "Forward" | "Backward" | "Both";

export type BPMN20__tTransactionMethod = string; // xsd:anyURI

export type BPMNDI__ParticipantBandKind =
  | "top_initiating"
  | "middle_initiating"
  | "bottom_initiating"
  | "top_non_initiating"
  | "middle_non_initiating"
  | "bottom_non_initiating";

export type BPMNDI__MessageVisibleKind = "initiating" | "non_initiating";

export interface BPMN20__tDefinitions extends XmlParserTsRootElementBaseType {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "@_targetNamespace": string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "@_expressionLanguage"?: string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "@_typeLanguage"?: string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "@_exporter"?: string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "@_exporterVersion"?: string; // from type BPMN20__tDefinitions @ BPMN20.xsd
  import?: BPMN20__tImport[]; // from type BPMN20__tDefinitions @ BPMN20.xsd
  extension?: BPMN20__tExtension[]; // from type BPMN20__tDefinitions @ BPMN20.xsd
  rootElement?: (
    /* From subsitution groups */
    | ({ __$$element: "category" } & BPMN20__tCategory)
    | ({ __$$element: "collaboration" } & BPMN20__tCollaboration)
    | ({ __$$element: "choreography" } & BPMN20__tChoreography)
    | ({
        __$$element: "globalChoreographyTask";
      } & BPMN20__tGlobalChoreographyTask)
    | ({ __$$element: "globalConversation" } & BPMN20__tGlobalConversation)
    | ({ __$$element: "correlationProperty" } & BPMN20__tCorrelationProperty)
    | ({ __$$element: "dataStore" } & BPMN20__tDataStore)
    | ({ __$$element: "endPoint" } & BPMN20__tEndPoint)
    | ({ __$$element: "error" } & BPMN20__tError)
    | ({ __$$element: "escalation" } & BPMN20__tEscalation)
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
    | ({
        __$$element: "globalBusinessRuleTask";
      } & BPMN20__tGlobalBusinessRuleTask)
    | ({ __$$element: "globalManualTask" } & BPMN20__tGlobalManualTask)
    | ({ __$$element: "globalScriptTask" } & BPMN20__tGlobalScriptTask)
    | ({ __$$element: "globalTask" } & BPMN20__tGlobalTask)
    | ({ __$$element: "globalUserTask" } & BPMN20__tGlobalUserTask)
    | ({ __$$element: "interface" } & BPMN20__tInterface)
    | ({ __$$element: "itemDefinition" } & BPMN20__tItemDefinition)
    | ({ __$$element: "message" } & BPMN20__tMessage)
    | ({ __$$element: "partnerEntity" } & BPMN20__tPartnerEntity)
    | ({ __$$element: "partnerRole" } & BPMN20__tPartnerRole)
    | ({ __$$element: "process" } & BPMN20__tProcess)
    | ({ __$$element: "resource" } & BPMN20__tResource)
    | ({ __$$element: "signal" } & BPMN20__tSignal)
  )[]; // from type BPMN20__tDefinitions @ BPMN20.xsd
  "bpmndi:BPMNDiagram"?: BPMNDI__BPMNDiagram[]; // from type BPMN20__tDefinitions @ BPMNDI.xsd
  relationship?: BPMN20__tRelationship[]; // from type BPMN20__tDefinitions @ BPMN20.xsd
}

export type BPMN20__tImport = {
  "@_namespace": string; // from type BPMN20__tImport @ BPMN20.xsd
  "@_location": string; // from type BPMN20__tImport @ BPMN20.xsd
  "@_importType": string; // from type BPMN20__tImport @ BPMN20.xsd
};

export interface BPMN20__tActivity /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
}

export interface BPMN20__tAdHocSubProcess {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_triggeredByEvent"?: boolean; // from type BPMN20__tSubProcess @ BPMN20.xsd
  laneSet?: BPMN20__tLaneSet[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  "@_cancelRemainingInstances"?: boolean; // from type BPMN20__tAdHocSubProcess @ BPMN20.xsd
  "@_ordering"?: BPMN20__tAdHocOrdering; // from type BPMN20__tAdHocSubProcess @ BPMN20.xsd
  completionCondition?: BPMN20__tExpression; // from type BPMN20__tAdHocSubProcess @ BPMN20.xsd
}

export interface BPMN20__tArtifact /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tAssignment {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  from: BPMN20__tExpression; // from type BPMN20__tAssignment @ BPMN20.xsd
  to: BPMN20__tExpression; // from type BPMN20__tAssignment @ BPMN20.xsd
}

export interface BPMN20__tAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_sourceRef": string; // from type BPMN20__tAssociation @ BPMN20.xsd
  "@_targetRef": string; // from type BPMN20__tAssociation @ BPMN20.xsd
  "@_associationDirection"?: BPMN20__tAssociationDirection; // from type BPMN20__tAssociation @ BPMN20.xsd
}

export interface BPMN20__tAuditing {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tBaseElement /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tBaseElementWithMixedContent /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  __$$text?: string; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
}

export interface BPMN20__tBoundaryEvent {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  "@_parallelMultiple"?: boolean; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutput?: BPMN20__tDataOutput[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  outputSet?: BPMN20__tOutputSet; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  "@_cancelActivity"?: boolean; // from type BPMN20__tBoundaryEvent @ BPMN20.xsd
  "@_attachedToRef": string; // from type BPMN20__tBoundaryEvent @ BPMN20.xsd
}

export interface BPMN20__tBusinessRuleTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tBusinessRuleTask @ BPMN20.xsd
}

export interface BPMN20__tCallableElement {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
}

export interface BPMN20__tCallActivity {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_calledElement"?: string; // from type BPMN20__tCallActivity @ BPMN20.xsd
}

export interface BPMN20__tCallChoreography {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_initiatingParticipantRef": string; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  "@_loopType"?: BPMN20__tChoreographyLoopType; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  participantRef: { __$$text: string }[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  "@_calledChoreographyRef"?: string; // from type BPMN20__tCallChoreography @ BPMN20.xsd
  participantAssociation?: BPMN20__tParticipantAssociation[]; // from type BPMN20__tCallChoreography @ BPMN20.xsd
}

export interface BPMN20__tCallConversation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tConversationNode @ BPMN20.xsd
  participantRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  messageFlowRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  "@_calledCollaborationRef"?: string; // from type BPMN20__tCallConversation @ BPMN20.xsd
  participantAssociation?: BPMN20__tParticipantAssociation[]; // from type BPMN20__tCallConversation @ BPMN20.xsd
}

export interface BPMN20__tCancelEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tCatchEvent /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  "@_parallelMultiple"?: boolean; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutput?: BPMN20__tDataOutput[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  outputSet?: BPMN20__tOutputSet; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
}

export interface BPMN20__tCategory {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCategory @ BPMN20.xsd
  categoryValue?: BPMN20__tCategoryValue[]; // from type BPMN20__tCategory @ BPMN20.xsd
}

export interface BPMN20__tCategoryValue {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_value"?: string; // from type BPMN20__tCategoryValue @ BPMN20.xsd
}

export interface BPMN20__tChoreography {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCollaboration @ BPMN20.xsd
  "@_isClosed"?: boolean; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participant?: BPMN20__tParticipant[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlow?: BPMN20__tMessageFlow[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationNode?: (
    /* From subsitution groups */
    | ({ __$$element: "callConversation" } & BPMN20__tCallConversation)
    | ({ __$$element: "conversation" } & BPMN20__tConversation)
    | ({ __$$element: "subConversation" } & BPMN20__tSubConversation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationAssociation?: BPMN20__tConversationAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participantAssociation?: BPMN20__tParticipantAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlowAssociation?: BPMN20__tMessageFlowAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  choreographyRef?: { __$$text: string }[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationLink?: BPMN20__tConversationLink[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tChoreography @ BPMN20.xsd
}

export interface BPMN20__tChoreographyActivity /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_initiatingParticipantRef": string; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  "@_loopType"?: BPMN20__tChoreographyLoopType; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  participantRef: { __$$text: string }[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
}

export interface BPMN20__tChoreographyTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_initiatingParticipantRef": string; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  "@_loopType"?: BPMN20__tChoreographyLoopType; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  participantRef: { __$$text: string }[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  messageFlowRef: { __$$text: string }[]; // from type BPMN20__tChoreographyTask @ BPMN20.xsd
}

export interface BPMN20__tCollaboration {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCollaboration @ BPMN20.xsd
  "@_isClosed"?: boolean; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participant?: BPMN20__tParticipant[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlow?: BPMN20__tMessageFlow[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationNode?: (
    /* From subsitution groups */
    | ({ __$$element: "callConversation" } & BPMN20__tCallConversation)
    | ({ __$$element: "conversation" } & BPMN20__tConversation)
    | ({ __$$element: "subConversation" } & BPMN20__tSubConversation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationAssociation?: BPMN20__tConversationAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participantAssociation?: BPMN20__tParticipantAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlowAssociation?: BPMN20__tMessageFlowAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  choreographyRef?: { __$$text: string }[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationLink?: BPMN20__tConversationLink[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
}

export interface BPMN20__tCompensateEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_waitForCompletion"?: boolean; // from type BPMN20__tCompensateEventDefinition @ BPMN20.xsd
  "@_activityRef"?: string; // from type BPMN20__tCompensateEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tComplexBehaviorDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  condition: BPMN20__tFormalExpression; // from type BPMN20__tComplexBehaviorDefinition @ BPMN20.xsd
  event?: BPMN20__tImplicitThrowEvent; // from type BPMN20__tComplexBehaviorDefinition @ BPMN20.xsd
}

export interface BPMN20__tComplexGateway {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_gatewayDirection"?: BPMN20__tGatewayDirection; // from type BPMN20__tGateway @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tComplexGateway @ BPMN20.xsd
  activationCondition?: BPMN20__tExpression; // from type BPMN20__tComplexGateway @ BPMN20.xsd
}

export interface BPMN20__tConditionalEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  condition: BPMN20__tExpression; // from type BPMN20__tConditionalEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tConversation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tConversationNode @ BPMN20.xsd
  participantRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  messageFlowRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
}

export interface BPMN20__tConversationAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_innerConversationNodeRef": string; // from type BPMN20__tConversationAssociation @ BPMN20.xsd
  "@_outerConversationNodeRef": string; // from type BPMN20__tConversationAssociation @ BPMN20.xsd
}

export interface BPMN20__tConversationLink {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tConversationLink @ BPMN20.xsd
  "@_sourceRef": string; // from type BPMN20__tConversationLink @ BPMN20.xsd
  "@_targetRef": string; // from type BPMN20__tConversationLink @ BPMN20.xsd
}

export interface BPMN20__tConversationNode /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tConversationNode @ BPMN20.xsd
  participantRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  messageFlowRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
}

export interface BPMN20__tCorrelationKey {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCorrelationKey @ BPMN20.xsd
  correlationPropertyRef?: { __$$text: string }[]; // from type BPMN20__tCorrelationKey @ BPMN20.xsd
}

export interface BPMN20__tCorrelationProperty {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCorrelationProperty @ BPMN20.xsd
  "@_type"?: string; // from type BPMN20__tCorrelationProperty @ BPMN20.xsd
  correlationPropertyRetrievalExpression: BPMN20__tCorrelationPropertyRetrievalExpression[]; // from type BPMN20__tCorrelationProperty @ BPMN20.xsd
}

export interface BPMN20__tCorrelationPropertyBinding {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_correlationPropertyRef": string; // from type BPMN20__tCorrelationPropertyBinding @ BPMN20.xsd
  dataPath: BPMN20__tFormalExpression; // from type BPMN20__tCorrelationPropertyBinding @ BPMN20.xsd
}

export interface BPMN20__tCorrelationPropertyRetrievalExpression {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_messageRef": string; // from type BPMN20__tCorrelationPropertyRetrievalExpression @ BPMN20.xsd
  messagePath: BPMN20__tFormalExpression; // from type BPMN20__tCorrelationPropertyRetrievalExpression @ BPMN20.xsd
}

export interface BPMN20__tCorrelationSubscription {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_correlationKeyRef": string; // from type BPMN20__tCorrelationSubscription @ BPMN20.xsd
  correlationPropertyBinding?: BPMN20__tCorrelationPropertyBinding[]; // from type BPMN20__tCorrelationSubscription @ BPMN20.xsd
}

export interface BPMN20__tDataAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  sourceRef?: { __$$text: string }[]; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  targetRef: { __$$text: string }; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  transformation?: BPMN20__tFormalExpression; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  assignment?: BPMN20__tAssignment[]; // from type BPMN20__tDataAssociation @ BPMN20.xsd
}

export interface BPMN20__tDataInput {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tDataInput @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tDataInput @ BPMN20.xsd
  "@_isCollection"?: boolean; // from type BPMN20__tDataInput @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tDataInput @ BPMN20.xsd
}

export interface BPMN20__tDataInputAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  sourceRef?: { __$$text: string }[]; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  targetRef: { __$$text: string }; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  transformation?: BPMN20__tFormalExpression; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  assignment?: BPMN20__tAssignment[]; // from type BPMN20__tDataAssociation @ BPMN20.xsd
}

export interface BPMN20__tDataObject {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tDataObject @ BPMN20.xsd
  "@_isCollection"?: boolean; // from type BPMN20__tDataObject @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tDataObject @ BPMN20.xsd
}

export interface BPMN20__tDataObjectReference {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tDataObjectReference @ BPMN20.xsd
  "@_dataObjectRef"?: string; // from type BPMN20__tDataObjectReference @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tDataObjectReference @ BPMN20.xsd
}

export interface BPMN20__tDataOutput {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tDataOutput @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tDataOutput @ BPMN20.xsd
  "@_isCollection"?: boolean; // from type BPMN20__tDataOutput @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tDataOutput @ BPMN20.xsd
}

export interface BPMN20__tDataOutputAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  sourceRef?: { __$$text: string }[]; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  targetRef: { __$$text: string }; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  transformation?: BPMN20__tFormalExpression; // from type BPMN20__tDataAssociation @ BPMN20.xsd
  assignment?: BPMN20__tAssignment[]; // from type BPMN20__tDataAssociation @ BPMN20.xsd
}

export interface BPMN20__tDataState {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tDataState @ BPMN20.xsd
}

export interface BPMN20__tDataStore {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tDataStore @ BPMN20.xsd
  "@_capacity"?: number; // from type BPMN20__tDataStore @ BPMN20.xsd
  "@_isUnlimited"?: boolean; // from type BPMN20__tDataStore @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tDataStore @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tDataStore @ BPMN20.xsd
}

export interface BPMN20__tDataStoreReference {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tDataStoreReference @ BPMN20.xsd
  "@_dataStoreRef"?: string; // from type BPMN20__tDataStoreReference @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tDataStoreReference @ BPMN20.xsd
}

export interface BPMN20__tDocumentation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tDocumentation @ BPMN20.xsd
  "@_textFormat"?: string; // from type BPMN20__tDocumentation @ BPMN20.xsd
  __$$text?: string; // from type BPMN20__tDocumentation @ BPMN20.xsd
}

export interface BPMN20__tEndEvent {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  dataInput?: BPMN20__tDataInput[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  inputSet?: BPMN20__tInputSet; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
}

export interface BPMN20__tEndPoint {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tError {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tError @ BPMN20.xsd
  "@_errorCode"?: string; // from type BPMN20__tError @ BPMN20.xsd
  "@_structureRef"?: string; // from type BPMN20__tError @ BPMN20.xsd
}

export interface BPMN20__tErrorEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_errorRef"?: string; // from type BPMN20__tErrorEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tEscalation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tEscalation @ BPMN20.xsd
  "@_escalationCode"?: string; // from type BPMN20__tEscalation @ BPMN20.xsd
  "@_structureRef"?: string; // from type BPMN20__tEscalation @ BPMN20.xsd
}

export interface BPMN20__tEscalationEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_escalationRef"?: string; // from type BPMN20__tEscalationEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tEvent /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
}

export interface BPMN20__tEventBasedGateway {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_gatewayDirection"?: BPMN20__tGatewayDirection; // from type BPMN20__tGateway @ BPMN20.xsd
  "@_instantiate"?: boolean; // from type BPMN20__tEventBasedGateway @ BPMN20.xsd
  "@_eventGatewayType"?: BPMN20__tEventBasedGatewayType; // from type BPMN20__tEventBasedGateway @ BPMN20.xsd
}

export interface BPMN20__tEventDefinition /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tExclusiveGateway {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_gatewayDirection"?: BPMN20__tGatewayDirection; // from type BPMN20__tGateway @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tExclusiveGateway @ BPMN20.xsd
}

export interface BPMN20__tExpression {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  __$$text?: string; // from type BPMN20__tExpression @ BPMN20.xsd
}

export type BPMN20__tExtension = {
  "@_definition"?: string; // from type BPMN20__tExtension @ BPMN20.xsd
  "@_mustUnderstand"?: boolean; // from type BPMN20__tExtension @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tExtension @ BPMN20.xsd
};

export interface BPMN20__tExtensionElements {
  __?: undefined;
}

export interface BPMN20__tFlowElement /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
}

export interface BPMN20__tFlowNode /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
}

export interface BPMN20__tFormalExpression {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElementWithMixedContent @ BPMN20.xsd
  "@_language"?: string; // from type BPMN20__tFormalExpression @ BPMN20.xsd
  "@_evaluatesToTypeRef"?: string; // from type BPMN20__tFormalExpression @ BPMN20.xsd
  __$$text?: string; // from type BPMN20__tFormalExpression @ BPMN20.xsd
}

export interface BPMN20__tGateway {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_gatewayDirection"?: BPMN20__tGatewayDirection; // from type BPMN20__tGateway @ BPMN20.xsd
}

export interface BPMN20__tGlobalBusinessRuleTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tGlobalTask @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tGlobalBusinessRuleTask @ BPMN20.xsd
}

export interface BPMN20__tGlobalChoreographyTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCollaboration @ BPMN20.xsd
  "@_isClosed"?: boolean; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participant?: BPMN20__tParticipant[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlow?: BPMN20__tMessageFlow[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationNode?: (
    /* From subsitution groups */
    | ({ __$$element: "callConversation" } & BPMN20__tCallConversation)
    | ({ __$$element: "conversation" } & BPMN20__tConversation)
    | ({ __$$element: "subConversation" } & BPMN20__tSubConversation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationAssociation?: BPMN20__tConversationAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participantAssociation?: BPMN20__tParticipantAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlowAssociation?: BPMN20__tMessageFlowAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  choreographyRef?: { __$$text: string }[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationLink?: BPMN20__tConversationLink[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tChoreography @ BPMN20.xsd
  "@_initiatingParticipantRef"?: string; // from type BPMN20__tGlobalChoreographyTask @ BPMN20.xsd
}

export interface BPMN20__tGlobalConversation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCollaboration @ BPMN20.xsd
  "@_isClosed"?: boolean; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participant?: BPMN20__tParticipant[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlow?: BPMN20__tMessageFlow[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationNode?: (
    /* From subsitution groups */
    | ({ __$$element: "callConversation" } & BPMN20__tCallConversation)
    | ({ __$$element: "conversation" } & BPMN20__tConversation)
    | ({ __$$element: "subConversation" } & BPMN20__tSubConversation)
  )[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationAssociation?: BPMN20__tConversationAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  participantAssociation?: BPMN20__tParticipantAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  messageFlowAssociation?: BPMN20__tMessageFlowAssociation[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  choreographyRef?: { __$$text: string }[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
  conversationLink?: BPMN20__tConversationLink[]; // from type BPMN20__tCollaboration @ BPMN20.xsd
}

export interface BPMN20__tGlobalManualTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tGlobalTask @ BPMN20.xsd
}

export interface BPMN20__tGlobalScriptTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tGlobalTask @ BPMN20.xsd
  "@_scriptLanguage"?: string; // from type BPMN20__tGlobalScriptTask @ BPMN20.xsd
  script?: BPMN20__tScript; // from type BPMN20__tGlobalScriptTask @ BPMN20.xsd
}

export interface BPMN20__tGlobalTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tGlobalTask @ BPMN20.xsd
}

export interface BPMN20__tGlobalUserTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tGlobalTask @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tGlobalUserTask @ BPMN20.xsd
  rendering?: BPMN20__tRendering[]; // from type BPMN20__tGlobalUserTask @ BPMN20.xsd
}

export interface BPMN20__tGroup {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_categoryValueRef"?: string; // from type BPMN20__tGroup @ BPMN20.xsd
}

export interface BPMN20__tHumanPerformer {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceAssignmentExpression?: BPMN20__tResourceAssignmentExpression; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceRef?: { __$$text: string }; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceParameterBinding?: BPMN20__tResourceParameterBinding[]; // from type BPMN20__tResourceRole @ BPMN20.xsd
}

export interface BPMN20__tImplicitThrowEvent {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  dataInput?: BPMN20__tDataInput[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  inputSet?: BPMN20__tInputSet; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
}

export interface BPMN20__tInclusiveGateway {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_gatewayDirection"?: BPMN20__tGatewayDirection; // from type BPMN20__tGateway @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tInclusiveGateway @ BPMN20.xsd
}

export interface BPMN20__tInputSet {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tInputSet @ BPMN20.xsd
  dataInputRefs?: { __$$text: string }[]; // from type BPMN20__tInputSet @ BPMN20.xsd
  optionalInputRefs?: { __$$text: string }[]; // from type BPMN20__tInputSet @ BPMN20.xsd
  whileExecutingInputRefs?: { __$$text: string }[]; // from type BPMN20__tInputSet @ BPMN20.xsd
  outputSetRefs?: { __$$text: string }[]; // from type BPMN20__tInputSet @ BPMN20.xsd
}

export interface BPMN20__tInterface {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name": string; // from type BPMN20__tInterface @ BPMN20.xsd
  "@_implementationRef"?: string; // from type BPMN20__tInterface @ BPMN20.xsd
  operation: BPMN20__tOperation[]; // from type BPMN20__tInterface @ BPMN20.xsd
}

export interface BPMN20__tIntermediateCatchEvent {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  "@_parallelMultiple"?: boolean; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutput?: BPMN20__tDataOutput[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  outputSet?: BPMN20__tOutputSet; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
}

export interface BPMN20__tIntermediateThrowEvent {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  dataInput?: BPMN20__tDataInput[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  inputSet?: BPMN20__tInputSet; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
}

export interface BPMN20__tInputOutputBinding {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_operationRef": string; // from type BPMN20__tInputOutputBinding @ BPMN20.xsd
  "@_inputDataRef": string; // from type BPMN20__tInputOutputBinding @ BPMN20.xsd
  "@_outputDataRef": string; // from type BPMN20__tInputOutputBinding @ BPMN20.xsd
}

export interface BPMN20__tInputOutputSpecification {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  dataInput?: BPMN20__tDataInput[]; // from type BPMN20__tInputOutputSpecification @ BPMN20.xsd
  dataOutput?: BPMN20__tDataOutput[]; // from type BPMN20__tInputOutputSpecification @ BPMN20.xsd
  inputSet: BPMN20__tInputSet[]; // from type BPMN20__tInputOutputSpecification @ BPMN20.xsd
  outputSet: BPMN20__tOutputSet[]; // from type BPMN20__tInputOutputSpecification @ BPMN20.xsd
}

export interface BPMN20__tItemDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_structureRef"?: string; // from type BPMN20__tItemDefinition @ BPMN20.xsd
  "@_isCollection"?: boolean; // from type BPMN20__tItemDefinition @ BPMN20.xsd
  "@_itemKind"?: BPMN20__tItemKind; // from type BPMN20__tItemDefinition @ BPMN20.xsd
}

export interface BPMN20__tLane {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tLane @ BPMN20.xsd
  "@_partitionElementRef"?: string; // from type BPMN20__tLane @ BPMN20.xsd
  partitionElement?: BPMN20__tBaseElement; // from type BPMN20__tLane @ BPMN20.xsd
  flowNodeRef?: { __$$text: string }[]; // from type BPMN20__tLane @ BPMN20.xsd
  childLaneSet?: BPMN20__tLaneSet; // from type BPMN20__tLane @ BPMN20.xsd
}

export interface BPMN20__tLaneSet {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tLaneSet @ BPMN20.xsd
  lane?: BPMN20__tLane[]; // from type BPMN20__tLaneSet @ BPMN20.xsd
}

export interface BPMN20__tLinkEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name": string; // from type BPMN20__tLinkEventDefinition @ BPMN20.xsd
  source?: { __$$text: string }[]; // from type BPMN20__tLinkEventDefinition @ BPMN20.xsd
  target?: { __$$text: string }; // from type BPMN20__tLinkEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tLoopCharacteristics /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tManualTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
}

export interface BPMN20__tMessage {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tMessage @ BPMN20.xsd
  "@_itemRef"?: string; // from type BPMN20__tMessage @ BPMN20.xsd
}

export interface BPMN20__tMessageEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_messageRef"?: string; // from type BPMN20__tMessageEventDefinition @ BPMN20.xsd
  operationRef?: { __$$text: string }; // from type BPMN20__tMessageEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tMessageFlow {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tMessageFlow @ BPMN20.xsd
  "@_sourceRef": string; // from type BPMN20__tMessageFlow @ BPMN20.xsd
  "@_targetRef": string; // from type BPMN20__tMessageFlow @ BPMN20.xsd
  "@_messageRef"?: string; // from type BPMN20__tMessageFlow @ BPMN20.xsd
}

export interface BPMN20__tMessageFlowAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_innerMessageFlowRef": string; // from type BPMN20__tMessageFlowAssociation @ BPMN20.xsd
  "@_outerMessageFlowRef": string; // from type BPMN20__tMessageFlowAssociation @ BPMN20.xsd
}

export interface BPMN20__tMonitoring {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tMultiInstanceLoopCharacteristics {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_isSequential"?: boolean; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  "@_behavior"?: BPMN20__tMultiInstanceFlowCondition; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  "@_oneBehaviorEventRef"?: string; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  "@_noneBehaviorEventRef"?: string; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  loopCardinality?: BPMN20__tExpression; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  loopDataInputRef?: { __$$text: string }; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  loopDataOutputRef?: { __$$text: string }; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  inputDataItem?: BPMN20__tDataInput; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  outputDataItem?: BPMN20__tDataOutput; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  complexBehaviorDefinition?: BPMN20__tComplexBehaviorDefinition[]; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
  completionCondition?: BPMN20__tExpression; // from type BPMN20__tMultiInstanceLoopCharacteristics @ BPMN20.xsd
}

export interface BPMN20__tOperation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name": string; // from type BPMN20__tOperation @ BPMN20.xsd
  "@_implementationRef"?: string; // from type BPMN20__tOperation @ BPMN20.xsd
  inMessageRef: { __$$text: string }; // from type BPMN20__tOperation @ BPMN20.xsd
  outMessageRef?: { __$$text: string }; // from type BPMN20__tOperation @ BPMN20.xsd
  errorRef?: { __$$text: string }[]; // from type BPMN20__tOperation @ BPMN20.xsd
}

export interface BPMN20__tOutputSet {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tOutputSet @ BPMN20.xsd
  dataOutputRefs?: { __$$text: string }[]; // from type BPMN20__tOutputSet @ BPMN20.xsd
  optionalOutputRefs?: { __$$text: string }[]; // from type BPMN20__tOutputSet @ BPMN20.xsd
  whileExecutingOutputRefs?: { __$$text: string }[]; // from type BPMN20__tOutputSet @ BPMN20.xsd
  inputSetRefs?: { __$$text: string }[]; // from type BPMN20__tOutputSet @ BPMN20.xsd
}

export interface BPMN20__tParallelGateway {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_gatewayDirection"?: BPMN20__tGatewayDirection; // from type BPMN20__tGateway @ BPMN20.xsd
}

export interface BPMN20__tParticipant {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tParticipant @ BPMN20.xsd
  "@_processRef"?: string; // from type BPMN20__tParticipant @ BPMN20.xsd
  interfaceRef?: { __$$text: string }[]; // from type BPMN20__tParticipant @ BPMN20.xsd
  endPointRef?: { __$$text: string }[]; // from type BPMN20__tParticipant @ BPMN20.xsd
  participantMultiplicity?: BPMN20__tParticipantMultiplicity; // from type BPMN20__tParticipant @ BPMN20.xsd
}

export interface BPMN20__tParticipantAssociation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  innerParticipantRef: { __$$text: string }; // from type BPMN20__tParticipantAssociation @ BPMN20.xsd
  outerParticipantRef: { __$$text: string }; // from type BPMN20__tParticipantAssociation @ BPMN20.xsd
}

export interface BPMN20__tParticipantMultiplicity {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_minimum"?: number; // from type BPMN20__tParticipantMultiplicity @ BPMN20.xsd
  "@_maximum"?: number; // from type BPMN20__tParticipantMultiplicity @ BPMN20.xsd
}

export interface BPMN20__tPartnerEntity {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tPartnerEntity @ BPMN20.xsd
  participantRef?: { __$$text: string }[]; // from type BPMN20__tPartnerEntity @ BPMN20.xsd
}

export interface BPMN20__tPartnerRole {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tPartnerRole @ BPMN20.xsd
  participantRef?: { __$$text: string }[]; // from type BPMN20__tPartnerRole @ BPMN20.xsd
}

export interface BPMN20__tPerformer {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceAssignmentExpression?: BPMN20__tResourceAssignmentExpression; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceRef?: { __$$text: string }; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceParameterBinding?: BPMN20__tResourceParameterBinding[]; // from type BPMN20__tResourceRole @ BPMN20.xsd
}

export interface BPMN20__tPotentialOwner {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceAssignmentExpression?: BPMN20__tResourceAssignmentExpression; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceRef?: { __$$text: string }; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceParameterBinding?: BPMN20__tResourceParameterBinding[]; // from type BPMN20__tResourceRole @ BPMN20.xsd
}

export interface BPMN20__tProcess {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tCallableElement @ BPMN20.xsd
  supportedInterfaceRef?: { __$$text: string }[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tCallableElement @ BPMN20.xsd
  ioBinding?: BPMN20__tInputOutputBinding[]; // from type BPMN20__tCallableElement @ BPMN20.xsd
  "@_processType"?: BPMN20__tProcessType; // from type BPMN20__tProcess @ BPMN20.xsd
  "@_isClosed"?: boolean; // from type BPMN20__tProcess @ BPMN20.xsd
  "@_isExecutable"?: boolean; // from type BPMN20__tProcess @ BPMN20.xsd
  "@_definitionalCollaborationRef"?: string; // from type BPMN20__tProcess @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tProcess @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tProcess @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tProcess @ BPMN20.xsd
  laneSet?: BPMN20__tLaneSet[]; // from type BPMN20__tProcess @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tProcess @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tProcess @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tProcess @ BPMN20.xsd
  correlationSubscription?: BPMN20__tCorrelationSubscription[]; // from type BPMN20__tProcess @ BPMN20.xsd
  supports?: { __$$text: string }[]; // from type BPMN20__tProcess @ BPMN20.xsd
}

export interface BPMN20__tProperty {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tProperty @ BPMN20.xsd
  "@_itemSubjectRef"?: string; // from type BPMN20__tProperty @ BPMN20.xsd
  dataState?: BPMN20__tDataState; // from type BPMN20__tProperty @ BPMN20.xsd
}

export interface BPMN20__tReceiveTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tReceiveTask @ BPMN20.xsd
  "@_instantiate"?: boolean; // from type BPMN20__tReceiveTask @ BPMN20.xsd
  "@_messageRef"?: string; // from type BPMN20__tReceiveTask @ BPMN20.xsd
  "@_operationRef"?: string; // from type BPMN20__tReceiveTask @ BPMN20.xsd
}

export interface BPMN20__tRelationship {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_type": string; // from type BPMN20__tRelationship @ BPMN20.xsd
  "@_direction"?: BPMN20__tRelationshipDirection; // from type BPMN20__tRelationship @ BPMN20.xsd
  source: { __$$text: string }[]; // from type BPMN20__tRelationship @ BPMN20.xsd
  target: { __$$text: string }[]; // from type BPMN20__tRelationship @ BPMN20.xsd
}

export interface BPMN20__tRendering {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tResource {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name": string; // from type BPMN20__tResource @ BPMN20.xsd
  resourceParameter?: BPMN20__tResourceParameter[]; // from type BPMN20__tResource @ BPMN20.xsd
}

export interface BPMN20__tResourceAssignmentExpression {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  expression:
    /* From subsitution groups */
    | ({ __$$element: "formalExpression" } & BPMN20__tFormalExpression)
    | ({ __$$element: "expression" } & BPMN20__tExpression); // from type BPMN20__tResourceAssignmentExpression @ BPMN20.xsd
}

export interface BPMN20__tResourceParameter {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tResourceParameter @ BPMN20.xsd
  "@_type"?: string; // from type BPMN20__tResourceParameter @ BPMN20.xsd
  "@_isRequired"?: boolean; // from type BPMN20__tResourceParameter @ BPMN20.xsd
}

export interface BPMN20__tResourceParameterBinding {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_parameterRef": string; // from type BPMN20__tResourceParameterBinding @ BPMN20.xsd
  expression:
    /* From subsitution groups */
    | ({ __$$element: "formalExpression" } & BPMN20__tFormalExpression)
    | ({ __$$element: "expression" } & BPMN20__tExpression); // from type BPMN20__tResourceParameterBinding @ BPMN20.xsd
}

export interface BPMN20__tResourceRole {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceAssignmentExpression?: BPMN20__tResourceAssignmentExpression; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceRef?: { __$$text: string }; // from type BPMN20__tResourceRole @ BPMN20.xsd
  resourceParameterBinding?: BPMN20__tResourceParameterBinding[]; // from type BPMN20__tResourceRole @ BPMN20.xsd
}

export interface BPMN20__tRootElement /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tScriptTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_scriptFormat"?: string; // from type BPMN20__tScriptTask @ BPMN20.xsd
  script?: BPMN20__tScript; // from type BPMN20__tScriptTask @ BPMN20.xsd
}

export interface BPMN20__tScript {
  __?: undefined;
  __$$text?: string; // from type BPMN20__tScript @ BPMN20.xsd
}

export interface BPMN20__tSendTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tSendTask @ BPMN20.xsd
  "@_messageRef"?: string; // from type BPMN20__tSendTask @ BPMN20.xsd
  "@_operationRef"?: string; // from type BPMN20__tSendTask @ BPMN20.xsd
}

export interface BPMN20__tSequenceFlow {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  "@_sourceRef": string; // from type BPMN20__tSequenceFlow @ BPMN20.xsd
  "@_targetRef": string; // from type BPMN20__tSequenceFlow @ BPMN20.xsd
  "@_isImmediate"?: boolean; // from type BPMN20__tSequenceFlow @ BPMN20.xsd
  conditionExpression?: BPMN20__tExpression; // from type BPMN20__tSequenceFlow @ BPMN20.xsd
}

export interface BPMN20__tServiceTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tServiceTask @ BPMN20.xsd
  "@_operationRef"?: string; // from type BPMN20__tServiceTask @ BPMN20.xsd
}

export interface BPMN20__tSignal {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tSignal @ BPMN20.xsd
  "@_structureRef"?: string; // from type BPMN20__tSignal @ BPMN20.xsd
}

export interface BPMN20__tSignalEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_signalRef"?: string; // from type BPMN20__tSignalEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tStandardLoopCharacteristics {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_testBefore"?: boolean; // from type BPMN20__tStandardLoopCharacteristics @ BPMN20.xsd
  "@_loopMaximum"?: number; // from type BPMN20__tStandardLoopCharacteristics @ BPMN20.xsd
  loopCondition?: BPMN20__tExpression; // from type BPMN20__tStandardLoopCharacteristics @ BPMN20.xsd
}

export interface BPMN20__tStartEvent {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  "@_parallelMultiple"?: boolean; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutput?: BPMN20__tDataOutput[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  outputSet?: BPMN20__tOutputSet; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tCatchEvent @ BPMN20.xsd
  "@_isInterrupting"?: boolean; // from type BPMN20__tStartEvent @ BPMN20.xsd
}

export interface BPMN20__tSubChoreography {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_initiatingParticipantRef": string; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  "@_loopType"?: BPMN20__tChoreographyLoopType; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  participantRef: { __$$text: string }[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tChoreographyActivity @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tSubChoreography @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tSubChoreography @ BPMN20.xsd
}

export interface BPMN20__tSubConversation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tConversationNode @ BPMN20.xsd
  participantRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  messageFlowRef?: { __$$text: string }[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  correlationKey?: BPMN20__tCorrelationKey[]; // from type BPMN20__tConversationNode @ BPMN20.xsd
  conversationNode?: (
    /* From subsitution groups */
    | ({ __$$element: "callConversation" } & BPMN20__tCallConversation)
    | ({ __$$element: "conversation" } & BPMN20__tConversation)
    | ({ __$$element: "subConversation" } & BPMN20__tSubConversation)
  )[]; // from type BPMN20__tSubConversation @ BPMN20.xsd
}

export interface BPMN20__tSubProcess {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_triggeredByEvent"?: boolean; // from type BPMN20__tSubProcess @ BPMN20.xsd
  laneSet?: BPMN20__tLaneSet[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
}

export interface BPMN20__tTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
}

export interface BPMN20__tTerminateEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
}

export interface BPMN20__tTextAnnotation {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_textFormat"?: string; // from type BPMN20__tTextAnnotation @ BPMN20.xsd
  text?: BPMN20__tText; // from type BPMN20__tTextAnnotation @ BPMN20.xsd
}

export interface BPMN20__tText {
  __?: undefined;
  __$$text?: string; // from type BPMN20__tText @ BPMN20.xsd
}

export interface BPMN20__tThrowEvent /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tEvent @ BPMN20.xsd
  dataInput?: BPMN20__tDataInput[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  inputSet?: BPMN20__tInputSet; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinition?: (
    /* From subsitution groups */
    | ({
        __$$element: "cancelEventDefinition";
      } & BPMN20__tCancelEventDefinition)
    | ({
        __$$element: "compensateEventDefinition";
      } & BPMN20__tCompensateEventDefinition)
    | ({
        __$$element: "conditionalEventDefinition";
      } & BPMN20__tConditionalEventDefinition)
    | ({ __$$element: "errorEventDefinition" } & BPMN20__tErrorEventDefinition)
    | ({
        __$$element: "escalationEventDefinition";
      } & BPMN20__tEscalationEventDefinition)
    | ({ __$$element: "linkEventDefinition" } & BPMN20__tLinkEventDefinition)
    | ({
        __$$element: "messageEventDefinition";
      } & BPMN20__tMessageEventDefinition)
    | ({
        __$$element: "signalEventDefinition";
      } & BPMN20__tSignalEventDefinition)
    | ({
        __$$element: "terminateEventDefinition";
      } & BPMN20__tTerminateEventDefinition)
    | ({ __$$element: "timerEventDefinition" } & BPMN20__tTimerEventDefinition)
  )[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
  eventDefinitionRef?: { __$$text: string }[]; // from type BPMN20__tThrowEvent @ BPMN20.xsd
}

export interface BPMN20__tTimerEventDefinition {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  timeDate?: BPMN20__tExpression; // from type BPMN20__tTimerEventDefinition @ BPMN20.xsd
  timeDuration?: BPMN20__tExpression; // from type BPMN20__tTimerEventDefinition @ BPMN20.xsd
  timeCycle?: BPMN20__tExpression; // from type BPMN20__tTimerEventDefinition @ BPMN20.xsd
}

export interface BPMN20__tTransaction {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_triggeredByEvent"?: boolean; // from type BPMN20__tSubProcess @ BPMN20.xsd
  laneSet?: BPMN20__tLaneSet[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  flowElement?: (
    /* From subsitution groups */
    | ({ __$$element: "adHocSubProcess" } & BPMN20__tAdHocSubProcess)
    | ({ __$$element: "boundaryEvent" } & BPMN20__tBoundaryEvent)
    | ({ __$$element: "businessRuleTask" } & BPMN20__tBusinessRuleTask)
    | ({ __$$element: "callActivity" } & BPMN20__tCallActivity)
    | ({ __$$element: "callChoreography" } & BPMN20__tCallChoreography)
    | ({ __$$element: "choreographyTask" } & BPMN20__tChoreographyTask)
    | ({ __$$element: "complexGateway" } & BPMN20__tComplexGateway)
    | ({ __$$element: "dataObject" } & BPMN20__tDataObject)
    | ({ __$$element: "dataObjectReference" } & BPMN20__tDataObjectReference)
    | ({ __$$element: "dataStoreReference" } & BPMN20__tDataStoreReference)
    | ({ __$$element: "endEvent" } & BPMN20__tEndEvent)
    | ({ __$$element: "event" } & BPMN20__tEvent)
    | ({ __$$element: "eventBasedGateway" } & BPMN20__tEventBasedGateway)
    | ({ __$$element: "exclusiveGateway" } & BPMN20__tExclusiveGateway)
    | ({ __$$element: "implicitThrowEvent" } & BPMN20__tImplicitThrowEvent)
    | ({ __$$element: "inclusiveGateway" } & BPMN20__tInclusiveGateway)
    | ({
        __$$element: "intermediateCatchEvent";
      } & BPMN20__tIntermediateCatchEvent)
    | ({
        __$$element: "intermediateThrowEvent";
      } & BPMN20__tIntermediateThrowEvent)
    | ({ __$$element: "manualTask" } & BPMN20__tManualTask)
    | ({ __$$element: "parallelGateway" } & BPMN20__tParallelGateway)
    | ({ __$$element: "receiveTask" } & BPMN20__tReceiveTask)
    | ({ __$$element: "scriptTask" } & BPMN20__tScriptTask)
    | ({ __$$element: "sendTask" } & BPMN20__tSendTask)
    | ({ __$$element: "sequenceFlow" } & BPMN20__tSequenceFlow)
    | ({ __$$element: "serviceTask" } & BPMN20__tServiceTask)
    | ({ __$$element: "startEvent" } & BPMN20__tStartEvent)
    | ({ __$$element: "subChoreography" } & BPMN20__tSubChoreography)
    | ({ __$$element: "subProcess" } & BPMN20__tSubProcess)
    | ({ __$$element: "task" } & BPMN20__tTask)
    | ({ __$$element: "transaction" } & BPMN20__tTransaction)
    | ({ __$$element: "userTask" } & BPMN20__tUserTask)
  )[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  artifact?: (
    /* From subsitution groups */
    | ({ __$$element: "association" } & BPMN20__tAssociation)
    | ({ __$$element: "group" } & BPMN20__tGroup)
    | ({ __$$element: "textAnnotation" } & BPMN20__tTextAnnotation)
  )[]; // from type BPMN20__tSubProcess @ BPMN20.xsd
  "@_method"?: BPMN20__tTransactionMethod; // from type BPMN20__tTransaction @ BPMN20.xsd
}

export interface BPMN20__tUserTask {
  __?: undefined;
  "@_id"?: string; // from type BPMN20__tBaseElement @ BPMN20.xsd
  documentation?: BPMN20__tDocumentation[]; // from type BPMN20__tBaseElement @ BPMN20.xsd
  extensionElements?: BPMN20__tExtensionElements; // from type BPMN20__tBaseElement @ BPMN20.xsd
  "@_name"?: string; // from type BPMN20__tFlowElement @ BPMN20.xsd
  auditing?: BPMN20__tAuditing; // from type BPMN20__tFlowElement @ BPMN20.xsd
  monitoring?: BPMN20__tMonitoring; // from type BPMN20__tFlowElement @ BPMN20.xsd
  categoryValueRef?: { __$$text: string }[]; // from type BPMN20__tFlowElement @ BPMN20.xsd
  incoming?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  outgoing?: { __$$text: string }[]; // from type BPMN20__tFlowNode @ BPMN20.xsd
  "@_isForCompensation"?: boolean; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_startQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_completionQuantity"?: number; // from type BPMN20__tActivity @ BPMN20.xsd
  "@_default"?: string; // from type BPMN20__tActivity @ BPMN20.xsd
  ioSpecification?: BPMN20__tInputOutputSpecification; // from type BPMN20__tActivity @ BPMN20.xsd
  property?: BPMN20__tProperty[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataInputAssociation?: BPMN20__tDataInputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  dataOutputAssociation?: BPMN20__tDataOutputAssociation[]; // from type BPMN20__tActivity @ BPMN20.xsd
  resourceRole?: (
    /* From subsitution groups */
    | ({ __$$element: "performer" } & BPMN20__tPerformer)
    | ({ __$$element: "humanPerformer" } & BPMN20__tHumanPerformer)
    | ({ __$$element: "potentialOwner" } & BPMN20__tPotentialOwner)
    | ({ __$$element: "resourceRole" } & BPMN20__tResourceRole)
  )[]; // from type BPMN20__tActivity @ BPMN20.xsd
  loopCharacteristics?:
    /* From subsitution groups */
    | ({
        __$$element: "multiInstanceLoopCharacteristics";
      } & BPMN20__tMultiInstanceLoopCharacteristics)
    | ({
        __$$element: "standardLoopCharacteristics";
      } & BPMN20__tStandardLoopCharacteristics); // from type BPMN20__tActivity @ BPMN20.xsd
  "@_implementation"?: BPMN20__tImplementation; // from type BPMN20__tUserTask @ BPMN20.xsd
  rendering?: BPMN20__tRendering[]; // from type BPMN20__tUserTask @ BPMN20.xsd
}

export type BPMNDI__BPMNDiagram = {
  "@_name"?: string; // from type DI__Diagram @ DI.xsd
  "@_documentation"?: string; // from type DI__Diagram @ DI.xsd
  "@_resolution"?: number; // from type DI__Diagram @ DI.xsd
  "@_id"?: string; // from type DI__Diagram @ DI.xsd
  "bpmndi:BPMNPlane": BPMNDI__BPMNPlane; // from type BPMNDI__BPMNDiagram @ BPMNDI.xsd
  "bpmndi:BPMNLabelStyle"?: BPMNDI__BPMNLabelStyle[]; // from type BPMNDI__BPMNDiagram @ BPMNDI.xsd
};

export interface BPMNDI__BPMNPlane {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: BPMNDI__BPMNPlane__extension; // from type DI__DiagramElement @ DI.xsd
  "di:DiagramElement"?: (
    /* From subsitution groups */
    | ({ __$$element: "bpmndi:BPMNShape" } & BPMNDI__BPMNShape)
    | ({ __$$element: "bpmndi:BPMNEdge" } & BPMNDI__BPMNEdge)
  )[]; // from type DI__Plane @ DI.xsd
  "@_bpmnElement"?: string; // from type BPMNDI__BPMNPlane @ BPMNDI.xsd
}

export interface BPMNDI__BPMNPlane__extension {
  __?: undefined;
}

export interface BPMNDI__BPMNEdge {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: BPMNDI__BPMNEdge__extension; // from type DI__DiagramElement @ DI.xsd
  "di:waypoint": DC__Point[]; // from type DI__Edge @ DI.xsd
  "@_bpmnElement"?: string; // from type BPMNDI__BPMNEdge @ BPMNDI.xsd
  "@_sourceElement"?: string; // from type BPMNDI__BPMNEdge @ BPMNDI.xsd
  "@_targetElement"?: string; // from type BPMNDI__BPMNEdge @ BPMNDI.xsd
  "@_messageVisibleKind"?: BPMNDI__MessageVisibleKind; // from type BPMNDI__BPMNEdge @ BPMNDI.xsd
  "bpmndi:BPMNLabel"?: BPMNDI__BPMNLabel; // from type BPMNDI__BPMNEdge @ BPMNDI.xsd
}

export interface BPMNDI__BPMNEdge__extension {
  __?: undefined;
}

export interface BPMNDI__BPMNShape {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: BPMNDI__BPMNShape__extension; // from type DI__DiagramElement @ DI.xsd
  "dc:Bounds": DC__Bounds; // from type DI__Shape @ DC.xsd
  "@_bpmnElement"?: string; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "@_isHorizontal"?: boolean; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "@_isExpanded"?: boolean; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "@_isMarkerVisible"?: boolean; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "@_isMessageVisible"?: boolean; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "@_participantBandKind"?: BPMNDI__ParticipantBandKind; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "@_choreographyActivityShape"?: string; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
  "bpmndi:BPMNLabel"?: BPMNDI__BPMNLabel; // from type BPMNDI__BPMNShape @ BPMNDI.xsd
}

export interface BPMNDI__BPMNShape__extension {
  __?: undefined;
}

export interface BPMNDI__BPMNLabel {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: BPMNDI__BPMNLabel__extension; // from type DI__DiagramElement @ DI.xsd
  "dc:Bounds"?: DC__Bounds; // from type DI__Label @ DC.xsd
  "@_labelStyle"?: string; // from type BPMNDI__BPMNLabel @ BPMNDI.xsd
}

export interface BPMNDI__BPMNLabel__extension {
  __?: undefined;
}

export type BPMNDI__BPMNLabelStyle = {
  "@_id"?: string; // from type DI__Style @ DI.xsd
  "dc:Font": DC__Font; // from type BPMNDI__BPMNLabelStyle @ DC.xsd
};

export type DC__Font = {
  "@_name"?: string; // from type DC__Font @ DC.xsd
  "@_size"?: number; // from type DC__Font @ DC.xsd
  "@_isBold"?: boolean; // from type DC__Font @ DC.xsd
  "@_isItalic"?: boolean; // from type DC__Font @ DC.xsd
  "@_isUnderline"?: boolean; // from type DC__Font @ DC.xsd
  "@_isStrikeThrough"?: boolean; // from type DC__Font @ DC.xsd
};

export type DC__Point = {
  "@_x": number; // from type DC__Point @ DC.xsd
  "@_y": number; // from type DC__Point @ DC.xsd
};

export type DC__Bounds = {
  "@_x": number; // from type DC__Bounds @ DC.xsd
  "@_y": number; // from type DC__Bounds @ DC.xsd
  "@_width": number; // from type DC__Bounds @ DC.xsd
  "@_height": number; // from type DC__Bounds @ DC.xsd
};

export interface DI__DiagramElement /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__DiagramElement__extension; // from type DI__DiagramElement @ DI.xsd
}

export interface DI__DiagramElement__extension {
  __?: undefined;
}

export type DI__Diagram = /* abstract */ {
  "@_name"?: string; // from type DI__Diagram @ DI.xsd
  "@_documentation"?: string; // from type DI__Diagram @ DI.xsd
  "@_resolution"?: number; // from type DI__Diagram @ DI.xsd
  "@_id"?: string; // from type DI__Diagram @ DI.xsd
};

export interface DI__Node /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__Node__extension; // from type DI__DiagramElement @ DI.xsd
}

export interface DI__Node__extension {
  __?: undefined;
}

export interface DI__Edge /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__Edge__extension; // from type DI__DiagramElement @ DI.xsd
  "di:waypoint": DC__Point[]; // from type DI__Edge @ DI.xsd
}

export interface DI__Edge__extension {
  __?: undefined;
}

export interface DI__LabeledEdge /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__LabeledEdge__extension; // from type DI__DiagramElement @ DI.xsd
  "di:waypoint": DC__Point[]; // from type DI__Edge @ DI.xsd
}

export interface DI__LabeledEdge__extension {
  __?: undefined;
}

export interface DI__Shape /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__Shape__extension; // from type DI__DiagramElement @ DI.xsd
  "dc:Bounds": DC__Bounds; // from type DI__Shape @ DC.xsd
}

export interface DI__Shape__extension {
  __?: undefined;
}

export interface DI__LabeledShape /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__LabeledShape__extension; // from type DI__DiagramElement @ DI.xsd
  "dc:Bounds": DC__Bounds; // from type DI__Shape @ DC.xsd
}

export interface DI__LabeledShape__extension {
  __?: undefined;
}

export interface DI__Label /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__Label__extension; // from type DI__DiagramElement @ DI.xsd
  "dc:Bounds"?: DC__Bounds; // from type DI__Label @ DC.xsd
}

export interface DI__Label__extension {
  __?: undefined;
}

export interface DI__Plane /* abstract */ {
  __?: undefined;
  "@_id"?: string; // from type DI__DiagramElement @ DI.xsd
  "di:extension"?: DI__Plane__extension; // from type DI__DiagramElement @ DI.xsd
  "di:DiagramElement"?: DI__DiagramElement[]; // from type DI__Plane @ DI.xsd
}

export interface DI__Plane__extension {
  __?: undefined;
}

export type DI__Style = /* abstract */ {
  "@_id"?: string; // from type DI__Style @ DI.xsd
};
