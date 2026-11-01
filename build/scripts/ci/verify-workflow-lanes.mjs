// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export function verifyWorkflowLanes(workflows) {
  const findings = [];
  if (workflows["live-ci.yml"])
    findings.push("live-ci.yml: generic merge verification was removed");
  for (const [name, source] of Object.entries(workflows)) {
    const releaseTags = ["release-linux.yml", "server-build.yml"].includes(
      name,
    );
    // Fail closed for mapping keys and scalar/list event declarations.
    // Full YAML semantics are covered by the integration contract fixtures.
    if (
      name !== "pr-check.yml" &&
      (/(?:^|[\s,{])["']?pull_request(?:_target)?["']?\s*:/.test(source) ||
        /^["']?on["']?\s*:\s*[^\n#]*\bpull_request(?:_target)?\b/m.test(
          source,
        ) ||
        /^\s*-\s*["']?pull_request(?:_target)?["']?\s*(?:#.*)?$/m.test(source))
    ) {
      findings.push(`${name}: only pr-check.yml may receive PR events`);
    }
    if (
      !releaseTags &&
      (/(?:^|[\s,{])["']?push["']?\s*:/.test(source) ||
        /^["']?on["']?\s*:\s*[^\n#]*\bpush\b/m.test(source) ||
        /^\s*-\s*["']?push["']?\s*(?:#.*)?$/m.test(source))
    ) {
      findings.push(
        `${name}: branch pushes must not repeat development verification`,
      );
    }
    if (releaseTags && /^\s+branches\s*:/m.test(source)) {
      findings.push(`${name}: publication push events must remain tag-only`);
    }
  }
  const pr = workflows["pr-check.yml"];
  if (!pr || !/^  pull_request:/m.test(pr))
    findings.push("pr-check.yml: missing PR entrypoint");
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workflows = Object.fromEntries(
    readdirSync(`${root}.forgejo/workflows`)
      .filter((name) => name.endsWith(".yml"))
      .map((name) => [
        name,
        readFileSync(`${root}.forgejo/workflows/${name}`, "utf8"),
      ]),
  );
  const findings = verifyWorkflowLanes(workflows);
  if (findings.length) {
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
  } else
    console.log(
      "Only PR source checks and explicit release tags run on source events; product verification is manual.",
    );
}
