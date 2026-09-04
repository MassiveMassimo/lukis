/* oxlint-disable jsx-a11y/prefer-tag-over-role */

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { AnimationPlaybackControls } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

export interface ElasticSliderProps {
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  formatValue: (value: number) => string;
  disabled: boolean;
}

const CLICK_THRESHOLD = 3;
const DEAD_ZONE = 32;
const MAX_CURSOR_RANGE = 200;
const MAX_STRETCH = 8;
const HANDLE_BUFFER = 8;
const LABEL_OFFSET = 16;
const VALUE_OFFSET = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function decimalsForStep(step: number): number {
  const decimal = step.toString().split(".")[1];
  return decimal?.length ?? 0;
}

function roundValue(value: number, step: number): number {
  const rounded = Math.round(value / step) * step;
  return Number.parseFloat(rounded.toFixed(decimalsForStep(step)));
}

function snapToDecile(value: number, min: number, max: number): number {
  const normalized = (value - min) / (max - min);
  const nearest = Math.round(normalized * 10) / 10;

  return Math.abs(normalized - nearest) <= 0.03125 ? min + nearest * (max - min) : value;
}

function snapPointerValue(value: number, min: number, max: number, step: number): number {
  const stepCount = (max - min) / step;
  if (stepCount > 10) return snapToDecile(value, min, max);

  return clamp(min + Math.round((value - min) / step) * step, min, max);
}

function getHandleOpacity(
  isActive: boolean,
  valueDodgesText: boolean,
  isDragging: boolean,
): number {
  if (!isActive) return 0;
  if (valueDodgesText) return 0.1;
  return isDragging ? 0.8 : 0.5;
}

