// SPDX-License-Identifier: AGPL-3.0-or-later

import { Checkbox, MyoxusTextarea, Select, Stack } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditor } from "../../BpmnEditorContext";
import {
  findConnectionElement,
  setGatewayMarkerVisible,
  setGatewayProperties,
} from "../../mutations/connection";
import { canOwnDefault, isGateway } from "../../mutations/connection-context";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { DefaultRouteSelector } from "../defaultRouteSelector/DefaultRouteSelector";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";

/** Semantic gateway fields shared by the retained five concrete owners. No
 * inferred direction/default is persisted merely by opening the inspector. */
export function GatewayPropertiesFields({
  gateway,
}: {
  gateway: { "@_id": string };
}) {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    { onCommandError } = useBpmnEditor();
  const definitions = useBpmnEditorStore(
      (state) => state.bpmn.model.definitions,
    ),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const current = findConnectionElement(definitions, gateway["@_id"])?.element;
  if (!current || !isGateway(current)) return null;
  const change = (value: Parameters<typeof setGatewayProperties>[2]) => {
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          setGatewayProperties(
            state.bpmn.model.definitions,
            gateway["@_id"],
            value,
          );
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  const directions = [
    { value: "Unspecified", label: t["com.myoxus.editor.bpmn.undefined"]() },
    {
      value: "Converging",
      label: t["com.myoxus.editor.bpmn.direction-converging"](),
    },
    {
      value: "Diverging",
      label: t["com.myoxus.editor.bpmn.direction-diverging"](),
    },
    { value: "Mixed", label: t["com.myoxus.editor.bpmn.direction-mixed"]() },
  ] as const;
  const references = indexBpmnIds(definitions),
    { diagramElements } = addOrGetProcessAndDiagramElements({ definitions }),
    shape = diagramElements.find(
      (shape) =>
        shape.__$$element === "bpmndi:BPMNShape" &&
        references.resolveReference(shape, shape["@_bpmnElement"]) ===
          gateway["@_id"],
    );
  return (
    <Stack>
      <Select
        label={t["com.myoxus.editor.bpmn.gateway-direction"]()}
        value={current["@_gatewayDirection"] ?? "Unspecified"}
        data={[...directions]}
        disabled={readOnly}
        onChange={(value) => {
          const direction = directions.find(
            (direction) => direction.value === value,
          );
          if (direction) change({ direction: direction.value });
        }}
      />
      {canOwnDefault(current) && <DefaultRouteSelector gateway={gateway} />}
      {current.__$$element === "exclusiveGateway" && (
        <Checkbox
          label={t["com.myoxus.editor.bpmn.show-gateway-marker"]()}
          checked={
            shape?.__$$element === "bpmndi:BPMNShape" &&
            shape["@_isMarkerVisible"] === true
          }
          disabled={readOnly}
          onChange={(_event, checked) => {
            try {
              store.setState((state) => {
                if (!state.settings.isReadOnly)
                  setGatewayMarkerVisible(
                    state.bpmn.model.definitions,
                    gateway["@_id"],
                    checked,
                  );
              });
            } catch (error) {
              onCommandError(error);
            }
          }}
        />
      )}
      {current.__$$element === "complexGateway" && (
        <MyoxusTextarea
          label={t["com.myoxus.editor.bpmn.activation-condition"]()}
          value={current.activationCondition?.__$$text ?? ""}
          disabled={readOnly}
          onChange={(value) => change({ activationCondition: value })}
        />
      )}
      {current.__$$element === "eventBasedGateway" && (
        <>
          <Checkbox
            label={t["com.myoxus.editor.bpmn.instantiate"]()}
            checked={current["@_instantiate"] ?? false}
            disabled={readOnly}
            onChange={(_event, checked) => change({ instantiate: checked })}
          />
          <Select
            label={t["com.myoxus.editor.bpmn.event-gateway-type"]()}
            value={current["@_eventGatewayType"] ?? "Exclusive"}
            disabled={readOnly}
            data={[
              {
                value: "Exclusive",
                label: t["com.myoxus.editor.bpmn.event-gateway-exclusive"](),
              },
              {
                value: "Parallel",
                label: t["com.myoxus.editor.bpmn.parallel"](),
              },
            ]}
            onChange={(value) => {
              if (value === "Exclusive" || value === "Parallel")
                change({ eventGatewayType: value });
            }}
          />
        </>
      )}
    </Stack>
  );
}
