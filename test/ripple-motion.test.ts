import assert from "node:assert/strict";
import { test } from "node:test";
import { createRipplePlayback, DEFAULT_RIPPLE_TIMING } from "../src/lib/ripple-motion.ts";
import { DEFAULT_RIPPLE } from "../src/lib/processor.ts";

test("original B shape preserves its trajectory at 1.5x playback speed", () => {
  const playback = createRipplePlayback(1850, {
    ...DEFAULT_RIPPLE,
    width: 0.205,
    broadening: 0.085 / (2.85 * 0.7),
  });
  assert.equal(playback.duration, 2800);
  assert.equal(playback.sample(0).amplitude, 0);
  for (const time of [170, 340, 800, 1400, 2300]) {
    const { distance, amplitude } = playback.sample(time / 1.5);
    const t = time / 1000;
    assert.ok(Math.abs(distance - 0.7 * t) < 1e-12);
    const phase = Math.min(1, time / 340);
    const expected = phase * phase * (3 - 2 * phase) * Math.exp(-0.2 * (0.7 * t) ** 2);
    assert.ok(Math.abs(amplitude - expected) < 1e-12);
    assert.ok(amplitude > 0, "No separate rebound reverses the initial impact");
  }
  assert.equal(playback.sample(2800).amplitude, 0);
});

test("duration stretches propagation without delaying the launch", () => {
  const normal = createRipplePlayback(1850);
  const slow = createRipplePlayback(1850, DEFAULT_RIPPLE, {
    ...DEFAULT_RIPPLE_TIMING,
    durationMs: 5600,
  });
  assert.ok(slow.duration > normal.duration * 1.9);
  assert.equal(slow.sample(800).distance, normal.sample(400).distance);
  assert.ok(slow.sample(170).amplitude > 0.49);
});

test("offset, attack and damping remain deterministic during reverse scrubbing", () => {
  const playback = createRipplePlayback(1850, DEFAULT_RIPPLE, {
    ...DEFAULT_RIPPLE_TIMING,
    startOffsetMs: 250,
    attackMs: 200,
  });
  assert.equal(playback.sample(200).amplitude, 0);
  assert.ok(playback.sample(350).amplitude > 0.49);
  const saved = playback.sample(800);
  playback.sample(4000);
  playback.sample(0);
  assert.deepEqual(playback.sample(800), saved);
  const damped = createRipplePlayback(1850, DEFAULT_RIPPLE, {
    ...DEFAULT_RIPPLE_TIMING,
    damping: 1,
  });
  assert.ok(damped.sample(1500).amplitude < createRipplePlayback(1850).sample(1500).amplitude);
  assert.ok(
    createRipplePlayback(1850, DEFAULT_RIPPLE, {
      ...DEFAULT_RIPPLE_TIMING,
      startOffsetMs: -200,
    }).sample(0).amplitude > 0,
  );
});

test("completion waits for the broad trailing shoulder and last echo across aspect ratios", () => {
  for (const [width, height] of [
    [4, 3],
    [3, 4],
    [1600, 1],
    [1, 1600],
    [10, 1],
    [1, 10],
    [1, 1],
  ]) {
    for (const waveWidth of [0.05, 0.205, 2]) {
      for (const broadening of [0, DEFAULT_RIPPLE.broadening, 0.12]) {
        const settings = {
          ...DEFAULT_RIPPLE,
          width: waveWidth,
          broadening,
          count: 6,
          spacing: 1.2,
        };
        const playback = createRipplePlayback(1850, settings, DEFAULT_RIPPLE_TIMING, {
          width,
          height,
        });
        assert.equal(playback.duration, 2800, "Extreme proportions must not lock the app");
        const { distance } = playback.sample(playback.duration);
        const sigma = waveWidth + broadening * distance;
        const lastTrailingCenter = -0.17 + distance - 5 * 1.2 - (0.28 * waveWidth) / 0.205;
        const corner = Math.hypot(width, height) / Math.min(width, height) / 2;
        assert.ok(
          lastTrailingCenter - sigma * 1.62 * 3 > corner + 0.002,
          "Height and normal samples must leave compact support before the flat fast path",
        );
        assert.equal(playback.sample(playback.duration).amplitude, 0);
      }
    }
  }
});

test("zero attack stays finite, zero echo does not extend playback, and a long reveal does not stretch the wave", () => {
  const instant = createRipplePlayback(0, DEFAULT_RIPPLE, {
    ...DEFAULT_RIPPLE_TIMING,
    attackMs: 0,
  });
  assert.equal(instant.sample(0).amplitude, 1);
  assert.equal(instant.sample(instant.duration).amplitude, 0);
  const single = createRipplePlayback(1850);
  const noEcho = createRipplePlayback(1850, { ...DEFAULT_RIPPLE, count: 6, echo: 0 });
  assert.equal(noEcho.duration, single.duration);
  const longReveal = createRipplePlayback(6000);
  assert.equal(longReveal.duration, 6000);
  assert.deepEqual(longReveal.sample(800), single.sample(800));
  assert.equal(longReveal.sample(5000).amplitude, 0);
});
