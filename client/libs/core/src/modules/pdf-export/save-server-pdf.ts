// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FetchService } from "@myoxus/core/modules/server";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { I18n } from "@myoxus/i18n";
import { download } from "@virgultum/editor/widgets/linked-doc";

/** Keep readable Unicode while reserving space for the extension on native filesystems. */
export function pdfFilename(
  title: string,
  date: string,
  version?: string,
): string {
  const clean = (value: string) =>
    value.replace(/[\p{Cc}/\\?%*:|"<>]/gu, "-").replace(/[. ]+$/g, "");
  const truncate = (value: string, limit: number) => {
    let result = "";
    for (const character of value) {
      if (new TextEncoder().encode(result + character).length > limit) break;
      result += character;
    }
    return result;
  };
  // Reserve the suffix before shortening long titles, so version/date survive.
  const suffix = truncate(
    clean([version, date].filter(Boolean).join("-")),
    160,
  );
  const titleLimit = 240 - new TextEncoder().encode(suffix).length - 1;
  const base = `${truncate(clean(title || "export"), titleLimit) || "export"}-${suffix}`;

  return `${base || "export"}.pdf`;
}

/** Fetch through the owning server session; Main receives complete bytes only. */
export async function saveServerPdf(
  fetchService: Pick<FetchService, "fetch">,
  url: string,
  filename: string,
): Promise<boolean> {
  try {
    const response = await fetchService.fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error("PDF download failed");
    const blob = await response.blob();
    if (BUILD_CONFIG.isElectron) {
      const bridge = getDesktopBridge();
      if (!bridge) throw new Error("Native PDF saving is unavailable");
      return (
        (await bridge.apis.ui.savePdf(filename, await blob.arrayBuffer()))
          .status === "saved"
      );
    }
    download(blob, filename);
    return true;
  } catch (cause) {
    // Native download and file errors share the existing localized UI message.
    if (!BUILD_CONFIG.isElectron) throw cause;
    throw new Error(I18n.t("com.myoxus.pdf-export.dialog.error.failed"), {
      cause,
    });
  }
}
