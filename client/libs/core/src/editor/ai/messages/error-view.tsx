// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Alert,
  Button,
  Stack,
  MyoxusText,
} from "@myoxus/ui-facade";

export function ChatErrorView({
  text,
  details,
  action,
  tooltip,
  onAction,
}: {
  text: string;
  details?: string;
  action: string;
  tooltip?: string;
  onAction: () => void;
}) {
  const t = useI18n();
  return (
    <Alert color="myoxusError" role="alert">
      <Stack>
        <MyoxusText>{text}</MyoxusText>
        {details ? (
          <Accordion>
            <AccordionItem value="details">
              <AccordionControl>
                {t["com.myoxus.ai.chat-panel.error-details"]()}
              </AccordionControl>
              <AccordionPanel>
                <MyoxusText preserveWhitespace>{details}</MyoxusText>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        ) : null}
        <Button
          data-testid="ai-error-action-button"
          tooltip={tooltip}
          onClick={onAction}
        >
          {action}
        </Button>
      </Stack>
    </Alert>
  );
}
