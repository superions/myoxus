/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus: worker-safe XML DOM, strict errors and opaque subtree preservation.
import {
  XMLSerializer,
  type Document,
  type Element,
  type Node,
} from "@xmldom/xmldom";
import { parseBoundedXml } from "./preflight";

export type XmlParserTs<T extends object> = {
  parse: (
    args:
      | { type: "xml"; xml: string }
      | { type: "domdoc"; domdoc: Document; instanceNs: Map<string, string> },
  ) => {
    json: T;
    instanceNs: Map<string, string>;
  };
  build: (args: { json: T; instanceNs: Map<string, string> }) => string;
};

export type XmlParserTsRootElementBaseType = Partial<{
  [k: `@_xmlns:${string}`]: string;
}> & { "@_xmlns"?: string };

export type XmlDocument = {
  "?xml"?: {
    "@_encoding"?: string;
    "@_version"?: string;
  };
};

export type MetaTypeProp = {
  type: string;
  isArray: boolean;
  fromType: string;
  xsdType: string;
};

export type MetaType = Record<string, MetaTypeProp>;

export type Meta = Record<string, MetaType>;

export type Root = { element: string; type: string };

export type Subs = Record<string, Record<string, string>>;

export type Elements = Record<string, string>;

export const domParser = {
  getDomDocument: parseBoundedXml,
};

/**
 * Returns a bi-directional map with the namespace aliases declared at the root element of a XML document pointing to their URIs and vice-versa. In this map, namespace aliases are suffixed with `:`.
 * E.g. "bpmn:" => "http://www.omg.org/spec/BPMN/20100524/MODEL" and vice versa.
 */
export function getInstanceNs(domdoc: Document): Map<string, string> {
  const nsMap = new Map<string, string>(
    Array.from(domdoc.documentElement?.attributes ?? []).flatMap((attr) => {
      if (attr.name !== "xmlns" && !attr.name.startsWith("xmlns:")) {
        return [];
      }

      const nsUri = attr.value;

      const s = attr.name.split(":");
      if (s.length === 1) {
        // That's the default namespace.
        return [
          [nsUri, ""],
          ["", nsUri],
        ];
      } else if (s.length === 2) {
        // Normal namespace mapping.
        return [
          [nsUri, `${s[1]}:`],
          [`${s[1]}:`, nsUri],
        ];
      } else {
        throw new Error(`Invalid xmlns mapping attribute '${attr.name}'`);
      }
    }),
  );

  return nsMap;
}

export function getInstanceNsFromJson(
  rootElement: XmlParserTsRootElementBaseType,
): Map<string, string> {
  const nsMap = new Map<string, string>(
    Object.entries(rootElement).flatMap(([attr, value]) => {
      if (!attr.startsWith("@_xmlns")) {
        return [];
      }

      const nsUri = value ?? "";

      const s = attr.split(":");
      if (s.length === 1) {
        // That's the default namespace.
        return [
          [nsUri, ""],
          ["", nsUri],
        ];
      } else if (s.length === 2) {
        // Normal namespace mapping.
        return [
          [nsUri, `${s[1]}:`],
          [`${s[1]}:`, nsUri],
        ];
      } else {
        throw new Error(`Invalid xmlns mapping attribute '${attr}'`);
      }
    }),
  );

  return nsMap;
}

