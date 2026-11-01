import { editorMessage, EditPropsStore } from "@virgultum/shared/services";
import {
  ConnectorCIcon,
  ConnectorEIcon,
  ConnectorLIcon,
} from "@myoxus/icons/lit";
import { menu } from "@virgultum/components/context-menu";
import { ConnectorMode } from "@virgultum/model";

import type { DenseMenuBuilder } from "@virgultum/widget-edgeless-toolbar";

import { ConnectorTool } from "../connector-tool";

export const buildConnectorDenseMenu: DenseMenuBuilder = (edgeless, gfx) => {
  const prevMode =
    edgeless.std.get(EditPropsStore).lastProps$.value.connector.mode;

  const isSelected = gfx.tool.currentToolName$.peek() === "connector";

  const createSelect =
    (mode: ConnectorMode, record = true) =>
    () => {
      gfx.tool.setTool(ConnectorTool, {
        mode,
      });
      record &&
        edgeless.std.get(EditPropsStore).recordLastProps("connector", { mode });
    };

  const iconSize = { width: "20", height: "20" };
  return menu.subMenu({
    name: "Connector",
    label: editorMessage("com.myoxus.keyboardShortcuts.connector", "Connector"),
    prefix: ConnectorCIcon(iconSize),
    select: createSelect(prevMode, false),
    isSelected,
    options: {
      items: [
        menu.action({
          name: "Curve",
          label: editorMessage("com.myoxus.editor.menu.curve", "Curve"),
          prefix: ConnectorCIcon(iconSize),
          select: createSelect(ConnectorMode.Curve),
          isSelected: isSelected && prevMode === ConnectorMode.Curve,
        }),
        menu.action({
          name: "Elbowed",
          label: editorMessage("com.myoxus.editor.menu.elbowed", "Elbowed"),
          prefix: ConnectorEIcon(iconSize),
          select: createSelect(ConnectorMode.Orthogonal),
          isSelected: isSelected && prevMode === ConnectorMode.Orthogonal,
        }),
        menu.action({
          name: "Straight",
          label: editorMessage("com.myoxus.editor.menu.straight", "Straight"),
          prefix: ConnectorLIcon(iconSize),
          select: createSelect(ConnectorMode.Straight),
          isSelected: isSelected && prevMode === ConnectorMode.Straight,
        }),
      ],
    },
  });
};
