#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function declaredVersion(manifest, section, name) {
  const range = manifest[section]?.[name];
  const match = typeof range === "string" && range.match(/\d+\.\d+\.\d+/);
  if (!match) {
    throw new Error(`${name} has no concrete version in ${section}`);
  }
  return match[0];
}

function podVersions(lockSource) {
  const pods = new Map();
  for (const line of lockSource.split("\nDEPENDENCIES:")[0].split(/\r?\n/)) {
    const match = line.match(/^  - ([A-Za-z0-9_.+-]+) \(([^)]+)\):?$/);
    if (match) pods.set(match[1], match[2]);
  }
  return pods;
}

const iosManifest = readJson("client/apps/ios/package.json");
const androidManifest = readJson("client/apps/android/package.json");
const podLock = read("client/apps/ios/App/Podfile.lock");
const pods = podVersions(podLock);
const expectedPods = new Map([
  ["Capacitor", declaredVersion(iosManifest, "dependencies", "@capacitor/ios")],
  [
    "CapacitorCordova",
    declaredVersion(iosManifest, "dependencies", "@capacitor/ios"),
  ],
  [
    "CapacitorApp",
    declaredVersion(iosManifest, "dependencies", "@capacitor/app"),
  ],
  [
    "CapacitorBrowser",
    declaredVersion(iosManifest, "dependencies", "@capacitor/browser"),
  ],
  [
    "CapacitorHaptics",
    declaredVersion(iosManifest, "dependencies", "@capacitor/haptics"),
  ],
  [
    "CapacitorKeyboard",
    declaredVersion(iosManifest, "dependencies", "@capacitor/keyboard"),
  ],
]);
const findings = [];
for (const [pod, expected] of expectedPods) {
  if (pods.get(pod) !== expected) {
    findings.push(
      `${pod} must be locked to ${expected}, found ${pods.get(pod)}`,
    );
  }
}

const capacitorLine = declaredVersion(
  androidManifest,
  "dependencies",
  "@capacitor/android",
);
for (const [section, name] of [
  ["dependencies", "@capacitor/core"],
  ["devDependencies", "@capacitor/cli"],
]) {
  const version = declaredVersion(androidManifest, section, name);
  if (version !== capacitorLine) {
    findings.push(
      `${name} ${version} is not aligned with @capacitor/android ${capacitorLine}`,
    );
  }
}
for (const lockfile of [
  "client/apps/android/App/app/gradle.lockfile",
  "client/apps/android/App/service/gradle.lockfile",
  "client/apps/android/App/capacitor-cordova-android-plugins/gradle.lockfile",
  "client/apps/android/App/settings-gradle.lockfile",
]) {
  if (!existsSync(resolve(repoRoot, lockfile)) || !read(lockfile).trim()) {
    findings.push(`missing generated Android dependency lock: ${lockfile}`);
  }
}

if (findings.length) {
  for (const finding of findings)
    console.error(`native-dependency-locks: ${finding}`);
  process.exit(1);
}
console.log(
  `Native dependency locks are aligned (iOS ${expectedPods.get("Capacitor")}, Android ${capacitorLine}).`,
);
