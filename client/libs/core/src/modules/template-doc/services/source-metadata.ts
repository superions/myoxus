// SPDX-License-Identifier: AGPL-3.0-or-later
import index from "../generated/document-bundles.json";
import type { PreparedNativeBundle } from "./native-bundle";

export type TemplateTitlePolicy = "template" | "template-date" | "date";
export interface TemplateSourceClassification {
  category: string | null;
  tags: readonly string[];
}
export type BuiltinCategory =
  | "journal-daily"
  | "meeting"
  | "review-weekly"
  | "review-sprint"
  | "hybrid"
  | "onboarding"
  | "notebook";

export interface ResolvedTemplateSourceMetadata {
  slug: string;
  source: "builtin" | "bundle" | "custom";
  category: string | null;
  tags: readonly string[];
  titlePolicy: TemplateTitlePolicy;
  purpose: "template" | "guide";
}

export type NativeDocumentBundle = PreparedNativeBundle;

export const nativeDocumentBundles = index.entries as NativeDocumentBundle[];
export const onboardingDocumentSlugs: readonly string[] = index.onboarding;
export const retiredDocumentSlugs: readonly string[] = index.retired;

export const isBuildingBlockCategory = (category: string | null | undefined) =>
  category === "building-blocks";

export function customSourceMetadata(
  docId: string,
  classification:
    { category: string | null; tags: readonly string[] | null } | undefined,
): ResolvedTemplateSourceMetadata {
  return {
    slug: docId,
    source: "custom",
    category: classification?.category ?? null,
    tags: classification?.tags ?? [],
    titlePolicy: "template",
    purpose: "template",
  };
}

export function nativeSourceMetadata(
  slug: string,
): ResolvedTemplateSourceMetadata | undefined {
  const bundle = nativeDocumentBundles.find(
    (entry) => entry.template_id === slug,
  );
  if (bundle)
    return {
      slug,
      source: "bundle",
      category: bundle.category ?? null,
      tags: bundle.tags ?? [],
      titlePolicy: bundle.title_policy ?? "template",
      purpose: bundle.purpose ?? "template",
    };
  return undefined;
}
