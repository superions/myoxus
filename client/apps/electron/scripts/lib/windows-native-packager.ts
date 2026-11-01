// SPDX-License-Identifier: AGPL-3.0-or-later

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_PROJECT_URLS } from "@myoxus-tools/utils/public-urls";

import { UUID } from "builder-util-runtime";

import type { BuildContext } from "./build-context";
import type { PackagingIdentity } from "./packaging-config";
import { runProcess, runProcessCapture } from "./process";

/** Deployed NSIS installations use electron-builder's UUID-v5 namespace.
 * Keep this identity stable independently of the native installer compiler.
 */
export function windowsInstallerGuid(appId: string): string {
  return UUID.v5(appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"));
}

function nsisValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid NSIS define value");
  return value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
}

const installerMessages = {
  UnsupportedArchitecture: "com.myoxus.appInstaller.unsupportedArchitecture",
  PreviousUninstallFailed: "com.myoxus.appInstaller.previousUninstallFailed",
  WriteFailed: "com.myoxus.appInstaller.writeFailed",
} as const;

/** Materialize native NSIS messages from the shared generated locale owner. */
export async function writeInstallerTranslations(
  repoRoot: string,
  productName: string,
  output: string,
  additionalLanguages: readonly string[] = [],
): Promise<void> {
  const lines: string[] = [];
  const locales = new Map<string, Record<string, string>>();
  for (const [locale, languageId] of [
    ["en", 1033],
    ["de", 1031],
    ["fr", 1036],
    ["es", 3082],
  ] as const) {
    const resources: Record<string, string> = JSON.parse(
      await readFile(
        path.join(repoRoot, `client/libs/i18n/src/resources/${locale}.json`),
        "utf8",
      ),
    );
    locales.set(locale, resources);
    for (const [name, key] of Object.entries(installerMessages)) {
      const value = resources[key];
      if (!value)
        throw new Error(`Missing installer translation ${locale}/${key}`);
      lines.push(
        `LangString ${name} ${languageId} "${nsisValue(value.replaceAll("{{appName}}", () => productName))}"`,
      );
    }
  }
  // Preserve compiler-owned wizard translations. New product messages use
  // the shared English fallback outside the four maintained main languages.
  for (const language of additionalLanguages) {
    if (!/^[A-Za-z]+$/.test(language))
      throw new Error("Invalid NSIS language name");
    const resources = locales.get(
      language === "SpanishInternational" ? "es" : "en",
    )!;
    for (const [name, key] of Object.entries(installerMessages)) {
      lines.push(
        `LangString ${name} \${LANG_${language.toUpperCase()}} "${nsisValue(resources[key].replaceAll("{{appName}}", () => productName))}"`,
      );
    }
  }
  // NSIS must recognize UTF-8 regardless of the build host's ANSI codepage.
  await writeFile(output, `\uFEFF${lines.join("\n")}\n`);
}

