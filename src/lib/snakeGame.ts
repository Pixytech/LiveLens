export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

export interface Point { x: number; y: number; }

export interface SnakeState {
  width: number;
  height: number;
  snake: Point[];      // head first
  direction: Direction;
  food: Point;
  score: number;
  alive: boolean;
}

const OPPOSITE: Record<Direction, Direction> = {
  UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT',
};

const DELTA: Record<Direction, Point> = {
  UP: { x: 0, y: -1 }, DOWN: { x: 0, y: 1 }, LEFT: { x: -1, y: 0 }, RIGHT: { x: 1, y: 0 },
};

const ALL_DIRECTIONS: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

function randCell(width: number, height: number, exclude: Point[]): Point {
  const taken = new Set(exclude.map(p => `${p.x},${p.y}`));
  const free: Point[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!taken.has(`${x},${y}`)) free.push({ x, y });
    }
  }
  return free[Math.floor(Math.random() * free.length)] ?? { x: 0, y: 0 };
}

export function createSnakeGame(width: number, height: number): SnakeState {
  const startX = Math.floor(width / 2);
  const startY = Math.floor(height / 2);
  const snake: Point[] = [
    { x: startX, y: startY },
    { x: startX - 1, y: startY },
    { x: startX - 2, y: startY },
  ];
  return {
    width, height, snake, direction: 'RIGHT',
    food: randCell(width, height, snake),
    score: 0, alive: true,
  };
}

function wouldDie(state: SnakeState, dir: Direction): boolean {
  const head = state.snake[0];
  const d = DELTA[dir];
  const p: Point = { x: head.x + d.x, y: head.y + d.y };
  if (p.x < 0 || p.x >= state.width || p.y < 0 || p.y >= state.height) return true;
  const willEat = p.x === state.food.x && p.y === state.food.y;
  const body = willEat ? state.snake : state.snake.slice(0, -1);
  return body.some(b => b.x === p.x && b.y === p.y);
}

function manhattanAfter(state: SnakeState, dir: Direction): number {
  const head = state.snake[0];
  const d = DELTA[dir];
  return Math.abs(head.x + d.x - state.food.x) + Math.abs(head.y + d.y - state.food.y);
}

/** Free-cell area reachable from `from` via flood fill, capped at `cap` — used to check a
 * candidate move doesn't wall the snake into a pocket smaller than its own body, which a
 * pure nearest-to-food greedy choice can't see coming. */
function reachableArea(state: SnakeState, from: Point, blocked: Set<string>, cap: number): number {
  const visited = new Set([`${from.x},${from.y}`]);
  const queue: Point[] = [from];
  let count = 0;
  while (queue.length > 0 && count < cap) {
    const p = queue.shift()!;
    count++;
    for (const dir of ALL_DIRECTIONS) {
      const d = DELTA[dir];
      const np: Point = { x: p.x + d.x, y: p.y + d.y };
      if (np.x < 0 || np.x >= state.width || np.y < 0 || np.y >= state.height) continue;
      const key = `${np.x},${np.y}`;
      if (visited.has(key) || blocked.has(key)) continue;
      visited.add(key);
      queue.push(np);
    }
  }
  return count;
}

/** Applies a move, with a safety shield in the spirit of laya-mlx's cycle-safety layer: a
 * direct reversal or a move that would immediately hit a wall or the snake's own body is
 * overridden. Candidates are ranked by whether they leave enough open space for the snake's
 * own length (avoiding self-trapping dead ends a pure nearest-to-food choice would walk into
 * and loop around), then by distance to food, then by preferring to keep going the same way —
 * that last tiebreak is what stops the shield oscillating back and forth between two equally
 * "close" directions. The model only "loses" for real when no safe direction exists at all.
 * Returns whether the requested direction was overridden. */
export function stepSnakeGame(state: SnakeState, requested: Direction): { state: SnakeState; corrected: boolean; ate: boolean } {
  if (!state.alive) return { state, corrected: false, ate: false };

  const isAdmissible = (dir: Direction) => dir !== OPPOSITE[state.direction] && !wouldDie(state, dir);

  let direction = requested;
  let corrected = false;
  if (!isAdmissible(direction)) {
    const head = state.snake[0];
    const safe = ALL_DIRECTIONS.filter(isAdmissible);
    if (safe.length > 0) {
      const scored = safe.map(dir => {
        const d = DELTA[dir];
        const newHead: Point = { x: head.x + d.x, y: head.y + d.y };
        const willEat = newHead.x === state.food.x && newHead.y === state.food.y;
        const body = willEat ? state.snake : state.snake.slice(0, -1);
        const blocked = new Set(body.map(p => `${p.x},${p.y}`));
        const area = reachableArea(state, newHead, blocked, state.snake.length + 1);
        return { dir, trapped: area < state.snake.length, distance: manhattanAfter(state, dir) };
      });
      scored.sort((a, b) =>
        Number(a.trapped) - Number(b.trapped) ||
        a.distance - b.distance ||
        Number(a.dir !== state.direction) - Number(b.dir !== state.direction)
      );
      direction = scored[0].dir;
    }
    corrected = true;
  }

  const head = state.snake[0];
  const d = DELTA[direction];
  const newHead: Point = { x: head.x + d.x, y: head.y + d.y };

  const hitsWall = newHead.x < 0 || newHead.x >= state.width || newHead.y < 0 || newHead.y >= state.height;
  const ate = !hitsWall && newHead.x === state.food.x && newHead.y === state.food.y;
  const body = ate ? state.snake : state.snake.slice(0, -1);
  const hitsSelf = !hitsWall && body.some(p => p.x === newHead.x && p.y === newHead.y);

  if (hitsWall || hitsSelf) {
    return { state: { ...state, direction, alive: false }, corrected, ate: false };
  }

  const snake = [newHead, ...body];
  const food = ate ? randCell(state.width, state.height, snake) : state.food;
  const score = ate ? state.score + 1 : state.score;

  return { state: { ...state, snake, direction, food, score, alive: true }, corrected, ate };
}

/** Compact text description of the board for prompting a language model. Kept short on
 * purpose — the safety shield in stepSnakeGame() guarantees a legal move regardless of what
 * the model says, so the prompt only needs to steer it roughly toward the food; a shorter
 * prompt means less to prefill, which is most of a move's latency for these tiny models. */
export function describeSnakeState(state: SnakeState): string {
  const head = state.snake[0];
  const dy = state.food.y - head.y;
  const dx = state.food.x - head.x;
  const vertical = dy < 0 ? `${-dy} up` : dy > 0 ? `${dy} down` : '';
  const horizontal = dx < 0 ? `${-dx} left` : dx > 0 ? `${dx} right` : '';
  const food = [vertical, horizontal].filter(Boolean).join(', ') || 'here';
  return `Head (${head.x},${head.y}) dir ${state.direction}. Food ${food}. Reply one word: UP, DOWN, LEFT, or RIGHT.`;
}

const DIRECTION_WORDS: Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/** Pulls the first direction word out of raw model output. */
export function parseDirection(text: string): Direction | null {
  const upper = text.toUpperCase();
  let best: { dir: Direction; index: number } | null = null;
  for (const dir of DIRECTION_WORDS) {
    const index = upper.indexOf(dir);
    if (index !== -1 && (best === null || index < best.index)) best = { dir, index };
  }
  return best?.dir ?? null;
}
