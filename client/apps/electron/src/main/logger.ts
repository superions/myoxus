import { app, shell } from "electron";
import log from "electron-log/main";

export const logger = log.scope("main");
log.initialize({
  preload: false,
});

log.transports.file.level = "info";
log.transports.console.level = "info";

export function getLogFilePath() {
  return log.transports.file.getFile().path;
}

export async function revealLogFile() {
  const filePath = getLogFilePath();
  return await shell.openPath(filePath);
}

// A renderer may veto before-quit; keep diagnostics alive after a canceled quit.
app.on("will-quit", () => {
  log.transports.console.level = false;
});
