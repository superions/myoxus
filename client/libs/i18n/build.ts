import { readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { parse } from "node:path";

import { ProjectRoot } from "@myoxus-tools/utils/path";
import { Package } from "@myoxus-tools/utils/workspace";

import { generateI18nSource } from "./generate";
import { findTranslationSources } from "./source-files";

const isDev = process.argv.includes("--dev");
const shouldCleanup = process.argv.includes("--cleanup");

const i18nPkg = new Package("@myoxus/i18n");
const resourcesDir = i18nPkg.join("src", "resources").toString();

function readResource(lang: string): Record<string, string> {
  const filePath = `${resourcesDir}/${lang}.json`;
  const fileContent = JSON.parse(readFileSync(filePath, "utf-8"));
  return fileContent;
}

function writeResource(lang: string, resource: Record<string, string>) {
  const filePath = `${resourcesDir}/${lang}.json`;
  writeFileSync(filePath, JSON.stringify(resource, null, 2) + "\n");
}

async function cleanupResources() {
  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const files = await findTranslationSources(ProjectRoot.toString());

  const filesWithContent = files.map((file) => {
    return {
      path: file,
      content: readFileSync(file, "utf8"),
    };
  });

  const dynamicPrefixes = new Set<string>();
  const templatePrefixRegex = /`[^`]*?(com\.myoxus\.[^`]*?)\$\{/g;
  const concatPrefixRegex = /['"](com\.myoxus\.[^'"]*?\.)['"]\s*\+/g;
  const addDynamicPrefix = (rawPrefix: string) => {
    let prefix = rawPrefix;
    if (!prefix.endsWith(".")) {
      const lastDot = prefix.lastIndexOf(".");
      if (lastDot === -1) {
        return;
      }
      prefix = prefix.slice(0, lastDot + 1);
    }
    dynamicPrefixes.add(prefix);
  };

  for (const file of filesWithContent) {
    templatePrefixRegex.lastIndex = 0;
    concatPrefixRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = templatePrefixRegex.exec(file.content)) !== null) {
      addDynamicPrefix(match[1]);
    }
    while ((match = concatPrefixRegex.exec(file.content)) !== null) {
      addDynamicPrefix(match[1]);
    }
  }

  const resources = readdirSync(resourcesDir)
    .filter((file) => file.endsWith(".json"))
    .reduce(
      (langs, file) => {
        const lang = parse(file).name;
        langs[lang] = readResource(lang);
        return langs;
      },
      {} as Record<string, Record<string, string>>,
    );

  const candidateKeys = new Set<string>();

  for (const resource of Object.values(resources)) {
    Object.keys(resource).forEach((key) => {
      candidateKeys.add(key);
    });
  }

  const unusedKeys = Array.from(candidateKeys).filter((key) => {
    const regex1 = new RegExp(`[\`'"]${escapeRegExp(key)}[\`'"]`, "g");
    const lastDot = key.lastIndexOf(".");
    const keyPrefix = lastDot === -1 ? "" : key.slice(0, lastDot + 1);
    if (keyPrefix && dynamicPrefixes.has(keyPrefix)) {
      return false;
    }
    for (const file of filesWithContent) {
      const match = file.content.match(regex1);
      if (match) {
        return false;
      }
    }
    return true;
  });

  if (unusedKeys.length === 0) {
    return;
  }

  const unusedKeySet = new Set(unusedKeys);

  for (const [lang, resource] of Object.entries(resources)) {
    let changed = false;
    for (const key of Object.keys(resource)) {
      if (unusedKeySet.has(key)) {
        delete resource[key];
        changed = true;
      }
    }
    if (changed) {
      writeResource(lang, resource);
    }
  }
}

function calcCompletenesses() {
  // Resource drafts can exist before a locale is registered. Completeness is a
  // runtime contract, so it must only expose SUPPORTED_LANGUAGES entries.
  const resourcesIndex = readFileSync(
    i18nPkg.join("src", "resources", "index.ts").toString(),
    "utf8",
  );
  const supportedLanguages = new Set(
    Array.from(resourcesIndex.matchAll(/\|\s*"([^"]+)"/g), (match) => match[1]),
  );
  const langs = readdirSync(resourcesDir)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => supportedLanguages.has(parse(file).name))
    .reduce(
      (langs, file) => {
        const lang = parse(file).name;
        langs[lang] = readResource(lang);
        return langs;
      },
      {} as Record<string, Record<string, string>>,
    );

  const base = Object.keys(langs.en).length;

  const completenesses = {};

  for (const key in langs) {
    const [langPart, variantPart] = key.split("-");

    const completeness = Object.keys(
      variantPart ? { ...langs[langPart], ...langs[key] } : langs[key],
    ).length;

    completenesses[key] = Math.min(
      Math.ceil(/* avoid 0% */ (completeness / base) * 100),
      100,
    );
  }

  writeFileSync(
    i18nPkg.join("src", "i18n-completenesses.json").toString(),
    JSON.stringify(completenesses, null, 2) + "\n",
  );
}

function generateTypes() {
  const generatedPath = i18nPkg.join("src", "i18n.gen.ts").toString();
  writeFileSync(generatedPath, generateI18nSource(readResource("en")));
}

/** Server-owned native field output reuses product copy without bundling every
 * UI message. This finite projection is generated, never a second translation
 * source. Main languages are required; optional locales use normal EN fallback.
 */
function generateDocumentFieldMessages() {
  const keys = {
    unset: "com.myoxus.document-metadata.value.not-set",
    noVersion: "com.myoxus.document-metadata.value.no-version",
    unversionedChanges:
      "com.myoxus.document-metadata.value.unversioned-changes",
    changedSuffix: "com.myoxus.document-metadata.value.changed",
  } as const;
  const base = readResource("en");
  const files = readdirSync(resourcesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const messages = Object.fromEntries(
    files.map((file) => {
      const locale = parse(file).name;
      const own = readResource(locale);
      const parentLocale = locale.split("-")[0];
      const parent =
        parentLocale !== locale && files.includes(`${parentLocale}.json`)
          ? readResource(parentLocale)
          : {};
      return [
        locale,
        Object.fromEntries(
          Object.entries(keys).map(([name, key]) => {
            if (
              ["en", "de", "fr", "es"].includes(locale) &&
              !own[key]?.trim()
            ) {
              throw new Error(
                `Missing required document-field translation: ${locale}/${key}`,
              );
            }
            return [name, own[key] ?? parent[key] ?? base[key]];
          }),
        ),
      ];
    }),
  );
  writeFileSync(
    ProjectRoot.join(
      "server",
      "crates",
      "application",
      "src",
      "document_fields",
      "messages.generated.json",
    ).toString(),
    JSON.stringify(messages, null, 2) + "\n",
  );
}

if (shouldCleanup) {
  await cleanupResources();
}
generateTypes();
calcCompletenesses();
generateDocumentFieldMessages();

if (isDev) {
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  watch(resourcesDir, (_, filename) => {
    if (!filename?.endsWith(".json")) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      generateTypes();
      calcCompletenesses();
      generateDocumentFieldMessages();
    }, 50);
  });
}
