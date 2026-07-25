// analytics.js - privacy-safe, categorical GoatCounter events. Sends only WHICH
// feature/outcome was used, never the user's numbers. Each path fires at most
// once per session and no-ops when GoatCounter isn't available (localhost,
// blocked, or not yet loaded).

const sent = new Set();

// Fire a single event now if GoatCounter is loaded. Returns true when the event
// was sent (or had already been sent this session), and false when GoatCounter
// isn't ready yet so the caller can decide to retry. Never throws - analytics
// must never break the app.
export function track(path) {
  if (sent.has(path)) return true;
  try {
    const gc = globalThis.goatcounter;
    if (!gc || typeof gc.count !== "function") return false; // not loaded yet
    gc.count({ path: `e-${path}`, title: path, event: true });
    sent.add(path);
    return true;
  } catch (_) { return true; } // sent-or-not unknown; don't retry on error
}

// GoatCounter loads async, so an event known at boot (e.g. "launched as an
// installed PWA") can't rely on a later render to retry. Poll until it's ready,
// then fire once - independent of whether the user ever interacts. The scheduler
// is injectable so tests can drive the retries without real timers.
export function trackWhenReady(path, tries = 30, schedule = setTimeout) {
  if (track(path) || tries <= 0) return;
  schedule(() => trackWhenReady(path, tries - 1, schedule), 300);
}

// Test-only: reset the once-per-session dedup so cases start clean.
export function _resetSentEvents() {
  sent.clear();
}
