// SPDX-License-Identifier: AGPL-3.0-or-later

import { signal } from "@preact/signals-core";
import type { Container } from "@virgultum/global/di";
import { describe, expect, it } from "vitest";

import {
  DefaultEditorI18nService,
  EditorI18nExtension,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "../../services/i18n-service.js";
import { legacyEditorMessage } from "../../services/legacy-editor-text.js";

type Binding = {
  factory: (provider: unknown) => unknown;
};

function makeContainer(): Container & { __bindings: Map<unknown, Binding> } {
  const bindings = new Map<unknown, Binding>();
  return {
    __bindings: bindings,
    addImpl: (identifier: unknown, factory: unknown) => {
      bindings.set(identifier, { factory: factory as Binding["factory"] });
    },
  } as unknown as Container & { __bindings: typeof bindings };
}

describe("EditorI18nService", () => {
  it("uses the standalone fallback and interpolates values without a host", () => {
    const service = new DefaultEditorI18nService();

    expect(
      service.translate(
        editorMessage("com.myoxus.editor.test.greeting", "Hello, {{name}}!", {
          name: "Ada",
        }),
      ),
    ).toBe("Hello, Ada!");
    expect(
      service.translate(
        editorMessage(
          "com.myoxus.editor.test.missing-value",
          "Value: {{value}}",
          {
            value: undefined,
          },
        ),
      ),
    ).toBe("Value: {{value}}");
  });

  it("uses the host translation and falls back for missing results", () => {
    const locale$ = signal("de");
    const service = new DefaultEditorI18nService({
      locale$,
      translate: (message) =>
        message.key === "com.myoxus.editor.test.translated"
          ? "Übersetzt"
          : undefined,
    });

    expect(
      service.translate(
        editorMessage("com.myoxus.editor.test.translated", "Translated"),
      ),
    ).toBe("Übersetzt");
    expect(
      service.translate(
        editorMessage("com.myoxus.editor.test.untranslated", "Fallback"),
      ),
    ).toBe("Fallback");
    expect(service.locale$.value).toBe("de");
  });

  it.each([" \t\n", "test.missing"])(
    "uses the interpolated fallback for an unusable host result: %s",
    (translated) => {
      const service = new DefaultEditorI18nService({
        locale$: signal("de"),
        translate: () => translated,
      });
      expect(
        service.translate(
          editorMessage("test.missing", "Hello {{name}}", {
            name: "Ada",
          }),
        ),
      ).toBe("Hello Ada");
    },
  );

  it("resolves transitional toolbar text through a central key", () => {
    const service = new DefaultEditorI18nService({
      locale$: signal("de"),
      translate: (message) =>
        message.key === "com.myoxus.editor.toolbar.card-view"
          ? "Kartenansicht"
          : undefined,
    });

    expect(
      resolveEditorMessage(legacyEditorMessage("Card view"), service),
    ).toBe("Kartenansicht");
    expect(
      resolveEditorMessage(
        legacyEditorMessage("Unknown visible label"),
        service,
      ),
    ).toBe("Unknown visible label");
  });

  it("publishes the service through the editor DI extension", () => {
    const container = makeContainer();
    const service = new DefaultEditorI18nService();

    EditorI18nExtension({
      locale$: service.locale$,
      translate: () => undefined,
    }).setup!(container);

    const binding = container.__bindings.get(EditorI18nProvider);
    expect(binding).toBeDefined();
    expect(binding!.factory(undefined)).toBeInstanceOf(
      DefaultEditorI18nService,
    );
  });
});
