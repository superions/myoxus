// SPDX-License-Identifier: AGPL-3.0-or-later

// Store/adapters need these identities without evaluating view services or icons.
// Re-export the original bindings so data and mounted editors share one DI scope.
export * from "./block-meta-service";
export * from "./doc-embed-service";
export * from "./document-index";
export * from "./embed-iframe";
export * from "./feature-flag-service";
export * from "./i18n-service";
export * from "./parse-url-service";
export * from "./telemetry-service";
export * from "./theme-service";
