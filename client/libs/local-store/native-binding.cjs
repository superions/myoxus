// prettier-ignore
// @ts-nocheck
/* Native loader for @myoxus/local-store. Keep this file CommonJS: the package is
 * ESM, but native addons are still loaded through require(). */

const { readFileSync } = require("node:fs");

const loadErrors = [];

const isMusl = () => {
  let musl = false;
  if (process.platform === "linux") {
    musl = isMuslFromFilesystem();
    if (musl === null) {
      musl = isMuslFromReport();
    }
    if (musl === null) {
      musl = isMuslFromChildProcess();
    }
  }
  return musl;
};

const isFileMusl = (f) => f.includes("libc.musl-") || f.includes("ld-musl-");

const isMuslFromFilesystem = () => {
  try {
    return readFileSync("/usr/bin/ldd", "utf-8").includes("musl");
  } catch {
    return null;
  }
};

const isMuslFromReport = () => {
  let report = null;
  if (typeof process.report?.getReport === "function") {
    process.report.excludeNetwork = true;
    report = process.report.getReport();
  }
  if (!report) {
    return null;
  }
  if (report.header && report.header.glibcVersionRuntime) {
    return false;
  }
  if (Array.isArray(report.sharedObjects)) {
    if (report.sharedObjects.some(isFileMusl)) {
      return true;
    }
  }
  return false;
};

const isMuslFromChildProcess = () => {
  try {
    return require("node:child_process")
      .execSync("ldd --version", { encoding: "utf8" })
      .includes("musl");
  } catch {
    return false;
  }
};

function tryRequire(bindingPath) {
  try {
    return require(bindingPath);
  } catch (error) {
    loadErrors.push(error);
    return null;
  }
}

function requireNative() {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
    return tryRequire(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
  }

  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return tryRequire("./myoxus_storage.win32-x64-msvc.node");
    }
    if (process.arch === "arm64") {
      return tryRequire("./myoxus_storage.win32-arm64-msvc.node");
    }
    loadErrors.push(
      new Error(`Unsupported architecture on Windows: ${process.arch}`),
    );
    return null;
  }

  if (process.platform === "darwin") {
    const universal = tryRequire("./myoxus_storage.darwin-universal.node");
    if (universal) {
      return universal;
    }
    if (process.arch === "x64") {
      return tryRequire("./myoxus_storage.darwin-x64.node");
    }
    if (process.arch === "arm64") {
      return tryRequire("./myoxus_storage.darwin-arm64.node");
    }
    loadErrors.push(
      new Error(`Unsupported architecture on macOS: ${process.arch}`),
    );
    return null;
  }

  if (process.platform === "linux") {
    if (process.arch === "x64") {
      return isMusl()
        ? tryRequire("./myoxus_storage.linux-x64-musl.node")
        : tryRequire("./myoxus_storage.linux-x64-gnu.node");
    }
    if (process.arch === "arm64") {
      return isMusl()
        ? tryRequire("./myoxus_storage.linux-arm64-musl.node")
        : tryRequire("./myoxus_storage.linux-arm64-gnu.node");
    }
    loadErrors.push(
      new Error(`Unsupported architecture on Linux: ${process.arch}`),
    );
    return null;
  }

  loadErrors.push(
    new Error(
      `Unsupported OS: ${process.platform}, architecture: ${process.arch}`,
    ),
  );
  return null;
}

const nativeBinding = requireNative();

if (!nativeBinding) {
  if (loadErrors.length > 0) {
    throw new Error(
      "Cannot find native binding for @myoxus/local-store. " +
        "Please run 'yarn workspace @myoxus/local-store build' to build the native module.",
      {
        cause: loadErrors.reduce((previous, current) => {
          current.cause = previous;
          return current;
        }),
      },
    );
  }
  throw new Error("Failed to load @myoxus/local-store native binding");
}

module.exports = nativeBinding;
module.exports.DocStorage = nativeBinding.DocStorage;
module.exports.DocStoragePool = nativeBinding.DocStoragePool;
