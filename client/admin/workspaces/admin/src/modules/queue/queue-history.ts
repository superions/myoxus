// SPDX-License-Identifier: AGPL-3.0-or-later

export type QueueHistoryPoint = { timestamp: number; pending: number };

/** Preserve real minute spacing: no interpolation or invented zero samples. */
export function queueHistorySeries(points: readonly QueueHistoryPoint[]) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (
    !Number.isSafeInteger(first.timestamp) ||
    first.timestamp < 0 ||
    !Number.isSafeInteger(last.timestamp)
  )
    return null;
  const slots = (last.timestamp - first.timestamp) / 60_000 + 1;
  if (!Number.isInteger(slots) || slots < 2 || slots > 1441) return null;
  const data: (number | null)[] = Array.from({ length: slots }, () => null);
  let previous = -1;
  for (const point of points) {
    const slot = (point.timestamp - first.timestamp) / 60_000;
    if (
      !Number.isInteger(slot) ||
      slot <= previous ||
      slot >= slots ||
      !Number.isSafeInteger(point.pending) ||
      point.pending < 0
    ) {
      return null;
    }
    data[slot] = point.pending;
    previous = slot;
  }
  return {
    data,
    start: first.timestamp,
    end: last.timestamp,
    last: last.pending,
  };
}
