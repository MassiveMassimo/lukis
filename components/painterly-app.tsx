"use client";

import { Button } from "@MassiveMassimo/ui";
import { IconDownload, IconRefresh, IconUpload } from "@tabler/icons-react";
import {
  type DialConfig,
  DialRoot,
  type EasingConfig,
  type TransitionConfig,
  useDialKitController,
} from "dialkit";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  type MotionStyle,
  type Transition,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  type CSSProperties,
  type DragEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ElasticSlider } from "@/components/elastic-slider";
import { getRevealDelay } from "@/lib/motion-timing";
import {
  createPainterlyProcessor,
  MAX_OUTPUT_DIMENSION,
  type ImageDimensions,
  type PainterlyProcessor,
} from "@/lib/painterly";
import {
  ACCEPTED_IMAGE_TYPES,
  createLatestUploadRunner,
  MAX_INPUT_FILE_SIZE,
  validateImageFile,
} from "@/lib/upload";

const MAX_INPUT_FILE_SIZE_MB = MAX_INPUT_FILE_SIZE / 1024 / 1024;
const HOVER_TRANSITION: Transition = {
  duration: 0.6,
  ease: [0.175, 0.885, 0.32, 1.1],
};
const UPLOAD_EXIT_TRANSITION: Transition = {
  duration: 0.2,
  ease: [0.4, 0, 1, 1],
};
const UPLOAD_ENTER_TRANSITION: Transition = {
  duration: 0.24,
  ease: [0.23, 1, 0.32, 1],
};
const RESULT_EXIT_TRANSITION: Transition = {
  duration: 0.22,
  ease: [0.4, 0, 1, 1],
};
const NO_MOTION_TRANSITION: Transition = { duration: 0 };
const REDUCED_TRANSITION: Transition = {
  duration: 0.12,
  ease: [0.23, 1, 0.32, 1],
};
const BOUNDS_TRANSITION = {
  type: "easing",
  duration: 0.3,
  ease: [1, -0.4, 0.35, 0.95],
} satisfies EasingConfig;
const REVEAL_TRANSITION = {
  type: "easing",
  duration: 0.3,
  ease: [0.22, 1, 0.36, 1],
} satisfies EasingConfig;
const BACKDROP_VARIANTS: Variants = {
  rest: { inset: "0rem" },
  hover: { inset: "-0.5rem" },
};
const REFERENCE_VARIANTS: Variants = {
  rest: { opacity: 0, scale: 0.94 },
  hover: { opacity: 0.24, scale: 1 },
};
const GUIDE_VARIANTS: Record<"top" | "right" | "bottom" | "left", Variants> = {
  top: { rest: { y: 0 }, hover: { y: -8 } },
  right: { rest: { x: 0 }, hover: { x: 8 } },
  bottom: { rest: { y: 0 }, hover: { y: 8 } },
  left: { rest: { x: 0 }, hover: { x: -8 } },
};
const UPLOAD_CHROME_VARIANTS: Variants = {
  hidden: { opacity: 0, transition: UPLOAD_EXIT_TRANSITION },
  rest: { opacity: 1, transition: UPLOAD_ENTER_TRANSITION },
  hover: { opacity: 1, transition: UPLOAD_ENTER_TRANSITION },
};
const CONTROLS_VARIANTS: Variants = {
  hidden: {
    transition: {
      staggerChildren: 0.03,
      staggerDirection: -1,
    },
  },
  visible: {
    transition: {
      delayChildren: 0.02,
      staggerChildren: 0.055,
    },
  },
};
const CONTROL_ITEM_VARIANTS: Variants = {
  hidden: {
    opacity: 0,
    transform: "translateY(0.375rem)",
    transition: {
      duration: 0.18,
      ease: [0.4, 0, 1, 1],
    },
  },
  visible: {
    opacity: 1,
    transform: "translateY(0rem)",
    transition: {
      duration: 0.22,
      ease: [0.23, 1, 0.32, 1],
    },
  },
};
const REDUCED_CONTROL_ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, transform: "translateY(0rem)" },
  visible: { opacity: 1, transform: "translateY(0rem)" },
};
const IMAGE_REVEAL_VARIANTS = {
  hidden: {
    "--edge-fade": "12%",
    "--reveal-x": "16%",
    "--reveal-y": "18%",
    filter: "blur(4px)",
    opacity: 0,
    scale: 0.88,
  },
  visible: {
    "--edge-fade": ["12%", "12%", "0%"],
    "--reveal-x": "0%",
    "--reveal-y": "0%",
    filter: "blur(0px)",
    opacity: 1,
    scale: 1,
    transition: {
      "--edge-fade": {
        times: [0, 0.7, 1],
        duration: REVEAL_TRANSITION.duration,
        ease: REVEAL_TRANSITION.ease,
      },
    },
  },
} satisfies Variants;
const DIAL_CONFIG = {
  bounds: {
    _collapsed: true,
    transition: BOUNDS_TRANSITION,
  },
  reveal: {
    _collapsed: true,
    transition: REVEAL_TRANSITION,
    startAt: [70, 0, 100, 1],
    scale: [IMAGE_REVEAL_VARIANTS.hidden.scale, 0.5, 1, 0.01],
    insetX: [16, 0, 50, 1],
    insetY: [18, 0, 50, 1],
  },
} satisfies DialConfig;

