import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";
import { getBuildConfig } from "../../tools/utils/src/build-config";
import { Workspace } from "../../tools/utils/src/workspace";

import { createDecoratorTransform } from "../../build/scripts/test/vite-decorator-transform.mjs";

const FONT_DIR = fileURLToPath(
  new URL("../../server/static/fonts/", import.meta.url),
);
const FONT_CONTENT_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function apiFontMiddleware(): Plugin {
  const serveFont = async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const rawUrl = req.url ?? "";
    if (!rawUrl.startsWith("/api/fonts/")) {
      next();
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawUrl.split("?", 1)[0]);
    } catch {
      res.statusCode = 400;
      res.end("invalid font path");
      return;
    }

    const fileName = decodedPath.slice("/api/fonts/".length);
    // Font routes intentionally accept one basename only. Rejecting malformed
    // and nested paths before resolution keeps Dev and Preview behavior equal.
    if (
      !fileName ||
      fileName !== basename(fileName) ||
      // Null bytes are an intentional path-boundary rejection.
      // oxlint-disable-next-line no-control-regex
      /[\\/\0]/.test(fileName)
    ) {
      res.statusCode = 400;
      res.end("invalid font path");
      return;
    }

    const filePath = resolve(FONT_DIR, fileName);

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error("font path is not a file");
      }
      const extension = fileName.slice(fileName.lastIndexOf("."));
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        FONT_CONTENT_TYPES[extension] ?? "application/octet-stream",
      );
      res.setHeader("Content-Length", String(fileStat.size));
      res.setHeader("Cache-Control", "public, max-age=3600");
      createReadStream(filePath).pipe(res);
    } catch {
      res.statusCode = 404;
      res.end("font not found");
    }
  };

  return {
    name: "myoxus-api-fonts",
    configureServer(server) {
      server.middlewares.use(serveFont);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveFont);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    define: {
      BUILD_CONFIG: JSON.stringify({
        ...getBuildConfig(new Workspace().getPackage("@myoxus/web"), {
          mode: "development",
          channel: "stable",
        }),
        debug: false,
      }),
    },
    plugins: [createDecoratorTransform(), apiFontMiddleware(), wasm()],
    oxc: {
      target: "es2022",
    },
    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
    server: {
      host: true,
      allowedHosts: true,
    },
    build: {
      target: "es2022",
      sourcemap: true,
      rolldownOptions: {
        onwarn(warning, defaultHandler) {
          if (
            warning.code &&
            ["EVAL", "SOURCEMAP_ERROR"].includes(warning.code)
          ) {
            return;
          }
          defaultHandler(warning);
        },
        treeshake: true,
      },
    },
  };
});
