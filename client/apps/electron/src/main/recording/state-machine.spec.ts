// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test, vi } from "vitest";
vi.mock("../logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { RecordingStateMachine } from "./state-machine";

describe("native recording transitions", () => {
  test("saved history reserves capture IDs without becoming the active recovery", () => {
    const machine = new RecordingStateMachine();
    const savedId = Date.now() + 10_000;
    machine.reserveIdentity(savedId);
    expect(machine.status).toBeNull();
    expect(machine.dispatch({ type: "START_RECORDING" })!.id).toBeGreaterThan(
      savedId,
    );
  });
  test("repeated start and detection cannot replace active, paused or recoverable audio", () => {
    const machine = new RecordingStateMachine();
    const first = machine.dispatch({ type: "START_RECORDING" })!;
    expect(machine.dispatch({ type: "START_RECORDING" })).toBe(first);
    expect(machine.dispatch({ type: "NEW_RECORDING" })).toBe(first);
    expect(
      machine.dispatch({ type: "PAUSE_RECORDING", id: first.id + 1 }),
    ).toBe(first);
    const paused = machine.dispatch({ type: "PAUSE_RECORDING", id: first.id })!;
    expect(machine.dispatch({ type: "START_RECORDING" })).toBe(paused);
    machine.dispatch({ type: "STOP_RECORDING", id: first.id });
    machine.dispatch({
      type: "CREATE_BLOCK_FAILED",
      id: first.id,
      error: new Error("encoder failed"),
    });
    expect(machine.dispatch({ type: "START_RECORDING" })).toMatchObject({
      id: first.id,
      status: "create-block-failed",
      error: "encoder failed",
    });
    expect(machine.dispatch({ type: "NEW_RECORDING" })?.id).toBe(first.id);
  });
  test("saved requires finalized audio, rejects foreign completion and advances after success", () => {
    const machine = new RecordingStateMachine();
    const first = machine.dispatch({ type: "START_RECORDING" })!;
    expect(
      machine.dispatch({ type: "CREATE_BLOCK_SUCCESS", id: first.id })?.status,
    ).toBe("recording");
    machine.dispatch({ type: "STOP_RECORDING", id: first.id });
    machine.dispatch({
      type: "SAVE_RECORDING",
      id: first.id,
      filepath: "/recording.mp4",
    });
    expect(
      machine.dispatch({ type: "CREATE_BLOCK_SUCCESS", id: first.id + 1 })
        ?.status,
    ).toBe("ready");
    machine.dispatch({ type: "CREATE_BLOCK_SUCCESS", id: first.id });
    expect(machine.dispatch({ type: "START_RECORDING" })?.id).not.toBe(
      first.id,
    );
  });
  test("restoring retains destination and advances identity beyond persisted recordings", () => {
    const machine = new RecordingStateMachine();
    const id = Date.now() + 1000;
    const destination = {
      workspaceId: "original",
      serverId: "server",
      serverBaseUrl: "https://myoxus.example",
      savingMode: "journal-today" as const,
    };
    machine.restore({ id, status: "stopped", startTime: 10, destination });
    machine.dispatch({
      type: "SAVE_RECORDING",
      id,
      filepath: "/recording.mp4",
    });
    expect(machine.status?.destination).toEqual(destination);
    machine.dispatch({ type: "CREATE_BLOCK_SUCCESS", id });
    expect(machine.dispatch({ type: "START_RECORDING" })!.id).toBeGreaterThan(
      id,
    );
  });
});
