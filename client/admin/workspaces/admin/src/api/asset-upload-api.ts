// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { adminFetch } from "../fetch-utils";

function currentSubPath() {
  const env = (globalThis as { environment?: { subPath?: string } })
    .environment;
  return typeof env?.subPath === "string"
    ? env.subPath.replace(/\/+$/, "")
    : "";
}

export async function uploadBrandingAsset({
  slot,
  file,
}: {
  slot: string;
  file: File;
}): Promise<Response> {
  const formData = new FormData();
  formData.append("slot", slot);
  formData.append("file", file);

  return adminFetch(`${currentSubPath()}/api/admin/branding/upload`, {
    method: "POST",
    body: formData,
    admin: {
      channel: "technical-http",
      operationName: `brandingAssetUpload:${slot}`,
    },
  });
}
