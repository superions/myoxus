import type { PointLocation } from "@virgultum/global/gfx";
import { GfxLocalElementModel } from "@virgultum/std/gfx";

import {
  ConnectorMode,
  DEFAULT_ROUGHNESS,
  type PointStyle,
  StrokeStyle,
} from "../../consts/index";
import { type Color, DefaultTheme } from "../../themes/index";
import type { Connection } from "./connector.js";

export class LocalConnectorElementModel extends GfxLocalElementModel {
  private _path: PointLocation[] = [];

  absolutePath: PointLocation[] = [];

  endpointScale: number | null = null;

  frontEndpointStyle!: PointStyle;
  frontEndpointCircle = false;
  rearEndpointCircle = false;

  mode: ConnectorMode = ConnectorMode.Orthogonal;

  routingObstacleIds: string[] = [];

  routingObstacleRegions: Record<
    string,
    readonly [number, number, number, number]
  > = {};

  routingClearance = 0;
  routingCornerRadius = 0;

  routingLaneOffset = 0;

  rearEndpointStyle!: PointStyle;

  rough?: boolean;

  roughness: number = DEFAULT_ROUGHNESS;

  source: Connection = {
    position: [0, 0],
  };

  stroke: Color = DefaultTheme.connectorColor;

  strokeStyle: StrokeStyle = StrokeStyle.Solid;

  strokeWidth: number = 4;

  target: Connection = {
    position: [0, 0],
  };

  updatingPath = false;

  get path(): PointLocation[] {
    return this._path;
  }

  set path(value: PointLocation[]) {
    const { x, y } = this;

    this._path = value;
    this.absolutePath = value.map((p) =>
      p.clone().setVec([p[0] + x, p[1] + y]),
    );
  }

  get type() {
    return "connector";
  }
}
