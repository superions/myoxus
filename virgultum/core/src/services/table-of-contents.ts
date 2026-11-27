// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createIdentifier } from "../primitives/di/index";
import type {
  TableOfContentsBlockModel,
  TableOfContentsProps,
} from "../models/index";

export interface TableOfContentsHost {
  mount(
    anchor: HTMLElement,
    model: TableOfContentsBlockModel,
    onNavigate?: (blockId: string) => void,
  ): () => void;
  configure(
    anchor: HTMLElement,
    props: TableOfContentsProps,
    apply: (value: TableOfContentsProps) => void,
    close: () => void,
  ): () => void;
}

export const TableOfContentsHost = createIdentifier<TableOfContentsHost>(
  "TableOfContentsHost",
);
