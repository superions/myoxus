// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { BrokenImageIcon, ImageIcon } from "@myoxus/icons/react";
import { Loading, ReferenceCard } from "@myoxus/ui-facade";
import type { EditorImageFallbackControls } from "@virgultum/editor/shared/services";

export function EditorImageFallback({
  controls: c,
}: {
  controls: EditorImageFallbackControls;
}) {
  const t = useI18n();
  return (
    <ReferenceCard
      size="small"
      contained={c.inSurface}
      fullHeight={c.inSurface}
      title={t.Image()}
      metadata={c.description}
      icon={
        c.loading ? <Loading /> : c.error ? <BrokenImageIcon /> : <ImageIcon />
      }
      className="drag-target"
      data-testid="editor-image-fallback"
      aria-busy={c.loading}
    />
  );
}
