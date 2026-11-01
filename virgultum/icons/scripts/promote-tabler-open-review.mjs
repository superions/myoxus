#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");
const outputPath = path.join(
  packageDir,
  "src/mappings/tabler-open-review.json",
);
const inputPaths = process.argv.slice(2);

if (inputPaths.length === 0) {
  throw new Error(
    "Pass at least one saved review JSON path from output/icon-review.",
  );
}

const iconNames = JSON.parse(
  fs.readFileSync(path.join(packageDir, "src/icon-names.json"), "utf8"),
);
const top200 = JSON.parse(
  fs.readFileSync(
    path.join(packageDir, "src/mappings/tabler-top-200.json"),
    "utf8",
  ),
);
const obvious = JSON.parse(
  fs.readFileSync(
    path.join(packageDir, "src/mappings/tabler-obvious.json"),
    "utf8",
  ),
);
const previous = fs.existsSync(outputPath)
  ? JSON.parse(fs.readFileSync(outputPath, "utf8"))
  : null;
const tablerEntryPath = fileURLToPath(
  import.meta.resolve("@tabler/icons-react"),
);
const tablerPackageDir = path.resolve(path.dirname(tablerEntryPath), "../..");
const tablerPackage = JSON.parse(
  fs.readFileSync(path.join(tablerPackageDir, "package.json"), "utf8"),
);
const tablerDynamicImports = fs.readFileSync(
  path.join(tablerPackageDir, "dist/esm/dynamic-imports.mjs"),
  "utf8",
);
const tablerNames = new Set(
  [...tablerDynamicImports.matchAll(/icons\/(Icon[^'.]+)\.ts/g)].map(
    (match) => match[1],
  ),
);

const normalizedTop200 = top200.icons.map(({ myoxus }) =>
  myoxus.endsWith("Icon") ? myoxus : `${myoxus}Icon`,
);
const previouslyMapped = new Set([
  ...normalizedTop200,
  ...obvious.icons.map(({ myoxus }) => myoxus),
]);
const candidateOrder = [
  ...iconNames.filter((name) => !previouslyMapped.has(name)),
  ...(previous?.review?.decisions ?? []).map(({ myoxus }) => myoxus),
].filter((name, index, names) => names.indexOf(name) === index);
const candidateNames = new Set(candidateOrder);
const merged = new Map(
  (previous?.review?.decisions ?? []).map((decision) => [
    decision.myoxus,
    decision,
  ]),
);
const sourceReviews = [];
const allowedStatuses = new Set([
  "accept",
  "change",
  "keep",
  "custom",
  "remove",
]);

for (const inputPath of inputPaths) {
  const absoluteInputPath = path.resolve(repoRoot, inputPath);
  const input = JSON.parse(fs.readFileSync(absoluteInputPath, "utf8"));
  sourceReviews.push({
    file: path.relative(repoRoot, absoluteInputPath),
    updatedAt: input.updatedAt ?? null,
  });
  for (const [myoxus, decision] of Object.entries(input.decisions ?? {})) {
    if (!candidateNames.has(myoxus)) {
      throw new Error(`${myoxus}: not an open-review candidate`);
    }
    if (!allowedStatuses.has(decision.status)) {
      throw new Error(`${myoxus}: unsupported status ${decision.status}`);
    }
    const normalized = {
      myoxus,
      status: decision.status,
      tabler: String(decision.tabler ?? "").trim(),
      note: String(decision.note ?? "").trim(),
    };
    if (
      (decision.status === "accept" || decision.status === "change") &&
      !tablerNames.has(normalized.tabler)
    ) {
      throw new Error(`${myoxus}: missing Tabler export ${normalized.tabler}`);
    }
    merged.set(myoxus, normalized);
  }
}

const decisions = candidateOrder.flatMap((myoxus) => {
  const decision = merged.get(myoxus);
  return decision ? [decision] : [];
});
const accepted = decisions.filter(
  ({ status }) => status === "accept" || status === "change",
);
const keepMyoxus = decisions.filter(({ status }) => status === "keep");
const customRequired = decisions.filter(({ status }) => status === "custom");
const removedExports = decisions.filter(({ status }) => status === "remove");
const unresolved = candidateOrder.filter((name) => !merged.has(name));
const completedAt =
  sourceReviews
    .map(({ updatedAt }) => updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ??
  previous?.review?.completedAt ??
  null;

const output = {
  schemaVersion: 1,
  decision: {
    iconSet: "tabler",
    package: tablerPackage.name,
    version: tablerPackage.version,
    license: tablerPackage.license,
  },
  scope: {
    reviewCandidateCount: candidateOrder.length,
    recordedDecisionCount: decisions.length,
    acceptedTablerCount: accepted.length,
    keepMyoxusCount: keepMyoxus.length,
    customRequiredCount: customRequired.length,
    removedExportCount: removedExports.length,
    unresolvedCount: unresolved.length,
  },
  review: {
    completedAt,
    sources: [...(previous?.review?.sources ?? []), ...sourceReviews].filter(
      (source, index, sources) =>
        sources.findIndex(
          (candidate) =>
            candidate.file === source.file &&
            candidate.updatedAt === source.updatedAt,
        ) === index,
    ),
    decisions,
  },
  icons: accepted.map(({ myoxus, tabler, status, note }) => ({
    myoxus,
    tabler,
    status: "accepted",
    reviewStatus: status,
    ...(note ? { note } : {}),
  })),
  keepMyoxus: keepMyoxus.map(({ myoxus, note }) => ({
    myoxus,
    status: "keep",
    ...(note ? { note } : {}),
  })),
  customRequired: customRequired.map(({ myoxus, note }) => ({
    myoxus,
    status: "custom",
    ...(note ? { note } : {}),
  })),
  removedExports: removedExports.map(({ myoxus, note }) => ({
    myoxus,
    status: "remove",
    ...(note ? { note } : {}),
  })),
  unresolved,
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `Promoted ${decisions.length}/${candidateOrder.length} decisions: ${accepted.length} Tabler, ${keepMyoxus.length} keep, ${customRequired.length} custom, ${removedExports.length} remove, ${unresolved.length} unresolved.`,
);
