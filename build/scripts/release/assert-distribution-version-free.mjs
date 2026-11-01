#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from "node:url";
export async function assertVersionFree(scope, version, fetchImpl = fetch) {
  if (
    !["containers", "clients"].includes(scope) ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)
  )
    throw new Error("Expected component scope and semantic version");
  const origin = "https://git.blume29.de";
  const request = (url, options = {}) =>
    fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
  if (scope === "clients") {
    for (const platform of ["linux", "windows", "macos"]) {
      const response = await request(
        `${origin}/api/v1/repos/myoxus/packages/releases/tags/${platform}-client-v${version}`,
      );
      if (response.status === 200)
        throw new Error(
          `Desktop version ${version} already has published ${platform} artifacts`,
        );
      if (response.status !== 404)
        throw new Error(
          `Cannot verify desktop reservation: HTTP ${response.status}`,
        );
    }
  } else {
    for (const name of [
      "myoxus",
      "myoxus-web-frontend",
      "myoxus-admin-frontend",
    ]) {
      const tokenResponse = await request(
        `${origin}/v2/token?service=container_registry&scope=${encodeURIComponent(`repository:myoxus/${name}:pull`)}`,
      );
      if (!tokenResponse.ok)
        throw new Error("Cannot obtain registry read authorization");
      const payload = await tokenResponse.json();
      const token = payload.token ?? payload.access_token;
      if (!token) throw new Error("Registry did not return read authorization");
      const response = await request(
        `${origin}/v2/myoxus/${name}/manifests/${version}`,
        {
          method: "HEAD",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept:
              "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          },
        },
      );
      if (response.status === 200)
        throw new Error(
          `Container version ${version} already has published ${name} artifacts`,
        );
      if (response.status !== 404)
        throw new Error(
          `Cannot verify container reservation: HTTP ${response.status}`,
        );
    }
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await assertVersionFree(...process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
