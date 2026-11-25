// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  Group,
  MediaPreviewFrame,
  MediaPreviewImage,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";

export function ChatContentImages({
  images,
  layout = "row",
}: {
  images: readonly string[];
  layout?: "row" | "column";
}) {
  if (!images.length) return null;

  if (layout === "column") {
    return (
      <Stack gap="md">
        {images.map((src, index) => (
          <MediaPreviewFrame key={`${src}-${index}`} aspectRatio="auto">
            <MediaPreviewImage alt="" src={src} />
          </MediaPreviewFrame>
        ))}
      </Stack>
    );
  }

  return (
    <Scrollable.Root style={{ contain: "inline-size" }}>
      <Scrollable.Viewport autosize scrollbars="x" offsetScrollbars="x">
        <Group wrap="nowrap" gap="sm">
          {images.map((src, index) => (
            <MediaPreviewFrame key={`${src}-${index}`} aspectRatio="auto">
              <MediaPreviewImage alt="" src={src} />
            </MediaPreviewFrame>
          ))}
        </Group>
      </Scrollable.Viewport>
    </Scrollable.Root>
  );
}
