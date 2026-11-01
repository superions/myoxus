import { EmbedIframeConfigExtension } from "@virgultum/shared/services";

const GENERIC_DEFAULT_WIDTH_IN_SURFACE = 800;
const GENERIC_DEFAULT_HEIGHT_IN_SURFACE = 600;
const GENERIC_DEFAULT_WIDTH_PERCENT = 100;
const GENERIC_DEFAULT_HEIGHT_IN_NOTE = 400;

/**
 * Product application hosts that must never be treated as arbitrary embeds.
 *
 * The historical hosts remain negative-match inputs so persisted links cannot
 * bypass this boundary merely because they predate the current product name.
 */
const NON_EMBEDDABLE_PRODUCT_DOMAINS = [
  "app.myoxus.de",
  "insider.myoxus.de",
  "toeverything.app",
  "apple.getaffineapp.com",
];

/**
 * Validates if a URL is suitable for generic iframe embedding
 * Allows HTTPS URLs but excludes Myoxus domains
 * @param url The URL to validate
 * @returns Boolean indicating if the URL can be generically embedded
 */
function isValidGenericEmbedUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);

    // Only allow HTTPS for security
    if (parsedUrl.protocol !== "https:") {
      return false;
    }

    // Exclude current and historical product application hosts.
    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      NON_EMBEDDABLE_PRODUCT_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      )
    ) {
      return false;
    }

    return true;
  } catch {
    // Invalid URL
    return false;
  }
}

const genericConfig = {
  name: "generic",
  match: (url: string) => isValidGenericEmbedUrl(url),
  buildOEmbedUrl: (url: string) => {
    if (!isValidGenericEmbedUrl(url)) {
      return undefined;
    }
    return url;
  },
  useOEmbedUrlDirectly: true,
  options: {
    widthInSurface: GENERIC_DEFAULT_WIDTH_IN_SURFACE,
    heightInSurface: GENERIC_DEFAULT_HEIGHT_IN_SURFACE,
    widthPercent: GENERIC_DEFAULT_WIDTH_PERCENT,
    heightInNote: GENERIC_DEFAULT_HEIGHT_IN_NOTE,
    allowFullscreen: true,
    style: "border: none; border-radius: 8px;",
    allow: "",
    referrerpolicy: "no-referrer-when-downgrade",
    sandbox: "allow-scripts",
  },
};

export const GenericEmbedConfig = EmbedIframeConfigExtension(genericConfig);
