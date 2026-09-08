import assert from "node:assert/strict";
import test from "node:test";
import {
  getTransitionDuration,
  getRevealTiming,
  transition,
  springTransition,
  ICON_EASE,
} from "../src/lib/motion.ts";

test("reveal duration places its start before the shared bounds ending", () => {
  const timing = getRevealTiming(0.8, 0.3);
  assert.equal(timing.delay, 0.5);
  assert.equal(timing.duration, 0.3);
  assert.equal(timing.delay + timing.duration, 0.8);
});

test("a reveal longer than bounds can finish after the resize", () => {
  assert.deepEqual(getRevealTiming(0.3, 2), { delay: 0, duration: 2 });
  assert.deepEqual(getRevealTiming(0, 0.3), { delay: 0, duration: 0.3 });
  assert.deepEqual(getRevealTiming(0.8, 0), { delay: 0.8, duration: 0 });
});

test("reduced motion removes delay and duration", () => {
  assert.deepEqual(getRevealTiming(0.8, 0.3, true), { delay: 0, duration: 0 });
});

test("duration resolution supports both DialKit spring modes", () => {
  assert.equal(getTransitionDuration({ type: "spring", visualDuration: 0.5 }), 0.5);
  const duration = getTransitionDuration({ type: "spring", stiffness: 200, damping: 25, mass: 1 });
  assert.ok(duration > 0 && duration < 10);
  assert.equal(getTransitionDuration({ type: "easing", duration: 0, ease: [0, 0, 1, 1] }), 0);
});

test("visual springs retain the saved reference curve", () => {
  // Samples from the archived Motion generator, normalized at the visual duration.
  for (const [bounce, expected] of [
    [0, [0.3892794, 0.76133584, 0.93391634]],
    [0.15, [0.40745545, 0.80524409, 0.9629762]],
  ] as const) {
    const timing = transition({ type: "spring", visualDuration: 0.6, bounce });
    assert.equal(timing.duration, 600);
    expected.forEach((value, index) => {
      assert.ok(Math.abs(timing.ease((index + 1) / 4) - value) < 0.00001);
    });
    assert.equal(timing.ease(0), 0);
    assert.equal(timing.ease(1), 1);
  }
});

test("physics duration depends on the actual mass and settling thresholds", () => {
  assert.ok(
    Math.abs(
      getTransitionDuration({ type: "spring", stiffness: 300, damping: 25, mass: 0.8 }) - 0.5,
    ) < 0.00001,
  );
  assert.notEqual(
    getTransitionDuration({ type: "spring", stiffness: 100, damping: 10, mass: 1 }),
    getTransitionDuration({ type: "spring", stiffness: 300, damping: 25, mass: 0.8 }),
  );
});

test("slider springs retain the reference settling tail after their visual duration", () => {
  // Unlike the bounds adapter, the original slider runs its springs to rest.
  // These durations come from its Motion generator at 60 Hz for each distance.
  for (const [visualDuration, bounce, distance, milliseconds] of [
    [0.25, 0.15, 0.75, 283.333333],
    [0.2, 0.1, 0.25, 266.666667],
    [0.35, 0.15, 8, 333.333333],
    [0.35, 0.15, 1, 633.333333],
  ]) {
    const timing = springTransition(
      { type: "spring", visualDuration, bounce },
      { settle: true, distance },
    );
    assert.ok(Math.abs(timing.duration - milliseconds) < 0.001);
    assert.equal(timing.ease(0), 0);
    assert.equal(timing.ease(1), 1);
  }
});

test("icon easing keeps its critically damped response and exact endpoint", () => {
  assert.equal(ICON_EASE(0), 0);
  assert.ok(ICON_EASE(0.25) > 0.65 && ICON_EASE(0.25) < 0.68);
  assert.ok(ICON_EASE(0.5) > 0.94 && ICON_EASE(0.5) < 0.95);
  assert.equal(ICON_EASE(1), 1);
});
