// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReleaseIdentity } from "../release/write-release-identity.mjs";

export interface VerifyBuiltReleaseIdentityOptions {
  buildDirectory: string;
  rootVersion: string;
  distributionVersion?: string;
  role?: "web" | "admin";
  revision?: string;
  releaseIdentity?: ReleaseIdentity;
  imageLabels?: Record<string, string>;
  workerSource?: string;
}

export interface BuiltReleaseIdentity {
  role: "web" | "admin";
  rootVersion: string;
  distributionVersion?: string;
  revision?: string;
  storageWorker: string | null;
  workers: string[];
}

export interface VerifyStaticReleaseIdentityOptions {
  identity: ReleaseIdentity;
  role: "web" | "admin";
  version: string;
  revision: string;
}

export interface VerifyOciReleaseIdentityOptions {
  labels: Record<string, string>;
  role: "web" | "admin" | "server";
  version: string;
  revision: string;
}

export function verifyBuiltReleaseIdentity(
  options: VerifyBuiltReleaseIdentityOptions,
): BuiltReleaseIdentity;

export function verifyStaticReleaseIdentity(
  options: VerifyStaticReleaseIdentityOptions,
): ReleaseIdentity;

export function verifyOciReleaseIdentity(
  options: VerifyOciReleaseIdentityOptions,
): Record<string, string>;
