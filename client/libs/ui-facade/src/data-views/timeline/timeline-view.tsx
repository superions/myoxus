// SPDX-License-Identifier: AGPL-3.0-or-later

import { TimeTimeline } from "./time-timeline";
import { OrdinalTimeline } from "./ordinal-timeline";
import type { ReactNode } from "react";

export type TimelineObject = {
  readonly kind: "section" | "period" | "event";
  readonly id: string;
};
export type TimelineLabelDraft = {
  readonly object: TimelineObject;
  readonly label: string;
  readonly valid: boolean;
  readonly message?: string;
};
export type TimelineMoveIntent = {
  readonly object: TimelineObject;
  readonly targetSectionId?: string;
  readonly targetPeriodId?: string;
  /** Slot after removing the moving object from its target list. */
  readonly targetOrder: number;
};
export type TimelineCapability = {
  readonly enabled: boolean;
  readonly reason?: string;
};
export type TimelineEventProjection = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
};
export type TimelinePeriodProjection = {
  readonly id: string;
  readonly label: string;
  readonly events: readonly TimelineEventProjection[];
};
export type TimelineSectionProjection = {
  readonly id: string;
  readonly label: string;
  readonly implicit?: boolean;
  readonly periods: readonly TimelinePeriodProjection[];
};
export type TimelineDiagnosticProjection = {
  readonly id: string;
  readonly anchorId: string | null;
  readonly message: string;
};
export type OrdinalTimelineViewProps = {
  readonly axis: { readonly kind: "ordinal"; readonly direction: "LR" | "TD" };
  readonly sections: readonly TimelineSectionProjection[];
  readonly selection: TimelineObject | null;
  readonly readonly: boolean;
  readonly selectionCapability: TimelineCapability;
  readonly diagnostics: readonly TimelineDiagnosticProjection[];
  readonly accessibility: {
    readonly title: string;
    readonly description?: string;
  };
  readonly density?: number;
  readonly fitWidth?: boolean;
  readonly labelDraft?: TimelineLabelDraft;
  readonly moveDraft?: TimelineMoveIntent;
  readonly movePreview?: {
    readonly valid: boolean;
    readonly label?: string;
    readonly message?: string;
  };
  /** Optional anchored reading/editing overlay. Consumers own comment syntax and persistence. */
  readonly comments?: {
    readonly counts: Readonly<Record<string, number>>;
    readonly label: string;
    readonly targetId?: string;
    readonly content?: ReactNode;
    readonly onOpen: (object: TimelineObject) => void;
    readonly onClose: () => void;
  };
  readonly labels?: {
    readonly label: string;
    readonly addPeriod: string;
    readonly addEvent: string;
    readonly delete: string;
    readonly more: string;
    readonly apply: string;
    readonly cancel: string;
    readonly move: string;
    readonly moveHint: string;
    readonly slot: (position: number, count: number) => string;
  };
  readonly onDelete?: (object: TimelineObject) => void;
  readonly onCreate?: (kind: "period" | "event", targetId: string) => void;
  readonly onRename?: (object: TimelineObject) => void;
  readonly onLabelChange?: (label: string) => void;
  readonly onDraftApply?: () => void;
  readonly onDraftCancel?: () => void;
  readonly onMovePreview?: (intent: TimelineMoveIntent) => void;
  readonly onMoveApply?: (intent: TimelineMoveIntent) => void;
  readonly onSelect: (object: TimelineObject) => void;
};

export type TimeTimelineTimeIntent = {
  readonly id: string;
  readonly start: number;
  readonly end: number | null;
  readonly mode: "move" | "resize-start" | "resize-end";
};
export type TimeTimelineEntry = {
  readonly id: string;
  readonly label: string;
  readonly start: number;
  readonly end: number | null;
  readonly timeLabel: string;
  readonly accessibleLabel: string;
  readonly selected?: boolean;
  readonly timeActions?: {
    readonly move: TimelineCapability;
    readonly start: TimelineCapability;
    readonly end: TimelineCapability;
    readonly moveStep: number;
    readonly startStep: number;
    readonly endStep: number;
  };
  readonly timePreview?: TimeTimelineTimeIntent & {
    readonly message: string;
    readonly error?: string;
    readonly valid: boolean;
  };
  readonly content?: ReactNode;
  readonly labelContent?: ReactNode;
  readonly actions?: ReactNode;
  readonly dateEditor?: {
    readonly enabled: boolean;
    readonly opened: boolean;
    readonly label: string;
    readonly content?: ReactNode;
    readonly onOpen: () => void;
    readonly onClose: () => void;
  };
  readonly rename?: TimelineCapability;
};
export type TimeTimelineGroup = {
  readonly id: string;
  readonly label: string | null;
  readonly entries: readonly TimeTimelineEntry[];
};
export type TimeTimelineViewProps = {
  readonly axis: {
    readonly kind: "time";
    readonly start: number;
    readonly end: number;
    readonly step: number;
    readonly zoom: "day" | "week" | "month" | "quarter" | "year";
    readonly ticks: readonly {
      readonly value: number;
      readonly label: string;
    }[];
  };
  readonly groups: readonly TimeTimelineGroup[];
  readonly accessibility: {
    readonly title: string;
    readonly description?: string;
  };
  readonly placement?: {
    readonly active: boolean;
    readonly chosen: boolean;
    readonly start: number;
    readonly end: number | null;
    readonly step: number;
    readonly label: string;
    readonly content?: ReactNode;
    readonly onPreview: (start: number, end: number | null) => void;
    readonly onChoose: () => void;
    readonly onCancel: () => void;
  };
  readonly now?: number;
  readonly empty?: ReactNode;
  readonly onSelect: (id: string) => void;
  readonly onOpen: (id: string) => void;
  readonly onRename?: (id: string) => void;
  readonly timeLabels?: {
    readonly move: string;
    readonly start: string;
    readonly end: string;
    readonly apply: string;
    readonly cancel: string;
  };
  readonly onTimePreview?: (intent: TimeTimelineTimeIntent) => void;
  readonly onTimeApply?: (intent: TimeTimelineTimeIntent) => void;
  readonly onTimeCancel?: () => void;
};
export type TimelineViewProps =
  OrdinalTimelineViewProps | TimeTimelineViewProps;
function isTimeTimeline(
  props: TimelineViewProps,
): props is TimeTimelineViewProps {
  return props.axis.kind === "time";
}
/** Projection entry only. Source syntax and persistence belong to consuming products. */
export function TimelineView(props: TimelineViewProps) {
  return isTimeTimeline(props) ? (
    <TimeTimeline {...props} />
  ) : (
    <OrdinalTimeline {...props} />
  );
}
