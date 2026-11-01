// SPDX-License-Identifier: AGPL-3.0-or-later
import { Paper } from "@mantine/core";
import type { PropsWithChildren } from "react";
import "./annotation.css";

/** Native Paper with the server-owned annotation surface and fold roles. */
export function AnnotationPaper({ children }: PropsWithChildren) {
  return (
    <Paper
      component="section"
      p="md"
      className="myoxus-annotation-paper"
      data-myoxus-ui-role="annotation-paper"
    >
      {children}
    </Paper>
  );
}
