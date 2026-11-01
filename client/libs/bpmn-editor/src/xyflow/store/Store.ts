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

import { createContext, useContext } from "react";
import { type StoreApi, type UseBoundStore, type Mutate } from "zustand";
import "zustand/middleware/immer";
import { useStoreWithEqualityFn } from "zustand/traditional";
import {
  type XyFlowDiagramState,
  type XyFlowReactKieDiagramEdgeData,
  type XyFlowReactKieDiagramNodeData,
} from "./State";

export type StoreApiType<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = UseBoundStore<Mutate<StoreApi<S>, [["zustand/immer", never]]>>;

export const XyFlowReactKieDiagramStoreApiContext = createContext<StoreApiType<
  any,
  any,
  any,
  any
> | null>(null);

export function useXyFlowReactKieDiagramStore<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
  StateSlice = StoreApi<S> extends { getState: () => infer T } ? T : never,
>(
  selector: (state: S) => StateSlice,
  equalityFn?: (a: StateSlice, b: StateSlice) => boolean,
) {
  const store = useContext(XyFlowReactKieDiagramStoreApiContext);
  if (store === null) {
    throw new Error(
      "Can't use XyFlow KIE Diagram Store outside of the XyFlowReactKieDiagram component.",
    );
  }

  return useStoreWithEqualityFn(store, selector, equalityFn);
}

export function useXyFlowReactKieDiagramStoreApi<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
>(): StoreApiType<S, N, NData, EData> {
  const store = useContext(XyFlowReactKieDiagramStoreApiContext);
  if (!store) throw new Error("BPMN diagram store provider is missing");
  return store as StoreApiType<S, N, NData, EData>;
}