export function getParser<T extends object>(args: {
  /** Meta information about the structure of the XML. Used for deciding whether a property is array, boolean, float or integer. */
  meta: Meta;
  /** Substituion group mapping going from concrete elements to their substitution group head. */
  subs: Subs;
  /** Element types mapped by their namespaced names. */
  elements: Elements;
  /** Bi-directional namespace --> URI mapping. This is the one used to normalize the resulting JSON, independent of the namespaces declared on the XML instance. */
  ns: Map<string, string>;
  /** Information about the root element used on the XML documents */
  root: Root;
  /** Only the handwritten XSD bootstrap needs structural traversal of unmapped XSD nodes. */
  opaqueUnknownElements?: boolean;
}): XmlParserTs<T> {
  return {
    parse: (parseArgs) => {
      const domdoc =
        parseArgs.type === "domdoc"
          ? parseArgs.domdoc
          : domParser.getDomDocument(parseArgs.xml);
      const instanceNs =
        parseArgs.type === "domdoc"
          ? parseArgs.instanceNs
          : getInstanceNs(domdoc);

      const rootType = {
        [args.root.element]: {
          type: args.root.type,
          isArray: false,
          xsdType: "",
          fromType: "",
        },
      };
      const json = parse({
        ...args,
        instanceNs,
        node: domdoc,
        nodeMetaType: rootType,
      });

      return { json, instanceNs };
    },
    build: ({ json }) => {
      const __json = JSON.parse(JSON.stringify(json));

      __json["?xml"] = {
        "@_version": "1.0",
        "@_encoding": "UTF-8",
      };

      // Since building starts from a level above the root element, we need create this pseudo-metaType to correctly type the tree we're building.
      const rootMetaType = {
        [args.root.element]: {
          type: args.root.type,
          fromType: "root",
          isArray: false,
          xsdType: "// root",
        },
      };

      const declaredElementsOrder = [];
      for (const e in args.elements ?? {}) {
        declaredElementsOrder.push(e);
      }

      const xml = build({
        json: __json,
        ns: args.ns,
        // Reconstruct scope from the model being written, not declarations
        // cached from the pre-edit source. Emit missing bindings only where
        // required; unused canonical aliases must not replace vendor bindings.
        instanceNs: new Map(),
        elements: args.elements,
        meta: args.meta,
        metaType: rootMetaType,
        declaredElementsOrder,
        indent: "",
      });
      return xml;
    },
  };
}

/////////////
/// PARSE ///
/////////////

/**
 * Normalize known schema names into KIE's model keys. Unknown element subtrees
 * stay opaque XML, including mixed text and sibling order, instead of being
 * flattened into a lossy generic object. The writer must honor __$$xml first.
 */
export function parse(args: {
  node: Node;
  nodeMetaType: MetaType | undefined;
  ns: Map<string, string>;
  instanceNs: Map<string, string>;
  meta: Meta;
  elements: Elements;
  subs: Subs;
  opaqueUnknownElements?: boolean;
}) {
  const json: any = {};

  for (const elemNode of Array.from(args.node.childNodes)) {
    if (elemNode.nodeType === 1 /* ELEMENT_NODE */) {
      const attrs = (elemNode as Element).attributes;
      const instanceNs = scopedNamespaces(
        Object.fromEntries(
          Array.from(attrs).map((attr) => [`@_${attr.name}`, attr.value]),
        ),
        args.instanceNs,
      );
      const childArgs = { ...args, instanceNs };
      const { nsedName, subsedName } = resolveQName(
        elemNode.nodeName,
        args.nodeMetaType,
        childArgs,
      );

      const elemMetaProp = args.nodeMetaType?.[subsedName ?? nsedName];

      const elemMetaType =
        args.meta[args.elements[nsedName]] ?? // A substitution uses the concrete BPMN type, not the abstract group head.
        (elemMetaProp
          ? args.meta[elemMetaProp.type] // If we can't find this type with the `elements` mapping, we try directly from `meta`.
          : undefined); // If the current element is not known, we simply ignore its type and go with the defaults.

      // If the elemNode's meta type has a __$$text property, this is the one we use to parse its value.
      // All other properties (except `__$$element`) on `elemType` are certainly attributes, which are handled below.
      // The `__$$element` property is also processed below, since there can be an element with both `__$$text` and `__$$element` properties.
      const t = elemMetaType?.["__$$text"]?.type ?? elemMetaProp?.type;

      let elemValue: any = {};
      // Empty schema containers (notably extensionElements) own no editable
      // children. Retain the whole container so interleaved extensions keep order.
      const opaque =
        args.opaqueUnknownElements !== false &&
        ((!elemMetaType && !elemMetaProp) ||
          (elemMetaType !== undefined &&
            Object.keys(elemMetaType).length === 0) ||
          (t === "string" &&
            Array.from(elemNode.childNodes).some(
              (child) => child.nodeType === 1,
            )));
      if (opaque) {
        // Mixed documentation is not a plain text field. Preserve its markup
        // through the low-level writer; the editable profile must fail closed
        // until its property control can represent that boundary. A decoded CR
        // needs a reference even inside opaque XML or XML 1.0 reparsing loses it.
        elemValue["__$$xml"] = new XMLSerializer()
          .serializeToString(elemNode)
          .replaceAll("\r", "&#13;");
      } else if (t === "string") {
        elemValue["__$$text"] = elemNode.textContent ?? "";
      } else if (t === "boolean") {
        elemValue["__$$text"] = parseBoolean(elemNode.textContent ?? "");
      } else if (t === "float") {
        elemValue["__$$text"] = parseFloat(elemNode.textContent ?? "");
      } else if (t === "integer") {
        elemValue["__$$text"] = parseInt(elemNode.textContent ?? "");
      } else {
        elemValue = parse({
          ...childArgs,
          node: elemNode,
          nodeMetaType: elemMetaType,
        });
      }

      if (subsedName !== nsedName) {
        // substitution occurred, need to save the original, normalized element name
        elemValue["__$$element"] = nsedName;
      }

      const argsForAttrs = { ns: args.ns, instanceNs, subs: {} }; // Attributes can't use substitution groups.
      for (let i = 0; !opaque && i < attrs.length; i++) {
        const attr = attrs[i];
        const resolvedAttrQName = resolveQName(
          attr.name,
          args.nodeMetaType,
          argsForAttrs,
        );

        // If the attribute's name is not qualified, we don't mess
        // with it. We treat it as having no namespace, instead of
        // potentially using the default namespace mapped with `xmlns=`.
        const attrName =
          attr.name === "xmlns" || attr.name.startsWith("xmlns:")
            ? attr.name
            : resolvedAttrQName.isQualified
              ? (resolvedAttrQName.subsedName ?? resolvedAttrQName.nsedName)
              : attr.name;

        const attrPropType = elemMetaType?.[`@_${attrName}`];

        let attrValue: any;
        if (attrPropType?.type === "string") {
          attrValue = attr.value;
        } else if (attrPropType?.type === "boolean") {
          attrValue = parseBoolean(attr.value);
        } else if (attrPropType?.type === "float") {
          attrValue = parseFloat(attr.value);
        } else if (attrPropType?.type === "integer") {
          attrValue = parseInt(attr.value);
        } else if (attrPropType?.type === "allNNI") {
          attrValue = parseAllNNI(attr.value);
        } else {
          attrValue = attr.value; // Unknown type, default to the text from the XML.
        }

        elemValue[`@_${attrName}`] = attrValue;
      }

      const currentValue = json[subsedName ?? nsedName];

      if (elemMetaProp?.isArray) {
        json[subsedName ?? nsedName] ??= [];
        json[subsedName ?? nsedName].push(elemValue);
      } else if (currentValue) {
        if (Array.isArray(currentValue)) {
          currentValue.push(elemValue);
        } else {
          json[subsedName ?? nsedName] = [currentValue, elemValue]; // Default behavior of accumulating elements with the same name inside an array.
        }
      } else {
        json[subsedName ?? nsedName] = elemValue;
      }
    }
  }

  return json;
}

