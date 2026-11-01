import {
  type SurfaceBlockModel,
  type SurfaceMiddleware,
  surfaceMiddlewareExtension,
} from "@virgultum/block-surface";
import type { ConnectorElementModel } from "@virgultum/model";
import type { GfxModel } from "@virgultum/std/gfx";

import { ConnectorPathGenerator } from "./connector-manager";

export const connectorWatcher: SurfaceMiddleware = (
  surface: SurfaceBlockModel,
) => {
  const hasElementById = (id: string) =>
    surface.hasElementById(id) || surface.store.hasBlock(id);
  const elementGetter = (id: string) =>
    surface.getElementById(id) ?? (surface.store.getModelById(id) as GfxModel);
  // Routing dependencies must not enter getConnectors: deleting an obstacle
  // is not permission to delete relationships whose endpoints are elsewhere.
  const dependents = new Map<string, Set<ConnectorElementModel>>();
  const dependencies = new Map<ConnectorElementModel, readonly string[]>();
  const removeDependencies = (connector: ConnectorElementModel) => {
    for (const id of dependencies.get(connector) ?? []) {
      const set = dependents.get(id);
      set?.delete(connector);
      if (!set?.size) dependents.delete(id);
    }
    dependencies.delete(connector);
  };
  const indexDependencies = (connector: ConnectorElementModel) => {
    // Source-owned Mermaid labels are renderer geometry. Rebuilding a path
    // during hydration or readonly navigation must not modify the document.
    // Their measured dimensions are refreshed by the owning appearance port.
    if (connector.yMap.has("mermaidEdgeId")) connector.stash("labelXYWH");
    removeDependencies(connector);
    const ids = [
      ...(connector.routingObstacleIds ?? []),
      ...(connector.labelObstacleIds ?? []),
      ...Object.keys(connector.routingObstacleRegions ?? {}),
    ];
    dependencies.set(connector, ids);
    for (const id of ids) {
      const set = dependents.get(id) ?? new Set();
      set.add(connector);
      dependents.set(id, set);
    }
  };
  const updateConnectorPath = (connector: ConnectorElementModel) => {
    if (
      ((connector.source?.id && hasElementById(connector.source.id)) ||
        (!connector.source?.id && connector.source?.position)) &&
      ((connector.target?.id && hasElementById(connector.target.id)) ||
        (!connector.target?.id && connector.target?.position))
    ) {
      // Path and path-attached label bounds are derived from endpoint geometry.
      // The queued refresh also runs after Undo; capturing it would add a new
      // history entry and discard Redo for the gesture that changed endpoints.
      // Explicit label/endpoint edits retain their own captured transaction.
      surface.store.transact(
        () => ConnectorPathGenerator.updatePath(connector, null, elementGetter),
        false,
      );
    }
  };
  const pendingList = new Set<ConnectorElementModel>();
  let pendingFlag = false;
  const addToUpdateList = (connector: ConnectorElementModel) => {
    pendingList.add(connector);

    if (!pendingFlag) {
      pendingFlag = true;
      queueMicrotask(() => {
        pendingList.forEach(updateConnectorPath);
        pendingList.clear();
        pendingFlag = false;
      });
    }
  };

  const disposables = [
    surface.elementAdded.subscribe(({ id }) => {
      const element = elementGetter(id);

      if (!element) return;

      if ("type" in element && element.type === "connector") {
        indexDependencies(element as ConnectorElementModel);
        addToUpdateList(element as ConnectorElementModel);
      } else {
        surface.getConnectors(id).forEach(addToUpdateList);
        dependents.get(id)?.forEach(addToUpdateList);
      }
    }),
    surface.elementUpdated.subscribe(({ id, props }) => {
      const element = elementGetter(id);

      if (
        props["xywh"] ||
        props["rotate"] ||
        props["path"] ||
        props["labelXYWH"]
      ) {
        surface.getConnectors(id).forEach(addToUpdateList);
        dependents.get(id)?.forEach(addToUpdateList);
      }

      if (
        "type" in element &&
        element.type === "connector" &&
        (props["mode"] !== undefined ||
          props["target"] ||
          props["source"] ||
          props["routingObstacleIds"] ||
          props["labelObstacleIds"] ||
          props["routingObstacleRegions"] ||
          props["routingClearance"] !== undefined ||
          props["routingLaneOffset"] !== undefined)
      ) {
        indexDependencies(element as ConnectorElementModel);
        addToUpdateList(element as ConnectorElementModel);
      }
    }),
    surface.elementRemoved.subscribe(({ id }) => {
      for (const connector of dependencies.keys()) {
        if (connector.id === id) {
          removeDependencies(connector);
          pendingList.delete(connector);
          break;
        }
      }
      dependents.get(id)?.forEach(addToUpdateList);
    }),
    surface.store.slots.blockUpdated.subscribe((payload) => {
      if (
        payload.type === "add" ||
        (payload.type === "update" && payload.props.key === "xywh")
      ) {
        surface.getConnectors(payload.id).forEach(addToUpdateList);
      }
    }),
  ];

  surface.getElementsByType("connector").forEach((connector) => {
    indexDependencies(connector as ConnectorElementModel);
    updateConnectorPath(connector as ConnectorElementModel);
  });

  return () => {
    pendingFlag = false;
    pendingList.clear();
    dependencies.clear();
    dependents.clear();
    disposables.forEach((d) => d.unsubscribe());
  };
};

export const connectorWatcherExtension = surfaceMiddlewareExtension(
  "connector-watcher",
  connectorWatcher,
);
