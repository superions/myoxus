// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext } from "react";

/** Input intent only. The modeller owns graph commands, validation and history;
 * runtime node/edge controls never inspect or rewrite BPMN XML. */
export type DiagramActionRequest =
  | {
      nodeId: string;
      action?: { kind: "edge" | "node"; type: string };
      placement?: "next";
    }
  | { edgeId: string };
export const DiagramActionContext = createContext<
  ((request: DiagramActionRequest) => void) | undefined
>(undefined);
