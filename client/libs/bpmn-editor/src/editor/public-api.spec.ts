// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, createElement, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createBpmnEditorStore, type State } from "./store/Store";
import { ComputedStateCache } from "../xyflow/store/ComputedStateCache";
import { INITIAL_COMPUTED_CACHE } from "./store/initialComputedCache";
import {
  BpmnEditorStoreApiContext,
  useBpmnEditorStore,
} from "./store/StoreContext";
import type {
  BpmnEditorRef,
  BpmnCommandState,
  BpmnSnapshot,
  BpmnSourceRevision,
} from "../modeller";
import {
  createBlankBpmnSource,
  getMarshaller,
  inspectBpmnSource,
} from "../source";
import {
  PendingEdits,
  PendingEditsContext,
} from "../xyflow/reactExt/PendingEdits";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal("BUILD_CONFIG", {
  isElectron: false,
  isWeb: true,
  isMobileEdition: false,
  appVersion: "test",
  releaseType: "canary",
});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
}));
vi.stubGlobal("environment", {
  isMobile: false,
  isMacOs: false,
  isSafari: false,
  publicPath: "/",
  subPath: "",
});
const { BpmnEditor, BPMN_THEME_ROLES } = await import("../modeller");
const { MyoxusUIProvider } = await import("@myoxus/ui-facade/provider");
const { I18nextProvider, getOrCreateI18n } = await import("@myoxus/i18n");
const i18n = getOrCreateI18n();
const { GlobalProperties } = await import("./propertiesPanel/GlobalProperties");
const { EventDefinitionProperties } =
  await import("./propertiesPanel/eventDefinition/EventDefinitionProperties");
