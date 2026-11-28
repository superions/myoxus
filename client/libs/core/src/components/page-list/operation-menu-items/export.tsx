// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  ExportIcon,
  ExportToHtmlIcon,
  ExportToMarkdownIcon,
  ExportToPngIcon,
  FileIconDocxIcon,
  InformationIcon,
  PageIcon,
  PrinterIcon,
  WorkflowIcon,
} from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import { MenuItem, MenuSeparator, MenuSub, Tooltip } from "@myoxus/ui-facade";
import { type ReactNode, useCallback } from "react";

export type ExportFormatType =
  | "pdf"
  | "docx"
  | "html"
  | "png"
  | "markdown"
  | "snapshot"
  | "pdf-export"
  | "mermaid-source"
  | "mermaid-markdown"
  | "mermaid-svg"
  | "mermaid-png";

export interface ExportMenuItemProps<T> {
  onSelect: () => void;
  className?: string;
  type: T;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  suffix?: ReactNode;
  unavailableReason?: string;
}

export interface ExportProps {
  exportHandler: (type: ExportFormatType) => void;
  pageMode?: "page" | "edgeless";
  className?: string;
  isMermaidDiagram?: boolean;
  docxUnavailableReason?: string;
}

export function ExportMenuItem<T>({
  onSelect,
  className,
  type,
  icon,
  label,
  disabled,
  suffix,
  unavailableReason,
}: ExportMenuItemProps<T>) {
  const menuItem = (
    <MenuItem
      className={className}
      data-testid={`export-to-${type}`}
      onSelect={() => {
        if (!unavailableReason) onSelect();
      }}
      aria-disabled={Boolean(unavailableReason) || disabled}
      aria-description={unavailableReason}
      closeMenuOnClick={!unavailableReason}
      block
      prefixIcon={icon}
      disabled={disabled}
      suffix={unavailableReason ? <InformationIcon /> : suffix}
    >
      {label}
    </MenuItem>
  );

  return unavailableReason ? (
    <Tooltip
      content={unavailableReason}
      events={{ hover: true, focus: true, touch: false }}
    >
      {menuItem}
    </Tooltip>
  ) : (
    menuItem
  );
}

export const PrintMenuItems = ({ exportHandler, className }: ExportProps) => {
  const t = useI18n();
  return (
    <ExportMenuItem
      onSelect={() => exportHandler("pdf")}
      className={className}
      type="pdf"
      icon={<PrinterIcon />}
      label={t["com.myoxus.export.print"]()}
    />
  );
};

export const ExportMenuItems = ({
  exportHandler,
  className,
  pageMode = "page",
  isMermaidDiagram = false,
  docxUnavailableReason,
}: ExportProps) => {
  const t = useI18n();

  return (
    <>
      <ExportMenuItem
        onSelect={() => exportHandler("html")}
        className={className}
        type="html"
        icon={<ExportToHtmlIcon />}
        label={t["Export to HTML"]()}
      />
      {pageMode !== "edgeless" ? (
        <ExportMenuItem
          onSelect={() => exportHandler("png")}
          className={className}
          type="png"
          icon={<ExportToPngIcon />}
          label={t["Export to PNG"]()}
        />
      ) : null}
      <ExportMenuItem
        onSelect={() => exportHandler("markdown")}
        className={className}
        type="markdown"
        icon={<ExportToMarkdownIcon />}
        label={t["Export to Markdown"]()}
      />
      {isMermaidDiagram ? (
        <>
          <ExportMenuItem
            onSelect={() => exportHandler("mermaid-source")}
            className={className}
            type="mermaid-source"
            icon={<WorkflowIcon />}
            label="Mermaid (.mmd)"
          />
          <ExportMenuItem
            onSelect={() => exportHandler("mermaid-markdown")}
            className={className}
            type="mermaid-markdown"
            icon={<ExportToMarkdownIcon />}
            label="Mermaid Markdown"
          />
          <ExportMenuItem
            onSelect={() => exportHandler("mermaid-svg")}
            className={className}
            type="mermaid-svg"
            icon={<WorkflowIcon />}
            label="Mermaid SVG"
          />
          <ExportMenuItem
            onSelect={() => exportHandler("mermaid-png")}
            className={className}
            type="mermaid-png"
            icon={<ExportToPngIcon />}
            label="Mermaid PNG"
          />
        </>
      ) : null}
      <ExportMenuItem
        onSelect={() => exportHandler("pdf-export")}
        className={className}
        type="pdf-export"
        icon={<PrinterIcon />}
        label={t["com.myoxus.export.pdf.menu-label"]()}
      />
      <ExportMenuItem
        onSelect={() => exportHandler("docx")}
        className={className}
        type="docx"
        icon={<FileIconDocxIcon />}
        label={t["com.myoxus.import.docx"]()}
        unavailableReason={
          pageMode === "edgeless"
            ? t["com.myoxus.export.word.mode"]()
            : docxUnavailableReason
        }
      />
      <ExportMenuItem
        onSelect={() => exportHandler("snapshot")}
        className={className}
        type="snapshot"
        icon={<PageIcon />}
        label={t["Export to Snapshot"]()}
      />
    </>
  );
};

export const Export = ({
  exportHandler,
  className,
  pageMode,
  isMermaidDiagram = false,
  docxUnavailableReason,
}: ExportProps) => {
  const t = useI18n();
  const handleOpenChange = useCallback((open: boolean) => {
    if (open) track.$.header.docOptions.export();
  }, []);

  return (
    <MenuSub
      items={
        <>
          <ExportMenuItems
            exportHandler={exportHandler}
            className={className}
            pageMode={pageMode}
            isMermaidDiagram={isMermaidDiagram}
            docxUnavailableReason={docxUnavailableReason}
          />
          {pageMode !== "edgeless" ? (
            <>
              <MenuSeparator />
              <PrintMenuItems
                exportHandler={exportHandler}
                className={className}
              />
            </>
          ) : null}
        </>
      }
      narrowBehavior="inline"
      triggerOptions={{
        prefixIcon: <ExportIcon />,
        "data-testid": "export-menu",
      }}
      subOptions={{ onOpenChange: handleOpenChange }}
    >
      {t.Export()}
    </MenuSub>
  );
};
