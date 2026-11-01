// SPDX-License-Identifier: AGPL-3.0-or-later
import { Button, Group, Stack, MyoxusText } from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidJourneyModel,
} from "@virgultum/block-mermaid";
/** The legend is derived from source occurrences. Highlight never changes ordering or score coordinates. */
export function JourneyActorsPopover({
  model,
  highlight,
  onHighlight,
  onOpenStep,
}: {
  model: MermaidJourneyModel;
  highlight?: string;
  onHighlight: (actor: string | undefined) => void;
  onOpenStep: (id: string) => void;
}) {
  const actors = [
    ...new Set(model.steps.flatMap((s) => s.actors).filter(Boolean)),
  ].sort();
  return (
    <Stack>
      {actors.map((actor) => (
        <Stack key={actor}>
          <Group>
            <Button
              variant={highlight === actor ? "primary" : "plain"}
              onClick={() =>
                onHighlight(highlight === actor ? undefined : actor)
              }
            >
              {actor}
            </Button>
            <MyoxusText>
              {messages.journeyOccurrences()}:{" "}
              {
                model.steps.flatMap((s) => s.actors.filter((a) => a === actor))
                  .length
              }
            </MyoxusText>
          </Group>
          {highlight === actor
            ? model.steps
                .filter((s) => s.actors.includes(actor))
                .map((step) => (
                  <Button
                    key={step.id}
                    variant="plain"
                    onClick={() => onOpenStep(step.id)}
                  >
                    {model.sections.find((s) => s.id === step.sectionId)
                      ?.title || messages.journeyUnnamed()}
                    : {step.label}
                  </Button>
                ))
            : null}
        </Stack>
      ))}
    </Stack>
  );
}
