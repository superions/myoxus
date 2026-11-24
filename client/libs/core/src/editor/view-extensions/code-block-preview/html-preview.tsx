// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useLayoutEffect, useRef, useState } from "react";
import { linkIframe } from "./iframe-container";
import { CodePreviewStatus } from "./status-view";
import { installPreviewStyles } from "./preview-styles";

export function HtmlCodePreview({ source }: { source: string }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [failedSource, setFailedSource] = useState<string>();
  useLayoutEffect(() => {
    if (!source || !iframe.current) return;
    try {
      linkIframe(iframe.current, source);
      setFailedSource(undefined);
    } catch (error) {
      setFailedSource(source);
      console.error("HTML preview iframe failed:", error);
    }
  }, [source]);

  if (!source)
    return <CodePreviewStatus status={{ language: "HTML", state: "empty" }} />;
  return (
    <div
      className="html-preview-container"
      ref={installPreviewStyles}
      data-range-sync-exclude="true"
    >
      {failedSource === source && (
        <CodePreviewStatus status={{ language: "HTML", state: "error" }} />
      )}
      <iframe
        ref={iframe}
        className="html-preview-iframe"
        title="HTML Preview"
        sandbox=""
        hidden={failedSource === source}
      />
    </div>
  );
}
