const fs = require("node:fs");

const { Kind, print, visit, TypeInfo, visitWithTypeInfo } = require("graphql");
// GraphQL identifiers are ASCII names, so native first-character casing retains
// operation/fragment naming without Lodash's general Unicode word handling.
const upperFirst = (name = "") => name.charAt(0).toUpperCase() + name.slice(1);
const lowerFirst = (name = "") => name.charAt(0).toLowerCase() + name.slice(1);

function tsString(value) {
  return JSON.stringify(value);
}

/**
 * return exported name used in runtime.
 *
 * @param {import('graphql').ExecutableDefinitionNode} def
 * @returns {string}
 */
function getExportedName(def) {
  const name = lowerFirst(def.name?.value);
  const suffix =
    def.kind === Kind.OPERATION_DEFINITION
      ? upperFirst(def.operation)
      : "Fragment";
  return name.endsWith(suffix) ? name : name + suffix;
}

/**
 * Check if a field is deprecated in the schema
 *
 * @param {import('graphql').GraphQLSchema} schema
 * @param {string} typeName
 * @param {string} fieldName
 * @returns {boolean}
 */
function fieldDeprecation(schema, typeName, fieldName) {
  const type = schema.getType(typeName);
  if (!type || !type.getFields) {
    return false;
  }

  const fields = type.getFields();
  const field = fields[fieldName];

  return field?.deprecationReason
    ? {
        name: fieldName,
        reason: field.deprecationReason,
      }
    : null;
}

/**
 * Check if a query uses deprecated fields
 *
 * @param {import('graphql').GraphQLSchema} schema
 * @param {import('graphql').DocumentNode} document
 * @returns {boolean}
 */
function parseDeprecations(schema, document) {
  const deprecations = [];

  const typeInfo = new TypeInfo(schema);

  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          const parentType = typeInfo.getParentType();
          if (parentType && node.name) {
            const fieldName = node.name.value;
            let deprecation;
            if (
              parentType.name &&
              (deprecation = fieldDeprecation(
                schema,
                parentType.name,
                fieldName,
              ))
            ) {
              deprecations.push(deprecation);
            }
          }
        },
      },
    }),
  );

  return deprecations.map(
    ({ name, reason }) => `'${name}' is deprecated: ${reason}`,
  );
}

/**
 * @type {import('@graphql-codegen/plugin-helpers').CodegenPlugin}
 *
 * Note: this file is loaded via ESM dynamic `import()` by graphql-codegen.
 * Older versions exposed `module.exports = {plugin, validate}`, but Node's
 * ESM-to-CJS bridge does NOT promote a single `module.exports` object to
 * top-level named exports — the consumer would only see `m.default`. We
 * therefore assign each named export to `exports.<name>`, which Node's
 * `cjs-module-lexer` detects and re-exports at the top level of the ESM
 * namespace, matching what `executePlugin` looks for (`m.plugin`).
 */
