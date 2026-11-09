import { useCallback, useRef, useState } from 'react';
import { Globe, type GlobeHandle, type GlobeTap } from './components/Globe';
import { FactSheet, type SheetState } from './components/FactSheet';
import { fetchFact } from './lib/api';
import { haptic } from './lib/haptics';
import { load, save } from './lib/storage';
import { formatCoord } from '../shared/geo';
import type { Mode } from '../shared/types';

interface Score {
  correct: number;
  total: number;
}

const debug = new URLSearchParams(location.search).has('debug');

export function App() {
  const globe = useRef<GlobeHandle>(null);
  const sheetEl = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [mode, setMode] = useState<Mode>(() => load<Mode>('gf.mode', 'fact'));
  const [score, setScore] = useState<Score>(() => load<Score>('gf.score', { correct: 0, total: 0 }));
  const [touched, setTouched] = useState(false);
  const reqId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const onTap = useCallback(async (tap: GlobeTap) => {
    haptic('tap');
    setTouched(true);
    const id = ++reqId.current;
    abort.current?.abort();
    abort.current = new AbortController();

    setSheet({ kind: 'loading', place: formatCoord(tap.lat, tap.lon) });
    // Card height is roughly known before content arrives; keep the pin above it.
    globe.current?.focus(tap.lat, tap.lon, sheetEl.current?.offsetHeight || window.innerHeight * 0.32);

    try {
      const fact = await fetchFact(
        { lat: tap.lat, lon: tap.lon, zoom: tap.zoom, mode: modeRef.current },
        abort.current.signal,
      );
      if (id !== reqId.current) return; // a newer tap won
      if (modeRef.current === 'guess' && fact.question) {
        setSheet({ kind: 'guess', fact, picked: null, revealed: false });
      } else {
        setSheet({ kind: 'fact', fact });
      }
    } catch {
      /* aborted by a newer tap */
    }
  }, []);

  const dismiss = useCallback(() => {
    reqId.current++;
    abort.current?.abort();
    setSheet(null);
    globe.current?.clearPin();
  }, []);

  const pick = (i: number) => {
    if (sheet?.kind !== 'guess' || sheet.revealed) return;
    const right = i === sheet.fact.question!.correctIndex;
    haptic(right ? 'success' : 'soft');
    const next = { correct: score.correct + (right ? 1 : 0), total: score.total + 1 };
    setScore(next);
    save('gf.score', next);
    setSheet({ ...sheet, picked: i, revealed: true });
  };

  const skip = () => {
    if (sheet?.kind !== 'guess') return;
    setSheet({ ...sheet, picked: null, revealed: true });
  };

  const toggleMode = () => {
    const next: Mode = mode === 'fact' ? 'guess' : 'fact';
    haptic('tap');
    setMode(next);
    save('gf.mode', next);
    // Switching to fact mode while a question is open: just show the fact.
    if (next === 'fact' && sheet?.kind === 'guess') setSheet({ kind: 'fact', fact: sheet.fact });
  };

  return (
    <div className="app">
      <Globe ref={globe} onTap={onTap} onTapSpace={dismiss} onInteract={() => setTouched(true)} />

      <div className="chrome-top">
        <button
          className={`mode-toggle ${mode === 'guess' ? 'on' : ''}`}
          onClick={toggleMode}
          aria-pressed={mode === 'guess'}
          aria-label="Guess mode"
        >
          <span className="switch" />
          Guess
          {mode === 'guess' && score.total > 0 && (
            <span className="score">
              {score.correct}/{score.total}
            </span>
          )}
        </button>
      </div>

      <div className={`intro ${touched ? 'gone' : ''}`}>Tap anywhere on Earth</div>

      <FactSheet ref={sheetEl} state={sheet} onDismiss={dismiss} onPick={pick} onSkip={skip} debug={debug} />
    </div>
  );
}
