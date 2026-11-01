function decodedEscape(character: string) {
  if (character === "b") return "\b";
  if (character === "f") return "\f";
  if (character === "n") return "\n";
  if (character === "r") return "\r";
  if (character === "t") return "\t";
  if (character === "v") return "\v";
  if (character === "0") return "\0";
  return character;
}

export function decodeMermaidLangiumString(value: string) {
  const inner = value.slice(1, -1);
  let result = "";
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === "\\" && index + 1 < inner.length) {
      result += decodedEscape(inner[index + 1]);
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

export function encodeMermaidLangiumString(value: string) {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\v", "\\v")
    .replaceAll("\0", "\\0")
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}
