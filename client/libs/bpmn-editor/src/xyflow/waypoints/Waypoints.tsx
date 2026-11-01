/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus: React 19/XYFlow 12 and direct Facade integration; see provenance.json.

import { drag } from "d3-drag";
import { useI18n } from "@myoxus/i18n";
import { select } from "d3-selection";
import { type DC__Point } from "../maths/model";
import * as React from "react";
import { useEffect } from "react";
import {
  useXyFlowReactKieDiagramStore,
  useXyFlowReactKieDiagramStoreApi,
} from "../store/Store";
import "./Waypoints.css";
import { useWaypointsActions } from "./WaypointActionsContext";
import { snapPoint } from "../snapgrid/SnapGrid";

export function PotentialWaypoint(props: { point: { x: number; y: number } }) {
  return (
    <circle
      className={"xyflow-react-kie-diagram--edge-waypoint-potential"}
      r={5}
      cx={props.point.x}
      cy={props.point.y}
    />
  );
}

export function Waypoints(props: {
  edgeId: string;
  edgeIndex: number;
  waypoints: DC__Point[];
  onDragStop: (e: React.MouseEvent) => void;
  edgeRef: React.RefObject<SVGPathElement | null>;
}) {
  const { keyboardFocus } = useWaypointsActions();
  React.useLayoutEffect(() => {
    const pending = keyboardFocus?.current;
    if (!keyboardFocus || !pending || pending.edgeId !== props.edgeId) return;
    const active = document.activeElement;
    const owner =
      props.edgeRef.current?.closest<SVGElement>(".react-flow__edge");
    if (
      active !== document.body &&
      active !== pending.origin &&
      active !== owner
    ) {
      keyboardFocus.current = undefined;
      return;
    }
    const target =
      pending.index === null
        ? owner
        : owner?.querySelector<SVGElement>(
            `[data-waypointindex="${pending.index}"]`,
          );
    if (target) {
      keyboardFocus.current = undefined;
      target.focus();
    }
  }, [keyboardFocus, props.edgeId, props.edgeRef, props.waypoints]);
  return (
    <>
      {props.waypoints.slice(1, -1).map((p, i) => (
        <Waypoint
          onDragStop={props.onDragStop}
          key={i}
          edgeIndex={props.edgeIndex}
          edgeId={props.edgeId}
          point={p}
          nextPoint={props.waypoints[i + 2]}
          index={
            i +
            1 /* Plus one because we're removing the 1st element of the array before iterating */
          }
        />
      ))}
    </>
  );
}

