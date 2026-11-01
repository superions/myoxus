// SPDX-License-Identifier: AGPL-3.0-or-later
// Real transport consumers for the isolated two-process fixture. The owning
// wrapper removes the database, Redis namespace and sockets on every exit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { io } from "socket.io-client";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";

const {
  MYOXUS_MI_API1_URL: initialA,
  MYOXUS_MI_API2_URL: initialB,
  MYOXUS_MI_PROJECT: project,
  MYOXUS_MI_ADMIN_EMAIL: email,
  MYOXUS_MI_ADMIN_PASSWORD: password,
} = process.env;
let a = initialA;
let b = initialB;
assert(a && b && project && email && password, "owning fixture required");
const compose = [
  "compose",
  "-p",
  project,
  "-f",
  "build/server/docker-compose.multi-instance.yml",
];
function docker(...args) {
  return execFileSync("docker", [...compose, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}
function apiAddress(service) {
  // Dynamic host ports can change after a container restart.
  const port = docker("port", service, "3001")
    .split("\n")
    .at(-1)
    .split(":")
    .at(-1);
  assert(/^\d+$/.test(port), "published API port");
  return `http://127.0.0.1:${port}`;
}
function sql(statement) {
  return execFileSync(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "postgres-mi",
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "myoxus_mi",
      "-d",
      "myoxus_mi",
      "-At",
    ],
    { input: statement, encoding: "utf8", timeout: 15_000 },
  ).trim();
}
function redis(...args) {
  return docker("exec", "-T", "redis-mi", "redis-cli", "--raw", ...args);
}
async function login(address, userEmail) {
  const response = await fetch(`${address}/api/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "fixture sign-in");
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function gql(address, cookie, query, variables = {}) {
  const response = await fetch(`${address}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert(
    !value.errors,
    `GraphQL fixture failed: ${JSON.stringify(value.errors)}`,
  );
  return value.data;
}
const sockets = [];
const awarenessStates = [];
async function peer(address, cookie) {
  const socket = io(address, {
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { Cookie: cookie },
    autoConnect: false,
  });
  const received = [];
  socket.on("notification:push", (envelope) => {
    received.push(envelope);
    socket.emit("notification:ack", { eventId: envelope.eventId });
  });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("socket connection deadline")),
      10_000,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("subscription deadline")),
      10_000,
    );
    socket.once("notification:subscribe", (value) => {
      clearTimeout(timer);
      assert(value.data.success);
      resolve();
    });
    socket.emit("notification:subscribe", {});
  });
  return { socket, received };
}
async function until(predicate, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`deadline: ${label}`);
}
async function sameDelivery(peers, predicate, label, timeout = 15_000) {
  await until(
    () => peers.every((p) => p.received.some(predicate)),
    label,
    timeout,
  );
  const events = peers.map((p) => p.received.find(predicate));
  assert(
    events.every((event) => event.eventId === events[0].eventId),
    `${label}: identity must survive cluster transit`,
  );
  await delay(200);
  peers.forEach((p) =>
    assert.equal(
      p.received.filter(predicate).length,
      1,
      `${label}: no origin/ACK duplicate`,
    ),
  );
  return events[0];
}
function enqueue(queue, name, data) {
  // Feed the existing worker's deployed BullMQ input; never invoke a publisher.
  const prefix = `bull:myoxus:${queue}`;
  const id = randomUUID();
  const now = Date.now();
  const opts = { maxAttempts: 3 };
  const job = {
    id,
    name,
    data,
    opts,
    timestamp: now,
    attemptsMade: 0,
    finishedOn: null,
    failedReason: null,
    heartbeat: null,
    returnvalue: null,
  };
  redis(
    "HSET",
    `${prefix}:${id}`,
    "name",
    name,
    "data",
    JSON.stringify(data),
    "opts",
    JSON.stringify(opts),
    "timestamp",
    String(now),
    "attemptsMade",
    "0",
    "_json",
    JSON.stringify(job),
  );
  redis("LPUSH", `${prefix}:wait`, id);
  return id;
}
let paused = false;
let redisPaused = false;
try {
  const cookie = await login(a, email);
  const { currentUser: owner } = await gql(
    a,
    cookie,
    "query { currentUser { id } }",
  );
  const outsiderEmail = `outsider-${process.env.MYOXUS_MI_RUN_ID}@example.test`;
  const outsiderCookie = await login(a, outsiderEmail);
  const peers = [
    await peer(a, cookie),
    await peer(b, cookie),
    await peer(b, cookie),
  ];
  const outsider = await peer(b, outsiderCookie);
  const invitationWorkspace = (
    await gql(a, outsiderCookie, "mutation { createWorkspace { id } }")
  ).createWorkspace.id;
  docker("pause", "api-2");
  paused = true;
  // Exercise the deployed producer/outbox/queue chain, not a fabricated job.
  const invitation = (
    await gql(
      a,
      outsiderCookie,
      "mutation($workspace:String!,$emails:[String!]!){inviteMembers(workspaceId:$workspace,emails:$emails){inviteId sentSuccess}}",
      { workspace: invitationWorkspace, emails: [email] },
    )
  ).inviteMembers[0];
  assert(invitation.sentSuccess);
  const invitationPush = (e) =>
    e.payload.payload?.inviteId === invitation.inviteId;
  await until(
    () => peers[0].received.some(invitationPush),
    "invitation job executed on A",
  );
  assert(
    docker("logs", "--no-color", "api-1").includes(
      "processing notification job",
    ),
    "real queue handler executed on A while B is paused",
  );
  docker("unpause", "api-2");
  paused = false;
  const created = await sameDelivery(
    peers,
    invitationPush,
    "general invitation notification job",
  );
  assert.equal(created.payload.payload.workspace.id, invitationWorkspace);
  assert.equal(created.payload.payload.createdByUser.name, "Unrelated fixture");
  assert.equal(created.eventType, "notification_new");
  assert.equal(
    outsider.received.length,
    0,
    "unrelated user receives no user-scoped push",
  );
  const invitationFeed = await gql(
    b,
    cookie,
    "query { currentUser { notifications(pagination:{first:10}) { edges { node { id type body } } } } }",
  );
  const invitationNode = invitationFeed.currentUser.notifications.edges
    .map(({ node }) => node)
    .find((node) => node.id === created.payload.notificationId);
  assert.equal(
    invitationNode.type,
    "Invitation",
    "worker discriminator reaches the actionable Inbox consumer",
  );
  assert.equal(invitationNode.body.inviteId, invitation.inviteId);
  const id = created.payload.notificationId;
  await gql(a, cookie, "mutation($id: String!) { readNotification(id: $id) }", {
    id,
  });
  await sameDelivery(
    peers,
    (e) =>
      e.eventType === "notification_read" && e.payload.notificationId === id,
    "read on A",
  );

  await gql(
    a,
    cookie,
    "mutation($workspace:String!,$invite:String!){acceptInviteById(workspaceId:$workspace,inviteId:$invite)}",
    { workspace: invitationWorkspace, invite: invitation.inviteId },
  );
  const accepted = await sameDelivery(
    [outsider],
    (event) => event.payload.notificationType === "invitation_accepted",
    "invitation acceptance retains inviter",
  );
  assert.equal(
    accepted.payload.payload.createdByUser.name,
    "Multi-instance fixture",
  );
  assert.equal(accepted.payload.payload.workspace.id, invitationWorkspace);
  assert.equal(
    sql(
      `SELECT invited_by_user_id FROM workspace_memberships WHERE id = '${invitation.inviteId}';`,
    ),
    accepted.payload.payload.userId,
  );
  outsider.received.length = 0;

  const workspace = (
    await gql(a, cookie, "mutation { createWorkspace { id } }")
  ).createWorkspace.id;
  const database = (
    await gql(
      a,
      cookie,
      "mutation($input: CreateDatabaseInput!) { createDatabase(input: $input) { database { id } } }",
      {
        input: {
          workspaceId: workspace,
          title: "Cluster reminders",
          initialViewKind: "Table",
        },
      },
    )
  ).createDatabase.database.id;
  const field = (
    await gql(
      a,
      cookie,
      "mutation($input: CreateDatabaseFieldInput!) { createDatabaseField(input: $input) { id } }",
      {
        input: {
          databaseId: database,
          name: "Due",
          fieldType: "DateTime",
          config: {
            dateTime: { defaultTimeZone: "UTC", allowReminders: true },
          },
        },
      },
    )
  ).createDatabaseField.id;
  const row = (
    await gql(
      a,
      cookie,
      "mutation($input: CreateDatabaseRowInput!) { createDatabaseRow(input: $input) { row { id } } }",
      {
        input: {
          databaseId: database,
          title: "Due row",
          cells: [
            {
              fieldId: field,
              value: {
                dateTime: {
                  start: new Date(Date.now() + 86_400_000).toISOString(),
                  allDay: false,
                  timeZone: "UTC",
                },
              },
            },
          ],
        },
      },
    )
  ).createDatabaseRow.row.id;
  const reminder = (
    await gql(
      a,
      cookie,
      "mutation($input: SetDatabaseRowReminderInput!) { setDatabaseRowReminder(input: $input) { id } }",
      {
        input: {
          databaseId: database,
          rowId: row,
          fieldId: field,
          offsetMinutes: 10,
        },
      },
    )
  ).setDatabaseRowReminder.id;
  // Advance only the owned schedule; the real scheduler and generation/access
  // validator still consume it, as in the existing Database reminder harness.
  sql(
    `UPDATE database_row_reminders SET trigger_at = now() - interval '1 second' WHERE id = '${reminder}';`,
  );
  // Cron -> Database and Database -> Notification each cross the existing
  // delayed-job promotion cadence. Observe the committed dispatch separately
  // so the delivery deadline is not spent waiting for the preceding queue.
  await until(
    () =>
      sql(
        `SELECT status::text FROM database_row_reminders WHERE id = '${reminder}';`,
      ) === "fired",
    "Database reminder scheduler dispatch",
    45_000,
  );
  await sameDelivery(
    peers,
    (e) =>
      e.eventType === "notification_new" &&
      e.payload.notificationType === "database_row_reminder",
    "Database reminder",
    // Allow the Notification queue's own promotion after committed dispatch.
    45_000,
  );

  const accountId = randomUUID(),
    eventId = randomUUID(),
    reminderId = randomUUID();
  sql(`INSERT INTO calendar_accounts (id, user_id, provider, remote_account_id, config) VALUES ('${accountId}', '${owner.id}', 'google', '${accountId}', '{}'::jsonb);
    INSERT INTO calendar_events (id, account_id, remote_event_id, starts_at, ends_at, title, payload) VALUES ('${eventId}', '${accountId}', '${eventId}', now() + interval '1 hour', now() + interval '2 hours', 'Cluster calendar reminder', '{}'::jsonb);
    INSERT INTO calendar_reminders (id, event_id, channel, minutes_before, scheduled_for) VALUES ('${reminderId}', '${eventId}', 'in_app', 60, now());`);
  enqueue("calendar-reminder", "calendar.processReminder", {
    reminder_id: reminderId,
  });
  await sameDelivery(
    peers,
    (e) =>
      e.eventType === "calendar_reminder_due" && e.payload.eventId === eventId,
    "Calendar reminder",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM notifications WHERE user_id = '${owner.id}' AND idempotency_key = 'calendar_reminder_${reminderId}';`,
    ),
    "1",
    "Calendar reminder persists once",
  );
  await gql(b, cookie, "mutation { readAllNotifications }");
  await sameDelivery(
    peers,
    (e) => e.eventType === "notification_read_all",
    "read-all on B",
  );

  // Kill subscriber connections only. Keep Redis commands and persisted state
  // available, proving missed Pub/Sub cannot replace authoritative reload.
  redis("CLIENT", "KILL", "TYPE", "pubsub");
  await delay(100);
  const lostKey = randomUUID();
  enqueue("notification", "notification.sendInvitation", {
    userId: owner.id,
    notificationType: "workspace_invitation",
    idempotencyKey: lostKey,
  });
  await until(
    () =>
      sql(
        `SELECT count(*) FROM notifications WHERE user_id = '${owner.id}' AND idempotency_key = '${lostKey}';`,
      ) === "1",
    "lost push remains persisted",
  );
  const lostId = sql(
    `SELECT id FROM notifications WHERE user_id = '${owner.id}' AND idempotency_key = '${lostKey}';`,
  );
  assert(
    peers.every(
      (peer) =>
        !peer.received.some(
          (event) => event.payload.payload?.idempotencyKey === lostKey,
        ),
    ),
    "the fixture must actually lose the push",
  );
  const reload = await gql(
    b,
    cookie,
    "query { currentUser { notifications(pagination: {first: 100}) { edges { node { id read } } } } }",
  );
  assert(
    reload.currentUser.notifications.edges.some(
      ({ node }) => node.id === lostId && !node.read,
    ),
    "B reload sees missed notification",
  );
  await delay(5500);
  const recoveredKey = randomUUID();
  enqueue("notification", "notification.sendInvitation", {
    userId: owner.id,
    notificationType: "workspace_invitation",
    idempotencyKey: recoveredKey,
  });
  await sameDelivery(
    peers,
    (e) => e.payload.payload?.idempotencyKey === recoveredKey,
    "subscriber reconnect",
  );
  assert.equal(outsider.received.length, 0);
  console.log(
    "cluster notification producer -> subscribed wire consumers: passed",
  );

  const context = {
    client: "storage",
    clientFormat: "myoxus-native",
    clientCapabilities: "document-metadata,sync",
  };
  const userspace = { ...context, spaceType: "userspace", spaceId: owner.id };
  const docId = `userspace-cluster-${randomUUID()}`;
  const docEvents = new Map();
  for (const { socket } of [...peers, outsider]) {
    const events = [];
    docEvents.set(socket, events);
    for (const event of [
      "space:broadcast-doc-update",
      "space:broadcast-doc-updates",
    ]) {
      socket.on(event, (payload) => events.push({ event, payload }));
    }
  }
  const emitAck = (socket, event, payload) =>
    socket.timeout(10_000).emitWithAck(event, payload);
  for (const { socket } of peers.slice(0, 2)) {
    const joined = await emitAck(socket, "space:join", {
      ...userspace,
      clientVersion: "0.41.5",
    });
    assert.equal(
      joined.data.success,
      true,
      "authenticated userspace owner joined",
    );
  }
  assert.equal(
    (
      await emitAck(outsider.socket, "space:join", {
        ...userspace,
        clientVersion: "0.41.5",
      })
    ).data.success,
    false,
    "non-owner cannot join userspace",
  );
  assert.equal(
    (
      await emitAck(peers[2].socket, "space:join", {
        ...context,
        spaceType: "workspace",
        spaceId: invitationWorkspace,
        clientVersion: "0.41.5",
      })
    ).data.success,
    true,
    "workspace-only recipient joined its own scope",
  );
  const firstLoad = await emitAck(peers[1].socket, "space:load-doc", {
    ...userspace,
    docId,
  });
  assert(!firstLoad.error, "userspace empty first load remains valid");
  const source = new Y.Doc();
  const remote = new Y.Doc();
  source.getMap("cluster-invariant").set("value", "durable userspace on A");
  const encoded = Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64");
  const persisted = await emitAck(peers[0].socket, "space:push-doc-update", {
    ...userspace,
    docId,
    update: encoded,
  });
  assert(!persisted.error, "userspace persistence ACK succeeds");
  assert.equal(persisted.data.accepted, true);
  await until(
    () => docEvents.get(peers[1].socket).length === 1,
    "B userspace document broadcast",
  );
  const received = docEvents.get(peers[1].socket)[0];
  assert.equal(
    received.event,
    "space:broadcast-doc-updates",
    "supported client receives only sync-026 format",
  );
  assert.equal(received.payload.spaceType, "userspace");
  assert.equal(received.payload.spaceId, owner.id);
  assert.equal(received.payload.docId, docId);
  assert.equal(received.payload.compressed, false);
  for (const update of received.payload.updates)
    Y.applyUpdate(remote, Buffer.from(update, "base64"));
  assert.equal(
    remote.getMap("cluster-invariant").get("value"),
    "durable userspace on A",
    "actual B CRDT consumer applies A update",
  );
  await delay(300);
  assert.equal(
    docEvents.get(peers[1].socket).length,
    1,
    "origin suppression avoids duplicate delivery",
  );
  for (const [label, { socket }] of [
    ["sender", peers[0]],
    ["workspace-room recipient", peers[2]],
    ["non-owner", outsider],
  ]) {
    assert.equal(
      docEvents.get(socket).length,
      0,
      `${label} receives no userspace update`,
    );
  }
  const denied = await emitAck(outsider.socket, "space:load-doc", {
    ...userspace,
    docId,
  });
  assert(denied.error, "non-owner cannot load durable userspace content");
  peers[0].socket.disconnect();
  const reconnected = await peer(b, cookie);
  const loaded = await emitAck(reconnected.socket, "space:load-doc", {
    ...userspace,
    docId,
  });
  assert(!loaded.error, "reconnect to another node reloads durable result");
  const restored = new Y.Doc();
  Y.applyUpdate(restored, Buffer.from(loaded.data.missing, "base64"));
  assert.equal(
    restored.getMap("cluster-invariant").get("value"),
    "durable userspace on A",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM docs WHERE userspace_owner_id='${owner.id}' AND external_id='${docId}';`,
    ),
    "1",
  );
  [source, remote, restored].forEach((doc) => doc.destroy());
  console.log(
    "cluster userspace durable producer -> B CRDT/reconnect consumer: passed",
  );

  // Client-owned state, discovery and application use the actual Yjs Awareness
  // codec; these peers never push a document mutation.
  const awarenessScope = { ...userspace, docId };
  const publisher = await peer(a, cookie);
  const localRecipient = await peer(a, cookie);
  const otherDocument = await peer(b, cookie);
  const traces = new Map();
  const joinAwareness = async (socket, scope) => {
    const events = [];
    traces.set(socket, events);
    for (const event of [
      "space:collect-awareness",
      "space:broadcast-awareness-update",
    ])
      socket.on(event, (payload) => events.push({ event, payload }));
    const joined = await emitAck(socket, "space:join-awareness", {
      ...scope,
      clientVersion: "0.41.5",
    });
    assert.equal(joined.data.success, true, "authorized awareness join");
  };
  for (const socket of [
    publisher.socket,
    localRecipient.socket,
    reconnected.socket,
  ])
    await joinAwareness(socket, awarenessScope);
  await joinAwareness(otherDocument.socket, {
    ...userspace,
    docId: `${docId}-other`,
  });
  await joinAwareness(peers[2].socket, {
    ...context,
    spaceType: "workspace",
    spaceId: invitationWorkspace,
    docId,
  });
  const outsiderId = (
    await gql(b, outsiderCookie, "query { currentUser { id } }")
  ).currentUser.id;
  await joinAwareness(outsider.socket, {
    ...context,
    spaceType: "userspace",
    spaceId: outsiderId,
    docId,
  });
  assert.equal(
    (
      await emitAck(outsider.socket, "space:join-awareness", {
        ...awarenessScope,
        clientVersion: "0.41.5",
      })
    ).data.success,
    false,
    "wrong owner awareness join denied",
  );

  const makeAwareness = () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awarenessStates.push({ doc, awareness });
    return awareness;
  };
  const current = makeAwareness();
  current.setLocalState({ user: { name: "A" }, cursor: 5 });
  const publishCurrent = () =>
    publisher.socket.emit("space:update-awareness", {
      ...awarenessScope,
      awarenessUpdate: Buffer.from(
        encodeAwarenessUpdate(current, [current.clientID]),
      ).toString("base64"),
    });
  publisher.socket.on("space:collect-awareness", publishCurrent);
  const consume = (socket) => {
    const awareness = makeAwareness();
    awareness.setLocalState(null);
    socket.on("space:broadcast-awareness-update", (payload) => {
      assert.equal(payload.spaceType, awarenessScope.spaceType);
      assert.equal(payload.spaceId, awarenessScope.spaceId);
      assert.equal(payload.docId, awarenessScope.docId);
      applyAwarenessUpdate(
        awareness,
        Buffer.from(payload.awarenessUpdate, "base64"),
        "remote",
      );
    });
    return awareness;
  };
  const consumer = consume(reconnected.socket);
  reconnected.socket.emit("space:load-awarenesses", awarenessScope);
  await until(
    () => consumer.getStates().get(current.clientID)?.cursor === 5,
    "initial collection finds existing A on B",
  );
  await delay(250);
  const count = (socket, event) =>
    traces.get(socket).filter((item) => item.event === event).length;
  assert.equal(count(publisher.socket, "space:collect-awareness"), 1);
  assert.equal(
    count(reconnected.socket, "space:collect-awareness"),
    0,
    "collection excludes its sender",
  );
  assert.equal(
    count(reconnected.socket, "space:broadcast-awareness-update"),
    1,
  );
  assert.equal(
    count(localRecipient.socket, "space:broadcast-awareness-update"),
    1,
    "same-node delivery is not echoed through Redis",
  );
  assert.equal(
    count(publisher.socket, "space:broadcast-awareness-update"),
    0,
    "update excludes its sender",
  );
  current.setLocalStateField("cursor", 35);
  publishCurrent();
  await until(
    () => consumer.getStates().get(current.clientID)?.cursor === 35,
    "subsequent cursor arrives on B",
  );
  await delay(250);
  assert.equal(
    count(reconnected.socket, "space:broadcast-awareness-update"),
    2,
  );
  assert.equal(
    count(localRecipient.socket, "space:broadcast-awareness-update"),
    2,
  );
  assert.equal(count(publisher.socket, "space:broadcast-awareness-update"), 0);
  for (const socket of [otherDocument.socket, peers[2].socket, outsider.socket])
    assert.deepEqual(
      traces.get(socket),
      [],
      "other document/space/user receives no awareness",
    );

  // Invalid Redis payloads must not fall through to the generic sync room,
  // which these authorized userspace peers have also joined.
  for (const malformed of [
    { ...awarenessScope, spaceType: "invalid" },
    { ...awarenessScope, spaceId: outsiderId },
    { ...awarenessScope, docId: " " },
    { ...awarenessScope, awarenessUpdate: null },
    { ...awarenessScope, awarenessUpdate: 4 },
  ]) {
    const subscribers = redis(
      "PUBLISH",
      `myoxus:socket:ws:broadcast:${owner.id}`,
      JSON.stringify({
        origin_instance: randomUUID(),
        event: "space:broadcast-awareness-update",
        workspace_id: owner.id,
        sender_socket_id: "invalid-fixture",
        payload: malformed,
      }),
    );
    assert(
      Number(subscribers) >= 2,
      "malformed fixture reaches both real Redis subscribers",
    );
  }
  await delay(250);
  assert.equal(
    count(reconnected.socket, "space:broadcast-awareness-update"),
    2,
  );
  reconnected.socket.disconnect();
  const fresh = await peer(b, cookie);
  await joinAwareness(fresh.socket, awarenessScope);
  const recovered = consume(fresh.socket);
  fresh.socket.emit("space:load-awarenesses", awarenessScope);
  await until(
    () => recovered.getStates().get(current.clientID)?.cursor === 35,
    "reconnect recollects current ephemeral state",
  );
  await delay(250);
  assert.equal(count(fresh.socket, "space:broadcast-awareness-update"), 1);
  assert.equal(count(publisher.socket, "space:collect-awareness"), 2);
  console.log(
    "cluster Awareness discovery -> B state/cursor/reconnect consumer: passed",
  );

  // Existing workspace minute metrics must be a cluster snapshot, not the
  // subset of whichever API happened to write last. Old peers must not keep
  // fixture memberships alive during leave/crash assertions.
  sockets.forEach((socket) => socket.disconnect());
  const metricScope = {
    ...context,
    spaceType: "workspace",
    spaceId: invitationWorkspace,
    clientVersion: "0.41.5",
  };
  const membershipKey = `myoxus:socket:ws:sessions:${invitationWorkspace}`;
  // Exercise the ephemeral Set -> leased Hash cutover in the existing owner.
  redis("DEL", membershipKey);
  redis("SADD", membershipKey, "obsolete-instance:obsolete-socket");
  const joinMetric = async (address, identity) => {
    const connection = await peer(address, identity);
    assert.equal(
      (await emitAck(connection.socket, "space:join", metricScope)).data
        .success,
      true,
    );
    return connection;
  };
  const latestCount = () =>
    Number(
      sql(
        `SELECT active_users FROM workspace_analytics_minute WHERE workspace_id = '${invitationWorkspace}' ORDER BY bucket_at DESC LIMIT 1;`,
      ),
    );
  const expectMetric = async (count, label) => {
    await until(() => latestCount() === count, label);
    // A second heartbeat cannot regress this stable membership state.
    await delay(1200);
    assert.equal(
      latestCount(),
      count,
      `${label}: every writer uses the global quantity`,
    );
  };
  let metricA = await joinMetric(a, cookie);
  let metricB = await joinMetric(b, outsiderCookie);
  await expectMetric(2, "two distinct users split across API nodes");
  assert.equal(redis("TYPE", membershipKey), "hash");
  assert.equal(
    redis("HEXISTS", membershipKey, "obsolete-instance:obsolete-socket"),
    "0",
  );
  metricB.socket.emit("space:leave", metricScope);
  metricB.socket.disconnect();
  metricB = await joinMetric(b, cookie);
  await expectMetric(1, "one authenticated user on two nodes counts once");
  metricA.socket.emit("space:leave", metricScope);
  metricA.socket.disconnect();
  await expectMetric(1, "leaving one socket retains the other user's presence");
  metricB.socket.emit("space:leave", metricScope);
  metricB.socket.disconnect();
  await expectMetric(0, "the final leave persists zero");
  metricA = await joinMetric(a, cookie);
  metricB = await joinMetric(b, outsiderCookie);
  await expectMetric(2, "both users joined before abrupt process loss");
  docker("kill", "-s", "KILL", "api-1");
  await expectMetric(1, "crashed API membership expires while B renews");
  docker("start", "api-1");
  a = apiAddress("api-1");
  await until(
    async () => {
      try {
        return (
          await fetch(`${a}/ready`, { signal: AbortSignal.timeout(1000) })
        ).ok;
      } catch (error) {
        if (error instanceof TypeError || error.name === "TimeoutError")
          return false;
        throw error;
      }
    },
    "API A restarted after owned crash",
    60_000,
  );
  metricA = await joinMetric(a, cookie);
  await expectMetric(2, "restarted process registers a new live identity");
  const skippedBefore = (
    docker("logs", "--no-color", "api-2").match(
      /cluster workspace analytics unavailable; metric sample skipped/g,
    ) ?? []
  ).length;
  docker("pause", "redis-mi");
  redisPaused = true;
  metricB.socket.emit("space:leave", metricScope);
  await until(
    () =>
      (
        docker("logs", "--no-color", "api-2").match(
          /cluster workspace analytics unavailable; metric sample skipped/g,
        ) ?? []
      ).length > skippedBefore,
    "Redis outage skips authoritative analytics sample",
    15_000,
  );
  assert.equal(
    latestCount(),
    2,
    "Redis failure must not overwrite the last global sample with a local subset",
  );
  docker("unpause", "redis-mi");
  redisPaused = false;
  metricB.socket.disconnect();
  await expectMetric(
    1,
    "Redis recovery restores the shared snapshot after failed leave",
  );

  // The existing Admin query preserves its minute/timeline aggregation. Compare
  // its actual projection with the persisted rows rather than inventing an
  // instantaneous dashboard count or changing the public operation.
  const persistedProjection = () =>
    sql(`
    SELECT json_build_object(
      'total', (SELECT COALESCE(SUM(active_users),0) FROM workspace_analytics_minute WHERE bucket_at > now() - interval '5 minutes'),
      'latest', (SELECT json_build_object('minute', bucket_at, 'count', SUM(active_users)) FROM workspace_analytics_minute GROUP BY bucket_at ORDER BY bucket_at DESC LIMIT 1)
    );`);
  await until(async () => {
    const before = persistedProjection();
    const dashboard = (
      await gql(
        b,
        cookie,
        "query { admin { adminDashboard { syncActiveUsers syncActiveUsersTimeline { minute activeUsers } } } }",
      )
    ).admin.adminDashboard;
    if (persistedProjection() !== before) return false; // A minute boundary may add another sample.
    const persisted = JSON.parse(before);
    assert.equal(dashboard.syncActiveUsers, persisted.total);
    assert(
      dashboard.syncActiveUsersTimeline.some(
        (sample) =>
          Date.parse(sample.minute) === Date.parse(persisted.latest.minute) &&
          sample.activeUsers === persisted.latest.count,
      ),
      "Admin timeline consumes the globally scoped persisted minute sample",
    );
    return true;
  }, "stable persisted Admin projection");
  console.log(
    "cluster membership join/renew/leave/crash/Redis failure -> persisted Admin consumer: passed",
  );

  sockets.forEach((socket) => socket.disconnect());
  const updates = [
    { module: "websocket", key: "eio_ping_interval_seconds", value: 2 },
    { module: "websocket", key: "eio_ping_timeout_seconds", value: 3 },
  ];
  const saved = await gql(
    a,
    cookie,
    "mutation Update($updates:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$updates){applied fieldErrors{path}}}}",
    { updates },
  );
  assert.equal(saved.admin.adminUpdateConfig.applied, true);
  assert.deepEqual(saved.admin.adminUpdateConfig.fieldErrors, []);
  const configQuery =
    "{admin{adminConfigValues{effectiveFields{path runtimeEffectiveValue runtimeEffectiveState}}}}";
  const beforeRestart = await gql(b, cookie, configQuery);
  const intervalField =
    beforeRestart.admin.adminConfigValues.effectiveFields.find(
      (field) => field.path === "websocket.eio_ping_interval_seconds",
    );
  assert.equal(intervalField.runtimeEffectiveValue, 60);
  assert.equal(intervalField.runtimeEffectiveState, "PENDING_RESTART");
  docker("restart", "--timeout", "1", "api-1", "api-2");
  a = apiAddress("api-1");
  b = apiAddress("api-2");
  await until(
    async () => {
      try {
        const responses = await Promise.all(
          [a, b].map((address) =>
            fetch(`${address}/ready`, { signal: AbortSignal.timeout(1000) }),
          ),
        );
        return responses.every((response) => response.ok);
      } catch (error) {
        if (error instanceof TypeError || error.name === "TimeoutError")
          return false;
        throw error;
      }
    },
    "both engines started with saved heartbeat",
    60_000,
  );
  docker("exec", "-T", "gateway", "nginx", "-s", "reload");
  for (const address of [a, b]) {
    const response = await fetch(
      `${address}/socket.io/?EIO=4&transport=polling`,
      {
        headers: { Cookie: cookie },
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.equal(wire[0], "0", "real Engine.IO open packet");
    const handshake = JSON.parse(wire.slice(1));
    assert.equal(handshake.pingInterval, 2000);
    assert.equal(handshake.pingTimeout, 3000);
    const values = await gql(address, cookie, configQuery);
    const active = values.admin.adminConfigValues.effectiveFields.find(
      (field) => field.path === "websocket.eio_ping_interval_seconds",
    );
    assert.equal(active.runtimeEffectiveValue, 2);
    assert.equal(active.runtimeEffectiveState, "EFFECTIVE");
  }
  const heartbeatPeer = await peer(process.env.MYOXUS_MI_GATEWAY_URL, cookie);
  const engine = heartbeatPeer.socket.io.engine;
  assert.equal(
    engine.transport.name,
    "websocket",
    "real proxy upgrade succeeded",
  );
  assert.equal(engine._pingInterval, 2000);
  assert.equal(engine._pingTimeout, 3000);
  let pings = 0,
    pongs = 0;
  engine.on("packet", (packet) => {
    if (packet.type === "ping") pings++;
  });
  engine.on("packetCreate", (packet) => {
    if (packet.type === "pong") pongs++;
  });
  await delay(6000);
  assert.equal(
    heartbeatPeer.socket.connected,
    true,
    "proxy connection outlives advertised tolerance",
  );
  assert(
    pings >= 2 && pongs >= 2,
    "ongoing protocol frames across the actual proxy",
  );
  console.log(
    "saved heartbeat -> both restarted engines -> proxy WebSocket/frame consumer: passed",
  );
} finally {
  if (redisPaused) docker("unpause", "redis-mi");
  if (paused) docker("unpause", "api-2");
  sockets.forEach((socket) => socket.disconnect());
  awarenessStates.forEach(({ doc, awareness }) => {
    awareness.destroy();
    doc.destroy();
  });
}
