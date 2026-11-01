// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { MeetingSettingsKey } from "@myoxus/desktop-api-contract";
import { Framework, MemoryMemento } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { DesktopApiService } from "../../desktop-api";
import { GlobalStateService } from "../../storage";
import { MeetingSettingsService } from "./meeting-settings";

function settingsHarness(initial?: Record<string, unknown>) {
  const state = new MemoryMemento();
  if (initial) state.set(MeetingSettingsKey, Object.freeze(initial));
  const recording = {
    checkRecordingAvailable: vi.fn(async () => true),
    checkMeetingPermissions: vi.fn(async () => ({
      screen: true,
      microphone: true,
      systemAudio: true,
    })),
    setupRecordingFeature: vi.fn(async () => true),
    disableRecordingFeature: vi.fn(async () => {}),
  };
  const framework = new Framework();
  framework
    .service(GlobalStateService, {
      globalState: state,
    } as unknown as GlobalStateService)
    .service(DesktopApiService, {
      handler: { recording },
    } as unknown as DesktopApiService)
    .service(MeetingSettingsService, [GlobalStateService]);
  return {
    service: framework.provider().get(MeetingSettingsService),
    state,
    recording,
  };
}

describe("native recording settings", () => {
  test("reads frozen historical preferences without mutating them and defaults new enrichment preferences off", () => {
    const original = {
      recordingSavingMode: "journal-today",
      autoTranscriptionSummary: true,
      autoTranscriptionTodo: true,
    };
    const h = settingsHarness(original);
    expect(h.service.settings).toMatchObject({ ...original, enabled: false });
    expect(h.state.get(MeetingSettingsKey)).toEqual(original);
    expect(settingsHarness().service.settings).toMatchObject({
      autoTranscriptionSummary: false,
      autoTranscriptionTodo: false,
    });
  });

  test("failed or denied setup leaves disabled state intact and successful setup commits once", async () => {
    const h = settingsHarness({
      enabled: false,
      recordingSavingMode: "journal-today",
    });
    h.recording.checkMeetingPermissions.mockResolvedValueOnce({
      screen: true,
      microphone: true,
      systemAudio: false,
    });
    await expect(h.service.setEnabled(true)).rejects.toThrow("permission");
    expect(h.service.settings.enabled).toBe(false);
    expect(h.recording.setupRecordingFeature).not.toHaveBeenCalled();

    const setup = Promise.withResolvers<boolean>();
    h.recording.setupRecordingFeature.mockReturnValueOnce(setup.promise);
    const enable = h.service.setEnabled(true);
    await vi.waitFor(() =>
      expect(h.recording.setupRecordingFeature).toHaveBeenCalledOnce(),
    );
    expect(h.service.settings.enabled).toBe(false);
    await expect(h.service.setEnabled(true)).rejects.toThrow(
      "already in progress",
    );
    setup.resolve(false);
    await expect(enable).rejects.toThrow("setup");
    expect(h.service.settings.enabled).toBe(false);

    await h.service.setEnabled(true);
    expect(h.service.settings).toMatchObject({
      enabled: true,
      recordingSavingMode: "journal-today",
    });
    expect(h.recording.setupRecordingFeature).toHaveBeenCalledTimes(2);
  });

  test("native rejection of disable during capture preserves the enabled preference", async () => {
    const h = settingsHarness({ enabled: true, recordingMode: "auto-start" });
    h.recording.disableRecordingFeature.mockRejectedValueOnce(
      new Error("There is an ongoing recording"),
    );
    await expect(h.service.setEnabled(false)).rejects.toThrow(
      "ongoing recording",
    );
    expect(h.service.settings).toMatchObject({
      enabled: true,
      recordingMode: "auto-start",
    });
    await h.service.setEnabled(false);
    expect(h.service.settings).toMatchObject({
      enabled: false,
      recordingMode: "auto-start",
    });
  });
});
