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
import "./NodeIcons.css";

export const nodeSvgProps = {
  width: 200,
  height: 120,
  x: 16,
  y: 48,
  strokeWidth: 16,
};

/** Glyph geometry lives in its viewBox; native controls own the rendered icon size. */
export function RoundSvg({ children }: React.PropsWithChildren) {
  const nodeSvgViewboxSize = nodeSvgProps.width + 2 * nodeSvgProps.strokeWidth;

  return (
    <svg
      className={"xyflow-react-kie-diagram--round-svg-container"}
      viewBox={`0 0 ${nodeSvgViewboxSize} ${nodeSvgViewboxSize}`}
      width="1em"
      height="1em"
    >
      {children}
    </svg>
  );
}
