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
// Modified by Myoxus: React 19/XYFlow 12 and direct Facade integration; see provenance.json.

import * as React from "react";
import { useI18n } from "@myoxus/i18n";
import { ChevronDownIcon, ChevronRightIcon } from "@myoxus/icons/react";
import { Button, Group, Text } from "@myoxus/ui-facade";

export function SectionHeader(props: {
  icon?: React.ComponentProps<typeof Button>["prefix"];
  title: string | React.ReactNode;
  expands?: boolean | "modal";
  fixed?: boolean;
  isSectionExpanded?: boolean;
  toogleSectionExpanded?: () => void;
  action?: React.ReactNode;
  locale: string;
}) {
  const t = useI18n();

  return (
    <Group>
      {props.expands ? (
        <Button
          variant="plain"
          tooltip={props.isSectionExpanded ? t.Collapse() : t.Expand()}
          aria-expanded={
            props.expands === true ? props.isSectionExpanded : undefined
          }
          aria-haspopup={props.expands === "modal" ? "dialog" : undefined}
          onClick={props.toogleSectionExpanded}
          prefix={props.icon}
          suffix={
            props.expands === true ? (
              props.isSectionExpanded ? (
                <ChevronDownIcon />
              ) : (
                <ChevronRightIcon />
              )
            ) : undefined
          }
        >
          {props.title}
        </Button>
      ) : (
        <>
          {props.icon}
          <Text truncate>{props.title}</Text>
        </>
      )}
      {props.action}
    </Group>
  );
}