export function resolveQName(
  name: string,
  parentMetaType: MetaType | undefined,
  {
    ns,
    instanceNs,
    subs,
  }: {
    ns: Map<string, string>;
    instanceNs: Map<string, string>;
    subs: Subs;
  },
) {
  let nameNs = undefined;
  let nameName = undefined;
  let isQualified: boolean;

  const s = name.split(":");
  if (s.length === 1) {
    // An unknown default namespace must not masquerade as standard unprefixed
    // BPMN. Keep it outside schema keys so the opaque/profile boundary sees it.
    nameNs = ns.get(instanceNs.get("")!) ?? "unknown:";
    nameName = s[0];
    isQualified = false;
  } else if (s.length === 2) {
    nameNs = ns.get(instanceNs.get(`${s[0]}:`)!) ?? `${s[0]}:`;
    nameName = s[1];
    isQualified = true;
  } else {
    throw new Error("BPMN_INVALID_QNAME");
  }

  // nsedName stands for "Namespaced name".
  const nsedName = `${nameNs}${nameName}`;

  const nsedSubs = subs[nameNs];

  // subsedName stands for "Substituted name";
  let subsedName: string | undefined = nsedName;

  // Resolve substituionGroups
  while (nsedSubs && !parentMetaType?.[subsedName]) {
    if (subsedName === undefined) {
      break; // Not mapped, ignore unknown element...
    }
    subsedName = nsedSubs[subsedName];
  }

  return { nsedName, subsedName, isQualified };
}

function parseInt(attrValue: string) {
  const value = attrValue.trim();
  const i = Number(value);
  // Prefix parsing would turn a corrupt scalar such as a CSS dimension into
  // plausible geometry. Reject the complete lexical value; never repair it.
  if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(i)) {
    throw new Error("BPMN_INVALID_INTEGER");
  }

  return i;
}

function parseFloat(attrValue: string) {
  const value = attrValue.trim();
  // XSD permits these special values; the owning DI/property inspector decides
  // where they are unusable. They must not be silently read as finite prefixes.
  if (value === "INF" || value === "-INF")
    return value === "INF" ? Infinity : -Infinity;
  if (value === "NaN") return Number.NaN;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new Error("BPMN_INVALID_NUMBER");
  }
  return Number(value);
}

