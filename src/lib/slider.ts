import { animate } from "animejs";
import { play } from "cuelume";
import "number-flow";
import type NumberFlow from "number-flow";
import { MESSAGE_EASE, reducedMotion, springTransition } from "./motion";

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

export function createSlider(element: HTMLElement, onChange: (value: number) => void) {
  const track = element.querySelector<HTMLElement>(".slider-track")!;
  const label = element.querySelector<HTMLElement>(".slider-label")!;
  const display = element.querySelector<HTMLElement>(".slider-value")!;
  const numberFlow = display.querySelector<NumberFlow>("number-flow")!;
  const handle = element.querySelector<HTMLElement>(".slider-handle")!;
  const min = Number(element.getAttribute("aria-valuemin"));
  const max = Number(element.getAttribute("aria-valuemax"));
  const step = Number(element.dataset.step);
  const notchPositions = [
    0,
    ...[...element.querySelectorAll<HTMLElement>("[data-notch-value]")].map(
      (notch) => (Number(notch.dataset.notchValue) - min) / (max - min),
    ),
    1,
  ];
  let value = Number(element.getAttribute("aria-valuenow"));
  const fractionDigits = step < 1 ? 1 : 0;
  numberFlow.locales = "en-US";
  numberFlow.format = {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  };
  numberFlow.numberSuffix = element.dataset.suffix ?? "";
  numberFlow.update(value);
  const visual = { fill: ((value - min) / (max - min)) * 100, stretch: 0 };
  let animation: ReturnType<typeof animate> | undefined;
  let handleAnimation: ReturnType<typeof animate> | undefined;
  let handleTarget = "";
  const handleVisual = { opacity: 0, scaleX: 0.25, scaleY: 1 };
  let pointer: { id: number; x: number; y: number; rect: DOMRect; dragged: boolean } | undefined;
  let disabled = false,
    hovered = false,
    focused = false,
    tickAt = 0;
  let leftThreshold = 0,
    rightThreshold = 100;
  const controller = new AbortController();
  const signal = controller.signal;
  function paintHandle() {
    handle.style.opacity = String(handleVisual.opacity);
    handle.style.transform = `translateY(-50%) scale(${handleVisual.scaleX}, ${handleVisual.scaleY})`;
  }
  function paint() {
    track.style.setProperty("--fill", `${visual.fill}%`);
    track.style.width = `calc(100% + ${Math.abs(visual.stretch)}px)`;
    track.style.transform = `translateX(${Math.min(0, visual.stretch)}px)`;
    const active = (hovered || focused || !!pointer) && !disabled;
    element.dataset.active = String(active);
    element.dataset.dragging = String(!!pointer);
    element.dataset.keyboardFocus = String(focused && !pointer && !disabled);
    const collision = visual.fill < leftThreshold || visual.fill > rightThreshold;
    const opacity = active ? (collision ? 0.1 : pointer?.dragged ? 0.8 : 0.5) : 0;
    const scaleX = active ? 1 : 0.25;
    const scaleY = active && collision ? 0.75 : 1;
    const target = `${opacity}:${scaleX}:${scaleY}:${reducedMotion()}`;
    if (target === handleTarget) return;
    handleTarget = target;
    handleAnimation?.cancel();
    if (reducedMotion()) {
      Object.assign(handleVisual, { opacity, scaleX, scaleY });
      paintHandle();
    } else {
      handleAnimation = animate(handleVisual, {
        opacity: { to: opacity, duration: 150, ease: MESSAGE_EASE },
        scaleX: {
          to: scaleX,
          ...springTransition(
            { type: "spring", visualDuration: 0.25, bounce: 0.15 },
            { settle: true, distance: scaleX - handleVisual.scaleX },
          ),
        },
        scaleY: {
          to: scaleY,
          ...springTransition(
            { type: "spring", visualDuration: 0.2, bounce: 0.1 },
            { settle: true, distance: scaleY - handleVisual.scaleY },
          ),
        },
        onUpdate: paintHandle,
      });
    }
  }
  function measure() {
    const width = element.clientWidth;
    leftThreshold = ((16 + label.offsetWidth + 8) / width) * 100;
    rightThreshold = ((width - 4 - display.offsetWidth - 8) / width) * 100;
    paint();
  }
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  observer.observe(label);
  observer.observe(display);
  function update(next: number) {
    const rounded = Number(
      clamp(min + Math.round((next - min) / step) * step, min, max).toFixed(4),
    );
    if (rounded === value) return;
    value = rounded;
    const text = `${step < 1 ? value.toFixed(1) : value}${element.dataset.suffix}`;
    numberFlow.update(value);
    element.setAttribute("aria-valuenow", String(value));
    element.setAttribute("aria-valuetext", text);
    onChange(value);
    if (performance.now() - tickAt >= 75) {
      play("tick", { volume: 0.75 });
      tickAt = performance.now();
    }
  }
  function settle() {
    animation?.cancel();
    const fill = ((value - min) / (max - min)) * 100;
    if (reducedMotion()) {
      Object.assign(visual, { fill, stretch: 0 });
      paint();
      return;
    }
    animation = animate(visual, {
      fill: {
        to: fill,
        ...springTransition(
          { type: "spring", stiffness: 300, damping: 25, mass: 0.8 },
          { settle: true, distance: fill - visual.fill },
        ),
      },
      stretch: {
        to: 0,
        ...springTransition(
          { type: "spring", visualDuration: 0.35, bounce: 0.15 },
          { settle: true, distance: visual.stretch },
        ),
      },
      onUpdate: paint,
    });
  }
  function release() {
    if (!pointer) return;
    const id = pointer.id;
    pointer = undefined;
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    settle();
    paint();
  }
  element.addEventListener(
    "pointerdown",
    (event) => {
      if (disabled || pointer || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      element.focus({ preventScroll: true });
      focused = false;
      animation?.cancel();
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        rect: element.getBoundingClientRect(),
        dragged: false,
      };
      element.setPointerCapture(event.pointerId);
      paint();
    },
    { signal },
  );
  element.addEventListener(
    "pointermove",
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.dragged && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 3)
        return;
      pointer.dragged = true;
      const x = event.clientX - pointer.rect.left;
      visual.fill = clamp((x / pointer.rect.width) * 100, 0, 100);
      const distance = x < 0 ? x : x > pointer.rect.width ? x - pointer.rect.width : 0;
      visual.stretch = reducedMotion()
        ? 0
        : Math.sign(distance) * 8 * Math.sqrt(clamp((Math.abs(distance) - 32) / 200, 0, 1));
      update(min + (visual.fill / 100) * (max - min));
      paint();
    },
    { signal },
  );
  element.addEventListener(
    "pointerup",
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (!pointer.dragged) {
        let position = clamp((event.clientX - pointer.rect.left) / pointer.rect.width, 0, 1);
        const snap = notchPositions.reduce((nearest, notch) =>
          Math.abs(nearest - position) < Math.abs(notch - position) ? nearest : notch,
        );
        if (Math.abs(snap - position) <= 0.03125) position = snap;
        update(min + position * (max - min));
      }
      release();
    },
    { signal },
  );
  for (const name of ["pointercancel", "lostpointercapture"] as const)
    element.addEventListener(
      name,
      (event) => {
        if (pointer?.id === event.pointerId) release();
      },
      { signal },
    );
  element.addEventListener(
    "pointerenter",
    () => {
      hovered = true;
      paint();
    },
    { signal },
  );
  element.addEventListener(
    "pointerleave",
    () => {
      hovered = false;
      paint();
    },
    { signal },
  );
  element.addEventListener(
    "focus",
    () => {
      focused = true;
      paint();
    },
    { signal },
  );
  element.addEventListener(
    "blur",
    () => {
      focused = false;
      paint();
    },
    { signal },
  );
  element.addEventListener(
    "keydown",
    (event) => {
      if (disabled) return;
      const delta = step * (event.shiftKey ? 10 : 1);
      const values: Record<string, number> = {
        ArrowRight: value + delta,
        ArrowUp: value + delta,
        ArrowLeft: value - delta,
        ArrowDown: value - delta,
        Home: min,
        End: max,
      };
      if (!(event.key in values)) return;
      event.preventDefault();
      focused = true;
      update(values[event.key]);
      animation?.cancel();
      visual.fill = ((value - min) / (max - min)) * 100;
      visual.stretch = 0;
      paint();
    },
    { signal },
  );
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
    "change",
    () => {
      if (reducedMotion()) {
        animation?.complete();
        visual.stretch = 0;
      }
      paint();
    },
    { signal },
  );
  paintHandle();
  paint();
  return {
    get value() {
      return value;
    },
    setDisabled(next: boolean) {
      disabled = next;
      element.setAttribute("aria-disabled", String(next));
      element.tabIndex = next ? -1 : 0;
      if (next) release();
      paint();
    },
    destroy() {
      release();
      animation?.cancel();
      handleAnimation?.cancel();
      observer.disconnect();
      numberFlow.animated = false;
      controller.abort();
    },
  };
}
