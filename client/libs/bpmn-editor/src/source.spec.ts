// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import { getMarshaller, type BpmnLatestModel } from "./source";
import {
  createBlankBpmnSource,
  inspectBpmnSource,
  inspectBpmnBytes,
} from "./source";
import { BPMN_XML_BUDGET } from "./xml-parser/preflight";
import { normalize } from "./editor/normalization/normalize";
import { resolveBpmnProcessOwner } from "./process-source";
import {
  indexBpmnIds,
  changeBpmnTargetNamespace,
  changeBpmnDefinitionsId,
} from "./editor/idRandomizer/bpmn-id-randomizer";
import { deleteItemDefinition } from "./editor/mutations/deleteItemDefinition";
import { addOrGetSignals } from "./editor/mutations/addOrGetSignals";
import { addOrGetErrors } from "./editor/mutations/addOrGetErrors";
import { addOrGetEscalations } from "./editor/mutations/addOrGetEscalations";
import { parseXmlQName } from "./xml-parser/q-names";
import { renameSignal } from "./editor/mutations/renameSignal";
import { renameEscalation } from "./editor/mutations/renameEscalation";
import { renameMessage } from "./editor/mutations/renameMessage";
import { renameError } from "./editor/mutations/renameError";
import {
  addOrGetItemDefinitions,
  defaultDataType,
} from "./editor/mutations/addOrGetItemDefinitions";
import { renameItemDefinition } from "./editor/mutations/renameItemDefinition";
import { addOrGetMessages } from "./editor/mutations/addOrGetMessages";
import { addOrGetOperations } from "./editor/mutations/addOrGetOperations";
import {
  getDataMapping,
  setDataMappingForElement,
} from "./editor/mutations/data-mapping";

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/${name}.bpmn`, import.meta.url), "utf8");
const processOf = (model: BpmnLatestModel) => {
  const process = model.definitions.rootElement?.find(
    (element) => element.__$$element === "process",
  );
  if (!process || process.__$$element !== "process")
    throw new Error("Missing process");
  return process;
};

describe("retained BPMN source marshaller", () => {
  it("admits graphical artifacts with scoped references and rejects cross-scope or wrong-kind targets", async () => {
    const objects = await fixture("data-objects-standard");
    const mappings = await fixture("data-associations-standard");
    const interfaceXml = await fixture("process-io-standard");
    expect(inspectBpmnSource(interfaceXml).status).toBe("accepted");
    expect(
      inspectBpmnSource(
        interfaceXml.replace(
          "<sourceRef>Input</sourceRef>",
          "<sourceRef>Output</sourceRef>",
        ),
      ).status,
    ).not.toBe("accepted");
    expect(
      inspectBpmnSource(
        interfaceXml.replace(
          "<targetRef>Output</targetRef>",
          "<targetRef>Input</targetRef>",
        ),
      ).status,
    ).not.toBe("accepted");
    expect(
      inspectBpmnSource(
        interfaceXml.replace(
          'id="InputDI" bpmnElement="Input"',
          'id="InputDI" bpmnElement="In"',
        ),
      ).status,
    ).not.toBe("accepted");
    expect(
      inspectBpmnSource(
        interfaceXml.replace(
          'id="Input" name="Request" itemSubjectRef="tns:Item" isCollection="true"',
          'id="Input" name="Request" itemSubjectRef="tns:Item" isCollection="false"',
        ),
      ).status,
    ).not.toBe("accepted");
    expect(inspectBpmnSource(mappings).status).toBe("accepted");
    const fanRoute =
      '<bpmndi:BPMNEdge id="FanInDI" bpmnElement="Read" sourceElement="OtherDataDI" targetElement="ReviewDI"><di:waypoint x="220" y="440"/><di:waypoint x="450" y="160"/></bpmndi:BPMNEdge>';
    const fanIn = mappings
      .replace(
        "<sourceRef>Data</sourceRef>",
        "<sourceRef>Data</sourceRef><sourceRef>OtherData</sourceRef>",
      )
      .replace("</bpmndi:BPMNPlane>", `${fanRoute}</bpmndi:BPMNPlane>`);
    expect(inspectBpmnSource(fanIn).status).toBe("accepted");
    const assignmentsOnly = fanIn.replace(
        /<transformation[^>]*>.*?<\/transformation>/,
        "",
      ),
      copyOnly = assignmentsOnly.replace(
        /<assignment id="Assign">.*?<\/assignment>/,
        "",
      );
    expect(inspectBpmnSource(assignmentsOnly).status).toBe("accepted");
    expect(inspectBpmnSource(copyOnly).status).not.toBe("accepted");
    for (const broken of [
      fanIn.replace('sourceElement="OtherDataDI"', 'sourceElement="DataDI"'),
      fanIn.replace('sourceElement="OtherDataDI" ', ""),
      fanIn.replace(fanRoute, ""),
    ])
      expect(inspectBpmnSource(broken).status).not.toBe("accepted");
    expect(
      inspectBpmnSource(
        mappings.replace(
          '<outputSet id="StartOutputs">',
          '<outputSet id="StartOutputs"><optionalOutputRefs>Out</optionalOutputRefs>',
        ),
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Start" },
    });
    for (const changed of [
      mappings.replace(
        '<inputSet id="Inputs">',
        '<inputSet id="Inputs"><optionalInputRefs>Out</optionalInputRefs>',
      ),
      mappings.replace("<dataInputRefs>In</dataInputRefs>", ""),
      mappings.replace(
        '<outputSet id="Outputs">',
        '<outputSet id="Outputs"><inputSetRefs>NestedInputs</inputSetRefs>',
      ),
    ])
      expect(inspectBpmnSource(changed)).toMatchObject({
        status: "unsupported",
        error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "IO" },
      });
    expect(
      inspectBpmnSource(
        mappings.replace(
          "<targetRef>In</targetRef>",
          "<targetRef>Review</targetRef>",
        ),
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Read" },
    });
    const stores = await fixture("data-stores-standard");
    expect(inspectBpmnSource(stores).status).toBe("accepted");
    expect(
      inspectBpmnSource(
        stores.replace(
          'dataStoreRef="shared:Store"',
          'dataStoreRef="shared:Item"',
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "First" },
    });
    expect(
      inspectBpmnSource(stores.replace('capacity="200"', 'capacity="-1"')),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Store" },
    });
    const references = await fixture("data-references-standard");
    expect(inspectBpmnSource(references).status).toBe("accepted");
    for (const target of ["tns:Backing", "Review", "NestedBacking"])
      expect(
        inspectBpmnSource(
          references.replace(
            'dataObjectRef="Backing"',
            `dataObjectRef="${target}"`,
          ),
        ),
      ).toMatchObject({
        status: "invalid",
        error: { code: "BPMN_DANGLING_REFERENCE", elementId: "First" },
      });
    expect(
      inspectBpmnSource(references.replace(/ dataObjectRef="Backing"/g, "")),
    ).toMatchObject({
      status: "incomplete-di",
      error: { code: "BPMN_INCOMPLETE_DI" },
    });
    expect(inspectBpmnSource(objects).status).toBe("accepted");
    expect(
      inspectBpmnSource(
        objects.replace(
          'itemSubjectRef="tns:CollectionItem"',
          'itemSubjectRef="tns:Review"',
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Orders" },
    });
    expect(
      inspectBpmnSource(
        objects.replace(
          'itemSubjectRef="tns:CollectionItem"',
          'itemSubjectRef="tns:Item"',
        ),
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Orders" },
    });
    expect(
      inspectBpmnSource(
        objects.replace(
          "<flowNodeRef>Review</flowNodeRef>",
          "<flowNodeRef>Orders</flowNodeRef>",
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Lane" },
    });
    const groups = (await fixture("groups-standard")).replace(
      '<task id="A" name="Review A"/>',
      '<task id="A" name="Review A"><categoryValueRef>tns:SharedValue</categoryValueRef></task>',
    );
    expect(inspectBpmnSource(groups).status).toBe("accepted");
    expect(
      inspectBpmnSource(
        groups.replace(
          "<categoryValueRef>tns:SharedValue</categoryValueRef>",
          "<categoryValueRef>tns:Category</categoryValueRef>",
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "A" },
    });
    expect(
      inspectBpmnSource(
        groups.replace(
          'categoryValueRef="tns:SharedValue"',
          'categoryValueRef="tns:Category"',
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "First" },
    });
    const source = await fixture("associations-standard"),
      result = inspectBpmnSource(source);
    expect(result.status).toBe("accepted");
    for (const target of ["tns:Missing", "tns:Child"]) {
      expect(
        inspectBpmnSource(
          source.replace(
            'id="Undirected" sourceRef="tns:A" targetRef="tns:Note1"',
            `id="Undirected" sourceRef="tns:A" targetRef="${target}"`,
          ),
        ),
      ).toMatchObject({
        status: "invalid",
        error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Undirected" },
      });
    }
    if (result.status !== "accepted") throw new Error(result.error.code);
    const output = getMarshaller(source).builder.build(result.model);
    expect(getMarshaller(output).parser.parse()).toEqual(result.model);
    expect(output).toContain('sourceRef="tns:A"');
  });
  it("admits all gateway kinds and rejects direction, default and event-target configuration loss", async () => {
    const source = await fixture("gateways-standard");
    expect(inspectBpmnSource(source).status).toBe("accepted");
    for (const candidate of [
      source.replace(
        'gatewayDirection="Mixed" default="tns:ChooseD"',
        'gatewayDirection="Unknown" default="tns:ChooseD"',
      ),
      source.replace(
        'gatewayDirection="Mixed" default="tns:ChooseD"',
        'gatewayDirection="Converging" default="tns:ChooseD"',
      ),
      source.replace('default="tns:ChooseD"', 'default="tns:ChooseF"'),
      source.replace(
        'id="Event" name="Wait for an event"',
        'id="Event" name="Wait for an event" eventGatewayType="Parallel"',
      ),
      source.replace(
        'sourceRef="Event" targetRef="Timer"',
        'sourceRef="Event" targetRef="H"',
      ),
      source.replace(
        '<sequenceFlow id="WaitTimer" sourceRef="Event" targetRef="Timer"/>',
        '<sequenceFlow id="WaitTimer" sourceRef="Event" targetRef="Timer"><conditionExpression>invalid</conditionExpression></sequenceFlow>',
      ),
    ])
      expect(inspectBpmnSource(candidate)).toMatchObject({
        status: "unsupported",
        error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Process" },
      });
  });
  it("admits source-owned conditions/defaults and rejects a default belonging to another source", async () => {
    const source = await fixture("flows-standard"),
      result = inspectBpmnSource(source);
    expect(result.status).toBe("accepted");
    expect(
      inspectBpmnSource(
        source.replace('default="tns:Default"', 'default="tns:Forward"'),
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Process" },
    });
    if (result.status !== "accepted") throw new Error(result.error.code);
    const output = getMarshaller(source).builder.build(result.model);
    expect(getMarshaller(output).parser.parse()).toEqual(result.model);
    expect(output).toContain('language="urn:myoxus:expression"');
  });
  it("admits actual event notation and rejects invalid trigger, attachment and link contexts before opening", async () => {
    const source = await fixture("events-standard");
    expect(inspectBpmnSource(source).status).toBe("accepted");
    const eventScope = await fixture("event-subprocess-standard");
    expect(inspectBpmnSource(eventScope).status).toBe("accepted");
    for (const candidate of [
      eventScope.replace(
        '<messageEventDefinition id="MessageDefinition" messageRef="tns:Message"/>',
        "",
      ),
      eventScope.replace(
        '<documentation id="ScopeDoc">',
        '<standardLoopCharacteristics/><documentation id="ScopeDoc">',
      ),
      eventScope.replace(
        '<startEvent id="Trigger"',
        '<startEvent id="SecondTrigger"><signalEventDefinition/></startEvent><startEvent id="Trigger"',
      ),
      eventScope.replace(
        "</process>",
        '<sequenceFlow id="Forbidden" sourceRef="Host" targetRef="EventScope"/></process>',
      ),
    ])
      expect(inspectBpmnSource(candidate)).toMatchObject({
        status: "unsupported",
        error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "EventScope" },
      });
    for (const [candidate, id] of [
      [
        source.replace(
          '<messageEventDefinition id="StartMessage" messageRef="tns:Request"/>',
          '<errorEventDefinition id="StartMessage" errorRef="tns:Failure"/>',
        ),
        "Start",
      ],
      [
        source.replace(
          'attachedToRef="tns:Host"',
          'attachedToRef="tns:NestedTask"',
        ),
        "Boundary",
      ],
      [
        source.replace(
          "<eventDefinitionRef>tns:SharedTimer</eventDefinitionRef>",
          '<errorEventDefinition id="NoninterruptingError" errorRef="tns:Failure"/>',
        ),
        "Boundary",
      ],
      [source.replace('name="Continue"', 'name="Different"'), "LinkCatch"],
      [
        source.replace(
          "<source>tns:ThrowLinkDefinition</source>",
          "<source>tns:CatchLinkDefinition</source>",
        ),
        "LinkCatch",
      ],
    ])
      expect(inspectBpmnSource(candidate)).toMatchObject({
        status: "unsupported",
        error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: id },
      });
  });
  it("rejects ad-hoc start/end events before opening a complete nested diagram", async () => {
    const ordinary = (await fixture("subprocesses-standard"))
      .replace(/\s*<boundaryEvent[\s\S]*?<\/boundaryEvent>/, "")
      .replace(
        /\s*<bpmndi:BPMNShape id="TimeoutDI"[\s\S]*?<\/bpmndi:BPMNShape>/,
        "",
      )
      .replace("<flowNodeRef>Timeout</flowNodeRef>", "");
    expect(inspectBpmnSource(ordinary).status).toBe("accepted");
    const invalid = ordinary
      .replace('<subProcess id="Inner"', '<adHocSubProcess id="Inner"')
      .replace("</subProcess>", "</adHocSubProcess>");
    expect(inspectBpmnSource(invalid)).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Inner" },
    });
  });
  it("admits complete nested lane DI and preserves ancestor memberships while rejecting ambiguous branches", async () => {
    const source = await fixture("lanes-standard");
    const result = inspectBpmnSource(source);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error(result.error.code);
    const written = getMarshaller(source).builder.build(result.model);
    expect(getMarshaller(written).parser.parse()).toEqual(result.model);
    const siblingConflict = source.replace(
      '<b:lane id="Other" name="External review"><b:flowNodeRef>TaskC',
      '<b:lane id="Other" name="External review"><b:flowNodeRef>TaskA',
    );
    expect(inspectBpmnSource(siblingConflict)).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Other" },
    });
    const missingShape = source.replace(
      /<bpmndi:BPMNShape id="DeepDI"[\s\S]*?<\/bpmndi:BPMNShape>/,
      "",
    );
    expect(inspectBpmnSource(missingShape)).toMatchObject({
      status: "incomplete-di",
      error: { code: "BPMN_INCOMPLETE_DI" },
    });
  });
  it("keeps standard global context and absent schema defaults through focused process edits", async () => {
    const source = await fixture("globals-standard");
    expect(
      inspectBpmnSource(
        source.replace(
          "<resourceRef>tns:Reviewer</resourceRef>",
          "<resourceRef>tns:Task</resourceRef>",
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Owner" },
    });
    expect(
      inspectBpmnSource(
        source.replace(
          'parameterRef="tns:Parameter"',
          'parameterRef="tns:Payload"',
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Binding" },
    });
    expect(
      inspectBpmnSource(
        source.replace(
          'name="subject" type="tns:Payload"',
          'name="subject" type="tns:Reviewer"',
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "Parameter" },
    });
    const inspection = inspectBpmnSource(source);
    expect(inspection.status).toBe("accepted");
    if (inspection.status !== "accepted")
      throw new Error(inspection.error.code);
    const model = normalize(inspection.model);
    const expected = structuredClone(model);
    processOf(model)["@_name"] = "Focused global edit";
    processOf(expected)["@_name"] = "Focused global edit";
    const written = getMarshaller(source).builder.build(model);
    expect(getMarshaller(written).parser.parse()).toEqual(expected);
    expect(inspectBpmnSource(written).status).toBe("accepted");
    expect(processOf(model)).not.toHaveProperty("@_isExecutable");
    expect(processOf(model)).not.toHaveProperty("@_isClosed");
    expect(processOf(model)).not.toHaveProperty("@_processType");
    expect(model.definitions).not.toHaveProperty("@_expressionLanguage");
    expect(model.definitions).not.toHaveProperty("@_typeLanguage");
  });
  it("retargets owned references and global IDs without rebinding external types, imports or DI", async () => {
    const source = await fixture("definitions-references");
    const model = getMarshaller(source).parser.parse();
    const before = structuredClone(model);
    expect(() =>
      changeBpmnTargetNamespace(model.definitions, "urn:bad namespace"),
    ).toThrow("BPMN_UNKNOWN_NAMESPACE");
    expect(() => changeBpmnDefinitionsId(model.definitions, "Task")).toThrow(
      "BPMN_INVALID_ID_RENAME",
    );
    expect(model).toEqual(before);
    changeBpmnDefinitionsId(model.definitions, "RenamedDefinitions");
    indexBpmnIds(model.definitions).rename("Process", "RenamedProcess");
    changeBpmnTargetNamespace(model.definitions, "urn:myoxus:retargeted");
    const binding = 'xmlns:tns1="urn:myoxus:retargeted" ';
    let expected = source
      .replace('id="Definitions"', 'id="RenamedDefinitions"')
      .replace('id="Process"', 'id="RenamedProcess"')
      .replace('bpmnElement="Process"', 'bpmnElement="RenamedProcess"')
      .replace(
        'targetNamespace="urn:myoxus:definitions"',
        'targetNamespace="urn:myoxus:retargeted"',
      )
      .replace(
        'name="Notice" structureRef="tns:Payload"',
        `name="Notice" ${binding}structureRef="tns1:Payload"`,
      )
      .replace(
        'errorCode="E1" structureRef="tns:Payload"',
        `errorCode="E1" ${binding}structureRef="tns1:Payload"`,
      )
      .replace(
        'escalationCode="E2" structureRef="tns:Payload"',
        `escalationCode="E2" ${binding}structureRef="tns1:Payload"`,
      )
      .replace(
        'id="Input" itemSubjectRef="tns:Payload"',
        `id="Input" ${binding}itemSubjectRef="tns1:Payload"`,
      )
      .replace(
        "<inMessageRef>tns:Message</inMessageRef>",
        `<inMessageRef ${binding.trim()}>tns1:Message</inMessageRef>`,
      );
    for (const [property, target] of [
      ["itemRef", "Payload"],
      ["messageRef", "Message"],
      ["signalRef", "Signal"],
      ["errorRef", "Error"],
      ["escalationRef", "Escalation"],
      ["operationRef", "Operation"],
      ["calledElement", "Global"],
      ["categoryValueRef", "CategoryValue"],
    ])
      expected = expected.replace(
        `${property}="tns:${target}"`,
        `${binding}${property}="tns1:${target}"`,
      );
    const written = getMarshaller(source).builder.build(model);
    expect(getMarshaller(written).parser.parse()).toEqual(
      getMarshaller(expected).parser.parse(),
    );
    expect(written).toContain('id="Payload" structureRef="tns:Payload"');
    expect(written).toContain('implementationRef="tns:Message"');
    expect(written).toContain('xmlns:tns="urn:myoxus:definitions"');
    changeBpmnDefinitionsId(model.definitions, undefined);
    expect(model.definitions).not.toHaveProperty("@_id");
    const modelDefault = getMarshaller(createBlankBpmnSource()).parser.parse();
    modelDefault.definitions["@_targetNamespace"] =
      "http://www.omg.org/spec/BPMN/20100524/MODEL";
    const untouchedDI = structuredClone(
      modelDefault.definitions["bpmndi:BPMNDiagram"],
    );
    changeBpmnTargetNamespace(
      modelDefault.definitions,
      "urn:myoxus:retargeted",
    );
    expect(modelDefault.definitions["bpmndi:BPMNDiagram"]).toEqual(untouchedDI);
  });
  it("keeps imported external mapping types unchanged until explicit selection and creates scoped operation inputs", async () => {
    const source = await fixture("definitions-references");
    const model = normalize(getMarshaller(source).parser.parse());
    const process = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const shadow = process.flowElement!.find(
      (element) => element["@_id"] === "Shadow",
    );
    if (shadow?.__$$element !== "task") throw new Error("Missing task");
    const input = shadow.ioSpecification!.dataInput![0];
    Object.assign(input, {
      "@_itemSubjectRef": "String",
      "@_xmlns": "urn:outside",
      "@_xmlns:b": "http://www.omg.org/spec/BPMN/20100524/MODEL",
    });
    addOrGetItemDefinitions({
      definitions: model.definitions,
      dataType: "String",
    });
    const rows = getDataMapping(shadow);
    rows.inputDataMapping[0].name = "Only name";
    const expected = structuredClone(model);
    const expectedShadow = processOf(expected).flowElement!.find(
      (element) => element["@_id"] === "Shadow",
    );
    if (expectedShadow?.__$$element !== "task") throw new Error("Missing task");
    expectedShadow.ioSpecification!.dataInput![0]["@_name"] = "Only name";
    setDataMappingForElement({
      definitions: model.definitions,
      elementId: "Shadow",
      element: "task",
      ...rows,
    });
    expect(model).toEqual(expected);
    rows.inputDataMapping[0].typeIsSelection = true;
    rows.inputDataMapping[0].dtype = "Payload";
    setDataMappingForElement({
      definitions: model.definitions,
      elementId: "Shadow",
      element: "task",
      ...rows,
    });
    expect(input["@_itemSubjectRef"]).toBe("tns1:Payload");
    expect(
      indexBpmnIds(model.definitions).resolveReference(
        input,
        input["@_itemSubjectRef"],
      ),
    ).toBe("Payload");
    const message = addOrGetMessages({
      definitions: model.definitions,
      messageName: "Message",
    });
    expect(message.messageRef).not.toBe("Message");
    expect(
      addOrGetMessages({
        definitions: model.definitions,
        messageName: "Request",
      }).messageRef,
    ).toBe("Message");
    const owner = model.definitions.rootElement!.find(
      (root) => root.__$$element === "interface",
    );
    if (owner?.__$$element !== "interface")
      throw new Error("Missing interface");
    Object.assign(owner, {
      "@_xmlns": "urn:outside",
      "@_xmlns:tns": "urn:outside",
      "@_xmlns:b": "http://www.omg.org/spec/BPMN/20100524/MODEL",
    });
    const operation = addOrGetOperations({
      definitions: model.definitions,
      interfaceId: "Interface",
      operationName: "New operation",
    }).operation;
    expect(operation).not.toHaveProperty("outMessageRef");
    expect(
      indexBpmnIds(model.definitions).resolveReference(
        operation.inMessageRef,
        operation.inMessageRef.__$$text,
      ),
    ).toBeDefined();
    const written = getMarshaller(source).builder.build(model);
    expect(written).not.toContain("typeIsSelection");
    expect(getMarshaller(written).parser.parse()).toEqual(model);
  });
  it("creates actual XML Schema builtin types without aliasing imported type names or changing root bindings", async () => {
    const source = (await fixture("definitions-references"))
      .replace('id="Definitions"', 'xmlns:xsd="urn:outside" id="Definitions"')
      .replace(
        '<message id="Message"',
        '<itemDefinition id="String" structureRef="String"/><itemDefinition id="Physical" itemKind="Physical" xmlns:schema="http://www.w3.org/2001/XMLSchema" structureRef="schema:string"/><itemDefinition id="Collection" isCollection="true" xmlns:schema="http://www.w3.org/2001/XMLSchema" structureRef="schema:string"/><itemDefinition id="ExistingBuiltin" xmlns:schema="http://www.w3.org/2001/XMLSchema" structureRef="schema:string"/><itemDefinition structureRef="tns:First"/><itemDefinition structureRef="tns:Second"/><message id="Message"',
      );
    const model = normalize(getMarshaller(source).parser.parse());
    const before = structuredClone(model);
    const string = addOrGetItemDefinitions({
      definitions: model.definitions,
      dataType: "String",
    }).itemDefinition;
    expect(string["@_id"]).toBe("ExistingBuiltin");
    expect(model).toEqual(before);
    for (const id of ["Physical", "Collection"]) {
      const item = model.definitions.rootElement!.find(
        (root) => root["@_id"] === id,
      )!;
      if (item.__$$element !== "itemDefinition")
        throw new Error("Missing non-scalar type");
      expect(
        defaultDataType(indexBpmnIds(model.definitions), item),
      ).toBeUndefined();
    }
    const boolean = addOrGetItemDefinitions({
      definitions: model.definitions,
      dataType: "Boolean",
    }).itemDefinition;
    expect(boolean["@_structureRef"]).toBe("xsd1:boolean");
    expect(defaultDataType(indexBpmnIds(model.definitions), boolean)).toBe(
      "Boolean",
    );
    const imported = model.definitions.rootElement!.find(
      (root) => root["@_id"] === "String",
    )!;
    if (imported.__$$element !== "itemDefinition")
      throw new Error("Missing imported type");
    expect(
      defaultDataType(indexBpmnIds(model.definitions), imported),
    ).toBeUndefined();
    expect(model.definitions["@_xmlns:xsd"]).toBe("urn:outside");
    const stable = structuredClone(model);
    expect(() =>
      addOrGetItemDefinitions({
        definitions: model.definitions,
        dataType: "unbound:Type",
      }),
    ).toThrow("BPMN_UNKNOWN_NAMESPACE");
    expect(() =>
      renameItemDefinition({
        definitions: model.definitions,
        id: "String",
        newItemDefinitionName: "tns:",
      }),
    ).toThrow("BPMN_INVALID_QNAME");
    expect(model).toEqual(stable);
    const blank = addOrGetItemDefinitions({
      definitions: model.definitions,
      dataType: "",
    }).itemDefinition;
    expect(blank).not.toHaveProperty("@_structureRef");
    const { itemDefinitionById, setItemDefinitionMetadata } =
      await import("./editor/mutations/renameItemDefinition");
    const ordinal = model.definitions.rootElement!.findIndex(
      (root) =>
        root.__$$element === "itemDefinition" &&
        root["@_structureRef"] === "tns:Second",
    );
    const expected = structuredClone(model);
    renameItemDefinition({
      definitions: model.definitions,
      id: ordinal,
      newItemDefinitionName: "tns:Revised",
    });
    setItemDefinitionMetadata(
      model.definitions,
      ordinal,
      "@_itemKind",
      "Physical",
    );
    setItemDefinitionMetadata(
      model.definitions,
      ordinal,
      "@_isCollection",
      false,
    );
    Object.assign(expected.definitions.rootElement![ordinal], {
      "@_structureRef": "tns:Revised",
      "@_itemKind": "Physical",
      "@_isCollection": false,
    });
    expect(model).toEqual(expected);
    expect(itemDefinitionById(model.definitions, ordinal)).not.toHaveProperty(
      "@_id",
    );
    deleteItemDefinition({ definitions: model.definitions, id: ordinal });
    expected.definitions.rootElement!.splice(ordinal, 1);
    expect(model).toEqual(expected);
    const written = getMarshaller(source).builder.build(model);
    expect(getMarshaller(written).parser.parse()).toEqual(model);
  });
  it("encodes selections in the field's scope and keeps display renames independent from payload/code", async () => {
    const source = await fixture("definitions-references");
    const model = normalize(getMarshaller(source).parser.parse());
    const expected = structuredClone(model);
    renameSignal({
      definitions: model.definitions,
      id: "Signal",
      newSignalName: "Renamed",
    });
    renameEscalation({
      definitions: model.definitions,
      id: "Escalation",
      newEscalationName: "Renamed",
    });
    for (const root of expected.definitions.rootElement ?? [])
      if (root.__$$element === "signal" || root.__$$element === "escalation")
        root["@_name"] = "Renamed";
    expect(model).toEqual(expected);
    const unchanged = structuredClone(model);
    expect(() =>
      renameMessage({
        definitions: model.definitions,
        id: "Signal",
        newMessageName: "Wrong kind",
      }),
    ).toThrow("BPMN_DEFINITION_NOT_FOUND");
    expect(() =>
      renameError({
        definitions: model.definitions,
        id: "Signal",
        newErrorName: "Wrong kind",
      }),
    ).toThrow("BPMN_DEFINITION_NOT_FOUND");
    expect(model).toEqual(unchanged);
    const index = indexBpmnIds(model.definitions);
    const start = processOf(model).flowElement!.find(
      (element) => element.__$$element === "startEvent",
    )!;
    if (start.__$$element !== "startEvent") throw new Error("Missing start");
    const event = start.eventDefinition![0];
    if (event.__$$element !== "messageEventDefinition")
      throw new Error("Missing message event");
    expect(index.resolveReference(event, "tns:Message")).toBe("Message");
    expect(index.resolveReference(event, "foreign:Message")).toBeUndefined();
    expect(index.referenceFor(event, "Message", " tns:Message ")).toBe(
      " tns:Message ",
    );
    expect(() => index.referenceFor(event, "Missing")).toThrow(
      "BPMN_DANGLING_REFERENCE",
    );
    expect(model).toEqual(unchanged);
    // The field, not its enclosing task, can shadow bindings. A safe selection
    // must not silently turn this external reference into a bare local token.
    Object.assign(event, {
      "@_xmlns": "urn:outside",
      "@_xmlns:tns": "urn:outside",
      "@_xmlns:b": "http://www.omg.org/spec/BPMN/20100524/MODEL",
    });
    const scoped = indexBpmnIds(model.definitions);
    expect(scoped.resolveReference(event, "tns:Message")).toBeUndefined();
    event["@_messageRef"] = scoped.referenceFor(
      event,
      "Message",
      event["@_messageRef"],
    );
    expect(event["@_messageRef"]).toBe("tns1:Message");
    const written = getMarshaller(source).builder.build(model);
    const reopened = getMarshaller(written).parser.parse();
    expect(reopened).toEqual(model);
    expect(written).toContain('xmlns:tns="urn:outside"');
    const reopenedStart = processOf(reopened).flowElement!.find(
      (element) => element.__$$element === "startEvent",
    )!;
    if (reopenedStart.__$$element !== "startEvent")
      throw new Error("Missing start");
    const reopenedEvent = reopenedStart.eventDefinition![0];
    expect(
      indexBpmnIds(reopened.definitions).resolveReference(
        reopenedEvent,
        "tns1:Message",
      ),
    ).toBe("Message");
    const shadowed = getMarshaller(
      source.replace(
        "<inMessageRef>",
        '<inMessageRef xmlns:tns="urn:outside">',
      ),
    ).parser.parse();
    indexBpmnIds(shadowed.definitions).rename("Message", "Changed");
    expect(getMarshaller(source).builder.build(shadowed)).toContain(
      '<inMessageRef xmlns:tns="urn:outside">tns:Message</inMessageRef>',
    );
  });
  it("renames only owned declaration references, preserving external type names and lexical namespace scope", async () => {
    const source = (await fixture("definitions-references"))
      .replace(
        '<message id="Message"',
        '<itemDefinition id="FormalType"/><message id="Message"',
      )
      .replaceAll(
        "</task>",
        '<standardLoopCharacteristics><loopCondition xmlns:schema="http://www.w3.org/2001/XMLSchema-instance" xmlns:model="http://www.omg.org/spec/BPMN/20100524/MODEL" schema:type="model:tFormalExpression" evaluatesToTypeRef="tns:FormalType">ready</loopCondition></standardLoopCharacteristics></task>',
      );
    const model = normalize(getMarshaller(source).parser.parse());
    const before = structuredClone(model);
    expect(() =>
      deleteItemDefinition({ definitions: model.definitions, id: "Payload" }),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(() =>
      deleteItemDefinition({
        definitions: model.definitions,
        id: "FormalType",
      }),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(() =>
      indexBpmnIds(model.definitions).rename("Payload", "Message"),
    ).toThrow("BPMN_INVALID_ID_RENAME");
    expect(model).toEqual(before);
    indexBpmnIds(model.definitions).rename("FormalType", "NewFormalType");
    indexBpmnIds(model.definitions).rename("Payload", "NewPayload");
    indexBpmnIds(model.definitions).rename("Message", "NewMessage");
    indexBpmnIds(model.definitions).rename("Signal", "NewSignal");
    indexBpmnIds(model.definitions).rename("Error", "NewError");
    indexBpmnIds(model.definitions).rename("Escalation", "NewEscalation");
    indexBpmnIds(model.definitions).rename("Operation", "NewOperation");
    indexBpmnIds(model.definitions).rename("Global", "NewGlobal");
    indexBpmnIds(model.definitions).rename("CategoryValue", "NewCategoryValue");
    const expected = source
      .replace('id="FormalType"', 'id="NewFormalType"')
      .replace(
        'evaluatesToTypeRef="tns:FormalType"',
        'evaluatesToTypeRef="tns:NewFormalType"',
      )
      .replace('id="Payload"', 'id="NewPayload"')
      .replace('itemRef="tns:Payload"', 'itemRef="tns:NewPayload"')
      .replace(
        'name="Notice" structureRef="tns:Payload"',
        'name="Notice" structureRef="tns:NewPayload"',
      )
      .replace(
        'errorCode="E1" structureRef="tns:Payload"',
        'errorCode="E1" structureRef="tns:NewPayload"',
      )
      .replace(
        'escalationCode="E2" structureRef="tns:Payload"',
        'escalationCode="E2" structureRef="tns:NewPayload"',
      )
      .replace(
        'id="Input" itemSubjectRef="tns:Payload"',
        'id="Input" itemSubjectRef="tns:NewPayload"',
      )
      .replace('id="Message"', 'id="NewMessage"')
      .replace(
        "<inMessageRef>tns:Message</inMessageRef>",
        "<inMessageRef>tns:NewMessage</inMessageRef>",
      )
      .replace('messageRef="tns:Message"', 'messageRef="tns:NewMessage"')
      .replace('id="Signal"', 'id="NewSignal"')
      .replace('signalRef="tns:Signal"', 'signalRef="tns:NewSignal"')
      .replace('id="Error"', 'id="NewError"')
      .replace('errorRef="tns:Error"', 'errorRef="tns:NewError"')
      .replace('id="Escalation"', 'id="NewEscalation"')
      .replace(
        'escalationRef="tns:Escalation"',
        'escalationRef="tns:NewEscalation"',
      )
      .replace('id="Operation"', 'id="NewOperation"')
      .replace(
        'operationRef="tns:Operation"',
        'operationRef="tns:NewOperation"',
      )
      .replace('id="Global"', 'id="NewGlobal"')
      .replace('calledElement="tns:Global"', 'calledElement="tns:NewGlobal"')
      .replace('id="CategoryValue"', 'id="NewCategoryValue"')
      .replace(
        'categoryValueRef="tns:CategoryValue"',
        'categoryValueRef="tns:NewCategoryValue"',
      );
    const written = getMarshaller(source).builder.build(model);
    expect(getMarshaller(written).parser.parse()).toEqual(
      getMarshaller(expected).parser.parse(),
    );
    expect(written).toContain('id="NewPayload" structureRef="tns:Payload"');
    expect(written).toContain('implementationRef="tns:Message"');
    expect(written).toContain('id="ShadowInput" itemSubjectRef="tns:Payload"');
    for (const reference of [
      'itemRef="tns:NewPayload"',
      'itemSubjectRef="tns:NewPayload"',
      "<inMessageRef>tns:NewMessage</inMessageRef>",
      "<outMessageRef>foreign:Message</outMessageRef>",
      'messageRef="tns:NewMessage"',
      'signalRef="tns:NewSignal"',
      'errorRef="tns:NewError"',
      'escalationRef="tns:NewEscalation"',
      'operationRef="tns:NewOperation"',
      'calledElement="tns:NewGlobal"',
      'categoryValueRef="tns:NewCategoryValue"',
    ])
      expect(written).toContain(reference);
    expect(() =>
      indexBpmnIds(
        getMarshaller(
          source.replace('id="Signal"', 'id="Message"'),
        ).parser.parse().definitions,
      ),
    ).toThrow("BPMN_DUPLICATE_ID");
    expect(() => parseXmlQName("private:fragment:extra")).toThrow(
      /^BPMN_INVALID_QNAME$/,
    );
    expect(parseXmlQName("ns:Élément")).toEqual({
      type: "xml-qname",
      prefix: "ns",
      localPart: "Élément",
    });
    expect(parseXmlQName(" Élément ")).toEqual({
      type: "xml-qname",
      localPart: "Élément",
    });
    for (const [kind, create] of [
      [
        "signal",
        () =>
          addOrGetSignals({
            definitions: model.definitions,
            signalName: "New signal",
          }).signalRef,
      ],
      [
        "error",
        () =>
          addOrGetErrors({
            definitions: model.definitions,
            errorName: "New error",
          }).errorRef,
      ],
      [
        "escalation",
        () =>
          addOrGetEscalations({
            definitions: model.definitions,
            escalationName: "New escalation",
          }).escalationRef,
      ],
    ] as const) {
      const id = create();
      expect(
        model.definitions.rootElement?.find((root) => root["@_id"] === id),
      ).toMatchObject({ __$$element: kind });
      expect(
        model.definitions.rootElement?.find((root) => root["@_id"] === id),
      ).not.toHaveProperty("@_structureRef");
    }
  });
  it("advertises only working initial semantics and retains passive extensions/definitions across a real normalized edit", async () => {
    const source = await fixture("profile-initial");
    const inspection = inspectBpmnSource(source);
    expect(inspection.status).toBe("accepted");
    if (inspection.status !== "accepted")
      throw new Error(inspection.error.code);
    expect(inspection.editability.findings).toContainEqual({
      state: "preserved-opaque",
      reason: "BPMN_PRESERVED_EXTENSION",
      elementId: "Process",
    });
    const before = structuredClone(inspection.model);
    const model = normalize(inspection.model);
    expect(model).toEqual(before);
    const task = processOf(model).flowElement!.find(
      (element) => element["@_id"] === "Task",
    )!;
    task["@_name"] = "Edited";
    processOf(before).flowElement!.find(
      (element) => element["@_id"] === "Task",
    )!["@_name"] = "Edited";
    const written = getMarshaller(source).builder.build(model);
    expect(getMarshaller(written).parser.parse()).toEqual(before);
    expect(
      getMarshaller(written).builder.build(
        getMarshaller(written).parser.parse(),
      ),
    ).toBe(written);
    expect(inspectBpmnSource(written).status).toBe("accepted");
    for (const [candidate, code, elementId] of [
      [
        source
          .replaceAll("<task ", "<choreographyTask ")
          .replaceAll("</task>", "</choreographyTask>"),
        "BPMN_UNSUPPORTED_ELEMENT",
        "Task",
      ],
      [
        source.replace(
          '<task id="Task"',
          '<task isForCompensation="true" id="Task"',
        ),
        "BPMN_UNSUPPORTED_PROPERTY",
        "Task",
      ],
      [
        source.replace('<task id="Task"', '<task unsupported="true" id="Task"'),
        "BPMN_UNSUPPORTED_PROPERTY",
        "Task",
      ],
      [
        source.replace(
          '<task id="Task"',
          '<task xmlns="urn:foreign" id="Task"',
        ),
        "BPMN_UNSUPPORTED_EXTENSION",
        "Process",
      ],
      [
        source.replace(
          "</process>",
          '<laneSet id="Lanes"><lane id="Lane"/></laneSet><laneSet id="Independent"/></process>',
        ),
        "BPMN_UNSUPPORTED_ELEMENT",
        "Independent",
      ],
      [
        source.replace(
          "</definitions>",
          '<collaboration id="Collaboration"/></definitions>',
        ),
        "BPMN_UNSUPPORTED_ELEMENT",
        "Collaboration",
      ],
    ])
      expect(inspectBpmnSource(candidate)).toMatchObject({
        status: "unsupported",
        source: candidate,
        error: { code, elementId },
      });
  });
  it("creates an unnamed process with its own DI plane and resolves imports without repairing their owners", () => {
    const blank = createBlankBpmnSource();
    const model = getMarshaller(blank).parser.parse();
    const before = structuredClone(model);
    const owner = resolveBpmnProcessOwner(model.definitions);
    expect(owner.plane["@_bpmnElement"]).toBe(owner.process["@_id"]);
    expect(owner.process["@_name"]).toBeUndefined();
    expect(model).toEqual(before);
    expect(inspectBpmnSource(blank).status).toBe("accepted");
    const unplaced = structuredClone(model);
    processOf(unplaced).flowElement = [
      { __$$element: "task", "@_id": "UnplacedTask" },
    ];
    const unplacedSource = getMarshaller(blank).builder.build(unplaced);
    expect(inspectBpmnSource(unplacedSource)).toMatchObject({
      status: "incomplete-di",
      source: unplacedSource,
      error: { code: "BPMN_INCOMPLETE_DI" },
    });
    const multiple = structuredClone(model);
    multiple.definitions.rootElement!.push({
      ...owner.process,
      "@_id": "SecondProcess",
    });
    expect(() => resolveBpmnProcessOwner(multiple.definitions)).toThrow(
      "BPMN_OWNER_CARDINALITY",
    );
    const missing = structuredClone(model);
    delete missing.definitions["bpmndi:BPMNDiagram"];
    expect(() => resolveBpmnProcessOwner(missing.definitions)).toThrow(
      "BPMN_MISSING_DI",
    );
    const foreign = structuredClone(model);
    foreign.definitions["@_xmlns:foreign"] = "urn:outside";
    foreign.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"][
      "@_bpmnElement"
    ] = `foreign:${owner.process["@_id"]}`;
    expect(() => resolveBpmnProcessOwner(foreign.definitions)).toThrow(
      "BPMN_PLANE_OWNER",
    );
  });
  it("refuses incomplete or ambiguous DI without changing source or inventing geometry", async () => {
    const source = await fixture("profile-initial");
    const startShape =
      '<bpmndi:BPMNShape id="StartDI" bpmnElement="Start"><dc:Bounds x="40" y="60" width="36" height="36"/></bpmndi:BPMNShape>';
    for (const [candidate, code] of [
      [source.replace(startShape, ""), "BPMN_INCOMPLETE_DI"],
      [
        source.replace(
          'id="TaskDI" bpmnElement="Task"',
          'id="TaskDI" bpmnElement="Start"',
        ),
        "BPMN_INCOMPLETE_DI",
      ],
      [
        source.replace(
          'id="TaskDI" bpmnElement="Task"',
          'id="TaskDI" bpmnElement="ForeignTask"',
        ),
        "BPMN_INCOMPLETE_DI",
      ],
      [
        source.replace("<bpmndi:BPMNLabel>", '<bpmndi:BPMNLabel id="Task">'),
        "BPMN_DUPLICATE_ID",
      ],
      [
        source.replace(
          "<bpmndi:BPMNLabel>",
          '<bpmndi:BPMNLabel labelStyle="MissingStyle">',
        ),
        "BPMN_DANGLING_REFERENCE",
      ],
      [source.replace('width="110"', 'width="-1"'), "BPMN_INCOMPLETE_DI"],
      [source.replace('x="40"', 'x="INF"'), "BPMN_INCOMPLETE_DI"],
      [source.replace('x="40"', 'x="40px"'), "BPMN_UNSUPPORTED_PROPERTY"],
      [
        source.replace('<di:waypoint x="280" y="80"/>', ""),
        "BPMN_INCOMPLETE_DI",
      ],
      [
        source.replace(
          "</bpmndi:BPMNDiagram>",
          '<bpmndi:BPMNPlane id="SecondPlane" bpmnElement="Process"/></bpmndi:BPMNDiagram>',
        ),
        "BPMN_OWNER_CARDINALITY",
      ],
      [
        source.replace(
          'id="Plane" bpmnElement="Process"',
          'id="Plane" bpmnElement="OtherProcess"',
        ),
        "BPMN_PLANE_OWNER",
      ],
    ]) {
      const result = inspectBpmnSource(candidate);
      expect(result).toMatchObject({ source: candidate, error: { code } });
      expect(result.status).not.toBe("accepted");
    }
  });
  it.each(["blank", "start-task-end", "cancel-loop"])(
    "preserves %s semantics and DI across a focused edit and two writes",
    async (name) => {
      const source = await fixture(name);
      const marshaller = getMarshaller(source);
      const model = marshaller.parser.parse();
      const before = structuredClone(model);
      processOf(model)["@_name"] = "Edited & retained";
      processOf(before)["@_name"] = "Edited & retained";

      const written = marshaller.builder.build(model);
      const reopened = getMarshaller(written);
      expect(reopened.parser.parse()).toEqual(before);
      expect(reopened.builder.build(reopened.parser.parse())).toBe(written);
    },
  );

  it("retains independently specified nodes, connections, QName values, geometry and opaque mixed XML", async () => {
    const marshaller = getMarshaller(await fixture("start-task-end"));
    const model = marshaller.parser.parse();
    const process = processOf(model);
    expect(process["@_isExecutable"]).toBe(true);
    expect(
      process.flowElement?.map((element) => [
        element.__$$element,
        element["@_id"],
      ]),
    ).toEqual([
      ["startEvent", "Start_1"],
      ["task", "Task_1"],
      ["endEvent", "End_1"],
      ["sequenceFlow", "Flow_1"],
      ["sequenceFlow", "Flow_2"],
    ]);
    const start = process.flowElement?.find(
      (element) => element.__$$element === "startEvent",
    );
    expect(start).toMatchObject({
      outgoing: [{ __$$text: "Flow_1" }],
      eventDefinition: [
        {
          __$$element: "messageEventDefinition",
          "@_messageRef": "tns:Message_1",
        },
      ],
    });
    expect(
      process.flowElement?.find((element) => element["@_id"] === "Flow_1"),
    ).toMatchObject({
      "@_sourceRef": "Start_1",
      "@_targetRef": "Task_1",
    });
    const plane =
      model.definitions["bpmndi:BPMNDiagram"]?.[0]["bpmndi:BPMNPlane"];
    expect(plane?.["@_bpmnElement"]).toBe("tns:Process_1");
    expect(plane?.["di:DiagramElement"]).toHaveLength(5);
    expect(
      plane?.["di:DiagramElement"]?.find(
        (element) => element["@_id"] === "Task_di",
      ),
    ).toMatchObject({
      "dc:Bounds": { "@_x": 180, "@_y": 78, "@_width": 100, "@_height": 80 },
    });
    expect(
      plane?.["di:DiagramElement"]?.find(
        (element) => element["@_id"] === "Flow_1_di",
      ),
    ).toMatchObject({
      "di:waypoint": [
        { "@_x": 116, "@_y": 118 },
        { "@_x": 180, "@_y": 118 },
      ],
    });
    process["@_name"] = "Changed";
    const written = marshaller.builder.build(model);
    expect(written).toContain('messageRef="tns:Message_1"');
    expect(written).toContain('vendor:version="2"');
    expect(written).toContain(
      'before<vendor:item key="a">A &amp; B</vendor:item>between<vendor:other/><vendor:item key="b"><![CDATA[<retained>]]></vendor:item>after',
    );
    // The complete parsed-tree comparison alone cannot detect markup the parser
    // already discarded. Observe the independently specified mixed XML as well.
    const mixed = (await fixture("profile-initial")).replace(
      "Unchanged&#13;documentation",
      'before<h:span xmlns:h="http://www.w3.org/1999/xhtml">important</h:span>after',
    );
    const mixedModel = getMarshaller(mixed).parser.parse();
    processOf(mixedModel)["@_name"] = "Focused edit";
    const mixedWritten = getMarshaller(mixed).builder.build(mixedModel);
    expect(mixedWritten).toContain(
      'before<h:span xmlns:h="http://www.w3.org/1999/xhtml">important</h:span>after',
    );
    expect(inspectBpmnSource(mixed)).toMatchObject({
      status: "unsupported",
      source: mixed,
      error: { code: "BPMN_UNSUPPORTED_EXTENSION", elementId: "Task" },
    });
    const shadowed =
      '<?xml version="1.0"?><b:definitions xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:q="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:dc="urn:vendor" targetNamespace="urn:fixture"><b:process xmlns:q="urn:shadow" id="P"><b:documentation>A&#13;B</b:documentation></b:process></b:definitions>';
    const shadowModel = getMarshaller(shadowed).parser.parse();
    processOf(shadowModel)["@_name"] = "Focused edit";
    const shadowWritten = getMarshaller(shadowed).builder.build(shadowModel);
    expect(getMarshaller(shadowWritten).parser.parse()).toEqual(shadowModel);
    expect(shadowWritten).toContain('xmlns:dc="urn:vendor"');
    expect(shadowWritten).not.toContain("xmlns:bpmndi=");
  });

  it("maps official cancel events and standard loops rather than KIE schema omissions", async () => {
    const source = await fixture("cancel-loop");
    const marshaller = getMarshaller(source);
    expect(inspectBpmnSource(source).status).toBe("accepted");
    expect(
      inspectBpmnSource(
        source.replace('cancelActivity="true"', 'cancelActivity="false"'),
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Boundary_1" },
    });
    const ordinary = source
      .replace("<transaction ", "<subProcess ")
      .replace("</transaction>", "</subProcess>");
    expect(inspectBpmnSource(ordinary)).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Cancel_1" },
    });
    expect(
      inspectBpmnSource(
        ordinary.replace(
          '<cancelEventDefinition id="CancelDefinition_1"/>',
          "",
        ),
      ),
    ).toMatchObject({
      status: "unsupported",
      error: { code: "BPMN_UNSUPPORTED_PROPERTY", elementId: "Boundary_1" },
    });
    const process = processOf(marshaller.parser.parse());
    const transaction = process.flowElement?.find(
      (element) => element.__$$element === "transaction",
    );
    if (transaction?.__$$element !== "transaction")
      throw new Error("Missing transaction");
    expect(
      transaction.flowElement?.find((element) => element["@_id"] === "Task_1"),
    ).toMatchObject({
      loopCharacteristics: {
        __$$element: "standardLoopCharacteristics",
        "@_loopMaximum": 3,
        "@_testBefore": false,
        loopCondition: { __$$text: "retry" },
      },
    });
    expect(
      transaction.flowElement?.find(
        (element) => element["@_id"] === "Cancel_1",
      ),
    ).toMatchObject({
      eventDefinition: [
        { __$$element: "cancelEventDefinition", "@_id": "CancelDefinition_1" },
      ],
    });
    expect(
      process.flowElement?.find((element) => element["@_id"] === "Boundary_1"),
    ).toMatchObject({
      "@_attachedToRef": "Transaction_1",
      eventDefinition: [
        { __$$element: "cancelEventDefinition", "@_id": "BoundaryCancel_1" },
      ],
    });
  });

  it("consumes a BOM only inside the parser and preserves XML attribute character references", async () => {
    const source =
      "\uFEFF" +
      (await fixture("blank")).replace(
        'id="Process_1"',
        'id="Process_1" name="A&#10;B&#9;C&#13;D"',
      );
    const marshaller = getMarshaller(source);
    const model = marshaller.parser.parse();
    expect(processOf(model)["@_name"]).toBe("A\nB\tC\rD");
    expect(
      getMarshaller(marshaller.builder.build(model)).parser.parse(),
    ).toEqual(model);
    const text = "<documentation>A\u0085B\u2028C\u2029D&#13;E</documentation>";
    const xml10 = `<?xml version="1.0" encoding="UTF-8"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P">${text}</process></definitions>`;
    const xml11 = xml10.replace('version="1.0"', 'version="1.1"');
    expect(
      processOf(getMarshaller(xml10).parser.parse()).documentation?.[0]
        .__$$text,
    ).toBe("A\u0085B\u2028C\u2029D\rE");
    expect(inspectBpmnBytes(new TextEncoder().encode(xml11))).toMatchObject({
      status: "unsupported",
      source: xml11,
      error: { code: "BPMN_UNSUPPORTED_XML_VERSION" },
    });
  });

  it("rejects malformed, DTD-bearing and non-BPMN XML without exposing payloads", () => {
    expect(() => getMarshaller("<private-fragment>")).toThrow(
      "BPMN_MALFORMED_XML",
    );
    expect(() => getMarshaller("<!DOCTYPE definitions><definitions/>")).toThrow(
      "BPMN_UNSAFE_XML",
    );
    expect(() => getMarshaller('<definitions xmlns="urn:other"/>')).toThrow(
      "BPMN_UNKNOWN_NAMESPACE",
    );
  });

  it("retains exact UTF-8 bytes, BOM and CRLF while refusing undecodable or falsely declared files", () => {
    const source = "\uFEFF" + createBlankBpmnSource().replaceAll("\n", "\r\n");
    const bytes = new TextEncoder().encode(source);
    const accepted = inspectBpmnBytes(bytes);
    expect(accepted).toMatchObject({ status: "accepted", source, bytes });
    expect(new TextEncoder().encode(accepted.source!)).toEqual(bytes);
    expect(
      inspectBpmnBytes(
        new TextEncoder().encode(
          source.replace("<process", '<process name="�"'),
        ),
      ).status,
    ).toBe("accepted");
    for (const invalid of [
      new Uint8Array([0xc0, 0xaf]),
      new Uint8Array([0xe2, 0x82]),
      new Uint8Array([0xff, 0xfe, 0x3c, 0]),
    ]) {
      expect(inspectBpmnBytes(invalid)).toEqual({
        status: "invalid",
        bytes: invalid,
        error: { code: "BPMN_INVALID_UTF8" },
      });
    }
    const declared = new TextEncoder().encode(
      source.replace("UTF-8", "ISO-8859-1"),
    );
    expect(inspectBpmnBytes(declared)).toMatchObject({
      status: "invalid",
      bytes: declared,
      error: { code: "BPMN_XML_ENCODING" },
    });
  });

  it("stops structural abuse at its causal parser budget without rewriting rejected source", () => {
    const blank = createBlankBpmnSource();
    // Independently stated XML, not generated through the writer under test.
    const tasks = Array.from(
      { length: 250 },
      (_, i) => `<task id="T${i}"/>`,
    ).join("");
    const shapes = Array.from(
      { length: 250 },
      (_, i) =>
        `<bpmndi:BPMNShape id="S${i}" bpmnElement="T${i}"><dc:Bounds x="${i * 120}" y="0" width="100" height="80"/></bpmndi:BPMNShape>`,
    ).join("");
    const large = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" targetNamespace="urn:fixture"><process id="Process">${tasks}</process><bpmndi:BPMNDiagram id="Diagram"><bpmndi:BPMNPlane id="Plane" bpmnElement="Process">${shapes}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram></definitions>`;
    const accepted = inspectBpmnBytes(new TextEncoder().encode(large));
    expect(accepted.status).toBe("accepted");
    if (accepted.status === "accepted")
      expect(processOf(accepted.model).flowElement).toHaveLength(250);
    const cases: Array<[string, string]> = [
      ['<definitions xmlns="urn:other"/>', "BPMN_UNKNOWN_NAMESPACE"],
      ["<unbound:definitions/>", "BPMN_MALFORMED_XML"],
      [blank.replace("</definitions>", "</unexpected>"), "BPMN_MALFORMED_XML"],
      [
        "<!DOCTYPE definitions [<!ENTITY private 'not disclosed'>]>" +
          blank.replace(/<\?xml[^?]+\?>/, ""),
        "BPMN_UNSAFE_XML",
      ],
      [blank.replace("<process", '<process name="&#0;"'), "BPMN_MALFORMED_XML"],
      [
        blank.replace(
          "</definitions>",
          `<extensionElements>${"<x>".repeat(BPMN_XML_BUDGET.depth)}${"</x>".repeat(BPMN_XML_BUDGET.depth)}</extensionElements></definitions>`,
        ),
        "BPMN_XML_DEPTH",
      ],
      [
        blank.replace(
          "<process",
          `<process ${Array.from({ length: BPMN_XML_BUDGET.attributes }, (_, i) => `a${i}="v"`).join(" ")}`,
        ),
        "BPMN_XML_ATTRIBUTES",
      ],
      [
        blank.replace(
          "<process",
          `<process name="${"v".repeat(BPMN_XML_BUDGET.attributeLength + 1)}"`,
        ),
        "BPMN_XML_ATTRIBUTE_LENGTH",
      ],
      [blank + " ".repeat(BPMN_XML_BUDGET.characters), "BPMN_XML_WORK"],
      [
        blank.replace(
          "</definitions>",
          `<extensionElements>${"<x/>".repeat(BPMN_XML_BUDGET.tokens)}</extensionElements></definitions>`,
        ),
        "BPMN_XML_TOKENS",
      ],
      [
        blank.replace(
          "</bpmndi:BPMNPlane>",
          `${"<bpmndi:BPMNShape/>".repeat(BPMN_XML_BUDGET.renderObjects + 1)}</bpmndi:BPMNPlane>`,
        ),
        "BPMN_RENDER_OBJECTS",
      ],
    ];
    for (const [source, code] of cases) {
      const result = inspectBpmnSource(source);
      expect(result).toMatchObject({ source, error: { code } });
      expect(
        JSON.stringify("error" in result ? result.error : {}),
      ).not.toContain("not disclosed");
    }
    expect(inspectBpmnSource('<definitions xmlns="urn:other"/>')).toMatchObject(
      { error: { code: "BPMN_UNKNOWN_NAMESPACE" } },
    );
  });

  it("imports the public source entry and roundtrips in a DOM-free worker", async () => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      import('tsx/esm/api').then(async ({ tsImport }) => {
        const { getMarshaller } = await tsImport(workerData.entry, workerData.entry);
        const marshaller = getMarshaller(workerData.source);
        parentPort.postMessage({
          hasBrowser: typeof window !== 'undefined' || typeof document !== 'undefined' || typeof DOMParser !== 'undefined',
          xml: marshaller.builder.build(marshaller.parser.parse()),
        });
      }).catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: {
          entry: fileURLToPath(new URL("./source.ts", import.meta.url)),
          source: await fixture("blank"),
        },
      },
    );
    try {
      const result = await new Promise<{ hasBrowser: boolean; xml: string }>(
        (resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`Worker exited: ${code}`));
          });
        },
      );
      expect(result.hasBrowser).toBe(false);
      expect(processOf(getMarshaller(result.xml).parser.parse())["@_id"]).toBe(
        "Process_1",
      );
    } finally {
      await worker.terminate();
    }
  });
});
