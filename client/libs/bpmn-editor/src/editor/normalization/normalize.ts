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
// Modified by Myoxus; see provenance.json for retained source and patches.

import { type BpmnLatestModel } from "../../marshaller";
export type Normalized<T> = WithRequiredDeep<T, "@_id">;
type WithRequiredDeep<T, K extends PropertyKey> = T extends undefined
  ? T
  : T extends Array<infer U>
    ? Array<WithRequiredDeep<U, K>>
    : { [P in keyof T]: WithRequiredDeep<T[P], K> } & (K extends keyof T
        ? { [P in K]-?: NonNullable<WithRequiredDeep<T[P], K>> }
        : T);

/**
 * Clone a source already accepted by the shared inspector. Required semantic/DI
 * identities are checked there; assigning optional imported IDs here would alter
 * unrelated branches on the first supported edit. New commands allocate their
 * own identities, never repair the imported source during normalization.
 */
export function normalize(model: BpmnLatestModel): Normalized<BpmnLatestModel> {
  // This type owner is also reached by the DOM-free source visitor. Clone is a
  // Node 26/worker/browser capability, not a reason to require DOM library types.
  const { structuredClone } = globalThis as typeof globalThis & {
    structuredClone<T>(value: T): T;
  };
  return structuredClone(model) as Normalized<BpmnLatestModel>;
}
