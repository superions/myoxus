// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FeatureType } from "@myoxus/graphql";

function isAdminEditableWorkspaceFeature(feature: FeatureType): boolean {
  void feature;
  // No workspace feature is admin-editable until the server exposes a curated
  // product capability model with labels instead of compatibility enum names.
  return false;
}

/**
 * Workspace feature values currently exposed by the server are compatibility
 * signals for legacy client expectations, not a curated admin capability model.
 * Keep this function allow-list based so plan/quota-shaped enum values never
 * become visible admin controls just because the server advertises them.
 */
export function adminEditableWorkspaceFeatures(
  features: readonly FeatureType[],
): FeatureType[] {
  return features.filter(isAdminEditableWorkspaceFeature);
}

export function mergeEditableWorkspaceFeatureSelection(
  currentSelection: readonly FeatureType[],
  editableFeatures: readonly FeatureType[],
  nextEditableSelection: readonly FeatureType[],
): FeatureType[] {
  const editable = new Set(editableFeatures);
  const hiddenSelection = currentSelection.filter(
    (feature) => !editable.has(feature),
  );
  return [...new Set([...hiddenSelection, ...nextEditableSelection])];
}
