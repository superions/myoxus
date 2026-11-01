function testPackageName(regexp: RegExp): (module: any) => boolean {
  return (module: any) =>
    module.nameForCondition && regexp.test(module.nameForCondition());
}

// https://hackernoon.com/the-100-correct-way-to-split-your-chunks-with-webpack-f8a9df5b7758
export const productionCacheGroups = {
  i18n: {
    test: /frontend[\\/]i18n[\\/]/,
    name: (module: any) => {
      const name = module.resource.match(/[\\/]([^\\/]+)\.json$/)?.[1];
      if (name && name !== "en") {
        return `i18n-langs.${name}`;
      }

      return "i18n";
    },
    priority: 200,
    enforce: true,
  },
  asyncVendor: {
    test: /[\\/]node_modules[\\/]/,
    name(module: any) {
      const modulePath =
        module?.nameForCondition?.() || module?.context || module?.resource;

      if (!modulePath || typeof modulePath !== "string") {
        return "app-async";
      }

      // monorepo linked in node_modules, so it's not a npm package
      if (!modulePath.includes("node_modules")) {
        return `app-async`;
      }
      // Shiki's language/theme registries already use per-entry dynamic imports.
      // Grouping the entire scope reunites them and loads every grammar/theme
      // when the first code block requests just one. Keep those boundaries.
      const shikiEntry = modulePath.match(
        /[\\/]node_modules[\\/]@shikijs[\\/](langs|themes)[\\/]dist[\\/]([^\\/]+)\.mjs$/,
      );
      if (shikiEntry && shikiEntry[2] !== "index") {
        return `npm-async-@shikijs-${shikiEntry[1]}-${shikiEntry[2]}`;
      }

      // Ordinary async Mantine controls must not reunite optional chart or
      // RichText runtimes with their first-use requests through the scope chunk.
      const optionalMantine = modulePath.match(
        /[\\/]node_modules[\\/]@mantine[\\/](charts|tiptap)[\\/]/,
      );
      if (optionalMantine) return `npm-async-@mantine-${optionalMantine[1]}`;

      const name = modulePath.match(
        /[\\/]node_modules[\\/](.*?)([\\/]|$)/,
      )?.[1];
      return `npm-async-${name}`;
    },
    priority: Number.MAX_SAFE_INTEGER,
    chunks: "async" as const,
  },
  virgultum: {
    name: `npm-virgultum`,
    test: testPackageName(/[\\/]node_modules[\\/](@virgultum)[\\/]/),
    priority: 200,
    enforce: true,
  },
  react: {
    name: `npm-react`,
    test: testPackageName(
      /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
    ),
    priority: 200,
    enforce: true,
  },
  jotai: {
    name: `npm-jotai`,
    test: testPackageName(/[\\/]node_modules[\\/](jotai)[\\/]/),
    priority: 200,
    enforce: true,
  },
  rxjs: {
    name: `npm-rxjs`,
    test: testPackageName(/[\\/]node_modules[\\/]rxjs[\\/]/),
    priority: 200,
    enforce: true,
  },
  lodash: {
    name: `npm-lodash`,
    test: testPackageName(/[\\/]node_modules[\\/]lodash[\\/]/),
    priority: 200,
    enforce: true,
  },
  emotion: {
    name: `npm-emotion`,
    test: testPackageName(/[\\/]node_modules[\\/](@emotion)[\\/]/),
    priority: 200,
    enforce: true,
  },
  vendor: {
    name: "vendor",
    test: /[\\/]node_modules[\\/]/,
    priority: 190,
    enforce: true,
  },
  styles: {
    name: "styles",
    test: (module: any) => {
      const resource = module.nameForCondition?.();
      return (
        typeof resource === "string" &&
        resource.endsWith(".css") &&
        !module.type.startsWith("javascript") &&
        // A shared initial stylesheet must not reunite the lazy modeller's CSS
        // with parser/source imports. XYFlow is shared with the lazy document
        // graph; its CSS follows that runtime, not ordinary editor startup.
        !/[\\/]client[\\/]libs[\\/]bpmn-editor[\\/]/.test(resource) &&
        !/[\\/]node_modules[\\/]@xyflow[\\/]/.test(resource)
      );
    },
    chunks: "all" as const,
    minSize: 1,
    minChunks: 1,
    reuseExistingChunk: true,
    priority: 1000,
    enforce: true,
  },
};
