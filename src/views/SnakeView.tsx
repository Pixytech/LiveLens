import { useCallback, useEffect, useRef, useState } from 'react';
import { OFFLINE_MODELS } from '../lib/offlineModels';
import {
  createSnakeGame, stepSnakeGame, describeSnakeState, parseDirection,
  type SnakeState,
} from '../lib/snakeGame';

const BOARD_W = 14;
const BOARD_H = 14;
const DEFAULT_PACE = 18; // moves/sec when not in max-speed mode
const MAX_RUNS_LOGGED = 20;

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface WorkerResult { type: 'result'; text: string; tokens: number; elapsedMs: number; tokensPerSec: number; }
interface WorkerError   { type: 'error'; message: string; }
type DecideReply = WorkerResult | WorkerError;

interface Progress { file: string; loaded: number; total: number; }

interface Stats {
  moves: number;
  corrected: number;
  totalTokens: number;
  totalElapsedMs: number;
  lastLatencyMs: number;
  lastTokensPerSec: number;
}

const ZERO_STATS: Stats = { moves: 0, corrected: 0, totalTokens: 0, totalElapsedMs: 0, lastLatencyMs: 0, lastTokensPerSec: 0 };

interface RunLog {
  id: string;
  model: string;
  device: string;
  score: number;
  moves: number;
  avgTokensPerSec: number;
  avgLatencyMs: number;
  corrected: number;
}

