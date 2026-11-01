// SPDX-License-Identifier: AGPL-3.0-or-later

type Renderer = typeof import("./renderers").renderMermaidChart;
let request: Promise<Renderer> | undefined;

// A chart portal owns demand; successful and in-flight delivery is shared.
// Failed attempts release the cache so retry never requires clearing source data.
export function loadMermaidChartRenderer(): Promise<Renderer> {
  return (request ??= import("./renderers")
    .then((module) => module.renderMermaidChart)
    .catch((error: unknown) => {
      request = undefined;
      throw error;
    }));
}
