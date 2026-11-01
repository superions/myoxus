/**
 * Canonical PDF export color profile options.
 *
 * Workspace defaults still persist the V2 enum strings consumed by
 * RenderContext (`sRGB`, `CMYK_FOGRA39`, `CMYK_SWOP`). The ICC library exposes
 * concrete server-side profile rows. These helpers bridge both views without
 * inventing options that the server has not seeded or an admin has not loaded.
 */

export type PdfExportColorProfileValue = "sRGB" | "CMYK_FOGRA39" | "CMYK_SWOP";

export interface PdfIccProfileLike {
  name: string;
  profileType: "sRGB" | "CMYK";
}

export interface PdfExportColorProfileOption {
  value: PdfExportColorProfileValue;
  label: string;
}

const FALLBACK_OPTIONS: PdfExportColorProfileOption[] = [
  { value: "sRGB", label: "sRGB" },
  { value: "CMYK_FOGRA39", label: "CMYK FOGRA39" },
  { value: "CMYK_SWOP", label: "CMYK SWOP" },
];

function mapProfileName(
  profile: PdfIccProfileLike,
): PdfExportColorProfileOption | null {
  const name = profile.name.toLocaleLowerCase();
  if (profile.profileType === "sRGB" || name.includes("srgb")) {
    return { value: "sRGB", label: profile.name };
  }
  if (name.includes("swop")) {
    return { value: "CMYK_SWOP", label: profile.name };
  }
  if (name.includes("fogra39") || name.includes("fogra 39")) {
    return { value: "CMYK_FOGRA39", label: profile.name };
  }
  return null;
}

export function buildColorProfileOptions(
  profiles: PdfIccProfileLike[],
  selectedValue?: string | null,
): PdfExportColorProfileOption[] {
  const byValue = new Map<
    PdfExportColorProfileValue,
    PdfExportColorProfileOption
  >();

  for (const profile of profiles) {
    const option = mapProfileName(profile);
    if (option && !byValue.has(option.value)) {
      byValue.set(option.value, option);
    }
  }

  // Keep currently persisted values selectable while a deployment is being
  // upgraded and before the corresponding system profile has been seeded.
  const selectedFallback = FALLBACK_OPTIONS.find(
    (option) => option.value === selectedValue,
  );
  if (selectedFallback && !byValue.has(selectedFallback.value)) {
    byValue.set(selectedFallback.value, selectedFallback);
  }

  if (byValue.size === 0) {
    return FALLBACK_OPTIONS;
  }

  return FALLBACK_OPTIONS.filter((option) => byValue.has(option.value)).map(
    (option) => byValue.get(option.value) ?? option,
  );
}
