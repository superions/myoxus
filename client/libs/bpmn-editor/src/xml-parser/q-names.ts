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

// Modified by Myoxus; retained Apache KIE source and changes are recorded in provenance.json.
// SPDX-License-Identifier: Apache-2.0

// Reference: https://www.w3.org/TR/REC-xml-names/#NT-QName

export type XmlQName = {
  type: "xml-qname";
  prefix?: string;
  localPart: string;
};

export function parseXmlQName(qName: string): XmlQName {
  const split = qName.trim().split(":");
  if (split.length > 2 || split.some((part) => !NC_NAME.test(part)))
    throw new Error("BPMN_INVALID_QNAME");

  if (split.length <= 1) {
    return { type: "xml-qname", localPart: split[0] };
  }

  return { type: "xml-qname", prefix: split[0], localPart: split[1] };
}

// XML Namespaces NCName uses the XML 1.0 NameStartChar/NameChar ranges without
// colon, not an ASCII-only UI slug. Attribute QName whitespace is collapsed for
// lookup; the source owner retains its original lexical value until an edit.
const NAME_START =
  "A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NC_NAME = new RegExp(
  `^[${NAME_START}][${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$`,
  "u",
);

/** IDs are exact NCNames; unlike QName lookup, validation does not trim them. */
export function isXmlNCName(value: string) {
  return NC_NAME.test(value);
}

/** Namespace values usable with an ordinary generated prefix. XML's two reserved
 * namespace URIs cannot be assigned to a new BPMN target alias. Relative names
 * are not rejected by a UI-only URL policy. */
export function isBindableXmlNamespace(value: string) {
  return (
    !!value &&
    !/\s/u.test(value) &&
    value !== "http://www.w3.org/XML/1998/namespace" &&
    value !== "http://www.w3.org/2000/xmlns/"
  );
}

export function buildXmlQName({ prefix, localPart }: XmlQName) {
  return prefix ? `${prefix}:${localPart}` : localPart;
}