export function Waypoint({
  edgeId,
  edgeIndex,
  index,
  point,
  nextPoint,
  onDragStop,
}: {
  edgeId: string;
  edgeIndex: number;
  index: number;
  point: DC__Point;
  nextPoint: DC__Point;
  onDragStop: (e: React.MouseEvent) => void;
}) {
  const t = useI18n();
  const numbers = new Intl.NumberFormat(t.language);
  const circleRef = React.useRef<SVGCircleElement>(null);
  const pointRef = React.useRef(point);
  pointRef.current = point;

  const xyFlowReactKieDiagramStoreApi = useXyFlowReactKieDiagramStoreApi();

  const {
    onWaypointAdded,
    onWaypointDeleted,
    onWaypointRepositioned,
    disabled,
  } = useWaypointsActions();

  const snapGrid = useXyFlowReactKieDiagramStore((s) => ({
    isEnabled: s.xyFlowReactKieDiagram.snapGrid.isEnabled,
    x: s.xyFlowReactKieDiagram.snapGrid.x / 2,
    y: s.xyFlowReactKieDiagram.snapGrid.y / 2,
  }));

  useEffect(() => {
    if (!circleRef.current) {
      return;
    }

    const selection = select(circleRef.current);
    let origin: {
      point: DC__Point;
      clientX: number;
      clientY: number;
      a: number;
      b: number;
      c: number;
      d: number;
    };
    let moved = false;
    const pointer = (event: MouseEvent | TouchEvent) =>
      "changedTouches" in event ? event.changedTouches[0] : event;
    const dragHandler = drag<SVGCircleElement, unknown>()
      .on("start", (e) => {
        moved = false;
        const native = pointer(e.sourceEvent);
        const matrix = circleRef.current!.getScreenCTM()?.inverse();
        // Freeze the screen-to-DI linear transform for the gesture. Native
        // pointer deltas keep stored DI independent of D3's container origin;
        // screen translation must not become a persisted waypoint displacement.
        origin = {
          point: { ...pointRef.current },
          clientX: native.clientX,
          clientY: native.clientY,
          a: matrix?.a ?? 1,
          b: matrix?.b ?? 0,
          c: matrix?.c ?? 0,
          d: matrix?.d ?? 1,
        };
      })
      .on("drag", (e) => {
        const native = pointer(e.sourceEvent),
          dx = native.clientX - origin.clientX,
          dy = native.clientY - origin.clientY;
        if (!moved && dx === 0 && dy === 0) return;
        // A click is not yet a drag. Toggling the renderer's drag status on
        // mousedown remounts RF's edge target before mouseup, preventing the
        // browser from ever producing the native double-click used to delete.
        if (!moved) {
          moved = true;
          xyFlowReactKieDiagramStoreApi.setState((state) =>
            state
              .dispatch(state)
              .setEdgeStatus(edgeId, { draggingWaypoint: true }),
          );
        }
        onWaypointRepositioned({
          edgeIndex,
          waypointIndex: index,
          waypoint: snapPoint(snapGrid, {
            "@_x": origin.point["@_x"] + origin.a * dx + origin.c * dy,
            "@_y": origin.point["@_y"] + origin.b * dx + origin.d * dy,
          }),
        });
      })
      .on("end", (e) => {
        if (!moved) return;
        onDragStop(e);
        xyFlowReactKieDiagramStoreApi.setState((state) =>
          state
            .dispatch(state)
            .setEdgeStatus(edgeId, { draggingWaypoint: false }),
        );
      });

    selection.call(dragHandler);
    return () => {
      // Remove only this waypoint's D3 bindings, never another editor's listeners.
      selection.on(".drag", null);
    };
  }, [
    edgeId,
    edgeIndex,
    index,
    onDragStop,
    onWaypointRepositioned,
    snapGrid,
    xyFlowReactKieDiagramStoreApi,
  ]);

  return (
    <circle
      data-waypointindex={index}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      role="group"
      aria-label={t["com.myoxus.editor.bpmn.position"]({
        x: numbers.format(point["@_x"]),
        y: numbers.format(point["@_y"]),
      })}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Insert Delete Backspace"
      ref={circleRef}
      className={"xyflow-react-kie-diagram--diagram-edge-waypoint"}
      cx={point["@_x"]}
      cy={point["@_y"]}
      r={1}
      onKeyDown={(event) => {
        if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
        const directions: Record<string, { x: number; y: number }> = {
          ArrowLeft: { x: -1, y: 0 },
          ArrowRight: { x: 1, y: 0 },
          ArrowUp: { x: 0, y: -1 },
          ArrowDown: { x: 0, y: 1 },
        };
        const direction = directions[event.key];
        if (
          !direction &&
          !["Delete", "Backspace", "Insert"].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        // Keyboard deltas are DI units, not screen pixels. Use the same
        // half-grid step/command as pointer dragging, without a gesture draft.
        if (direction)
          onWaypointRepositioned({
            edgeIndex,
            waypointIndex: index,
            waypoint: {
              ...point,
              "@_x":
                point["@_x"] +
                direction.x * (snapGrid.isEnabled ? snapGrid.x : 1),
              "@_y":
                point["@_y"] +
                direction.y * (snapGrid.isEnabled ? snapGrid.y : 1),
            },
          });
        else if (event.key === "Insert")
          onWaypointAdded({
            edgeIndex,
            beforeIndex: index + 1,
            waypoint: {
              "@_x": (point["@_x"] + nextPoint["@_x"]) / 2,
              "@_y": (point["@_y"] + nextPoint["@_y"]) / 2,
            },
          });
        else {
          // Restore a durable focus owner before this circle unmounts. Delete
          // belongs to this point, never the selected edge's global shortcut.
          (
            circleRef.current?.closest(".react-flow__edge") as SVGElement | null
          )?.focus();
          onWaypointDeleted({ edgeIndex, waypointIndex: index });
        }
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();

        onWaypointDeleted({
          edgeIndex,
          waypointIndex: index,
        });
      }}
    />
  );
}
