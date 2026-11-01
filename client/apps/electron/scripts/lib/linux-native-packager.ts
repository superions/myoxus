// SPDX-License-Identifier: MIT

import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_PROJECT_URLS } from "@myoxus-tools/utils/public-urls";

import type { BuildContext } from "./build-context";
import type { PackagingIdentity } from "./packaging-config";
import { runProcess } from "./process";

const description =
  "Collaborative workspace for docs, whiteboards, and databases";
const debDependencies = [
  "libgtk-3-0",
  "libnotify4",
  "libnss3",
  "libxss1",
  "libxtst6",
  "xdg-utils",
  "libatspi2.0-0",
  "libuuid1",
  "libsecret-1-0",
  "libpulse0",
];
const rpmDependencies = [
  "gtk3",
  "libnotify",
  "nss",
  "libXScrnSaver",
  "(libXtst or libXtst6)",
  "xdg-utils",
  "at-spi2-core",
  "(libuuid or libuuid1)",
  "pulseaudio-libs",
];

export function linuxDesktopEntry(
  identity: PackagingIdentity,
  flatpak = false,
): string {
  return `[Desktop Entry]\nName=${identity.productName}\nComment=Collaborative workspace\nExec=${flatpak ? "electron-wrapper" : `/opt/${identity.productName}/${identity.productName}`} %U\nTerminal=false\nType=Application\nIcon=${identity.appId}\nStartupWMClass=${identity.productName}\nCategories=Office;WordProcessor;Presentation;ContactManagement;ProjectManagement;Graphics;Network;\nMimeType=x-scheme-handler/${identity.protocolScheme};\n`;
}

async function put(
  root: string,
  relative: string,
  contents: string,
  executable = false,
) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  if (executable) await chmod(file, 0o755);
}

