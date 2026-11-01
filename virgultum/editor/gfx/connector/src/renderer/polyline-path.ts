// SPDX-License-Identifier: AGPL-3.0-or-later

/** Round routed corners inside their protected polyline bounds. Endpoints and
 * their straight approach segments remain shared with routing and hit-testing. */
export function createRoundedPolylinePath(
  points: readonly Readonly<{ 0: number; 1: number }>[],
  radius: number,
) {
  if (points.length < 2) return "";
  let path = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1]!,
      current = points[i]!,
      next = points[i + 1]!;
    const before = Math.hypot(
      previous[0] - current[0],
      previous[1] - current[1],
    );
    const after = Math.hypot(next[0] - current[0], next[1] - current[1]);
    const size = Number.isFinite(radius)
      ? Math.max(0, Math.min(radius, before / 2, after / 2))
      : 0;
    if (!size) {
      path += `L${current[0]},${current[1]}`;
      continue;
    }
    const entry = [
      current[0] + ((previous[0] - current[0]) * size) / before,
      current[1] + ((previous[1] - current[1]) * size) / before,
    ];
    const exit = [
      current[0] + ((next[0] - current[0]) * size) / after,
      current[1] + ((next[1] - current[1]) * size) / after,
    ];
    path += `L${entry[0]},${entry[1]}Q${current[0]},${current[1]} ${exit[0]},${exit[1]}`;
  }
  return path + `L${points.at(-1)![0]},${points.at(-1)![1]}`;
}
