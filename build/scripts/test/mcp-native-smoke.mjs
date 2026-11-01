#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic calls through the real CLI runtimes, not model prompts or a
// substitute MCP client. Credentials stay in the wrapper's private environment.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";

const endpoint = process.env.MYOXUS_MCP_URL;
const token = process.env.MYOXUS_MCP_TOKEN;
const workspaceId = process.env.MYOXUS_MCP_IMPORT_WORKSPACE_ID;
const root = process.env.MYOXUS_MCP_CLIENT_HOME;
const sessionCookie = process.env.MYOXUS_MCP_SMOKE_SESSION;
const keyId = process.env.MYOXUS_MCP_SMOKE_KEY_ID;
assert(
  endpoint && token && workspaceId && root && sessionCookie && keyId,
  "Missing native smoke fixture inputs",
);

class RpcProcess {
  pending = new Map();
  nextId = 0;
  buffer = Buffer.alloc(0);
  stderr = "";
  constructor(binary, args, framed, env) {
    this.framed = framed;
    this.child = spawn(binary, args, {
      cwd: root,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.receive(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2_000_000);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Native CLI exited (${code ?? signal})`)),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
  }
  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  send(message) {
    const body = JSON.stringify(message);
    this.child.stdin.write(
      this.framed
        ? `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
        : `${body}\n`,
    );
  }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length) {
        let body;
        if (this.framed) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const length = Number(
            /Content-Length: (\d+)/i.exec(
              this.buffer.subarray(0, end).toString(),
            )?.[1],
          );
          assert(
            Number.isSafeInteger(length) &&
              length >= 0 &&
              length <= 32 * 1024 * 1024,
            "Invalid native RPC frame",
          );
          if (this.buffer.length < end + 4 + length) return;
          body = this.buffer.subarray(end + 4, end + 4 + length).toString();
          this.buffer = this.buffer.subarray(end + 4 + length);
        } else {
          const end = this.buffer.indexOf("\n");
          if (end < 0) return;
          body = this.buffer.subarray(0, end).toString();
          this.buffer = this.buffer.subarray(end + 1);
        }
        if (!body.trim()) continue;
        const message = JSON.parse(body);
        if (message.method && message.id != null) {
          // No model, shell, filesystem or elicitation callbacks are delegated.
          // Native permission notifications have a separate fixture-only owner.
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: "No client callback authorized by MCP smoke",
            },
          });
        } else if (message.method) {
          Promise.resolve(this.onNotification?.(message)).catch((error) =>
            this.fail(error),
          );
        } else if (this.pending.has(message.id)) {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error)
            request.reject(
              new Error(
                JSON.stringify(message.error).replaceAll(token, "[redacted]"),
              ),
            );
          else request.resolve(message.result);
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const failures = this.stderr
          .split("\n")
          .filter((line) =>
            /401|unauthori[sz]ed|auth.?required|\bWARN\b|\bERROR\b/i.test(line),
          )
          .slice(-3)
          .join("\n")
          .replaceAll(token, "[redacted]")
          .slice(-1200);
        reject(
          new Error(
            `${method} timed out${failures ? `; native diagnostic: ${failures}` : ""}`,
          ),
        );
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async close() {
    this.fail(new Error("Native smoke transport closing"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    // CLI children are owned process groups. Bound shutdown even when a native
    // client leaves an SSE listener open after stdin EOF.
    const kill = setTimeout(() => {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }, 3000);
    try {
      this.child.stdin.end();
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await exited;
    } finally {
      clearTimeout(kill);
    }
  }
}

function payload(result, name) {
  if (typeof result === "string") result = { textResultForLlm: result };
  const errorDetail = String(
    result?.error ?? result?.textResultForLlm ?? "No native error detail",
  )
    .replaceAll(token, "[redacted]")
    .slice(0, 1000);
  assert(
    result &&
      !result.isError &&
      (result.resultType == null ||
        ["success", "complete"].includes(result.resultType)),
    `${name}: native tool invocation failed (${result?.resultType ?? "MCP error"}): ${errorDetail}`,
  );
  if (result.structuredContent != null) return result.structuredContent;
  const text =
    result.content?.find((item) => item.type === "text")?.text ??
    result.textResultForLlm;
  assert.equal(typeof text, "string", `${name}: missing native tool result`);
  const value = JSON.parse(text);
  if (value.structuredContent != null) return value.structuredContent;
  if (value.content) return payload(value, name);
  return value;
}

function nativeProtocol(client) {
  const logs = [client.rpc.stderr];
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (/\.(log|jsonl)$/.test(entry.name))
        logs.push(readFileSync(file, "utf8").slice(-2_000_000));
    }
  };
  // These are newly created, private CLI homes. Do not inspect the user's real
  // client logs or print protocol payloads/credentials from this diagnostic.
  collect(path.join(root, client.kind));
  const versions = new Set();
  for (const text of logs) {
    for (const pattern of [
      /protocol[_ ]?version[\\'":=\s]*(?:Some\()?(?:ProtocolVersion\()?['"\\]*(\d{4}-\d{2}-\d{2})/gi,
      /negotiated protocol(?: version)?(?: to)?\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2})/gi,
    ])
      for (const match of text.matchAll(pattern)) versions.add(match[1]);
  }
  assert.equal(
    versions.size,
    1,
    `${client.kind}: native protocol trace must identify one observed version, got ${[...versions]}`,
  );
  return [...versions][0];
}

