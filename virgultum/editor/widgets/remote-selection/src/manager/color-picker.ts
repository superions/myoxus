class RandomPicker<T> {
  private _copyArray: T[];

  private readonly _originalArray: T[];

  constructor(array: T[]) {
    this._originalArray = [...array];
    this._copyArray = [...array];
  }

  private randomIndex(max: number): number {
    return Math.floor(Math.random() * max);
  }

  pick(): T {
    if (this._copyArray.length === 0) {
      this._copyArray = [...this._originalArray];
    }

    const index = this.randomIndex(this._copyArray.length);
    const item = this._copyArray[index];
    this._copyArray.splice(index, 1);
    return item;
  }
}

export const multiPlayersColor = new RandomPicker([
  "var(--myoxus-multi-players-purple)",
  "var(--myoxus-multi-players-magenta)",
  "var(--myoxus-multi-players-red)",
  "var(--myoxus-multi-players-orange)",
  "var(--myoxus-multi-players-green)",
  "var(--myoxus-multi-players-blue)",
  "var(--myoxus-text-highlight-foreground-yellow)",
  "var(--myoxus-text-highlight-foreground-teal)",
]);

export function vividRemoteColor(color: string): string {
  if (color === "var(--myoxus-multi-players-grey)")
    return "var(--myoxus-text-highlight-foreground-teal)";
  if (color === "var(--myoxus-multi-players-brown)")
    return "var(--myoxus-text-highlight-foreground-yellow)";
  return color;
}

/** Match the existing session hue to the editor's text-marker palette. */
export function textMarkerColor(color: string): string {
  if (color === "var(--myoxus-multi-players-magenta)") return color;
  const tone = color.match(
    /^var\(--myoxus-(?:multi-players|text-highlight-foreground)-(purple|red|orange|green|blue|yellow|teal)\)$/,
  )?.[1];
  return tone ? `var(--myoxus-text-highlight-foreground-${tone})` : color;
}
