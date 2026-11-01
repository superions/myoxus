// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Historical Theme registry — populated by P-AR-1-T-A..D Mikropaketen.
// Active theme authoring lives in server/static/branding/theme-seed.json and
// the generated server catalog; runtime paths must not import this registry.
// Each theme is a `ThemeTokenSet` keyed by `ThemeId`.
// Mikropaket P-AR-1-01 leaves the registry intentionally empty;
// `theme-schema.spec.ts` validates every entry as it gets added.
//
// P-AR-1-T-A registers the four Sans-Foundation themes
// (Stuttgart — default, Hamburg, Reykjavík, Zürich).
//
// P-AR-1-T-B adds two Sans-Calm themes (Hannover, Bremen) and two
// Refined-Serif themes (Wien, Lyon — both `expressive-new`).
//
// P-AR-1-T-C adds the four Editorial-Expressive themes
// (Berlin, Helsinki, Milano, Porto). Berlin's canonical mode is
// dark — see berlin.ts for the rationale.
//
// P-AR-1-T-D adds the four Warm-Expressive themes — Lisboa, Bordeaux,
// Habana (all `expressive-existing`) and Sevilla (`expressive-new`).
// This batch closes the registry at the full 16 city themes.

import { berlin } from "./berlin";
import { bordeaux } from "./bordeaux";
import { bremen } from "./bremen";
import { habana } from "./habana";
import { hamburg } from "./hamburg";
import { hannover } from "./hannover";
import { helsinki } from "./helsinki";
import { lisboa } from "./lisboa";
import { lyon } from "./lyon";
import { milano } from "./milano";
import { porto } from "./porto";
import { reykjavik } from "./reykjavik";
import { sevilla } from "./sevilla";
import { stuttgart } from "./stuttgart";
import type { ThemeId, ThemeTokenSet } from "./types";
import { wien } from "./wien";
import { zuerich } from "./zuerich";

export const THEMES: Partial<Record<ThemeId, ThemeTokenSet>> = {
  stuttgart,
  hamburg,
  reykjavik,
  zuerich,
  hannover,
  bremen,
  wien,
  lyon,
  berlin,
  helsinki,
  milano,
  porto,
  lisboa,
  bordeaux,
  habana,
  sevilla,
};

export {
  berlin,
  bordeaux,
  bremen,
  habana,
  hamburg,
  hannover,
  helsinki,
  lisboa,
  lyon,
  milano,
  porto,
  reykjavik,
  sevilla,
  stuttgart,
  wien,
  zuerich,
};

export type {
  ThemeColorTokens,
  ThemeId,
  ThemeMeta,
  ThemeTokenSet,
  ThemeTypographyTokens,
  TypographyToken,
} from "./types";
