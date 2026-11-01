import {
  MeetingSettingsKey,
  type MeetingSettingsSchema,
} from "@myoxus/desktop-api-contract";
import { LiveData, Service } from "@myoxus/infra";
import { defaults } from "lodash-es";

import { DesktopApiService } from "../../desktop-api";
import type { GlobalStateService } from "../../storage";

const MEETING_SETTINGS_KEY = MeetingSettingsKey;

const defaultMeetingSettings: MeetingSettingsSchema = {
  enabled: false,
  recordingSavingMode: "new-doc",
  autoTranscriptionSummary: false,
  autoTranscriptionTodo: false,
  recordingMode: "prompt",
};

export class MeetingSettingsService extends Service {
  constructor(private readonly globalStateService: GlobalStateService) {
    super();
  }

  private readonly desktopApiService =
    this.framework.getOptional(DesktopApiService);

  readonly settings$ = LiveData.computed((get) => {
    const value = get(
      LiveData.from(
        this.globalStateService.globalState.watch<MeetingSettingsSchema>(
          MEETING_SETTINGS_KEY,
        ),
        undefined,
      ),
    );
    return defaults({}, value, defaultMeetingSettings);
  });

  get settings() {
    return this.settings$.value;
  }

  private changingEnabled = false;

  /** Persist only after the native operation succeeds; failure leaves the
   * previous preference intact, including when capture prevents disabling. */
  async setEnabled(enabled: boolean) {
    if (this.changingEnabled)
      throw new Error("Recording setup is already in progress");
    const currentEnabled = this.settings.enabled;
    if (currentEnabled === enabled) {
      return;
    }

    this.changingEnabled = true;
    try {
      if (!this.desktopApiService)
        throw new Error("Native recording is unavailable");
      if (enabled) {
        if (!(await this.isRecordingFeatureAvailable()))
          throw new Error(
            "Native recording is unavailable on this operating system",
          );
        const permissions = await this.checkMeetingPermissions();
        if (
          !permissions?.systemAudio ||
          ((environment.isMacOs || environment.isWindows) &&
            (!permissions.screen || !permissions.microphone))
        )
          throw new Error("System audio capture permission is unavailable");
        const successful =
          await this.desktopApiService.handler.recording.setupRecordingFeature();
        if (!successful) throw new Error("Failed to setup recording feature");
      } else {
        await this.desktopApiService.handler.recording.disableRecordingFeature();
      }
      this.globalStateService.globalState.set(MEETING_SETTINGS_KEY, {
        ...this.settings$.value,
        enabled,
      });
    } finally {
      this.changingEnabled = false;
    }
  }

  async startRecording() {
    if (!this.desktopApiService)
      throw new Error("Native recording is unavailable");
    return this.desktopApiService.handler.recording.startRecording();
  }

  async listRecoverableRecordings() {
    return (
      this.desktopApiService?.handler.recording.listRecoverableRecordings() ??
      []
    );
  }

  async retryRecording(id: number) {
    return this.desktopApiService?.handler.recording.retryRecording(id);
  }

  setRecordingSavingMode(mode: MeetingSettingsSchema["recordingSavingMode"]) {
    this.globalStateService.globalState.set(MEETING_SETTINGS_KEY, {
      ...this.settings$.value,
      recordingSavingMode: mode,
    });
  }

  // Native recording is available on macOS 14.2+, Windows, and Linux
  // desktops with a reachable PipeWire/PulseAudio monitor.
  async isRecordingFeatureAvailable() {
    return this.desktopApiService?.handler.recording.checkRecordingAvailable();
  }

  async checkMeetingPermissions() {
    return this.desktopApiService?.handler.recording.checkMeetingPermissions();
  }

  // Main owns the platform-specific privacy pane; Linux has no such prompt.
  async showRecordingPermissionSetting(type: "screen" | "microphone") {
    return this.desktopApiService?.handler.recording.showRecordingPermissionSetting(
      type,
    );
  }

  async askForMeetingPermission(type: "microphone" | "screen") {
    return this.desktopApiService?.handler.recording.askForMeetingPermission(
      type,
    );
  }

  setRecordingMode = (mode: MeetingSettingsSchema["recordingMode"]) => {
    const currentMode = this.settings.recordingMode;

    if (currentMode === mode) {
      return;
    }

    this.globalStateService.globalState.set(MEETING_SETTINGS_KEY, {
      ...this.settings,
      recordingMode: mode,
    });
  };

  async openSavedRecordings() {
    // todo: open the saved recordings folder
    await this.desktopApiService?.handler.recording.showSavedRecordings();
  }
}
