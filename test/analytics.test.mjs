import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { track, trackWhenReady, _resetSentEvents } from "../js/analytics.js";

// A fake GoatCounter that records the events it was asked to count.
function fakeCounter() {
  const calls = [];
  return { calls, count: (o) => calls.push(o) };
}

beforeEach(() => {
  _resetSentEvents();
  delete globalThis.goatcounter;
});

test("track returns false and sends nothing when GoatCounter is not loaded", () => {
  assert.equal(track("mode-flat"), false);
});

test("track sends a categorical event with the e- prefix when loaded", () => {
  const gc = fakeCounter();
  globalThis.goatcounter = gc;
  assert.equal(track("verdict-charge-it"), true);
  assert.deepEqual(gc.calls, [
    { path: "e-verdict-charge-it", title: "verdict-charge-it", event: true },
  ]);
});

test("track fires each path at most once per session", () => {
  const gc = fakeCounter();
  globalThis.goatcounter = gc;
  assert.equal(track("car-selected"), true);
  assert.equal(track("car-selected"), true); // dedup: still truthy, but no resend
  assert.equal(gc.calls.length, 1);
});

test("track never throws if GoatCounter.count blows up", () => {
  globalThis.goatcounter = { count: () => { throw new Error("boom"); } };
  assert.doesNotThrow(() => track("pwa-standalone"));
  assert.equal(track("pwa-standalone"), true); // swallowed, treated as handled
});

test("trackWhenReady fires immediately when GoatCounter is already loaded", () => {
  const gc = fakeCounter();
  globalThis.goatcounter = gc;
  let scheduled = 0;
  trackWhenReady("pwa-standalone", 30, () => { scheduled++; });
  assert.equal(gc.calls.length, 1);
  assert.equal(scheduled, 0); // no retry needed
});

test("trackWhenReady retries until GoatCounter loads, then fires exactly once", () => {
  const gc = fakeCounter();
  let ticks = 0;
  // Synchronous scheduler: GoatCounter "loads" on the 3rd retry tick.
  const schedule = (cb) => { ticks++; if (ticks === 3) globalThis.goatcounter = gc; cb(); };
  trackWhenReady("pwa-standalone", 30, schedule);
  assert.equal(gc.calls.length, 1);
  assert.equal(gc.calls[0].path, "e-pwa-standalone");
});

test("trackWhenReady gives up after the retry budget without looping forever", () => {
  let calls = 0;
  const schedule = (cb) => { calls++; cb(); }; // GoatCounter never loads
  trackWhenReady("pwa-installed", 5, schedule);
  assert.equal(calls, 5); // exactly `tries` retries, then stops
  assert.equal(globalThis.goatcounter, undefined);
});
