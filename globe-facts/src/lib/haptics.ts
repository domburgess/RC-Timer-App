// Haptics abstraction: Capacitor Haptics when wrapped natively, Vibration API on the web
// (Android Chrome), silently nothing elsewhere (iOS Safari has no web vibration).

type Kind = 'tap' | 'success' | 'soft';

interface CapHaptics {
  impact(o: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }): Promise<void>;
  notification(o: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }): Promise<void>;
}

export function haptic(kind: Kind): void {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: { Haptics?: CapHaptics } } }).Capacitor;
    const h = cap?.Plugins?.Haptics;
    if (h) {
      if (kind === 'success') void h.notification({ type: 'SUCCESS' });
      else void h.impact({ style: kind === 'tap' ? 'LIGHT' : 'MEDIUM' });
      return;
    }
    if ('vibrate' in navigator) navigator.vibrate(kind === 'tap' ? 8 : kind === 'success' ? [12, 60, 12] : 20);
  } catch {
    /* haptics are a nicety */
  }
}
