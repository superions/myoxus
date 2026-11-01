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
  "var(--myoxus-multi-players-brown)",
  "var(--myoxus-multi-players-grey)",
]);
