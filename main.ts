// Sokoban solver: push-optimal A* over pushes, one room at a time.
//
// A generated level is a hallway with rooms off it; a box pushed out of a
// room can never come back, so each room is an independent problem and the
// level's optimum is the sum of the rooms' optima. For every room we run an
// A* search over pushes (a state is the boxes plus the player's reachable
// region), with an admissible heuristic — the cheapest assignment of boxes to
// goals by walking distance — and two deadlock prunes: a box on a square
// from which no push can ever reach a goal, and a frozen 2x2 block. The
// first solved state A* pops is push-optimal, so a level solved room by
// room takes exactly P* pushes. Pure work, no clock, no randomness: the
// same level always yields the same moves.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// [dx, dy, walk letter, push letter], fixed order everywhere so ties break alike.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares from which a box alone can still be pushed onto some goal: pull
// backwards from the goals over open floor (a pull needs the square behind
// the box, and the square behind that, both open).
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (wall[y] === 0 && wall[y - d] === 0 && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Walking distance from every square to each goal, over walls alone.
function goalDistances(wall: Uint8Array, goals: number[], w: number): Int32Array[] {
  return goals.map((g) => {
    const dist = new Int32Array(wall.length).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (wall[q] === 0 && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

// The squares the player reaches from `from` around walls and `occ` boxes,
// marked in `seen` with `stamp`; returns the lowest square reached.
function reach(
  wall: Uint8Array,
  occ: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
  w: number,
): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block: four
// squares of walls and boxes, with a box among them off its goal.
function frozenBlock(
  wall: Uint8Array,
  occ: Uint8Array,
  goal: Uint8Array,
  t: number,
  w: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

// The shortest walk from `from` to `to` around walls and boxes, lower-case
// letters, first direction first on ties.
function walkTo(
  wall: Uint8Array,
  occ: Uint8Array,
  from: number,
  to: number,
  w: number,
): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occ[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
  player: number;
}

// Push-optimal A* over pushes for one sub-problem: `wall` already holds the
// other rooms' boxes as walls. A state is the sorted boxes plus the lowest
// square of the player's reachable region. Returns null past `maxExpand`
// expansions or when no solution exists.
function pushSearch(
  w: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  maxExpand: number,
): SearchResult | null {
  const size = wall.length;
  const n = goals.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w);
  for (const b of boxes0) if (!live[b]) return null;
  const dists = goalDistances(wall, goals, w);

  // Admissible heuristic: the cheapest one-to-one assignment of boxes to
  // goals by walking distance (each push moves one box one square, so the
  // assignment cost can drop by at most 1 a push). Few boxes: try every
  // permutation; many: each box's nearest goal (still a lower bound).
  const heuristic = (boxes: number[]): number => {
    if (n <= 5) {
      const perm = goals.map((_, i) => i);
      let best = Infinity;
      const rec = (k: number, acc: number): void => {
        if (acc >= best) return;
        if (k === n) {
          best = acc;
          return;
        }
        for (let i = k; i < n; i++) {
          [perm[k], perm[i]] = [perm[i]!, perm[k]!];
          const d = dists[perm[k]!]![boxes[k]!]!;
          if (d >= 0) rec(k + 1, acc + d);
          [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        }
      };
      rec(0, 0);
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const d of dists) if (d[b]! >= 0 && d[b]! < m) m = d[b]!;
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Numeric state key while it stays exact (size ** (n + 1) < 2 ** 53),
  // else a string key.
  const numeric = (n + 1) * Math.log2(size) < 52;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (numeric) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return low + '|' + boxes.join(',');
  };

  const boxesArr: number[][] = [boxes0.slice()];
  const playerArr: number[] = [player0];
  const gArr: number[] = [0];
  const parentArr: number[] = [-1];
  const pushFromArr: number[] = [-1];
  const pushToArr: number[] = [-1];
  const pushDirArr: number[] = [-1];
  const closed = new Map<number | string, number>();

  for (const b of boxes0) occ[b] = 1;
  const low0 = reach(wall, occ, player0, seen, ++stamp, stack, w);
  for (const b of boxes0) occ[b] = 0;
  closed.set(keyOf(boxes0, low0), 0);

  // Heap of [f, h, seq, state, g]; ties by h, then insertion order.
  const heap: [number, number, number, number, number][] = [];
  let seq = 0;
  const hLess = (
    a: [number, number, number, number, number],
    b: [number, number, number, number, number],
  ): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!hLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && hLess(heap[c + 1]!, heap[c]!)) c++;
        if (!hLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(boxes0);
  if (h0 === Infinity) return null;
  heapPush([h0, h0, seq++, 0, 0]);
  if (solved(boxes0)) return { pushes: 0, moves: '', player: player0 };

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s, g] = heapPop();
    if (gArr[s] !== g) continue;
    const boxes = boxesArr[s]!;
    if (solved(boxes)) {
      // Rebuild the moves: walk to each push's square, then push.
      const path: number[] = [];
      for (let t = s; t > 0; t = parentArr[t]!) path.push(t);
      path.reverse();
      let moves = '';
      let player = player0;
      let cur = boxes0.slice();
      for (const t of path) {
        const from = pushFromArr[t]!;
        const to = pushToArr[t]!;
        const di = pushDirArr[t]!;
        const [dx, dy, , letter] = DIRS[di]!;
        for (const b of cur) occ[b] = 1;
        moves += walkTo(wall, occ, player, from - (dy * w + dx), w);
        for (const b of cur) occ[b] = 0;
        moves += letter;
        player = from;
        const next = cur.slice();
        next[next.indexOf(from)] = to;
        next.sort((a, b) => a - b);
        cur = next;
      }
      return { pushes: path.length, moves, player };
    }
    if (expanded >= maxExpand) return null;
    expanded++;
    for (const b of boxes) occ[b] = 1;
    const here = ++stamp;
    reach(wall, occ, playerArr[s]!, seen, here, stack, w);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const stand = b - d;
        const t = b + d;
        if (seen[stand] !== here || wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(wall, occ, goal, t, w);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          const low = reach(wall, occ, b, mark, ++stamp, stack, w);
          key = keyOf(next, low);
          h = heuristic(next);
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || h === Infinity) continue;
        const old = closed.get(key);
        if (old !== undefined && old <= g + 1) continue;
        closed.set(key, g + 1);
        const ns = boxesArr.length;
        boxesArr.push(next!);
        playerArr.push(b);
        gArr.push(g + 1);
        parentArr.push(s);
        pushFromArr.push(b);
        pushToArr.push(t);
        pushDirArr.push(di);
        heapPush([g + 1 + h, h, seq++, ns, g + 1]);
      }
    }
    for (const b of boxes) occ[b] = 0;
  }
  return null;
}

interface Room {
  boxes: number[];
  goals: number[];
}

// Split the level into rooms: cut the hallway row's dead squares (a box
// there reaches no goal) out of the floor; each remaining part holding boxes
// is a room. Null when the level is no set of rooms.
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(wall, goals, w);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve one level: room by room when it splits, else one search over the
// whole level. A room search that gives up falls back to the whole level.
function solve(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    // Where every box stands now (solved rooms: on their goals).
    const now = new Uint8Array(level.wall.length);
    for (const b of level.boxes) now[b] = 1;
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (let i = 0; i < wall.length; i++) {
        if (now[i] && !room.boxes.includes(i)) wall[i] = 1;
      }
      const res = pushSearch(level.w, wall, room.goals, room.boxes, player, 500_000);
      if (res === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      player = res.player;
      for (const b of room.boxes) now[b] = 0;
      for (const g of room.goals) now[g] = 1;
    }
    if (ok) return moves;
  }
  const whole = pushSearch(level.w, level.wall, level.goals, level.boxes, level.player, 1_000_000);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
