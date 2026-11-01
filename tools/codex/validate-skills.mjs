#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function option(name, fallback = undefined) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1] ?? fallback;
    if (args[index].startsWith(prefix)) return args[index].slice(prefix.length);
  }
  return fallback;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: validate-skills.mjs [--repo <repo-root>] [--json]`);
  process.exit(0);
}

const defaultRepo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repo = path.resolve(option("--repo", defaultRepo));
const skillsRoot = path.join(repo, ".agents/skills");
const failures = [];

function fail(file, message) {
  failures.push({ file: path.relative(repo, file), message });
}

function walkFiles(root) {
  const result = [];
  if (!existsSync(root)) return result;
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) result.push(...walkFiles(full));
    else result.push(full);
  }
  return result;
}

function parseFrontmatter(file, source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    fail(file, "missing YAML frontmatter");
    return null;
  }
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z_]+):\s*(.*)$/);
    if (field) fields[field[1]] = field[2].trim();
  }
  const names = Object.keys(fields);
  for (const required of ["name", "description"]) {
    if (!fields[required]) fail(file, `frontmatter lacks ${required}`);
  }
  for (const name of names) {
    if (!["name", "description"].includes(name)) {
      fail(file, `unsupported frontmatter field: ${name}`);
    }
  }
  return fields;
}

if (!existsSync(skillsRoot)) {
  console.error(`skills root does not exist: ${skillsRoot}`);
  process.exit(1);
}

const skillDirs = readdirSync(skillsRoot)
  .map((name) => path.join(skillsRoot, name))
  .filter((entry) => statSync(entry).isDirectory())
  .sort();
const names = new Map();

for (const skillDir of skillDirs) {
  const folder = path.basename(skillDir);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    fail(skillDir, "missing SKILL.md");
    continue;
  }
  const source = readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(skillFile, source);
  if (frontmatter) {
    if (frontmatter.name !== folder) {
      fail(
        skillFile,
        `name ${frontmatter.name} does not match folder ${folder}`,
      );
    }
    if (!/^[a-z0-9-]{1,64}$/.test(frontmatter.name)) {
      fail(
        skillFile,
        "name must be lowercase hyphen-case and at most 64 characters",
      );
    }
    if (names.has(frontmatter.name)) {
      fail(
        skillFile,
        `duplicate skill name also used by ${names.get(frontmatter.name)}`,
      );
    }
    names.set(frontmatter.name, path.relative(repo, skillFile));
  }
  if (source.split(/\r?\n/).length > 500) {
    fail(skillFile, "SKILL.md exceeds 500 lines");
  }

  const metadataFile = path.join(skillDir, "agents/openai.yaml");
  if (!existsSync(metadataFile)) {
    fail(skillDir, "missing agents/openai.yaml");
  } else {
    const metadata = readFileSync(metadataFile, "utf8");
    for (const field of [
      "display_name:",
      "short_description:",
      "default_prompt:",
    ]) {
      if (!metadata.includes(field)) fail(metadataFile, `missing ${field}`);
    }
    if (frontmatter && !metadata.includes(`$${frontmatter.name}`)) {
      fail(metadataFile, `default prompt does not invoke $${frontmatter.name}`);
    }
  }

  for (const match of source.matchAll(
    /(?:^|[`(\s])((?:scripts|references)\/[A-Za-z0-9_./-]+)/gm,
  )) {
    const relative = match[1].replace(/[.,;:)]+$/, "");
    if (!existsSync(path.join(skillDir, relative))) {
      fail(skillFile, `referenced resource does not exist: ${relative}`);
    }
  }
}

const skillFiles = walkFiles(skillsRoot);
const toolFiles = walkFiles(path.join(repo, "tools/codex"));
for (const file of skillFiles) {
  const source = readFileSync(file, "utf8");
  if (
    /(?:~\/\.codex|\/Users\/|\/home\/|\/opt\/homebrew\/|\/usr\/local\/)/.test(
      source,
    )
  ) {
    fail(file, "contains a host-local path");
  }
  if (source.includes("mantine-llms-full.txt")) {
    fail(file, "references the unbounded Mantine full documentation dump");
  }
  if (file.endsWith(".mjs")) {
    if (!source.startsWith("#!/usr/bin/env node")) {
      fail(file, "Node helper lacks portable env shebang");
    }
    if (/\b(?:sed\s+-i|readlink\s+-f|nproc)\b/.test(source)) {
      fail(file, "uses a GNU/BSD-specific shell command");
    }
    const checked = spawnSync(process.execPath, ["--check", file], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (checked.status !== 0) {
      fail(
        file,
        `Node syntax check failed: ${(checked.stderr || checked.stdout).trim()}`,
      );
    }
  }
}

for (const file of toolFiles.filter((entry) => entry.endsWith(".mjs"))) {
  const source = readFileSync(file, "utf8");
  if (!source.startsWith("#!/usr/bin/env node")) {
    fail(file, "Node helper lacks portable env shebang");
  }
  const isValidator = path.resolve(file) === path.resolve(process.argv[1]);
  if (!isValidator && /\b(?:sed\s+-i|readlink\s+-f|nproc)\b/.test(source)) {
    fail(file, "uses a GNU/BSD-specific shell command");
  }
  const checked = spawnSync(process.execPath, ["--check", file], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (checked.status !== 0) {
    fail(
      file,
      `Node syntax check failed: ${(checked.stderr || checked.stdout).trim()}`,
    );
  }
}

const compactMantine = path.join(
  skillsRoot,
  "myoxus-mantine-facade/references/mantine-llms.txt",
);
if (!existsSync(compactMantine) || statSync(compactMantine).size < 10_000) {
  fail(
    compactMantine,
    "compact LLM-optimized Mantine reference is missing or truncated",
  );
}

if (args.includes("--json")) {
  console.log(
    JSON.stringify({ failures, skillCount: skillDirs.length }, null, 2),
  );
} else if (failures.length === 0) {
  console.log(`skill-validation: ok (${skillDirs.length} skills)`);
} else {
  for (const finding of failures) {
    console.error(`[FAIL] ${finding.file}: ${finding.message}`);
  }
}

process.exit(failures.length === 0 ? 0 : 1);
