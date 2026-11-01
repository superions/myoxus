/**
 * Web workers can share editor/model modules with browser UI entries, but they
 * cannot apply extracted CSS side effects. Treat style imports as empty modules
 * in worker bundles so class-name modules stay importable without injecting UI
 * CSS into worker code.
 *
 * @type {import('@rspack/core').LoaderDefinition}
 */
export default function loader() {
  return "export {};";
}
