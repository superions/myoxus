// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Alert,
  Button,
  Group,
  Loading,
  Modal,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import { type RefObject, useEffect, useRef, useState } from "react";
import { configureEditorI18n } from "../../../editor/virgultum/editor-i18n";
import type {
  TemplateCheckDiagnostic,
  TemplateCheckResult,
} from "../../doc/services/docs";
import { templateVariableCapabilities } from "../../doc/services/template-variables";
import { WorkbenchService } from "../../workbench";
import { templateFailureMessages } from "../services/template-application";
import { TemplateCheckService } from "../services/template-check";
import { TemplateInstantiationError } from "../services/template-instantiation-error";

function CheckResults({
  result,
  locate,
}: {
  result: TemplateCheckResult;
  locate: (diagnostic: TemplateCheckDiagnostic) => void;
}) {
  const t = useI18n();
  const stale = useLiveData(result.stale$);
  const i18n = configureEditorI18n();
  const labels = {
    available: t["com.myoxus.template-check.available"](),
    application: t["com.myoxus.template-check.application"](),
    input: t["com.myoxus.template-check.input"](),
    context: t["com.myoxus.template-check.context"](),
    error: t["com.myoxus.template-check.error"](),
  };
  return (
    <Stack>
      <MyoxusText data-testid="template-check-summary">
        {t["com.myoxus.template-check.summary"]({
          count: String(result.diagnostics.length),
        })}
        {Object.entries(labels).map(([status, label]) => {
          const count = result.diagnostics.filter(
            (d) => d.status === status,
          ).length;
          return count ? ` · ${label}: ${count}` : "";
        })}
      </MyoxusText>
      {stale ? <Alert title={t["com.myoxus.template-check.stale"]()} /> : null}
      {!result.diagnostics.length ? (
        <MyoxusText>{t["com.myoxus.template-check.empty"]()}</MyoxusText>
      ) : null}
      {result.diagnostics.map((diagnostic, index) => {
        const capability = templateVariableCapabilities.find(
          (entry) => entry.name === diagnostic.name,
        );
        const reason = diagnostic.reason;
        const message =
          diagnostic.status === "context"
            ? labels.context
            : reason === "unknown-token"
              ? t["com.myoxus.template-check.unknown"]()
              : reason === "invalid-syntax"
                ? t["com.myoxus.template-check.syntax"]()
                : reason === "repeat-invalid"
                  ? t["com.myoxus.template-check.repeat"]()
                  : reason
                    ? t[templateFailureMessages[reason]]()
                    : labels[diagnostic.status];
        return (
          <Stack
            key={index}
            gap="xs"
            data-testid="template-check-diagnostic"
            data-status={diagnostic.status}
          >
            <Group justify="space-between">
              <MyoxusText>
                {capability
                  ? i18n.translate(capability.label)
                  : diagnostic.name
                    ? `{{${diagnostic.name}}}`
                    : labels.error}
              </MyoxusText>
              <Button
                variant="secondary"
                disabled={stale}
                onClick={() => locate(diagnostic)}
                data-testid="template-check-locate"
              >
                {t["com.myoxus.template-check.locate"]()}
              </Button>
            </Group>
            <MyoxusText>{message}</MyoxusText>
            {capability ? (
              <MyoxusText tone="secondary">
                {i18n.translate(capability.source)} ·{" "}
                {i18n.translate(capability.availability)}
              </MyoxusText>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

/** Uses the existing Modal return-focus/exit contract for both source menus. */
export function TemplateCheckDialog({
  sourceDocId,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  sourceDocId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const t = useI18n();
  const service = useService(TemplateCheckService);
  const workbench = useService(WorkbenchService).workbench;
  const [result, setResult] = useState<TemplateCheckResult | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(false);
  const active = useRef<{
    abort: AbortController;
    result?: TemplateCheckResult;
  } | null>(null);
  const navigation = useRef<{
    result: TemplateCheckResult;
    diagnostic: TemplateCheckDiagnostic;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!open) return;
    const attempt = {
      abort: new AbortController(),
      result: undefined as TemplateCheckResult | undefined,
    };
    active.current = attempt;
    setResult(null);
    setPending(true);
    setFailure(false);
    const timer = setTimeout(
      () => attempt.abort.abort(new TemplateInstantiationError("sync-timeout")),
      30_000,
    );
    void service
      .check(sourceDocId, attempt.abort.signal)
      .then(
        (result) => {
          if (attempt.abort.signal.aborted) {
            result.release();
            return;
          }
          attempt.result = result;
          setResult(result);
        },
        () => {
          if (!attempt.abort.signal.aborted) setFailure(true);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        if (active.current === attempt) setPending(false);
        if (
          attempt.abort.signal.reason instanceof TemplateInstantiationError &&
          attempt.abort.signal.reason.reason === "sync-timeout"
        )
          setFailure(true);
      });
    return () => {
      clearTimeout(timer);
      attempt.abort.abort(new TemplateInstantiationError("cancelled"));
      attempt.result?.release();
      if (active.current === attempt) active.current = null;
    };
  }, [open, generation, sourceDocId, service]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title={t["com.myoxus.template-check.action"]()}
      width="lg"
      contentOptions={{
        "data-testid": "template-check-dialog",
        onKeyDown: (event) => event.stopPropagation(),
      }}
      onExitTransitionEnd={() => {
        const next = navigation.current;
        navigation.current = null;
        if (next && next.result.isCurrent()) {
          workbench.openDoc(
            {
              docId: sourceDocId,
              mode: "page",
            },
            { at: "active" },
          );
          // Native inspection owns the range. A route block anchor would run
          // a second focus operation and overwrite the selected token.
          service.locate(next.result, next.diagnostic);
        }
      }}
    >
      <Stack>
        <MyoxusText tone="secondary">
          {t["com.myoxus.template-check.description"]()}
        </MyoxusText>
        {pending ? <Loading /> : null}
        {failure ? (
          <Alert
            title={t["com.myoxus.template-application.error.unavailable"]()}
          />
        ) : null}
        {result ? (
          <CheckResults
            result={result}
            locate={(diagnostic) => {
              if (!result.isCurrent()) {
                result.stale$.setValue(true);
                return;
              }
              navigation.current = { result, diagnostic };
              onOpenChange(false);
            }}
          />
        ) : null}
        <Group justify="flex-end">
          <Button
            disabled={pending}
            onClick={() => setGeneration((value) => value + 1)}
            data-testid="template-check-again"
          >
            {t["com.myoxus.template-check.again"]()}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
