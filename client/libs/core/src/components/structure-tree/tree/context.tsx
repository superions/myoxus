// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createContext } from "react";

import type { NodeOperation } from "./types";

export interface StructureTreeContextData {
  level: number;
  operations?: NodeOperation[];
  registerChild: () => () => void;
}

export const StructureTreeContext =
  createContext<StructureTreeContextData | null>(null);
