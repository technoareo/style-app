import { iou } from "./geometry";
import type { Box } from "./types";

export type MatchPair = { gold: number; pred: number; iou: number };

/**
 * Hungarian algorithm (minimum cost, square matrix, O(n^3)). The inputs here are
 * a handful of boxes per photo, so clarity beats speed.
 */
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j] !== 0) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

/**
 * Deterministic ONE-TO-ONE maximum matching between gold and predicted boxes.
 * An edge exists when IoU >= threshold (class-agnostic: geometry only). Among
 * all matchings the one with the most pairs wins, and among those the one with
 * the largest total IoU. A greedy "best IoU first" pass can match fewer pairs;
 * the tests keep a counterexample.
 */
export function maximumMatching(
  gold: readonly Box[],
  pred: readonly Box[],
  threshold: number,
): MatchPair[] {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
    throw new RangeError("IoU threshold must be a number above 0 and at most 1.");
  const n = gold.length;
  const m = pred.length;
  if (n === 0 || m === 0) return [];
  const size = Math.max(n, m);
  // One more matched pair must always outweigh any IoU gain (total IoU <= min(n, m)).
  const bonus = Math.min(n, m) + 1;
  const edge: number[][] = [];
  const cost: number[][] = [];
  for (let i = 0; i < size; i++) {
    edge.push(new Array<number>(size).fill(0));
    cost.push(new Array<number>(size).fill(0));
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const overlap = iou(gold[i], pred[j]);
      if (overlap >= threshold) {
        edge[i][j] = overlap;
        cost[i][j] = -(bonus + overlap);
      }
    }
  }
  const assignment = minCostAssignment(cost);
  const pairs: MatchPair[] = [];
  for (let i = 0; i < n; i++) {
    const j = assignment[i];
    if (j >= 0 && j < m && edge[i][j] >= threshold) pairs.push({ gold: i, pred: j, iou: edge[i][j] });
  }
  return pairs;
}
