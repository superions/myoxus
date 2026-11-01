import { atom, type SetStateAction, useAtom } from "jotai";

import type { MyoxusEditorContainer } from "../../editor/virgultum/doc-editor";

const activeEditorContainerAtom = atom<MyoxusEditorContainer | null>(null);

export function useActiveVirgultumEditor(): [
  MyoxusEditorContainer | null,
  React.Dispatch<SetStateAction<MyoxusEditorContainer | null>>,
] {
  const [editorContainer, setEditorContainer] = useAtom(
    activeEditorContainerAtom,
  );

  return [editorContainer, setEditorContainer];
}
