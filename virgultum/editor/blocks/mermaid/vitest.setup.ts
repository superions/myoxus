import { beforeEach, vi } from "vitest";

const values: Record<string, string> = {
  "--myoxus-background-primary-color": "rgb(255, 255, 255)",
  "--myoxus-background-error-color": "rgb(255, 225, 225)",
  "--myoxus-background-processing-color": "rgb(225, 240, 255)",
  "--myoxus-background-secondary-color": "rgb(245, 245, 245)",
  "--myoxus-background-success-color": "rgb(230, 250, 235)",
  "--myoxus-background-warning-color": "rgb(255, 240, 215)",
  "--myoxus-border-color": "rgb(80, 80, 80)",
  "--myoxus-error-color": "rgb(175, 55, 55)",
  "--myoxus-primary-color": "rgb(70, 90, 210)",
  "--myoxus-processing-color": "rgb(45, 105, 150)",
  "--myoxus-success-color": "rgb(30, 130, 70)",
  "--myoxus-text-primary-color": "rgb(20, 20, 20)",
  "--myoxus-text-secondary-color": "rgb(90, 90, 90)",
  "--myoxus-typography-body-family": "Inter",
  "--myoxus-typography-body-font-style": "normal",
  "--myoxus-typography-body-letter-spacing": "0px",
  "--myoxus-typography-body-line-height": "24px",
  "--myoxus-typography-body-size": "16px",
  "--myoxus-typography-body-small-size": "12px",
  "--myoxus-typography-body-weight": "400",
  "--myoxus-typography-h1-family": "Inter",
  "--myoxus-typography-h1-font-style": "normal",
  "--myoxus-typography-h1-size": "24px",
  "--myoxus-typography-h3-size": "20px",
  "--myoxus-warning-color": "rgb(190, 95, 40)",
};

beforeEach(() => {
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const requestedColor = (element as HTMLElement).style?.color.match(
      /^var\((--[^)]+)\)$/,
    )?.[1];
    return {
      backgroundColor: values["--myoxus-background-primary-color"],
      borderBottomColor: values["--myoxus-background-success-color"],
      borderColor: values["--myoxus-border-color"],
      borderLeftColor: values["--myoxus-border-color"],
      borderRightColor: values["--myoxus-primary-color"],
      borderTopColor: values["--myoxus-background-secondary-color"],
      color:
        (requestedColor ? values[requestedColor] : undefined) ??
        values["--myoxus-text-primary-color"],
      fontFamily: values["--myoxus-typography-body-family"],
      fontSize: values["--myoxus-typography-body-size"],
      fontStyle: values["--myoxus-typography-body-font-style"],
      fontWeight: values["--myoxus-typography-body-weight"],
      getPropertyValue: (property: string) => values[property] ?? "",
      letterSpacing: values["--myoxus-typography-body-letter-spacing"],
      lineHeight: values["--myoxus-typography-body-line-height"],
      outlineColor: values["--myoxus-text-secondary-color"],
      textDecorationColor: values["--myoxus-success-color"],
    } as CSSStyleDeclaration;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text: string) =>
      ({ width: Array.from(text).length * 8 }) as TextMetrics,
  } as CanvasRenderingContext2D);
});
