"use client";

import { Button } from "@MassiveMassimo/ui";
import { IconAlertCircle, IconDownload, IconRefresh, IconUpload } from "@tabler/icons-react";
import { play, setEnabled, setVolume } from "cuelume";
import { cancelFrame, frame as motionFrame, spring } from "motion";
import {
  type DialConfig,
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
  useMotionValue,
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

import { ElasticSlider, SLIDER_MAX_STRETCH } from "@/components/elastic-slider";
import { ThemeControls } from "@/components/theme-controls";
import { getRevealTiming, getTransitionDuration } from "@/lib/motion-timing";
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
const ERROR_DISPLAY_MS = 5_000;
const MESSAGE_CHANGE_DURATION = 0.3;
const HOVER_TRANSITION: Transition = {
  duration: 0.6,
  ease: [0.175, 0.885, 0.32, 1.1],
};
const NO_MOTION_TRANSITION: Transition = { duration: 0 };
const REDUCED_TRANSITION: Transition = {
  type: "tween",
  duration: 0.12,
  ease: [0.23, 1, 0.32, 1],
};
const BOUNDS_TRANSITION = {
  type: "easing",
  duration: 1.2,
  ease: [0.6, -0.35, 0, 1],
} satisfies EasingConfig;
const REVEAL_TRANSITION = {
  type: "easing",
  duration: 1,
  ease: [0.35, 0, 0, 1],
} satisfies EasingConfig;
const MONOCHROME_STYLE = {
  opacity: "var(--monochrome-opacity)",
  filter: "var(--monochrome-filter)",
  maskImage:
    "linear-gradient(to right, transparent 0%, black 12%, black 88%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 20%, black 80%, transparent 100%)",
};
const COLOR_STYLE = {
  opacity: 1,
  filter: "grayscale(0) brightness(1) contrast(1)",
  maskImage:
    "linear-gradient(to right, transparent 0%, black 0%, black 100%, transparent 100%), linear-gradient(to bottom, transparent 0%, black 0%, black 100%, transparent 100%)",
};
const REFERENCE_VARIANTS: Variants = {
  rest: { ...MONOCHROME_STYLE, opacity: 0, scale: 0.94 },
  hover: { ...MONOCHROME_STYLE, scale: 1 },
};
const CONTROL_ITEM_VARIANTS: Variants = {
  hidden: {
    opacity: 0,
    transform: "translateY(2rem)",
    transition: {
      duration: 0.18,
      ease: [0.4, 0, 1, 1],
    },
  },
  visible: {
    opacity: 1,
    transform: "translateY(0rem)",
    transition: {
      duration: 1,
      ease: [0.175, 0.885, 0.32, 1.1],
    },
  },
};
const REDUCED_CONTROL_ITEM_VARIANTS: Variants = {
  hidden: { opacity: 0, transform: "translateY(0rem)" },
  visible: { opacity: 1, transform: "translateY(0rem)" },
};
const IMAGE_REVEAL_VARIANTS = {
  hidden: {
    opacity: 0,
  },
  visible: {
    opacity: 1,
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
  },
  sound: {
    _collapsed: true,
    enabled: true,
    volume: [0.5, 0, 1, 0.05],
  },
} satisfies DialConfig;

function toMotionTransition(transition: TransitionConfig): Transition {
  if (transition.type === "spring") {
    const duration = getTransitionDuration(transition);
    const curve = spring({ ...transition, keyframes: [0, 1] });
    const end = curve.next(duration * 1000).value;
    return {
      type: "tween",
      duration,
      ease: (progress: number) =>
        end === 0 ? progress : curve.next(progress * duration * 1000).value / end,
    };
  }
  const { type: _dialKitType, ...motionTransition } = transition;
  return { ...motionTransition, type: "tween" };
}

function setStyleProperty(element: HTMLElement | null, property: string, value: string) {
  if (element && element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
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
}

function GuideLines({ guideRef }: GuideLinesProps) {
  return (
    <span ref={guideRef} aria-hidden="true" className="frame-guides">
      <span className="guide-line guide-line-top max-[44rem]:mask-none!" />
      <span className="guide-line guide-line-right" />
      <span className="guide-line guide-line-bottom max-[44rem]:mask-none!" />
      <span className="guide-line guide-line-left" />
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
  const { bounds, reveal, sound } = painterlyDial.values;
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const outgoingCanvasRef = useRef<HTMLCanvasElement>(null);
  const outgoingBoundsRef = useRef<HTMLSpanElement>(null);
  const previewCoverScale = useMotionValue(1);
  const frameRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const messageChromeRef = useRef<HTMLSpanElement>(null);
  const imageBoundsRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const guidesRef = useRef<HTMLSpanElement>(null);
  const geometrySyncScheduled = useRef(false);
  const processorRef = useRef<PainterlyProcessor | null>(null);
  const dragDepth = useRef(0);
  const interactionLockedRef = useRef(false);
  const [runLatestUpload] = useState(createLatestUploadRunner);
  const [file, setFile] = useState<File | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [strength, setStrength] = useState(78);
  const [brushSize, setBrushSize] = useState(1.4);
  const [isDragging, setIsDragging] = useState(false);
  const [isPreviewHovered, setIsPreviewHovered] = useState(false);
  const [uploadReferenceVisible, setUploadReferenceVisible] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [processorErrorMessage, setProcessorErrorMessage] = useState<string | null>(null);
  const [isPreviewVisible, setIsPreviewVisible] = useState(false);
  const [status, setStatus] = useState("");
  const [temporaryError, setTemporaryError] = useState<{ message: string } | null>(null);
  const error = processorErrorMessage ?? temporaryError?.message ?? null;
  const [isRevealComplete, setIsRevealComplete] = useState(false);
  const [hasRevealedImage, setHasRevealedImage] = useState(false);
  const [hasOutgoingImage, setHasOutgoingImage] = useState(false);
  const revealTiming = getRevealTiming(
    getTransitionDuration(bounds.transition ?? BOUNDS_TRANSITION),
    getTransitionDuration(reveal.transition ?? REVEAL_TRANSITION),
    shouldReduceMotion ?? false,
  );

  useEffect(() => {
    setEnabled(sound.enabled);
    setVolume(sound.volume);
  }, [sound.enabled, sound.volume]);

  useEffect(() => {
    if (!temporaryError) return;
    const timeout = window.setTimeout(() => {
      setTemporaryError(null);
      setStatus((current) => (current === temporaryError.message ? "" : current));
    }, ERROR_DISPLAY_MS);
    return () => window.clearTimeout(timeout);
  }, [temporaryError]);

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
      setStatus(message);
    }

    return () => {
      runLatestUpload.cancel();
      processorRef.current?.dispose();
      processorRef.current = null;
    };
  }, [runLatestUpload]);

  useEffect(() => {
    processorRef.current?.render(strength / 100, brushSize);
  }, [brushSize, strength]);

  const syncGeometry = useCallback(() => {
    const frame = frameRef.current;
    const guides = guidesRef.current;
    if (!frame || !guides) return;

    const frameBounds = frame.getBoundingClientRect();
    const imageBounds = imageBoundsRef.current?.getBoundingClientRect() ?? frameBounds;
    const stageBounds = frame.offsetParent?.getBoundingClientRect();
    const layoutBottom = stageBounds ? stageBounds.top + frame.offsetTop + frame.offsetHeight : 0;
    const canvasStyle = canvasRef.current ? getComputedStyle(canvasRef.current) : null;
    const width = canvasStyle ? Number.parseFloat(canvasStyle.width) : 0;
    const height = canvasStyle ? Number.parseFloat(canvasStyle.height) : 0;

    // Read all geometry before updating the image, guides, or unscaled UI overlays.
    if (stageBounds) {
      const outgoingBounds = outgoingBoundsRef.current;
      setStyleProperty(outgoingBounds, "width", `${imageBounds.width}px`);
      setStyleProperty(outgoingBounds, "height", `${imageBounds.height}px`);
      setStyleProperty(
        outgoingBounds,
        "transform",
        `translate(${imageBounds.left - stageBounds.left}px, ${imageBounds.top - stageBounds.top}px)`,
      );
      const chrome = messageChromeRef.current;
      setStyleProperty(chrome, "width", `${frameBounds.width}px`);
      setStyleProperty(chrome, "height", `${frameBounds.height}px`);
      setStyleProperty(
        chrome,
        "transform",
        `translate(${frameBounds.left - stageBounds.left}px, ${frameBounds.top - stageBounds.top}px)`,
      );
      const controls = controlsRef.current;
      setStyleProperty(controls, "width", `${frameBounds.width}px`);
      setStyleProperty(controls, "transform", `translateY(${frameBounds.bottom - layoutBottom}px)`);
    }

    // Cover the moving bounds with one uniform scale so the image keeps its proportions.
    if (width > 0 && height > 0) {
      previewCoverScale.set(Math.max(imageBounds.width / width, imageBounds.height / height));
    }
    setStyleProperty(guides, "--guide-top", `${imageBounds.top}px`);
    setStyleProperty(guides, "--guide-bottom", `${imageBounds.bottom - 1}px`);
    setStyleProperty(guides, "--guide-left", `${imageBounds.left}px`);
    setStyleProperty(guides, "--guide-right", `${imageBounds.right - 1}px`);
  }, [previewCoverScale]);

  const scheduleGeometrySync = useCallback(() => {
    if (geometrySyncScheduled.current) return;
    geometrySyncScheduled.current = true;
    // Coalesce Motion and observer notifications after projection writes, before paint.
    queueMicrotask(() => {
      geometrySyncScheduled.current = false;
      syncGeometry();
    });
  }, [syncGeometry]);

  const startGeometrySync = useCallback(() => {
    cancelFrame(scheduleGeometrySync);
    motionFrame.postRender(scheduleGeometrySync, true);
  }, [scheduleGeometrySync]);

  const settleGeometrySync = useCallback(() => {
    cancelFrame(scheduleGeometrySync);
    motionFrame.postRender(scheduleGeometrySync);
  }, [scheduleGeometrySync]);

  useLayoutEffect(() => {
    const resizeObserver = new ResizeObserver(scheduleGeometrySync);
    // Include Motion's first layout transform, before its animation callbacks start.
    const frameObserver = new MutationObserver(scheduleGeometrySync);
    if (frameRef.current) {
      resizeObserver.observe(frameRef.current);
      frameObserver.observe(frameRef.current, { attributes: true, attributeFilter: ["style"] });
    }
    if (resultRef.current) resizeObserver.observe(resultRef.current);

    syncGeometry();
    window.addEventListener("resize", scheduleGeometrySync);
    return () => {
      resizeObserver.disconnect();
      frameObserver.disconnect();
      window.removeEventListener("resize", scheduleGeometrySync);
      cancelFrame(scheduleGeometrySync);
    };
  }, [scheduleGeometrySync, syncGeometry]);

  function clearFileInput() {
    if (inputRef.current) inputRef.current.value = "";
  }

  function showError(message: string) {
    setTemporaryError({ message });
    setStatus(message);
  }

  function captureOutgoingImage() {
    const canvas = canvasRef.current;
    const outgoing = outgoingCanvasRef.current;
    const context = outgoing?.getContext("2d");
    if (!file || !canvas || !outgoing || !context) return;

    // Freeze pixels and their current treatment before replacing or clearing the frame.
    outgoing.width = canvas.width;
    outgoing.height = canvas.height;
    context.drawImage(canvas, 0, 0);
    const appearance = getComputedStyle(canvas);
    outgoing.style.opacity = appearance.opacity;
    outgoing.style.filter = appearance.filter;
    outgoing.style.maskImage = appearance.maskImage;
    setHasOutgoingImage(true);
  }

  function acceptFile(nextFile: File | undefined) {
    if (interactionLockedRef.current) return;

    const validationError = validateImageFile(nextFile);
    if (validationError) {
      if (nextFile) play("error");
      showError(validationError);
      clearFileInput();
      return;
    }

    const processor = processorRef.current;
    if (!nextFile || !processor) {
      if (nextFile) play("error");
      const message = processorErrorMessage ?? "The painterly processor is unavailable.";
      showError(message);
      return;
    }

    interactionLockedRef.current = true;
    captureOutgoingImage();
    setUploadReferenceVisible(isPreviewHovered || isDragging);
    return runLatestUpload(async (isCurrent) => {
      setIsRevealComplete(false);
      setIsUploading(true);
      setIsPreviewVisible(false);
      setTemporaryError(null);
      setStatus("Preparing image…");

      try {
        const nextDimensions = await processor.load(nextFile, isCurrent);
        if (!nextDimensions || !isCurrent()) return;

        processor.render(strength / 100, brushSize);
        play("ready", { volume: 0.65 });
        setIsPreviewVisible(true);
        setFile(nextFile);
        setDimensions(nextDimensions);
        setTemporaryError(null);
        setStatus("");
      } catch (processError) {
        if (!isCurrent()) return;
        play("error");
        console.error(processError);
        const message = "That image could not be processed. Try another file.";
        setIsPreviewVisible(Boolean(file));
        setHasOutgoingImage(false);
        showError(message);
      } finally {
        if (isCurrent()) {
          interactionLockedRef.current = false;
          setIsUploading(false);
          clearFileInput();
        }
      }
    });
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    if (interactionLockedRef.current) return;
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
    if (interactionLockedRef.current) return;
    acceptFile(event.dataTransfer.files[0]);
  }

  function chooseImage() {
    play("press");
    inputRef.current?.click();
  }

  async function downloadImage() {
    if (!file || interactionLockedRef.current) return;
    const processor = processorRef.current;
    if (!processor) return;

    play("press");
    const filename = file.name.replace(/\.[^.]+$/, "") || "image";
    interactionLockedRef.current = true;
    setIsDownloading(true);
    setTemporaryError(null);
    setStatus("Preparing download…");

    try {
      processor.render(strength / 100, brushSize);
      await processor.download(filename);
      play("success", { volume: 0.65 });
      setStatus("Painterly PNG download started.");
    } catch (downloadError) {
      play("error");
      console.error(downloadError);
      const message = "The PNG could not be downloaded. Try again.";
      showError(message);
    } finally {
      interactionLockedRef.current = false;
      setIsDownloading(false);
    }
  }

  function restart() {
    if (interactionLockedRef.current) return;
    captureOutgoingImage();
    play("droplet", { volume: 0.65 });
    interactionLockedRef.current = true;
    dragDepth.current = 0;
    setIsDragging(false);
    setIsRestarting(true);
    setTemporaryError(null);
    setStatus("");
  }

  function finishRestart() {
    if (!isRestarting) return;
    setIsPreviewVisible(false);
    setFile(null);
    setDimensions(null);
    setHasRevealedImage(false);
    interactionLockedRef.current = false;
    setIsRestarting(false);
    clearFileInput();
  }

  const isBusy = isUploading || isDownloading || isRestarting;
  const isReplacing = Boolean(file) && isDragging && !isBusy;
  const showImageMessage = Boolean(file) && (isReplacing || Boolean(error));
  const MessageIcon = error ? IconAlertCircle : IconUpload;
  const dropzoneDisabled = isBusy || processorErrorMessage !== null;
  const isFrameExpanded = isDragging || (!file && isPreviewHovered && !dropzoneDisabled);
  const showMessage = !isPreviewVisible || showImageMessage;
  const isReferenceVisible =
    isUploading || (isPreviewVisible && !isRevealComplete)
      ? uploadReferenceVisible
      : isPreviewHovered || isDragging;
  const showReplacementMessage = hasRevealedImage && !isRestarting;
  const message =
    error ??
    (showReplacementMessage ? "Drop to replace" : "Drop or browse an image to make it painterly");
  const hoverTransition = shouldReduceMotion ? NO_MOTION_TRANSITION : HOVER_TRANSITION;
  const boundsTransition = shouldReduceMotion
    ? { duration: 0 }
    : toMotionTransition(bounds.transition ?? BOUNDS_TRANSITION);
  const revealTransition = shouldReduceMotion
    ? REDUCED_TRANSITION
    : { ...toMotionTransition(reveal.transition ?? REVEAL_TRANSITION), ...revealTiming };
  const clearTransition = {
    ...boundsTransition,
    duration: shouldReduceMotion
      ? 0
      : getTransitionDuration(bounds.transition ?? BOUNDS_TRANSITION) / 2,
  };
  const opacityTransition =
    isUploading || (hasOutgoingImage && !file)
      ? NO_MOTION_TRANSITION
      : isPreviewVisible
        ? revealTransition
        : clearTransition;
  const blurTransition = shouldReduceMotion ? NO_MOTION_TRANSITION : opacityTransition;
  const holdOutgoingImage = isUploading || isRestarting;
  const controlVariants = {
    hidden: {
      transition: {
        staggerChildren: 0.03,
        staggerDirection: -1,
      },
    },
    visible: {
      transition: {
        delayChildren: shouldReduceMotion ? 0 : revealTiming.delay + revealTiming.duration * 0.45,
        staggerChildren: shouldReduceMotion ? 0 : 0.2,
      },
    },
  } satisfies Variants;
  const controlItemVariants = shouldReduceMotion
    ? REDUCED_CONTROL_ITEM_VARIANTS
    : CONTROL_ITEM_VARIANTS;
  const imageRevealVariants = {
    hidden: {
      ...IMAGE_REVEAL_VARIANTS.hidden,
      transition: shouldReduceMotion ? NO_MOTION_TRANSITION : undefined,
    },
    visible: {
      ...IMAGE_REVEAL_VARIANTS.visible,
      transition: shouldReduceMotion ? NO_MOTION_TRANSITION : revealTransition,
    },
  } satisfies Variants;
  const previewStyle = getPreviewStyle(dimensions);

  return (
    <MotionConfig reducedMotion="user">
      <div className="ds-root min-h-screen bg-background text-foreground antialiased [--page-padding:clamp(1rem,4vw,3rem)]">
        <main className="app-main grid min-h-screen place-items-center p-(--page-padding)">
          <section
            className="tool-surface relative isolate grid w-full max-w-4xl gap-4"
            aria-label="Painterly image processor"
          >
            <input
              ref={inputRef}
              id="image-input"
              type="file"
              aria-hidden="true"
              tabIndex={-1}
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              disabled={isBusy}
              className="sr-only"
              onChange={(event) => acceptFile(event.target.files?.[0])}
            />

            <motion.div
              ref={resultRef}
              className="result grid w-full grid-cols-1 gap-6 max-[44rem]:gap-4"
              initial={false}
              style={previewStyle}
            >
              <div
                className="preview-stage relative grid place-items-center py-2"
                data-dragging={isDragging || undefined}
              >
                <GuideLines guideRef={guidesRef} />
                <motion.div
                  aria-hidden="true"
                  className="pointer-events-none fixed top-[calc(50%-0.5rem)] left-1/2 z-3 h-72 w-[min(calc(100vw-var(--page-padding)-var(--page-padding)),56rem)] -translate-x-1/2 -translate-y-1/2 max-[44rem]:h-60"
                  initial={false}
                  animate={{ opacity: file ? 0 : 1 }}
                  transition={boundsTransition}
                >
                  <span className="dropzone-monogram" />
                </motion.div>
                <motion.div
                  ref={frameRef}
                  className="canvas-frame pointer-events-none relative isolate z-4 grid h-72 w-full mask-none! data-[has-file=true]:aspect-[var(--preview-aspect,1)] data-[has-file=true]:h-auto data-[has-file=true]:w-[min(100%,var(--preview-max-width,56rem))] max-[44rem]:not-data-[has-file=true]:h-60"
                  layout
                  transition={boundsTransition}
                  onLayoutAnimationStart={startGeometrySync}
                  onLayoutAnimationComplete={settleGeometrySync}
                  data-has-file={file ? "true" : undefined}
                >
                  <motion.button
                    ref={imageBoundsRef}
                    type="button"
                    disabled={dropzoneDisabled}
                    aria-label={
                      file ? "Replace image" : "Drop or browse an image to make it painterly"
                    }
                    aria-describedby={!file ? "image-requirements" : undefined}
                    className="image-bounds dropzone group pointer-events-auto absolute inset-0 grid cursor-pointer overflow-hidden border-0 bg-background p-0 text-foreground outline-none disabled:cursor-wait"
                    animate={{ inset: isFrameExpanded ? "-0.5rem" : "0rem" }}
                    transition={hoverTransition}
                    onUpdate={() => motionFrame.postRender(scheduleGeometrySync)}
                    onHoverStart={() => setIsPreviewHovered(true)}
                    onHoverEnd={() => setIsPreviewHovered(false)}
                    onDragEnter={onDragEnter}
                    onDragLeave={onDragLeave}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = interactionLockedRef.current
                        ? "none"
                        : "copy";
                    }}
                    onDrop={onDrop}
                    onClick={chooseImage}
                  >
                    <motion.span
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-1/2 h-72 w-[min(calc(100vw-var(--page-padding)-var(--page-padding)),56rem)] -translate-x-1/2 -translate-y-1/2 max-[44rem]:h-60"
                      layout="position"
                      layoutAnchor={{ x: 0.5, y: 0.5 }}
                      transition={{ layout: NO_MOTION_TRANSITION }}
                    >
                      <motion.span
                        className="dropzone-reference"
                        style={{ maskComposite: "intersect" }}
                        initial="rest"
                        animate={isReferenceVisible ? "hover" : "rest"}
                        variants={REFERENCE_VARIANTS}
                        transition={hoverTransition}
                      />
                    </motion.span>
                    <motion.span
                      className="canvas-clip pointer-events-none relative z-1 grid size-full origin-center rounded-none bg-background"
                      style={{ filter: "none", transform: "none" }}
                      aria-hidden={!isPreviewVisible}
                      onAnimationComplete={(definition) => {
                        if (definition === "visible") {
                          setIsRevealComplete(true);
                          setHasRevealedImage(true);
                        }
                      }}
                      initial={IMAGE_REVEAL_VARIANTS.hidden}
                      animate={isPreviewVisible ? "visible" : "hidden"}
                      variants={imageRevealVariants}
                      transition={opacityTransition}
                    >
                      <motion.span
                        className="canvas-surface grid size-full"
                        layout="position"
                        layoutAnchor={{ x: 0.5, y: 0.5 }}
                        initial={{ filter: "blur(4px)" }}
                        animate={{
                          filter:
                            shouldReduceMotion || isPreviewVisible ? "blur(0px)" : "blur(4px)",
                        }}
                        transition={{
                          layout: NO_MOTION_TRANSITION,
                          filter: blurTransition,
                        }}
                      >
                        <motion.canvas
                          className="block size-full object-cover"
                          style={{ scale: previewCoverScale, maskComposite: "intersect" }}
                          animate={showImageMessage ? MONOCHROME_STYLE : COLOR_STYLE}
                          transition={hoverTransition}
                          ref={canvasRef}
                          aria-label="Painterly processed image preview"
                        />
                      </motion.span>
                    </motion.span>
                  </motion.button>
                </motion.div>
                <span
                  ref={outgoingBoundsRef}
                  aria-hidden="true"
                  className="outgoing-bounds pointer-events-none absolute top-0 left-0 z-4 overflow-hidden"
                >
                  <motion.span
                    className="outgoing-image block size-full bg-background"
                    initial={false}
                    animate={{
                      opacity: hasOutgoingImage && holdOutgoingImage ? 1 : 0,
                      filter:
                        !hasOutgoingImage || shouldReduceMotion || holdOutgoingImage
                          ? "blur(0px)"
                          : "blur(4px)",
                    }}
                    transition={
                      holdOutgoingImage
                        ? NO_MOTION_TRANSITION
                        : file
                          ? revealTransition
                          : clearTransition
                    }
                    onAnimationComplete={() => {
                      if (!holdOutgoingImage) {
                        setHasOutgoingImage(false);
                        const outgoing = outgoingCanvasRef.current;
                        if (outgoing) {
                          outgoing.width = 0;
                          outgoing.height = 0;
                        }
                      }
                    }}
                  >
                    <canvas
                      ref={outgoingCanvasRef}
                      className="block size-full object-cover"
                      style={{ maskComposite: "intersect" }}
                    />
                  </motion.span>
                </span>
                <motion.span
                  ref={messageChromeRef}
                  className="message-chrome pointer-events-none absolute inset-0 z-5 grid content-center justify-items-center gap-2 px-4 text-center data-[error=true]:text-destructive"
                  data-error={Boolean(error)}
                  aria-hidden={!showMessage}
                  initial={false}
                  animate={{
                    opacity: showMessage ? 1 : 0,
                    filter: showMessage || shouldReduceMotion ? "blur(0px)" : "blur(4px)",
                  }}
                  transition={
                    shouldReduceMotion
                      ? NO_MOTION_TRANSITION
                      : { duration: 0.18, ease: [0.4, 0, 1, 1] }
                  }
                >
                  <span className="relative grid size-9 place-items-center" aria-hidden="true">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={error ? "error" : "upload"}
                        data-message-icon={error ? "error" : "upload"}
                        data-error={Boolean(error)}
                        className="col-start-1 row-start-1 grid size-9 place-items-center text-muted-foreground data-[error=true]:text-destructive"
                        initial={{
                          opacity: 0,
                          transform: shouldReduceMotion ? "scale(1)" : "scale(0.25)",
                          filter: shouldReduceMotion ? "blur(0px)" : "blur(4px)",
                        }}
                        animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
                        exit={{
                          opacity: 0,
                          transform: shouldReduceMotion ? "scale(1)" : "scale(0.25)",
                          filter: shouldReduceMotion ? "blur(0px)" : "blur(4px)",
                        }}
                        transition={{
                          type: "spring",
                          duration: MESSAGE_CHANGE_DURATION,
                          bounce: 0,
                        }}
                      >
                        <MessageIcon size={18} strokeWidth={1.5} />
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  <span className="grid w-full max-w-lg min-w-0 gap-0.5">
                    <span className="relative block min-w-0 text-sm leading-[1.4]">
                      <AnimatePresence
                        key={isRestarting ? "restart" : "messages"}
                        mode="popLayout"
                        initial={false}
                      >
                        <motion.strong
                          key={message}
                          data-message-text
                          data-error={Boolean(error)}
                          aria-hidden="true"
                          className="block font-medium text-foreground data-[error=true]:text-destructive"
                          initial={{
                            opacity: 0,
                            y: shouldReduceMotion ? 0 : 16,
                            filter: shouldReduceMotion ? "blur(0px)" : "blur(2px)",
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                            filter: "blur(0px)",
                            transition: shouldReduceMotion
                              ? NO_MOTION_TRANSITION
                              : { duration: MESSAGE_CHANGE_DURATION, delay: 0.1 },
                          }}
                          exit={{
                            opacity: 0,
                            y: shouldReduceMotion ? 0 : -16,
                            filter: shouldReduceMotion ? "blur(0px)" : "blur(2px)",
                          }}
                          transition={
                            shouldReduceMotion
                              ? NO_MOTION_TRANSITION
                              : { duration: MESSAGE_CHANGE_DURATION }
                          }
                        >
                          {message}
                        </motion.strong>
                      </AnimatePresence>
                    </span>
                    {!showReplacementMessage && (
                      <small
                        className="text-xs leading-[1.4] text-muted-foreground"
                        id="image-requirements"
                      >
                        PNG, JPEG, WebP · max {MAX_INPUT_FILE_SIZE_MB} MB · output up to{" "}
                        {MAX_OUTPUT_DIMENSION}px
                      </small>
                    )}
                  </span>
                </motion.span>
              </div>

              <AnimatePresence initial={false} onExitComplete={finishRestart}>
                {file && !isRestarting && (
                  <motion.div
                    key="controls"
                    ref={controlsRef}
                    className="controls grid w-[min(100%,var(--preview-max-width,56rem))] gap-4 justify-self-center"
                    style={{ paddingInline: SLIDER_MAX_STRETCH }}
                    inert={!isRevealComplete}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    variants={controlVariants}
                  >
                    <motion.div
                      className="control-row grid w-full max-w-lg justify-self-center"
                      variants={controlItemVariants}
                    >
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
                    <motion.div
                      className="control-row grid w-full max-w-lg justify-self-center"
                      variants={controlItemVariants}
                    >
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
                    <motion.div
                      className="control-actions flex w-full max-w-lg items-center justify-between justify-self-center"
                      variants={controlItemVariants}
                    >
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label="Restart with another image"
                        title="Restart"
                        onClick={restart}
                        disabled={isBusy}
                      >
                        <IconRefresh aria-hidden="true" className="block" />
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
                        <IconDownload aria-hidden="true" className="block" />
                      </Button>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            <p className="status sr-only" aria-live="polite" aria-atomic="true">
              {status}
            </p>
          </section>
        </main>
        <ThemeControls />
      </div>
    </MotionConfig>
  );
}
