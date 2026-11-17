// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import {
  CheckCircleIcon,
  CircleIcon,
  CodeIcon,
  CrossedCircleIcon,
  GitBranchIcon,
  GithubIcon,
  IssueIcon,
  OpenInNewIcon,
} from "@myoxus/icons/react";
import {
  Badge,
  Group,
  Loading,
  MyoxusText,
  ReferenceCard,
  Stack,
} from "@myoxus/ui-facade";
import type { EditorGithubCardControls } from "@virgultum/editor/shared/services";

/** Provider identity, resource lifetime and commands stay in Virgultum. */
export function EditorGithubCard({
  controls: c,
}: {
  controls: EditorGithubCardControls;
}) {
  const t = useI18n();
  const compact = c.style === "list" || c.style === "cube";
  const title = c.loading
    ? t["com.myoxus.loading"]()
    : (c.title ?? (c.family === "GitHub" ? "GitHub" : c.host || "GitHub"));
  const SiteIcon =
    c.family === "GitLab" || c.family === "Forgejo/Gitea"
      ? CodeIcon
      : GithubIcon;
  const labels: Record<string, string> = {
    open: t["com.myoxus.editor.github.open"](),
    closed: t["com.myoxus.editor.github.closed"](),
    merged: t["com.myoxus.editor.github.merged"](),
    draft: t["com.myoxus.workspace-content-operation.status.draft"](),
  };
  const status = c.status;
  const StatusIcon =
    c.type === "pr"
      ? GitBranchIcon
      : status === "open"
        ? IssueIcon
        : c.statusReason === "completed"
          ? CheckCircleIcon
          : c.statusReason === "not_planned"
            ? CrossedCircleIcon
            : CircleIcon;
  const tone =
    status === "open"
      ? "success"
      : status === "merged" || c.statusReason === "completed"
        ? "info"
        : c.type === "pr" && status === "closed"
          ? "error"
          : "neutral";
  const footer = (
    <Stack gap="xs">
      {c.style === "vertical" &&
      c.assignees &&
      (c.type === "issue" ||
        c.family === "GitLab" ||
        c.family === "Forgejo/Gitea") ? (
        <Group gap="xs" wrap="nowrap">
          <MyoxusText typographySlot="dense-label">
            {t["com.myoxus.editor.embed.assignees"]()}
          </MyoxusText>
          <MyoxusText typographySlot="dense-label" truncate>
            {c.assignees.length
              ? c.assignees.map((assignee, index) => (
                  <span key={assignee}>
                    {index ? ", " : ""}
                    <MyoxusText
                      component="span"
                      typographySlot="dense-label"
                      tone="link"
                      onClick={() => c.openAssignee(assignee)}
                    >
                      @{assignee}
                    </MyoxusText>
                  </span>
                ))
              : t["com.myoxus.editor.embed.no-assignees"]()}
          </MyoxusText>
        </Group>
      ) : null}
      <Group
        gap="xs"
        wrap="nowrap"
        onClick={() => c.open()}
        data-testid="editor-github-card-url"
      >
        <MyoxusText
          tone={c.selected ? "link" : "secondary"}
          typographySlot="dense-label"
          truncate
        >
          {[!compact && c.repository, !compact && c.date, c.host]
            .filter(Boolean)
            .join(" | ")}
        </MyoxusText>
        <OpenInNewIcon />
      </Group>
    </Stack>
  );
  return (
    <ReferenceCard
      size={compact ? "small" : "preview"}
      orientation={
        c.style === "vertical" || c.style === "cube" ? "vertical" : "horizontal"
      }
      contained={c.inSurface}
      selected={c.selected}
      fullHeight={c.inSurface}
      title={title}
      icon={c.loading ? <Loading /> : <SiteIcon />}
      status={
        !c.loading && status ? (
          <Badge tone={tone} prefix={<StatusIcon />}>
            {labels[status] ?? status}
          </Badge>
        ) : undefined
      }
      description={!compact && !c.loading ? c.description : undefined}
      image={c.loading ? null : c.image}
      imageFallback={<SiteIcon />}
      footer={footer}
      onClick={(event) => {
        event.stopPropagation();
        c.select();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        c.open();
      }}
      aria-busy={c.loading}
      data-testid="editor-github-card"
    />
  );
}
