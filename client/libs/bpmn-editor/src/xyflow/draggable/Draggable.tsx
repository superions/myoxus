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

import * as React from "react";
import {
  useState,
  useCallback,
  useContext,
  useMemo,
  useLayoutEffect,
} from "react";
import { useI18n } from "@myoxus/i18n";
import { DragHandle, Group } from "@myoxus/ui-facade";
import { generateUuid } from "../uuid/uuid";

export interface DraggableStateContext {
  source: number;
  dest: number;
  dragging: boolean;
  origin: number;
  leftOrigin: boolean;
}

export interface DraggableDispatchContext {
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>, index: number) => void;
  onDragEnd: (index: number) => void;
  onDragEnter: (index: number) => void;
  onDragLeave: (index: number) => void;
}

export const DraggableStateContext = React.createContext<DraggableStateContext>(
  {} as any,
);
export const DraggableDispatchContext =
  React.createContext<DraggableDispatchContext>({} as any);
export const DraggableItemContext = React.createContext<{ hovered: boolean }>(
  {} as any,
);

export function useDraggableStateContext() {
  return useContext(DraggableStateContext);
}

export function useDraggableDispatchContext() {
  return useContext(DraggableDispatchContext);
}

export function useDraggableItemContext() {
  return useContext(DraggableItemContext);
}

export type DraggableReorderFunction = (source: number, dest: number) => void;

export function DragAndDrop({
  reorder,
  onDragEnd,
  values,
  draggableItem,
  isDisabled,
}: {
  reorder: DraggableReorderFunction;
  onDragEnd?: (source: number, dest: number) => void;
  values?: any[];
  draggableItem?: (value: any, index: number) => React.ReactNode;
  isDisabled: boolean;
}) {
  const [source, setSource] = useState<number>(-1);
  const [dest, setDest] = useState<number>(-1);
  const [dragging, setDragging] = useState<boolean>(false);
  const [origin, setOrigin] = useState<number>(-1);
  const [leftOrigin, setLeftOrigin] = useState<boolean>(false);
  const [valuesCopy, setValuesCopy] = useState(values ?? []);
  const [valuesKeys, setValuesKeys] = useState(
    (values ?? [])?.map((_) => generateUuid()),
  );

  useLayoutEffect(() => {
    setValuesCopy((prev) => {
      if (values?.length !== prev.length) {
        setValuesKeys((values ?? [])?.map((_) => generateUuid()));
      }
      return values ?? [];
    });
  }, [values, isDisabled]);

  const onInternalDragStart = useCallback(
    (index: number) => {
      if (isDisabled) {
        return;
      }
      setDragging(true);
      setSource(index);
      setOrigin(index);
      setLeftOrigin(false);
    },
    [isDisabled],
  );

  const onInternalDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, index: number) => {
      if (isDisabled) {
        return;
      }
      e.preventDefault();
      setDest(index);
    },
    [isDisabled],
  );

  const onInternalDragEnd = useCallback(
    (_index: number) => {
      if (isDisabled) {
        return;
      }
      onDragEnd?.(origin, dest);
      setDragging(false);
      setSource(-1);
      setDest(-1);
      setOrigin(-1);
      setLeftOrigin(false);
    },
    [dest, onDragEnd, origin, isDisabled],
  );

  const onInternalReorder = useCallback(
    (source: number, dest: number) => {
      if (isDisabled) {
        return;
      }
      setValuesCopy((prev) => {
        const reordenedValues = [...prev];
        const [removedValue] = reordenedValues.splice(source, 1);
        reordenedValues.splice(dest, 0, removedValue);
        return reordenedValues;
      });
      setValuesKeys((prev) => {
        const reordenedKeys = [...prev];
        const [removedKeys] = reordenedKeys.splice(source, 1);
        reordenedKeys.splice(dest, 0, removedKeys);
        return reordenedKeys;
      });
    },
    [isDisabled],
  );

  const onInternalDragEnter = useCallback(
    (index: number) => {
      if (isDisabled) {
        return;
      }
      if (index === dest && index !== source) {
        reorder(source, dest);
        onInternalReorder(source, dest);
        setSource(dest);
        setDest(source);
      }
    },
    [dest, reorder, source, onInternalReorder, isDisabled],
  );

  const onInternalDragLeave = useCallback(
    (index: number) => {
      if (isDisabled) {
        return;
      }
      if (!leftOrigin && index !== source) {
        setLeftOrigin(true);
      }
    },
    [leftOrigin, source, isDisabled],
  );

  return (
    <DraggableStateContext.Provider
      value={{
        source,
        dest,
        dragging,
        origin,
        leftOrigin,
      }}
    >
      <DraggableDispatchContext.Provider
        value={{
          onDragStart: onInternalDragStart,
          onDragOver: onInternalDragOver,
          onDragEnd: onInternalDragEnd,
          onDragEnter: onInternalDragEnter,
          onDragLeave: onInternalDragLeave,
        }}
      >
        {valuesCopy?.map((value, index) => (
          <React.Fragment key={valuesKeys[index]}>
            {draggableItem?.(value, index)}
          </React.Fragment>
        ))}
      </DraggableDispatchContext.Provider>
    </DraggableStateContext.Provider>
  );
}

export function Draggable(props: {
  index: number;
  children: React.ReactNode;
  isDisabled: boolean;
}) {
  const t = useI18n();
  const { source, dragging, leftOrigin } = useDraggableStateContext();
  const { onDragStart, onDragOver, onDragEnd, onDragEnter, onDragLeave } =
    useDraggableDispatchContext();
  const [hoveredItem, setHoveredItem] = useState<number>(-1);
  const [draggable, setDraggable] = useState(false);
  const hovered = useMemo(
    () => hoveredItem === props.index,
    [hoveredItem, props.index],
  );
  const isDragging = useMemo(
    () => props.index === source && leftOrigin,
    [leftOrigin, props.index, source],
  );

  return (
    <Group
      draggable={dragging || draggable}
      onDragStart={() => onDragStart(props.index)}
      onDragOver={(e) => onDragOver(e, props.index)}
      onDragEnd={() => {
        onDragEnd(props.index);
        setHoveredItem(-1);
      }}
      onDragLeave={() => onDragLeave(props.index)}
      onDragEnter={() => onDragEnter(props.index)}
      onPointerEnter={() => setHoveredItem(props.index)}
      onPointerLeave={() => setHoveredItem(-1)}
      onPointerOver={() => setHoveredItem(props.index)}
    >
      <DragHandle
        disabled={props.isDisabled}
        dragging={isDragging}
        aria-label={t["com.myoxus.common.reorder"]()}
        onPointerEnter={() => setDraggable(true)}
        onPointerLeave={() => setDraggable(false)}
      />
      <DraggableItemContext.Provider value={{ hovered }}>
        {props.children}
      </DraggableItemContext.Provider>
    </Group>
  );
}