//** AllNNI stands for All non-negative integers. This comes from the XSD specification. */
function parseAllNNI(attrValue: string) {
  try {
    return attrValue === "unbounded" ? "unbounded" : parseInt(attrValue);
  } catch {
    throw new Error("BPMN_INVALID_INTEGER");
  }
}

function parseBoolean(attrValue: string) {
  if (attrValue === "true" || attrValue === "1") {
    return true;
  } else if (attrValue === "false" || attrValue === "0") {
    return false;
  } else {
    throw new Error("BPMN_INVALID_BOOLEAN");
  }
}

/////////////
/// BUILD ///
/////////////

const ampEntity = { regex: new RegExp(`&`, "g"), replacement: "&amp;" };
const gtEntity = { regex: new RegExp(`>`, "g"), replacement: "&gt;" };
const ltEntity = { regex: new RegExp(`<`, "g"), replacement: "&lt;" };
const aposEntity = { regex: new RegExp(`'`, "g"), replacement: "&apos;" };
const quotEntity = { regex: new RegExp(`"`, "g"), replacement: "&quot;" };

function applyEntities(value: any) {
  return (
    `${value}`
      .replace(ampEntity.regex, ampEntity.replacement)
      .replace(gtEntity.regex, gtEntity.replacement)
      .replace(ltEntity.regex, ltEntity.replacement)
      .replace(aposEntity.regex, aposEntity.replacement)
      .replace(quotEntity.regex, quotEntity.replacement)
      // A literal CR becomes LF at the next XML parse, including text nodes.
      .replaceAll("\r", "&#13;")
  );
}

function buildAttrs(
  json: any,
  {
    ns,
    instanceNs,
  }: { ns: Map<string, string>; instanceNs: Map<string, string> },
) {
  let isEmpty = true;
  let hasText = false;
  let attrs = " ";

  // Attributes don't ever need to be serialized in a particular order.
  for (const propName in json) {
    if (propName[0] === "@") {
      const attrName =
        propName.split(":").length === 2 // only apply namespace if it's qualified name. attributes are unnamespaced by default.
          ? applyInstanceNs({ propName: propName.substring(2), instanceNs, ns })
          : propName.substring(2);

      // Literal XML attribute whitespace is normalized on reparse; references
      // retain the value previously decoded by the XML parser.
      const value = applyEntities(json[propName])
        .replaceAll("\t", "&#9;")
        .replaceAll("\n", "&#10;")
        .replaceAll("\r", "&#13;");
      attrs += `${attrName}="${value}" `;
    } else if (propName === "__$$text") {
      hasText = true;
      isEmpty = false;
    } else if (propName !== "__$$element" && propName !== "__$$xml") {
      isEmpty = false;
    }
  }

  if (typeof json !== "object") {
    isEmpty = false;
  }

  return { attrs: attrs.substring(0, attrs.length - 1), isEmpty, hasText };
}

function scopedNamespaces(
  json: any,
  inherited: Map<string, string>,
): Map<string, string> {
  const instanceNs = new Map(inherited);
  for (const [key, value] of Object.entries(json)) {
    if (key === "@_xmlns" || key.startsWith("@_xmlns:")) {
      const prefix = key === "@_xmlns" ? "" : `${key.slice(8)}:`;
      instanceNs.set(prefix, value as string);
    }
  }
  // Reverse aliases are a cache of the actual in-scope forward bindings. A
  // shadowed prefix must not remain a usable alias for its previous namespace.
  for (const key of instanceNs.keys())
    if (key !== "" && !key.endsWith(":")) instanceNs.delete(key);
  const bindings = [...instanceNs].filter(
    ([prefix]) => prefix === "" || prefix.endsWith(":"),
  );
  for (const [prefix, uri] of bindings) instanceNs.set(uri, prefix);
  return instanceNs;
}

/** Prepare one element without altering imported bindings. New commands may
 * need a schema namespace absent from the source; add a collision-free alias
 * only at that new element rather than normalizing every root declaration. */
