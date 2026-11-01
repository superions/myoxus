import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { MeetingSettingsService } from "@myoxus/core/modules/media/services/meeting-settings";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { UserFriendlyError } from "@myoxus/error";
import track from "@myoxus/track";
import { useCallback } from "react";

import { notify, useConfirmModal } from "../../primitives";

export const useEnableRecording = () => {
  const meetingSettingsService = useService(MeetingSettingsService);
  const confirmModal = useConfirmModal();
  const t = useI18n();

  const notifySystemAudioUnavailable = useCallback(() => {
    notify.error({
      title:
        t[
          "com.myoxus.settings.meetings.linux-system-audio.unavailable.title"
        ](),
      message:
        t[
          "com.myoxus.settings.meetings.linux-system-audio.unavailable.description"
        ](),
    });
  }, [t]);

  const handleEnabledChange = useAsyncCallback(
    async (checked: boolean) => {
      try {
        if (checked) {
          const permissions =
            await meetingSettingsService.checkMeetingPermissions();
          if (permissions && !permissions.systemAudio) {
            notifySystemAudioUnavailable();
            return;
          }
        }
        track.$.settingsPanel.meetings.toggleMeetingFeatureFlag({
          option: checked ? "on" : "off",
          type: "Meeting record",
        });
        await meetingSettingsService.setEnabled(checked);
      } catch (error) {
        const permissions =
          await meetingSettingsService.checkMeetingPermissions();
        if (permissions && !permissions.systemAudio) {
          notifySystemAudioUnavailable();
          return;
        }
        if (
          !environment.isMacOs ||
          !checked ||
          (permissions?.screen && permissions.microphone)
        ) {
          notify.error({
            title: t["com.myoxus.settings.meetings"](),
            message: UserFriendlyError.fromAny(error).message,
          });
          return;
        }
        confirmModal.openConfirmModal({
          title: permissions?.screen
            ? t["com.myoxus.settings.meetings.privacy.microphone"]()
            : t["com.myoxus.settings.meetings.record.permission-modal.title"](),
          description: permissions?.screen
            ? t["com.myoxus.settings.meetings.privacy.microphone.description"]()
            : t[
                "com.myoxus.settings.meetings.record.permission-modal.description"
              ](),
          onConfirm: async () => {
            await meetingSettingsService.showRecordingPermissionSetting(
              permissions?.screen ? "microphone" : "screen",
            );
          },
          cancelText: t["com.myoxus.recording.dismiss"](),
          confirmButtonOptions: {
            variant: "primary",
          },
          confirmText:
            t[
              "com.myoxus.settings.meetings.record.permission-modal.open-setting"
            ](),
        });
      }
    },
    [confirmModal, meetingSettingsService, notifySystemAudioUnavailable, t],
  );

  return handleEnabledChange;
};
