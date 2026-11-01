// SPDX-License-Identifier: AGPL-3.0-or-later

export type ReleaseRole = "web" | "admin" | "server";

export interface ClientReleaseIdentity {
  schemaVersion: 1;
  role: "web" | "admin";
  clientVersion: string;
  editorVersion: string;
  revision: string;
}

export interface ServerReleaseIdentity {
  schemaVersion: 1;
  role: "server";
  serverVersion: string;
  revision: string;
}

export type ReleaseIdentity = ClientReleaseIdentity | ServerReleaseIdentity;

export function resolveDeclaredReleaseVersion(options: {
  repoRoot: string;
  role: ReleaseRole;
}): string;

export function createReleaseIdentity(options: {
  role: ReleaseRole;
  version: string;
  revision: string;
}): ReleaseIdentity;

export function resolveReleaseIdentity(options: {
  repoRoot: string;
  role: ReleaseRole;
  revision: string;
  expectedVersion?: string;
}): ReleaseIdentity;

export function writeReleaseIdentity(options: {
  outputPath: string;
  identity: ReleaseIdentity;
}): void;
