// SPDX-License-Identifier: AGPL-3.0-or-later
import { registerAIEditorEffects } from "@myoxus/core/editor/ai/effects/editor";
import { editorEffects } from "@myoxus/core/editor/editors";
editorEffects();
registerAIEditorEffects();
export { VirgultumEditor as default } from "./virgultum-editor";
export { resumePageIntent } from "./page-handoff";
