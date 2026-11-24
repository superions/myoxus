import { createReactComponentFromLit } from "@myoxus/lit-react";
import { DocTitle } from "@virgultum/editor/fragments/doc-title";
import React from "react";

export { DocumentViewport } from "./document-viewport";

export const LitDocTitle = createReactComponentFromLit({
  react: React,
  elementClass: DocTitle,
});
