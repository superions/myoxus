#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = process.cwd();

const checkedPaths = [
  "build/web/Dockerfile",
  "build/web/Dockerfile.prebuilt",
  "build/admin/Dockerfile",
  "build/admin/Dockerfile.prebuilt",
  "client/libs/icons/src/assets/platform/browser-favicon.svg",
  "build/scripts/frontends/materialize-static-artifacts.sh",
  "build/scripts/frontends/render-basepath-nginx.sh",
  "build/scripts/frontends/verify-public-static-root.sh",
  "build/scripts/release/write-release-identity.mjs",
  "build/scripts/release/release-containers.sh",
  "build/server/docker-compose.selfhost.yml",
  "build/server/docker-compose.registry.yml",
  "build/server/docker-stack.registry.yml",
  "client/frontends/nginx/myoxus.conf",
  ".forgejo/workflows/release-linux.yml",
  ".dockerignore",
  "tools/utils/src/workspace.gen.ts",
  "client/libs/core/package.json",
  "client/libs/core/tsconfig.json",
  "client/libs/desktop-api-contract/package.json",
  "client/libs/desktop-api-contract/tsconfig.json",
  "docs/ops/deployment/docker.md",
  "docs/ops/deployment/swarm.md",
  "docs/ops/deployment/prebuilt-images.md",
  "docs/ops/getting-started/installation.md",
  "docs/ops/runbooks/README.md",
  "docs/dev/clients/adminfrontend/deployment.md",
  "docs/dev/clients/webfrontend/architecture.md",
  "docs/dev/node-version-policy.md",
  "docs/dev/tooling-scripts-tests-audit.md",
];

const read = (root, path) => readFileSync(join(root, path), "utf8");

function assertAbsent(failures, root, path, patterns) {
  const text = read(root, path);
  for (const pattern of patterns) {
    if (
      pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)
    ) {
      failures.push(`${path} must not contain ${pattern.toString()}`);
    }
  }
}

function assertPresent(failures, root, path, patterns) {
  const text = read(root, path);
  for (const pattern of patterns) {
    if (
      !(pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern))
    ) {
      failures.push(`${path} must contain ${pattern.toString()}`);
    }
  }
}

function assertExists(failures, root, path) {
  if (!existsSync(join(root, path))) {
    failures.push(`${path} must exist`);
  }
}

function assertStaticArtifactDockerfile(failures, root, path, role) {
  assertPresent(failures, root, path, [
    "FROM scratch AS artifact",
    `/myoxus-artifact/${role}/`,
  ]);
  assertAbsent(failures, root, path, [
    /^FROM nginx:/m,
    "/etc/nginx/",
    /^EXPOSE\s/m,
    /^CMD\s/m,
    /^ENTRYPOINT\s/m,
    "/usr/share/nginx/",
  ]);
}

