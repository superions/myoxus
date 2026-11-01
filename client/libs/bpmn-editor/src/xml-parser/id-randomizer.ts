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
// Modified by Myoxus: local imports, owned-ID remapping, QName scope and payload-free errors.

import { type Elements, type Meta, type MetaType } from ".";
import {
  buildXmlQName,
  parseXmlQName,
  isXmlNCName,
  isBindableXmlNamespace,
} from "./q-names";

export type XmlParserTsIdRandomizerUpdater = (args: { newId: string }) => void;
export type XmlParserTsIdRandomizerMatcher<M extends Meta> = (args: {
  parentJson: any;
  attr: string;
  metaTypeName: keyof M;
  metaType: MetaType;
}) => [string, XmlParserTsIdRandomizerUpdater] | undefined;

/**
 * Retained schema-driven ID remapper for a private, mutable model fragment.
 * `ack` gathers writes; `randomize` applies them. Only declarations inside the
 * acknowledged fragment own replacement IDs; external references stay intact.
 * Opaque extension trees are never traversed as schema-owned content.
 */
export class XmlParserTsIdRandomizer<M extends Meta> {
  private readonly updaters = new Map<
    string,
    XmlParserTsIdRandomizerUpdater[]
  >();
  private readonly toAttribute = new Map<
    string,
    XmlParserTsIdRandomizerUpdater
  >();
  private readonly declaredIds = new Set<string>();
  private readonly attributed = new Map<string, string>();
  private readonly randomized = new Map<string, string>();
  private readonly scopes = new WeakMap<object, ReadonlyMap<string, string>>();
  private readonly localQNames: {
    owner: Record<string, any>;
    value: string;
    write: (next: string) => void;
  }[] = [];

  constructor(
    private readonly args: {
      meta: M;
      elements: Elements;
      newIdGenerator: () => string;
      matchers?: XmlParserTsIdRandomizerMatcher<M>[];
      /** Resolves lexical QName prefixes at the owning definitions boundary. */
      namespaces?: ReadonlyMap<string, string>;
      localNamespace?: string;
      /** Domain namespace whose unprefixed reference tokens denote owned IDs. */
      unprefixedReferenceNamespace?: string;
      /** Concrete domain fields whose QName names an external type/implementation,
       * not a declaration ID even when its namespace happens to be local. */
      nonIdentityQNames?: ReadonlySet<string>;
      /** A domain may resolve a schema-declared polymorphic value in its actual
       * namespace scope. This changes traversal, never the source type spelling. */
      resolveType?: (context: {
        declaredType: string;
        value: Readonly<Record<string, unknown>>;
        namespaces: ReadonlyMap<string, string>;
      }) => string | undefined;
    },
  ) {}

  public getOriginalIds(): Set<string> {
    return new Set(this.declaredIds);
  }

  /** Conservative reference check over acknowledged schema fields, excluding the declaration itself. */
  public isReferenced(id: string): boolean {
    return this.referenceCount(id) > 0;
  }

  /** Count owned schema-reference occurrences, excluding the declaration. A
   * deletion command can prove it has explicitly handled every consumer before
   * it writes; same-spelled external QNames do not participate in this count. */
  public referenceCount(id: string): number {
    return (
      (this.updaters.get(id)?.length ?? 0) - (this.declaredIds.has(id) ? 1 : 0)
    );
  }

  /** Resolve only owned identities in this object's lexical scope. External
   * QNames deliberately do not fall back to a same-spelled local declaration. */
  public resolveReference(
    owner: object,
    value: string | undefined,
  ): string | undefined {
    if (!value) return undefined;
    const qname = parseXmlQName(value);
    const scope = this.scopeOf(owner);
    return this.isLocal(qname.prefix, scope) &&
      this.declaredIds.has(qname.localPart)
      ? qname.localPart
      : undefined;
  }

  /** Expand an XML type/implementation QName without treating it as a BPMN ID.
   * A prefixed name must have a binding at the field owner, even for external
   * types. Bare names keep the owner's default namespace (or no namespace). */
  public expandQName(owner: object, value: string) {
    const qname = parseXmlQName(value);
    const namespace = this.scopeOf(owner).get(qname.prefix ?? "");
    if (qname.prefix && !namespace) throw new Error("BPMN_UNKNOWN_NAMESPACE");
    return { namespace, localPart: qname.localPart };
  }

  /** Bind a known external namespace at one mutable XML field owner. This is
   * deliberately separate from selecting a declared BPMN identity. */
  public qnameFor(
    owner: Record<string, any>,
    namespace: string,
    localPart: string,
    preferredPrefix: string,
  ) {
    if (
      parseXmlQName(localPart).prefix ||
      parseXmlQName(preferredPrefix).prefix ||
      !namespace
    )
      throw new Error("BPMN_INVALID_QNAME");
    const scope = this.scopeOf(owner);
    const binding = [...scope].find(([, uri]) => uri === namespace)?.[0];
    if (binding !== undefined)
      return binding ? `${binding}:${localPart}` : localPart;
    let prefix = preferredPrefix;
    for (let suffix = 1; scope.has(prefix); suffix++)
      prefix = `${preferredPrefix}${suffix}`;
    owner[`@_xmlns:${prefix}`] = namespace;
    this.scopes.set(owner, new Map(scope).set(prefix, namespace));
    return `${prefix}:${localPart}`;
  }

