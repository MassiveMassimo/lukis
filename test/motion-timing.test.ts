import assert from "node:assert/strict";
import test from "node:test";
import { getTransitionDuration, getRevealTiming } from "../lib/motion-timing.ts";

test("reveal duration places its start before the shared bounds ending", () => {
  const timing = getRevealTiming(0.8, 0.3);
  assert.equal(timing.delay, 0.5);
  assert.equal(timing.duration, 0.3);
  assert.equal(timing.delay + timing.duration, 0.8);
});

test("a reveal longer than bounds uses the whole bounds timeline", () => {
  assert.deepEqual(getRevealTiming(0.3, 2), { delay: 0, duration: 0.3 });
  assert.deepEqual(getRevealTiming(0, 0.3), { delay: 0, duration: 0 });
  assert.deepEqual(getRevealTiming(0.8, 0), { delay: 0.8, duration: 0 });
});

test("reduced motion removes delay and duration", () => {
  assert.deepEqual(getRevealTiming(0.8, 0.3, true), { delay: 0, duration: 0 });
});

test("duration resolution supports both DialKit spring modes", () => {
  assert.equal(getTransitionDuration({ type: "spring", visualDuration: 0.5 }), 0.5);
  const duration = getTransitionDuration({ type: "spring", stiffness: 200, damping: 25, mass: 1 });
  assert.ok(duration > 0 && duration < 10);
  assert.equal(getTransitionDuration({ type: "easing", duration: 0 }), 0);
});