exports.plugin = (schema, documents, { output }) => {
  const defs = new Map();
  const queries = [];
  const mutations = [];

  const nameLocationMap = new Map();
  const locationSourceMap = new Map();
  for (const source of documents) {
    if (!source?.location) {
      throw new Error("GraphQL document is missing its source location");
    }
    if (!source.document || typeof source.rawSDL !== "string") {
      throw new Error(
        `GraphQL document ${source.location} is missing its parsed AST or rawSDL`,
      );
    }
    locationSourceMap.set(source.location, source);
  }

  function addDef(exportedName, location) {
    if (nameLocationMap.has(exportedName)) {
      throw new Error(
        `name ${exportedName} export from ${location} are duplicated.`,
      );
    }

    nameLocationMap.set(exportedName, location);
  }

  const fragmentByName = new Map();
  for (const source of locationSourceMap.values()) {
    for (const def of source.document.definitions) {
      if (def.kind !== Kind.FRAGMENT_DEFINITION) {
        continue;
      }

      const fragmentName = def.name.value;
      if (fragmentByName.has(fragmentName)) {
        throw new Error(`fragment ${fragmentName} is defined more than once.`);
      }
      fragmentByName.set(fragmentName, def);
    }
  }

  function collectReferencedFragments(definition, location) {
    const collected = [];
    const seen = new Set();

    function collect(fragmentName) {
      if (seen.has(fragmentName)) {
        return;
      }
      seen.add(fragmentName);

      const fragment = fragmentByName.get(fragmentName);
      if (!fragment) {
        throw new Error(
          `fragment ${fragmentName} referenced from ${location} was not found.`,
        );
      }

      collected.push(print(fragment));
      visit(fragment, {
        [Kind.FRAGMENT_SPREAD]: {
          enter: (node) => collect(node.name.value),
        },
      });
    }

    visit(definition, {
      [Kind.FRAGMENT_SPREAD]: {
        enter: (node) => collect(node.name.value),
      },
    });

    return collected.join("\n");
  }

  for (const [location, source] of locationSourceMap) {
    visit(source.document, {
      [Kind.OPERATION_DEFINITION]: {
        enter: (node) => {
          if (!node.name) {
            throw new Error(
              `Anonymous operation definition found in ${location}.`,
            );
          }

          const exportedName = getExportedName(node);
          addDef(exportedName, location);

          // parse 'file' fields
          const containsFile = node.variableDefinitions.some((def) => {
            // Upload lists can nest both list and non-null wrappers. The
            // descriptor must still select multipart transport for [Upload!]!.
            let variableType = def.type;
            while (variableType.kind !== Kind.NAMED_TYPE) {
              variableType = variableType.type;
            }
            const varType = variableType.name.value;
            const checkContainFile = (type) => {
              if (schema.getType(type)?.name === "Upload") return true;
              const typeDef = schema.getType(type);
              const fields = typeDef.getFields?.();
              if (!fields || typeof fields !== "object") return false;
              for (let field of Object.values(fields)) {
                let type = field.type;
                while (type.ofType) {
                  type = type.ofType;
                }
                if (type.name === "Upload") {
                  return true;
                }
              }
              return false;
            };
            return varType ? checkContainFile(varType) : false;
          });

          // Check if the query uses deprecated fields
          const deprecations = parseDeprecations(schema, source.document);

          const fragments = collectReferencedFragments(node, location);

          defs.set(exportedName, {
            type: node.operation,
            name: exportedName,
            operationName: node.name.value,
            containsFile,
            deprecations,
            query: `${print(node)}${fragments ? `\n${fragments}` : ""}`,
          });

          if (node.operation === "query") {
            queries.push(exportedName);
          } else if (node.operation === "mutation") {
            mutations.push(exportedName);
          }
        },
      },
      [Kind.FRAGMENT_DEFINITION]: {
        enter: (node) => {
          const exportedName = getExportedName(node);
          addDef(exportedName, location);

          const fragments = collectReferencedFragments(node, location);

          defs.set(exportedName, {
            type: "fragment",
            name: exportedName,
            content: `${print(node)}${fragments ? `\n${fragments}` : ""}`,
          });
        },
      },
    });
  }

  const preludes = [
    "/* do not manipulate this file manually. */",
    `export type GraphQLOperationKind = "query" | "mutation" | "subscription";
export interface GraphQLQuery {
  id: string;
  op: string;
  kind?: GraphQLOperationKind;
  query: string;
  file?: boolean;
  deprecations?: string[];
}`,
  ];

  const operations = [];

  defs.forEach((def) => {
    if (def.type === "fragment") {
      preludes.push(`export const ${def.name} = \`${def.content}\`;`);
    } else {
      let item = `export const ${def.name} = {
  id: ${tsString(def.name)} as const,
  op: ${tsString(def.operationName)},
  kind: ${tsString(def.type)} as const,
  query: \`${def.query}\`,
`;
      if (def.containsFile) {
        item += "  file: true,\n";
      }
      if (def.deprecations.length) {
        item += `  deprecations: ${JSON.stringify(def.deprecations)},\n`;
      }
      item += "};\n";

      operations.push(item);
    }
  });

  fs.writeFileSync(output, preludes.join("\n") + "\n" + operations.join("\n"));

  const queriesUnion = queries
    .map((query) => {
      const queryName = upperFirst(query);
      return `{
          name: ${tsString(query)},
          variables: ${queryName}Variables,
          response: ${queryName}
        }
      `;
    })
    .join("|");

  const mutationsUnion = mutations
    .map((query) => {
      const queryName = upperFirst(query);
      return `{
          name: ${tsString(query)},
          variables: ${queryName}Variables,
          response: ${queryName}
        }
      `;
    })
    .join("|");
  const queryTypes = queriesUnion
    ? `export type Queries = ${queriesUnion}`
    : "";
  const mutationsTypes = mutationsUnion
    ? `export type Mutations = ${mutationsUnion}`
    : "";
  return `
${queryTypes}
${mutationsTypes}
`;
};

exports.validate = (_schema, _documents, { output }) => {
  if (!output) {
    throw new Error("Export plugin must be used with a output file given");
  }
};
