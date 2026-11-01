// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const UPDATE_FEED_PORT = 43443;
export const UPDATE_FEED_URL = `https://127.0.0.1:${UPDATE_FEED_PORT}/api/v1/repos/myoxus/packages/releases?page=1&limit=50`;

type UpdateFeedEvidence = {
  artifactRequests: number;
  bytesServed: number;
  manifestRequests: number;
  requestPaths?: string[];
  rangeRequests: number;
  releaseRequests: number;
};

export type LinuxUpdateFeedServer = {
  artifactName: string;
  artifactSize: number;
  caCertificatePath: string;
  certificateSpkiSha256: string;
  close: () => Promise<void>;
  evidence: () => UpdateFeedEvidence;
  feedUrl: string;
  version: string;
};

export type RealUpdateFeedServer = LinuxUpdateFeedServer & {
  artifactSha512: string;
};

export type RealUpdateFeedOptions = {
  artifactPath: string;
  channel: "beta" | "internal" | "stable";
  port: number;
  version: string;
};

async function runOpenSsl(args: string[], cwd: string): Promise<void> {
  await execFileAsync("openssl", args, { cwd });
}

async function createCertificateAuthority(directory: string): Promise<{
  caCertificatePath: string;
  certificatePath: string;
  privateKeyPath: string;
}> {
  const caCertificatePath = path.join(directory, "ca.crt");
  const caPrivateKeyPath = path.join(directory, "ca.key");
  const certificatePath = path.join(directory, "server.crt");
  const certificateRequestPath = path.join(directory, "server.csr");
  const privateKeyPath = path.join(directory, "server.key");
  const extensionPath = path.join(directory, "server.ext");

  await runOpenSsl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=Myoxus Electron E2E CA",
      "-keyout",
      caPrivateKeyPath,
      "-out",
      caCertificatePath,
    ],
    directory,
  );
  await runOpenSsl(
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-keyout",
      privateKeyPath,
      "-out",
      certificateRequestPath,
    ],
    directory,
  );
  await writeFile(
    extensionPath,
    [
      "basicConstraints=critical,CA:false",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "",
    ].join("\n"),
  );
  await runOpenSsl(
    [
      "x509",
      "-req",
      "-in",
      certificateRequestPath,
      "-CA",
      caCertificatePath,
      "-CAkey",
      caPrivateKeyPath,
      "-CAcreateserial",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensionPath,
      "-out",
      certificatePath,
    ],
    directory,
  );

  return { caCertificatePath, certificatePath, privateKeyPath };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function artifactContentType(name: string): string {
  if (name.endsWith(".deb")) return "application/vnd.debian.binary-package";
  if (name.endsWith(".rpm")) return "application/x-rpm";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".exe"))
    return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

/**
 * Serves one real N+1 package through the same Forgejo release and latest.yml
 * contract consumed by production. The caller owns artifact construction; this
 * fixture never fabricates package bytes or rewrites the package.
 */