async function installPayload(
  root: string,
  application: string,
  identity: PackagingIdentity,
  context: BuildContext,
  flatpak: boolean,
) {
  const destination = path.join(
    root,
    flatpak ? `lib/${identity.appId}` : `opt/${identity.productName}`,
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(application, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const sourceMetainfo = await readFile(
    path.join(context.stageAppDir, "resources/myoxus.metainfo.xml"),
    "utf8",
  );
  const desktopName = flatpak ? identity.appId : identity.productName;
  await put(
    root,
    `${flatpak ? "" : "usr/"}share/applications/${desktopName}.desktop`,
    linuxDesktopEntry(identity, flatpak),
  );
  await put(
    root,
    `${flatpak ? "" : "usr/"}share/metainfo/${identity.appId}.metainfo.xml`,
    sourceMetainfo.replace(
      /<launchable type="desktop-id">.*?<\/launchable>/,
      `<launchable type="desktop-id">${desktopName}.desktop</launchable>`,
    ),
  );
  const icon = path.join(
    root,
    `${flatpak ? "" : "usr/"}share/icons/hicolor/scalable/apps/${identity.appId}.svg`,
  );
  if (flatpak) {
    // AppStream composes icons on the host, where an SVG loader is optional.
    // Use the same stage-owned runtime raster without changing the artwork.
    const raster = path.join(
      root,
      `share/icons/hicolor/512x512/apps/${identity.appId}.png`,
    );
    await mkdir(path.dirname(raster), { recursive: true });
    await cp(identity.runtimeIconPng, raster);
  } else {
    await mkdir(path.dirname(icon), { recursive: true });
    await cp(identity.appIconSvg, icon);
  }
  await put(
    root,
    `${flatpak ? "" : "usr/"}share/doc/${identity.packageName}/copyright`,
    await readFile(path.join(context.repoRoot, "LICENSE"), "utf8"),
  );
}

// Both package managers must preserve the same sandbox/AppArmor setup and
// update-alternatives registration as existing installations.
export function linuxInstallScript(identity: PackagingIdentity): string {
  const executable = identity.productName;
  return `#!/bin/bash\nset -e\napp='/opt/${executable}'\nif command -v update-alternatives >/dev/null; then\n  if [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then rm -f '/usr/bin/${executable}'; fi\n  update-alternatives --install '/usr/bin/${executable}' '${executable}' "$app/${executable}" 100\nelse\n  ln -sf "$app/${executable}" '/usr/bin/${executable}'\nfi\nif { [ -L /proc/self/ns/user ] && unshare --user true; }; then chmod 0755 "$app/chrome-sandbox"; else chmod 4755 "$app/chrome-sandbox"; fi\nfor updater in update-mime-database update-desktop-database; do\n  if command -v "$updater" >/dev/null; then\n    if [ "$updater" = update-mime-database ]; then "$updater" /usr/share/mime; else "$updater" /usr/share/applications; fi\n  fi\ndone\nif command -v apparmor_status >/dev/null && apparmor_status --enabled >/dev/null 2>&1 && apparmor_parser --skip-kernel-load --debug "$app/resources/apparmor-profile" >/dev/null 2>&1; then\n  cp "$app/resources/apparmor-profile" '/etc/apparmor.d/${executable}'\n  if ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then apparmor_parser --replace --write-cache --skip-read-cache '/etc/apparmor.d/${executable}'; fi\nfi\n`;
}

export function linuxRemoveScript(identity: PackagingIdentity): string {
  const executable = identity.productName;
  return `#!/bin/bash\nset -e\nif command -v update-alternatives >/dev/null; then update-alternatives --remove '${executable}' '/opt/${executable}/${executable}'; else rm -f '/usr/bin/${executable}'; fi\nprofile='/etc/apparmor.d/${executable}'\nif [ -f "$profile" ]; then\n  if command -v apparmor_status >/dev/null && apparmor_status --enabled >/dev/null 2>&1 && ! { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }; then apparmor_parser --remove "$profile"; fi\n  rm -f "$profile"\nfi\n`;
}

export async function buildLinuxPackage({
  application,
  outputDirectory,
  context,
  identity,
  target,
}: {
  application: string;
  outputDirectory: string;
  context: BuildContext;
  identity: PackagingIdentity;
  target: "deb" | "rpm" | "flatpak";
}): Promise<string[]> {
  const root = path.join(path.dirname(outputDirectory), "payload");
  await mkdir(root, { recursive: true });
  await installPayload(
    root,
    application,
    identity,
    context,
    target === "flatpak",
  );
  const artifact = path.join(outputDirectory, identity.artifactName(target));
  const run = (command: string, args: string[]) =>
    runProcess({ command, args, cwd: outputDirectory, timeoutMs: 1_200_000 });
  if (target === "deb") {
    await put(
      root,
      "DEBIAN/control",
      `Package: ${identity.packageName}\nVersion: ${identity.version.replace("-", "~")}\nSection: office\nPriority: optional\nArchitecture: amd64\nMaintainer: Myoxus Contributors <myoxus@blume29.de>\nDepends: ${debDependencies.join(", ")}\nHomepage: ${PUBLIC_PROJECT_URLS.repository}\nDescription: ${description}\n`,
    );
    await put(root, "DEBIAN/postinst", `${linuxInstallScript(identity)}`, true);
    await put(
      root,
      "DEBIAN/postrm",
      `#!/bin/bash\nset -e\ncase "$1" in remove|purge)\n${linuxRemoveScript(identity).split("\n").slice(2).join("\n")}\n;; esac\n`,
      true,
    );
    await run("dpkg-deb", ["--root-owner-group", "--build", root, artifact]);
  } else if (target === "rpm") {
    const top = path.join(path.dirname(outputDirectory), "rpm");
    for (const folder of [
      "BUILD",
      "BUILDROOT",
      "RPMS",
      "SOURCES",
      "SPECS",
      "SRPMS",
    ])
      await mkdir(path.join(top, folder), { recursive: true });
    const [version, prerelease] = identity.version.split("-", 2);
    const spec = path.join(top, "SPECS/myoxus.spec");
    await writeFile(
      spec,
      `Name: ${identity.packageName}\nVersion: ${version}\nRelease: ${prerelease ? `0.${prerelease.replaceAll("-", ".")}` : "1"}\nSummary: ${description}\nLicense: AGPL-3.0-or-later\nGroup: Office\nVendor: Myoxus Contributors\nURL: ${PUBLIC_PROJECT_URLS.repository}\nRequires: ${rpmDependencies.join(", ")}\nAutoReqProv: no\n%global __os_install_post %{nil}\n%description\n${description}\n%install\nmkdir -p "%{buildroot}"\ncp -a "${root}/." "%{buildroot}/"\n%files\n%defattr(-,root,root,-)\n/opt/${identity.productName}\n/usr/share/applications/${identity.productName}.desktop\n/usr/share/metainfo/${identity.appId}.metainfo.xml\n/usr/share/icons/hicolor/scalable/apps/${identity.appId}.svg\n/usr/share/doc/${identity.packageName}\n%post\n${linuxInstallScript(identity)}\n%postun\nif [ "$1" = 0 ]; then\n${linuxRemoveScript(identity)}\nfi\n`,
    );
    await run("rpmbuild", [
      "-bb",
      "--target",
      "x86_64",
      "--define",
      `_topdir ${top}`,
      "--define",
      `_rpmdir ${outputDirectory}`,
      "--define",
      `_rpmfilename ${path.basename(artifact)}`,
      spec,
    ]);
  } else {
    await put(
      root,
      "bin/electron-wrapper",
      `#!/bin/sh\nexport TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"\nexec zypak-wrapper '/app/lib/${identity.appId}/${identity.productName}' "$@"\n`,
      true,
    );
    const manifest = path.join(path.dirname(outputDirectory), "flatpak.json");
    const repository = path.join(path.dirname(outputDirectory), "flatpak-repo");
    await writeFile(
      manifest,
      JSON.stringify(
        {
          id: identity.appId,
          command: "electron-wrapper",
          runtime: "org.freedesktop.Platform",
          "runtime-version": "25.08",
          sdk: "org.freedesktop.Sdk",
          base: "org.electronjs.Electron2.BaseApp",
          "base-version": "25.08",
          branch: identity.buildType,
          "finish-args": [
            "--socket=wayland",
            "--socket=x11",
            "--share=ipc",
            "--device=dri",
            "--socket=pulseaudio",
            "--share=network",
            "--talk-name=org.freedesktop.Notifications",
            "--env=GTK_USE_PORTAL=1",
          ],
          modules: [
            {
              name: "zypak",
              sources: [
                {
                  type: "git",
                  url: "https://github.com/refi64/zypak",
                  tag: "v2025.09",
                },
              ],
            },
            {
              name: "myoxus",
              buildsystem: "simple",
              "build-commands": ["cp -a payload/. /app/"],
              sources: [{ type: "dir", path: root, dest: "payload" }],
            },
          ],
        },
        null,
        2,
      ),
    );
    await run("flatpak-builder", [
      "--force-clean",
      "--user",
      "--arch=x86_64",
      "--disable-rofiles-fuse",
      `--repo=${repository}`,
      path.join(path.dirname(outputDirectory), "flatpak-build"),
      manifest,
    ]);
    await run("flatpak", [
      "build-bundle",
      "--arch=x86_64",
      repository,
      artifact,
      identity.appId,
      identity.buildType,
      "--runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo",
    ]);
  }
  return [artifact];
}
