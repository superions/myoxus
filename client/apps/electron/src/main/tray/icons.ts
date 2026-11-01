import { join } from "node:path";

import { resourcesPath } from "../../shared/utils";

export const icons = {
  record: join(resourcesPath, "icons/waveform.png"),
  recording: join(resourcesPath, "icons/waveform-recording.png"),
  tray: join(resourcesPath, "icons/tray.png"),
  journal: join(resourcesPath, "icons/journal.png"),
  page: join(resourcesPath, "icons/page.png"),
  edgeless: join(resourcesPath, "icons/edgeless.png"),
  monitor: join(resourcesPath, "icons/monitor.png"),
};
