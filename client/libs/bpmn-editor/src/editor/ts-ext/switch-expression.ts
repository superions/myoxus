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

export type SwitchExpressionValue = string | number | symbol;
export type PartialWithMandatoryDefault<K extends SwitchExpressionValue, V> = {
  default: V;
} & Partial<Record<K, V>>;
export type SwitchExpressionCases<K extends SwitchExpressionValue, V> =
  PartialWithMandatoryDefault<K, V> | Record<K, V>;

/** Resolves an exhaustive literal map; an explicitly present undefined value is not a default. */
export const switchExpression = <
  S extends SwitchExpressionValue,
  ExplicitRet extends R,
  C extends SwitchExpressionCases<S, R> = SwitchExpressionCases<S, ExplicitRet>,
  R = C extends SwitchExpressionCases<S, infer R> ? R : any,
>(
  switchValue: S | undefined,
  cases: C,
): R => {
  if (switchValue !== undefined && Object.hasOwn(cases, switchValue)) {
    return (cases as Record<S, R>)[switchValue];
  }
  if (Object.hasOwn(cases, "default")) {
    return (cases as PartialWithMandatoryDefault<S, R>).default;
  }
  throw new Error("BPMN_UNHANDLED_VARIANT");
};
