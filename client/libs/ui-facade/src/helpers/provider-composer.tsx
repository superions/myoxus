// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ReactElement, type ReactNode, cloneElement } from "react";

export function ProviderComposer({
  contexts,
  children,
}: {
  contexts: ReactElement<{ children?: ReactNode }>[];
  children: ReactNode;
}) {
  return contexts.reduceRight(
    (kids: ReactNode, parent) => cloneElement(parent, undefined, kids),
    children,
  );
}
