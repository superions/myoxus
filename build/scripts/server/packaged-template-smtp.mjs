// SPDX-License-Identifier: AGPL-3.0-or-later
// A local SMTP receiver for the isolated packaged-template consumer journey.
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [host, directory] = process.argv.slice(2);
mkdirSync(directory, { mode: 0o700 });
const connections = new Set();
let messages = 0;
const server = createServer((socket) => {
  connections.add(socket);
  socket.on("close", () => connections.delete(socket));
  socket.on("error", () => socket.destroy());
  socket.setTimeout(30000, () => socket.destroy());
  socket.write("220 localhost ESMTP packaged fixture\r\n");
  let buffer = "";
  let data = null;
  socket.on("data", (bytes) => {
    buffer += bytes.toString("utf8");
    if (buffer.length + (data?.length ?? 0) > 1024 * 1024) {
      socket.destroy();
      return;
    }
    let end;
    while ((end = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data !== null) {
        if (line === ".") {
          writeFileSync(join(directory, `${messages++}.eml`), data, {
            mode: 0o600,
          });
          data = null;
          socket.write("250 captured\r\n");
        } else {
          data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
        }
      } else if (/^(EHLO|HELO)\b/i.test(line)) {
        socket.write("250-localhost\r\n250 8BITMIME\r\n");
      } else if (/^DATA\b/i.test(line)) {
        data = "";
        socket.write("354 send message\r\n");
      } else if (/^QUIT\b/i.test(line)) {
        socket.end("221 bye\r\n");
      } else {
        socket.write("250 OK\r\n");
      }
    }
  });
});
server.listen(0, host, () => {
  writeFileSync(
    join(directory, "ready.json"),
    JSON.stringify({ port: server.address().port }),
    { mode: 0o600 },
  );
});
process.on("SIGTERM", () => {
  for (const socket of connections) socket.destroy();
  server.close();
});
