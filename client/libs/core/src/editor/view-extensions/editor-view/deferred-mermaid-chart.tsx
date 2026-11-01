// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { Button, Group, MyoxusText } from "@myoxus/ui-facade";
import type {
  MermaidPieReactHostProps,
  MermaidQuadrantReactHostProps,
  MermaidXyReactHostProps,
  MermaidRadarReactHostProps,
  MermaidSankeyReactHostProps,
  MermaidTreemapReactHostProps,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";
import { loadMermaidChartRenderer } from "./mermaid-chart-runtime/load";

type ChartProps = {
  pie: MermaidPieReactHostProps;
  quadrant: MermaidQuadrantReactHostProps;
  xy: MermaidXyReactHostProps;
  radar: MermaidRadarReactHostProps;
  sankey: MermaidSankeyReactHostProps;
  treemap: MermaidTreemapReactHostProps;
};
export type MermaidChartRequest = {
  [K in keyof ChartProps]: { kind: K; props: ChartProps[K] };
}[keyof ChartProps];
type Renderer =
  typeof import("./mermaid-chart-runtime/renderers").renderMermaidChart;
// Mount the existing runtime after delivery so its focus and geometry hooks
// start against real chart DOM, with the latest controlled props and portal theme.
export function DeferredMermaidChart(props: MermaidChartRequest) {
  const t = useI18n();
  const [renderer, setRenderer] = useState<Renderer>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void loadMermaidChartRenderer()
      .then((renderer) => {
        if (active) setRenderer(() => renderer);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (renderer) return renderer(props);
  if (!failed) return <MyoxusText role="status">{t["Loading"]()}</MyoxusText>;
  return (
    <Group>
      <MyoxusText role="alert">{t["UNKNOWN_ERROR"]()}</MyoxusText>
      <Button onClick={() => setAttempt((attempt) => attempt + 1)}>
        {t["Retry"]()}
      </Button>
    </Group>
  );
}
