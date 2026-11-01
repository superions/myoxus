// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMindmapDraftBasis } from "./drafts";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  HiddenFileInput,
  MyoxusText,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  MINDMAP_XML_LIMITS,
  MindmapXmlError,
  parseMindmapXml,
  prepareForeignMindmap,
  readMermaidSourceLimit,
  mermaidMessages as m,
  type MindmapReactHostProps,
  type PreparedMindmapImport,
} from "@virgultum/block-mermaid";

/** File reads and their candidate remain local. Only Apply invokes the owning
 * checked consumer; changing Source/rights or closing invalidates pending reads. */
export function MindmapImportForm({
  props,
  onClose,
}: {
  props: MindmapReactHostProps;
  onClose: () => void;
}) {
  const basis = useMindmapDraftBasis(props, onClose);
  return (
    <MindmapFileImportForm
      importFileSizeLimit={props.importFileSizeLimit}
      native={props.surface === "controls" || props.embedded}
      fillEmpty={props.model.nodes.length === 0}
      readonly={props.readonly || props.displayOnly}
      onImport={(candidate, position) =>
        props.onImport(candidate, basis, position)
      }
      onClose={onClose}
    />
  );
}

/** Shared file candidate/confirmation UI for existing owners and native Create.
 * No owner exists in the Create path until Apply succeeds. */
export function MindmapFileImportForm({
  importFileSizeLimit,
  native,
  fillEmpty,
  readonly,
  onImport,
  onClose,
}: {
  importFileSizeLimit: number;
  native: boolean;
  fillEmpty: boolean;
  readonly: boolean;
  onImport: (
    candidate: PreparedMindmapImport,
    position?: { x: number; y: number },
  ) => { changed: boolean; diagnostic?: string };
  onClose: () => void;
}) {
  const t = useI18n(),
    input = useRef<HTMLInputElement | null>(null);
  const version = useRef(0);
  const [candidate, setCandidate] = useState<PreparedMindmapImport | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false),
    [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  const fail = (error: unknown) =>
    t["com.myoxus.editor.mermaid.mindmap-import-error"]({
      format:
        error instanceof MindmapXmlError ? (error.format ?? "XML") : "Mermaid",
      code:
        error instanceof MindmapXmlError
          ? error.code
          : error instanceof Error
            ? error.message
            : "read",
      node: error instanceof MindmapXmlError ? String(error.node ?? "–") : "–",
      position:
        error instanceof MindmapXmlError ? (error.position ?? "–") : "–",
      limit:
        error instanceof MindmapXmlError ? String(error.limit ?? "–") : "–",
    });
  return (
    <Stack>
      <HiddenFileInput
        ref={input}
        accept=".mm,.opml,.xml"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          const current = ++version.current;
          setCandidate(null);
          setConfirmed(false);
          setError(null);
          setLoading(true);
          try {
            const bytes = Math.min(
              MINDMAP_XML_LIMITS.bytes,
              importFileSizeLimit,
            );
            if (file.size > bytes)
              throw new MindmapXmlError("bytes", null, null, null, bytes);
            const content = await file.text();
            if (version.current !== current) return;
            const parsed = parseMindmapXml(content, {
              ...MINDMAP_XML_LIMITS,
              bytes,
            });
            const limit = await readMermaidSourceLimit();
            if (version.current !== current) return;
            const prepared = prepareForeignMindmap(parsed, limit);
            if (version.current === current) setCandidate(prepared);
          } catch (error) {
            if (version.current === current) setError(fail(error));
          } finally {
            if (version.current === current) setLoading(false);
          }
        }}
      />
      <Button loading={loading} onClick={() => input.current?.click()}>
        {t["com.myoxus.workspace-import.choose-file"]()}
      </Button>
      {error ? (
        <Alert color="myoxusError" role="alert">
          {error}
        </Alert>
      ) : null}
      {candidate ? (
        <>
          <MyoxusText>
            {t["com.myoxus.editor.mermaid.mindmap-import-summary"]({
              format: candidate.format === "mm" ? "FreeMind" : "OPML",
              nodes: String(candidate.nodeCount),
              depth: String(candidate.depth),
              left: String(
                candidate.root.children.filter(
                  (node) => node.layoutType === "left",
                ).length,
              ),
              right: String(
                candidate.root.children.filter(
                  (node) => node.layoutType === "right",
                ).length,
              ),
            })}
          </MyoxusText>
          <MyoxusText>{candidate.root.text}</MyoxusText>
          {candidate.losses.length ? (
            <>
              <Stack>
                {candidate.losses.map((loss) => (
                  <MyoxusText key={`${loss.kind}:${loss.field}`}>
                    {loss.field} × {loss.count}
                  </MyoxusText>
                ))}
              </Stack>
              <Checkbox
                label={t["com.myoxus.editor.mermaid.mindmap-import-losses"]()}
                checked={confirmed}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />
            </>
          ) : null}
          {native && !fillEmpty ? (
            <Group>
              <NumberInput
                label={t["com.myoxus.editor.mermaid.mindmap-import-x"]()}
                value={position.x}
                onChange={(value) =>
                  setPosition({
                    ...position,
                    x: value === "" ? NaN : Number(value),
                  })
                }
              />
              <NumberInput
                label={t["com.myoxus.editor.mermaid.mindmap-import-y"]()}
                value={position.y}
                onChange={(value) =>
                  setPosition({
                    ...position,
                    y: value === "" ? NaN : Number(value),
                  })
                }
              />
            </Group>
          ) : null}
        </>
      ) : null}
      <Group>
        <Button
          disabled={
            readonly ||
            !candidate ||
            loading ||
            (candidate.losses.length > 0 && !confirmed) ||
            (native &&
              !fillEmpty &&
              (!Number.isFinite(position.x) || !Number.isFinite(position.y)))
          }
          onClick={() => {
            if (!candidate || readonly) return;
            const result = onImport(candidate, native ? position : undefined);
            if (result.changed) onClose();
            else setError(result.diagnostic ?? m.mmdImportFailed());
          }}
        >
          {!fillEmpty
            ? t["com.myoxus.editor.mermaid.mindmap-import-new"]()
            : t.Apply()}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            version.current++;
            onClose();
          }}
        >
          {t.Cancel()}
        </Button>
      </Group>
    </Stack>
  );
}
