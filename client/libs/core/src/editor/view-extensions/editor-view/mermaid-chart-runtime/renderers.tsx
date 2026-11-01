// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidChartRequest } from "../deferred-mermaid-chart";
import { MermaidPieRuntime } from "./pie";
import { MermaidQuadrantRuntime } from "./quadrant";
import { MermaidXyRuntime } from "./xy";
import { MermaidRadarRuntime } from "./radar";
import { MermaidSankeyRuntime } from "./sankey";
import { MermaidTreemapRuntime } from "./treemap";

// Keep each existing runtime and its hook/geometry lifecycle intact: it mounts
// after delivery, with the latest controlled props and the existing portal theme.
export function renderMermaidChart(request: MermaidChartRequest) {
  switch (request.kind) {
    case "pie":
      return <MermaidPieRuntime props={request.props} />;
    case "quadrant":
      return <MermaidQuadrantRuntime props={request.props} />;
    case "xy":
      return <MermaidXyRuntime props={request.props} />;
    case "radar":
      return <MermaidRadarRuntime props={request.props} />;
    case "sankey":
      return <MermaidSankeyRuntime props={request.props} />;
    case "treemap":
      return <MermaidTreemapRuntime props={request.props} />;
  }
}
