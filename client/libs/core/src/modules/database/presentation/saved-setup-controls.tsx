// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Button,
  FormSelect,
  Group,
  Input,
  MyoxusText,
  Notice,
  Stack,
} from "@myoxus/ui-facade";

/** Hosts own admission, acknowledged preference writes and draft replacement.
 * Loading a selection never confirms creation or enables a personal rule. */
export function SavedSetupControls({
  options,
  selectedId,
  label,
  busy = false,
  disabled = false,
  canSave,
  canLoad,
  failed = false,
  unavailable = false,
  cleared = false,
  onSelect,
  onLabelChange,
  onLoad,
  onSave,
  onDelete,
  onClear,
  onRetry,
}: {
  options: readonly { id: string; label: string }[];
  selectedId: string | null;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  canSave: boolean;
  canLoad: boolean;
  failed?: boolean;
  unavailable?: boolean;
  cleared?: boolean;
  onSelect: (id: string) => void;
  onLabelChange: (label: string) => void;
  onLoad: () => void;
  onSave: () => void;
  onDelete: () => void;
  onClear: () => void;
  onRetry: () => void;
}) {
  const t = useI18n();
  const locked = disabled || busy;
  return (
    <Accordion>
      <AccordionItem value="saved-setup">
        <AccordionControl>
          {t["com.myoxus.assistant.saved-setup.selection"]()}
        </AccordionControl>
        <AccordionPanel>
          <Stack>
            <MyoxusText tone="secondary">
              {t["com.myoxus.assistant.saved-setup.help"]()}
            </MyoxusText>
            <FormSelect
              label={t["com.myoxus.assistant.saved-setup.selection"]()}
              data={options.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              value={selectedId}
              disabled={locked}
              onChange={onSelect}
            />
            <Input
              label={t["com.myoxus.assistant.saved-setup.name"]()}
              value={label}
              disabled={locked}
              onChange={onLabelChange}
            />
            <Group>
              <Button
                type="button"
                variant="secondary"
                disabled={locked || !selectedId || !canLoad || unavailable}
                onClick={onLoad}
              >
                {t["com.myoxus.assistant.saved-setup.load"]()}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={locked || !canSave || !label.trim()}
                onClick={onSave}
              >
                {t.Save()}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={locked || !selectedId}
                onClick={onDelete}
              >
                {t.Delete()}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={locked || !selectedId}
                onClick={onClear}
              >
                {t["com.myoxus.assistant.saved-setup.clear"]()}
              </Button>
            </Group>
            {unavailable || cleared ? (
              <Notice tone="warning">
                {t["com.myoxus.assistant.saved-setup.unavailable"]()}
              </Notice>
            ) : null}
            {failed ? (
              <Notice tone="error">
                {t["com.myoxus.common.operation-failed"]()}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked}
                  onClick={onRetry}
                >
                  {t.Retry()}
                </Button>
              </Notice>
            ) : null}
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
