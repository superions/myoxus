// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import type { ConversionWarning } from "../doc/services/docs";

const featureKeys = {
  text: "com.myoxus.conversion.feature.text",
  lists: "com.myoxus.conversion.feature.lists",
  tables: "com.myoxus.conversion.feature.tables",
  images: "com.myoxus.conversion.feature.images",
  notes: "com.myoxus.conversion.feature.notes",
  files: "com.myoxus.conversion.feature.files",
  other: "com.myoxus.conversion.feature.other",
} as const;

function feature(code: string): keyof typeof featureKeys {
  if (/table|merged_cell/.test(code)) return "tables";
  if (/image|diagram|embedded_object/.test(code)) return "images";
  if (/attachment|audio|video|media|external_widget/.test(code)) return "files";
  if (/note|story|annotation|review/.test(code)) return "notes";
  if (/list|numbering|task|checkbox/.test(code)) return "lists";
  if (
    /text|title|heading|inline|run|link|border|formula|bookmark|code|callout|mention|reference/.test(
      code,
    )
  )
    return "text";
  return "other";
}

/** Display observed changes only. No notices does not establish that the Word
 * reader understood every source construct. Codec messages are never UI copy. */
export function ConversionDiagnostics({
  warnings,
  bestEffort = false,
}: {
  warnings: ConversionWarning[];
  bestEffort?: boolean;
}) {
  const t = useI18n();
  const groups = new Map<
    keyof typeof featureKeys,
    { normalized: number; omitted: number; other: number }
  >();
  for (const warning of warnings) {
    const key = feature(warning.code);
    const group = groups.get(key) ?? { normalized: 0, omitted: 0, other: 0 };
    const kind = warning.code.endsWith("_omitted")
      ? "omitted"
      : warning.code.endsWith("_normalized")
        ? "normalized"
        : "other";
    group[kind] += warning.count;
    groups.set(key, group);
  }
  const count = (value: number) =>
    new Intl.NumberFormat(t.language).format(value);
  return (
    <Stack>
      {bestEffort && <Text>{t["com.myoxus.conversion.best-effort"]()}</Text>}
      {groups.size > 0 && (
        <Accordion>
          <AccordionItem value="conversion">
            <AccordionControl>
              {t["com.myoxus.conversion.details"]()}
            </AccordionControl>
            <AccordionPanel>
              <Stack>
                {[...groups].map(([key, values]) => (
                  <Stack key={key}>
                    <Text>{t[featureKeys[key]]()}</Text>
                    {values.normalized > 0 && (
                      <Text>
                        {t["com.myoxus.conversion.normalized"]({
                          count: count(values.normalized),
                        })}
                      </Text>
                    )}
                    {values.omitted > 0 && (
                      <Text>
                        {t["com.myoxus.conversion.omitted"]({
                          count: count(values.omitted),
                        })}
                      </Text>
                    )}
                    {values.other > 0 && (
                      <Text>
                        {t["com.myoxus.conversion.other"]({
                          count: count(values.other),
                        })}
                      </Text>
                    )}
                  </Stack>
                ))}
              </Stack>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}
    </Stack>
  );
}
