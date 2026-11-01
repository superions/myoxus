/**
 * @vitest-environment happy-dom
 */

import { Framework, FrameworkRoot, LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DocService } from "../../modules/doc";
import { TemplateValue } from "./template";

function renderTemplateValue({
  isTemplate = false,
  readonly = false,
}: {
  isTemplate?: boolean;
  readonly?: boolean;
} = {}) {
  const setTemplateState = vi.fn();
  const framework = new Framework();
  framework.service(DocService, {
    doc: {
      isTemplate$: new LiveData(isTemplate),
      record: {
        setTemplateState,
      },
    },
  } as any);

  render(
    <MyoxusUIProvider>
      <FrameworkRoot framework={framework.provider()}>
        <TemplateValue
          readonly={readonly}
          value={undefined}
          onChange={vi.fn()}
        />
      </FrameworkRoot>
    </MyoxusUIProvider>,
  );

  return {
    checkbox: screen.getByTestId("toggle-template-checkbox"),
    setTemplateState,
  };
}

describe("TemplateValue", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("writes template state through the native document metadata boundary", () => {
    const first = renderTemplateValue({ isTemplate: false });

    fireEvent.click(first.checkbox);

    expect(first.setTemplateState).toHaveBeenCalledExactlyOnceWith(true);

    document.body.innerHTML = "";
    const second = renderTemplateValue({ isTemplate: true });

    fireEvent.click(second.checkbox);

    expect(second.setTemplateState).toHaveBeenCalledExactlyOnceWith(false);
  });

  test("does not mutate template state when the property is readonly", () => {
    const { checkbox, setTemplateState } = renderTemplateValue({
      isTemplate: true,
      readonly: true,
    });

    fireEvent.click(checkbox);

    expect(setTemplateState).not.toHaveBeenCalled();
  });
});
