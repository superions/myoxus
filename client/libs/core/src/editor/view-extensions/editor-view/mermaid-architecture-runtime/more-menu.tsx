// SPDX-License-Identifier: AGPL-3.0-or-later

import { DownloadIcon, LayoutIcon, MoreHorizontalIcon } from "@myoxus/icons";
import { IconButton, Menu, MenuItem } from "@myoxus/ui-facade";
import type { MermaidArchitectureEditorReactHostProps } from "@virgultum/block-mermaid";
import type { ReactNode } from "react";
import { useState } from "react";

import { MermaidArchitectureDiagramSettings } from "./diagram-settings";

export function MermaidArchitectureMoreMenu({
  label,
  onLayoutOpen,
  preview,
  props,
}: {
  readonly label: string;
  readonly onLayoutOpen: () => void;
  readonly preview: ReactNode;
  readonly props: MermaidArchitectureEditorReactHostProps;
}) {
  const [opened, setOpened] = useState(false);
  const closeAndRun = (run: () => void) => {
    setOpened(false);
    run();
  };

  return (
    <>
      <Menu
        items={
          <>
            <MermaidArchitectureDiagramSettings
              props={props}
              trigger="menu-item"
            />
            {props.embedded ? (
              <MenuItem
                leftSection={<DownloadIcon />}
                onSelect={() => closeAndRun(props.onExportMmd)}
              >
                {props.labels.exportMmd}
              </MenuItem>
            ) : null}
            {!props.readonly ? (
              <>
                <MenuItem
                  leftSection={<LayoutIcon />}
                  onSelect={() => closeAndRun(onLayoutOpen)}
                >
                  {props.labels.layout}
                </MenuItem>
                <MenuItem
                  aria-label={
                    props.canAlign
                      ? props.labels.alignRow
                      : `${props.labels.alignRow}. ${props.alignDisabledReason}`
                  }
                  disabled={!props.canAlign}
                  onSelect={() => closeAndRun(() => props.onAlign("row"))}
                  title={props.alignDisabledReason || undefined}
                >
                  {props.labels.alignRow}
                </MenuItem>
                <MenuItem
                  aria-label={
                    props.canAlign
                      ? props.labels.alignColumn
                      : `${props.labels.alignColumn}. ${props.alignDisabledReason}`
                  }
                  disabled={!props.canAlign}
                  onSelect={() => closeAndRun(() => props.onAlign("column"))}
                  title={props.alignDisabledReason || undefined}
                >
                  {props.labels.alignColumn}
                </MenuItem>
              </>
            ) : null}
          </>
        }
        rootOptions={{
          closeOnItemClick: false,
          onOpenChange: setOpened,
          open: opened,
        }}
        title={label}
      >
        <IconButton
          aria-label={label}
          icon={<MoreHorizontalIcon />}
          tooltip={label}
        />
      </Menu>
      {preview}
    </>
  );
}