const { eventById } = await import("./mutations/event");
const { BpmnEditorContextProvider } = await import("./BpmnEditorContext");
it("edits the selected data-route inspector without losing semantic slots or expression identities", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/data-associations-standard.bpmn",
      "utf8",
    ),
    original = getMarshaller(xml).parser.parse(),
    store = createBpmnEditorStore(
      original,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    ),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { SingleEdgeProperties } =
    await import("./propertiesPanel/SingleEdgeProperties");
  store.setState((state) => {
    state.xyFlowReactKieDiagram._selectedEdges = ["Read"];
  });
  const field = (text: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === text)!;
    return document.getElementById(label.htmlFor) as HTMLTextAreaElement;
  };
  const type = async (label: string, value: string) =>
    act(async () => {
      const input = field(label);
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                BpmnEditorContextProvider,
                { model: original },
                createElement(SingleEdgeProperties),
              ),
            ),
          ),
        ),
      ),
    );
    await type("Transformation expression", "normalize(updated)");
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Assign")!
        .click(),
    );
    await type("Assignment source expression", "updatedValue");
    const model = store.getState().bpmn.model,
      process = model.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const task = process.flowElement!.find(
      (element) => element["@_id"] === "Review",
    );
    if (task?.__$$element !== "task") throw new Error("Missing activity");
    expect(task.dataInputAssociation![0]).toMatchObject({
      "@_id": "Read",
      targetRef: { __$$text: "In" },
      transformation: {
        "@_id": "Transform",
        "@_language": "urn:map",
        __$$text: "normalize(updated)",
      },
      assignment: [
        {
          "@_id": "Assign",
          from: { "@_id": "From", __$$text: "updatedValue" },
          to: { "@_id": "To", __$$text: "inputValue" },
        },
      ],
    });
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(model)).status,
    ).toBe("accepted");
    const selectSource = async () => {
      const sources = field("Semantic source references");
      if (sources.getAttribute("aria-expanded") !== "true")
        await act(async () => sources.click());
      const list = document.getElementById(
        sources.getAttribute("aria-controls")!,
      )!;
      await act(async () =>
        [...list.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((option) => option.textContent === "Other data (OtherData)")!
          .click(),
      );
    };
    await selectSource();
    const fanIn = store
      .getState()
      .computed(store.getState())
      .getDiagramData()
      .edges.filter((edge) => edge.data?.bpmnElement["@_id"] === "Read");
    expect(fanIn.map((edge) => [edge.source, edge.target])).toEqual([
      ["Data", "Review"],
      ["OtherData", "Review"],
    ]);
    expect(fanIn[0].id).not.toBe(fanIn[1].id);
    await selectSource();
    expect(store.getState().bpmn.model).toEqual(model);
    const selectTarget = async (label: string) => {
      const input = field("Semantic target reference");
      if (input.getAttribute("aria-expanded") !== "true")
        await act(async () => input.click());
      const list = document.getElementById(
        input.getAttribute("aria-controls")!,
      )!;
      await act(async () =>
        [...list.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((option) => option.textContent === label)!
          .click(),
      );
    };
    await selectTarget("Independent input (Contract)");
    const { dataAssociationById: boundAssociation } =
      await import("./mutations/data-association");
    expect(
      boundAssociation(store.getState().bpmn.model.definitions, "Read")!
        .association.targetRef,
    ).toEqual({ __$$text: "Contract" });
    expect(
      boundAssociation(store.getState().bpmn.model.definitions, "Read")!.host
        .ioSpecification,
    ).toEqual(task.ioSpecification);
    await selectTarget("Order (In)");
    expect(store.getState().bpmn.model).toEqual(model);
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Reverse data association")!
        .click(),
    );
    const { dataAssociationById } =
        await import("./mutations/data-association"),
      reversed = store.getState().bpmn.model,
      location = dataAssociationById(reversed.definitions, "Read")!;
    expect(location.kind).toBe("dataOutputAssociation");
    expect(location.association).toEqual({
      ...task.dataInputAssociation![0],
      sourceRef: [
        {
          __$$text: location.host.ioSpecification!.dataOutput!.at(-1)!["@_id"],
        },
      ],
      targetRef: { __$$text: "Data" },
    });
    const route = (model: typeof reversed) =>
      model.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
        "di:DiagramElement"
      ]!.find((element) => element["@_bpmnElement"] === "Read")!;
    expect(route(reversed)).toEqual({
      ...route(model),
      "@_sourceElement": "ReviewDI",
      "@_targetElement": "DataDI",
      "di:waypoint": (route(model) as { "di:waypoint": unknown[] })[
        "di:waypoint"
      ]
        .slice()
        .reverse(),
    });
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(reversed)).status,
    ).toBe("accepted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors shared data-store metadata while keeping reference identity, notation and root lifetime separate", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/data-stores-standard.bpmn",
      "utf8",
    ),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const field = (label: string) => {
    const el = [...container.querySelectorAll<HTMLLabelElement>("label")].find(
      (el) => el.textContent === label,
    )!;
    return document.getElementById(el.htmlFor) as HTMLInputElement;
  };
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (el) => el.textContent === text,
    )!;
  const snapshot = async () => {
    let result!: BpmnSnapshot;
    await act(async () => {
      result = ref.current!.flush();
    });
    return result;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "stores", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    expect(node("Store")).toBeNull();
    expect(
      node("First").querySelector(
        "svg.xyflow-react-kie-diagram--node-shape ellipse",
      ),
    ).not.toBeNull();
    expect(
      node("First").querySelector(
        "svg.xyflow-react-kie-diagram--node-shape polygon",
      ),
    ).toBeNull();
    const deleteSelection = () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Delete",
      )!;
    expect(deleteSelection().disabled).toBe(true);
    await act(async () => node("First").click());
    expect(deleteSelection().disabled).toBe(false);
    await act(async () => button("Referenced data store").click());
    expect(field("Unlimited data store capacity").checked).toBe(false);
    await act(async () => field("Unlimited data store capacity").click());
    expect(field("Data store capacity").disabled).toBe(true);
    let model = getMarshaller((await snapshot()).xml).parser.parse();
    expect(
      model.definitions.rootElement!.find(
        (e) => e.__$$element === "dataStore" && e["@_id"] === "Store",
      ),
    ).toMatchObject({
      "@_capacity": 200,
      "@_isUnlimited": true,
      documentation: [
        { "@_id": "StoreDoc", __$$text: "Shared store metadata" },
      ],
    });
    await act(async () => node("First").click());
    expect(deleteSelection().disabled).toBe(false);
    await act(async () => deleteSelection().click());
    expect(node("First")).toBeNull();
    expect(deleteSelection().disabled).toBe(true);
    const saved = await snapshot();
    model = getMarshaller(saved.xml).parser.parse();
    expect(
      model.definitions.rootElement!.filter(
        (e) => e.__$$element === "dataStore",
      ),
    ).toHaveLength(2);
    expect(inspectBpmnSource(saved.xml).status).toBe("accepted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("edits graphical process I/O through the mounted canvas without turning interface declarations into flow elements", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/process-io-standard.bpmn",
      "utf8",
    ),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>(),
    node = (id: string) =>
      container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${id}"]`,
      )!;
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const type = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "process-io", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    const arrow = (id: string) =>
      [
        ...node(id).querySelectorAll(
          "svg.xyflow-react-kie-diagram--node-shape polygon",
        ),
      ].at(-1)!;
    expect(arrow("Input").getAttribute("fill")).not.toBe(
      arrow("Output").getAttribute("fill"),
    );
    expect(
      node("Input").querySelectorAll("[data-bpmn-collection] line"),
    ).toHaveLength(3);
    await act(async () => node("Input").click());
    expect(field("Collection of data items").disabled).toBe(true);
    await type(field("Data state"), "reviewed");
    const label = container.querySelector<HTMLElement>(
      '[data-nodehref="Input"]',
    )!;
    await act(async () =>
      label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = label.querySelector<HTMLInputElement>(
      'input[aria-label="Edit"]',
    )!;
    expect(input.value).toBe("Request");
    await type(input, "Renamed input");
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    let snapshot!: BpmnSnapshot;
    await act(async () => {
      snapshot = ref.current!.flush();
    });
    const model = getMarshaller(snapshot.xml).parser.parse(),
      expected = getMarshaller(xml).parser.parse(),
      process = expected.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      )!;
    if (process.__$$element !== "process") throw new Error("Missing process");
    process.ioSpecification!.dataInput![0]["@_name"] = "Renamed input";
    process.ioSpecification!.dataInput![0].dataState!["@_name"] = "reviewed";
    expect(model).toEqual(expected);
    expect(inspectBpmnSource(snapshot.xml).status).toBe("accepted");
    await act(async () => ref.current!.undo());
    expect(node("Input").textContent).toContain("Request");
    expect(node("Input").textContent).toContain("[ready]");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[draggable=true][aria-label="Data output"]',
        )!
        .click(),
    );
    await act(async () => {
      snapshot = ref.current!.flush();
    });
    const created = getMarshaller(snapshot.xml)
      .parser.parse()
      .definitions.rootElement!.find((root) => root.__$$element === "process")!;
    if (created.__$$element !== "process") throw new Error("Missing process");
    expect(created.ioSpecification!.dataOutput).toHaveLength(2);
    expect(created.flowElement).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("projects reference-owned state and shared backing cardinality through the mounted inspector", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/data-references-standard.bpmn",
      "utf8",
    ),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>(),
    node = (id: string) =>
      container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${id}"]`,
      )!;
  const field = (label: string) => {
    const element = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((element) => element.textContent === label)!;
    return document.getElementById(element.htmlFor) as HTMLInputElement;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "references", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    expect(node("Backing")).toBeNull();
    expect(node("NestedBacking")).toBeNull();
    expect(
      node("First").querySelectorAll("[data-bpmn-collection] line"),
    ).toHaveLength(3);
    await act(async () => node("Sub").click());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Collapse subprocess")!
        .click(),
    );
    expect(node("NestedRef")).toBeNull();
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Expand subprocess")!
        .click(),
    );
    expect(node("NestedRef")).not.toBeNull();
    await act(async () => node("First").click());
    expect(field("Collection of data items").disabled).toBe(true);
    const input = field("Referenced data object");
    await act(async () => input.click());
    const list = document.getElementById(input.getAttribute("aria-controls")!)!,
      option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === "Visible data (Visible)",
      )!;
    await act(async () => option.click());
    expect(node("First").querySelector("[data-bpmn-collection]")).toBeNull();
    expect(
      node("Second").querySelectorAll("[data-bpmn-collection] line"),
    ).toHaveLength(3);
    expect(node("First").textContent).toContain("[Draft]");
    let saved!: BpmnSnapshot;
    await act(async () => {
      saved = ref.current!.flush();
    });
    expect(inspectBpmnSource(saved.xml).status).toBe("accepted");
    await act(async () => ref.current!.undo());
    expect(
      node("First").querySelectorAll("[data-bpmn-collection] line"),
    ).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("keeps data-object state notation out of inline names while preserving collection and state metadata", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/data-objects-standard.bpmn",
      "utf8",
    ),
    original = getMarshaller(xml).parser.parse(),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const type = async (name: string, value: string) =>
    act(async () => {
      const input = field(name);
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const snapshot = async () => {
    let value!: BpmnSnapshot;
    await act(async () => {
      value = ref.current!.flush();
    });
    return value;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "data-objects", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    expect(
      node("Orders").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape [data-bpmn-collection] line",
      ),
    ).toHaveLength(3);
    expect(node("Orders").textContent).toContain("[Draft]");
    await act(async () => node("Orders").click());
    expect(field("Collection of data items").disabled).toBe(true);
    const chooseType = async (text: string) => {
      const input = field("Data type");
      await act(async () => input.focus());
      const list = document.getElementById(
        input.getAttribute("aria-controls")!,
      )!;
      const option = [
        ...list.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((option) => option.textContent === text)!;
      await act(async () => option.click());
    };
    await chooseType("String");
    expect(field("Collection of data items").checked).toBe(false);
    expect(field("Collection of data items").disabled).toBe(true);
    await chooseType("xsd:string");
    expect(field("Collection of data items").checked).toBe(true);
    await chooseType("Clear selection");
    expect(field("Collection of data items").disabled).toBe(false);
    expect(field("Collection of data items").checked).toBe(true);
    await chooseType("xsd:string");
    await type("Data state", "Final");
    const edited = await snapshot();
    await act(async () => node("Receipt").click());
    await act(async () => field("Collection of data items").click());
    await type("Data state", "Received");
    const label = container.querySelector<HTMLElement>(
      '[data-nodehref="Receipt"]',
    )!;
    await act(async () =>
      label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    const input = label.querySelector<HTMLInputElement>(
      'input[aria-label="Edit"]',
    )!;
    expect(input.value).toBe("Receipt");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Invoice");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const saved = await snapshot(),
      model = getMarshaller(saved.xml).parser.parse(),
      process = model.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    expect(
      process.flowElement!.find((e) => e["@_id"] === "Receipt"),
    ).toMatchObject({
      "@_name": "Invoice",
      "@_isCollection": true,
      dataState: { "@_name": "Received" },
    });
    expect(
      process.flowElement!.find((e) => e["@_id"] === "Orders"),
    ).toMatchObject({
      dataState: {
        "@_id": "OrderState",
        "@_name": "Final",
        documentation: [
          {
            "@_id": "StateDoc",
            __$$text: "Preserve state identity and metadata",
          },
        ],
      },
    });
    expect(model.definitions["bpmndi:BPMNDiagram"]).toEqual(
      original.definitions["bpmndi:BPMNDiagram"],
    );
    expect(
      model.definitions.rootElement!.filter(
        (root) => root.__$$element === "itemDefinition",
      ),
    ).toEqual(
      original.definitions.rootElement!.filter(
        (root) => root.__$$element === "itemDefinition",
      ),
    );
    expect(inspectBpmnSource(saved.xml).status).toBe("accepted");
    expect(edited.xml).toContain('name="Final"');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("projects shared group category edits to both consumers without making groups own their contents", async () => {
  const xml = (
      await readFile(
        "client/libs/bpmn-editor/src/fixtures/groups-standard.bpmn",
        "utf8",
      )
    )
      .replace(' id="FirstDoc"', "")
      .replace(
        '<task id="A" name="Review A"/>',
        '<task id="A" name="Review A"><categoryValueRef>tns:SharedValue</categoryValueRef><categoryValueRef xmlns:alias="urn:myoxus:groups">alias:SharedValue</categoryValueRef><categoryValueRef xmlns:peer="urn:one">peer:SharedValue</categoryValueRef><categoryValueRef xmlns:peer="urn:two">peer:SharedValue</categoryValueRef></task>',
      ),
    original = getMarshaller(xml).parser.parse(),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const snapshot = async () => {
    let value!: BpmnSnapshot;
    await act(async () => {
      value = ref.current!.flush();
    });
    return value;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "groups", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    await act(async () => node("First").click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field("Name"), "Shared revision");
      field("Name").dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(node("First").textContent).toContain("Shared revision");
    expect(node("Second").textContent).toContain("Shared revision");
    const documentation = field(
      "Documentation",
    ) as unknown as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(documentation, "Updated documentation");
      documentation.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const input = field("Definition reference");
    await act(async () => input.click());
    const list = document.getElementById(input.getAttribute("aria-controls")!)!,
      option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === "Other category",
      )!;
    await act(async () => option.click());
    expect(node("First").textContent).toContain("Other category");
    expect(node("Second").textContent).toContain("Shared revision");
    await act(async () => node("A").click());
    const categories = field("Category values");
    await act(async () => categories.click());
    const categoryList = document.getElementById(
      categories.getAttribute("aria-controls")!,
    )!;
    const categoryOption = [
      ...categoryList.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "Other category")!;
    await act(async () => categoryOption.click());
    await act(async () => node("First").click());
    const edited = await snapshot();
    const editedProcess = getMarshaller(edited.xml)
      .parser.parse()
      .definitions.rootElement!.find(
        (element) => element.__$$element === "process",
      )!;
    expect(
      editedProcess.artifact!.find((element) => element["@_id"] === "First")!
        .documentation,
    ).toEqual([{ __$$text: "Updated documentation" }]);
    expect(
      editedProcess.flowElement!.find((element) => element["@_id"] === "A")!
        .categoryValueRef,
    ).toEqual([
      ...original.definitions
        .rootElement!.find((root) => root.__$$element === "process")!
        .flowElement!.find((element) => element["@_id"] === "A")!
        .categoryValueRef!,
      { __$$text: "OtherValue" },
    ]);
    expect(inspectBpmnSource(edited.xml).status).toBe("accepted");
    expect(
      getMarshaller(edited.xml).parser.parse().definitions[
        "bpmndi:BPMNDiagram"
      ],
    ).toEqual(original.definitions["bpmndi:BPMNDiagram"]);
    await act(async () => node("First").focus());
    await act(async () =>
      node("First").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      ),
    );
    expect(node("First")).toBeNull();
    expect(node("A")).not.toBeNull();
    const after = await snapshot();
    expect(
      getMarshaller(after.xml)
        .parser.parse()
        .definitions.rootElement!.find(
          (root) => root.__$$element === "category",
        ),
    ).toEqual(
      getMarshaller(edited.xml)
        .parser.parse()
        .definitions.rootElement!.find(
          (root) => root.__$$element === "category",
        ),
    );
    await act(async () => ref.current!.undo());
    expect((await snapshot()).xml).toBe(edited.xml);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors association directions through the retained inspector and actual marker path", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/associations-standard.bpmn",
      "utf8",
    ),
    original = getMarshaller(xml).parser.parse(),
    store = createBpmnEditorStore(
      original,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
  const { AssociationProperties } =
      await import("./propertiesPanel/singleEdgeProperties/AssociationProperties"),
    { AssociationPath } = await import("./diagram/edges/EdgeSvgs"),
    { connectionElement } = await import("./mutations/connection");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Fields = () => {
    const definitions = useBpmnEditorStore(
        (state) => state.bpmn.model.definitions,
      ),
      association = connectionElement(definitions, "Undirected").element;
    if (association.__$$element !== "association")
      throw new Error("Missing association");
    return createElement(
      "div",
      null,
      createElement(AssociationProperties, { association }),
      createElement(
        "svg",
        null,
        createElement(AssociationPath, {
          id: "projection",
          d: "M0,0 L100,0",
          associationDirection: association["@_associationDirection"],
        }),
      ),
    );
  };
  const select = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    await act(async () => input.click());
    const list = document.getElementById(input.getAttribute("aria-controls")!)!;
    const option = [
      ...list.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === value)!;
    await act(async () => option.click());
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                BpmnEditorContextProvider,
                { model: original },
                createElement(Fields),
              ),
            ),
          ),
        ),
      ),
    );
    expect(store.getState().bpmn.model.definitions).toEqual(
      original.definitions,
    );
    expect(
      container.querySelector("#projection")!.getAttribute("marker-end"),
    ).toBeNull();
    await select("Directed");
    expect(
      container.querySelector("#projection")!.getAttribute("marker-start"),
    ).toBeNull();
    expect(
      container.querySelector("#projection")!.getAttribute("marker-end"),
    ).toBe("url(#open-arrow)");
    await select("Bidirectional");
    expect(
      container.querySelector("#projection")!.getAttribute("marker-start"),
    ).toBe("url(#open-arrow)");
    const model = store.getState().bpmn.model;
    expect(model.definitions["bpmndi:BPMNDiagram"]).toEqual(
      original.definitions["bpmndi:BPMNDiagram"],
    );
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(model)).status,
    ).toBe("accepted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors gateway fields through their retained public inspectors and rejects lossy morphs", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/gateways-standard.bpmn",
      "utf8",
    ),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const choose = async (id: string) => act(async () => node(id).click());
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const select = async (name: string, value: string) => {
    const input = field(name);
    await act(async () => input.click());
    const list = document.getElementById(input.getAttribute("aria-controls")!)!,
      option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === value,
      )!;
    await act(async () => option.click());
  };
  const snapshot = async () => {
    let value!: BpmnSnapshot;
    await act(async () => {
      value = ref.current!.flush();
    });
    return value;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "gateways", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    await choose("Exclusive");
    const before = await snapshot();
    expect(
      node("Exclusive").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape line",
      ),
    ).toHaveLength(0);
    await select("Gateway direction", "Diverging");
    expect((await snapshot()).xml).toBe(before.xml);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => field("Show gateway marker").click());
    expect(
      node("Exclusive").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape line",
      ),
    ).toHaveLength(2);
    const marked = await snapshot();
    await select("Default sequence flow", "Accepted");
    expect((await snapshot()).xml).toBe(marked.xml);
    await choose("Complex");
    const input = field("Activation condition");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "readyCount > 3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const edited = await snapshot();
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-nodehref="Complex"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "3", bubbles: true }),
        ),
    );
    expect((await snapshot()).xml).toBe(edited.xml);
    await choose("Event");
    expect(
      node("Event").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape circle",
      ),
    ).toHaveLength(2);
    await select("Event gateway type", "Parallel");
    expect((await snapshot()).xml).toBe(edited.xml);
    await act(async () => field("Instantiate process").click());
    expect(
      node("Event").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape circle",
      ),
    ).toHaveLength(1);
    await select("Event gateway type", "Parallel");
    expect(
      node("Event").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape line",
      ),
    ).toHaveLength(2);
    expect(
      node("Event").querySelectorAll(
        "svg.xyflow-react-kie-diagram--node-shape polygon",
      ),
    ).toHaveLength(1);
    const parallel = await snapshot();
    await act(async () => field("Instantiate process").click());
    expect((await snapshot()).xml).toBe(parallel.xml);
    expect(inspectBpmnSource(parallel.xml).status).toBe("accepted");
    await act(async () => ref.current!.undo());
    await act(async () => ref.current!.redo());
    expect((await snapshot()).xml).toBe(parallel.xml);
    await choose("Event");
    await act(async () => node("Event").focus());
    await act(async () =>
      node("Event").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      ),
    );
    expect(node("Event")).toBeNull();
    const deleted = await snapshot();
    expect(inspectBpmnSource(deleted.xml).status).toBe("accepted");
    await act(async () => ref.current!.undo());
    expect((await snapshot()).xml).toBe(parallel.xml);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("anchors native waypoint drags to current DI rather than the pointer coordinate origin", async () => {
  const { Waypoint } = await import("../xyflow/waypoints/Waypoints"),
    { WaypointActionsContextProvider } =
      await import("../xyflow/waypoints/WaypointActionsContext"),
    { XyFlowReactKieDiagramStoreApiContext } =
      await import("../xyflow/store/Store"),
    { repositionEdgeWaypoint } =
      await import("./mutations/repositionEdgeWaypoint");
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/flows-standard.bpmn",
      "utf8",
    ),
    store = createBpmnEditorStore(
      getMarshaller(xml).parser.parse(),
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
  store.setState((state) => {
    state.xyFlowReactKieDiagram.snapGrid.isEnabled = false;
  });
  const model = store.getState().bpmn.model,
    di =
      model.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
        "di:DiagramElement"
      ]!,
    index = di.findIndex((edge) => edge["@_bpmnElement"] === "Forward"),
    route = di[index];
  if (route.__$$element !== "bpmndi:BPMNEdge") throw new Error("Missing edge");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Drawing = () => {
    const model = useBpmnEditorStore((state) => state.bpmn.model),
      edge =
        model.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
          "di:DiagramElement"
        ]![index];
    if (edge.__$$element !== "bpmndi:BPMNEdge") throw new Error("Missing edge");
    return createElement(
      "svg",
      null,
      createElement(
        "g",
        null,
        createElement(Waypoint, {
          edgeId: "Forward",
          edgeIndex: index,
          index: 1,
          point: edge["di:waypoint"]![1],
          nextPoint: edge["di:waypoint"]![2],
          onDragStop: () => {},
        }),
      ),
    );
  };
  const move = async (startX: number, endX: number) => {
    await act(async () => {
      container.querySelector("circle")!.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          clientX: startX,
          clientY: 300,
          view: window,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: endX,
          clientY: 300,
          view: window,
        }),
      );
      window.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          clientX: endX,
          clientY: 300,
          view: window,
        }),
      );
    });
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          BpmnEditorStoreApiContext.Provider,
          { value: store },
          createElement(
            XyFlowReactKieDiagramStoreApiContext.Provider,
            { value: store },
            createElement(
              WaypointActionsContextProvider,
              {
                value: {
                  onWaypointAdded: () => {},
                  onWaypointDeleted: () => {},
                  onWaypointRepositioned: (args) =>
                    store.setState((state) =>
                      repositionEdgeWaypoint({
                        definitions: state.bpmn.model.definitions,
                        __readonly_edgeIndex: args.edgeIndex,
                        __readonly_waypointIndex: args.waypointIndex,
                        __readonly_waypoint: args.waypoint,
                      }),
                    ),
                },
              },
              createElement(Drawing),
            ),
          ),
        ),
      ),
    );
    // Happy DOM lacks SVGPoint.matrixTransform. This identity drawing isolates
    // D3's subject/delta contract; actual transformed geometry is browser evidence.
    Object.defineProperty(container.querySelector("svg"), "createSVGPoint", {
      value: () => {
        const point = {
          x: 0,
          y: 0,
          matrixTransform: () => ({ x: point.x, y: point.y }),
        };
        return point;
      },
    });
    const idle = store.getState();
    await move(100, 100);
    expect(store.getState()).toBe(idle);
    await move(100, 140);
    await move(140, 160);
    await act(async () =>
      container.querySelector("circle")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const after =
      store.getState().bpmn.model.definitions["bpmndi:BPMNDiagram"]![0][
        "bpmndi:BPMNPlane"
      ]!["di:DiagramElement"]![index];
    if (after.__$$element !== "bpmndi:BPMNEdge")
      throw new Error("Missing route");
    expect(after["di:waypoint"]).toEqual([
      route["di:waypoint"]![0],
      { "@_x": 711, "@_y": 130 },
      ...route["di:waypoint"]!.slice(2),
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("edits mounted sequence-flow conditions and reassigns source defaults without losing the prior edge", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/flows-standard.bpmn",
      "utf8",
    ),
    original = getMarshaller(xml).parser.parse();
  const { SequenceFlowProperties } =
      await import("./propertiesPanel/singleEdgeProperties/SequenceFlowProperties"),
    { SequenceFlowPath } = await import("./diagram/edges/EdgeSvgs"),
    { connectionElement, sequenceFlowNotation } =
      await import("./mutations/connection");
  const store = createBpmnEditorStore(
    original,
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const Fields = () => {
    const model = useBpmnEditorStore((state) => state.bpmn.model);
    const flow = connectionElement(model.definitions, "Conditional").element;
    if (flow.__$$element !== "sequenceFlow") throw new Error("Missing flow");
    return createElement(
      "div",
      null,
      createElement(SequenceFlowProperties, { sequenceFlow: flow }),
      createElement(
        "svg",
        null,
        ...["Conditional", "Default"].map((id) =>
          createElement(SequenceFlowPath, {
            key: id,
            id,
            flowKind: sequenceFlowNotation(model.definitions, id),
            d: "M 0 0 L 100 0",
          }),
        ),
      ),
    );
  };
  const edge = (id: string) =>
    container.querySelector<SVGPathElement>(`path[id="${id}"]`)!;
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const type = async (value: string) =>
    act(async () => {
      const input = field("Condition expression");
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                PendingEditsContext.Provider,
                { value: new PendingEdits() },
                createElement(
                  BpmnEditorContextProvider,
                  { model: original },
                  createElement(Fields),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    expect(edge("Conditional").getAttribute("marker-start")).toBe(
      "url(#bpmn-conditional-flow)",
    );
    expect(edge("Default").getAttribute("marker-start")).toBe(
      "url(#bpmn-default-flow)",
    );
    await type("reviewed");
    const edited = store.getState().bpmn.model;
    await act(async () => field("Default sequence flow").click());
    expect(store.getState().bpmn.model).toBe(edited);
    await type("");
    await act(async () => field("Default sequence flow").click());
    expect(edge("Conditional").getAttribute("marker-start")).toBe(
      "url(#bpmn-default-flow)",
    );
    expect(edge("Default").getAttribute("marker-start")).toBeNull();
    const xmlOut = getMarshaller(xml).builder.build(
        store.getState().bpmn.model,
      ),
      model = getMarshaller(xmlOut).parser.parse();
    expect(inspectBpmnSource(xmlOut).status).toBe("accepted");
    expect(model.definitions["bpmndi:BPMNDiagram"]).toEqual(
      original.definitions["bpmndi:BPMNDiagram"],
    );
    const process = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    expect(
      process.flowElement!.find((element) => element["@_id"] === "A"),
    ).toMatchObject({ "@_default": "tns:Conditional" });
    expect(
      process
        .flowElement!.filter(
          (element) => element.__$$element === "sequenceFlow",
        )
        .map((element) => element["@_id"]),
    ).toEqual(["Conditional", "Default", "Forward", "Reverse"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("keeps event-subprocess triggers, context guards and hidden contents coherent through the public editor", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/event-subprocess-standard.bpmn",
    "utf8",
  );
  const original = getMarshaller(xml).parser.parse();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const choose = async (id: string) => act(async () => node(id).click());
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === name,
    )!;
  const snapshot = async () => {
    let value!: BpmnSnapshot;
    await act(async () => {
      value = ref.current!.flush();
    });
    return value;
  };
  const key = async (id: string, key: string) =>
    act(async () =>
      container
        .querySelector<HTMLElement>(`[data-nodehref="${id}"]`)!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    );
  const renderEditor = (source: BpmnSourceRevision, readOnly = false) =>
    act(async () => {
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source,
              readOnly,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      );
    });
  const openNodeActions = (id: string) =>
    act(async () => {
      container
        .querySelector<HTMLElement>(`[data-nodehref="${id}"]`)!
        .dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "F10",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
    });
  const keyboardDialog = () =>
    document.querySelector<HTMLElement>(
      '[role="dialog"][data-myoxus-ui-role="settings-modal"][aria-label="Actions"]',
    );
  try {
    await renderEditor({ revision: "event-subprocess", xml });
    expect(node("CompensationWork")).toBeNull();
    expect(
      node("CompensationScope").querySelector(
        '[data-event-subprocess-trigger="compensateEventDefinition"]',
      ),
    ).not.toBeNull();
    await choose("EventScope");
    const duplicateBaseline = await snapshot();
    await act(async () =>
      node("EventScope").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "d",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const duplicated = await snapshot();
    expect(inspectBpmnSource(duplicated.xml).status).toBe("accepted");
    const duplicateModel = getMarshaller(duplicated.xml).parser.parse();
    const duplicateProcess = duplicateModel.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    )!;
    if (duplicateProcess.__$$element !== "process")
      throw new Error("Missing duplicate process");
    const copies = duplicateProcess.flowElement!.filter(
      (element) =>
        element.__$$element === "subProcess" &&
        element["@_name"] === "Message handler",
    );
    expect(copies).toHaveLength(2);
    const copiedScope = copies.find(
      (element) => element["@_id"] !== "EventScope",
    )!;
    if (copiedScope.__$$element !== "subProcess")
      throw new Error("Missing copied scope");
    const copiedIds = new Set(
      copiedScope.flowElement!.map((element) => element["@_id"]),
    );
    expect(copiedIds.has("Trigger")).toBe(false);
    for (const element of copiedScope.flowElement!)
      if (element.__$$element === "sequenceFlow") {
        expect(copiedIds.has(element["@_sourceRef"])).toBe(true);
        expect(copiedIds.has(element["@_targetRef"])).toBe(true);
      }
    await act(async () => ref.current!.undo());
    expect((await snapshot()).xml).toBe(duplicateBaseline.xml);
    await choose("Trigger");
    const before = await snapshot();
    const selected = node("Trigger");
    const actions = selected.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions"]',
    )!;
    await act(async () => {
      actions.focus();
      actions.click();
    });
    expect(
      selected.querySelector('[data-testid="Trigger-add-edge_sequenceFlow"]'),
    ).not.toBeNull();
    const keyboardOwner = selected.querySelector<HTMLElement>(
      '[data-nodehref="Trigger"]',
    )!;
    await act(async () =>
      keyboardOwner.dispatchEvent(new MouseEvent("mouseenter")),
    );
    await act(async () =>
      keyboardOwner.dispatchEvent(new MouseEvent("mouseleave")),
    );
    expect(document.activeElement).toBe(actions);
    await act(async () =>
      actions.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(actions.getAttribute("aria-expanded")).toBe("false");
    expect(
      selected.querySelector('[data-handleid="unique-source-handle"]'),
    ).not.toBeNull();
    expect((await snapshot()).xml).toBe(before.xml);
    await openNodeActions("Trigger");
    const actionDialog = keyboardDialog()!;
    const targetLabel = [
      ...actionDialog.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === "Semantic target reference")!;
    const targetField = document.getElementById(targetLabel.htmlFor)!;
    await act(async () => targetField.click());
    const targets = document.getElementById(
      targetField.getAttribute("aria-controls")!,
    )!;
    await act(async () =>
      [...targets.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === "EventEnd")!
        .click(),
    );
    await act(async () =>
      actionDialog
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    const keyboardModel = getMarshaller((await snapshot()).xml).parser.parse();
    const processWithKeyboardFlow = keyboardModel.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    )!;
    if (processWithKeyboardFlow.__$$element !== "process")
      throw new Error("Missing keyboard flow owner");
    const eventScope = processWithKeyboardFlow.flowElement!.find(
      (element) => element["@_id"] === "EventScope",
    );
    if (eventScope?.__$$element !== "subProcess")
      throw new Error("Missing keyboard flow scope");
    expect(eventScope.flowElement).toContainEqual(
      expect.objectContaining({
        __$$element: "sequenceFlow",
        "@_sourceRef": "Trigger",
        "@_targetRef": "EventEnd",
      }),
    );
    await act(async () => ref.current!.undo());
    expect((await snapshot()).xml).toBe(before.xml);
    await choose("Trigger");
    expect(button("Delete").disabled).toBe(false);
    await act(async () => button("Delete").click());
    expect((await snapshot()).xml).toBe(before.xml);
    expect(node("Trigger")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await key("Trigger", "4");
    expect((await snapshot()).xml).toBe(before.xml); // Error cannot retain a noninterrupting start.
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === "Interrupting")!;
    await act(async () => document.getElementById(label.htmlFor)!.click());
    await key("Trigger", "4");
    const edited = await snapshot();
    expect(inspectBpmnSource(edited.xml).status).toBe("accepted");
    await choose("EventScope");
    expect(button("Activity")).toBeUndefined();
    await act(async () => button("Collapse subprocess").click());
    expect(node("Trigger")).toBeNull();
    expect(
      node("EventScope").querySelector(
        '[data-event-subprocess-trigger="errorEventDefinition"]',
      ),
    ).not.toBeNull();
    const collapsed = await snapshot();
    expect(
      getMarshaller(collapsed.xml).parser.parse().definitions.rootElement,
    ).toEqual(getMarshaller(edited.xml).parser.parse().definitions.rootElement);
    await key("EventScope", "1");
    const normal = await snapshot(),
      model = getMarshaller(normal.xml).parser.parse();
    const process = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const scope = process.flowElement!.find((e) => e["@_id"] === "EventScope");
    if (
      scope?.__$$element !== "subProcess" ||
      scope.flowElement?.[0].__$$element !== "startEvent"
    )
      throw new Error("Missing scope/start");
    expect(scope["@_triggeredByEvent"]).toBeUndefined();
    expect(scope.flowElement[0].eventDefinition).toBeUndefined();
    expect(model.definitions["bpmndi:BPMNDiagram"]).toEqual(
      getMarshaller(collapsed.xml).parser.parse().definitions[
        "bpmndi:BPMNDiagram"
      ],
    );
    expect(
      model.definitions.rootElement!.filter(
        (root) => root.__$$element !== "process",
      ),
    ).toEqual(
      original.definitions.rootElement!.filter(
        (root) => root.__$$element !== "process",
      ),
    );
    await act(async () => ref.current!.undo());
    expect((await snapshot()).xml).toBe(collapsed.xml);
    const palette = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[draggable="true"]',
      ),
    ].find(
      (button) => button.getAttribute("aria-label") === "Event subprocess",
    )!;
    await act(async () => palette.click());
    const created = getMarshaller((await snapshot()).xml).parser.parse();
    const createdProcess = created.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (createdProcess?.__$$element !== "process")
      throw new Error("Missing process");
    const added = createdProcess.flowElement!.filter(
      (element) =>
        element.__$$element === "subProcess" && element["@_triggeredByEvent"],
    );
    expect(added).toHaveLength(3);
    expect(added.at(-1)).toMatchObject({
      flowElement: [
        {
          __$$element: "startEvent",
          eventDefinition: [{ __$$element: "messageEventDefinition" }],
        },
      ],
    });
    const committed = await snapshot();
    await renderEditor({ revision: committed.revision, xml: committed.xml });
    await choose("Host");
    await openNodeActions("Host");
    expect(keyboardDialog()).not.toBeNull();
    const resetSource = { revision: "keyboard-source-reset", xml };
    await renderEditor(resetSource);
    await vi.waitFor(() => expect(keyboardDialog()).toBeNull());
    expect((await snapshot()).xml).toBe(xml);
    await choose("Host");
    await openNodeActions("Host");
    expect(keyboardDialog()).not.toBeNull();
    await renderEditor(resetSource, true);
    await vi.waitFor(() => expect(keyboardDialog()).toBeNull());
    expect((await snapshot()).xml).toBe(xml);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors transaction fields and cancel notation while refusing lossy morphs before an explicit valid change", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/cancel-loop.bpmn",
    "utf8",
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const chooseNode = async (id: string) => act(async () => node(id).click());
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === name,
    )!;
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const type = (name: string, value: string) => {
    const input = field(name);
    Object.getOwnPropertyDescriptor(
      input.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    field(name).dispatchEvent(new Event("input", { bubbles: true }));
  };
  const shortcut = async (id: string, key: string) =>
    act(async () =>
      container
        .querySelector<HTMLElement>(`[data-nodehref="${id}"]`)!
        .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    );
  const snapshot = async () => {
    let value!: BpmnSnapshot;
    await act(async () => {
      value = ref.current!.flush();
    });
    return value;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "transaction", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    expect(
      node("Transaction_1").querySelectorAll(
        "rect.xyflow-react-kie-diagram--node-containerNode-visibleRect",
      ),
    ).toHaveLength(2);
    expect(
      node("Cancel_1")
        .querySelector('[data-event-symbol="cancel"]')
        ?.getAttribute("fill"),
    ).not.toBe("none");
    expect(
      node("Boundary_1")
        .querySelector('[data-event-symbol="cancel"]')
        ?.getAttribute("fill"),
    ).toBe("none");
    await chooseNode("Boundary_1");
    expect(field("Cancel attached activity").disabled).toBe(true);
    await chooseNode("Transaction_1");
    expect(field("Transaction method").value).toBe("");
    await act(async () => button("Data mapping (1)").click());
    const mappingDialog =
      document.querySelector<HTMLElement>('[role="dialog"]')!;
    const nameLabel = [
      ...mappingDialog.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === "Name")!;
    const mappingName = document.getElementById(
      nameLabel.htmlFor,
    ) as HTMLInputElement;
    expect(mappingName.value).toBe("Container request");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(mappingName, "Renamed transaction request");
      mappingName.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      mappingDialog
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await act(async () => type("Transaction method", "urn:myoxus:transaction"));
    await act(async () => button("Activity").click());
    const mode = field("Loop mode");
    await act(async () => mode.click());
    const list = document.getElementById(mode.getAttribute("aria-controls")!)!;
    await act(async () =>
      [...list.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === "Sequential")!
        .click(),
    );
    await act(async () => type("Loop cardinality expression", "3"));
    const edited = await snapshot();
    await act(async () => button("Collapse subprocess").click());
    expect(node("Task_1")).toBeNull();
    expect(node("Boundary_1")).not.toBeNull();
    const collapsed = await snapshot();
    const editedModel = getMarshaller(edited.xml).parser.parse(),
      collapsedModel = getMarshaller(collapsed.xml).parser.parse();
    expect(collapsedModel.definitions.rootElement).toEqual(
      editedModel.definitions.rootElement,
    );
    await shortcut("Transaction_1", "1");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect((await snapshot()).xml).toBe(collapsed.xml);
    await act(async () => button("Expand subprocess").click());
    await chooseNode("Cancel_1");
    await shortcut("Cancel_1", "1");
    await chooseNode("Boundary_1");
    await shortcut("Boundary_1", "3");
    await chooseNode("Transaction_1");
    const compatible = await snapshot(),
      expected = getMarshaller(compatible.xml).parser.parse();
    const process = expected.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (
      process?.__$$element !== "process" ||
      process.flowElement?.[0].__$$element !== "transaction"
    )
      throw new Error("Missing transaction");
    const originalTransaction = process.flowElement[0];
    expect(originalTransaction["@_method"]).toBe("urn:myoxus:transaction");
    expect(originalTransaction.ioSpecification).toEqual({
      "@_id": "TransactionIO",
      dataInput: [
        { "@_id": "TransactionInput", "@_name": "Renamed transaction request" },
      ],
      inputSet: [
        {
          "@_id": "TransactionInputs",
          dataInputRefs: [{ __$$text: "TransactionInput" }],
        },
      ],
      outputSet: [{ "@_id": "TransactionOutputs" }],
    });
    expect(originalTransaction.loopCharacteristics).toMatchObject({
      __$$element: "multiInstanceLoopCharacteristics",
      "@_isSequential": true,
      loopCardinality: { __$$text: "3" },
    });
    delete originalTransaction["@_method"];
    process.flowElement[0] = {
      ...originalTransaction,
      __$$element: "subProcess",
    };
    await shortcut("Transaction_1", "1");
    const changed = await snapshot();
    expect(getMarshaller(changed.xml).parser.parse()).toEqual(expected);
    expect(inspectBpmnSource(changed.xml).status).toBe("accepted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors multiple and shared event triggers through the public canvas while preserving interruption, link peers and DI", async () => {
  const raw = await readFile(
    "client/libs/bpmn-editor/src/fixtures/events-standard.bpmn",
    "utf8",
  );
  const marshaller = getMarshaller(raw),
    input = marshaller.parser.parse(),
    processInput = input.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
  if (processInput?.__$$element !== "process")
    throw new Error("Missing event fixture process");
  const nested = processInput.flowElement!.find(
    (node) => node.__$$element === "subProcess",
  );
  if (nested?.__$$element !== "subProcess")
    throw new Error("Missing nested fixture scope");
  const topBoundary = nested.flowElement!.find(
    (node) => node["@_id"] === "NestedBoundary",
  );
  if (topBoundary?.__$$element !== "boundaryEvent")
    throw new Error("Missing nested boundary");
  topBoundary["@_name"] = "Nested failure";
  const payloadCatch = processInput.flowElement!.find(
    (event) => event["@_id"] === "CatchTimer",
  );
  if (payloadCatch?.__$$element !== "intermediateCatchEvent")
    throw new Error("Missing paired payload owner");
  payloadCatch.dataOutput = [
    { "@_id": "TimerPayloadA", "@_name": "First timer payload" },
    { "@_id": "TimerPayloadB", "@_name": "Second timer payload" },
  ];
  const shapes =
      input.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
        "di:DiagramElement"
      ]!,
    topShape = shapes.find(
      (shape) => shape["@_bpmnElement"] === "NestedBoundary",
    ),
    authoredShape = shapes.find(
      (shape) => shape["@_bpmnElement"] === "Boundary",
    );
  if (
    topShape?.__$$element !== "bpmndi:BPMNShape" ||
    authoredShape?.__$$element !== "bpmndi:BPMNShape"
  )
    throw new Error("Missing boundary geometry");
  topShape["dc:Bounds"]["@_y"] = 572;
  authoredShape["bpmndi:BPMNLabel"] = {
    "dc:Bounds": { "@_x": 460, "@_y": 60, "@_width": 80, "@_height": 30 },
  };
  const authoredNodes = [
    "MultiStart",
    "CatchTimer",
    "ThrowMultiple",
    "End",
    "Host",
    "SubProcess",
  ];
  for (const id of authoredNodes) {
    const shape = shapes.find((shape) => shape["@_bpmnElement"] === id);
    const element = processInput.flowElement!.find(
      (element) => element["@_id"] === id,
    );
    if (shape?.__$$element !== "bpmndi:BPMNShape" || !element)
      throw new Error("Missing authored-label owner");
    element["@_name"] ||= id;
    shape["bpmndi:BPMNLabel"] = {
      "dc:Bounds": {
        "@_x": shape["dc:Bounds"]["@_x"] - 30,
        "@_y": shape["dc:Bounds"]["@_y"] - 50,
        "@_width": 140,
        "@_height": 30,
      },
    };
  }
  const xml = marshaller.builder.build(input);
  const original = getMarshaller(xml).parser.parse();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const fields = (label: string) =>
    [...container.querySelectorAll<HTMLLabelElement>("label")]
      .filter((element) => element.textContent === label)
      .map(
        (element) =>
          document.getElementById(element.htmlFor) as HTMLInputElement,
      );
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === label,
    )!;
  const select = async (label: string, value: string, index = 0) => {
    const input = fields(label)[index];
    await act(async () => input.click());
    const list = document.getElementById(input.getAttribute("aria-controls")!)!;
    const option = [
      ...list.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === value)!;
    await act(async () => option.click());
  };
  const node = (id: string) =>
    container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
  const chooseNode = async (id: string) => act(async () => node(id).click());
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "events", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    expect(
      node("MultiStart").querySelector(
        '[data-event-symbol="parallelMultiple"]',
      ),
    ).not.toBeNull();
    expect(
      node("ThrowMultiple")
        .querySelector('[data-event-symbol="multiple"]')
        ?.getAttribute("fill"),
    ).not.toBe("none");
    expect(
      node("NestedBoundary").querySelector(".outside-top")?.textContent,
    ).toBe("Nested failure");
    const authoredCaption = node("Boundary").querySelector<HTMLElement>(
      ".xyflow-react-kie-diagram--editable-node-name-input",
    )!;
    expect([
      authoredCaption.style.left,
      authoredCaption.style.top,
      authoredCaption.style.width,
      authoredCaption.style.height,
    ]).toEqual(["100px", "-76px", "80px", "30px"]);
    for (const id of authoredNodes) {
      const label = node(id).querySelector<HTMLElement>(
        ".xyflow-react-kie-diagram--editable-node-name-input",
      )!;
      expect([
        label.style.left,
        label.style.top,
        label.style.width,
        label.style.height,
      ]).toEqual(["-30px", "-50px", "140px", "30px"]);
    }
    await chooseNode("CatchTimer");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-nodehref="CatchTimer"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "F10",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    );
    const actionForm = document.querySelector<HTMLElement>(
      '[role="dialog"][data-myoxus-ui-role="settings-modal"][aria-label="Actions"]',
    )!;
    const chooseActionField = async (label: string, value: string) => {
      const controlLabel = [
        ...actionForm.querySelectorAll<HTMLLabelElement>("label"),
      ].find((element) => element.textContent === label)!;
      const control = document.getElementById(controlLabel.htmlFor)!;
      await act(async () => control.click());
      const list = document.getElementById(
        control.getAttribute("aria-controls")!,
      )!;
      await act(async () =>
        [...list.querySelectorAll<HTMLElement>('[role="option"]')]
          .find((option) => option.textContent === value)!
          .click(),
      );
    };
    await chooseActionField("Actions", "Data association");
    await chooseActionField(
      "Semantic target reference",
      "Boundary host (Host)",
    );
    await act(async () =>
      actionForm
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await vi.waitFor(() => expect(actionForm.isConnected).toBe(false));
    const payloadForm = document.querySelector<HTMLElement>(
      '[role="dialog"][data-myoxus-ui-role="settings-modal"][aria-label="Data association"]',
    )!;
    expect(payloadForm.contains(document.activeElement)).toBe(true);
    await act(async () =>
      [...payloadForm.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Cancel")!
        .click(),
    );
    let cancelled!: BpmnSnapshot;
    await act(async () => {
      cancelled = ref.current!.flush();
    });
    expect(cancelled.xml).toBe(xml);
    await chooseNode("MultiStart");
    await act(async () =>
      fields("Wait for all triggers (parallel multiple)")[0].click(),
    );
    expect(
      node("MultiStart").querySelector('[data-event-symbol="multiple"]'),
    ).not.toBeNull();
    await chooseNode("CatchTimer");
    await select("Definition reference", "SharedTimer", 1);
    await act(async () => button("Make definition reusable").click());
    await select("Definition reference", "Inline definition");
    await chooseNode("Boundary");
    expect(
      node("Boundary").querySelector("circle[stroke-dasharray]"),
    ).not.toBeNull();
    await act(async () => fields("Cancel attached activity")[0].click());
    expect(
      node("Boundary").querySelector("circle[stroke-dasharray]"),
    ).toBeNull();
    await chooseNode("LinkCatch");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(fields("Link")[0], "Reviewed");
      fields("Link")[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    await chooseNode("EndCompensation");
    expect(fields("Wait for compensation to finish")[0].checked).toBe(true);
    await act(async () => fields("Wait for compensation to finish")[0].click());
    let snapshot!: BpmnSnapshot;
    await act(async () => {
      snapshot = ref.current!.flush();
    });
    const result = inspectBpmnSource(snapshot.xml);
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error(result.error.code);
    const process = result.model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const events = process.flowElement!;
    expect(
      events.find((event) => event["@_id"] === "EndCompensation"),
    ).toMatchObject({
      eventDefinition: [
        { "@_waitForCompletion": false, "@_activityRef": "tns:Host" },
      ],
    });
    const repeated = events.find((event) => event["@_id"] === "CatchTimer");
    if (
      repeated?.__$$element !== "intermediateCatchEvent" ||
      repeated.eventDefinition?.[0].__$$element !== "timerEventDefinition"
    )
      throw new Error("Missing inlined timer");
    expect(repeated.eventDefinition[0]).toMatchObject({
      __$$element: "timerEventDefinition",
      timeDuration: {
        "@_xsi:type": "tFormalExpression",
        "@_language": "urn:timer",
        __$$text: "PT5M",
      },
    });
    expect(repeated.eventDefinition[0]["@_id"]).not.toBe("SharedTimer");
    expect(repeated.eventDefinition[0].timeDuration?.["@_id"]).not.toBe(
      "SharedExpression",
    );
    expect(repeated.eventDefinitionRef?.[0].__$$text).toBe("TimerA");
    expect(repeated.dataOutput).toEqual([
      payloadCatch.dataOutput![1],
      payloadCatch.dataOutput![0],
    ]);
    expect(
      result.model.definitions.rootElement!.find(
        (root) => root["@_id"] === "SharedTimer",
      ),
    ).toEqual(
      original.definitions.rootElement!.find(
        (root) => root["@_id"] === "SharedTimer",
      ),
    );
    expect(
      events
        .filter(
          (event) =>
            event["@_id"] === "LinkCatch" || event["@_id"] === "LinkThrow",
        )
        .map(
          (event) => "eventDefinition" in event && event.eventDefinition?.[0],
        ),
    ).toMatchObject([
      {
        "@_name": "Reviewed",
        source: [{ __$$text: "tns:ThrowLinkDefinition" }],
      },
      { "@_name": "Reviewed", target: { __$$text: "tns:CatchLinkDefinition" } },
    ]);
    expect(result.model.definitions["bpmndi:BPMNDiagram"]).toEqual(
      original.definitions["bpmndi:BPMNDiagram"],
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("edits each concrete event definition including repeated timers and a referenced root without rewriting adjacent data", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/globals-standard.bpmn",
    "utf8",
  );
  const model = getMarshaller(xml).parser.parse();
  model.definitions["@_xmlns:xsi"] =
    "http://www.w3.org/2001/XMLSchema-instance";
  const sharedDuration = {
    "@_id": "SharedDuration",
    "@_xsi:type": "tFormalExpression",
    "@_language": "urn:timer",
    __$$text: "PT5M",
  };
  model.definitions.rootElement!.push({
    "@_id": "SharedTimer",
    __$$element: "timerEventDefinition",
    timeDuration: sharedDuration,
  });
  const store = createBpmnEditorStore(
    model,
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  store.setState((state) => {
    const start = eventById(state.bpmn.model.definitions, "Start").event;
    start.eventDefinition = [
      {
        __$$element: "timerEventDefinition",
        timeDuration: { __$$text: "PT1M" },
      },
      {
        "@_id": "SecondTimer",
        __$$element: "timerEventDefinition",
        timeDuration: { "@_id": "SecondDuration", __$$text: "PT2M" },
      },
      {
        "@_id": "Condition",
        __$$element: "conditionalEventDefinition",
        condition: {
          "@_id": "EventExpression",
          "@_language": "urn:condition",
          "@_xsi:type": "tFormalExpression",
          __$$text: "ready",
        },
      },
    ] as typeof start.eventDefinition;
    start.eventDefinitionRef = [{ __$$text: "tns:SharedTimer" }];
  });
  const before = store.getState().bpmn.model;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const pending = new PendingEdits();
  const fields = (label: string) =>
    [...container.querySelectorAll<HTMLLabelElement>("label")]
      .filter((element) => element.textContent === label)
      .map(
        (element) =>
          document.getElementById(element.htmlFor) as HTMLInputElement,
      );
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      input.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                PendingEditsContext.Provider,
                { value: pending },
                createElement(
                  BpmnEditorContextProvider,
                  { model: before },
                  createElement(EventDefinitionProperties, {
                    event: eventById(before.definitions, "Start").event,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    const durations = fields("After a duration");
    expect(durations.map((input) => input.value)).toEqual([
      "PT1M",
      "PT2M",
      "PT5M",
    ]);
    await act(async () => type(durations[1], "PT7M"));
    await act(async () => type(fields("Condition expression")[0], "approved"));
    await act(async () => fields("Timer")[2].click());
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ]
      .filter((option) => option.textContent === "At a specific date")
      .at(-1)!;
    await act(async () => option.click());
    const expected = structuredClone(before);
    const start = eventById(expected.definitions, "Start").event;
    if (
      start.eventDefinition![1].__$$element !== "timerEventDefinition" ||
      start.eventDefinition![2].__$$element !== "conditionalEventDefinition"
    )
      throw new Error("Missing definitions");
    start.eventDefinition![1].timeDuration!.__$$text = "PT7M";
    start.eventDefinition![2].condition.__$$text = "approved";
    const shared = expected.definitions.rootElement!.find(
      (root) => root["@_id"] === "SharedTimer",
    );
    if (shared?.__$$element !== "timerEventDefinition")
      throw new Error("Missing shared timer");
    shared.timeDate = shared.timeDuration;
    delete shared.timeDuration;
    expect(store.getState().bpmn.model).toEqual(expected);
    expect(
      getMarshaller(getMarshaller(xml).builder.build(expected)).parser.parse(),
    ).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors ad-hoc controls and morphs the mounted subprocess without losing compatible loop or DI data", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    ref = createRef<BpmnEditorRef>();
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.textContent === name ||
        button.getAttribute("aria-label") === name,
    )!;
  const field = (name: string) => {
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === name)!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const type = (name: string, value: string) => {
    const input = field(name),
      prototype =
        input.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const choose = async (name: string, value: string) => {
    await act(async () => field(name).click());
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ]
      .filter((option) => option.textContent === value)
      .at(-1)!;
    await act(async () => option.click());
  };
  const snapshot = async () => {
    let value!: BpmnSnapshot;
    await act(async () => {
      value = ref.current!.flush();
    });
    return getMarshaller(value.xml).parser.parse();
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: {
                revision: "blank-ad-hoc",
                xml: createBlankBpmnSource(),
              },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    await act(async () => button("Ad-hoc subprocess").click());
    const before = await snapshot();
    const process = before.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const activity = process.flowElement![0];
    expect(activity).toMatchObject({ __$$element: "adHocSubProcess" });
    expect(activity).not.toHaveProperty("@_ordering");
    expect(activity).not.toHaveProperty("@_cancelRemainingInstances");
    const outer = () =>
      container.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${activity["@_id"]}"]`,
      )!;
    const glyph = () =>
      outer().querySelector(
        'svg.xyflow-react-kie-diagram--node-shape svg[viewBox="0 0 110.000000 44.000000"] path',
      );
    expect(glyph()).not.toBeNull();
    await choose("Activity ordering", "Sequential");
    await act(async () =>
      (field("Cancel remaining instances") as HTMLInputElement).click(),
    );
    await act(async () => type("Completion condition", "completed > 0"));
    await act(async () => button("Activity").click());
    await choose("Loop mode", "Sequential");
    await act(async () => type("Loop cardinality expression", "4"));
    const edited = await snapshot();
    const owner = edited.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (
      owner?.__$$element !== "process" ||
      owner.flowElement![0].__$$element !== "adHocSubProcess"
    )
      throw new Error("Missing ad-hoc owner");
    expect(owner.flowElement![0]).toMatchObject({
      "@_ordering": "Sequential",
      "@_cancelRemainingInstances": false,
      completionCondition: { __$$text: "completed > 0" },
      loopCharacteristics: {
        __$$element: "multiInstanceLoopCharacteristics",
        "@_isSequential": true,
        loopCardinality: { __$$text: "4" },
      },
    });
    const inner = container.querySelector<HTMLElement>(
      `[data-nodehref="${activity["@_id"]}"]`,
    )!;
    await act(async () =>
      inner.dispatchEvent(
        new KeyboardEvent("keydown", { key: "1", bubbles: true }),
      ),
    );
    const morphed = await snapshot();
    const expected = structuredClone(edited);
    const expectedProcess = expected.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (
      expectedProcess?.__$$element !== "process" ||
      expectedProcess.flowElement![0].__$$element !== "adHocSubProcess"
    )
      throw new Error("Missing expected owner");
    const element = expectedProcess.flowElement![0];
    delete element["@_ordering"];
    delete element["@_cancelRemainingInstances"];
    delete element.completionCondition;
    expectedProcess.flowElement![0] = { ...element, __$$element: "subProcess" };
    expect(morphed).toEqual(expected);
    expect(glyph()).toBeNull();
    expect(morphed.definitions["bpmndi:BPMNDiagram"]).toEqual(
      before.definitions["bpmndi:BPMNDiagram"],
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
const taskVariants = [
  ["task", "BPMN Task", "1"],
  ["userTask", "BPMN User Task", "2"],
  ["businessRuleTask", "BPMN Business Rule Task", "3"],
  ["serviceTask", "BPMN Service Task", "4"],
  ["scriptTask", "BPMN Script Task", "5"],
  ["manualTask", "BPMN Manual Task", "7"],
  ["sendTask", "BPMN Send Task", "8"],
  ["receiveTask", "BPMN Receive Task", "9"],
] as const;
it.each(taskVariants)(
  "creates and morphs %s through the mounted public editor without losing type, fields or geometry",
  async (kind, label, key) => {
    const container = document.createElement("div");
    document.body.append(container);
    const ref = createRef<BpmnEditorRef>();
    let root = createRoot(container);
    const render = (source: BpmnSourceRevision) =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source,
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      );
    const field = (label: string) => {
      const element = [
        ...container.querySelectorAll<HTMLLabelElement>("label"),
      ].find((value) => value.textContent === label);
      if (!element) throw new Error(`Missing field: ${label}`);
      return document.getElementById(element.htmlFor) as HTMLInputElement;
    };
    const type = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    try {
      await act(async () =>
        render({ revision: `blank-${kind}`, xml: createBlankBpmnSource() }),
      );
      const palette = [
        ...container.querySelectorAll<HTMLButtonElement>(
          "button[draggable=true]",
        ),
      ].find((value) => value.getAttribute("aria-label") === label);
      if (!palette) throw new Error(`Missing task choice: ${label}`);
      await act(async () => palette.click());
      let snapshot!: BpmnSnapshot;
      await act(async () => {
        snapshot = ref.current!.flush();
      });
      const before = getMarshaller(snapshot.xml).parser.parse();
      const process = before.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      );
      if (process?.__$$element !== "process")
        throw new Error("Missing process");
      const task = process.flowElement![0];
      expect(task.__$$element).toBe(kind);
      const node = () =>
        container.querySelector<HTMLDivElement>(
          `[data-nodehref="${task["@_id"]}"]`,
        )!;
      if (kind !== "task") {
        // Check the rendered symbol, not only an attribute repeating the type.
        expect(
          node().parentElement!.querySelector("svg svg, svg path, svg line"),
        ).not.toBeNull();
      }
      await act(async () => type(field("Name"), ""));
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === label,
        ),
      ).toBe(true);
      await act(async () => type(field("Name"), "Edited task"));
      if (kind === "scriptTask")
        await act(async () =>
          type(field("Script format"), "urn:fixture:script"),
        );
      if (
        [
          "userTask",
          "businessRuleTask",
          "serviceTask",
          "sendTask",
          "receiveTask",
        ].includes(kind)
      )
        await act(async () =>
          type(field("Implementation"), "urn:fixture:implementation"),
        );
      await act(async () => {
        snapshot = ref.current!.flush();
      });
      const edited = getMarshaller(snapshot.xml).parser.parse();
      const editedOwner = edited.definitions.rootElement!.find(
        (value) => value.__$$element === "process",
      );
      if (editedOwner?.__$$element !== "process")
        throw new Error("Missing edited process");
      if (kind === "scriptTask")
        expect(editedOwner.flowElement![0]).toMatchObject({
          "@_scriptFormat": "urn:fixture:script",
        });
      if (
        [
          "userTask",
          "businessRuleTask",
          "serviceTask",
          "sendTask",
          "receiveTask",
        ].includes(kind)
      )
        expect(editedOwner.flowElement![0]).toMatchObject({
          "@_implementation": "urn:fixture:implementation",
        });
      if (kind !== "task") {
        await act(async () =>
          node().dispatchEvent(
            new KeyboardEvent("keydown", { key: "1", bubbles: true }),
          ),
        );
        await act(async () => {
          snapshot = ref.current!.flush();
        });
        const generic = getMarshaller(snapshot.xml).parser.parse();
        expect(generic.definitions["bpmndi:BPMNDiagram"]).toEqual(
          before.definitions["bpmndi:BPMNDiagram"],
        );
        const owner = generic.definitions.rootElement!.find(
          (value) => value.__$$element === "process",
        );
        expect(
          owner?.__$$element === "process" && owner.flowElement![0].__$$element,
        ).toBe("task");
        await act(async () => ref.current!.undo());
        await act(async () => {
          snapshot = ref.current!.flush();
        });
        expect(getMarshaller(snapshot.xml).parser.parse()).toEqual(edited);
        await act(async () => ref.current!.redo());
        await act(async () =>
          node().dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
          ),
        );
        await act(async () => {
          snapshot = ref.current!.flush();
        });
      }
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => render(snapshot));
      expect(
        container.querySelectorAll(".react-flow__node-node_task"),
      ).toHaveLength(1);
      const reopened = getMarshaller(ref.current!.flush().xml).parser.parse();
      expect(reopened.definitions["bpmndi:BPMNDiagram"]).toEqual(
        before.definitions["bpmndi:BPMNDiagram"],
      );
      const owner = reopened.definitions.rootElement!.find(
        (value) => value.__$$element === "process",
      );
      expect(
        owner?.__$$element === "process" && owner.flowElement![0],
      ).toMatchObject({
        __$$element: kind,
        "@_name": "Edited task",
        "@_id": task["@_id"],
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
it("distinguishes unspecified execution metadata and requires explicit namespace confirmation before flush", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/globals-standard.bpmn",
    "utf8",
  );
  const store = createBpmnEditorStore(
    getMarshaller(xml).parser.parse(),
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  const pending = new PendingEdits();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const before = structuredClone(store.getState().bpmn.model);
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === name,
    )!;
  const field = (label: string) => {
    const element = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((element) => element.textContent === label)!;
    return document.getElementById(element.htmlFor) as HTMLInputElement;
  };
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                PendingEditsContext.Provider,
                { value: pending },
                createElement(GlobalProperties),
              ),
            ),
          ),
        ),
      ),
    );
    expect(store.getState().bpmn.model).toEqual(before);
    const executable = field("Executable");
    expect(executable.value).toBe("Not defined");
    await act(async () => executable.click());
    const no = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "No")!;
    await act(async () => no.click());
    const expected = structuredClone(before);
    const process = expected.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    process["@_isExecutable"] = false;
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Definitions").click());
    const namespace = field("Namespace");
    await act(async () => type(namespace, "urn:myoxus:confirmed"));
    await act(async () => {
      expect(pending.flush()).toBe(false);
    });
    expect(document.activeElement).toBe(namespace);
    await act(async () => button("Apply").click());
    await act(async () => button("Cancel").click());
    expect(namespace.value).toBe("urn:myoxus:confirmed");
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Apply").click());
    await act(async () => button("Confirm").click());
    expect(store.getState().bpmn.model.definitions["@_targetNamespace"]).toBe(
      "urn:myoxus:confirmed",
    );
    await act(async () => {
      expect(pending.flush()).toBe(true);
    });
    expect(pending.dirty).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
const { PropertiesManager } =
  await import("./propertiesPanel/propertiesManager/PropertiesManager");
const { ItemDefinitionRefSelector } =
  await import("./propertiesPanel/itemDefinitionRefSelector/ItemDefinitionRefSelector");
it("does not confuse an existing String declaration with the builtin creation choice", async () => {
  const xml = (
    await readFile(
      "client/libs/bpmn-editor/src/fixtures/definitions-references.bpmn",
      "utf8",
    )
  ).replace(
    '<message id="Message"',
    '<itemDefinition id="String" structureRef="tns:Custom"/><message id="Message"',
  );
  const store = createBpmnEditorStore(
    getMarshaller(xml).parser.parse(),
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const selected = vi.fn();
  function Selector() {
    const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
    return createElement(ItemDefinitionRefSelector, {
      value: "String",
      referenceOwner: definitions,
      onChange: selected,
    });
  }
  const before = structuredClone(store.getState().bpmn.model);
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(Selector),
            ),
          ),
        ),
      ),
    );
    const input =
      container.querySelector<HTMLInputElement>('[role="combobox"]')!;
    expect(input.value).toBe("tns:Custom");
    await act(async () => input.focus());
    const existing = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "tns:Custom")!;
    await act(async () => existing.click());
    expect(selected).toHaveBeenLastCalledWith("String", "tns:Custom");
    expect(store.getState().bpmn.model).toEqual(before);
    await act(async () => {
      input.blur();
      input.focus();
    });
    const builtin = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "String")!;
    await act(async () => builtin.click());
    const id = selected.mock.lastCall![0];
    expect(id).not.toBe("String");
    const definition = store
      .getState()
      .bpmn.model.definitions.rootElement!.find((root) => root["@_id"] === id);
    expect(definition).toMatchObject({
      __$$element: "itemDefinition",
      "@_structureRef": "xsd:string",
      "@_xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "tns:");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].some(
        (option) => option.textContent?.includes("Create"),
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("keeps partial type QNames in a field draft and commits only a validated type through flush", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/definitions-references.bpmn",
    "utf8",
  );
  const store = createBpmnEditorStore(
    getMarshaller(xml).parser.parse(),
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  const pending = new PendingEdits();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const before = structuredClone(store.getState().bpmn.model);
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                PendingEditsContext.Provider,
                { value: pending },
                createElement(PropertiesManager),
              ),
            ),
          ),
        ),
      ),
    );
    const declaration = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Payload")!;
    await act(async () => declaration.click());
    const label = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === "Data type")!;
    const input = document.getElementById(label.htmlFor) as HTMLInputElement;
    expect(input.value).toBe("tns:Payload");
    const type = (value: string) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => type("tns:"));
    expect(pending.dirty).toBe(true);
    await act(async () => {
      expect(pending.flush()).toBe(false);
    });
    expect(document.activeElement).toBe(input);
    expect(store.getState().bpmn.model).toEqual(before);
    await act(async () => type("tns:EditedPayload"));
    await act(async () => {
      expect(pending.flush()).toBe(true);
    });
    const expected = structuredClone(before);
    const item = expected.definitions.rootElement!.find(
      (root) => root.__$$element === "itemDefinition",
    );
    if (item?.__$$element !== "itemDefinition") throw new Error("Missing type");
    item["@_structureRef"] = "tns:EditedPayload";
    expect(store.getState().bpmn.model).toEqual(expected);
    expect(pending.dirty).toBe(false);
    await act(async () => type("unbound:"));
    await act(async () => pending.discard());
    expect(input.value).toBe("tns:EditedPayload");
    expect(store.getState().bpmn.model).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