function loadRunLog(): RunLog[] {
  try {
    const raw = localStorage.getItem('snake_perf_log');
    return raw ? JSON.parse(raw) as RunLog[] : [];
  } catch { return []; }
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function SnakeView() {
  const [modelId, setModelId] = useState(() => {
    const id = localStorage.getItem('snake_model');
    return OFFLINE_MODELS.some(m => m.id === id) ? id! : OFFLINE_MODELS[0].id;
  });
  const [status, setStatus]     = useState<Status>('idle');
  const [device, setDevice]     = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const [gameState, setGameState] = useState<SnakeState>(() => createSnakeGame(BOARD_W, BOARD_H));
  const [running, setRunning]     = useState(false);
  const [paused, setPaused]       = useState(false);
  const [thinking, setThinking]   = useState(false);
  const [stats, setStats]         = useState<Stats>(ZERO_STATS);
  const [lastMove, setLastMove]   = useState<string>('');

  const [runLog, setRunLog] = useState<RunLog[]>(loadRunLog);
  const [maxSpeed, setMaxSpeed] = useState(true);
  const [pace, setPace] = useState(DEFAULT_PACE);

  const workerRef   = useRef<Worker | null>(null);
  const resolveRef  = useRef<((r: DecideReply) => void) | null>(null);
  const stateRef    = useRef<SnakeState>(gameState);
  const statsRef    = useRef<Stats>(ZERO_STATS);
  const genRef       = useRef(0);       // loop generation — bump to cancel an in-flight loop
  const pausedRef     = useRef(false);
  const modelLabelRef = useRef(OFFLINE_MODELS[0].label);
  const deviceRef      = useRef('');

  const offlineModel = OFFLINE_MODELS.find(m => m.id === modelId) ?? OFFLINE_MODELS[0];

  useEffect(() => { localStorage.setItem('snake_model', modelId); }, [modelId]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { modelLabelRef.current = offlineModel.label; }, [offlineModel]);
  useEffect(() => { deviceRef.current = device; }, [device]);

  // ── Load model ──────────────────────────────────────────────────────────
  const loadModel = useCallback(() => {
    genRef.current++; // cancel any running loop
    setRunning(false); setPaused(false); setThinking(false);
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../snake/snake.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setStatus('loading'); setProgress(null); setError(null);

    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'progress': setProgress({ file: data.file, loaded: data.loaded, total: data.total }); break;
        case 'ready':    setDevice(data.device); setStatus('ready'); setProgress(null); break;
        case 'result':   resolveRef.current?.(data as WorkerResult); resolveRef.current = null; break;
        case 'error':
          if (resolveRef.current) { resolveRef.current(data as WorkerError); resolveRef.current = null; }
          else { setError(data.message); setStatus('error'); }
          break;
      }
    };
    worker.onerror = e => { setError(e.message); setStatus('error'); };
    worker.postMessage({ type: 'load', modelId });
  }, [modelId]);

  useEffect(() => { loadModel(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { genRef.current++; workerRef.current?.terminate(); }, []);

  const decide = useCallback((prompt: string) => {
    return new Promise<DecideReply>(resolve => {
      resolveRef.current = resolve;
      workerRef.current?.postMessage({ type: 'decide', prompt });
    });
  }, []);

  // ── Record a finished run to the comparison log ────────────────────────
  const recordRun = useCallback((final: SnakeState, s: Stats) => {
    if (s.moves === 0) return;
    const entry: RunLog = {
      id: `${Date.now()}`,
      model: modelLabelRef.current,
      device: deviceRef.current,
      score: final.score,
      moves: s.moves,
      avgTokensPerSec: s.totalElapsedMs > 0 ? (s.totalTokens / s.totalElapsedMs) * 1000 : 0,
      avgLatencyMs: s.totalElapsedMs / s.moves,
      corrected: s.corrected,
    };
    setRunLog(prev => {
      const next = [entry, ...prev].slice(0, MAX_RUNS_LOGGED);
      localStorage.setItem('snake_perf_log', JSON.stringify(next));
      return next;
    });
  }, []);

  // ── Game loop ───────────────────────────────────────────────────────────
  const runLoop = useCallback(async (gen: number) => {
    while (gen === genRef.current) {
      if (pausedRef.current) { await sleep(120); continue; }

      const snapshot = stateRef.current;
      if (!snapshot.alive) return;

      setThinking(true);
      const t0 = performance.now();
      const reply = await decide(describeSnakeState(snapshot));
      if (gen !== genRef.current) return; // superseded by reset/model reload
      setThinking(false);

      if (reply.type === 'error') {
        setError(reply.message); setStatus('error'); setRunning(false);
        return;
      }

      const dir = parseDirection(reply.text) ?? snapshot.direction;
      const { state: next, corrected } = stepSnakeGame(snapshot, dir);
      stateRef.current = next;
      setGameState(next);
      setLastMove(`${dir}${corrected ? ' (corrected)' : ''} · "${reply.text.trim().slice(0, 24)}"`);

      const updated: Stats = {
        moves: statsRef.current.moves + 1,
        corrected: statsRef.current.corrected + (corrected ? 1 : 0),
        totalTokens: statsRef.current.totalTokens + reply.tokens,
        totalElapsedMs: statsRef.current.totalElapsedMs + reply.elapsedMs,
        lastLatencyMs: reply.elapsedMs,
        lastTokensPerSec: reply.tokensPerSec,
      };
      statsRef.current = updated;
      setStats(updated);
      if (!next.alive) recordRun(next, updated);

      if (!next.alive) { setRunning(false); return; }
      if (gen !== genRef.current) return;

      if (!maxSpeed) {
        const targetMs = 1000 / pace;
        const wait = targetMs - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
      }
    }
  }, [decide, maxSpeed, pace, recordRun]);

  const start = useCallback(() => {
    if (status !== 'ready' || running) return;
    setPaused(false);
    genRef.current++;
    const gen = genRef.current;
    setRunning(true);
    void runLoop(gen);
  }, [status, running, runLoop]);

  const resetGame = useCallback(() => {
    genRef.current++; // cancel any in-flight loop
    const fresh = createSnakeGame(BOARD_W, BOARD_H);
    stateRef.current = fresh;
    setGameState(fresh);
    statsRef.current = ZERO_STATS;
    setStats(ZERO_STATS);
    setLastMove('');
    setRunning(false);
    setPaused(false);
    setThinking(false);
  }, []);

  const clearLog = useCallback(() => {
    setRunLog([]);
    localStorage.removeItem('snake_perf_log');
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────
  const progressPct = progress?.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
  const dotClass = { idle: 'chat-dot--idle', loading: 'chat-dot--loading', ready: thinking ? 'chat-dot--generating' : 'chat-dot--ready', error: 'chat-dot--error' }[status];
  const avgTokensPerSec = stats.totalElapsedMs > 0 ? (stats.totalTokens / stats.totalElapsedMs) * 1000 : 0;
  const cellPx = 22;

  const bodySet = new Set(gameState.snake.slice(1).map(p => `${p.x},${p.y}`));
  const head = gameState.snake[0];

  return (
    <div className="view snake-view">
      <p className="view-arch">
        <span className="view-arch-label">How it works</span>
        Every move, the loaded offline model is asked to describe the board back a single direction word. That decision, its
        latency and its tokens/sec are timed live below — switch models and play again to build a side-by-side performance log,
        the same idea behind projects like <a href="https://github.com/mizorewww/laya-mlx" target="_blank" rel="noopener noreferrer" className="chat-settings-link">laya-mlx</a>'s
        Snake benchmark, run here entirely in-browser instead of via native Apple MLX. A safety shield overrides a move only
        when it would immediately hit a wall or the snake's own body — small models fail at that a lot, and each override
        counts toward "Corrected / shielded" below, so speed and survival stay comparable across very different model sizes.
      </p>

      {error && <p className="error-banner">{error}</p>}

      <div className="snake-grid">
        {/* ── Left: board ── */}
        <div className="panel snake-board-panel">
          <div className="panel-header">
            <span>
              <span className={`chat-dot ${dotClass}`} style={{ marginRight: 8 }} />
              {status === 'loading' ? 'Loading model…' : offlineModel.label}
              {device && <span className="engine-badge" style={{ marginLeft: 8 }}>{device.toUpperCase()}</span>}
            </span>
            <span className="dim">Score {gameState.score}</span>
          </div>

          {status === 'loading' && (
            <div style={{ marginBottom: 12 }}>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${progressPct}%` }} /></div>
              <p className="monitor-progress-label">{progress ? `${progress.file} · ${progressPct}%` : 'Initialising…'}</p>
            </div>
          )}

          <div
            className="snake-board"
            style={{
              gridTemplateColumns: `repeat(${BOARD_W}, ${cellPx}px)`,
              gridTemplateRows: `repeat(${BOARD_H}, ${cellPx}px)`,
            }}
          >
            {Array.from({ length: BOARD_W * BOARD_H }).map((_, i) => {
              const x = i % BOARD_W, y = Math.floor(i / BOARD_W);
              const isHead = head.x === x && head.y === y;
              const isBody = !isHead && bodySet.has(`${x},${y}`);
              const isFood = gameState.food.x === x && gameState.food.y === y;
              const cls = isHead ? 'snake-cell--head' : isBody ? 'snake-cell--body' : isFood ? 'snake-cell--food' : '';
              return <div key={i} className={`snake-cell ${cls}`} />;
            })}
          </div>

          {!gameState.alive && stats.moves > 0 && (
            <p className="snake-gameover">Game over — {gameState.score} food, {stats.moves} moves. Reset to play again.</p>
          )}

          <div className="snake-controls">
            <button className="action-btn action-btn--start" onClick={start} disabled={status !== 'ready' || running || !gameState.alive}>
              {stats.moves === 0 ? 'Start' : 'Resume'}
            </button>
            <button className="action-btn" onClick={() => setPaused(p => !p)} disabled={!running}>
              {paused ? 'Unpause' : 'Pause'}
            </button>
            <button className="action-btn action-btn--clear" onClick={resetGame}>Reset</button>
          </div>

          {lastMove && <p className="snake-lastmove">Last decision: {lastMove}</p>}
        </div>

        {/* ── Right: model + speed + live stats ── */}
        <div className="snake-settings-col">
          <div className="panel">
            <div className="panel-header">Model</div>
            <select
              className="speech-select"
              value={modelId}
              onChange={e => setModelId(e.target.value)}
              disabled={status === 'loading' || running}
            >
              {(['General', 'Code'] as const).map(group => (
                <optgroup key={group} label={group}>
                  {OFFLINE_MODELS.filter(m => m.group === group).map(m => (
                    <option key={m.id} value={m.id}>{m.label} — {m.size} {m.speed}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button className="action-btn action-btn--start monitor-load-btn" style={{ marginTop: 8 }} onClick={loadModel} disabled={status === 'loading'}>
              {status === 'loading' ? 'Loading…' : 'Load / Reload'}
            </button>
            <p className="chat-settings-hint" style={{ marginTop: 8 }}>{offlineModel.note}</p>
          </div>

          <div className="panel">
            <div className="panel-header">Pace</div>
            <label className="snake-pace-row">
              <input type="checkbox" checked={maxSpeed} onChange={e => setMaxSpeed(e.target.checked)} disabled={running} />
              Max speed (no pacing delay)
            </label>
            <label className="snake-pace-row" style={{ opacity: maxSpeed ? 0.4 : 1 }}>
              <input
                type="range" min={1} max={20} value={pace}
                onChange={e => setPace(Number(e.target.value))}
                disabled={maxSpeed || running}
              />
              {pace} moves/sec target
            </label>
          </div>

          <div className="panel">
            <div className="panel-header">Live performance</div>
            <div className="snake-stat-row"><span className="dim">Moves</span><span>{stats.moves}</span></div>
            <div className="snake-stat-row"><span className="dim">Corrected / shielded</span><span>{stats.corrected}</span></div>
            <div className="snake-stat-row"><span className="dim">Last decision latency</span><span>{stats.lastLatencyMs.toFixed(0)} ms</span></div>
            <div className="snake-stat-row"><span className="dim">Last tokens/sec</span><span>{stats.lastTokensPerSec.toFixed(1)}</span></div>
            <div className="snake-stat-row"><span className="dim">Avg tokens/sec</span><span>{avgTokensPerSec.toFixed(1)}</span></div>
          </div>
        </div>
      </div>

      {/* ── Performance comparison across runs/models ── */}
      <div className="panel">
        <div className="panel-header">
          Performance comparison
          {runLog.length > 0 && <button className="chat-ctx-clear" onClick={clearLog}>Clear</button>}
        </div>
        {runLog.length === 0 ? (
          <p className="empty">Finish a run (let the snake die, or reset after some moves) to log it here and compare models.</p>
        ) : (
          <div className="snake-log-wrap">
            <table className="snake-log-table">
              <thead>
                <tr>
                  <th>Model</th><th>Device</th><th>Score</th><th>Moves</th>
                  <th>Avg tok/s</th><th>Avg latency</th><th>Shielded</th>
                </tr>
              </thead>
              <tbody>
                {runLog.map(r => (
                  <tr key={r.id}>
                    <td>{r.model}</td>
                    <td>{r.device.toUpperCase()}</td>
                    <td>{r.score}</td>
                    <td>{r.moves}</td>
                    <td>{r.avgTokensPerSec.toFixed(1)}</td>
                    <td>{r.avgLatencyMs.toFixed(0)} ms</td>
                    <td>{r.corrected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
