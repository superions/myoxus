// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { Entity } from "@myoxus/infra";

import type {
  WorkbenchToolId,
  WorkbenchViewFamily,
} from "../../server/stores/user-preferences";

export type ContextSurfaceDescriptor = {
  id: WorkbenchToolId;
  label?: string;
  tooltip?: string;
  order?: number;
  sequence?: number;
  viewFamilies?: readonly WorkbenchViewFamily[];
  retainBodyWhenCollapsed?: boolean;
  /** Continue only after the surface has resolved its own unsaved native edit. */
  beforeClose?: (next: () => void) => void;
};

export class ContextSurface extends Entity<ContextSurfaceDescriptor> {
  readonly id = this.props.id;

  get label() {
    return this.props.label ?? this.id;
  }

  get tooltip() {
    return this.props.tooltip ?? this.label;
  }

  get order() {
    return this.props.order ?? Number.MAX_SAFE_INTEGER;
  }

  get sequence() {
    return this.props.sequence ?? 0;
  }

  get viewFamilies() {
    return this.props.viewFamilies ?? [];
  }

  requestClose(next: () => void) {
    if (this.props.beforeClose) this.props.beforeClose(next);
    else next();
  }

  get retainBodyWhenCollapsed() {
    return this.props.retainBodyWhenCollapsed ?? false;
  }
}