const { CalledElementSelector } =
  await import("./propertiesPanel/calledElementSelector/CalledElementSelector");
const { ServiceTaskProperties } =
  await import("./propertiesPanel/singleNodeProperties/ServiceTaskProperties");
const { CallActivityProperties } =
  await import("./propertiesPanel/singleNodeProperties/CallActivityProperties");
it("authors global call targets through native controls, retains metadata and rejects hidden invalid identity drafts", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/global-tasks-standard.bpmn",
    "utf8",
  );
  const store = createBpmnEditorStore(
    getMarshaller(xml).parser.parse(),
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  const pending = new PendingEdits();
  function Properties() {
    const model = useBpmnEditorStore((state) => state.bpmn.model);
    const process = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    const call =
      process?.__$$element === "process" &&
      process.flowElement!.find((element) => element["@_id"] === "LocalA");
    if (!call || call.__$$element !== "callActivity")
      throw new Error("Missing call");
    return createElement(CallActivityProperties, { callActivity: call });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string, scope: ParentNode = container) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === name,
    )!;
  const field = (name: string, scope: ParentNode = container) => {
    const label = [...scope.querySelectorAll<HTMLLabelElement>("label")].find(
      (label) => label.textContent === name,
    )!;
    return document.getElementById(label.htmlFor) as HTMLInputElement;
  };
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                PendingEditsContext.Provider,
                { value: pending },
                createElement(Properties),
              ),
            ),
          ),
        ),
      ),
    );
    const ids = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].filter((label) => label.textContent === "Element ID");
    const id = document.getElementById(ids[1].htmlFor) as HTMLInputElement;
    const before = store.getState().bpmn.model;
    await act(async () => type(id, "GlobalUser"));
    await act(async () => button("Reusable work").click());
    await act(async () => button("Local A").click());
    await act(async () => expect(pending.flush()).toBe(false));
    expect(document.activeElement).toBe(id);
    expect(store.getState().bpmn.model).toBe(before);
    await act(async () => type(id, "RenamedGlobal"));
    await act(async () => expect(pending.flush()).toBe(true));
    const renamed = store.getState().bpmn.model;
    const process = renamed.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    expect(
      process
        .flowElement!.filter(
          (element) => element.__$$element === "callActivity",
        )
        .map((call) => call["@_calledElement"]),
    ).toEqual([
      "tns:RenamedGlobal",
      "local:RenamedGlobal",
      "RenamedGlobal",
      "ext:GlobalGeneric",
      "GlobalGeneric",
      "tns:GlobalUser",
      "tns:GlobalManual",
      "tns:GlobalScript",
      "tns:GlobalRules",
    ]);
    await act(async () =>
      store.setState((state) => state.dispatch(state).commitHistory()),
    );
    await act(async () => button("Delete").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    await act(async () => button("Delete", dialog).click());
    expect(
      store
        .getState()
        .bpmn.model.definitions.rootElement!.some(
          (root) => root["@_id"] === "RenamedGlobal",
        ),
    ).toBe(false);
    await act(async () =>
      store.setState((state) => state.dispatch(state).undo()),
    );
    expect(store.getState().bpmn.model).toBe(renamed);
    for (const [kind, title] of [
      ["globalTask", "Global task"],
      ["globalUserTask", "Global user task"],
      ["globalManualTask", "Global manual task"],
      ["globalScriptTask", "Global script task"],
      ["globalBusinessRuleTask", "Global business rule task"],
    ] as const) {
      await act(async () => button("Create").click());
      const modal = document.querySelector('[role="dialog"]')!;
      const typeSelect =
        modal.querySelector<HTMLInputElement>('[role="combobox"]')!;
      await act(async () => typeSelect.click());
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((option) => option.textContent === title)!;
      await act(async () => option.click());
      await act(async () => type(field("Name", modal), title));
      await act(async () => button("Create", modal).click());
      const model = store.getState().bpmn.model;
      const created = model.definitions.rootElement!.find(
        (root) => root.__$$element === kind && root["@_name"] === title,
      );
      expect(created).toMatchObject({ __$$element: kind });
      expect(model.definitions["bpmndi:BPMNDiagram"]).toEqual(
        before.definitions["bpmndi:BPMNDiagram"],
      );
      if (kind === "globalScriptTask")
        await act(async () => type(field("Script language"), "urn:script"));
      if (kind === "globalUserTask" || kind === "globalBusinessRuleTask")
        await act(async () =>
          type(field("Implementation"), "urn:implementation"),
        );
      const current = store.getState().bpmn.model;
      expect(
        getMarshaller(getMarshaller(xml).builder.build(current)).parser.parse(),
      ).toEqual(current);
      expect(
        container.querySelector<HTMLInputElement>(
          '[data-testid="called-element-selector"] input',
        )!.value,
      ).toBe(title);
    }
    // Exercise the consuming canvas as well: a marker subscription previously
    // indexed the old node-prop owner against the just-renamed scope tree.
    const ref = createRef<BpmnEditorRef>();
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source: { revision: "global-canvas", xml },
              readOnly: false,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
            }),
          ),
        ),
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>('.react-flow__node[data-id="User"]')!
        .click(),
    );
    const globalIdLabel = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].filter((label) => label.textContent === "Element ID")[1];
    const globalId = document.getElementById(
      globalIdLabel.htmlFor,
    ) as HTMLInputElement;
    await act(async () => type(globalId, "RenamedUser"));
    let snapshot!: BpmnSnapshot;
    await act(async () => {
      snapshot = ref.current!.flush();
    });
    expect(
      container.querySelectorAll(".react-flow__node-node_task"),
    ).toHaveLength(9);
    const current = getMarshaller(snapshot.xml).parser.parse();
    expect(
      current.definitions.rootElement!.some(
        (root) => root["@_id"] === "RenamedUser",
      ),
    ).toBe(true);
    const owner = current.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    expect(
      owner?.__$$element === "process" &&
        owner.flowElement!.find((element) => element["@_id"] === "User"),
    ).toMatchObject({ "@_calledElement": "tns:RenamedUser" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors I/O-set membership and evaluation order without orphaning slots or losing existing mappings", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/data-associations-standard.bpmn",
      "utf8",
    ),
    original = getMarshaller(xml).parser.parse(),
    store = createBpmnEditorStore(
      original,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
  const { InputOutputSets } =
      await import("./propertiesPanel/dataMapping/InputOutputSets"),
    { Accordion } = await import("@myoxus/ui-facade"),
    container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (name: string, scope: ParentNode = container) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === name,
    )!;
  const region = (name: string) =>
    document.getElementById(button(name).getAttribute("aria-controls")!)!;
  const field = (label: string, scope: ParentNode) => {
    const element = [...scope.querySelectorAll<HTMLLabelElement>("label")].find(
      (element) => element.textContent === label,
    )!;
    return document.getElementById(element.htmlFor) as HTMLInputElement;
  };
  const choose = async (label: string, name: string, scope: ParentNode) => {
    const input = field(label, scope);
    await act(async () => input.click());
    const list = document.getElementById(input.getAttribute("aria-controls")!)!;
    await act(async () =>
      [...list.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === name)!
        .click(),
    );
  };
  const task = (model: typeof original) => {
    const process = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const owner = process.flowElement!.find(
      (element) => element["@_id"] === "Review",
    );
    if (owner?.__$$element !== "task") throw new Error("Missing task");
    return owner;
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                Accordion,
                null,
                createElement(InputOutputSets, { ownerId: "Review" }),
              ),
            ),
          ),
        ),
      ),
    );
    await act(async () => button("Input/output sets").click());
    await act(async () => button("Inputs").click());
    await act(async () => button("Delete", region("Inputs")).click());
    expect(store.getState().bpmn.model).toEqual(original);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await choose("Optional inputs", "Order (In)", region("Inputs"));
    const optional = store.getState().bpmn.model;
    expect(
      task(optional).ioSpecification!.inputSet[0].optionalInputRefs,
    ).toEqual([{ __$$text: "In" }]);
    await choose("Inputs", "Order (In)", region("Inputs"));
    expect(store.getState().bpmn.model).toBe(optional);
    await act(async () => button("Add input set").click());
    const id = task(store.getState().bpmn.model).ioSpecification!.inputSet[1][
      "@_id"
    ]!;
    await act(async () => button(id).click());
    await choose("Inputs", "Order (In)", region(id));
    await choose("Output sets", "Outputs (Outputs)", region(id));
    await choose("Inputs", "Order (In)", region("Inputs"));
    const expected = structuredClone(original),
      expectedTask = task(expected),
      second = task(store.getState().bpmn.model).ioSpecification!.inputSet[1];
    expectedTask.ioSpecification!.inputSet[0].dataInputRefs = [
      { __$$text: "Contract" },
    ];
    expectedTask.ioSpecification!.inputSet.push({
      "@_id": id,
      dataInputRefs: [{ __$$text: "In" }],
      outputSetRefs: [{ __$$text: "Outputs" }],
    });
    expect(second).toEqual(expectedTask.ioSpecification!.inputSet[1]);
    await act(async () =>
      region(id)
        .querySelector<HTMLButtonElement>('button[aria-label="Move up"]')!
        .click(),
    );
    expectedTask.ioSpecification!.inputSet.reverse();
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Outputs").click());
    const before = store.getState().bpmn.model;
    await act(async () => button("Delete", region("Outputs")).click());
    expect(store.getState().bpmn.model).toBe(before);
    const built = getMarshaller(xml).builder.build(before);
    expect(inspectBpmnSource(built).status).toBe("accepted");
    expect(getMarshaller(built).parser.parse()).toEqual(before);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("authors shared resource definitions and process roles without dangling parameter consumers", async () => {
  const xml = await readFile(
      "client/libs/bpmn-editor/src/fixtures/globals-standard.bpmn",
      "utf8",
    ),
    model = getMarshaller(xml).parser.parse(),
    store = createBpmnEditorStore(
      model,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
  const { ResourceDefinitions } =
      await import("./propertiesPanel/resources/ResourceDefinitions"),
    { ResourceRoles } =
      await import("./propertiesPanel/resources/ResourceRoles"),
    { Accordion } = await import("@myoxus/ui-facade");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    original = store.getState().bpmn.model;
  const render = async (child: React.ReactNode) =>
    act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              child,
            ),
          ),
        ),
      ),
    );
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === name,
    )!;
  const type = async (
    input: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        input.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await render(createElement(ResourceDefinitions));
    await act(async () => button("Reviewer").click());
    await act(async () => button("Delete").click());
    expect(store.getState().bpmn.model).toBe(original);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "other references",
    );
    await act(async () => button("subject").click());
    await act(async () => button("Delete").click());
    expect(store.getState().bpmn.model).toBe(original);
    await type(
      [...container.querySelectorAll<HTMLInputElement>("input")].find(
        (input) => input.value === "Reviewer",
      )!,
      "Review team",
    );
    const edited = store.getState().bpmn.model,
      expected = structuredClone(original);
    const resource = expected.definitions.rootElement!.find(
      (root) => root.__$$element === "resource",
    )!;
    if (resource.__$$element !== "resource")
      throw new Error("Missing resource");
    resource["@_name"] = "Review team";
    expect(edited).toEqual(expected);
    await render(
      createElement(
        Accordion,
        null,
        createElement(ResourceRoles, { ownerId: "Process" }),
      ),
    );
    await act(async () => button("Resource roles").click());
    await act(async () => button("Create").click());
    await act(async () => button("Resource role").click());
    const field = [
        ...container.querySelectorAll<HTMLLabelElement>("label"),
      ].find((label) => label.textContent === "Resource")!,
      select = document.getElementById(field.htmlFor) as HTMLInputElement;
    await act(async () => select.click());
    const list = document.getElementById(
      select.getAttribute("aria-controls")!,
    )!;
    await act(async () =>
      [...list.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === "Review team (Reviewer)")!
        .click(),
    );
    await act(async () => button("Add parameter binding").click());
    await act(async () => button("subject").click());
    await type(
      [...container.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1)!,
      "processContext",
    );
    const authored = store.getState().bpmn.model,
      process = authored.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    expect(process.resourceRole![0]).toMatchObject({
      resourceRef: { __$$text: "Reviewer" },
      resourceParameterBinding: [
        {
          "@_parameterRef": "Parameter",
          expression: { __$$text: "processContext" },
        },
      ],
    });
    const { deleteResource } = await import("./mutations/resource");
    expect(() =>
      store.setState((state) => {
        deleteResource(state.bpmn.model.definitions, "Reviewer");
      }),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(store.getState().bpmn.model).toBe(authored);
    const built = getMarshaller(xml).builder.build(authored);
    expect(inspectBpmnSource(built).status).toBe("accepted");
    expect(getMarshaller(built).parser.parse()).toEqual(authored);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("edits standard I/O names and resource expressions without rewriting their unrepresented XML", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/tasks-standard.bpmn",
    "utf8",
  );
  const store = createBpmnEditorStore(
    getMarshaller(xml).parser.parse(),
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  const expected = structuredClone(store.getState().bpmn.model);
  const owner = expected.definitions.rootElement!.find(
    (root) => root.__$$element === "process",
  );
  if (owner?.__$$element !== "process") throw new Error("Missing process");
  const expectedTask = owner.flowElement!.find(
    (element) => element["@_id"] === "Task",
  );
  if (expectedTask?.__$$element !== "receiveTask")
    throw new Error("Missing task");
  function Properties() {
    const model = useBpmnEditorStore((state) => state.bpmn.model);
    const owner = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (owner?.__$$element !== "process") throw new Error("Missing process");
    const task = owner.flowElement!.find(
      (element) => element["@_id"] === "Task",
    );
    if (task?.__$$element !== "receiveTask") throw new Error("Missing task");
    return createElement(ServiceTaskProperties, { serviceTask: task });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const pending = new PendingEdits();
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === text,
    )!;
  const type = (
    input: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => {
    const prototype =
      input.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await act(async () =>
      root.render(
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(
              BpmnEditorStoreApiContext.Provider,
              { value: store },
              createElement(
                PendingEditsContext.Provider,
                { value: pending },
                createElement(Properties),
              ),
            ),
          ),
        ),
      ),
    );
    await act(async () => button("Data mapping (2)").click());
    const input = [
      ...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input'),
    ].find((input) => input.value === "Request")!;
    await act(async () => type(input, "Request value"));
    expect(input.checkValidity()).toBe(true);
    await act(async () => button("Save").click());
    expectedTask.ioSpecification!.dataInput![0]["@_name"] = "Request value";
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Resource roles").click());
    await act(async () => button("Performer").click());
    const expression = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ].find((input) => input.value === "reviewer")!;
    await act(async () => type(expression, "reviewer, backup"));
    const role = expectedTask.resourceRole!.find(
      (role) => role["@_id"] === "Performer",
    )!;
    role.resourceAssignmentExpression!.expression.__$$text = "reviewer, backup";
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Observer").click());
    const clear = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find(
      (button) => button.getAttribute("aria-label") === "Clear selection",
    )!;
    await act(async () => clear.click());
    delete expectedTask.resourceRole![0].resourceRef;
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Activity").click());
    const condition = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ].find((input) => input.value === "retry")!;
    await act(async () => type(condition, "retry && attempts < 4"));
    if (
      expectedTask.loopCharacteristics?.__$$element !==
      "standardLoopCharacteristics"
    )
      throw new Error("Missing standard loop");
    expectedTask.loopCharacteristics.loopCondition!.__$$text =
      "retry && attempts < 4";
    expect(store.getState().bpmn.model).toEqual(expected);
    const loopSelect = container.querySelector<HTMLInputElement>(
      '[aria-label="Loop mode"]',
    )!;
    await act(async () => loopSelect.click());
    const parallel = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "Parallel")!;
    await act(async () => parallel.click());
    expectedTask.loopCharacteristics = {
      "@_id": "Loop",
      __$$element: "multiInstanceLoopCharacteristics",
      "@_isSequential": false,
    };
    expect(store.getState().bpmn.model).toEqual(expected);
    await act(async () => button("Input collection").click());
    const itemLabel = [
      ...container.querySelectorAll<HTMLLabelElement>("label"),
    ].find((label) => label.textContent === "Data input")!;
    const itemName = document.getElementById(
      itemLabel.htmlFor,
    ) as HTMLInputElement;
    await act(async () => type(itemName, "Iteration item"));
    const actualProcess = store
      .getState()
      .bpmn.model.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      );
    const actualTask =
      actualProcess?.__$$element === "process" &&
      actualProcess.flowElement!.find((element) => element["@_id"] === "Task");
    if (
      !actualTask ||
      actualTask.__$$element !== "receiveTask" ||
      actualTask.loopCharacteristics?.__$$element !==
        "multiInstanceLoopCharacteristics"
    )
      throw new Error("Missing MI task");
    expectedTask.loopCharacteristics.inputDataItem = {
      "@_id": actualTask.loopCharacteristics.inputDataItem!["@_id"],
      "@_name": "Iteration item",
    };
    expect(store.getState().bpmn.model).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("shows declaration labels and keeps event/call references bound to their actual XML scopes", async () => {
  const xml = await readFile(
    "client/libs/bpmn-editor/src/fixtures/definitions-references.bpmn",
    "utf8",
  );
  const store = createBpmnEditorStore(
    getMarshaller(xml).parser.parse(),
    new ComputedStateCache<ReturnType<State["computed"]>>(
      INITIAL_COMPUTED_CACHE,
    ),
  );
  let eventId = "Start";
  function Properties() {
    const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
    const process = definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const event = process.flowElement!.find(
      (element) => element["@_id"] === eventId,
    );
    if (event?.__$$element === "callActivity")
      return createElement(CalledElementSelector, { element: event });
    if (event?.__$$element === "serviceTask")
      return createElement(ServiceTaskProperties, { serviceTask: event });
    if (
      !event ||
      (event.__$$element !== "startEvent" &&
        event.__$$element !== "intermediateCatchEvent" &&
        event.__$$element !== "endEvent" &&
        event.__$$element !== "boundaryEvent")
    )
      throw new Error("Missing event");
    return createElement(
      BpmnEditorContextProvider,
      { model: store.getState().bpmn.model },
      createElement(EventDefinitionProperties, { event }),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const before = structuredClone(store.getState().bpmn.model);
  const pending = new PendingEdits();
  const render = () =>
    root.render(
      createElement(
        MyoxusUIProvider,
        null,
        createElement(
          I18nextProvider,
          { i18n },
          createElement(
            BpmnEditorStoreApiContext.Provider,
            { value: store },
            createElement(
              PendingEditsContext.Provider,
              { value: pending },
              createElement(Properties),
            ),
          ),
        ),
      ),
    );
  try {
    for (const [id, label, field] of [
      ["Start", "Request", "Message"],
      ["Catch", "Notice", "Signal"],
      ["End", "Failure", "Error code"],
      ["Boundary", "Escalate", "Escalation code"],
    ]) {
      eventId = id;
      await act(async () => render());
      const input = container.querySelector<HTMLInputElement>(
        `input[aria-label="${field}"]`,
      )!;
      expect(input.value).toBe(label);
      await act(async () => input.focus());
      const option = [
        ...document.querySelectorAll<HTMLElement>('[role="option"]'),
      ].find((option) => option.textContent === label);
      expect(option).toBeDefined();
      await act(async () => option!.click());
      expect(input.value).toBe(label);
      expect(store.getState().bpmn.model).toEqual(before);
    }
    eventId = "Call";
    await act(async () => render());
    const call = container.querySelector<HTMLInputElement>(
      '[data-testid="called-element-selector"] input',
    )!;
    const type = (value: string) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(call, value);
      call.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => type("tns:"));
    await act(async () => {
      expect(pending.flush()).toBe(false);
    });
    expect(store.getState().bpmn.model).toEqual(before);
    expect(document.activeElement).toBe(call);
    await act(async () => type("tns:Task"));
    await act(async () => {
      expect(pending.flush()).toBe(false);
    });
    expect(store.getState().bpmn.model).toEqual(before);
    await act(async () => type("foreign:ExternalCallable"));
    await act(async () => {
      expect(pending.flush()).toBe(true);
    });
    const expected = structuredClone(before);
    const process = expected.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const activity = process.flowElement!.find(
      (element) => element.__$$element === "callActivity",
    );
    if (activity?.__$$element !== "callActivity")
      throw new Error("Missing call");
    activity["@_calledElement"] = "foreign:ExternalCallable";
    expect(store.getState().bpmn.model).toEqual(expected);
    eventId = "Service";
    await act(async () => render());
    const choices = [
      ...container.querySelectorAll<HTMLInputElement>('[role="combobox"]'),
    ].filter((input) =>
      ["Interface", "Operation"].includes(
        input.getAttribute("aria-label") ?? "",
      ),
    );
    expect(choices.map((input) => input.value)).toEqual(["Service", "Invoke"]);
    await act(async () => choices[1].focus());
    const operation = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === "Invoke")!;
    await act(async () => operation.click());
    expect(store.getState().bpmn.model).toEqual(expected);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
it("flushes the actual mounted command before debounce, preserves history on ACK and protects invalid field drafts", async () => {
  const ref = createRef<BpmnEditorRef>();
  const emissions: BpmnSnapshot[] = [];
  let readySnapshot: BpmnSnapshot | undefined;
  let readinessStatus: string | undefined;
  let state: BpmnCommandState | undefined;
  let source = { revision: "initial", xml: createBlankBpmnSource() };
  let readOnly = false;
  const container = document.createElement("div");
  container.style.fontSize = "14px";
  container.style.lineHeight = "21px";
  container.style.setProperty("--mantine-font-family", "sans-serif");
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  const originalBBox = Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    "getBBox",
  );
  const originalContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  const originalLanguage = i18n.language;
  document.body.append(container);
  let root = createRoot(container);
  const render = () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          MyoxusUIProvider,
          null,
          createElement(
            I18nextProvider,
            { i18n },
            createElement(BpmnEditor, {
              ref,
              source,
              readOnly,
              locale: "en",
              themeRoles: BPMN_THEME_ROLES,
              onSourceChange: (value) => emissions.push(value),
              onReadinessChange: (value) => {
                readinessStatus = value.status;
                if (value.status === "ready" && !readySnapshot)
                  readySnapshot = ref.current!.flush();
              },
              onCommandStateChange: (value) => {
                state = value;
              },
            }),
          ),
        ),
      ),
    );
  const button = (name: string) => {
    const value = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "button[draggable=true]",
      ),
    ].find((button) => button.getAttribute("aria-label") === name);
    if (!value) throw new Error(`Missing control: ${name}`);
    return value;
  };
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  try {
    await act(async () => render());
    expect(readySnapshot?.xml).toBe(source.xml);
    const canvas = container.querySelector<HTMLElement>(
      '[role="application"]',
    )!;
    expect(canvas.getAttribute("aria-label")).toBe(
      i18n.t("com.myoxus.editor.bpmn.default-title"),
    );
    expect(canvas.tabIndex).toBe(0);
    const dismissEmpty = container.querySelector<HTMLButtonElement>(
      '.react-flow__panel.top.center button[aria-label="Close"]',
    )!;
    await act(async () => dismissEmpty.click());
    expect(document.activeElement).toBe(canvas);
    expect(
      [...container.querySelectorAll("button[draggable=true]")].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual([
      "BPMN Start Event",
      "Intermediate catch event",
      "Intermediate throw event",
      "BPMN End Event",
      "BPMN Task",
      "BPMN User Task",
      "BPMN Manual Task",
      "BPMN Business Rule Task",
      "BPMN Service Task",
      "BPMN Script Task",
      "BPMN Send Task",
      "BPMN Receive Task",
      "BPMN Call Activity",
      "BPMN Sub-Process",
      "Ad-hoc subprocess",
      "Transaction",
      "Event subprocess",
      "Gateways",
      "BPMN Inclusive Gateway (OR)",
      "BPMN Parallel Gateway (AND)",
      "BPMN Event-Based Gateway",
      "BPMN Complex Gateway",
      "BPMN Lane",
      "BPMN Data Object",
      "Data object reference",
      "Data input",
      "Data output",
      "BPMN Data Store",
      "BPMN Group",
      "BPMN Annotation",
    ]);
    expect(state?.dirty).toBe(false);
    // Definitions are a real palette command, not a detached inspector-only
    // capability. Opening its native modal and changing tabs must be source-free.
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Definitions"]')!
        .click(),
    );
    const definitionsDialog =
      document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () =>
      [...definitionsDialog.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((tab) => tab.textContent === "Resource")!
        .click(),
    );
    expect(
      [...definitionsDialog.querySelectorAll("button")].some(
        (button) => button.textContent === "Create",
      ),
    ).toBe(true);
    await act(async () =>
      definitionsDialog
        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
        .click(),
    );
    expect(state?.dirty).toBe(false);
    await act(async () => button("BPMN Task").click());
    expect(state?.dirty).toBe(true);
    expect(emissions).toHaveLength(0);
    const nodeDescription = () =>
      document.getElementById(
        container
          .querySelector(".react-flow__node")!
          .getAttribute("aria-describedby")!,
      )!.textContent;
    await act(async () => {
      await i18n.changeLanguage("de");
    });
    expect(canvas.getAttribute("aria-label")).toBe("BPMN-Diagramm");
    expect(nodeDescription()).toBe(
      i18n.t("com.myoxus.editor.bpmn.keyboard-node"),
    );
    expect(container.querySelector('[role="application"]')).toBe(canvas);
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    let saved!: BpmnSnapshot;
    await act(async () => {
      saved = ref.current!.flush();
    });
    const model = getMarshaller(saved.xml).parser.parse();
    const process = model.definitions.rootElement?.find(
      (root) => root.__$$element === "process",
    );
    expect(
      process?.__$$element === "process" &&
        process.flowElement?.[0].__$$element,
    ).toBe("task");
    expect(
      model.definitions["bpmndi:BPMNDiagram"]?.[0]["bpmndi:BPMNPlane"][
        "di:DiagramElement"
      ],
    ).toHaveLength(1);
    expect(emissions).toHaveLength(1);
    source = saved;
    await act(async () => render());
    expect(state).toMatchObject({ dirty: false, canUndo: true });
    await act(async () => ref.current!.undo());
    let undone!: BpmnSnapshot;
    await act(async () => {
      undone = ref.current!.flush();
    });
    expect(undone.xml).not.toContain("<task ");
    await act(async () => ref.current!.redo());
    // Remount the exact saved source through the same guarded public entry.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(1);
    const importedXml =
      "\uFEFF" +
      source.xml
        .replace("<process", '<process name="Imported source"')
        .replaceAll("\n", "\r\n");
    let imported!: BpmnSnapshot;
    await act(async () => {
      imported = ref.current!.replaceSource(importedXml);
    });
    expect(imported.xml).toBe(importedXml);
    expect(state).toMatchObject({ dirty: true, canUndo: true });
    const beforeImport = source;
    source = imported;
    await act(async () => render());
    expect(state).toMatchObject({ dirty: false, canUndo: true });
    await act(async () => ref.current!.undo());
    expect(ref.current!.flush().xml).toBe(beforeImport.xml);
    // Replacing with the identical working source or rejecting a file cannot
    // erase Redo; only an actual accepted mutation creates the import boundary.
    await act(async () => ref.current!.replaceSource(beforeImport.xml));
    expect(() => ref.current!.replaceSource("<html/>")).toThrow(
      "BPMN_NOT_READY",
    );
    expect(state?.canRedo).toBe(true);
    await act(async () => ref.current!.redo());
    expect(ref.current!.flush().xml).toBe(importedXml);
    // The process ID is a draft-owning field. Invalid input must not turn Save
    // into a successful export of the previous accepted ID.
    const labels = [...container.querySelectorAll("label")];
    const idLabel = labels.find((label) => label.textContent === "Element ID");
    const idInput = document.getElementById(
      idLabel!.htmlFor,
    ) as HTMLInputElement;
    await act(async () => type(idInput, "invalid id"));
    expect(state).toMatchObject({ dirty: true, pendingFields: true });
    const panelClose = container.querySelector<HTMLButtonElement>(
      '[data-testid="kie-tools--bpmn-editor--properties-panel-container"] button[aria-label="Close"]',
    )!;
    await act(async () => panelClose.click());
    expect(state?.pendingFields).toBe(true);
    const panelInvoker = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Properties"]',
    )!;
    expect(document.activeElement).toBe(panelInvoker);
    expect(idInput.closest("[hidden]")).not.toBeNull();
    await act(async () => panelInvoker.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(panelClose));
    await act(async () => panelClose.click());
    await act(async () => {
      expect(() => ref.current!.flush()).toThrow("BPMN_PENDING_FIELD_INVALID");
    });
    expect(idInput.closest("[hidden]")).toBeNull();
    expect(idInput.value).toBe("invalid id");
    expect(document.activeElement).toBe(idInput);
    await act(async () => ref.current!.discard());
    const recoveryIdInput = document.getElementById(
      [...container.querySelectorAll("label")].find(
        (label) => label.textContent === "Element ID",
      )!.htmlFor,
    ) as HTMLInputElement;
    await act(async () => type(recoveryIdInput, "RecoveryProcess"));
    expect(state?.pendingFields).toBe(true);
    readOnly = true;
    await act(async () => render());
    expect(nodeDescription()).toBe(
      i18n.t("com.myoxus.editor.bpmn.keyboard-read-only"),
    );
    const recovered = ref.current!.flush().xml;
    expect(recovered).toContain('id="RecoveryProcess"');
    expect(recovered).toContain('bpmnElement="RecoveryProcess"');
    expect(state?.pendingFields).toBe(false);
    readOnly = false;
    await act(async () => render());
    await act(async () => button("BPMN Task").click());
    let before!: string;
    let candidate!: BpmnSnapshot;
    await act(async () => {
      candidate = ref.current!.flush();
      before = candidate.xml;
    });
    expect(state?.canUndo).toBe(true);
    readOnly = true;
    await act(async () => render());
    const deleteControl = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((control) => control.textContent?.trim() === "Delete")!;
    expect(deleteControl.disabled).toBe(true);
    await act(async () => deleteControl.click());
    expect(ref.current!.flush().xml).toBe(before);
    expect(() => ref.current!.replaceSource(createBlankBpmnSource())).toThrow(
      "BPMN_NOT_READY",
    );
    await act(async () => ref.current!.undo());
    expect(ref.current!.flush().xml).toBe(before);
    await act(async () => ref.current!.redo());
    expect(ref.current!.flush().xml).toBe(before);
    const replacement = {
      revision: "external-replacement",
      xml: createBlankBpmnSource(),
    };
    let fontsReady!: () => void;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        load: async () => [],
        ready: new Promise<void>((resolve) => {
          fontsReady = resolve;
        }),
      },
    });
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 100, height: 80 }),
    });
    // Happy DOM has no text rasterizer. This asserts async revision lifetime,
    // not font metrics; the downloaded SVG is measured in the actual browser.
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({
        font: "",
        measureText: (text: string) => ({ width: text.length }),
      }),
    });
    let inFlight!: ReturnType<BpmnEditorRef["exportSvg"]>;
    const canceled = new AbortController();
    let canceling!: ReturnType<BpmnEditorRef["exportSvg"]>;
    await act(async () => {
      canceling = ref.current!.exportSvg(canceled.signal);
    });
    const aborted = expect(canceling).rejects.toThrow("preview canceled");
    await act(async () => {
      canceled.abort(new Error("preview canceled"));
      await aborted;
    });
    await act(async () => {
      inFlight = ref.current!.exportSvg();
    });
    source = replacement;
    await act(async () => render());
    const stale = expect(inFlight).rejects.toThrow("BPMN_STALE_SNAPSHOT");
    await act(async () => {
      fontsReady();
      await stale;
    });
    source = candidate;
    await act(async () => render());
    expect(ref.current!.flush().xml).toBe(replacement.xml);
    readOnly = false;
    await act(async () => render());
    await act(async () => button("BPMN Task").click());
    const recoverable = ref.current!.flush();
    source = recoverable;
    await act(async () => render());
    const beforeFailureEmissions = emissions.length;
    const translate = i18n.t;
    const renderingFault = vi
      .spyOn(i18n, "t")
      .mockImplementation((key, ...args) => {
        if (key === "com.myoxus.editor.shape.bpmn.user-task")
          throw new Error("expected retained renderer failure");
        return Reflect.apply(translate, i18n, [key, ...args]);
      });
    try {
      await act(async () => {
        await i18n.changeLanguage("de");
      });
      expect(readinessStatus).toBe("render-error");
      expect(ref.current!.flush().xml).toBe(recoverable.xml);
      await expect(ref.current!.exportSvg()).rejects.toThrow("BPMN_NOT_READY");
    } finally {
      renderingFault.mockRestore();
    }
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Retry")!
        .click();
    });
    expect(readinessStatus).toBe("ready");
    expect(state).toMatchObject({ dirty: false, canUndo: true });
    expect(ref.current!.flush().xml).toBe(recoverable.xml);
    expect(emissions).toHaveLength(beforeFailureEmissions);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        load: async () => [],
        ready: new Promise<void>((resolve) => {
          fontsReady = resolve;
        }),
      },
    });
    await act(async () => {
      inFlight = ref.current!.exportSvg();
    });
    source = { revision: "invalid-remote", xml: "<html/>" };
    await act(async () => render());
    const rejectedSourceExport = expect(inFlight).rejects.toThrow(
      "BPMN_STALE_SNAPSHOT",
    );
    await act(async () => {
      fontsReady();
      await rejectedSourceExport;
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="BPMN Task"]',
      )!.disabled,
    ).toBe(true);
    expect(() => ref.current!.flush()).toThrow("BPMN_NOT_READY");
    const previousEmissions = emissions.length;
    await act(async () => ref.current!.undo());
    expect(emissions).toHaveLength(previousEmissions);
    // Re-admitting the exact pre-error bytes still has to reopen the gate.
    source = { ...recoverable, revision: "recovered-remote" };
    await act(async () => render());
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="BPMN Task"]',
      )!.disabled,
    ).toBe(false);
    expect(ref.current!.flush().xml).toBe(recoverable.xml);
  } finally {
    await act(async () => root.unmount());
    await i18n.changeLanguage(originalLanguage);
    container.remove();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
    if (originalBBox)
      Object.defineProperty(SVGElement.prototype, "getBBox", originalBBox);
    else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    if (originalContext)
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        "getContext",
        originalContext,
      );
    else Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
    vi.unstubAllGlobals();
  }
});
