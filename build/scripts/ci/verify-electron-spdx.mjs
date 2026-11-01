// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const SPDX_IDENTIFIER = "SPDX-License-Identifier: AGPL-3.0-or-later";
const SOURCE_HEADER = `// ${SPDX_IDENTIFIER}`;
const COMMENT_HEADER = `# ${SPDX_IDENTIFIER}`;
const XML_HEADER = `<!-- ${SPDX_IDENTIFIER} -->`;
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const yamlExtensions = new Set([".yaml", ".yml"]);
const xmlExtensions = new Set([".xml", ".svg"]);
const binaryExtensions = new Set([
  ".7z",
  ".bin",
  ".bmp",
  ".deb",
  ".dmg",
  ".gif",
  ".gz",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".node",
  ".nupkg",
  ".otf",
  ".pdf",
  ".png",
  ".rpm",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".woff",
  ".woff2",
  ".zip",
]);
const directTrackRoots = [
  "build/scripts/electron/",
  "client/apps/electron/",
  "client/apps/electron-renderer/",
  "client/libs/desktop-api-contract/",
  "client/libs/icons/src/assets/native/",
  "client/libs/icons/src/assets/platform/",
  "tests/client/desktop/electron/",
];

function usage() {
  console.log(`Usage: node build/scripts/ci/verify-electron-spdx.mjs [options]

Options:
  --base <revision>  Compare additions with the merge base of revision and HEAD.
                     Without it, compare the worktree with HEAD.
  --self-test        Run deterministic temporary-repository negative fixtures.
  --help             Show this help.`);
}