export async function startRealUpdateFeedServer(
  options: RealUpdateFeedOptions,
): Promise<RealUpdateFeedServer> {
  const artifactName = path.basename(options.artifactPath);
  if (!path.isAbsolute(options.artifactPath)) {
    throw new Error("Update artifact path must be absolute");
  }
  if (!artifactName.includes(options.version)) {
    throw new Error(
      `Update artifact ${artifactName} does not contain target version ${options.version}`,
    );
  }
  const artifactSize = (await stat(options.artifactPath)).size;
  if (artifactSize <= 0) throw new Error("Update artifact must not be empty");
  const artifactSha512 = createHash("sha512")
    .update(await readFile(options.artifactPath))
    .digest("base64");
  const directory = await mkdtemp(
    path.join(tmpdir(), "myoxus-electron-real-update-"),
  );
  let server: Server | undefined;
  try {
    const certificates = await createCertificateAuthority(directory);
    const manifest = Buffer.from(
      [
        `version: ${options.version}`,
        "files:",
        `  - url: ${artifactName}`,
        `    sha512: ${artifactSha512}`,
        `    size: ${artifactSize}`,
        "releaseDate: 2026-07-23T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    const origin = `https://127.0.0.1:${options.port}`;
    const feedUrl = `${origin}/api/v1/repos/myoxus/packages/releases?page=1&limit=50`;
    const tag = `desktop-v${options.version}`;
    const downloadBase = `${origin}/myoxus/packages/releases/download/${tag}`;
    const releasePayload = Buffer.from(
      JSON.stringify([
        {
          tag_name: tag,
          name: `Myoxus Desktop ${options.version}`,
          body: "Ephemeral two-version Electron update evidence",
          draft: false,
          prerelease: options.channel !== "stable",
          published_at: "2026-07-23T00:00:00.000Z",
          assets: [
            {
              name: "latest.yml",
              size: manifest.length,
              browser_download_url: `${downloadBase}/latest.yml`,
            },
            {
              name: artifactName,
              size: artifactSize,
              browser_download_url: `${downloadBase}/${encodeURIComponent(artifactName)}`,
            },
          ],
        },
      ]),
    );
    const evidence: UpdateFeedEvidence = {
      artifactRequests: 0,
      bytesServed: 0,
      manifestRequests: 0,
      rangeRequests: 0,
      releaseRequests: 0,
      requestPaths: [],
    };
    const certificate = await readFile(certificates.certificatePath);
    const certificateSpkiSha256 = createHash("sha256")
      .update(
        new X509Certificate(certificate).publicKey.export({
          format: "der",
          type: "spki",
        }),
      )
      .digest("base64");

    server = createServer(
      {
        cert: certificate,
        key: await readFile(certificates.privateKeyPath),
      },
      async (request, response) => {
        const url = new URL(request.url ?? "/", origin);
        evidence.requestPaths?.push(url.pathname);
        if (
          url.pathname === "/api/v1/repos/myoxus/packages/releases" &&
          url.searchParams.get("page") === "1" &&
          url.searchParams.get("limit") === "50"
        ) {
          evidence.releaseRequests += 1;
          response.writeHead(200, {
            "content-length": releasePayload.length,
            "content-type": "application/json",
          });
          response.end(releasePayload);
          return;
        }
        if (
          url.pathname ===
          `/myoxus/packages/releases/download/${tag}/latest.yml`
        ) {
          evidence.manifestRequests += 1;
          response.writeHead(200, {
            "content-length": manifest.length,
            "content-type": "application/yaml",
          });
          response.end(manifest);
          return;
        }
        if (
          url.pathname ===
          `/myoxus/packages/releases/download/${tag}/${encodeURIComponent(artifactName)}`
        ) {
          evidence.artifactRequests += 1;
          const artifact = await readFile(options.artifactPath);
          const range = request.headers.range?.match(
            /^bytes=(\d+)(?:-(\d*))?$/,
          );
          const start = range ? Number(range[1]) : 0;
          const requestedEnd = range?.[2]
            ? Number(range[2])
            : artifact.length - 1;
          const end = Math.min(requestedEnd, artifact.length - 1);
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= artifact.length
          ) {
            response.writeHead(416, {
              "content-range": `bytes */${artifact.length}`,
            });
            response.end();
            return;
          }
          if (range) evidence.rangeRequests += 1;
          const body = artifact.subarray(start, end + 1);
          evidence.bytesServed += body.length;
          response.writeHead(range ? 206 : 200, {
            "accept-ranges": "bytes",
            "content-length": body.length,
            "content-type": artifactContentType(artifactName),
            ...(range
              ? {
                  "content-range": `bytes ${start}-${end}/${artifact.length}`,
                }
              : {}),
          });
          response.end(body);
          return;
        }
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      },
    );
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(options.port, "127.0.0.1", resolve);
    });

    return {
      artifactName,
      artifactSha512,
      artifactSize,
      caCertificatePath: certificates.caCertificatePath,
      certificateSpkiSha256,
      close: async () => {
        if (server) await closeServer(server);
        await rm(directory, { force: true, recursive: true });
      },
      evidence: () => ({
        ...evidence,
        requestPaths: [...(evidence.requestPaths ?? [])],
      }),
      feedUrl,
      version: options.version,
    };
  } catch (error) {
    if (server?.listening) await closeServer(server);
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export async function startLinuxUpdateFeedServer(): Promise<LinuxUpdateFeedServer> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "myoxus-electron-update-"),
  );
  let server: Server | undefined;
  try {
    const certificates = await createCertificateAuthority(directory);
    const version = "0.40.1";
    const artifactName = `myoxus-${version}-stable-linux-x64.deb`;
    const artifact = Buffer.alloc(8 * 1024 * 1024, 0x4d);
    const sha512 = createHash("sha512").update(artifact).digest("base64");
    const manifest = Buffer.from(
      [
        `version: ${version}`,
        "files:",
        `  - url: ${artifactName}`,
        `    sha512: ${sha512}`,
        `    size: ${artifact.length}`,
        "releaseDate: 2026-07-22T00:00:00.000Z",
        "",
      ].join("\n"),
    );
    const origin = `https://127.0.0.1:${UPDATE_FEED_PORT}`;
    const tag = `desktop-v${version}`;
    const downloadBase = `${origin}/myoxus/packages/releases/download/${tag}`;
    const releasePayload = Buffer.from(
      JSON.stringify([
        {
          tag_name: tag,
          name: `Myoxus Desktop ${version}`,
          body: "Ephemeral Linux updater fixture",
          draft: false,
          prerelease: false,
          published_at: "2026-07-22T00:00:00.000Z",
          assets: [
            {
              name: "latest.yml",
              size: manifest.length,
              browser_download_url: `${downloadBase}/latest.yml`,
            },
            {
              name: artifactName,
              size: artifact.length,
              browser_download_url: `${downloadBase}/${artifactName}`,
            },
          ],
        },
      ]),
    );
    const evidence: UpdateFeedEvidence = {
      artifactRequests: 0,
      bytesServed: 0,
      manifestRequests: 0,
      rangeRequests: 0,
      releaseRequests: 0,
    };
    const certificate = await readFile(certificates.certificatePath);
    const certificateSpkiSha256 = createHash("sha256")
      .update(
        new X509Certificate(certificate).publicKey.export({
          format: "der",
          type: "spki",
        }),
      )
      .digest("base64");

    server = createServer(
      {
        cert: certificate,
        key: await readFile(certificates.privateKeyPath),
      },
      (request, response) => {
        const url = new URL(request.url ?? "/", origin);
        if (
          url.pathname === "/api/v1/repos/myoxus/packages/releases" &&
          url.searchParams.get("page") === "1" &&
          url.searchParams.get("limit") === "50"
        ) {
          evidence.releaseRequests += 1;
          response.writeHead(200, {
            "content-length": releasePayload.length,
            "content-type": "application/json",
          });
          response.end(releasePayload);
          return;
        }

        if (
          url.pathname ===
          `/myoxus/packages/releases/download/${tag}/latest.yml`
        ) {
          evidence.manifestRequests += 1;
          response.writeHead(200, {
            "content-length": manifest.length,
            "content-type": "application/yaml",
          });
          response.end(manifest);
          return;
        }

        if (
          url.pathname ===
          `/myoxus/packages/releases/download/${tag}/${artifactName}`
        ) {
          evidence.artifactRequests += 1;
          const range = request.headers.range?.match(/^bytes=(\d+)-$/);
          const start = range ? Number(range[1]) : 0;
          if (range) evidence.rangeRequests += 1;
          const body = artifact.subarray(start);

          const headers: Record<string, number | string> = {
            "accept-ranges": "bytes",
            "content-length": body.length,
            "content-type": "application/vnd.debian.binary-package",
          };
          if (start > 0) {
            headers["content-range"] =
              `bytes ${start}-${artifact.length - 1}/${artifact.length}`;
          }
          response.writeHead(start > 0 ? 206 : 200, headers);

          const chunkSize = 64 * 1024;
          let offset = 0;
          const writeChunk = () => {
            const chunk = body.subarray(offset, offset + chunkSize);
            if (chunk.length === 0) {
              response.end();
              return;
            }
            offset += chunk.length;
            evidence.bytesServed += chunk.length;
            response.write(chunk);
            setTimeout(writeChunk, 10);
          };
          writeChunk();
          return;
        }

        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      },
    );

    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(UPDATE_FEED_PORT, "127.0.0.1", resolve);
    });

    return {
      artifactName,
      artifactSize: artifact.length,
      caCertificatePath: certificates.caCertificatePath,
      certificateSpkiSha256,
      close: async () => {
        if (server) await closeServer(server);
        await rm(directory, { force: true, recursive: true });
      },
      evidence: () => ({ ...evidence }),
      feedUrl: UPDATE_FEED_URL,
      version,
    };
  } catch (error) {
    if (server?.listening) await closeServer(server);
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}
