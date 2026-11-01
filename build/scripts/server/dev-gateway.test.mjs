import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

test(
  "development proxy preserves asset routing and propagates stream cancellation",
  { timeout: 15000 },
  async (t) => {
    let streamingResponse;
    const upstream = createServer((req, res) => {
      if (req.url === "/api/copilot/chat/owned/stream-object") {
        streamingResponse = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial\n\n");
      } else res.end(req.url);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => {
      upstream.closeAllConnections();
      return new Promise((resolve) => upstream.close(resolve));
    });
    const assetOrigin = `http://127.0.0.1:${upstream.address().port}`;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const gateway = spawn(
      process.execPath,
      ["build/scripts/server/dev-gateway.mjs"],
      {
        env: {
          ...process.env,
          MYOXUS_DEV_GATEWAY_PORT: String(port),
          MYOXUS_DEV_ASSET_ORIGIN: assetOrigin,
          MYOXUS_DEV_BACKEND_ORIGIN: assetOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(async () => {
      if (gateway.exitCode === null) {
        const exit = once(gateway, "exit");
        gateway.kill("SIGTERM");
        await exit;
      }
    });
    await new Promise((resolve, reject) => {
      gateway.stdout.on("data", (chunk) => {
        if (String(chunk).includes("listening on")) resolve();
      });
      gateway.once("error", reject);
      gateway.once("exit", (code) =>
        reject(new Error(`Gateway exited before readiness: ${code}`)),
      );
    });
    for (const [request, expected] of [
      [
        "/style/logo.svg?v=server-version&ts=1",
        "/style/logo.svg?v=server-version&ts=1",
      ],
      [
        "/adminfrontend/style/product-mark.svg?v=version",
        "/style/product-mark.svg?v=version",
      ],
      [
        "/api/fonts/uploaded.woff2?v=font-version",
        "/api/fonts/uploaded.woff2?v=font-version",
      ],
      [
        "/adminfrontend/api/fonts/uploaded.woff2?v=font-version",
        "/api/fonts/uploaded.woff2?v=font-version",
      ],
      ["/favicon-192.png?v=icon-version", "/favicon-192.png?v=icon-version"],
      ["/favicon.svg", "/favicon.svg"],
      ["/public/workspace/document", "/public/workspace/document"],
      ["/public-assets/workspace/blob", "/public-assets/workspace/blob"],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${request}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), expected);
    }
    const response = await fetch(
      `http://127.0.0.1:${port}/api/copilot/chat/owned/stream-object`,
    );
    const reader = response.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "data: partial\n\n",
    );
    const closed = once(streamingResponse, "close", {
      signal: AbortSignal.timeout(2000),
    });
    await reader.cancel();
    await closed;
    assert.equal(
      streamingResponse.destroyed,
      true,
      "Stop must not leave provider generation connected upstream",
    );
  },
);
