// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ToolIcon } from "@myoxus/icons/react";
import type { ReactToLit } from "@myoxus/lit-react";
import { buildImageProxyURL } from "@virgultum/core/adapters";
import { createElement, type ReactNode } from "react";
import { ToolCallCardView } from "./tool-call-card-view";
import { ToolFailedCardView } from "./tool-failed-card-view";
import { ToolResultCardView } from "./tool-result-card-view";

type ToolPresentation = { name: string; icon?: ReactNode; contained?: boolean };
export interface ToolResult {
  title: ReactNode;
  /** A string is a source image URL; native icons are React nodes. */
  icon?: ReactNode;
  content?: string;
  href?: string;
  onClick?: () => void;
}

/** Inert previews keep their summary without creating a second React root. */
export function renderToolCallCard(
  host: ReactToLit | undefined,
  p: ToolPresentation,
) {
  return host
    ? host(
        createElement(ToolCallCardView, {
          ...p,
          icon: p.icon ?? createElement(ToolIcon),
        }),
        true,
      )
    : p.name;
}

export function renderToolFailedCard(
  host: ReactToLit | undefined,
  p: ToolPresentation,
) {
  return host
    ? host(
        createElement(ToolFailedCardView, {
          ...p,
          icon: p.icon ?? createElement(ToolIcon),
        }),
        true,
      )
    : p.name;
}

function imageUrl(url: string) {
  return buildImageProxyURL(url, BUILD_CONFIG.imageProxyUrl);
}

/** The owning producer's portal preserves the native disclosure during streaming. */
export function renderToolResultCard(
  host: ReactToLit | undefined,
  p: ToolPresentation & {
    footerIcons?: readonly ReactNode[];
    results?: readonly ToolResult[];
  },
) {
  if (!host) return p.name;
  return host(
    createElement(ToolResultCardView, {
      name: p.name,
      contained: p.contained,
      icon: p.icon ?? createElement(ToolIcon),
      footerIcons: (p.footerIcons ?? []).map((icon) =>
        typeof icon === "string" ? { url: imageUrl(icon) } : { icon },
      ),
      results: (p.results ?? []).map((result) => ({
        ...result,
        icon: typeof result.icon === "string" ? undefined : result.icon,
        image:
          typeof result.icon === "string" ? imageUrl(result.icon) : undefined,
      })),
    }),
    true,
  );
}