  /** Terminal step of a target-namespace transaction. Only schema identity refs
   * gathered in the original local namespace move; external XML types/imports
   * and original bindings remain untouched. Bare MODEL/no-default ID tokens
   * retain their existing BPMN meaning. Rebuild the index after this command. */
  public retargetLocalReferences(namespace: string) {
    if (!isBindableXmlNamespace(namespace))
      throw new Error("BPMN_UNKNOWN_NAMESPACE");
    if (namespace === this.args.localNamespace) return this;
    for (const reference of this.localQNames) {
      const qname = parseXmlQName(reference.value);
      if (!this.declaredIds.has(qname.localPart))
        throw new Error("BPMN_DANGLING_REFERENCE");
    }
    for (const reference of this.localQNames) {
      const qname = parseXmlQName(reference.value);
      const binding = this.scopeOf(reference.owner).get(qname.prefix ?? "");
      if (
        !qname.prefix &&
        (binding === undefined ||
          binding === "" ||
          binding === this.args.unprefixedReferenceNamespace)
      )
        continue;
      reference.write(
        this.qnameFor(reference.owner, namespace, qname.localPart, "tns"),
      );
    }
    return this;
  }

  /** Encode a selected existing ID at its actual reference owner. An unchanged
   * selection keeps its exact lexical spelling. Under a foreign default scope,
   * bind the target namespace locally instead of writing a misleading bare ID.
   * Call only inside the caller's model transaction; this may add one binding. */
  public referenceFor(
    owner: Record<string, any>,
    id: string | undefined,
    previous?: string,
  ): string | undefined {
    if (id === undefined) return undefined;
    if (!this.declaredIds.has(id)) throw new Error("BPMN_DANGLING_REFERENCE");
    if (previous && this.resolveReference(owner, previous) === id)
      return previous;
    const scope = this.scopeOf(owner);
    if (previous) {
      const qname = parseXmlQName(previous);
      if (this.isLocal(qname.prefix, scope))
        return buildXmlQName({ ...qname, localPart: id });
    }
    if (this.isLocal(undefined, scope)) return id;
    const namespace = this.args.localNamespace;
    if (!namespace) throw new Error("BPMN_UNSUPPORTED_REFERENCE");
    return this.qnameFor(owner, namespace, id, "tns");
  }

  private scopeOf(owner: object) {
    const scope = this.scopes.get(owner);
    if (!scope) throw new Error("BPMN_INVALID_REFERENCE_OWNER");
    return scope;
  }

  /** A detached fragment root loses its ancestors. Copy their effective
   * bindings onto that root without changing the original XML or rewriting
   * external names. Descendant shadowing remains attached to its own owner. */
  public namespaceDeclarationsFor(owner: object): Record<string, string> {
    return Object.fromEntries(
      [...this.scopeOf(owner)].map(([prefix, uri]) => [
        prefix ? `@_xmlns:${prefix}` : "@_xmlns",
        uri,
      ]),
    );
  }

  private isLocal(
    prefix: string | undefined,
    scope: ReadonlyMap<string, string> | undefined,
  ) {
    const binding = scope?.get(prefix ?? "");
    // xmlns="" undeclares the default namespace; it is not a foreign binding.
    return prefix
      ? binding !== undefined && binding === this.args.localNamespace
      : binding === undefined ||
          binding === "" ||
          binding === this.args.localNamespace ||
          binding === this.args.unprefixedReferenceNamespace;
  }

  public ack<X extends keyof M>({
    json,
    parentJson,
    type,
    attr,
    __$$element,
    arrayIndex,
    path,
    namespaces = this.args.namespaces,
  }: {
    json: any;
    type: X;
    attr: keyof M[X];
    arrayIndex?: number;
    __$$element?: string;
    parentJson?: any;
    path?: string;
    namespaces?: ReadonlyMap<string, string>;
  }): XmlParserTsIdRandomizer<M> {
    const rootMetaProp = this.args.meta[type]?.[attr as string];
    if (!rootMetaProp) throw new Error("BPMN_INVALID_ID_METADATA");
    if (json === undefined && rootMetaProp.xsdType !== "xsd:ID") return this;
    if (
      parentJson &&
      typeof parentJson === "object" &&
      !this.scopes.has(parentJson)
    )
      this.scopes.set(parentJson, new Map(namespaces));
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const scope = new Map(namespaces);
      for (const [name, value] of Object.entries(json)) {
        if (name === "@_xmlns" && typeof value === "string")
          scope.set("", value);
        else if (name.startsWith("@_xmlns:") && typeof value === "string")
          scope.set(name.slice(8), value);
      }
      namespaces = scope;
      this.scopes.set(json, scope);
    }

