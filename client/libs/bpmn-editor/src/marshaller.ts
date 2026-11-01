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
// Modified by Myoxus: local parser and official BPMN 2.0.2 schemas; no engine extension schema.
import { type Document } from "@xmldom/xmldom";
import {
  type Meta,
  type XmlParserTs,
  domParser,
  getInstanceNs,
  getParser,
} from "./xml-parser";
import {
  subs as bpmn20subs,
  elements as bpmn20elements,
  meta as bpmn20meta,
  root as bpmn20root,
  ns as bpmn20ns,
} from "./schemas/bpmn-2_0/ts-gen/meta";
import type { BPMN20__tDefinitions } from "./schemas/bpmn-2_0/ts-gen/types";

export type BpmnMarshaller<V extends BpmnMarshallerVersions = "latest"> =
  InternalBpmnMarshaller<V> & {
    originalVersion: BpmnVersions;
    isLatest: boolean;
  };

export type InternalBpmnMarshaller<
  V extends BpmnMarshallerVersions = "latest",
> = V extends "2.0"
  ? BpmnMarshaller20
  : V extends "latest"
    ? BpmnLatestMarshaller
    : never;

export type BpmnMarshallerBase = {
  instanceNs: Map<string, string>;
  root: { element: string; type: string };
  meta: Meta;
};

export type AllBpmnMarshallers = BpmnMarshaller20;

export type BpmnVersions = AllBpmnMarshallers["version"];
export type BpmnMarshallerVersions = AllBpmnMarshallers["version"] | "latest";

export type BpmnMarshaller20 = BpmnMarshallerBase & {
  parser: { parse(): { definitions: BPMN20__tDefinitions } };
  builder: { build(json: { definitions: BPMN20__tDefinitions }): string };
  version: "2.0";
};

export const BPMN_PARSERS: Record<BpmnVersions, XmlParserTs<any>> = {
  "2.0": getParser<{ [bpmn20root.element]: BPMN20__tDefinitions }>({
    ns: bpmn20ns,
    meta: bpmn20meta,
    subs: bpmn20subs,
    elements: bpmn20elements,
    root: bpmn20root,
  }),
};

export const BPMN_VERSIONS_TIMELINE: BpmnVersions[] = ["2.0"];
export const BPMN_LATEST_VERSION = "2.0" as const;
export type BpmnLatestMarshaller = BpmnMarshaller20;
export type BpmnLatestModel = { [bpmn20root.element]: BPMN20__tDefinitions };

export type BpmnMarshallerOpts<V extends BpmnMarshallerVersions> = {
  upgradeTo?: V;
};

/**
 * Parse and write the retained KIE controlled model using official BPMN 2.0.2 metadata.
 * Parsing does not edit the input. Building serializes a changed model, not the
 * original bytes; callers retain the exact source separately for download.
 * Unknown XML subtrees are opaque to mutations and retain their XML structure.
 * This low-level API is not an editable-profile or execution-validity check.
 */
export function getMarshaller<V extends BpmnMarshallerVersions = "latest">(
  xml: string,
  opts?: BpmnMarshallerOpts<V>,
): BpmnMarshaller<V> {
  const originalDomdoc = domParser.getDomDocument(xml);
  const originalInstanceNs = getInstanceNs(originalDomdoc);

  const originalMarshaller = getMarshallerForFixedVersion(
    originalDomdoc,
    originalInstanceNs,
  );

  // There is one standard version; "latest" never selects an engine dialect.
  const targetVersion: BpmnVersions =
    opts?.upgradeTo === "latest"
      ? BPMN_LATEST_VERSION
      : (opts?.upgradeTo ?? originalMarshaller.version);

  // If the XML is already on the latest version, we don't do anything else and just return the marshaller.
  if (originalMarshaller.version === targetVersion) {
    return {
      ...(originalMarshaller as InternalBpmnMarshaller<V>),
      originalVersion: originalMarshaller.version,
      isLatest: true,
    };
  } else {
    throw new Error(
      `BPMN MARSHALLER: Cannot build BPMN ${targetVersion} marshaller from a model that's already in version '${originalMarshaller.version}'. Downgrading BPMN models is not possible.`,
    );
  }
}

export function getBpmnVersion(instanceNs: Map<string, string>): BpmnVersions {
  // Do not remove this '!== undefined', as "" is a valid namespace on the instanceNs map, although it is a falsy value.
  if (instanceNs.get(bpmn20ns.get("")!) !== undefined) {
    return "2.0";
  }
  // None.. throw error
  else {
    throw new Error("BPMN_UNKNOWN_NAMESPACE");
  }
}

export function getMarshallerForFixedVersion(
  domdoc: Document,
  instanceNs: Map<string, string>,
): AllBpmnMarshallers {
  if (domdoc.documentElement?.localName !== "definitions") {
    throw new Error("BPMN_UNKNOWN_ROOT");
  }
  if (domdoc.documentElement.namespaceURI !== bpmn20ns.get(""))
    throw new Error("BPMN_UNKNOWN_NAMESPACE");
  const version = getBpmnVersion(instanceNs);

  switch (version) {
    case "2.0":
      return {
        instanceNs,
        version: "2.0",
        root: bpmn20root,
        meta: bpmn20meta,
        parser: {
          parse: () =>
            BPMN_PARSERS["2.0"].parse({ type: "domdoc", domdoc, instanceNs })
              .json,
        },
        builder: {
          build: (json) => BPMN_PARSERS["2.0"].build({ json, instanceNs }),
        },
      };
    default:
      throw new Error("BPMN_UNKNOWN_NAMESPACE");
  }
}
