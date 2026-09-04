import assert from "node:assert/strict";
import test from "node:test";
import { getTransitionDuration, getRevealDelay } from "../lib/motion-timing.ts";

test("reveal delay follows the configured percentage of an easing transition", () => {
  const transition = {
    type: "easing",
    duration: 0.4,
    ease: [0.22, 1, 0.36, 1],
  };

  assert.equal(getTransitionDuration(transition), 0.4);
  assert.equal(getRevealDelay(transition, 70), 280);
});

test("reveal delay follows a time spring visual duration", () => {
  const transition = {
    type: "spring",
    visualDuration: 0.5,
    bounce: 0.2,
  };

  assert.equal(getTransitionDuration(transition), 0.5);
  assert.equal(getRevealDelay(transition, 70), 350);
});

test("physics springs receive a finite calculated duration", () => {
  const transition = {
    type: "spring",
    stiffness: 200,
    damping: 25,
    mass: 1,
  };

  const duration = getTransitionDuration(transition);

  assert.ok(duration > 0);
  assert.ok(duration < 10);
  assert.equal(getRevealDelay(transition, 70), duration * 700);
});

test("reveal timing is clamped to the bounds animation", () => {
  const transition = { type: "easing", duration: 0.3 };

  assert.equal(getRevealDelay(transition, -20), 0);
  assert.equal(getRevealDelay(transition, 120), 300);
  assert.equal(getRevealDelay(transition, 70, true), 0);
  assert.equal(getTransitionDuration({ type: "easing", duration: 0 }), 0);
});