function elementNamespaces(
  item: Record<string, unknown>,
  name: string,
  args: { instanceNs: Map<string, string>; ns: Map<string, string> },
) {
  let instanceNs = scopedNamespaces(item, args.instanceNs);
  const colon = name.indexOf(":");
  const canonical = colon < 0 ? "" : name.slice(0, colon + 1);
  const uri = args.ns.get(canonical);
  if (uri && instanceNs.get(uri) === undefined) {
    const stem = canonical.slice(0, -1) || (instanceNs.has("") ? "bpmn" : "");
    let prefix = stem;
    for (let index = 1; instanceNs.has(prefix ? `${prefix}:` : ""); index++)
      prefix = `${stem || "bpmn"}${index}`;
    item[prefix ? `@_xmlns:${prefix}` : "@_xmlns"] = uri;
    instanceNs = scopedNamespaces(item, args.instanceNs);
  }
  return instanceNs;
}

export function build(args: {
  json: any;
  ns: Map<string, string>;
  instanceNs: Map<string, string>;
  elements: Elements;
  meta: Meta;
  metaType: MetaType | undefined;
  declaredElementsOrder: string[];
  indent: string;
}): string {
  const { json, ns, indent, metaType } = args;
  if (typeof json !== "object" || json === null) {
    throw new Error("BPMN_INVALID_MODEL");
  }
  // Namespace declarations belong to their element's scope, not the root map.
  // Keep QName-valued attributes lexical while mapping normalized element keys.
  const instanceNs = scopedNamespaces(json, args.instanceNs);
  args = { ...args, instanceNs };

  let xml = "";

  // We want to respect a certain order here given xsd:sequence, xsd:choice, and xsd:all declarations
  const sortedJsonProps: string[] = [];
  for (const p in json) {
    sortedJsonProps.push(p);
  }

  const declaredPropOrder: string[] = [];
  for (const p in metaType ?? {}) {
    declaredPropOrder.push(p);
  }

  sortedJsonProps.sort(
    (a, b) => declaredPropOrder.indexOf(a) - declaredPropOrder.indexOf(b),
  );

  // After the correct order is established, we can iterate over the `json` object.
  for (const __unsafeJsonPropName of sortedJsonProps) {
    const jsonPropName = applyEntities(__unsafeJsonPropName);
    const jsonPropValue = json[jsonPropName];

    // attributes are processed individually.
    if (jsonPropName[0] === "@") {
      continue;
    }
    // ignore this, as we won't make it part of the final XML.
    else if (jsonPropName === "__$$element" || jsonPropName === "__$$xml") {
      continue;
    }
    // ignore this. text content is treated inside the "array" and "nested element" sections.
    else if (jsonPropName === "__$$text") {
      continue;
    }
    // pi tag
    else if (jsonPropName[0] === "?") {
      xml =
        `${indent}<${jsonPropName}${buildAttrs(jsonPropValue, args).attrs} ?>\n` +
        xml; // PI Tags should always go at the top of the XML
    }
    // empty tag
    else if (
      jsonPropValue === undefined ||
      jsonPropValue === null ||
      jsonPropValue === ""
    ) {
      const elementName = applyInstanceNs({
        ns,
        instanceNs,
        propName: jsonPropName,
      });
      xml += `${indent}<${elementName} />\n`;
    }
    // primitive element
    else if (typeof jsonPropValue !== "object") {
      const elementName = applyInstanceNs({
        ns,
        instanceNs,
        propName: jsonPropName,
      });
      xml += `${indent}<${elementName}>${applyEntities(jsonPropValue)}</${elementName}>\n`;
    }
    // array
    else if (Array.isArray(jsonPropValue)) {
      // Substitutions occupy the same schema particle. Keep source/command order;
      // sorting by XSD declaration order is an engine convention, not BPMN semantics.
      for (const item of jsonPropValue) {
        if (typeof item?.__$$xml === "string") {
          xml += `${indent}${item.__$$xml}\n`;
          continue;
        }
        const itemArgs = {
          ...args,
          instanceNs: elementNamespaces(
            item,
            item?.["__$$element"] ?? jsonPropName,
            args,
          ),
        };
        const elementName = applyInstanceNs({
          ...itemArgs,
          propName: item?.["__$$element"] ?? jsonPropName,
        });
        const { attrs, isEmpty, hasText } = buildAttrs(item, itemArgs);
        xml += `${indent}<${elementName}${attrs}`;
        if (isEmpty) {
          xml += " />\n";
        } else if (typeof item === "object") {
          if (hasText) {
            xml += `>${applyEntities(item["__$$text"])}</${elementName}>\n`;
          } else {
            xml += `>\n${build({
              ...itemArgs,
              json: item,
              metaType: getPropMetaTypeForJsonObj({
                args,
                jsonObj: item,
                jsonPropName,
                metaType,
              }),
              indent: `${indent}  `,
            })}`;
            xml += `${indent}</${elementName}>\n`;
          }
        }
      }
    }
    // nested element
    else {
      const item = jsonPropValue;
      if (typeof item.__$$xml === "string") {
        xml += `${indent}${item.__$$xml}\n`;
        continue;
      }
      const itemArgs = {
        ...args,
        instanceNs: elementNamespaces(
          item,
          item["__$$element"] ?? jsonPropName,
          args,
        ),
      };
      const elementName = applyInstanceNs({
        ...itemArgs,
        propName: item["__$$element"] ?? jsonPropName,
      });
      const { attrs, isEmpty, hasText } = buildAttrs(item, itemArgs);
      xml += `${indent}<${elementName}${attrs}`;
      if (isEmpty) {
        xml += " />\n";
      } else if (typeof item === "object") {
        if (hasText) {
          xml += `>${applyEntities(item["__$$text"])}</${elementName}>\n`;
        } else {
          xml += `>\n${build({
            ...itemArgs,
            json: item,
            metaType: getPropMetaTypeForJsonObj({
              args,
              jsonObj: item,
              jsonPropName,
              metaType,
            }),
            indent: `${indent}  `,
          })}`;
          xml += `${indent}</${elementName}>\n`;
        }
      }
    }
  }

  return xml;
}

