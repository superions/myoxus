// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import {
  Avatar,
  Group,
  IconButton,
  InsideModalContext,
  MyoxusText,
  NavLink,
  ReferenceCard,
  Stack,
} from "@myoxus/ui-facade";
import { useContext, useId, useState, type ReactNode } from "react";

interface ResultView {
  title: ReactNode;
  icon?: ReactNode;
  image?: string;
  content?: string;
  href?: string;
  onClick?: () => void;
}

/** Streaming updates retain expansion. Source actions never nest in the disclosure button. */
export function ToolResultCardView({
  name,
  icon,
  footerIcons,
  results,
  contained = true,
}: {
  name: string;
  icon: ReactNode;
  footerIcons: { url?: string; icon?: ReactNode }[];
  results: ResultView[];
  contained?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const inModal = useContext(InsideModalContext);
  const t = useI18n();
  const label = expanded ? t["Collapse"]() : t["Expand"]();
  return (
    <ReferenceCard
      size="small"
      contained={contained && !inModal}
      title={name}
      metadata={results[0]?.title}
      icon={icon}
      actions={
        <IconButton
          size="small"
          aria-label={label}
          tooltip={label}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </IconButton>
      }
      footer={
        footerIcons.length ? (
          <Group gap="xs">
            {footerIcons.slice(0, 3).map((item, index) => (
              <Avatar key={index} url={item.url}>
                {item.icon ?? icon}
              </Avatar>
            ))}
          </Group>
        ) : undefined
      }
      data-testid="chat-tool-result"
    >
      {expanded ? (
        <Stack gap="xs" id={detailsId}>
          {results.map((result, index) => {
            const sourceIcon = result.image ? (
              <Avatar url={result.image}>{icon}</Avatar>
            ) : (
              result.icon
            );
            if (result.href)
              return (
                <NavLink
                  key={index}
                  component="a"
                  href={result.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  label={result.title}
                  description={result.content}
                  leftSection={sourceIcon}
                  onClick={result.onClick}
                />
              );
            if (result.onClick)
              return (
                <NavLink
                  key={index}
                  component="button"
                  type="button"
                  label={result.title}
                  description={result.content}
                  leftSection={sourceIcon}
                  onClick={result.onClick}
                />
              );
            return (
              <Stack key={index} gap="xs">
                <Group>
                  {sourceIcon}
                  <MyoxusText>{result.title}</MyoxusText>
                </Group>
                {result.content ? (
                  <MyoxusText>{result.content}</MyoxusText>
                ) : null}
              </Stack>
            );
          })}
        </Stack>
      ) : null}
    </ReferenceCard>
  );
}
