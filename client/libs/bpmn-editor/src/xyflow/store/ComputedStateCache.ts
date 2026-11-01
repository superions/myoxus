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

export type TypeOrReturnType<T> = T extends (...args: any[]) => any
  ? ReturnType<T>
  : T;

export type CacheEntry<T> = {
  value: TypeOrReturnType<T> | undefined;
  dependencies: readonly any[];
};

export type Cache<T> = {
  [K in keyof T]: CacheEntry<T[K]>;
};

export class ComputedStateCache<T extends Record<string, any>> {
  private readonly cache: Cache<T>;

  constructor(initialValues: Cache<T>) {
    this.cache = { ...initialValues };
    // The exported seed is shared by mounts, but mutable cache entries must
    // remain instance-owned even when their dependency values happen to match.
    for (const key of Object.keys(initialValues) as (keyof T)[]) {
      this.cache[key] = {
        ...initialValues[key],
        dependencies: [...initialValues[key].dependencies],
      };
    }
  }

  public cached<K extends keyof T, D extends readonly any[]>(
    key: K,
    delegate: (...dependencies: D) => TypeOrReturnType<T[K]>,
    dependencies: D,
  ): TypeOrReturnType<T[K]> {
    const cachedDeps = this.cache[key]?.dependencies ?? [];

    // Initial entries have no value; empty dependencies must still compute once.
    let depsAreEqual =
      this.cache[key]?.value !== undefined &&
      cachedDeps.length === dependencies.length;
    if (depsAreEqual) {
      for (let i = 0; i < cachedDeps.length; i++) {
        if (!Object.is(cachedDeps[i], dependencies[i])) {
          depsAreEqual = false;
          break;
        }
      }
    }

    if (depsAreEqual) {
      return this.cache[key].value!;
    }

    const v = delegate(...dependencies);
    this.cache[key].dependencies = dependencies;
    this.cache[key].value = v;
    return v;
  }
}
