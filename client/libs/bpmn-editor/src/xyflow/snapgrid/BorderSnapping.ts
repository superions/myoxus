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

import type { DC__Bounds } from "../maths/model";

export const DEFAULT_BORDER_ALLOWANCE_IN_PX = 14;

/** Attachment centers the actual event on the painted host outline. Imported
 * sizes/positions are authoritative; creation minima and a styling offset must
 * not invent an invisible larger host or shift the event off its border. */
export function snapToDropTargetsBorder(
  container: DC__Bounds,
  bounds: DC__Bounds,
  allowance: number,
) {
  let x = bounds["@_x"],
    y = bounds["@_y"];
  const cx = x + bounds["@_width"] / 2,
    cy = y + bounds["@_height"] / 2;
  const left = container["@_x"],
    right = left + container["@_width"];
  const top = container["@_y"],
    bottom = top + container["@_height"];
  if (Math.abs(cx - left) <= allowance) x = left - bounds["@_width"] / 2;
  if (Math.abs(cx - right) <= allowance) x = right - bounds["@_width"] / 2;
  if (Math.abs(cy - top) <= allowance) y = top - bounds["@_height"] / 2;
  if (Math.abs(cy - bottom) <= allowance) y = bottom - bounds["@_height"] / 2;
  return { x, y };
}