    const declaredType =
      this.args.elements[__$$element ?? json?.__$$element] ?? rootMetaProp.type;
    const resolvedType =
      json && typeof json === "object" && !Array.isArray(json)
        ? (this.args.resolveType?.({
            declaredType,
            value: json,
            namespaces: namespaces ?? new Map(),
          }) ?? declaredType)
        : declaredType;

    if (rootMetaProp.isArray && arrayIndex === undefined) {
      if (!Array.isArray(json)) throw new Error("BPMN_INVALID_ID_FRAGMENT");
      for (let index = 0; index < json.length; index++) {
        this.ack({
          json: json[index],
          parentJson: json,
          attr,
          type,
          arrayIndex: index,
          __$$element,
          path:
            path === undefined
              ? `${String(attr)}.${index}`
              : `${path}.${index}`,
          namespaces,
        });
      }
    } else if (this.args.meta[resolvedType]) {
      for (const metaPropName in this.args.meta[resolvedType]) {
        this.ack({
          json: json[metaPropName],
          parentJson: json,
          attr: metaPropName,
          type: resolvedType,
          path:
            path === undefined
              ? `${String(attr)}.${metaPropName}`
              : `${path}.${metaPropName}`,
          namespaces,
        });
      }
    } else {
      const accessor = arrayIndex ?? attr;
      const textElement =
        typeof json === "object" && json !== null && "__$$text" in json;
      const value = textElement ? json.__$$text : json;
      const write = (next: string) => {
        // Reference elements can carry namespace declarations/attributes too.
        // Replacing the whole object would silently discard that source data.
        parentJson[accessor] = textElement ? { ...json, __$$text: next } : next;
      };

      if (
        rootMetaProp.xsdType === "xsd:ID" ||
        rootMetaProp.xsdType === "xsd:IDREF"
      ) {
        const update = ({ newId }: { newId: string }) => write(newId);
        if (rootMetaProp.xsdType === "xsd:ID" && value === undefined) {
          this.toAttribute.set(path ?? String(attr), update);
        } else if (typeof value === "string") {
          if (rootMetaProp.xsdType === "xsd:ID") {
            if (!value || this.declaredIds.has(value))
              throw new Error("BPMN_DUPLICATE_ID");
            this.declaredIds.add(value);
          }
          this.addUpdater(value, update);
        }
      } else if (
        rootMetaProp.xsdType === "xsd:QName" &&
        typeof value === "string"
      ) {
        if (
          this.args.nonIdentityQNames?.has(
            `${rootMetaProp.fromType}.${String(attr)}`,
          )
        )
          return this;
        const qname = parseXmlQName(value);
        if (this.isLocal(qname.prefix, namespaces)) {
          this.localQNames.push({
            owner: textElement ? json : parentJson,
            value,
            write,
          });
          this.addUpdater(qname.localPart, ({ newId }) =>
            write(buildXmlQName({ ...qname, localPart: newId })),
          );
        }
      } else {
        for (const match of this.args.matchers ?? []) {
          const result = match({
            metaTypeName: type,
            metaType: this.args.meta[type],
            attr: String(attr),
            parentJson,
          });
          if (result) this.addUpdater(...result);
        }
      }
    }
    return this;
  }

  private addUpdater(id: string, updater: XmlParserTsIdRandomizerUpdater) {
    this.updaters.set(id, [...(this.updaters.get(id) ?? []), updater]);
  }

  /** Missing IDs are assigned; replacing existing owned IDs is explicitly opt-in. */
  public randomize(args?: { skipAlreadyAttributedIds: boolean }) {
    for (const [path, update] of this.toAttribute) {
      const newId = this.args.newIdGenerator();
      this.attributed.set(path, newId);
      update({ newId });
    }
    if (args?.skipAlreadyAttributedIds === false) {
      for (const id of this.declaredIds) {
        const newId = this.args.newIdGenerator();
        this.randomized.set(id, newId);
        for (const update of this.updaters.get(id) ?? []) update({ newId });
      }
    }
    return this;
  }

  public getAttributed() {
    return this.attributed;
  }

  /** Renames one owned declaration and its schema references without touching unrelated IDs. */
  public rename(id: string, newId: string) {
    if (
      !isXmlNCName(newId) ||
      !this.declaredIds.has(id) ||
      (newId !== id && this.declaredIds.has(newId))
    ) {
      throw new Error("BPMN_INVALID_ID_RENAME");
    }
    for (const update of this.updaters.get(id) ?? []) update({ newId });
    return this;
  }

  public getRandomized() {
    return this.randomized;
  }
}
