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
export const PaletteNotationContext = React.createContext(false);

export function RoundSvg({ children }: React.PropsWithChildren) {
  const nodeSvgViewboxSize = nodeSvgProps.width + 2 * nodeSvgProps.strokeWidth;
  const palette = React.useContext(PaletteNotationContext);
  const ref = React.useRef<SVGSVGElement>(null);
  const [fittedViewBox, setFittedViewBox] = React.useState<string>();
  React.useLayoutEffect(() => {
    if (!palette || !ref.current?.getBBox) return;
    const bounds = ref.current.getBBox();
    if (!bounds.width || !bounds.height) return;
    // Fit only the palette miniature to its painted notation. Canvas/export
    // geometry and the shared icon defaults remain untouched.
    const margin = nodeSvgProps.strokeWidth;
    setFittedViewBox(
      `${bounds.x - margin} ${bounds.y - margin} ${bounds.width + 2 * margin} ${bounds.height + 2 * margin}`,
    );
  }, [palette, children]);

  return (
    <svg
      ref={ref}
      data-palette-notation={palette}
      className={"xyflow-react-kie-diagram--round-svg-container"}
      viewBox={
        palette && fittedViewBox
          ? fittedViewBox
          : `0 0 ${nodeSvgViewboxSize} ${nodeSvgViewboxSize}`
      }
      width={palette ? 32 : "1em"}
      height={palette ? 32 : "1em"}
    >
      {children}
    </svg>
  );
}