function collectFailures(root) {
  const failures = [];
  const forbiddenPaths = [
    "build/web/Dockerfile.combined",
    "build/frontends/Dockerfile.gateway",
    "client/frontends/nginx.conf",
    "client/frontends/nginx/web.conf",
    "client/frontends/nginx/admin.conf",
    "client/frontends/nginx/gateway.conf",
  ];
  for (const path of forbiddenPaths) {
    if (existsSync(join(root, path))) {
      failures.push(`${path} must not exist`);
    }
  }
  if (existsSync(join(root, "client/libs/electron-api"))) {
    failures.push(
      "client/libs/electron-api must not exist; use the platform-neutral desktop-api-contract package",
    );
  }

  const nginxDir = join(root, "client/frontends/nginx");
  if (existsSync(nginxDir)) {
    const configs = readdirSync(nginxDir).filter((name) =>
      name.endsWith(".conf"),
    );
    if (configs.length !== 1 || configs[0] !== "myoxus.conf") {
      failures.push(
        `client/frontends/nginx must contain only myoxus.conf, found: ${configs.join(", ") || "none"}`,
      );
    }
  }

  assertStaticArtifactDockerfile(failures, root, "build/web/Dockerfile", "web");
  assertStaticArtifactDockerfile(
    failures,
    root,
    "build/web/Dockerfile.prebuilt",
    "web",
  );
  assertStaticArtifactDockerfile(
    failures,
    root,
    "build/admin/Dockerfile",
    "admin",
  );
  assertStaticArtifactDockerfile(
    failures,
    root,
    "build/admin/Dockerfile.prebuilt",
    "admin",
  );

  assertPresent(failures, root, "build/web/Dockerfile", [
    "verify-public-static-root.sh /out/frontends/web",
  ]);
  assertPresent(failures, root, "build/admin/Dockerfile", [
    "verify-public-static-root.sh /out/frontends/admin",
  ]);

  for (const path of [
    "build/web/Dockerfile",
    "build/web/Dockerfile.prebuilt",
  ]) {
    assertPresent(failures, root, path, [
      "org.opencontainers.image.version",
      "org.opencontainers.image.source",
      "/myoxus-artifact/release.json",
      "client/frontends/nginx/myoxus.conf /myoxus-artifact/deployment/nginx/myoxus.conf",
      "materialize-static-artifacts.sh /myoxus-artifact/deployment/materialize-static-artifacts.sh",
      "verify-public-static-root.sh /myoxus-artifact/deployment/verify-public-static-root.sh",
      "prepare-swarm-state.sh /myoxus-artifact/deployment/prepare-swarm-state.sh",
      "docker-stack.registry.yml /myoxus-artifact/deployment/docker-stack.registry.yml",
      "docker-compose.selfhost.yml /myoxus-artifact/deployment/docker-compose.selfhost.yml",
      "client/libs/icons/src/assets/platform/browser-favicon.svg /myoxus-artifact/canonical-style/product-mark.svg",
    ]);
  }
  assertExists(
    failures,
    root,
    "client/libs/icons/src/assets/platform/browser-favicon.svg",
  );
  for (const path of [
    "build/admin/Dockerfile",
    "build/admin/Dockerfile.prebuilt",
  ]) {
    assertPresent(failures, root, path, [
      "org.opencontainers.image.version",
      "org.opencontainers.image.source",
      "/myoxus-artifact/release.json",
    ]);
    assertAbsent(failures, root, path, [
      "deployment/nginx",
      "docker-stack.registry.yml",
    ]);
  }
  for (const path of [
    "build/web/Dockerfile",
    "build/web/Dockerfile.prebuilt",
    "build/admin/Dockerfile",
    "build/admin/Dockerfile.prebuilt",
  ]) {
    assertAbsent(failures, root, path, ["org.opencontainers.image.licenses"]);
  }

  assertPresent(
    failures,
    root,
    "build/scripts/frontends/materialize-static-artifacts.sh",
    [
      "docker create",
      "docker cp",
      "org.opencontainers.image.version",
      "release.json does not match its OCI release identity",
      "deployment/nginx/myoxus.conf",
      "verify-public-static-root.sh",
      "deployment/prepare-swarm-state.sh",
      'chmod -R a+rX "$STAGE_DIR"',
      "materialized static frontend artifacts",
    ],
  );

  assertPresent(
    failures,
    root,
    "build/scripts/frontends/verify-public-static-root.sh",
    ["sourceMappingURL", "-name '*.map'"],
  );

  assertPresent(failures, root, "client/frontends/nginx/myoxus.conf", [
    "root /usr/share/nginx/frontends/web;",
    "root /usr/share/nginx/frontends/admin;",
    "proxy_pass http://myoxus_api",
    "include /etc/nginx/basepath-extra.conf;",
    /location = \/ready \{[^}]*proxy_pass http:\/\/myoxus_api\/ready;/,
  ]);
  assertPresent(
    failures,
    root,
    "build/scripts/frontends/render-basepath-nginx.sh",
    [
      "location = ${BASE_PATH}/ready {",
      "rewrite ^${BASE_PATH}/ready$ /ready break;",
    ],
  );
  assertAbsent(failures, root, "client/frontends/nginx/myoxus.conf", [
    "upstream myoxus_web",
    "upstream myoxus_admin",
    "proxy_pass http://myoxus_web",
    "proxy_pass http://myoxus_admin",
  ]);

  assertPresent(failures, root, "build/server/docker-compose.selfhost.yml", [
    /^ {2}frontend:$/m,
    "image: ${MYOXUS_NGINX_IMAGE:-nginx:stable-alpine}",
    "MYOXUS_FRONTEND_ASSET_ROOT",
    "/deployment/nginx/myoxus.conf:/etc/nginx/myoxus.conf.template:ro",
    "MYOXUS_QA_ARTIFACT_DIR:-../../playwright/.qa}:/usr/share/nginx/qa:ro",
  ]);
  assertAbsent(failures, root, "build/server/docker-compose.selfhost.yml", [
    /^ {2}web-frontend:$/m,
    /^ {2}admin-frontend:$/m,
    /^ {2}frontends-gateway:$/m,
    "Dockerfile.gateway",
    ":/usr/share/nginx/frontends/qa:ro",
  ]);

  assertPresent(failures, root, "build/server/docker-stack.registry.yml", [
    /^ {2}frontend:$/m,
    "image: ${MYOXUS_NGINX_IMAGE:-nginx:stable-alpine}",
    "MYOXUS_FRONTEND_ASSET_ROOT",
    "/deployment/nginx/myoxus.conf",
  ]);
  assertAbsent(failures, root, "build/server/docker-stack.registry.yml", [
    /^ {2}web-frontend:$/m,
    /^ {2}admin-frontend:$/m,
    /^ {2}frontends-gateway:$/m,
    "myoxus-frontends-gateway",
  ]);

  assertPresent(failures, root, "build/server/docker-compose.registry.yml", [
    "MYOXUS_SERVER_IMAGE_TAG",
  ]);
  assertAbsent(failures, root, "build/server/docker-compose.registry.yml", [
    "myoxus-web-frontend",
    "myoxus-admin-frontend",
    "myoxus-frontends-gateway",
  ]);

  assertPresent(failures, root, ".forgejo/workflows/release-linux.yml", [
    '      - "server-v*"',
    '      - "frontends-v*"',
    "artifact: web-frontend",
    "artifact: admin-frontend",
    "frontend.container-isolation",
    "Accept and promote container images",
    "accept-and-promote-container-images.sh",
    "reconcile-registry",
  ]);
  assertAbsent(failures, root, ".forgejo/workflows/release-linux.yml", [
    "artifact: frontends-gateway",
    "myoxus-frontends-gateway",
    "Dockerfile.gateway",
  ]);
  assertPresent(failures, root, "build/scripts/ci/build-container-image.sh", [
    'docker push "$commit_image"',
  ]);
  assertAbsent(failures, root, "build/scripts/ci/build-container-image.sh", [
    'docker push "$release_image"',
    '--tag "$release_image"',
  ]);

  assertPresent(failures, root, "build/scripts/release/release-containers.sh", [
    "local -a images=(myoxus myoxus-web-frontend myoxus-admin-frontend)",
    "resolve_component_commit",
    'REGISTRY_NAMESPACE="myoxus"',
  ]);
  assertPresent(failures, root, ".dockerignore", [
    "/build/server/runtime-frontends",
  ]);
  assertAbsent(failures, root, "build/scripts/release/release-containers.sh", [
    "myoxus-frontends-gateway",
    "MYOXUS_REGISTRY_NAMESPACE",
    "three frontend image jobs",
    "component tags do not point to the same commit",
  ]);

  assertAbsent(failures, root, "tools/utils/src/workspace.gen.ts", [
    "@myoxus/electron-api",
    "client/libs/electron-api",
  ]);
  assertPresent(failures, root, "tools/utils/src/workspace.gen.ts", [
    '"location": "client/libs/desktop-api-contract"',
    '"name": "@myoxus/desktop-api-contract"',
  ]);
  assertAbsent(
    failures,
    root,
    "client/libs/desktop-api-contract/package.json",
    ['"@myoxus/electron"', "@myoxus/electron-api", '"./web-worker"'],
  );
  assertAbsent(
    failures,
    root,
    "client/libs/desktop-api-contract/tsconfig.json",
    ["../../apps/electron"],
  );
  assertAbsent(failures, root, "client/libs/core/package.json", [
    "@myoxus/electron-api",
  ]);
  assertAbsent(failures, root, "client/libs/core/tsconfig.json", [
    "../electron-api",
  ]);

  const activeDocs = checkedPaths.filter((path) => path.startsWith("docs/"));
  for (const path of activeDocs) {
    assertAbsent(failures, root, path, [
      "build/frontends/Dockerfile.gateway",
      "client/frontends/nginx/gateway.conf",
      "MYOXUS_FRONTENDS_GATEWAY_DOCKERFILE",
      "myoxus-frontends-gateway",
      "frontends-gateway",
      "same Nginx as the web frontend",
    ]);
  }

  return failures;
}

