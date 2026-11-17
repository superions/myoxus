import { DocModeProvider, TelemetryProvider } from "@virgultum/core/services";
import type { BlockStdScope } from "@virgultum/core/runtime";

export async function retryIframe(
  std: BlockStdScope,
  onRetry: () => Promise<boolean>,
) {
  const success = await onRetry();
  std.getOptional(TelemetryProvider)?.track("ReloadLink", {
    type: "embed iframe block",
    page:
      std.get(DocModeProvider).getEditorMode() === "edgeless"
        ? "whiteboard editor"
        : "doc editor",
    segment: "editor",
    module: "embed block",
    control: "reload button",
    result: success ? "success" : "failure",
  });
}