function parseArgs(argv) {
  let base = null;
  let selfTest = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--self-test") {
      selfTest = true;
    } else if (arg === "--help") {
      return { help: true, base, selfTest };
    } else if (arg === "--base") {
      base = argv[index + 1];
      if (!base || base.startsWith("--")) {
        throw new Error("--base requires a Git revision");
      }
      index += 1;
    } else if (arg.startsWith("--base=")) {
      base = arg.slice("--base=".length);
      if (!base) throw new Error("--base requires a Git revision");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { help: false, base, selfTest };
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nulPaths(output) {
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

function isElectronTrack(file) {
  if (directTrackRoots.some((root) => file.startsWith(root))) return true;
  if (/^build\/scripts\/ci\/[^/]*electron[^/]*\.(?:mjs|sh)$/.test(file)) {
    return true;
  }
  return /^\.forgejo\/workflows\/[^/]*electron[^/]*\.ya?ml$/.test(file);
}

function resolveDiffBase(root, requestedBase) {
  if (!requestedBase) {
    const dirty = git(root, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]).trim().length;
    if (dirty > 0) return "HEAD";
    try {
      git(root, ["rev-parse", "--verify", "HEAD^"]);
      return "HEAD^";
    } catch {
      return "HEAD";
    }
  }
  try {
    return git(root, ["merge-base", requestedBase, "HEAD"]).trim();
  } catch (error) {
    const detail = error.stderr?.toString("utf8").trim();
    throw new Error(
      `cannot resolve --base ${requestedBase}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function collectDiffFiles(root, requestedBase) {
  const diffBase = resolveDiffBase(root, requestedBase);
  let changed;
  let baseFiles;
  let untracked;

  try {
    changed = nulPaths(
      git(
        root,
        [
          "diff",
          "--name-only",
          "-z",
          "--diff-filter=ACMR",
          "--no-ext-diff",
          diffBase,
          "--",
        ],
        { encoding: "buffer" },
      ),
    );
    baseFiles = new Set(
      nulPaths(
        git(root, ["ls-tree", "-r", "-z", "--name-only", diffBase, "--"], {
          encoding: "buffer",
        }),
      ),
    );
    untracked = nulPaths(
      git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"], {
        encoding: "buffer",
      }),
    );
  } catch (error) {
    const detail = error.stderr?.toString("utf8").trim();
    throw new Error(
      `cannot inspect Git additions${detail ? `: ${detail}` : ""}`,
    );
  }

  const changedTrackFiles = [
    ...new Set(changed.filter(isElectronTrack)),
  ].sort();
  const newTrackFiles = [
    ...new Set(
      [...changed, ...untracked].filter(
        (file) => isElectronTrack(file) && !baseFiles.has(file),
      ),
    ),
  ].sort();

  return { changedTrackFiles, diffBase, newTrackFiles };
}

function isJsonManifest(file) {
  const basename = path.posix.basename(file);
  return (
    basename === "package.json" ||
    basename === "tsconfig.json" ||
    /^tsconfig\.[^.]+\.json$/.test(basename) ||
    basename.endsWith(".config.json")
  );
}

function isTestFixture(file) {
  const segments = file.toLowerCase().split("/");
  const basename = segments.at(-1);
  return (
    segments.some((segment) =>
      [
        "test",
        "tests",
        "fixture",
        "fixtures",
        "__fixtures__",
        "__snapshots__",
        "test-data",
        "testdata",
      ].includes(segment),
    ) || /(?:^|[._-])(?:fixture|snapshot)(?:[._-]|$)/.test(basename)
  );
}

function isBinary(extension, buffer) {
  return binaryExtensions.has(extension) || buffer.includes(0);
}

function finding(file, code, message) {
  return { code, file, message };
}

function validateFile(root, file) {
  const absolutePath = path.join(root, ...file.split("/"));
  let stat;
  let contents;

  try {
    stat = lstatSync(absolutePath);
    contents = readFileSync(absolutePath);
  } catch {
    return [finding(file, "unreadable", "new file cannot be read")];
  }

  if (!stat.isFile()) {
    return [finding(file, "not_regular", "new path must be a regular file")];
  }

  const extension = path.posix.extname(file).toLowerCase();
  if (extension === ".json") {
    if (isJsonManifest(file) && !/(?:^|\/)fixtures?(?:\/|$)/i.test(file)) {
      return [];
    }
    if (isTestFixture(file)) {
      return [
        finding(
          file,
          "json_fixture_forbidden",
          "new committed JSON test fixtures are forbidden; generate data in SPDX-capable source",
        ),
      ];
    }
    return [];
  }

  if (isBinary(extension, contents)) {
    return isTestFixture(file)
      ? [
          finding(
            file,
            "binary_fixture_forbidden",
            "new committed binary fixtures are forbidden; generate them deterministically",
          ),
        ]
      : [];
  }

  const lines = contents.toString("utf8").split(/\r?\n/);
  if (sourceExtensions.has(extension)) {
    return lines[0] === SOURCE_HEADER
      ? []
      : [
          finding(
            file,
            "source_header",
            `line 1 must be exactly ${JSON.stringify(SOURCE_HEADER)}`,
          ),
        ];
  }

  if (extension === ".sh") {
    const findings = [];
    if (!lines[0]?.startsWith("#!") || lines[0].length <= 2) {
      findings.push(
        finding(file, "shell_shebang", "line 1 must be a non-empty shebang"),
      );
    }
    if (lines[1] !== COMMENT_HEADER) {
      findings.push(
        finding(
          file,
          "shell_header",
          `line 2 must be exactly ${JSON.stringify(COMMENT_HEADER)}`,
        ),
      );
    }
    return findings;
  }

  if (xmlExtensions.has(extension)) {
    const findings = [];
    if (
      !/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"[A-Za-z0-9._-]+"|'[A-Za-z0-9._-]+'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>$/.test(
        lines[0] ?? "",
      )
    ) {
      findings.push(
        finding(file, "xml_declaration", "line 1 must be an XML declaration"),
      );
    }
    if (lines[1] !== XML_HEADER) {
      findings.push(
        finding(
          file,
          "xml_header",
          `line 2 must be exactly ${JSON.stringify(XML_HEADER)}`,
        ),
      );
    }
    return findings;
  }

  if (yamlExtensions.has(extension)) {
    return lines[0] === COMMENT_HEADER
      ? []
      : [
          finding(
            file,
            "yaml_header",
            `line 1 must be exactly ${JSON.stringify(COMMENT_HEADER)}`,
          ),
        ];
  }

  return [];
}

function validateFiles(root, files) {
  return files
    .flatMap((file) => validateFile(root, file))
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.code.localeCompare(right.code),
    );
}

function writeFixture(root, file, contents) {
  const absolutePath = path.join(root, ...file.split("/"));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function commitAll(root, message) {
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=Myoxus SPDX Self-Test",
    "-c",
    "user.email=spdx-self-test@invalid.example",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    message,
  ]);
}

function runSelfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "myoxus-electron-spdx-"));
  try {
    git(root, ["init", "--quiet"]);
    writeFixture(root, "client/apps/electron/src/legacy.ts", "export {};\n");
    commitAll(root, "baseline");
    const base = git(root, ["rev-parse", "HEAD"]).trim();

    const validFixtures = new Map([
      ["build/scripts/ci/verify-electron-example.mjs", `${SOURCE_HEADER}\n`],
      ["client/apps/electron/src/valid.tsx", `${SOURCE_HEADER}\nexport {};\n`],
      ["client/apps/electron/src/valid.js", `${SOURCE_HEADER}\n`],
      ["client/apps/electron/src/valid.cjs", `${SOURCE_HEADER}\n`],
      [
        "client/apps/electron/scripts/valid.sh",
        `#!/usr/bin/env bash\n${COMMENT_HEADER}\n`,
      ],
      [
        "client/apps/electron/resources/valid.xml",
        `<?xml version="1.0" encoding="UTF-8"?>\n${XML_HEADER}\n<root />\n`,
      ],
      [
        "client/apps/electron/resources/valid.svg",
        `<?xml version="1.0"?>\n${XML_HEADER}\n<svg />\n`,
      ],
      [
        "client/apps/electron/resources/valid.yml",
        `${COMMENT_HEADER}\nkey: value\n`,
      ],
      ["client/apps/electron/package.json", '{"private":true}\n'],
      ["tests/client/desktop/electron/tsconfig.test.json", "{}\n"],
    ]);
    const negativeFixtures = new Map([
      ["client/apps/electron/src/missing.ts", "export {};\n"],
      ["client/apps/electron/src/misplaced.ts", `\n${SOURCE_HEADER}\n`],
      [
        "client/apps/electron/scripts/missing.sh",
        "#!/usr/bin/env bash\ntrue\n",
      ],
      [
        "client/apps/electron/scripts/missing-shebang.sh",
        `${COMMENT_HEADER}\ntrue\n`,
      ],
      [
        "client/apps/electron/scripts/misplaced.sh",
        `#!/usr/bin/env bash\n\n${COMMENT_HEADER}\n`,
      ],
      ["client/apps/electron/resources/missing.xml", "<root />\n"],
      [
        "client/apps/electron/resources/misplaced.svg",
        `\n<?xml version="1.0"?>\n${XML_HEADER}\n<svg />\n`,
      ],
      ["client/apps/electron/resources/missing.yaml", "key: value\n"],
      [
        "client/apps/electron/resources/misplaced.yml",
        `\n${COMMENT_HEADER}\nkey: value\n`,
      ],
      ["client/apps/electron/test/fixtures/payload.json", '{"fixture":true}\n'],
      [
        "tests/client/desktop/electron/fixtures/payload.bin",
        Buffer.from([0x4d, 0x59, 0x4f, 0x58, 0x00, 0x01]),
      ],
    ]);

    for (const [file, contents] of [...validFixtures, ...negativeFixtures]) {
      writeFixture(root, file, contents);
    }
    writeFixture(
      root,
      "client/apps/electron/src/legacy.ts",
      "export const changedLegacyFile = true;\n",
    );
    commitAll(root, "negative fixtures");

    const diff = collectDiffFiles(root, base);
    const expectedNewFiles = [
      ...validFixtures.keys(),
      ...negativeFixtures.keys(),
    ].sort();
    if (
      JSON.stringify(diff.newTrackFiles) !== JSON.stringify(expectedNewFiles)
    ) {
      throw new Error(
        "--base did not identify the exact committed fixture set",
      );
    }
    if (
      !diff.changedTrackFiles.includes("client/apps/electron/src/legacy.ts")
    ) {
      throw new Error(
        "changed-file detection omitted the modified baseline file",
      );
    }
    if (diff.newTrackFiles.includes("client/apps/electron/src/legacy.ts")) {
      throw new Error(
        "modified baseline file was incorrectly classified as new",
      );
    }

    const findings = validateFiles(root, diff.newTrackFiles);
    for (const file of validFixtures.keys()) {
      if (findings.some((item) => item.file === file)) {
        throw new Error(`valid fixture failed: ${file}`);
      }
    }
    for (const file of negativeFixtures.keys()) {
      if (!findings.some((item) => item.file === file)) {
        throw new Error(`negative fixture did not fail: ${file}`);
      }
    }

    const expectedCodes = new Set([
      "binary_fixture_forbidden",
      "json_fixture_forbidden",
      "shell_header",
      "shell_shebang",
      "source_header",
      "xml_declaration",
      "xml_header",
      "yaml_header",
    ]);
    for (const code of expectedCodes) {
      if (!findings.some((item) => item.code === code)) {
        throw new Error(`negative fixtures did not exercise ${code}`);
      }
    }

    writeFixture(
      root,
      "client/apps/electron/src/untracked.ts",
      `${SOURCE_HEADER}\nexport {};\n`,
    );
    const worktreeDiff = collectDiffFiles(root, null);
    if (
      JSON.stringify(worktreeDiff.newTrackFiles) !==
      JSON.stringify(["client/apps/electron/src/untracked.ts"])
    ) {
      throw new Error(
        "default worktree detection did not isolate the untracked file",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log("Electron SPDX guard self-test passed.");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.selfTest) {
    runSelfTest();
    return;
  }

  const diff = collectDiffFiles(repoRoot, options.base);
  const findings = validateFiles(repoRoot, diff.newTrackFiles);
  if (findings.length > 0) {
    console.error("Electron SPDX/fixture violations:");
    for (const item of findings) {
      console.error(`- ${item.file} [${item.code}] ${item.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Electron SPDX guard passed: ${diff.changedTrackFiles.length} changed, ${diff.newTrackFiles.length} new Electron-track files checked (base ${diff.diffBase}).`,
  );
}

try {
  main();
} catch (error) {
  console.error(`Electron SPDX guard failed: ${error.message}`);
  process.exitCode = 1;
}
