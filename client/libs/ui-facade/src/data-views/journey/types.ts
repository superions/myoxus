// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";

export type JourneyCapability = {
  readonly enabled: boolean;
  readonly reason?: string;
};
export type JourneyMapSelection = {
  readonly stepId?: string;
  readonly sectionId?: string;
};

export type JourneyMapStep = {
  readonly precedingContent?: ReactNode;
  readonly id: string;
  readonly sectionId: string;
  readonly label: string;
  readonly draft?: boolean;
  readonly score: number;
  readonly actors: readonly string[];
  readonly highlighted?: boolean;
  readonly diagnostic?: ReactNode;
  readonly content?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly frame?: (
    step: ReactNode,
    state: { readonly dragging: boolean },
  ) => ReactNode;
  readonly open?: JourneyCapability;
  readonly move?: JourneyCapability;
  readonly rename?: JourneyCapability;
  readonly remove?: JourneyCapability;
};

export type JourneyMapSection = {
  /** Optional renderer-owned track geometry, independent of UI density. */
  readonly implicit?: boolean;
  readonly frame?: (section: ReactNode) => ReactNode;
  readonly precedingContent?: ReactNode;
  readonly id: string;
  readonly label: string;
  readonly steps: ReadonlyArray<JourneyMapStep>;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly frameTestId?: string;
  readonly addStepTestId?: string;
  readonly add?: JourneyCapability;
  readonly rename?: JourneyCapability;
  readonly reorder?: JourneyCapability;
  readonly remove?: JourneyCapability;
};

export type JourneyMapStepMove = {
  readonly stepId: string;
  readonly fromSectionId: string;
  readonly toSectionId: string;
  readonly targetStepId?: string;
  readonly edge?: "before" | "after";
};

export type JourneyMapSectionMove = {
  readonly sectionId: string;
  readonly targetSectionId: string;
  readonly edge: "before" | "after";
};

export type JourneyMapLabels = {
  readonly actions: string;
  readonly unnamedSection: string;
  readonly score: (value: number) => string;
  readonly scoreValue: (value: number) => string;
  readonly scoreAxis: string;
  readonly moveTarget: (
    object: string,
    target: string,
    position: number,
  ) => string;
  readonly addStep: (sectionLabel: string) => string;
  readonly addSection: string;
  readonly stepCount: (count: number) => string;
  readonly dragStep: (stepLabel: string) => string;
  readonly dragSection: (sectionLabel: string) => string;
  readonly deleteStep: (stepLabel: string) => string;
  readonly deleteSection: (sectionLabel: string) => string;
  readonly emptySection: string;
  readonly openStep: (stepLabel: string) => string;
  readonly movedStep: (
    stepLabel: string,
    fromSectionLabel: string,
    toSectionLabel: string,
  ) => string;
  readonly movedSection: (
    sectionLabel: string,
    targetSectionLabel: string,
  ) => string;
};

export type JourneyMapProps = {
  readonly stepWidth?: number;
  readonly renderLabel?: (label: string) => ReactNode;
  readonly "aria-label": string;
  readonly "data-testid"?: string;
  readonly sections: ReadonlyArray<JourneyMapSection>;
  readonly labels: JourneyMapLabels;
  readonly selection?: JourneyMapSelection;
  readonly readonly?: boolean;
  readonly scrollOwner?: "parent" | "self";
  readonly toolbar?: ReactNode;
  readonly empty?: ReactNode;
  readonly error?: ReactNode;
  readonly addSection?: JourneyCapability;
  readonly editRequest?: {
    readonly id: string;
    readonly kind: "step" | "section";
    readonly requestId: number;
  };
  /** Returning focus after apply/replay also cancels the previous move gesture. */
  readonly focusRequest?: {
    /** Reveal an offscreen popover anchor without stealing its form focus. */
    readonly revealOnly?: boolean;
    readonly requestId: number;
    readonly selection?: JourneyMapSelection;
    readonly target?: "add-section-empty" | "map";
  };
  readonly onEditInput?: (
    kind: "step" | "section",
    id: string,
    label: string,
  ) => void;
  readonly onInteractionStart?: (
    kind: "step" | "section",
    id: string,
    intent: "rename" | "move",
  ) => void;
  readonly onEditEnd?: (
    kind: "step" | "section",
    id: string,
    outcome: "commit" | "cancel",
  ) => void;
  readonly onOpenSection?: (sectionId: string, trigger: HTMLElement) => void;
  readonly onAddStep?: (sectionId: string) => void | Promise<void>;
  readonly onAddSection?: (trigger: HTMLElement) => void | Promise<void>;
  readonly onDeleteStep?: (stepId: string) => void | Promise<void>;
  readonly onDeleteSection?: (
    sectionId: string,
    trigger: HTMLElement,
  ) => void | Promise<void>;
  /** Returning false rejects the move and suppresses its success announcement. */
  readonly onMoveStep?: (
    move: JourneyMapStepMove,
  ) => boolean | void | Promise<boolean | void>;
  readonly onMoveSection?: (
    move: JourneyMapSectionMove,
  ) => boolean | void | Promise<boolean | void>;
  readonly onOpenStep: (stepId: string, trigger: HTMLElement) => void;
  readonly onSelectionTargetChange?: (target: HTMLElement) => void;
  readonly onSelectStep: (stepId: string, trigger: HTMLElement) => void;
  readonly onSelectSection: (sectionId: string, trigger: HTMLElement) => void;
  readonly onRenameStep?: (
    stepId: string,
    label: string,
  ) => void | Promise<void>;
  readonly onRenameSection?: (
    sectionId: string,
    label: string,
  ) => void | Promise<void>;
};