function toMotionTransition(transition: TransitionConfig): Transition {
  if (transition.type !== "easing") return transition;
  const { type: _dialKitType, ...motionTransition } = transition;
  return { ...motionTransition, type: "tween" };
}

type PreviewStyle = MotionStyle &
  CSSProperties & {
    "--preview-aspect": string;
    "--preview-max-width": string;
  };

function getPreviewStyle(dimensions: ImageDimensions | null): PreviewStyle | undefined {
  if (!dimensions) return undefined;

  const aspectRatio = dimensions.width / dimensions.height;
  return {
    "--preview-aspect": `${dimensions.width} / ${dimensions.height}`,
    "--preview-max-width": `${Math.min(aspectRatio * 62, 90)}vh`,
  };
}

interface GuideLinesProps {
  guideRef: RefObject<HTMLSpanElement | null>;
  transition: Transition;
}

function GuideLines({ guideRef, transition }: GuideLinesProps) {
  return (
    <span ref={guideRef} aria-hidden="true" className="frame-guides">
      <motion.span
        className="guide-line guide-line-top"
        variants={GUIDE_VARIANTS.top}
        transition={transition}
      />
      <motion.span
        className="guide-line guide-line-right"
        variants={GUIDE_VARIANTS.right}
        transition={transition}
      />
      <motion.span
        className="guide-line guide-line-bottom"
        variants={GUIDE_VARIANTS.bottom}
        transition={transition}
      />
      <motion.span
        className="guide-line guide-line-left"
        variants={GUIDE_VARIANTS.left}
        transition={transition}
      />
    </span>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PainterlyApp() {
  const shouldReduceMotion = useReducedMotion();
  const painterlyDial = useDialKitController("Painterly", DIAL_CONFIG, {
    id: "painterly",
    persist: true,
  });
  const { bounds, reveal } = painterlyDial.values;
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const guidesRef = useRef<HTMLSpanElement>(null);
  const guideAnimationFrameRef = useRef<number | null>(null);
  const processorRef = useRef<PainterlyProcessor | null>(null);
  const dragDepth = useRef(0);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [runLatestUpload] = useState(createLatestUploadRunner);
  const [file, setFile] = useState<File | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [strength, setStrength] = useState(78);
  const [brushSize, setBrushSize] = useState(1.4);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [processorErrorMessage, setProcessorErrorMessage] = useState<string | null>(null);
  const [previewPhase, setPreviewPhase] = useState<"hidden" | "bounds" | "visible">("hidden");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isPreviewVisible = previewPhase === "visible";
  const revealDelay = getRevealDelay(
    bounds.transition ?? BOUNDS_TRANSITION,
    reveal.startAt,
    shouldReduceMotion ?? false,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    try {
      processorRef.current = createPainterlyProcessor(canvas);
    } catch (initializationError) {
      // WebGL support can only be checked after the canvas mounts.
      const message = getErrorMessage(initializationError);
      // oxlint-disable-next-line react/set-state-in-effect
      setProcessorErrorMessage(message);
      setError(message);
      setStatus(message);
    }

    return () => {
      if (revealTimerRef.current !== null) {
        clearTimeout(revealTimerRef.current);
      }
      processorRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    processorRef.current?.render(strength / 100, brushSize);
  }, [brushSize, strength]);

  useEffect(() => {
    if (previewPhase !== "bounds") return;

    const timer = setTimeout(() => {
      revealTimerRef.current = null;
      setPreviewPhase("visible");
    }, revealDelay);
    revealTimerRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (revealTimerRef.current === timer) {
        revealTimerRef.current = null;
      }
    };
  }, [previewPhase, revealDelay]);

  const syncGuideBounds = useCallback(() => {
    const frame = frameRef.current;
    const guides = guidesRef.current;
    if (!frame || !guides) return;

    const frameBounds = frame.getBoundingClientRect();
    guides.style.setProperty("--guide-top", `${frameBounds.top}px`);
    guides.style.setProperty("--guide-bottom", `${frameBounds.bottom - 1}px`);
    guides.style.setProperty("--guide-left", `${frameBounds.left}px`);
    guides.style.setProperty("--guide-right", `${frameBounds.right - 1}px`);
  }, []);

  const startGuideSync = useCallback(() => {
    if (guideAnimationFrameRef.current !== null) {
      cancelAnimationFrame(guideAnimationFrameRef.current);
    }

    function syncNextFrame() {
      syncGuideBounds();
      guideAnimationFrameRef.current = requestAnimationFrame(syncNextFrame);
    }

    syncNextFrame();
  }, [syncGuideBounds]);

  const settleGuideSync = useCallback(() => {
    if (guideAnimationFrameRef.current !== null) {
      cancelAnimationFrame(guideAnimationFrameRef.current);
    }

    let previousBounds = "";
    let stableFrames = 0;
    let sampledFrames = 0;

    function syncUntilSettled() {
      syncGuideBounds();
      const frameBounds = frameRef.current?.getBoundingClientRect();
      const currentBounds = frameBounds
        ? [frameBounds.top, frameBounds.right, frameBounds.bottom, frameBounds.left]
            .map((value) => value.toFixed(2))
            .join(",")
        : "";

      stableFrames =
        currentBounds !== "" && currentBounds === previousBounds ? stableFrames + 1 : 0;
      previousBounds = currentBounds;
      sampledFrames += 1;

      if (stableFrames >= 2 || sampledFrames >= 30) {
        guideAnimationFrameRef.current = null;
        syncGuideBounds();
        return;
      }

      guideAnimationFrameRef.current = requestAnimationFrame(syncUntilSettled);
    }

    guideAnimationFrameRef.current = requestAnimationFrame(syncUntilSettled);
  }, [syncGuideBounds]);

  useLayoutEffect(() => {
    const resizeObserver = new ResizeObserver(syncGuideBounds);
    if (frameRef.current) resizeObserver.observe(frameRef.current);
    if (resultRef.current) resizeObserver.observe(resultRef.current);

    syncGuideBounds();
    window.addEventListener("resize", syncGuideBounds);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", syncGuideBounds);
      if (guideAnimationFrameRef.current !== null) {
        cancelAnimationFrame(guideAnimationFrameRef.current);
      }
    };
  }, [syncGuideBounds]);

  function clearFileInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  function acceptFile(nextFile: File | undefined) {
    return runLatestUpload(async (isCurrent) => {
      const validationError = validateImageFile(nextFile);
      if (validationError) {
        setIsUploading(false);
        setError(validationError);
        setStatus(validationError);
        clearFileInput();
        return;
      }

      if (!nextFile || !processorRef.current) {
        const message = processorErrorMessage ?? "The painterly processor is unavailable.";
        setError(message);
        setStatus(message);
        return;
      }

      if (revealTimerRef.current !== null) {
        clearTimeout(revealTimerRef.current);
      }
      setIsUploading(true);
      setPreviewPhase("hidden");
      setError(null);
      setStatus("Preparing image…");

      try {
        const nextDimensions = await processorRef.current.load(nextFile, isCurrent);
        if (!nextDimensions || !isCurrent()) return;

        processorRef.current.render(strength / 100, brushSize);
        setPreviewPhase("bounds");
        setFile(nextFile);
        setDimensions(nextDimensions);
        setStatus("");
      } catch (processError) {
        if (!isCurrent()) return;
        if (revealTimerRef.current !== null) {
          clearTimeout(revealTimerRef.current);
        }
        console.error(processError);
        const message = "That image could not be processed. Try another file.";
        setPreviewPhase(file ? "visible" : "hidden");
        setError(message);
        setStatus(message);
      } finally {
        if (isCurrent()) {
          setIsUploading(false);
          clearFileInput();
        }
      }
    });
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (isDownloading) return;
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    if (isDownloading) return;
    acceptFile(event.dataTransfer.files[0]);
  }

  function chooseImage() {
    inputRef.current?.click();
  }

  async function downloadImage() {
    if (!file || isUploading || isDownloading || isRestarting) return;
    const processor = processorRef.current;
    if (!processor) return;

    const filename = file.name.replace(/\.[^.]+$/, "") || "image";
    setIsDownloading(true);
    setError(null);
    setStatus("Preparing download…");

    try {
      processor.render(strength / 100, brushSize);
      await processor.download(filename);
      setStatus("Painterly PNG download started.");
    } catch (downloadError) {
      console.error(downloadError);
      const message = "The PNG could not be downloaded. Try again.";
      setError(message);
      setStatus(message);
    } finally {
      setIsDownloading(false);
    }
  }

  function restart() {
    if (isUploading || isDownloading || isRestarting) return;
    if (revealTimerRef.current !== null) {
      clearTimeout(revealTimerRef.current);
    }
    revealTimerRef.current = null;
    dragDepth.current = 0;
    setIsDragging(false);
    setIsRestarting(true);
    setPreviewPhase("hidden");
    setError(null);
    setStatus("");
  }

  function finishRestart() {
    if (!isRestarting) return;
    setFile(null);
    setDimensions(null);
    setIsRestarting(false);
    clearFileInput();
  }

  const isBusy = isUploading || isDownloading || isRestarting;
  const dropzoneDisabled = isBusy || processorErrorMessage !== null;
  const hoverTransition = shouldReduceMotion ? NO_MOTION_TRANSITION : HOVER_TRANSITION;
  const boundsTransition = shouldReduceMotion
    ? { duration: 0 }
    : toMotionTransition(bounds.transition ?? BOUNDS_TRANSITION);
  const revealTransition = shouldReduceMotion
    ? REDUCED_TRANSITION
    : toMotionTransition(reveal.transition ?? REVEAL_TRANSITION);
  const resultExitTransition = shouldReduceMotion ? REDUCED_TRANSITION : RESULT_EXIT_TRANSITION;
  const controlItemVariants = shouldReduceMotion
    ? REDUCED_CONTROL_ITEM_VARIANTS
    : CONTROL_ITEM_VARIANTS;
  const imageRevealVariants = {
    hidden: {
      ...IMAGE_REVEAL_VARIANTS.hidden,
      "--reveal-x": `${reveal.insetX}%`,
      "--reveal-y": `${reveal.insetY}%`,
      scale: reveal.scale,
    },
    visible: IMAGE_REVEAL_VARIANTS.visible,
  } satisfies Variants;
  const previewStyle = getPreviewStyle(dimensions);

  return (
    <MotionConfig reducedMotion="user">
      <div className="ds-root dark">
        <main className="app-main">
          {/* The section is a pointer drop target. Its nested button provides keyboard access. */}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <section
            className="tool-surface"
            aria-label="Painterly image processor"
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={(event) => {
              event.preventDefault();
              if (!isDownloading) event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={onDrop}
          >
            <input
              ref={inputRef}
              id="image-input"
              type="file"
              aria-hidden="true"
              tabIndex={-1}
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              disabled={isBusy}
              className="hidden-input"
              onChange={(event) => acceptFile(event.target.files?.[0])}
            />

            <motion.div ref={resultRef} className="result" initial={false} style={previewStyle}>
              <motion.div
                className="preview-stage"
                initial="rest"
                animate={isDragging ? "hover" : "rest"}
                data-dragging={isDragging || undefined}
                whileHover={!file && !dropzoneDisabled ? "hover" : "rest"}
              >
                <GuideLines guideRef={guidesRef} transition={hoverTransition} />
                <motion.div
                  ref={frameRef}
                  className="canvas-frame"
                  layout
                  transition={boundsTransition}
                  onLayoutAnimationStart={startGuideSync}
                  onLayoutAnimationComplete={settleGuideSync}
                  data-has-file={file ? "true" : undefined}
                >
                  <div className="canvas-clip" aria-hidden={!isPreviewVisible}>
                    <motion.div
                      className="canvas-surface"
                      layout
                      initial={false}
                      animate={isPreviewVisible ? "visible" : "hidden"}
                      variants={imageRevealVariants}
                      transition={isRestarting ? resultExitTransition : revealTransition}
                    >
                      <canvas ref={canvasRef} aria-label="Painterly processed image preview" />
                    </motion.div>
                  </div>
                </motion.div>

                <AnimatePresence initial={false}>
                  {!file && (
                    <motion.button
                      key="dropzone"
                      type="button"
                      disabled={dropzoneDisabled}
                      aria-label="Drop or browse an image to make it painterly"
                      aria-describedby="image-requirements"
                      data-dragging={isDragging || undefined}
                      data-uploading={isUploading || undefined}
                      className="dropzone"
                      initial="hidden"
                      animate={isDragging ? "hover" : "rest"}
                      exit="hidden"
                      variants={UPLOAD_CHROME_VARIANTS}
                      onClick={chooseImage}
                    >
                      <motion.span aria-hidden="true" className="dropzone-monogram" />
                      <motion.span
                        aria-hidden="true"
                        className="dropzone-backdrop"
                        variants={BACKDROP_VARIANTS}
                        transition={hoverTransition}
                      >
                        <motion.span
                          className="dropzone-reference"
                          variants={REFERENCE_VARIANTS}
                          transition={hoverTransition}
                        />
                      </motion.span>
                      <span className="dropzone-content">
                        <span className="upload-icon">
                          <IconUpload aria-hidden="true" size={18} strokeWidth={1.5} />
                        </span>
                        <span>
                          <strong>Drop or browse an image to make it painterly</strong>
                          <small id="image-requirements">
                            PNG, JPEG, WebP · max {MAX_INPUT_FILE_SIZE_MB} MB · output up to{" "}
                            {MAX_OUTPUT_DIMENSION}px
                          </small>
                        </span>
                      </span>
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>

              <AnimatePresence initial={false} onExitComplete={finishRestart}>
                {file && !isRestarting && (
                  <motion.div
                    key="controls"
                    className="controls"
                    initial="hidden"
                    animate={isPreviewVisible ? "visible" : "hidden"}
                    exit="hidden"
                    variants={CONTROLS_VARIANTS}
                  >
                    <motion.div className="control-row" variants={controlItemVariants}>
                      <ElasticSlider
                        label="Paint"
                        value={strength}
                        onValueChange={setStrength}
                        min={0}
                        max={100}
                        step={1}
                        formatValue={(value) => `${value}%`}
                        disabled={isBusy}
                      />
                    </motion.div>
                    <motion.div className="control-row" variants={controlItemVariants}>
                      <ElasticSlider
                        label="Brush"
                        value={brushSize}
                        onValueChange={setBrushSize}
                        min={0.7}
                        max={3}
                        step={0.1}
                        formatValue={(value) => value.toFixed(1)}
                        disabled={isBusy}
                      />
                    </motion.div>
                    <motion.div className="control-actions" variants={controlItemVariants}>
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label="Restart with another image"
                        title="Restart"
                        onClick={restart}
                        disabled={isBusy}
                      >
                        <IconRefresh aria-hidden="true" className="action-icon" />
                      </Button>
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label="Download painterly PNG"
                        title="Download PNG"
                        onClick={downloadImage}
                        loading={isDownloading}
                        disabled={isUploading || isRestarting}
                      >
                        <IconDownload aria-hidden="true" className="action-icon" />
                      </Button>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            <p className={error ? "status error" : "status status-sr-only"} aria-live="polite">
              {status}
            </p>
          </section>
        </main>
        <DialRoot theme="dark" />
      </div>
    </MotionConfig>
  );
}
