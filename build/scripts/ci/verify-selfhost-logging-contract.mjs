#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const composePath = "build/server/docker-compose.selfhost.yml";
const smokePath = "build/scripts/server/smoke-api.sh";
const devFullstackPath = "build/scripts/server/dev-fullstack.sh";
const serviceNames = [
  "postgres",
  "redis",
  "verapdf",
  "pdf-fonts-init",
  "api",
  "frontend",
];

const read = (path) => readFileSync(join(repoRoot, path), "utf8");

function composeServiceBlocks(compose) {
  const servicesStart = compose.indexOf("services:\n");
  const volumesStart = compose.indexOf("\nvolumes:\n", servicesStart);
  if (servicesStart === -1 || volumesStart === -1) {
    return new Map();
  }

  const body = compose.slice(
    servicesStart + "services:\n".length,
    volumesStart,
  );
  const headers = [...body.matchAll(/^  ([a-z0-9-]+):\s*$/gm)];
  return new Map(
    headers.map((header, index) => {
      const start = header.index;
      const end = headers[index + 1]?.index ?? body.length;
      return [header[1], body.slice(start, end)];
    }),
  );
}

function collectFailures(compose, smoke, devFullstack) {
  const failures = [];
  const blocks = composeServiceBlocks(compose);

  for (const required of [
    "x-logging: &default-logging",
    "driver: json-file",
    "max-size: 10m",
    'max-file: "5"',
  ]) {
    if (!compose.includes(required)) {
      failures.push(`${composePath} must contain ${required}`);
    }
  }

  if (compose.includes("MYOXUS__LOGGING__LEVEL")) {
    failures.push(
      `${composePath} must leave logging.level to mounted server configuration`,
    );
  }
  if (compose.includes("${MYOXUS_LOG_LEVEL:-trace}")) {
    failures.push(
      `${composePath} must not default the long-lived stack to TRACE`,
    );
  }

  for (const serviceName of serviceNames) {
    const block = blocks.get(serviceName);
    if (!block) {
      failures.push(`${composePath} is missing service ${serviceName}`);
    } else if (!/^    logging: \*default-logging$/m.test(block)) {
      failures.push(
        `${composePath} service ${serviceName} must use bounded logs`,
      );
    }
  }

  for (const required of [
    ".HostConfig.LogConfig.Type",
    '{{with index .HostConfig.LogConfig.Config "max-size"}}{{.}}{{end}}',
    '{{with index .HostConfig.LogConfig.Config "max-file"}}{{.}}{{end}}',
    "MYOXUS__LOGGING__LEVEL|RUST_LOG",
    "SMOKE_ALLOW_TRACE_LOGGING",
    '"$API_URL/ready"',
    '"status":"ready"',
    "HTTP 200/ready",
  ]) {
    if (!smoke.includes(required)) {
      failures.push(`${smokePath} must contain ${required}`);
    }
  }
  for (const forbidden of [
    "TRACE logging NOT active",
    'grep -q "TRACE"',
    "TRACE-level logging active",
  ]) {
    if (smoke.includes(forbidden)) {
      failures.push(`${smokePath} must not contain ${forbidden}`);
    }
  }

  if (devFullstack.includes("MYOXUS_LOG_LEVEL:-trace")) {
    failures.push(`${devFullstackPath} must not default to global TRACE`);
  }
  if (!devFullstack.includes('DEFAULT_LOG_LEVEL="info,')) {
    failures.push(`${devFullstackPath} must define the normal INFO filter`);
  }

  return failures;
}

const compose = read(composePath);
const smoke = read(smokePath);
const devFullstack = read(devFullstackPath);
const failures = collectFailures(compose, smoke, devFullstack);

function gatewayLogFailures(config) {
  const format = config.match(/log_format\s+myoxus_main\s+([\s\S]*?);/)?.[1];
  if (!format) return ["gateway must define myoxus_main access logging"];
  const errors = [];
  if (!/error_log\s+\/dev\/null\s*;/.test(config)) {
    errors.push("gateway request errors can append raw URLs and Referer");
  }
  if (
    /\$(?:request|request_uri|args|query_string|http_referer)\b/.test(format)
  ) {
    errors.push("gateway access format includes query or Referer credentials");
  }
  for (const field of [
    "request_method",
    "myoxus_request_path",
    "status",
    "request_id",
    "request_time",
  ]) {
    if (!format.includes(`$${field}`))
      errors.push(`gateway access format is missing ${field}`);
  }
  return errors;
}

const gateway = read("client/frontends/nginx/myoxus.conf");
failures.push(...gatewayLogFailures(gateway));

const mutationChecks = [
  {
    name: "gateway restores unredacted request error logging",
    failures: gatewayLogFailures(gateway.replace("error_log /dev/null;", "")),
  },
  ...["request", "request_uri", "http_referer"].map((field) => ({
    name: `gateway restores credential-bearing ${field}`,
    failures: gatewayLogFailures(
      gateway.replace(
        "log_format myoxus_main '",
        `log_format myoxus_main '$${field} `,
      ),
    ),
  })),
  {
    name: "missing service rotation",
    failures: collectFailures(
      compose.replace("    logging: *default-logging\n", ""),
      smoke,
      devFullstack,
    ),
  },
  {
    name: "restored Compose TRACE default",
    failures: collectFailures(
      compose.replace(
        "      MYOXUS__LOGGING__FILE_PATH:",
        "      MYOXUS__LOGGING__LEVEL: ${MYOXUS_LOG_LEVEL:-trace}\n      MYOXUS__LOGGING__FILE_PATH:",
      ),
      smoke,
      devFullstack,
    ),
  },
  {
    name: "smoke test stops checking the log driver",
    failures: collectFailures(
      compose,
      smoke.replace(".HostConfig.LogConfig.Type", ".State.Status"),
      devFullstack,
    ),
  },
  {
    name: "smoke test stops checking readiness",
    failures: collectFailures(
      compose,
      smoke.replace('"$API_URL/ready"', '"$API_URL/health"'),
      devFullstack,
    ),
  },
  {
    name: "fullstack TRACE default returns",
    failures: collectFailures(
      compose,
      smoke,
      devFullstack.replace(
        "MYOXUS_LOG_LEVEL:-$DEFAULT_LOG_LEVEL",
        "MYOXUS_LOG_LEVEL:-trace",
      ),
    ),
  },
];

for (const mutation of mutationChecks) {
  if (mutation.failures.length === 0) {
    failures.push(`guard mutation was not detected: ${mutation.name}`);
  }
}

if (failures.length > 0) {
  console.error("Selfhost logging contract failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Selfhost logging contract passed for ${serviceNames.length} services and ${mutationChecks.length} negative fixtures.`,
);
