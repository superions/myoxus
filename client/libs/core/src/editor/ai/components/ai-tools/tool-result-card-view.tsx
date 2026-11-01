// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Avatar,
  Group,
  MyoxusText,
  NavLink,
  Stack,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";

interface ResultView {
  title: ReactNode;
  icon?: ReactNode;
  image?: string;
  content?: string;
  href?: string;
  onClick?: () => void;
}

/** Uncontrolled native disclosure retains expansion across streamed updates.
 * Source actions remain outside its toggle, never nested interactive headers.
 */
export function ToolResultCardView({
  name,
  icon,
  footerIcons,
  results,
}: {
  name: string;
  icon: ReactNode;
  footerIcons: { url?: string; icon?: ReactNode }[];
  results: ResultView[];
}) {
  return (
    <Accordion data-testid="chat-tool-result">
      <AccordionItem value="result">
        <AccordionControl icon={icon}>
          <Group>
            <MyoxusText>{name}</MyoxusText>
            {footerIcons.slice(0, 3).map((item, index) => (
              <Avatar key={index} url={item.url}>
                {item.icon ?? icon}
              </Avatar>
            ))}
          </Group>
        </AccordionControl>
        <AccordionPanel>
          <Stack>
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
                <Stack key={index}>
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
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