export async function buildWindowsInstaller({
  application,
  outputDirectory,
  context,
  identity,
}: {
  application: string;
  outputDirectory: string;
  context: BuildContext;
  identity: PackagingIdentity;
}): Promise<string[]> {
  if (process.platform !== "win32")
    throw new Error("NSIS packaging requires its Windows host");
  const artifact = path.join(outputDirectory, identity.artifactName("exe"));
  const temp = path.dirname(outputDirectory);
  const tools = path.join(context.outDir, "packaging-tools");
  const compiler = await runProcessCapture({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(context.repoRoot, "build/scripts/ci/ensure-nsis-tool.ps1"),
      "-ToolsDirectory",
      tools,
    ],
    cwd: temp,
    timeoutMs: 120_000,
  });
  const makensis = compiler.stdout.trim();
  const run = (command: string, args: string[]) =>
    runProcess({ command, args, cwd: temp, timeoutMs: 600_000 });
  const sign = async (file: string) => {
    const thumbprint = process.env.MYOXUS_WINDOWS_CERTIFICATE_THUMBPRINT;
    if (!thumbprint) return;
    if (!/^[A-Fa-f0-9]{40,64}$/.test(thumbprint))
      throw new Error("Invalid Windows signing certificate thumbprint");
    await run("signtool.exe", [
      "sign",
      "/fd",
      "SHA256",
      "/sha1",
      thumbprint,
      "/tr",
      "http://timestamp.digicert.com",
      "/td",
      "SHA256",
      file,
    ]);
    await run("signtool.exe", ["verify", "/pa", "/all", "/v", file]);
  };
  const elevate = path.join(temp, "elevate.exe");
  const helperScript = path.join(temp, "elevate.nsi");
  await writeFile(
    helperScript,
    `Unicode true\nRequestExecutionLevel admin\nSilentInstall silent\nOutFile "${nsisValue(elevate)}"\n!include FileFunc.nsh\nFunction .onInit\n  \${GetParameters} $0\n  ClearErrors\n  ExecWait '$0' $1\n  IfErrors failed\n  SetErrorLevel $1\n  Quit\nfailed:\n  SetErrorLevel 1\n  Quit\nFunctionEnd\nSection\nSectionEnd\n`,
  );
  await run(makensis, ["/WX", "/V2", helperScript]);
  await sign(elevate);
  await mkdir(path.join(application, "resources"), { recursive: true });
  await cp(elevate, path.join(application, "resources/elevate.exe"));
  await cp(
    path.join(context.electronDir, "scripts/windows-launch.ps1"),
    path.join(application, "resources/windows-launch.ps1"),
  );
  const uninstaller = path.join(temp, "uninstaller.exe");
  const bootstrap = path.join(temp, "uninstaller-generator.exe");
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(identity.version);
  if (!version || version.slice(1).some((part) => Number(part) > 65535))
    throw new Error("Invalid Windows resource version");
  const defines: Record<string, string> = {
    WINDOWS_VERSION: `${version.slice(1).join(".")}.0`,
    TRANSLATION_HEADER: path.join(temp, "translations.nsh"),
    LANGUAGE_HEADER: path.join(temp, "languages.nsh"),
    PROJECT_URL: PUBLIC_PROJECT_URLS.repository,
    APP_ID: identity.appId,
    APP_GUID: windowsInstallerGuid(identity.appId),
    PRODUCT_NAME: identity.productName,
    PACKAGE_NAME: identity.packageName,
    VERSION: identity.version,
    APPLICATION: application,
    ARTIFACT: artifact,
    UNINSTALLER: uninstaller,
    BOOTSTRAP_EXE: bootstrap,
    ICON: identity.windowsIco,
    SIDEBAR: path.join(context.stageAppDir, "resources/icons/nsis-sidebar.bmp"),
    LICENSE_FILE: path.join(context.repoRoot, "LICENSE"),
  };
  // These are the optional wizard languages shipped by the previous installer.
  // Keep the language set bounded rather than enabling unfinished vendor locales.
  const additionalLanguages = [
    "SimpChinese",
    "TradChinese",
    "Japanese",
    "Korean",
    "Italian",
    "Dutch",
    "Danish",
    "Swedish",
    "Norwegian",
    "Finnish",
    "Russian",
    "Portuguese",
    "PortugueseBR",
    "Polish",
    "Ukrainian",
    "Czech",
    "Slovak",
    "Hungarian",
    "Arabic",
    "Turkish",
    "Thai",
    "Vietnamese",
  ];
  await writeFile(
    defines.LANGUAGE_HEADER,
    // Some vendor wizard strings intentionally fall back to English. Retain
    // those notices without failing /WX; other compiler warnings stay fatal.
    [
      "!pragma warning push",
      "!pragma warning warning 9999",
      ...additionalLanguages.map(
        (name) => `!insertmacro MUI_LANGUAGE "${name}"`,
      ),
      "!pragma warning pop",
    ].join("\n"),
  );
  await writeInstallerTranslations(
    context.repoRoot,
    identity.productName,
    defines.TRANSLATION_HEADER,
    additionalLanguages,
  );
  const header = path.join(temp, "identity.nsh");
  await writeFile(
    header,
    Object.entries(defines)
      .map(([key, value]) => `!define ${key} "${nsisValue(value)}"`)
      .join("\n"),
  );
  const script = path.join(context.electronDir, "scripts/nsis-installer.nsi");
  const include = `/DIDENTITY_HEADER=${header}`;
  // Generate and sign the uninstaller before embedding it. Signing only the
  // final installer would leave the installed uninstaller unsigned.
  await run(makensis, ["/WX", "/V2", include, "/DBOOTSTRAP", script]);
  await run(bootstrap, []);
  await sign(uninstaller);
  await run(makensis, ["/WX", "/V2", include, script]);
  await sign(artifact);
  return [artifact];
}
