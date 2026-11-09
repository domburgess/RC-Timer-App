import { forwardRef, useEffect, useRef, useState } from 'react';
import type { FactResponse } from '../../shared/types';

export type SheetState =
  | { kind: 'loading'; place: string }
  | { kind: 'fact'; fact: FactResponse }
  | { kind: 'guess'; fact: FactResponse; picked: number | null; revealed: boolean };

interface Props {
  state: SheetState | null;
  onDismiss(): void;
  onPick(index: number): void;
  onSkip(): void;
  debug: boolean;
}

export const FactSheet = forwardRef<HTMLDivElement, Props>(function FactSheet(
  { state, onDismiss, onPick, onSkip, debug },
  ref,
) {
  const [shown, setShown] = useState<SheetState | null>(state);
  const [showSources, setShowSources] = useState(false);
  const [showData, setShowData] = useState(false);
  const drag = useRef<{ y0: number; dy: number } | null>(null);
  const inner = useRef<HTMLDivElement>(null);

  // Keep rendering the last state while the sheet slides out.
  useEffect(() => {
    if (state) setShown(state);
    setShowSources(false);
    setShowData(false);
  }, [state]);

  // Swipe down to dismiss.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    drag.current = { y0: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !inner.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    inner.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onPointerUp = () => {
    if (!drag.current || !inner.current) return;
    const { dy } = drag.current;
    drag.current = null;
    inner.current.style.transform = '';
    if (dy > 70) onDismiss();
  };

  const s = shown;
  const open = !!state;

  return (
    <div ref={ref} className={`sheet ${open ? 'open' : ''}`} aria-live="polite" aria-hidden={!open}>
      <div
        ref={inner}
        className="sheet-inner"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="grabber" />
        {s?.kind === 'loading' && (
          <>
            <div className="place">{s.place}</div>
            <div className="shimmer">
              <span />
              <span />
              <span className="short" />
            </div>
          </>
        )}

        {s && s.kind !== 'loading' && (
          <>
            <div className="place">
              {s.fact.place}
              {s.fact.writer === 'offline' && <span className="badge">offline</span>}
            </div>

            {s.kind === 'guess' && s.fact.question ? (
              <Guess s={s} onPick={onPick} onSkip={onSkip} />
            ) : (
              <p className="fact" key={s.fact.id}>
                {s.fact.fact}
              </p>
            )}

            <div className="foot">
              <button className="sources-btn" onClick={() => setShowSources((v) => !v)}>
                {sourceSummary(s.fact)}
              </button>
              <span className="hint">Tap anywhere for another</span>
            </div>
            {showSources && (
              <ul className="sources">
                {s.fact.sources.map((src, i) => (
                  <li key={i}>
                    {src.url ? (
                      <a href={src.url} target="_blank" rel="noreferrer">
                        {src.label}
                      </a>
                    ) : (
                      src.label
                    )}
                  </li>
                ))}
                <li className="muted">
                  {s.fact.writer === 'claude'
                    ? 'Written by Claude from this data only'
                    : s.fact.writer === 'computed'
                      ? 'Computed directly from this data'
                      : 'Computed on your device'}
                  {s.fact.cached ? ' · cached' : ''}
                </li>
              </ul>
            )}
            {debug && s.fact.data && (
              <>
                <button className="sources-btn" onClick={() => setShowData((v) => !v)}>
                  {showData ? 'hide data' : 'show source data'}
                </button>
                {showData && <pre className="debug">{JSON.stringify(s.fact.data, null, 2)}</pre>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
});

function sourceSummary(f: FactResponse): string {
  const names = [...new Set(f.sources.map((s) => s.label.split(':')[0].split(' (')[0]))];
  return names.slice(0, 2).join(' · ') || 'Sources';
}

function Guess({
  s,
  onPick,
  onSkip,
}: {
  s: Extract<SheetState, { kind: 'guess' }>;
  onPick(i: number): void;
  onSkip(): void;
}) {
  const q = s.fact.question!;
  return (
    <div className="guess">
      <p className="question">{q.prompt}</p>
      <div className="options">
        {q.options.map((opt, i) => {
          const state = !s.revealed
            ? ''
            : i === q.correctIndex
              ? 'correct'
              : i === s.picked
                ? 'wrong'
                : 'dim';
          return (
            <button key={i} className={`option ${state}`} disabled={s.revealed} onClick={() => onPick(i)}>
              {opt}
            </button>
          );
        })}
      </div>
      {s.revealed ? (
        <p className="fact reveal">
          {s.picked !== null && (
            <span className="verdict">{s.picked === q.correctIndex ? 'Yes! ' : 'Not quite. '}</span>
          )}
          {q.reveal ?? s.fact.fact}
        </p>
      ) : (
        <button className="skip" onClick={onSkip}>
          Just tell me
        </button>
      )}
    </div>
  );
}