export function ElasticSlider({
  label,
  value,
  onValueChange,
  min,
  max,
  step,
  formatValue,
  disabled,
}: ElasticSliderProps) {
  const shouldReduceMotion = useReducedMotion();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const pointerDownPosition = useRef<{ x: number; y: number } | null>(null);
  const isClick = useRef(true);
  const animation = useRef<AnimationPlaybackControls | null>(null);
  const wrapperRect = useRef<DOMRect | null>(null);
  const scale = useRef(1);
  const pendingPointerFocus = useRef(false);
  const [isInteracting, setIsInteracting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [keyboardFocusRing, setKeyboardFocusRing] = useState(false);
  const [dodge, setDodge] = useState<{ left: number; right: number }>({
    left: 38,
    right: 72,
  });

  const percentage = ((value - min) / (max - min)) * 100;
  const isActive = !disabled && (isInteracting || isHovered);
  const displayValue = formatValue(value);
  const fillPercent = useMotionValue(percentage);
  const fillWidth = useTransform(fillPercent, (percent) => `${percent}%`);
  const handleLeft = useTransform(fillPercent, (percent) => `max(4px, calc(${percent}% - 8px))`);
  const rubberStretch = useMotionValue(0);
  const rubberWidth = useTransform(
    rubberStretch,
    (stretch) => `calc(100% + ${Math.abs(stretch)}px)`,
  );
  const rubberX = useTransform(rubberStretch, (stretch) => (stretch < 0 ? stretch : 0));

  useEffect(() => {
    if (!isInteracting && !animation.current) {
      fillPercent.jump(percentage);
    }
  }, [fillPercent, isInteracting, percentage]);

  function positionToValue(clientX: number): number {
    const rect = wrapperRect.current;
    if (!rect) return min;

    const sceneX = (clientX - rect.left) / scale.current;
    const nativeWidth = wrapperRef.current?.offsetWidth ?? rect.width;
    const percent = clamp(sceneX / nativeWidth, 0, 1);
    return clamp(min + percent * (max - min), min, max);
  }

  function percentFromValue(nextValue: number): number {
    return ((nextValue - min) / (max - min)) * 100;
  }

  function animateFillTo(targetPercent: number): void {
    animation.current?.stop();

    if (shouldReduceMotion) {
      fillPercent.jump(targetPercent);
      animation.current = null;
      return;
    }

    animation.current = animate(fillPercent, targetPercent, {
      type: "spring",
      stiffness: 300,
      damping: 25,
      mass: 0.8,
      onComplete: () => {
        animation.current = null;
      },
    });
  }

  function computeRubberStretch(clientX: number, sign: number): number {
    const rect = wrapperRect.current;
    if (!rect) return 0;

    const distancePast = sign < 0 ? rect.left - clientX : clientX - rect.right;
    const overflow = Math.max(0, distancePast - DEAD_ZONE);

    return sign * MAX_STRETCH * Math.sqrt(Math.min(overflow / MAX_CURSOR_RANGE, 1));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (disabled) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDownPosition.current = {
      x: event.clientX,
      y: event.clientY,
    };
    isClick.current = true;
    pendingPointerFocus.current = true;
    setIsInteracting(true);
    setKeyboardFocusRing(false);
    trackRef.current?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      pendingPointerFocus.current = false;
    });

    const wrapper = wrapperRef.current;
    if (wrapper) {
      const rect = wrapper.getBoundingClientRect();
      wrapperRect.current = rect;
      scale.current = rect.width / wrapper.offsetWidth;
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (!isInteracting || !pointerDownPosition.current) return;

    const deltaX = event.clientX - pointerDownPosition.current.x;
    const deltaY = event.clientY - pointerDownPosition.current.y;
    if (isClick.current && Math.hypot(deltaX, deltaY) > CLICK_THRESHOLD) {
      isClick.current = false;
      setIsDragging(true);
    }
    if (isClick.current) return;

    const rect = wrapperRect.current;
    if (rect && !shouldReduceMotion) {
      if (event.clientX < rect.left) {
        rubberStretch.jump(computeRubberStretch(event.clientX, -1));
      } else if (event.clientX > rect.right) {
        rubberStretch.jump(computeRubberStretch(event.clientX, 1));
      } else {
        rubberStretch.jump(0);
      }
    }

    const nextValue = positionToValue(event.clientX);
    animation.current?.stop();
    animation.current = null;
    fillPercent.jump(percentFromValue(nextValue));
    onValueChange(roundValue(nextValue, step));
  }

  function finishInteraction(): void {
    if (!shouldReduceMotion && rubberStretch.get() !== 0) {
      animate(rubberStretch, 0, {
        type: "spring",
        visualDuration: 0.35,
        bounce: 0.15,
      });
    } else {
      rubberStretch.jump(0);
    }

    setIsInteracting(false);
    setIsDragging(false);
    pointerDownPosition.current = null;
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (!isInteracting) return;

    if (isClick.current) {
      const rawValue = positionToValue(event.clientX);
      const snapped = snapPointerValue(rawValue, min, max, step);

      animateFillTo(percentFromValue(snapped));
      onValueChange(roundValue(snapped, step));
    }

    finishInteraction();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) return;

    const arrowStep = event.shiftKey ? step * 10 : step;
    let nextValue: number;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        nextValue = value + arrowStep;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        nextValue = value - arrowStep;
        break;
      case "Home":
        nextValue = min;
        break;
      case "End":
        nextValue = max;
        break;
      default:
        return;
    }

    event.preventDefault();
    setKeyboardFocusRing(true);
    const snapped = roundValue(clamp(nextValue, min, max), step);
    animateFillTo(percentFromValue(snapped));
    onValueChange(snapped);
  }

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return undefined;

    const measure = () => {
      const trackWidth = wrapper.offsetWidth;
      if (trackWidth <= 0) return;

      const left = labelRef.current
        ? ((LABEL_OFFSET + labelRef.current.offsetWidth + HANDLE_BUFFER) / trackWidth) * 100
        : 38;
      const right = valueRef.current
        ? ((trackWidth - VALUE_OFFSET - valueRef.current.offsetWidth - HANDLE_BUFFER) /
            trackWidth) *
          100
        : 72;

      setDodge((current) =>
        current.left === left && current.right === right ? current : { left, right },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    if (labelRef.current) observer.observe(labelRef.current);
    if (valueRef.current) observer.observe(valueRef.current);
    return () => observer.disconnect();
    // Text changes alter the measured collision bounds.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [displayValue, label]);

  const valueDodgesText = percentage < dodge.left || percentage > dodge.right;
  const handleOpacity = getHandleOpacity(isActive, valueDodgesText, isDragging);
  const discreteSteps = (max - min) / step;
  const hashMarkCount = discreteSteps <= 10 ? discreteSteps - 1 : 9;

  return (
    <div ref={wrapperRef} className="elastic-slider">
      <motion.div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        data-slot="elastic-slider-track"
        data-active={isActive || undefined}
        data-disabled={disabled || undefined}
        data-focus-visible={keyboardFocusRing || undefined}
        aria-label={label}
        aria-orientation="horizontal"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={displayValue}
        aria-disabled={disabled || undefined}
        style={{ width: rubberWidth, x: rubberX }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={finishInteraction}
        onFocus={() => {
          if (!pendingPointerFocus.current) setKeyboardFocusRing(true);
        }}
        onBlur={() => setKeyboardFocusRing(false)}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <span data-slot="elastic-slider-hash-marks" aria-hidden="true">
          {Array.from({ length: hashMarkCount }, (_, index) => (
            <span
              key={index}
              className="elastic-slider-hash-mark"
              style={{
                left: `${
                  discreteSteps <= 10
                    ? (((index + 1) * step) / (max - min)) * 100
                    : (index + 1) * 10
                }%`,
              }}
            />
          ))}
        </span>

        <motion.span
          data-slot="elastic-slider-fill"
          aria-hidden="true"
          style={{ width: fillWidth }}
        />

        <motion.span
          data-slot="elastic-slider-handle"
          aria-hidden="true"
          style={{ left: handleLeft, y: "-50%" }}
          animate={{
            opacity: handleOpacity,
            scaleX: isActive ? 1 : 0.25,
            scaleY: isActive && valueDodgesText ? 0.75 : 1,
          }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : {
                  scaleX: {
                    type: "spring",
                    visualDuration: 0.25,
                    bounce: 0.15,
                  },
                  scaleY: {
                    type: "spring",
                    visualDuration: 0.2,
                    bounce: 0.1,
                  },
                  opacity: { duration: 0.15 },
                }
          }
        />

        <span ref={labelRef} data-slot="elastic-slider-label" aria-hidden="true">
          {label}
        </span>
        <span ref={valueRef} data-slot="elastic-slider-value" aria-hidden="true">
          {displayValue}
        </span>
      </motion.div>
    </div>
  );
}
