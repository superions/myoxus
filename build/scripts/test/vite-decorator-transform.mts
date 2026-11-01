import swc from "@rollup/plugin-swc";
import { withFilter } from "vite";

/**
 * Lower standard decorators for browser targets that do not implement them.
 * Vite 8's Oxc transform strips TypeScript, but intentionally does not lower
 * native decorators yet. Keeping the narrow SWC pass shared prevents browser
 * configs from drifting while Oxc remains the primary transform owner.
 */
export function createDecoratorTransform() {
  const decoratorTransform = swc({
    include: /\.[cm]?[jt]sx?$/,
    swc: {
      jsc: {
        externalHelpers: false,
        parser: {
          decorators: true,
          dynamicImport: true,
          syntax: "typescript",
          tsx: true,
        },
        target: "es2022",
        transform: {
          decoratorVersion: "2023-11",
          legacyDecorator: false,
          react: {
            runtime: "automatic",
          },
          useDefineForClassFields: false,
        },
      },
      inlineSourcesContent: true,
    },
  });

  const filteredTransform = withFilter(
    {
      ...decoratorTransform,
      // SWC must lower decorators before Vite's Oxc transform lowers class
      // fields; reversing that order moves accessor initializers ahead of
      // state fields declared earlier in the class.
      enforce: "pre",
    },
    {
      // Scoped imports such as `@myoxus/*` must stay on Vite's Oxc path.
      // Match decorator declarations and auto-accessor fields at line start,
      // without treating Lit event bindings (`@click=`) as decorators. SWC
      // must lower both because current Node runtimes cannot execute the
      // auto-accessor syntax emitted by decorator-heavy Virgultum classes.
      transform: {
        code: /^(?:\s*@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s*\(|\s*$)|\s*(?:(?:public|protected|private|static|override|declare|abstract)\s+)*accessor\s+[A-Za-z_$][\w$]*)/m,
      },
    },
  );

  return filteredTransform;
}
