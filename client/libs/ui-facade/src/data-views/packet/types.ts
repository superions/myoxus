// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
export type PacketGeometryIntent =
  | { kind: "boundary"; leftKey: string; rightKey?: string; bit: number }
  | { kind: "reorder"; fieldKey: string; targetIndex: number };
export type PacketFragment = {
  fieldId: string;
  row: number;
  columnStart: number;
  columnEnd: number;
  startBit: number;
  endBit: number;
  fieldStartBit: number;
  fieldEndBit: number;
  label: string;
  continuesBefore: boolean;
  continuesAfter: boolean;
  boundary?: {
    leftKey: string;
    rightKey?: string;
    bit: number;
    min: number;
    max: number;
  };
};
export type PacketRowProjection = {
  row: number;
  startBit: number;
  endBit: number;
  fragments: readonly PacketFragment[];
};
export type PacketGridProjection = {
  rows: readonly PacketRowProjection[];
  bitsPerRow: number;
  bitWidth: number;
  rowHeight: number;
  showBits: boolean;
  paddingX: number;
  paddingY: number;
};
export type PacketBitGridLabels = {
  bit?: (value: number) => string;
  field: (
    label: string,
    start: number,
    end: number,
    continued: boolean,
  ) => string;
  totalWidth: (bits: number) => string;
  boundary: (bit: number, label: string) => string;
  reorderTarget: (index: number) => string;
};
/** Neutral geometry only. The consumer plans domain impacts and owns Source/history. */
export type PacketGeometryCallbacks = {
  onGeometryStart?: (intent: PacketGeometryIntent) => void;
  onGeometryPreview?: (intent: PacketGeometryIntent) => void;
  onGeometryConfirm?: (intent: PacketGeometryIntent) => void;
  onGeometryCancel?: (escape?: KeyboardEvent) => void;
};
export type PacketBitGridProps = PacketGridProjection &
  PacketGeometryCallbacks & {
    "aria-label": string;
    "aria-description"?: string;
    labels: PacketBitGridLabels;
    totalWidth: number;
    fieldOrder: readonly string[];
    selectedFieldId?: string;
    /** Opaque consumer session: a new basis cancels drafts without exposing Source. */
    gestureSession?: object;
    readonly?: boolean;
    displayOnly?: boolean;
    scrollOwner?: "parent" | "self";
    error?: ReactNode;
    empty?: ReactNode;
    markers?: ReactNode;
    focusRequest?: { fieldId?: string; requestId: number };
    onSelectField?: (fieldId: string, trigger: HTMLElement) => void;
    onOpenField?: (fragment: PacketFragment, trigger: HTMLElement) => void;
    onDeleteField?: (fieldId: string) => void;
    frameField?: (fragment: PacketFragment, field: ReactNode) => ReactNode;
    fieldMarker?: (fragment: PacketFragment) => ReactNode;
  };