function copyFixture(targetRoot) {
  for (const path of checkedPaths) {
    const from = join(repoRoot, path);
    const to = join(targetRoot, path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

function runSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "myoxus-fbi-guard-"));
  try {
    copyFixture(fixture);
    if (collectFailures(fixture).length !== 0) {
      throw new Error("clean fixture unexpectedly failed");
    }

    writeFileSync(
      join(fixture, "build/web/Dockerfile"),
      `${read(fixture, "build/web/Dockerfile")}\nFROM nginx:stable-alpine\n`,
    );
    if (
      !collectFailures(fixture).some((failure) =>
        failure.includes("FROM nginx"),
      )
    ) {
      throw new Error("frontend Nginx regression was not detected");
    }

    writeFileSync(
      join(fixture, "client/frontends/nginx/gateway.conf"),
      "server {}\n",
    );
    if (
      !collectFailures(fixture).some((failure) =>
        failure.includes("gateway.conf"),
      )
    ) {
      throw new Error("second Nginx config regression was not detected");
    }

    rmSync(
      join(
        fixture,
        "client/libs/icons/src/assets/platform/browser-favicon.svg",
      ),
    );
    if (
      !collectFailures(fixture).some((failure) =>
        failure.includes("browser-favicon.svg must exist"),
      )
    ) {
      throw new Error("missing product mark source was not detected");
    }

    console.log("[PASS] frontend container isolation guard self-test");
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const failures = collectFailures(repoRoot);
if (failures.length > 0) {
  console.error("[FAIL] frontend container isolation guard failed");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("[PASS] frontend container isolation guard");
