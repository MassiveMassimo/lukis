import { DEFAULT_RIPPLE, type RippleSettings } from "./processor.ts";

export const DEFAULT_RIPPLE_TIMING = {
  startOffsetMs: 0,
  attackMs: 340 / 1.5,
  durationMs: 2800,
  damping: 0.2,
};
export type RippleTiming = typeof DEFAULT_RIPPLE_TIMING;
export interface RippleMotion {
  distance: number;
  amplitude: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** One clock moves the impact fold and its trailing shoulder beyond the image. */
export function createRipplePlayback(
  revealDuration: number,
  settings = DEFAULT_RIPPLE,
  timing = DEFAULT_RIPPLE_TIMING,
  dimensions = { width: 4, height: 3 },
) {
  const shortSide = Math.min(dimensions.width, dimensions.height);
  // Include the normal's finite-difference samples and softened center metric.
  const corner = Math.hypot(dimensions.width, dimensions.height) / shortSide / 2 + 0.004;
  const lastEcho = settings.echo > 0 ? (settings.count - 1) * settings.spacing : 0;
  // Compact support ends at three widths. The broader trailing shoulder exits last.
  const exitDistance =
    (corner + 0.17 + lastEcho + (0.28 / 0.205 + 3 * 1.62) * settings.width) /
    (1 - 3 * 1.62 * settings.broadening);
  // Keep B's original travel on ordinary images. Wider images and broader
  // waves travel farther in the same user-selected duration.
  const travelDistance = Math.max(2.94, Math.ceil(exitDistance / 0.07) * 0.07);
  const waveDuration = timing.durationMs;
  const duration = Math.max(revealDuration, timing.startOffsetMs + waveDuration);
  return {
    duration,
    sample(elapsed: number) {
      const age = elapsed - timing.startOffsetMs;
      const distance = clamp(age / waveDuration) * travelDistance;
      const attack = timing.attackMs > 0 ? clamp(age / timing.attackMs) : 1;
      const launch = attack * attack * (3 - 2 * attack);
      return {
        wave: clamp(age / waveDuration),
        distance,
        amplitude:
          age < 0 || age >= waveDuration
            ? 0
            : launch * Math.exp(-timing.damping * distance * distance),
      };
    },
  };
}

export function defaultRippleMotion(
  wave: number,
  settings: RippleSettings = DEFAULT_RIPPLE,
  dimensions = { width: 4, height: 3 },
): RippleMotion {
  const playback = createRipplePlayback(0, settings, DEFAULT_RIPPLE_TIMING, dimensions);
  const { distance, amplitude } = playback.sample(clamp(wave) * playback.duration);
  return { distance, amplitude };
}
