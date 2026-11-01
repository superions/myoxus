// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  eventDefinitionFor,
  type EventDefinition,
  type EventDefinitionKind,
  type EventDefinitionTarget,
} from "../../mutations/event";
import type { Normalized } from "../../normalization/normalize";
import type { BPMN20__tDefinitions } from "../../../schemas/bpmn-2_0/ts-gen/types";

export type EventDefinitionProps = {
  eventId: string;
  target: EventDefinitionTarget;
};
type Definitions = Normalized<BPMN20__tDefinitions>;
type ConcreteDefinition<K extends EventDefinitionKind> = Normalized<
  Extract<EventDefinition, { __$$element: K }>
>;
type EventDefinitionBinding<K extends EventDefinitionKind> = {
  definition: ConcreteDefinition<K> | undefined;
  change: (
    action: (
      definition: ConcreteDefinition<K>,
      definitions: Definitions,
    ) => void,
  ) => void;
  readOnly: boolean;
  definitions: Definitions;
};

/** Every field edits the same concrete definition in the current snapshot,
 * including a shared root definition reached by eventDefinitionRef. */
export function useEventDefinition<K extends EventDefinitionKind>(
  { eventId, target }: EventDefinitionProps,
  kind: K,
): EventDefinitionBinding<K> {
  const store = useBpmnEditorStoreApi();
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  type Definition = ConcreteDefinition<K>;
  const current = eventDefinitionFor(definitions, eventId, target);
  const definition =
    current?.__$$element === kind ? (current as Definition) : undefined;
  const change = (
    action: (
      definition: Definition,
      definitions: Normalized<BPMN20__tDefinitions>,
    ) => void,
  ) =>
    store.setState((state) => {
      if (state.settings.isReadOnly) return;
      const current = eventDefinitionFor(
        state.bpmn.model.definitions,
        eventId,
        target,
      );
      if (current?.__$$element === kind)
        action(current as Definition, state.bpmn.model.definitions);
    });
  return { definition, change, readOnly, definitions };
}
