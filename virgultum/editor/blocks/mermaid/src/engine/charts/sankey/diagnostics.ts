// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyConfig } from "./config.js";

export type SankeyDiagnostic = {
  readonly code:
    | "header"
    | "ambiguous-record"
    | "field-count"
    | "field-syntax"
    | "empty-endpoint"
    | "invalid-value"
    | "negative-value"
    | "self-link"
    | "cycle"
    | "config"
    | "conflict";
  readonly recordId: string;
  readonly line: number;
  readonly field?: "source" | "target" | "value";
  readonly configField?: keyof SankeyConfig;
  readonly effectiveValue?: string | number;
  readonly impact: "record" | "layout" | "document";
};

/** All intra-component links are cyclic; source order cannot pick a scapegoat. */
export function sankeyCyclicLinks(
  links: readonly {
    readonly id: string;
    readonly source?: string;
    readonly target?: string;
    readonly renderable: boolean;
  }[],
) {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const link of links) {
    if (!link.renderable || !link.source || !link.target) continue;
    forward.set(link.source, [
      ...(forward.get(link.source) ?? []),
      link.target,
    ]);
    forward.set(link.target, forward.get(link.target) ?? []);
    reverse.set(link.target, [
      ...(reverse.get(link.target) ?? []),
      link.source,
    ]);
    reverse.set(link.source, reverse.get(link.source) ?? []);
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of forward.keys()) {
    if (visited.has(start)) continue;
    const stack: { id: string; finish: boolean }[] = [
      { id: start, finish: false },
    ];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.finish) {
        order.push(item.id);
        continue;
      }
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      stack.push({ id: item.id, finish: true });
      for (const id of forward.get(item.id) ?? []) {
        if (!visited.has(id)) stack.push({ id, finish: false });
      }
    }
  }
  const component = new Map<string, number>();
  let ordinal = 0;
  for (const start of order.reverse()) {
    if (component.has(start)) continue;
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (component.has(id)) continue;
      component.set(id, ordinal);
      stack.push(...(reverse.get(id) ?? []));
    }
    ordinal++;
  }
  return new Set(
    links
      .filter(
        (link) =>
          link.renderable &&
          link.source &&
          link.target &&
          component.has(link.source) &&
          component.get(link.source) === component.get(link.target),
      )
      .map((link) => link.id),
  );
}
