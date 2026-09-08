import { animate, cubicBezier } from "animejs";
import { play, setEnabled, setVolume } from "cuelume";
import type { TransitionConfig } from "dialkit/vanilla";
import type { ImageProcessor } from "./processor";
import { DEFAULT_RIPPLE } from "./processor";
import { createRipplePlayback, DEFAULT_RIPPLE_TIMING, type RippleTiming } from "./ripple-motion";
import type { ImageDimensions } from "./image";
import { createButtonFeedback } from "./button";
import { createIconSwap } from "./icon-swap";
import { createSlider } from "./slider";
import {
  BOUNDS_TRANSITION,
  REVEAL_TRANSITION,
  HOVER_EASE,
  MESSAGE_EASE,
  FADE_EASE,
  getRevealTiming,
  reducedMotion,
  transition,
} from "./motion";
import { createLatestUploadRunner, validateImageFile } from "./upload";
import { getThemeSnapshot, setTheme, subscribeTheme, type Theme } from "./theme";

export function mountApp() {
  // Query only within this page's lifecycle.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const get = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const input = get<HTMLInputElement>("#image-input");
  const canvas = get<HTMLCanvasElement>("#preview");
  const outgoing = get<HTMLCanvasElement>("#outgoing");
  const frame = get(".canvas-frame"),
    stage = get(".preview-stage"),
    guides = get(".frame-guides");
  const dropzone = get<HTMLButtonElement>(".dropzone"),
    clip = get(".canvas-clip"),
    surface = get(".canvas-surface");
  const outgoingBounds = get(".outgoing-bounds"),
    outgoingImage = get(".outgoing-image");
  const messageChrome = get(".message-chrome");
  let messageText = get("[data-message-text]");
  const textAnimations = new Map<HTMLElement, ReturnType<typeof animate>>();
  const iconSwap = createIconSwap();
  const selectIcon = iconSwap.select;
  const requirements = get("#image-requirements"),
    reference = get(".dropzone-reference"),
    logo = get(".logo-frame");
  const controlsSpace = get(".controls-space"),
    controls = get(".controls"),
    status = get(".status");
  const rows = [...controls.children] as HTMLElement[];
  const restartButton = get<HTMLButtonElement>("#restart"),
    downloadButton = get<HTMLButtonElement>("#download");
  const copyButton = get<HTMLButtonElement>("#copy");
  const clipboardSupported =
    typeof ClipboardItem !== "undefined" && typeof navigator.clipboard?.write === "function";
  if (!clipboardSupported) copyButton.title = "Image copying is unavailable. Use Download PNG.";
  const downloadFeedback = createButtonFeedback(downloadButton);
  const copyFeedback = createButtonFeedback(copyButton);
  const themeButton = get<HTMLButtonElement>("#theme");
  const abort = new AbortController(),
    signal = abort.signal;
  const runLatest = createLatestUploadRunner();
  const animations = new Set<ReturnType<typeof animate>>();
  let processor: ImageProcessor | undefined;
  let processorStarting = true;
  let file: File | null = null,
    dimensions: ImageDimensions | null = null;
  let busy = false,
    uploading = false,
    previewVisible = false,
    revealed = false,
    hasRevealedImage = false,
    disposed = false;
  let hovered = false,
    dragging = false,
    dragDepth = 0,
    heldReference = false;
  let error: string | null = null,
    fatal: string | null = null;
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  let boundsConfig: TransitionConfig = BOUNDS_TRANSITION,
    revealConfig: TransitionConfig = REVEAL_TRANSITION;
  let rippleSettings = { ...DEFAULT_RIPPLE };
  let rippleTiming: RippleTiming = { ...DEFAULT_RIPPLE_TIMING };
  let rippleLoop = { enabled: false, gapMs: 500 };
  let rippleReplayTimer: ReturnType<typeof setTimeout> | undefined;
  let ripplePreview = {
    paused: false,
    useTimeline: false,
    timelineProgress: 0.35,
    revealProgress: 1,
    waveProgress: 0.35,
  };
  let ripplePreviewPending = false;
  let ripplePreviewTask: Promise<void> | undefined;
  let boundsAnimation: ReturnType<typeof animate> | undefined,
    hoverAnimation: ReturnType<typeof animate> | undefined;
  let referenceAnimation: ReturnType<typeof animate> | undefined,
    messageAnimation: ReturnType<typeof animate> | undefined;
  let monochromeAnimation: ReturnType<typeof animate> | undefined;
  let monochromeTarget: string | undefined;
  let renderPending = false,
    renderTask: Promise<void> | undefined;
  let dialCleanup: (() => void) | undefined, dialElement: HTMLElement | undefined;
  const model = { width: 0, height: 0, extra: 0, inset: 0 };
  let viewport = {
    width: innerWidth,
    height: innerHeight,
    padding: 0,
    available: 0,
    gap: 24,
    emptyHeight: 288,
  };
  const paintSlider = createSlider(get('[role="slider"][aria-label="Paint"]'), requestRender);
  const brushSlider = createSlider(get('[role="slider"][aria-label="Brush"]'), requestRender);
  setEnabled(true);
  setVolume(0.5);

  function motion(target: Parameters<typeof animate>[0], options: Parameters<typeof animate>[1]) {
    const onComplete = options.onComplete;
    const animation = animate(target, {
      ...options,
      autoplay: false,
      onComplete: (completed) => {
        animations.delete(completed);
        onComplete?.(completed);
      },
    });
    animations.add(animation);
    animation.play();
    return animation;
  }
  function cancel(animation: ReturnType<typeof animate> | undefined) {
    if (!animation) return;
    animation.cancel();
    animations.delete(animation);
  }
  function readViewport() {
    const padding = Math.max(16, Math.min(48, innerWidth * 0.04));
    viewport = {
      width: innerWidth,
      height: innerHeight,
      padding,
      available: Math.min(896, innerWidth - 2 * padding),
      gap: innerWidth <= 704 ? 16 : 24,
      emptyHeight: innerWidth <= 704 ? 240 : 288,
    };
  }
  function targetGeometry() {
    if (!dimensions) return { width: viewport.available, height: viewport.emptyHeight, extra: 0 };
    const aspect = dimensions.width / dimensions.height;
    const width = Math.min(viewport.available, Math.min(aspect * 0.62, 0.9) * viewport.height);
    return { width, height: width / aspect, extra: 140 + viewport.gap };
  }
  function writeGeometry() {
    const width = Math.max(1, model.width),
      height = Math.max(1, model.height);
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    controlsSpace.style.height = `${Math.max(0, model.extra)}px`;
    controls.style.width = `${width}px`;
    // Hover expands the hit area, not the centered copy. Resizing both makes
    // grid/translate rounding move the icon between fractional pixel positions.
    messageChrome.style.width = `${width}px`;
    messageChrome.style.height = `${height}px`;
    messageChrome.style.top = "8px";
    outgoingBounds.style.width = `${width - model.inset * 2}px`;
    outgoingBounds.style.height = `${height - model.inset * 2}px`;
    outgoingBounds.style.top = `${8 + model.inset}px`;
    const left = (viewport.width - width) / 2 + model.inset;
    const top =
      Math.max(viewport.padding, (viewport.height - height - 16 - model.extra) / 2) +
      8 +
      model.inset -
      scrollY;
    guides.style.setProperty("--guide-left", `${left}px`);
    guides.style.setProperty("--guide-right", `${left + width - 2 * model.inset}px`);
    guides.style.setProperty("--guide-top", `${top}px`);
    guides.style.setProperty("--guide-bottom", `${top + height - 2 * model.inset}px`);
  }
  function moveBounds() {
    cancel(boundsAnimation);
    const timing = transition(boundsConfig);
    frame.dataset.animating = String(timing.duration > 0);
    boundsAnimation = motion(model, {
      ...targetGeometry(),
      ...timing,
      onUpdate: writeGeometry,
      onComplete: () => {
        frame.dataset.animating = "false";
        writeGeometry();
        if (!file) controlsSpace.hidden = true;
      },
    });
  }
  function syncBusy() {
    input.disabled = busy || processorStarting || !!fatal;
    dropzone.disabled = busy || processorStarting || !!fatal;
    restartButton.disabled = busy || !file || !!fatal;
    downloadButton.disabled = busy || !file || !!fatal;
    copyButton.disabled = busy || !file || !!fatal || !clipboardSupported;
    controls.inert = busy || !revealed || !!fatal;
    paintSlider.setDisabled(busy || !!fatal);
    brushSlider.setDisabled(busy || !!fatal);
  }
  function showError(message: string, persistent = false) {
    clearTimeout(errorTimer);
    error = message;
    if (persistent) fatal = message;
    status.textContent = message;
    if (!persistent)
      errorTimer = setTimeout(() => {
        error = fatal;
        status.textContent = fatal ?? "";
        updateMessage();
      }, 5000);
    syncBusy();
    updateMessage();
  }
  function changeMessage(text: string) {
    if (messageText.textContent === text) return;
    const previous = messageText;
    const parent = previous.parentElement!;
    const existing = [...parent.querySelectorAll<HTMLElement>("[data-message-text]")].find(
      (node) => node.textContent === text,
    );
    messageText = existing ?? document.createElement("strong");
    if (!existing) {
      messageText.dataset.messageText = "";
      messageText.setAttribute("aria-hidden", "true");
      messageText.textContent = text;
      Object.assign(messageText.style, {
        opacity: "0",
        transform: reducedMotion() ? "translateY(0px)" : "translateY(16px)",
        filter: reducedMotion() ? "blur(0px)" : "blur(2px)",
      });
    }
    messageText.dataset.error = String(!!error);
    delete messageText.dataset.exiting;
    parent.prepend(messageText);
    previous.dataset.exiting = "true";
    cancel(textAnimations.get(previous));
    cancel(textAnimations.get(messageText));
    const exit = motion(previous, {
      opacity: 0,
      translateY: reducedMotion() ? 0 : -16,
      filter: reducedMotion() ? "blur(0px)" : "blur(2px)",
      duration: reducedMotion() ? 0 : 300,
      ease: MESSAGE_EASE,
      onComplete: () => {
        previous.remove();
        textAnimations.delete(previous);
      },
    });
    // Zero-duration exits finish synchronously and have already removed the node.
    if (!exit.completed) textAnimations.set(previous, exit);
    const incoming = messageText;
    const enter = motion(incoming, {
      opacity: 1,
      translateY: 0,
      filter: "blur(0px)",
      duration: reducedMotion() ? 0 : 300,
      delay: reducedMotion() || existing ? 0 : 100,
      ease: MESSAGE_EASE,
      onComplete: () => textAnimations.delete(incoming),
    });
    if (!enter.completed) textAnimations.set(incoming, enter);
  }
  function updateMonochrome() {
    const monochrome = !!file && (dragging || !!error);
    const theme = getComputedStyle(document.documentElement);
    const opacity = monochrome ? Number(theme.getPropertyValue("--monochrome-opacity")) : 1;
    const filter = monochrome
      ? theme.getPropertyValue("--monochrome-filter").trim()
      : "grayscale(0) brightness(1) contrast(1)";
    const target = `${opacity}:${filter}`;
    if (target === monochromeTarget) return;
    const colorMask =
      "linear-gradient(to right,transparent,black 0%,black 100%,transparent),linear-gradient(to bottom,transparent,black 0%,black 100%,transparent)";
    const maskImage = monochrome
      ? "linear-gradient(to right,transparent,black 12%,black 88%,transparent),linear-gradient(to bottom,transparent,black 20%,black 80%,transparent)"
      : colorMask;
    const initial = monochromeTarget === undefined;
    monochromeTarget = target;
    cancel(monochromeAnimation);
    if (!canvas.style.maskImage || canvas.style.maskImage === "none")
      canvas.style.maskImage = colorMask;
    canvas.style.maskComposite = "intersect";
    monochromeAnimation = motion(canvas, {
      opacity,
      filter,
      maskImage,
      duration: initial || reducedMotion() ? 0 : 600,
      ease: HOVER_EASE,
      onComplete: () => {
        if (!monochrome) canvas.style.maskImage = "none";
      },
    });
  }
  function updateMessage() {
    const shown = !previewVisible || dragging || !!error;
    const text = error ?? (hasRevealedImage ? "Drop to replace" : "Turn an image into a painting");
    messageChrome.dataset.error = String(!!error);
    messageChrome.setAttribute("aria-hidden", String(!shown));
    requirements.hidden = hasRevealedImage;
    cancel(messageAnimation);
    messageAnimation = motion(messageChrome, {
      opacity: shown ? 1 : 0,
      filter: shown || reducedMotion() ? "blur(0px)" : "blur(4px)",
      duration: reducedMotion() ? 0 : 180,
      ease: cubicBezier(0.4, 0, 1, 1),
    });
    changeMessage(text);
    for (const icon of document.querySelectorAll<HTMLElement>("[data-message-icon]")) {
      const selected = icon.dataset.messageIcon === (error ? "error" : "upload");
      selectIcon(icon, selected, 300);
    }
    updateMonochrome();
  }
  function updateHover() {
    const expanded = !busy && (dragging || (!file && hovered));
    cancel(hoverAnimation);
    hoverAnimation = motion(model, {
      inset: expanded ? -8 : 0,
      duration: reducedMotion() ? 0 : 600,
      ease: HOVER_EASE,
      onUpdate: () => {
        dropzone.style.inset = `${model.inset}px`;
        writeGeometry();
      },
    });
    const visible =
      uploading || (previewVisible && !revealed) ? heldReference : hovered || dragging;
    cancel(referenceAnimation);
    if (!uploading && !(previewVisible && !revealed))
      referenceAnimation = motion(reference, {
        opacity: visible
          ? Number(
              getComputedStyle(document.documentElement).getPropertyValue("--monochrome-opacity"),
            )
          : 0,
        scale: visible ? 1 : 0.94,
        duration: reducedMotion() ? 0 : 600,
        ease: HOVER_EASE,
        onComplete: () => {
          if (visible) reference.style.transform = "none";
        },
      });
    stage.dataset.dragging = String(dragging);
    updateMessage();
  }
  async function captureOutgoing() {
    if (!file || !processor) return;
    const appearance = getComputedStyle(canvas);
    const style = {
      opacity: appearance.opacity,
      filter: appearance.filter,
      maskImage: appearance.maskImage,
      maskComposite: appearance.maskComposite,
    };
    await processor.snapshot(outgoing);
    Object.assign(outgoing.style, style);
    outgoingImage.style.opacity = "1";
    outgoingImage.style.filter = "none";
  }
  function clearOutgoing() {
    outgoingImage.style.opacity = "0";
    outgoing.width = outgoing.height = 0;
  }
  async function revealImage() {
    const bounds = transition(boundsConfig),
      reveal = transition(revealConfig);
    const { duration, delay } = reducedMotion()
      ? { duration: 120, delay: 0 }
      : getRevealTiming(bounds.duration, reveal.duration);
    const ease = reducedMotion() ? FADE_EASE : reveal.ease;
    const maskedReveal = !reducedMotion() && duration > 0;
    const playbackSettings = { ...rippleSettings };
    const playback = createRipplePlayback(
      duration,
      playbackSettings,
      rippleTiming,
      dimensions ?? undefined,
    );
    const ripple = { progress: 0, elapsed: 0 };
    clip.dataset.revealProgress = maskedReveal ? "0" : "1";
    if (maskedReveal) await processor!.present(0, 0, rippleSettings);
    if (disposed) return;
    const maskAnimation = maskedReveal
      ? motion(ripple, {
          progress: 1,
          duration,
          delay,
          ease,
          onUpdate: () => {
            clip.dataset.revealProgress = String(ripple.progress);
          },
        })
      : undefined;
    let rippleTask: Promise<void> | undefined;
    let rippleError: unknown;
    const rippleAnimation = maskedReveal
      ? motion(ripple, {
          elapsed: playback.duration,
          duration: playback.duration,
          delay,
          ease: "linear",
          onUpdate: () => {
            // Keep at most one GPU frame pending; slow devices skip ahead.
            if (rippleTask || rippleError || disposed) return;
            const sampled = playback.sample(ripple.elapsed);
            rippleTask = processor!
              .present(
                reducedMotion() ? 1 : ripple.progress,
                reducedMotion() ? 1 : sampled.wave,
                playbackSettings,
                reducedMotion() ? undefined : sampled,
              )
              .catch((cause) => {
                rippleError = cause;
              })
              .finally(() => {
                rippleTask = undefined;
              });
          },
        })
      : undefined;
    clip.setAttribute("aria-hidden", "false");
    surface.style.filter = "blur(0px)";
    motion(outgoingImage, {
      opacity: 0,
      filter: reducedMotion() ? "blur(0px)" : "blur(4px)",
      duration,
      delay,
      ease,
      onComplete: clearOutgoing,
    });
    if (!hasRevealedImage)
      rows.forEach((row, index) =>
        motion(row, {
          opacity: [0, 1],
          translateY: [reducedMotion() ? 0 : 32, 0],
          duration: reducedMotion() ? 0 : 1000,
          delay: reducedMotion() ? 0 : delay + duration * 0.45 + index * 200,
          ease: HOVER_EASE,
        }),
      );
    await motion(clip, { opacity: maskedReveal ? [1, 1] : [0, 1], duration, delay, ease });
    if (disposed) return;
    revealed = hasRevealedImage = true;
    updateMessage();
    await maskAnimation;
    await rippleAnimation;
    await rippleTask;
    if (disposed) return;
    if (rippleError) throw rippleError;
    if (rippleAnimation) await processor!.present(1);
    busy = false;
    syncBusy();
    updateHover();
    refreshRipplePreview();
    queueRippleReplay();
  }
  function replayRipple() {
    if (busy || disposed || !file || !processor || fatal) return;
    busy = true;
    syncBusy();
    void revealImage().catch((cause) => {
      if (disposed) return;
      busy = false;
      showError(cause instanceof Error ? cause.message : "The reveal could not replay.", true);
    });
  }
  function queueRippleReplay() {
    clearTimeout(rippleReplayTimer);
    if (
      !rippleLoop.enabled ||
      ripplePreview.paused ||
      reducedMotion() ||
      busy ||
      !file ||
      disposed ||
      fatal
    )
      return;
    rippleReplayTimer = setTimeout(replayRipple, rippleLoop.gapMs);
  }
  function refreshRipplePreview() {
    if (!import.meta.env.DEV || busy || disposed || !processor || !file || fatal) return;
    ripplePreviewPending = true;
    if (ripplePreviewTask) return;
    ripplePreviewTask = (async () => {
      while (ripplePreviewPending && !busy && !disposed) {
        ripplePreviewPending = false;
        const paused = ripplePreview.paused && !reducedMotion();
        const reveal = transition(revealConfig);
        const { duration } = getRevealTiming(transition(boundsConfig).duration, reveal.duration);
        const playback = createRipplePlayback(
          duration,
          rippleSettings,
          rippleTiming,
          dimensions ?? undefined,
        );
        const elapsed = ripplePreview.timelineProgress * playback.duration;
        const timeline = paused && ripplePreview.useTimeline;
        let progress = 1;
        if (timeline) progress = reveal.ease(duration > 0 ? Math.min(1, elapsed / duration) : 1);
        else if (paused) progress = ripplePreview.revealProgress;
        const sampled = timeline ? playback.sample(elapsed) : undefined;
        clip.style.opacity = "1";
        clip.dataset.revealProgress = String(progress);
        surface.style.filter = "blur(0px)";
        // Coalesce slider edits without refiltering or queuing stale frames.
        // oxlint-disable-next-line no-await-in-loop
        await processor!.present(
          progress,
          sampled?.wave ?? (paused ? ripplePreview.waveProgress : 1),
          rippleSettings,
          sampled,
        );
      }
    })()
      .catch((cause) =>
        showError(cause instanceof Error ? cause.message : "The ripple preview failed.", true),
      )
      .finally(() => {
        ripplePreviewTask = undefined;
      });
  }
  async function acceptFile(nextFile: File | undefined) {
    if (busy || disposed) return;
    const validation = validateImageFile(nextFile);
    if (validation || !nextFile) {
      play("error");
      showError(validation!);
      input.value = "";
      return;
    }
    if (!processor) {
      showError(fatal ?? "The image processor is starting. Try again in a moment.");
      input.value = "";
      return;
    }
    busy = true;
    uploading = true;
    heldReference = hovered || dragging;
    syncBusy();
    await runLatest(async (isCurrent) => {
      try {
        await captureOutgoing();
        previewVisible = false;
        revealed = false;
        clip.style.opacity = "0";
        clearTimeout(errorTimer);
        error = fatal;
        status.textContent = "Preparing image…";
        updateHover();
        const next = await processor!.load(
          nextFile,
          isCurrent,
          paintSlider.value / 100,
          brushSlider.value,
        );
        if (!next || !isCurrent()) return;
        file = nextFile;
        downloadFeedback.setState("idle");
        copyFeedback.setState("idle");
        dimensions = next;
        uploading = false;
        previewVisible = true;
        frame.dataset.hasFile = "true";
        controlsSpace.hidden = false;
        controls.hidden = false;
        dropzone.setAttribute("aria-label", "Replace image");
        dropzone.removeAttribute("aria-describedby");
        play("ready", { volume: 0.65 });
        status.textContent = "";
        motion(logo, { opacity: 0, ...transition(boundsConfig) });
        moveBounds();
        updateMessage();
        await revealImage();
      } catch (cause) {
        if (!isCurrent() || disposed) return;
        console.error(cause);
        previewVisible = revealed = !!file;
        clip.style.opacity = file ? "1" : "0";
        clearOutgoing();
        play("error");
        showError(fatal ?? "That image could not be processed. Try another file.");
      } finally {
        if (isCurrent() && !disposed) {
          busy = uploading = false;
          input.value = "";
          syncBusy();
          updateHover();
        }
      }
    });
  }
  function requestRender() {
    renderPending = true;
    if (renderTask || !processor || !file) return;
    renderTask = (async () => {
      while (renderPending) {
        if (disposed) return;
        renderPending = false;
        // Coalesce changes made during a GPU pass before starting the next pass.
        // oxlint-disable-next-line no-await-in-loop
        await processor!.render(paintSlider.value / 100, brushSlider.value);
      }
      refreshRipplePreview();
      queueRippleReplay();
    })()
      .catch((cause) =>
        showError(cause instanceof Error ? cause.message : "The image could not be updated.", true),
      )
      .finally(() => {
        renderTask = undefined;
      });
  }
  input.addEventListener(
    "change",
    () => {
      void acceptFile(input.files?.[0]);
    },
    { signal },
  );
  dropzone.addEventListener(
    "click",
    () => {
      if (!busy && !fatal) {
        play("press");
        input.click();
      }
    },
    { signal },
  );
  dropzone.addEventListener(
    "pointerenter",
    () => {
      hovered = true;
      updateHover();
    },
    { signal },
  );
  dropzone.addEventListener(
    "pointerleave",
    () => {
      hovered = false;
      updateHover();
    },
    { signal },
  );
  dropzone.addEventListener(
    "dragenter",
    (event) => {
      event.preventDefault();
      if (!busy) {
        dragDepth++;
        dragging = true;
        updateHover();
      }
    },
    { signal },
  );
  dropzone.addEventListener(
    "dragleave",
    (event) => {
      event.preventDefault();
      if (!busy && --dragDepth <= 0) {
        dragDepth = 0;
        dragging = false;
        updateHover();
      }
    },
    { signal },
  );
  dropzone.addEventListener(
    "dragover",
    (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? "none" : "copy";
    },
    { signal },
  );
  dropzone.addEventListener(
    "drop",
    (event) => {
      event.preventDefault();
      if (busy) return;
      const next = event.dataTransfer?.files[0];
      const upload = acceptFile(next);
      dragging = false;
      dragDepth = 0;
      updateHover();
      void upload;
    },
    { signal },
  );
  async function exportImage(action: "download" | "copy") {
    if (busy || !file || !processor || (action === "copy" && !clipboardSupported)) return;
    const imageProcessor = processor;
    const filename = file.name.replace(/\.[^.]+$/, "");
    const feedback = action === "copy" ? copyFeedback : downloadFeedback;
    busy = true;
    feedback.setState("loading");
    syncBusy();
    play("press");
    try {
      const prepared = (async () => {
        await renderTask;
        await imageProcessor.render(paintSlider.value / 100, brushSlider.value);
      })();
      if (action === "copy") {
        const png = prepared.then(() => imageProcessor.exportPng());
        try {
          // Start the write inside the click gesture. Safari accepts a promised PNG.
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        } finally {
          // Keep controls locked until encoding ends, even if permission is denied early.
          await png;
        }
      } else {
        await prepared;
        await imageProcessor.download(filename);
      }
      if (disposed) return;
      feedback.setState("success");
      play("success", { volume: 0.65 });
      status.textContent =
        action === "copy"
          ? "Painterly PNG copied to clipboard."
          : "Painterly PNG download started.";
    } catch (cause) {
      if (disposed) return;
      console.error(cause);
      feedback.setState("idle");
      play("error");
      showError(
        fatal ??
          (action === "copy"
            ? "The image could not be copied. Allow clipboard access or download the PNG."
            : "The PNG could not be downloaded. Try again."),
      );
    } finally {
      if (!disposed) {
        busy = false;
        syncBusy();
        refreshRipplePreview();
        queueRippleReplay();
      }
    }
  }
  downloadButton.addEventListener("click", () => void exportImage("download"), { signal });
  copyButton.addEventListener("click", () => void exportImage("copy"), { signal });
  restartButton.addEventListener(
    "click",
    async () => {
      if (busy || !file || !processor) return;
      downloadFeedback.setState("idle");
      copyFeedback.setState("idle");
      busy = true;
      syncBusy();
      play("droplet", { volume: 0.65 });
      try {
        await captureOutgoing();
        dragging = hovered = false;
        dragDepth = 0;
        clearTimeout(errorTimer);
        error = fatal;
        status.textContent = "";
        await Promise.all(
          rows.map((row, index) =>
            motion(row, {
              opacity: 0,
              translateY: reducedMotion() ? 0 : 32,
              duration: reducedMotion() ? 0 : 180,
              delay: reducedMotion() ? 0 : (rows.length - 1 - index) * 30,
              ease: cubicBezier(0.4, 0, 1, 1),
            }),
          ),
        );
        file = dimensions = null;
        previewVisible = revealed = hasRevealedImage = false;
        controls.hidden = true;
        processor.clear();
        clip.style.opacity = "0";
        clip.setAttribute("aria-hidden", "true");
        delete frame.dataset.hasFile;
        dropzone.setAttribute("aria-label", "Turn an image into a painting");
        dropzone.setAttribute("aria-describedby", "image-requirements");
        moveBounds();
        const timing = transition(boundsConfig);
        motion(outgoingImage, {
          opacity: 0,
          filter: reducedMotion() ? "blur(0px)" : "blur(4px)",
          ...timing,
          duration: timing.duration / 2,
          onComplete: clearOutgoing,
        });
        motion(logo, { opacity: 1, ...timing });
      } catch (cause) {
        console.error(cause);
        showError("The image could not be cleared. Try again.");
      } finally {
        busy = false;
        input.value = "";
        syncBusy();
        updateHover();
      }
    },
    { signal },
  );
  const themes = {
    system: { label: "System", next: "light" },
    light: { label: "Light", next: "dark" },
    dark: { label: "Dark", next: "system" },
  } as const;
  function updateTheme() {
    const [theme, resolved] = getThemeSnapshot().split(":") as [Theme, string];
    const description = `Theme: ${themes[theme].label}. Switch to ${themes[themes[theme].next].label}`;
    themeButton.setAttribute("aria-label", description);
    themeButton.title = description;
    for (const icon of document.querySelectorAll<HTMLElement>("[data-theme-icon]")) {
      selectIcon(icon, icon.dataset.themeIcon === theme);
    }
    if (dialElement) dialElement.dataset.theme = resolved;
    updateHover();
  }
  themeButton.addEventListener(
    "click",
    () => setTheme(themes[document.documentElement.dataset.theme as Theme].next),
    { signal },
  );
  const unsubscribeTheme = subscribeTheme(updateTheme);
  readViewport();
  Object.assign(model, targetGeometry());
  writeGeometry();
  updateTheme();
  syncBusy();
  window.addEventListener(
    "resize",
    () => {
      readViewport();
      moveBounds();
    },
    { signal },
  );
  window.addEventListener("scroll", writeGeometry, { signal, passive: true });
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  reduce.addEventListener(
    "change",
    () => {
      if (reduce.matches) for (const animation of animations) animation.complete();
      writeGeometry();
      refreshRipplePreview();
      queueRippleReplay();
    },
    { signal },
  );
  void import("./processor")
    .then(async ({ createImageProcessor }) => {
      const next = await createImageProcessor(canvas, (cause) => showError(cause.message, true));
      if (disposed) next.dispose();
      else {
        processor = next;
        processorStarting = false;
        document.documentElement.dataset.processorState = "ready";
        syncBusy();
      }
    })
    .catch((cause) => {
      if (!disposed) {
        processorStarting = false;
        document.documentElement.dataset.processorState = "error";
        showError(
          cause instanceof Error ? cause.message : "Image processing is unavailable.",
          true,
        );
      }
    });
  if (import.meta.env.DEV) {
    void Promise.all([import("dialkit/vanilla"), import("dialkit/vanilla/styles.css")]).then(
      ([{ createDialKit, createDialRoot }]) => {
        if (disposed) return;
        const root = createDialRoot({
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          onOpenChange: (open) => play(open ? "scan" : "droplet", { volume: 0.5 }),
        });
        dialElement = root.element;
        const kit = createDialKit(
          "Lukis",
          {
            bounds: { _collapsed: true, transition: BOUNDS_TRANSITION },
            reveal: { _collapsed: true, transition: REVEAL_TRANSITION },
            ripple: {
              _collapsed: true,
              replay: { type: "action", label: "Replay reveal" },
              preset: { type: "action", label: "Load impact default" },
              appearance: {
                strength: [DEFAULT_RIPPLE.strength, 0, 3, 0.05],
                height: [DEFAULT_RIPPLE.height, 0, 0.8, 0.005],
                width: [DEFAULT_RIPPLE.width, 0.05, 2, 0.005],
                broadening: [DEFAULT_RIPPLE.broadening, 0, 0.12, 0.001],
                refraction: [DEFAULT_RIPPLE.refraction, 0, 0.6, 0.01],
                dispersion: [DEFAULT_RIPPLE.dispersion, 0, 0.6, 0.005],
                colorBoost: [DEFAULT_RIPPLE.colorBoost, 0, 10, 0.1],
                sheen: [DEFAULT_RIPPLE.sheen, 0, 2, 0.01],
                shading: [DEFAULT_RIPPLE.shading, 0, 2, 0.01],
                feather: [DEFAULT_RIPPLE.feather, 0.05, 0.8, 0.01],
                blurPx: [DEFAULT_RIPPLE.blurPx, 0, 16, 0.25],
                count: [DEFAULT_RIPPLE.count, 1, 6, 1],
                spacing: [DEFAULT_RIPPLE.spacing, 0.05, 1.2, 0.01],
                echo: [DEFAULT_RIPPLE.echo, 0, 1, 0.05],
              },
              timing: {
                _collapsed: true,
                startOffsetMs: [0, -2000, 4000, 25],
                attackMs: [DEFAULT_RIPPLE_TIMING.attackMs, 0, 2000, 10],
                durationMs: [DEFAULT_RIPPLE_TIMING.durationMs, 500, 20000, 50],
                damping: [DEFAULT_RIPPLE_TIMING.damping, 0, 1, 0.01],
              },
              loop: { _collapsed: true, enabled: false, gapMs: [500, 100, 2500, 50] },
              preview: {
                _collapsed: true,
                paused: false,
                useTimeline: false,
                timelineProgress: [0.35, 0, 1, 0.01],
                revealProgress: [1, 0, 1, 0.01],
                waveProgress: [0.35, 0, 1, 0.01],
              },
              reset: { type: "action", label: "Reset ripple" },
            },
            sound: {
              _collapsed: true,
              enabled: true,
              volume: [0.5, 0, 1, 0.05] as [number, number, number, number],
            },
          },
          {
            id: "lukis",
            persist: true,
            onAction: (path) => {
              if (path === "ripple.reset" || path === "ripple.preset") {
                kit.setValues({
                  ...(path === "ripple.preset"
                    ? { reveal: { transition: REVEAL_TRANSITION } }
                    : {}),
                  ripple: {
                    appearance: { ...DEFAULT_RIPPLE },
                    timing: { ...DEFAULT_RIPPLE_TIMING },
                    loop: { enabled: false, gapMs: 500 },
                    preview: {
                      paused: false,
                      useTimeline: false,
                      timelineProgress: 0.35,
                      revealProgress: 1,
                      waveProgress: 0.35,
                    },
                  },
                });
              }
              if (path !== "ripple.replay" || busy) return;
              kit.setValue("ripple.preview.paused", false);
              replayRipple();
            },
          },
        );
        kit.subscribe((values) => {
          boundsConfig = values.bounds.transition;
          revealConfig = values.reveal.transition;
          rippleSettings = values.ripple.appearance;
          rippleTiming = values.ripple.timing;
          rippleLoop = values.ripple.loop;
          ripplePreview = values.ripple.preview;
          setEnabled(values.sound.enabled);
          setVolume(values.sound.volume);
          refreshRipplePreview();
          queueRippleReplay();
        });
        dialCleanup = () => {
          kit.destroy();
          root.destroy();
        };
      },
    );
  }
  window.addEventListener("pagehide", (event) => {
    if (event.persisted || disposed) return;
    disposed = true;
    abort.abort();
    runLatest.cancel();
    clearTimeout(errorTimer);
    clearTimeout(rippleReplayTimer);
    for (const animation of animations) animation.cancel();
    animations.clear();
    iconSwap.destroy();
    downloadFeedback.destroy();
    copyFeedback.destroy();
    paintSlider.destroy();
    brushSlider.destroy();
    unsubscribeTheme();
    dialCleanup?.();
    processor?.dispose();
  });
}
