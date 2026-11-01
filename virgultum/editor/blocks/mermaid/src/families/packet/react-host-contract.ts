// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidPacketModel,
  PacketCommand,
  PacketCommandResult,
} from "../../engine/packet/index.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type { MermaidSelectionActionModel } from "../runtime/shell-contract.js";
import { defineMermaidFamilyReactRendererToken } from "../runtime/react-host.js";
/** Commands are the sole write port. Selection and exact-source replay remain
 * transient projections of the document's existing history owner. */
export type MermaidPacketReactHostProps = {
  readonly model: MermaidPacketModel;
  readonly projectionModel?: MermaidPacketModel;
  readonly readonly: boolean;
  readonly embedded: boolean;
  readonly displayOnly: boolean;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly actionTarget?: HTMLElement | null;
  readonly headerActionTarget?: HTMLElement | null;
  readonly selection?: string;
  readonly replayed: boolean;
  readonly onExportMmd?: () => void;
  readonly onSelectionChange: (selection: string | undefined) => void;
  readonly onSelectionActionChange: (
    action: MermaidSelectionActionModel | null,
  ) => void;
  readonly onCommand: (
    command: PacketCommand,
    baseSource?: string,
  ) => PacketCommandResult;
  readonly onPreviewCommand: (
    command: PacketCommand,
    baseSource?: string,
  ) => PacketCommandResult;
  readonly onConsumeEscape: (event: KeyboardEvent) => void;
  readonly onOpenSource: () => void;
};
export const mermaidPacketRendererToken =
  defineMermaidFamilyReactRendererToken<MermaidPacketReactHostProps>("packet");