async function ready(read, select) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = select(await read());
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Native Myoxus tool discovery did not become ready");
}

async function startClient(kind, expectRevoked = false) {
  const codex = kind === "codex";
  const binary = codex
    ? process.env.MYOXUS_CODEX_BIN
    : process.env.MYOXUS_COPILOT_BIN;
  assert(binary, `Missing ${kind} binary`);
  for (const directory of [root, `${root}/codex`, `${root}/copilot`])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) &&
        key !== "MYOXUS_MCP_SMOKE_SESSION",
    ),
  );
  Object.assign(env, {
    CODEX_HOME: `${root}/codex`,
    COPILOT_HOME: `${root}/copilot`,
    MYOXUS_MCP_TOKEN: token,
    COPILOT_MCP_MYOXUS_TOKEN: token,
    RUST_LOG: "rmcp=trace,codex_rmcp_client=debug",
  });
  // Approve only the fixture mutations through each native client's policy;
  // Copilot's headless permission bridge is bound to the exact workspace below.
  const rpc = new RpcProcess(
    binary,
    codex
      ? [
          "app-server",
          "--stdio",
          "-c",
          'mcp_servers.myoxus.tools.calendar_event_create.approval_mode="approve"',
          "-c",
          'mcp_servers.myoxus.tools.calendar_event_delete.approval_mode="approve"',
          "-c",
          "mcp_servers.myoxus.tool_timeout_sec=10",
        ]
      : [
          "--headless",
          "--stdio",
          "--no-auto-update",
          "--disable-client-telemetry",
          "--log-level",
          "all",
          "--log-dir",
          `${root}/copilot/logs`,
        ],
    !codex,
    env,
  );
  let sessionId;
  let offeredTools = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (!codex && sessionId) await rpc.call("session.destroy", { sessionId });
    } finally {
      await rpc.close();
    }
  };
  if (!codex)
    rpc.onNotification = async (message) => {
      const notification = message.params;
      if (
        message.method !== "session.event" ||
        notification?.event?.type !== "permission.requested"
      )
        return;
      const data = notification.event.data;
      if (data.resolvedByHook) return;
      const permission = data.permissionRequest;
      const operation = offeredTools.find((tool) =>
        [tool.name, tool.namespacedName, tool.mcpToolName].includes(
          permission.toolName,
        ),
      )?.mcpToolName;
      const fixtureWrite =
        ["calendar_event_create", "calendar_event_delete"].includes(
          operation,
        ) &&
        permission.args?.workspace_id === workspaceId &&
        permission.args?.idempotency_key?.startsWith("native-");
      const fixtureRead =
        (operation === "list_workspaces" && permission.args?.limit === 1) ||
        (operation === "calendar_events_list" &&
          permission.args?.workspace_id === workspaceId);
      const allowed =
        notification.sessionId === sessionId &&
        permission.kind === "mcp" &&
        permission.serverName === "myoxus" &&
        (fixtureWrite || fixtureRead);
      await rpc.call("session.permissions.handlePendingPermissionRequest", {
        sessionId: notification.sessionId,
        requestId: data.requestId,
        result: { kind: allowed ? "approve-once" : "user-not-available" },
      });
      assert(
        allowed,
        `Copilot permission is outside the fixture: kind=${permission.kind}; server=${permission.serverName}; tool=${permission.toolName}; argsType=${typeof permission.args}; argumentFields=${Object.keys(permission.args ?? {})}`,
      );
    };
  try {
    await rpc.call(
      codex ? "initialize" : "connect",
      codex
        ? {
            clientInfo: { name: "myoxus-native-smoke", version: "1" },
            capabilities: { experimentalApi: true },
          }
        : {},
    );
    if (codex) rpc.send({ jsonrpc: "2.0", method: "initialized" });
    const created = await rpc.call(
      codex ? "thread/start" : "session.create",
      codex
        ? { cwd: root, ephemeral: true, approvalPolicy: "never" }
        : {
            workingDirectory: root,
            enableConfigDiscovery: false,
            enableSkills: false,
            requestPermission: true,
            enableManagedSettings: false,
            enableSessionStore: false,
            disabledMcpServers: ["github-mcp-server", "githubiq"],
            // A session needs a model configuration, but this test never sends a
            // prompt or invokes inference. The provider cannot reach a real service.
            provider: {
              type: "openai",
              baseUrl: "http://127.0.0.1:9/v1",
              apiKey: "unused-transport-only",
            },
            model: "transport-only",
            mcpServers: {
              myoxus: {
                type: "http",
                url: endpoint,
                headers: { Authorization: `Bearer ${token}` },
                tools: ["*"],
              },
            },
          },
    );
    sessionId = codex ? created.thread.id : created.sessionId;
    assert(sessionId, `${kind}: missing native session`);
    if (expectRevoked) {
      const status = await ready(
        () =>
          rpc.call(
            codex ? "mcpServerStatus/list" : "session.mcp.list",
            codex ? { threadId: sessionId } : { sessionId },
          ),
        (result) => {
          const server = (codex ? result.data : result.servers).find(
            (entry) => entry.name === "myoxus",
          );
          if (!server) return null;
          const status = codex ? server.runtimeStatus : server.status;
          assert.notEqual(
            status,
            "connected",
            `${kind}: revoked key reconnected successfully`,
          );
          if (status === "authenticationRequired" || status === "needs-auth")
            return status;
          if (status === "failed") {
            const detail = server.toolsError ?? server.error ?? "";
            assert(
              /401|unauthori[sz]ed|auth(?:entication)?(?:_| )required|invalid or expired/i.test(
                detail,
              ),
              `${kind}: connection failed without a positive auth-denial diagnostic: ${detail}`,
            );
            return "authenticationRejected";
          }
          return null;
        },
      );
      await close();
      return status;
    }
    if (!codex)
      await ready(
        () => rpc.call("session.mcp.list", { sessionId }),
        (result) =>
          result.servers.find(
            (server) =>
              server.name === "myoxus" && server.status === "connected",
          ),
      );
    if (!codex)
      await rpc.call("session.tools.initializeAndValidate", { sessionId });
    const toolNames = codex
      ? await ready(
          () => rpc.call("mcpServerStatus/list", { threadId: sessionId }),
          (result) => {
            const server = result.data.find((entry) => entry.name === "myoxus");
            return server?.tools &&
              Object.values(server.tools).some(
                (tool) => tool.name === "list_workspaces",
              )
              ? Object.keys(server.tools)
              : null;
          },
        )
      : await ready(
          () => rpc.call("session.tools.getCurrentMetadata", { sessionId }),
          (result) => {
            offeredTools = result.tools?.filter(
              (tool) => tool.mcpServerName === "myoxus",
            );
            return offeredTools?.some(
              (tool) => tool.mcpToolName === "list_workspaces",
            )
              ? offeredTools.map((tool) => tool.name)
              : null;
          },
        );
    const invoke = async (name, args) => {
      assert(
        [
          "list_workspaces",
          "calendar_events_list",
          "calendar_event_create",
          "calendar_event_delete",
        ].includes(name),
        "Native smoke cannot invoke unrelated tools",
      );
      if (name !== "list_workspaces")
        assert.equal(
          args.workspace_id,
          workspaceId,
          "Native calls must stay in their fixture workspace",
        );
      if (["calendar_event_create", "calendar_event_delete"].includes(name))
        assert(
          args.idempotency_key?.startsWith("native-"),
          "Native writes require their fixture replay key",
        );
      if (codex)
        return rpc.call("mcpServer/tool/call", {
          threadId: sessionId,
          server: "myoxus",
          tool: name,
          arguments: args,
        });
      const offered = offeredTools.find(
        (tool) => tool.mcpToolName === name,
      )?.name;
      assert(offered, `${kind}: ${name} is absent from native discovery`);
      return rpc.call("session.tools.execute", {
        sessionId,
        name: offered,
        arguments: args,
      });
    };
    return {
      kind,
      rpc,
      invoke,
      toolNames,
      version: execFileSync(binary, ["--version"], { encoding: "utf8" }).split(
        "\n",
      )[0],
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${kind}: startup and cleanup failed`,
      );
    }
    throw error;
  }
}

async function journey(client) {
  payload(
    await client.invoke("list_workspaces", { limit: 1 }),
    "list_workspaces",
  );
  const start = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const args = {
    workspace_id: workspaceId,
    title: `Native ${client.kind} retry smoke`,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    idempotency_key: `native-${client.kind}-${crypto.randomUUID()}`,
  };
  let eventId;
  try {
    const created = payload(
      await client.invoke("calendar_event_create", args),
      "calendar_event_create",
    );
    eventId = created.id;
    assert(eventId, "Native calendar write returned no identity");
    const replay = payload(
      await client.invoke("calendar_event_create", args),
      "calendar_event_create replay",
    );
    assert.deepEqual(
      replay,
      created,
      "Native same-key replay changed the committed result",
    );
    const readback = payload(
      await client.invoke("calendar_events_list", {
        workspace_id: workspaceId,
        from: start.toISOString(),
        to: end.toISOString(),
      }),
      "calendar_events_list",
    );
    assert.equal(
      readback.events.filter((event) => event.id === eventId).length,
      1,
      "Native readback must contain the committed event exactly once",
    );
  } finally {
    if (eventId)
      payload(
        await client.invoke("calendar_event_delete", {
          workspace_id: workspaceId,
          event_id: eventId,
          idempotency_key: `native-cleanup-${crypto.randomUUID()}`,
        }),
        "calendar_event_delete",
      );
  }
}

const clients = [];
const failures = [];
try {
  for (const kind of ["codex", "copilot"]) {
    const client = await startClient(kind);
    clients.push(client);
    try {
      await journey(client);
      client.negotiatedProtocol = nativeProtocol(client);
    } catch (error) {
      throw new Error(`${kind} native consuming journey failed`, {
        cause: error,
      });
    }
  }
  await Promise.all(clients.map((client) => client.close()));
  const revoked = await fetch(
    `${process.env.MYOXUS_API_URL ?? "http://localhost:3001"}/graphql`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `affine_session=${sessionCookie}`,
      },
      body: JSON.stringify({
        query: "mutation($id:String!){apiKeys{revokeApiKey(id:$id)}}",
        variables: { id: keyId },
      }),
    },
  );
  assert(revoked.ok, "Native smoke key revocation HTTP failure");
  const revocation = await revoked.json();
  assert(
    !revocation.errors && revocation.data?.apiKeys?.revokeApiKey === true,
    "Native smoke key revocation failed",
  );
  for (const client of clients) {
    client.revocationStatus = await startClient(client.kind, true);
  }
  process.stdout.write(
    `${JSON.stringify({ clients: clients.map((client) => ({ name: client.kind, version: client.version, negotiatedProtocol: client.negotiatedProtocol, protocolEvidence: "native client trace", visibleTools: client.toolNames.length, authorizedRead: true, committedWriteReadback: true, sameKeyReplay: true, revokedKeyRejected: true, revocationStatus: client.revocationStatus, revocationEvidence: "fresh native connection with the original revoked credential", outcome: "native calls pass" })), keyRevoked: true }, null, 2)}\n`,
  );
} catch (error) {
  failures.push(error);
} finally {
  const results = await Promise.allSettled(
    clients.map((client) => client.close()),
  );
  for (const result of results)
    if (result.status === "rejected") failures.push(result.reason);
}
if (failures.length)
  throw new AggregateError(
    failures,
    "Native MCP journey or client cleanup failed",
  );
