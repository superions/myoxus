import { useAppUpdater } from "@myoxus/core/components/hooks/use-app-updater";
import { useI18n } from "@myoxus/i18n";
import {
  MyoxusButton,
  MyoxusLoader,
  SettingsRow,
  SettingsStatusText,
} from "../../primitives";

export const UpdateCheckSection = () => {
  const t = useI18n();
  const {
    updaterState: state,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
  } = useAppUpdater();
  const unavailable =
    state?.availability.state === "disabled" ? state.availability.reason : null;
  const active = state?.phase === "checking" || state?.phase === "downloading";
  const buttonLabel = state?.ready
    ? t["com.myoxus.aboutMyoxus.checkUpdate.button.restart"]()
    : state?.available && state.progress === null
      ? t["com.myoxus.aboutMyoxus.checkUpdate.button.download"]()
      : state?.phase === "error" || state?.phase === "latest"
        ? t["com.myoxus.aboutMyoxus.checkUpdate.button.retry"]()
        : t["com.myoxus.aboutMyoxus.checkUpdate.button.check"]();
  const subtitle =
    unavailable === "externally-managed"
      ? t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.externally-managed"]()
      : unavailable === "portable"
        ? t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.portable"]()
        : unavailable
          ? t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.disabled"]()
          : state?.phase === "error"
            ? t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.error"]()
            : state?.ready
              ? t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.restart"]()
              : state?.phase === "checking"
                ? t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.checking"]()
                : state?.progress !== null && state?.progress !== undefined
                  ? t[
                      "com.myoxus.aboutMyoxus.checkUpdate.subtitle.downloading"
                    ]()
                  : state?.available
                    ? t[
                        "com.myoxus.aboutMyoxus.checkUpdate.subtitle.update-available"
                      ]({ version: state.available.version })
                    : state?.phase === "latest"
                      ? t[
                          "com.myoxus.aboutMyoxus.checkUpdate.subtitle.latest"
                        ]()
                      : t[
                          "com.myoxus.aboutMyoxus.checkUpdate.subtitle.check"
                        ]();
  const handleClick = () => {
    if (state?.ready) return quitAndInstall();
    if (state?.available && state.progress === null) return downloadUpdate();
    void checkForUpdates();
  };
  return (
    <SettingsRow
      name={t["com.myoxus.aboutMyoxus.checkUpdate.title"]()}
      desc={
        <SettingsStatusText tone={state?.phase === "error" ? "error" : "muted"}>
          {active ? <MyoxusLoader /> : null}
          {subtitle}
        </SettingsStatusText>
      }
    >
      <MyoxusButton
        data-testid="check-update-button"
        onClick={handleClick}
        disabled={!state || Boolean(unavailable) || active}
      >
        {buttonLabel}
      </MyoxusButton>
    </SettingsRow>
  );
};