// To know what the metaType of `jsonObj` is, we first need to check if it is mapped as an element.
// If it is, we use the type mapped to elements with its `__$$element` attribute or `jsonPropName`
// If it's not, we proceed normally with traversing the metaType tree.
function getPropMetaTypeForJsonObj({
  args: { elements, meta },
  jsonObj,
  jsonPropName,
  metaType,
}: {
  args: {
    elements: Elements;
    meta: Meta;
  };
  jsonObj: any;
  jsonPropName: string;
  metaType: MetaType | undefined;
}): MetaType | undefined {
  return meta[
    elements[jsonObj?.["__$$element"] ?? jsonPropName] ??
      metaType?.[jsonPropName]?.type ??
      ""
  ];
}

function applyInstanceNs({
  propName,
  ns,
  instanceNs,
}: {
  ns: Map<string, string>;
  instanceNs: Map<string, string>;
  propName: string;
}) {
  const s = propName.split(":");

  if (s.length === 1) {
    const newPropertyNs = instanceNs.get(ns.get("")!) ?? "";
    return `${newPropertyNs}${propName}`;
  } else if (s.length === 2) {
    const propertyNs = `${s[0]}:`;
    const newPropertyNs =
      instanceNs.get(ns.get(propertyNs) ?? "obviously non-existent key") ??
      propertyNs;
    return `${newPropertyNs}${s[1]}`;
  } else {
    throw new Error("BPMN_INVALID_QNAME");
  }
}

//////////////////
/// EXTENSIONS ///
//////////////////

export type NamespacedProperty<P extends string, K> = K extends string
  ? K extends
      `@_${string}` | `${string}:${string}` | "__$$text" | "__$$element" // @_xxx are attributes, xxx:xxx are elements referencing other namespaces; __$$element and __$$text are special properties with no domain-related characteristcs. Therefore, not namespace-able.
    ? K
    : `${P}:${K}`
  : never;

export type Namespaced<P extends string, T> = {
  [K in keyof T as NamespacedProperty<P, K>]: NonNullable<T[K]> extends Array<
    infer R
  >
    ? Array<Namespaced<P, R>>
    : T[K];
};

/**
 * Receives a base meta and an array of prefix-meta pair. Types described by the extension metas have their properties prefixed by their corresponding prefix.
 *
 * Modifies `base` to include properties on `extensionMetasByPrefix`.
 */
export function mergeMetas(
  base: Meta,
  extensionMetasByPrefix: [string, Meta][],
): void {
  const prefixedMetas = extensionMetasByPrefix.reduce((acc, [k, m]) => {
    return {
      ...acc,
      ...Object.keys(m).reduce((macc, t) => {
        macc[t] = Object.keys(m[t]).reduce((tacc, p) => {
          if (p.includes(":") || p.startsWith("@_")) {
            tacc[p] = m[t][p];
          } else {
            tacc[`${k}${p}`] = m[t][p];
          }
          return tacc;
        }, {} as any);
        return macc;
      }, {} as any),
    };
  }, {});

  Object.entries(prefixedMetas).forEach(([k, v]) => {
    base[k] = v as any;
  });
}
