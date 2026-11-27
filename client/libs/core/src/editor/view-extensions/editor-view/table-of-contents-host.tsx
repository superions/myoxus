// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MountReactPortal } from "@myoxus/core/editor/portal";
import { TableOfContentsHost } from "@virgultum/editor/shared/services";
import type { ExtensionType } from "@virgultum/editor/store";
import {
  TableOfContentsBlock,
  TableOfContentsConfiguration,
} from "./table-of-contents";

export function patchTableOfContents(
  mountPortal: MountReactPortal,
): ExtensionType {
  return {
    setup(di) {
      di.addImpl(TableOfContentsHost, () => ({
        mount: (anchor, model, onNavigate) =>
          mountPortal(
            anchor,
            <TableOfContentsBlock model={model} onNavigate={onNavigate} />,
          ),
        configure: (anchor, value, apply, close) =>
          mountPortal(
            anchor,
            <TableOfContentsConfiguration
              value={value}
              apply={apply}
              close={close}
            />,
          ),
      }));
    },
  };
}
