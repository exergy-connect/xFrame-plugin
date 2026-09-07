importScripts("recordingStore.js", "gifEncode.js");

// Handle the action explicitly so the toolbar gesture invokes the extension
// on the active tab as well as opening the persistent recording controls.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  .catch((error) => console.error("Could not configure xFrame side panel", error));

chrome.action.onClicked.addListener((tab) => {
  // Call open directly within the gesture; do not await other work first.
  chrome.sidePanel.open({ windowId: tab.windowId })
    .catch((error) => console.error("Could not open xFrame side panel", error));
});

const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);
const EXTENSION_ORIGIN = chrome.runtime.getURL("/");
const SESSION_STORAGE_KEY = "frameitSession";
const SNAPSHOT_MODE_KEY = "snapshotMode";
const SNAPSHOT_DELAY_KEY = "snapshotDelay";
const SNAPSHOT_LINKEDIN_KEY = "snapshotLinkedIn";
const SNAPSHOT_FORMAT_KEY = "snapshotFormat";
const SNAPSHOT_JPG_KEY = "snapshotJpg"; // legacy boolean → migrated to format
const DEFAULT_SNAPSHOT_MODE = "full";
const DEFAULT_SNAPSHOT_DELAY = 5;
const DEFAULT_SNAPSHOT_LINKEDIN = false;
const DEFAULT_SNAPSHOT_FORMAT = "png";
/** LinkedIn feed image pixel size. */
const LINKEDIN_WIDTH = 1280;
const LINKEDIN_HEIGHT = 644;
/** High-quality JPEG encode quality (0–1) for A/B tests vs PNG. */
const JPEG_QUALITY = 0.95;

/** Recording quality presets → MediaRecorder bitrates. */
const VIDEO_QUALITY_PRESETS = {
  efficient: { videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 128_000 },
  standard: { videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 192_000 },
  high: { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 },
  // LinkedIn: capture at high quality; native H.264/AAC when available,
  // otherwise WebM is transcoded to MP4 (local/unpacked builds only).
  linkedin: { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 },
};
const DEFAULT_VIDEO_QUALITY = "standard";
const DEFAULT_OUTRO_DURATION_SEC = 3;
const DEFAULT_SOUNDTRACK_FADE_SEC = 3;
const CAPTURE_MODES = ["audio-video", "video", "audio"];
const DEFAULT_CAPTURE_MODE = "audio-video";

function normalizeCaptureMode(value, includeAudio) {
  if (CAPTURE_MODES.includes(value)) return value;
  if (includeAudio === false) return "video";
  return DEFAULT_CAPTURE_MODE;
}

function captureIncludesTabAudio(mode) {
  return mode !== "video";
}

function captureIncludesVideo(mode) {
  return mode !== "audio";
}

function extensionFromMimeType(mimeType) {
  const mime = (mimeType || "").toLowerCase();
  if (mime.startsWith("audio/")) {
    if (mime.includes("mp4")) return ".m4a";
    if (mime.includes("ogg")) return ".ogg";
    return ".webm";
  }
  return mime.includes("mp4") ? ".mp4" : ".webm";
}

function resolveVideoQuality(value) {
  const key = typeof value === "string" ? value.toLowerCase() : "";
  return VIDEO_QUALITY_PRESETS[key] ? key : DEFAULT_VIDEO_QUALITY;
}

function resolveOutroDurationSec(value) {
  const n = Math.round(Number(value));
  if (n === 1 || n === 2 || n === 3 || n === 5 || n === 10) return n;
  return DEFAULT_OUTRO_DURATION_SEC;
}

const LAST_RECORDING_FILENAME_KEY = "lastRecordingFilename";
const LAST_RECORDING_MIME_KEY = "lastRecordingMime";
const GIF_JOB_STORAGE_KEY = "frameitGifJob";

const CONTENT_SESSION_TYPES = new Set([
  "frameit-countdown-done",
  "frameit-stop-session",
  "frameit-cancel-session",
  "frameit-pause-session",
  "frameit-resume-session",
  "frameit-snapshot-countdown-done",
  "frameit-snapshot-selection-done",
  "frameit-snapshot-cancel",
]);

const EXTENSION_PAGE_TYPES = new Set([
  "frameit-start-session",
  "frameit-start-snapshot",
  "frameit-start-gif",
  "frameit-get-status",
  "frameit-gif-progress",
  "frameit-gif-done",
]);

let session = null;
let sessionRestorePromise = null;
let snapshotState = null;
/** @type {{ phase: string, progress: number, error?: string, tabId?: number } | null} */
let gifJob = null;
let outroTimerId = null;
let outroTimerResolve = null;
let stopInFlight = null;
/** In-memory outro data URL for the active session (not persisted). */
let sessionOutroDataUrl = null;

function isExtensionPageSender(sender) {
  return typeof sender?.url === "string" && sender.url.startsWith(EXTENSION_ORIGIN);
}

function isTabContentScript(sender) {
  return Boolean(sender?.tab) && !isExtensionPageSender(sender);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  const fromContentScript = isTabContentScript(sender);

  // Offscreen/extension pages may forward debug logs to the recorded tab.
  if (message.type === "frameit-debug-log" && !fromContentScript) {
    forwardDebugLogToSessionTab(message)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "frameit-transcode-progress" && !fromContentScript) {
    forwardTranscodeProgressToSessionTab(message)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Content scripts may only drive overlay/session UI events.
  if (fromContentScript && !CONTENT_SESSION_TYPES.has(message.type)) {
    return false;
  }

  // Popup / extension-page commands should not come from a tab content script.
  if (
    !fromContentScript &&
    !EXTENSION_PAGE_TYPES.has(message.type) &&
    !CONTENT_SESSION_TYPES.has(message.type)
  ) {
    // Ignore offscreen/saver-only traffic here (handled by dedicated listeners).
    return false;
  }

  if (message.type === "frameit-start-session") {
    if (fromContentScript) {
      sendResponse({ ok: false, error: "Start session must come from the extension UI" });
      return false;
    }
    startSession({
      includeLogo: message.includeLogo !== false,
      logoDataUrl: normalizeLogoDataUrl(message.logoDataUrl),
      includeOutro: Boolean(message.includeOutro),
      outroDurationSec: message.outroDurationSec,
      hideControls: message.hideControls !== false,
      includePointer: Boolean(message.includePointer),
      captureMode: message.captureMode,
      includeAudio: message.includeAudio,
      includeMicrophone: Boolean(message.includeMicrophone),
      includeSoundtrack: Boolean(message.includeSoundtrack),
      soundtrackLoop: Boolean(message.soundtrackLoop),
      videoQuality: message.videoQuality,
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-start-snapshot") {
    if (fromContentScript) {
      sendResponse({ ok: false, error: "Snapshot must come from the extension UI" });
      return false;
    }
    startSnapshot({
      mode: message.mode,
      delay: message.delay,
      linkedIn: message.linkedIn,
      format: message.format,
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-countdown-done") {
    onCountdownDone()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-snapshot-countdown-done") {
    if (
      fromContentScript &&
      snapshotState &&
      sender.tab?.id === snapshotState.tabId &&
      snapshotState.phase === "countdown" &&
      snapshotState.countdownResolve
    ) {
      const resolve = snapshotState.countdownResolve;
      snapshotState.countdownResolve = null;
      resolve();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "frameit-snapshot-selection-done") {
    if (
      fromContentScript &&
      snapshotState &&
      sender.tab?.id === snapshotState.tabId &&
      snapshotState.phase === "selecting" &&
      snapshotState.selectionResolve
    ) {
      const resolve = snapshotState.selectionResolve;
      snapshotState.selectionResolve = null;
      snapshotState.selectionReject = null;
      resolve({
        x: Number(message.x) || 0,
        y: Number(message.y) || 0,
        width: Number(message.width) || 0,
        height: Number(message.height) || 0,
        viewportWidth: Number(message.viewportWidth) || 0,
        viewportHeight: Number(message.viewportHeight) || 0,
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "frameit-snapshot-cancel") {
    if (
      fromContentScript &&
      snapshotState &&
      sender.tab?.id === snapshotState.tabId &&
      snapshotState.selectionReject
    ) {
      const reject = snapshotState.selectionReject;
      snapshotState.selectionResolve = null;
      snapshotState.selectionReject = null;
      reject(new Error("Snapshot cancelled"));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "frameit-stop-session") {
    stopSession()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-cancel-session") {
    cancelSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-pause-session") {
    pauseSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-resume-session") {
    resumeSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-get-status") {
    if (fromContentScript) {
      sendResponse({ ok: false, error: "Status is only available to the extension UI" });
      return false;
    }
    getStatus()
      .then((status) => sendResponse(status))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-start-gif") {
    if (fromContentScript) {
      sendResponse({ ok: false, error: "Create GIF must come from the extension UI" });
      return false;
    }
    startGifJob({
      fps: message.fps,
      speedPercent: message.speedPercent,
      spiralflow: Boolean(message.spiralflow),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-gif-progress") {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "Unauthorized" });
      return false;
    }
    if (gifJob) {
      gifJob.progress = Math.max(0, Math.min(1, Number(message.progress) || 0));
      if (message.phase) gifJob.phase = String(message.phase);
      persistGifJob().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "frameit-gif-done") {
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, error: "Unauthorized" });
      return false;
    }
    onGifDone(message)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "take-snapshot") return;
  startSnapshotFromCommand().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) {
    abortSession().catch(() => {});
  }
  if (snapshotState?.tabId === tabId) {
    abortSnapshot(new Error("Tab closed")).catch(() => {});
  }
  if (gifJob?.tabId === tabId && gifJob.phase !== "done" && gifJob.phase !== "error") {
    gifJob = {
      phase: "error",
      progress: gifJob.progress || 0,
      error: "GIF tab was closed",
      tabId: null,
    };
    persistGifJob().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!session || session.tabId !== tabId) return;
  if (changeInfo.status === "complete" &&
      (session.phase === "recording" || session.phase === "outro")) {
    ensureSessionOverlay().catch(() => {});
  }
});

async function startSnapshotFromCommand() {
  const prefs = await loadSnapshotPrefs();
  await startSnapshot(prefs);
}

async function loadSnapshotPrefs() {
  try {
    const stored = await chrome.storage.local.get([
      SNAPSHOT_MODE_KEY,
      SNAPSHOT_DELAY_KEY,
      SNAPSHOT_LINKEDIN_KEY,
      SNAPSHOT_FORMAT_KEY,
      SNAPSHOT_JPG_KEY,
    ]);
    return {
      mode: normalizeSnapshotMode(stored?.[SNAPSHOT_MODE_KEY]),
      delay: normalizeSnapshotDelay(stored?.[SNAPSHOT_DELAY_KEY]),
      linkedIn: normalizeSnapshotLinkedIn(stored?.[SNAPSHOT_LINKEDIN_KEY]),
      format: normalizeSnapshotFormat(
        stored?.[SNAPSHOT_FORMAT_KEY],
        stored?.[SNAPSHOT_JPG_KEY]
      ),
    };
  } catch (_error) {
    return {
      mode: DEFAULT_SNAPSHOT_MODE,
      delay: DEFAULT_SNAPSHOT_DELAY,
      linkedIn: DEFAULT_SNAPSHOT_LINKEDIN,
      format: DEFAULT_SNAPSHOT_FORMAT,
    };
  }
}

function normalizeSnapshotMode(value) {
  return value === "region" ? "region" : DEFAULT_SNAPSHOT_MODE;
}

function normalizeSnapshotDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SNAPSHOT_DELAY;
  return Math.max(0, Math.min(60, Math.floor(n)));
}

function normalizeSnapshotLinkedIn(value) {
  return value === true;
}

function normalizeSnapshotFormat(value, legacyJpg) {
  if (value === "jpg" || value === "gif" || value === "png") return value;
  if (legacyJpg === true) return "jpg";
  return DEFAULT_SNAPSHOT_FORMAT;
}

function snapshotExtensionForFormat(format) {
  if (format === "jpg") return ".jpg";
  if (format === "gif") return ".gif";
  return ".png";
}

function assertCapturableTab(tab) {
  if (!tab?.id) {
    throw new Error("No active tab found");
  }
  if (
    tab.url?.startsWith("chrome://") ||
    tab.url?.startsWith("chrome-extension://") ||
    tab.url?.startsWith("https://chrome.google.com/webstore") ||
    tab.url?.startsWith("https://chromewebstore.google.com/")
  ) {
    throw new Error("This page cannot be captured. Open a regular website tab.");
  }
}

async function startSnapshot({ mode, delay, linkedIn, format } = {}) {
  await ensureSessionRestored();
  await ensureGifJobRestored();
  if (session) {
    throw new Error("Finish or stop the recording before taking a snapshot");
  }
  if (gifJob && gifJob.phase !== "done" && gifJob.phase !== "error") {
    throw new Error("Wait for GIF creation to finish");
  }
  if (snapshotState) {
    throw new Error("A snapshot is already in progress");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  assertCapturableTab(tab);

  const snapshotMode = normalizeSnapshotMode(mode);
  const snapshotDelay = normalizeSnapshotDelay(delay);
  const snapshotLinkedIn = normalizeSnapshotLinkedIn(linkedIn);
  const snapshotFormat = normalizeSnapshotFormat(format);

  snapshotState = {
    tabId: tab.id,
    tabTitle: tab.title || "Snapshot",
    windowId: tab.windowId,
    mode: snapshotMode,
    delay: snapshotDelay,
    linkedIn: snapshotLinkedIn,
    format: snapshotFormat,
    phase: "starting",
    countdownResolve: null,
    selectionResolve: null,
    selectionReject: null,
  };

  try {
    if (snapshotDelay > 0 || snapshotMode === "region") {
      await injectOverlay(tab.id);
    }
  } catch (error) {
    snapshotState = null;
    throw error;
  }

  // Run countdown → optional region → capture without blocking the popup/command.
  runSnapshotCapture().catch(async (error) => {
    const message = String(error?.message || error || "");
    if (message !== "Snapshot cancelled") {
      console.warn("Snapshot failed:", message);
    }
    await abortSnapshot();
  });
}

async function runSnapshotCapture() {
  if (!snapshotState) return;

  const {
    tabId,
    windowId,
    mode,
    delay: snapshotDelay,
    linkedIn,
    format,
    tabTitle,
  } = snapshotState;

  if (snapshotDelay > 0) {
    snapshotState.phase = "countdown";
    const countdownDone = new Promise((resolve) => {
      snapshotState.countdownResolve = resolve;
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "frameit-show-snapshot-countdown",
      seconds: snapshotDelay,
      label: "Taking snapshot...",
    });
    await countdownDone;
    if (!snapshotState) return;
  }

  let selection = null;
  if (mode === "region") {
    snapshotState.phase = "selecting";
    const selectionDone = new Promise((resolve, reject) => {
      snapshotState.selectionResolve = resolve;
      snapshotState.selectionReject = reject;
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "frameit-start-region-select",
    });
    selection = await selectionDone;
    if (!snapshotState) return;
  }

  snapshotState.phase = "capturing";
  if (snapshotDelay > 0 || mode === "region") {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // Overlay may already be gone.
    }
    await delay(120);
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });
  if (!dataUrl) {
    throw new Error("Failed to capture the visible tab");
  }

  let downloadUrl = dataUrl;
  if (selection) {
    downloadUrl = await cropPngDataUrl(downloadUrl, selection);
  }
  if (linkedIn) {
    downloadUrl = await optimizePngForLinkedIn(downloadUrl);
  }
  if (format === "jpg") {
    downloadUrl = await encodeJpegDataUrl(downloadUrl, JPEG_QUALITY);
  } else if (format === "gif") {
    downloadUrl = await encodeGifDataUrl(downloadUrl);
  }

  const filename = buildFilename(
    tabTitle,
    new Date(),
    snapshotExtensionForFormat(format)
  );
  await chrome.downloads.download({
    url: downloadUrl,
    filename,
    saveAs: false,
  });

  snapshotState = null;
}

async function abortSnapshot(reason) {
  const tabId = snapshotState?.tabId;
  const rejectSelection = snapshotState?.selectionReject;
  if (snapshotState) {
    snapshotState.countdownResolve = null;
    snapshotState.selectionResolve = null;
    snapshotState.selectionReject = null;
  }
  snapshotState = null;

  if (rejectSelection && reason) {
    try {
      rejectSelection(reason);
    } catch (_error) {
      // Listener may already have settled.
    }
  }

  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // ignore
    }
  }
}

/**
 * Fit the snapshot into LinkedIn's 1280×644 frame (center cover crop).
 */
async function optimizePngForLinkedIn(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  try {
    const scale = Math.max(
      LINKEDIN_WIDTH / bitmap.width,
      LINKEDIN_HEIGHT / bitmap.height
    );
    const sw = LINKEDIN_WIDTH / scale;
    const sh = LINKEDIN_HEIGHT / scale;
    const sx = (bitmap.width - sw) / 2;
    const sy = (bitmap.height - sh) / 2;

    const canvas = new OffscreenCanvas(LINKEDIN_WIDTH, LINKEDIN_HEIGHT);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not optimize the snapshot for LinkedIn");
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, LINKEDIN_WIDTH, LINKEDIN_HEIGHT);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(outBlob);
  } finally {
    bitmap.close();
  }
}

async function encodeJpegDataUrl(dataUrl, quality) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Could not encode the JPEG snapshot");
    }
    // JPEG has no alpha; paint an opaque backdrop first.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const q = Math.min(1, Math.max(0.5, Number(quality) || JPEG_QUALITY));
    const outBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: q,
    });
    return blobToDataUrl(outBlob);
  } finally {
    bitmap.close();
  }
}

async function encodeGifDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Could not encode the GIF snapshot");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const gifBytes = encodeRgbaToGif(
      imageData.data,
      imageData.width,
      imageData.height
    );
    return blobToDataUrl(new Blob([gifBytes], { type: "image/gif" }));
  } finally {
    bitmap.close();
  }
}

async function cropPngDataUrl(dataUrl, rect) {
  const viewportWidth = Number(rect.viewportWidth) || 0;
  const viewportHeight = Number(rect.viewportHeight) || 0;
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    throw new Error("Invalid selection viewport size");
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  try {
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;
    let sx = Math.round(Number(rect.x) * scaleX);
    let sy = Math.round(Number(rect.y) * scaleY);
    let sw = Math.round(Number(rect.width) * scaleX);
    let sh = Math.round(Number(rect.height) * scaleY);

    sx = Math.max(0, Math.min(bitmap.width - 1, sx));
    sy = Math.max(0, Math.min(bitmap.height - 1, sy));
    sw = Math.max(1, Math.min(bitmap.width - sx, sw));
    sh = Math.max(1, Math.min(bitmap.height - sy, sh));

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not crop the snapshot");
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return blobToDataUrl(outBlob);
  } finally {
    bitmap.close();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not encode the snapshot"));
    };
    reader.onerror = () => reject(new Error("Could not encode the snapshot"));
    reader.readAsDataURL(blob);
  });
}

async function startSession({
  includeLogo = true,
  logoDataUrl = null,
  includeOutro = false,
  outroDurationSec = DEFAULT_OUTRO_DURATION_SEC,
  hideControls = true,
  includePointer = false,
  captureMode = DEFAULT_CAPTURE_MODE,
  includeAudio,
  includeMicrophone = false,
  includeSoundtrack = false,
  soundtrackLoop = false,
  videoQuality = DEFAULT_VIDEO_QUALITY,
} = {}) {
  await ensureSessionRestored();
  await ensureGifJobRestored();
  if (snapshotState) {
    throw new Error("Finish the snapshot before starting a recording");
  }
  if (gifJob && gifJob.phase !== "done" && gifJob.phase !== "error") {
    throw new Error("Wait for GIF creation to finish");
  }
  if (session) {
    throw new Error("A session is already in progress");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  assertCapturableTab(tab);

  const tabTitle = tab.title || "Session";
  const sessionStartedAt = new Date();
  const qualityKey = resolveVideoQuality(videoQuality);
  const bitrates = VIDEO_QUALITY_PRESETS[qualityKey];
  const resolvedCaptureMode = normalizeCaptureMode(captureMode, includeAudio);
  const includeVideo = captureIncludesVideo(resolvedCaptureMode);
  const includeTabAudio = captureIncludesTabAudio(resolvedCaptureMode);
  const outroDataUrl = includeVideo && includeOutro ? await loadOutroDataUrl() : null;
  if (includeVideo && includeOutro && !outroDataUrl) {
    throw new Error("Choose an outro image, or turn off the outro.");
  }
  if (includeSoundtrack) {
    const soundtrack = await getSoundtrackAudio();
    if (!soundtrack) {
      throw new Error("Choose a soundtrack, or turn off the soundtrack.");
    }
  }

  session = {
    tabId: tab.id,
    tabTitle,
    sessionStartedAt,
    phase: "acquiring",
    mimeType: "",
    includeLogo: includeVideo && Boolean(includeLogo),
    logoDataUrl: includeVideo && includeLogo ? normalizeLogoDataUrl(logoDataUrl) : null,
    includeOutro: Boolean(includeVideo && includeOutro && outroDataUrl),
    outroDurationSec: resolveOutroDurationSec(outroDurationSec),
    hideControls: Boolean(hideControls),
    includePointer: includeVideo && Boolean(includePointer),
    captureMode: resolvedCaptureMode,
    includeAudio: includeTabAudio,
    includeVideo,
    includeMicrophone: Boolean(includeMicrophone),
    includeSoundtrack: Boolean(includeSoundtrack),
    soundtrackLoop: Boolean(soundtrackLoop),
    videoQuality: qualityKey,
    preferLinkedIn: includeVideo && qualityKey === "linkedin",
    videoBitsPerSecond: bitrates.videoBitsPerSecond,
    audioBitsPerSecond: bitrates.audioBitsPerSecond,
    paused: false,
    pausedAt: 0,
    totalPausedMs: 0,
  };
  sessionOutroDataUrl = outroDataUrl;
  await persistSession();

  try {
    const streamId = await getTabCaptureStreamId(tab.id);

    await ensureOffscreenDocument();
    const acquired = await sendToOffscreen({
      type: "frameit-acquire-stream",
      streamId,
      includePointer: Boolean(session.includePointer),
      captureMode: session.captureMode,
      includeAudio: session.includeAudio,
      includeVideo: session.includeVideo !== false,
      includeMicrophone: session.includeMicrophone,
      includeSoundtrack: Boolean(session.includeSoundtrack),
      soundtrackLoop: Boolean(session.soundtrackLoop),
    });
    if (!acquired?.ok) {
      throw new Error(acquired?.error || "Failed to acquire tab stream");
    }

    await injectOverlay(tab.id);
    session.phase = "countdown";
    await persistSession();
    await chrome.tabs.sendMessage(tab.id, { type: "frameit-show-countdown" });
  } catch (error) {
    await abortSession();
    throw error;
  }
}

async function getTabCaptureStreamId(tabId) {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const message = String(error?.message || error);
    if (/has not been invoked|activeTab permission/i.test(message)) {
      throw new Error(
        "Click the xFrame toolbar icon on the page you want to record, then " +
        "click Start session again. Chrome requires this after switching to " +
        "a new page or reloading the extension."
      );
    }
    throw error;
  }
}

async function onCountdownDone() {
  await ensureSessionRestored();
  if (!session || session.phase !== "countdown") {
    return;
  }

  const started = await sendToOffscreen({
    type: "frameit-start-recording",
    videoBitsPerSecond:
      session.videoBitsPerSecond ||
      VIDEO_QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY].videoBitsPerSecond,
    audioBitsPerSecond:
      session.includeAudio ||
      session.includeMicrophone ||
      session.includeSoundtrack
      ? session.audioBitsPerSecond ||
        VIDEO_QUALITY_PRESETS[DEFAULT_VIDEO_QUALITY].audioBitsPerSecond
      : undefined,
    preferLinkedIn:
      Boolean(session.includeVideo !== false) &&
      (Boolean(session.preferLinkedIn) || session.videoQuality === "linkedin"),
  });
  if (!started?.ok) {
    await abortSession();
    throw new Error(started?.error || "Failed to start recording");
  }

  session.mimeType = started.mimeType || "";
  session.phase = "recording";
  session.paused = false;
  session.pausedAt = 0;
  session.totalPausedMs = 0;
  session.recordingStartedAt = Date.now();
  await persistSession();

  await ensureSessionOverlay();
}

async function pauseSession() {
  await ensureSessionRestored();
  if (!session || session.phase !== "recording" || session.paused) {
    throw new Error("Session is not recording");
  }

  const paused = await sendToOffscreen({ type: "frameit-pause-recording" });
  if (!paused?.ok) {
    throw new Error(paused?.error || "Failed to pause recording");
  }

  session.paused = true;
  session.pausedAt = Date.now();
  await persistSession();
}

async function resumeSession() {
  await ensureSessionRestored();
  if (!session || session.phase !== "recording" || !session.paused) {
    throw new Error("Session is not paused");
  }

  const resumed = await sendToOffscreen({ type: "frameit-resume-recording" });
  if (!resumed?.ok) {
    throw new Error(resumed?.error || "Failed to resume recording");
  }

  if (session.pausedAt) {
    session.totalPausedMs =
      (session.totalPausedMs || 0) + (Date.now() - session.pausedAt);
  }
  session.pausedAt = 0;
  session.paused = false;
  await persistSession();
}

async function stopSession() {
  if (stopInFlight) return stopInFlight;
  stopInFlight = stopSessionBody().finally(() => {
    stopInFlight = null;
  });
  return stopInFlight;
}

async function stopSessionBody() {
  await ensureSessionRestored();
  if (!session) {
    throw new Error("No active session");
  }
  if (session.phase === "stopping") {
    throw new Error("Session is already stopping");
  }

  const outroPlayed = await playOutroIfNeeded();
  if (!session) {
    return { cancelled: true };
  }
  if (!outroPlayed) {
    await fadeSoundtrackIfNeeded();
  }
  if (!session) {
    return { cancelled: true };
  }
  if (
    !outroPlayed &&
    session.phase !== "recording" &&
    session.phase !== "outro"
  ) {
    throw new Error("Session is not recording");
  }

  return finalizeStop();
}

async function playOutroIfNeeded() {
  if (!session || session.phase === "outro") {
    if (session?.phase === "outro") {
      const remaining = Math.max(0, (session.outroEndsAt || 0) - Date.now());
      await startSoundtrackFade(remaining / 1000);
      await waitOutroMs(remaining);
    }
    return Boolean(session);
  }

  const imageUrl = session.includeOutro
    ? sessionOutroDataUrl || (await loadOutroDataUrl())
    : null;
  const durationMs = resolveOutroDurationSec(session.outroDurationSec) * 1000;
  if (!imageUrl || durationMs <= 0 || session.phase !== "recording") {
    return false;
  }

  if (session.paused) {
    await resumeSession();
  }

  session.phase = "outro";
  session.outroEndsAt = Date.now() + durationMs;
  await persistSession();

  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: "frameit-show-outro",
      imageDataUrl: imageUrl,
    });
  } catch (_error) {
    // Overlay may be unavailable; still hold the duration so the end is stable.
  }

  await startSoundtrackFade(durationMs / 1000);
  await waitOutroMs(Math.max(0, session.outroEndsAt - Date.now()));
  return Boolean(session);
}

async function fadeSoundtrackIfNeeded() {
  if (!session?.includeSoundtrack || session.phase !== "recording") {
    return;
  }
  if (session.paused) {
    await resumeSession();
  }
  if (!session || session.phase !== "recording") return;
  await startSoundtrackFade(DEFAULT_SOUNDTRACK_FADE_SEC);
  await waitOutroMs(DEFAULT_SOUNDTRACK_FADE_SEC * 1000);
}

async function startSoundtrackFade(durationSec) {
  if (!session?.includeSoundtrack) return;
  try {
    await sendToOffscreen({
      type: "frameit-fade-soundtrack",
      durationSec,
    });
  } catch (_error) {
    // Fade is best-effort; stop still proceeds.
  }
}

async function finalizeStop() {
  await ensureSessionRestored();
  if (!session) {
    return { cancelled: true };
  }

  const { tabId, tabTitle, sessionStartedAt, mimeType } = session;
  const extension = extensionFromMimeType(mimeType);
  const filename = buildFilename(tabTitle, sessionStartedAt, extension);
  const stoppedAt = Date.now();
  const currentPauseMs =
    session.paused && session.pausedAt ? stoppedAt - session.pausedAt : 0;
  const recordingDurationSec = session.recordingStartedAt
    ? Math.max(
        0.001,
        (stoppedAt -
          session.recordingStartedAt -
          (session.totalPausedMs || 0) -
          currentPauseMs) /
          1000
      )
    : null;

  session.phase = "stopping";
  await persistSession();

  try {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "frameit-session-stopping",
      });
    } catch (_error) {
      // Overlay may already be gone.
    }

    const stopped = await sendToOffscreen({
      type: "frameit-stop-recording",
      filename,
      durationSec: recordingDurationSec,
    });
    if (!stopped?.ok) {
      throw new Error(stopped?.error || "Failed to stop recording");
    }

    const finalMime = stopped.mimeType || mimeType || "video/webm";
    const finalName =
      stopped.filename ||
      buildFilename(tabTitle, sessionStartedAt, extensionFromMimeType(finalMime));

    await downloadPendingRecording(finalName);

    try {
      await chrome.storage.local.set({
        [LAST_RECORDING_FILENAME_KEY]: finalName,
        [LAST_RECORDING_MIME_KEY]: finalMime,
      });
    } catch (_error) {
      // Metadata is optional for Animate; blob is already in IndexedDB.
    }

    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // Tab may have closed.
    }

    session = null;
    sessionOutroDataUrl = null;
    await persistSession();
    await closeOffscreenDocument();

    return { filename: finalName, mimeType: finalMime };
  } catch (error) {
    await abortSession();
    throw error;
  }
}

function clearOutroTimer() {
  if (outroTimerId != null) {
    clearTimeout(outroTimerId);
    outroTimerId = null;
  }
  if (outroTimerResolve) {
    const resolve = outroTimerResolve;
    outroTimerResolve = null;
    resolve();
  }
}

function waitOutroMs(ms) {
  clearOutroTimer();
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    outroTimerResolve = resolve;
    outroTimerId = setTimeout(() => {
      outroTimerId = null;
      outroTimerResolve = null;
      resolve();
    }, wait);
  });
}

async function cancelSession() {
  await ensureSessionRestored();
  if (!session) {
    throw new Error("No active session");
  }
  await abortSession();
}

async function getStatus() {
  await ensureSessionRestored();
  await ensureGifJobRestored();
  if (session?.phase === "recording" || session?.phase === "outro") {
    await ensureSessionOverlay().catch(() => {});
  }
  let hasLast = false;
  let lastFilename = null;
  try {
    hasLast = await hasLastRecording();
  } catch (_error) {
    hasLast = false;
  }
  try {
    const stored = await chrome.storage.local.get([
      LAST_RECORDING_FILENAME_KEY,
    ]);
    const name = stored?.[LAST_RECORDING_FILENAME_KEY];
    lastFilename = typeof name === "string" && name ? name : null;
  } catch (_error) {
    lastFilename = null;
  }
  const status = {
    ok: true,
    active: Boolean(session),
    phase: session?.phase || null,
    paused: Boolean(session?.paused),
    recordingStartedAt: session?.recordingStartedAt || null,
    pausedAt: session?.pausedAt || null,
    totalPausedMs: session?.totalPausedMs || 0,
    hideControls: session?.hideControls !== false,
    includeOutro: Boolean(session?.includeOutro && sessionOutroDataUrl),
    includeSoundtrack: Boolean(session?.includeSoundtrack),
    snapshotActive: Boolean(snapshotState),
    snapshotPhase: snapshotState?.phase || null,
    hasLastRecording: hasLast,
    lastRecordingFilename: lastFilename,
    gifActive: Boolean(
      gifJob && gifJob.phase !== "done" && gifJob.phase !== "error"
    ),
    gifPhase: gifJob?.phase || null,
    gifProgress: gifJob?.progress ?? 0,
    gifError: gifJob?.error || null,
  };

  // One-shot terminal GIF status for the popup.
  if (gifJob && (gifJob.phase === "done" || gifJob.phase === "error")) {
    gifJob = null;
    persistGifJob().catch(() => {});
  }

  return status;
}

async function downloadPendingRecording(filename) {
  const saverUrl = `${chrome.runtime.getURL("saver.html")}?filename=${encodeURIComponent(
    filename
  )}`;

  return new Promise((resolve, reject) => {
    let saverTabId = null;
    const timeoutId = setTimeout(() => {
      finish(new Error("Timed out while saving the recording"), true);
    }, 120_000);

    function finish(error, removeTab) {
      clearTimeout(timeoutId);
      chrome.runtime.onMessage.removeListener(onMessage);
      if (removeTab && saverTabId != null) {
        chrome.tabs.remove(saverTabId).catch(() => {});
      }
      if (error) reject(error);
      else resolve();
    }

    function onMessage(message, sender) {
      if (message?.type !== "frameit-save-done") return;
      if (!isExtensionPageSender(sender)) return;
      if (message.ok) {
        finish(null, false);
      } else {
        finish(new Error(message.error || "Failed to save recording"), true);
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);

    chrome.tabs
      .create({ url: saverUrl, active: false })
      .then((tab) => {
        saverTabId = tab.id;
      })
      .catch((error) => {
        finish(error, false);
      });
  });
}

async function abortSession() {
  clearOutroTimer();
  const tabId = session?.tabId;
  session = null;
  sessionOutroDataUrl = null;
  await persistSession();

  try {
    await sendToOffscreen({ type: "frameit-discard" });
  } catch (_error) {
    // Offscreen may not exist.
  }

  try {
    await clearPendingRecording();
  } catch (_error) {
    // ignore
  }

  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "frameit-teardown" });
    } catch (_error) {
      // ignore
    }
  }

  await closeOffscreenDocument();
}

async function persistGifJob() {
  if (!gifJob) {
    await chrome.storage.session.remove(GIF_JOB_STORAGE_KEY);
    return;
  }
  await chrome.storage.session.set({
    [GIF_JOB_STORAGE_KEY]: {
      phase: gifJob.phase,
      progress: gifJob.progress,
      error: gifJob.error || null,
      tabId: gifJob.tabId ?? null,
    },
  });
}

async function ensureGifJobRestored() {
  if (gifJob) return;
  try {
    const stored = await chrome.storage.session.get(GIF_JOB_STORAGE_KEY);
    const raw = stored?.[GIF_JOB_STORAGE_KEY];
    if (raw && typeof raw === "object" && raw.phase) {
      gifJob = {
        phase: String(raw.phase),
        progress: Number(raw.progress) || 0,
        error: raw.error ? String(raw.error) : null,
        tabId: raw.tabId != null ? Number(raw.tabId) : null,
      };
    }
  } catch (_error) {
    // session storage may be unavailable
  }
}

async function startGifJob({ fps, speedPercent, spiralflow } = {}) {
  await ensureSessionRestored();
  await ensureGifJobRestored();

  if (session) {
    throw new Error("Finish or cancel the recording session first");
  }
  if (snapshotState) {
    throw new Error("Wait for the snapshot to finish");
  }
  if (gifJob && gifJob.phase !== "done" && gifJob.phase !== "error") {
    throw new Error("A GIF is already being created");
  }

  const hasLast = await hasLastRecording();
  if (!hasLast) {
    throw new Error("Record a session first, then create a GIF");
  }

  const fpsN = Math.max(1, Math.min(30, Math.round(Number(fps) || 10)));
  const speedN = Math.max(10, Math.min(500, Math.round(Number(speedPercent) || 100)));

  let filename = "session.gif";
  try {
    const stored = await chrome.storage.local.get([LAST_RECORDING_FILENAME_KEY]);
    const base = stored?.[LAST_RECORDING_FILENAME_KEY];
    if (typeof base === "string" && base) {
      filename = base.replace(/\.(mp4|webm)$/i, "") + ".gif";
    }
  } catch (_error) {
    // keep default
  }

  gifJob = { phase: "starting", progress: 0, error: null, tabId: null };
  await persistGifJob();

  const params = new URLSearchParams({
    fps: String(fpsN),
    speed: String(speedN),
    spiralflow: spiralflow ? "1" : "0",
    filename,
  });
  const makerUrl = `${chrome.runtime.getURL("gifMaker.html")}?${params.toString()}`;

  try {
    const tab = await chrome.tabs.create({ url: makerUrl, active: false });
    gifJob.tabId = tab.id;
    gifJob.phase = "encoding";
    await persistGifJob();
  } catch (error) {
    gifJob = {
      phase: "error",
      progress: 0,
      error: String(error?.message || error),
      tabId: null,
    };
    await persistGifJob();
    throw error;
  }
}

async function onGifDone(message) {
  await ensureGifJobRestored();
  const tabId = gifJob?.tabId;
  if (message?.ok) {
    gifJob = { phase: "done", progress: 1, error: null, tabId: null };
  } else {
    gifJob = {
      phase: "error",
      progress: gifJob?.progress || 0,
      error: String(message?.error || "GIF creation failed"),
      tabId: null,
    };
  }
  await persistGifJob();
  if (tabId != null) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_error) {
      // already closed
    }
  }
}

async function injectOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function forwardDebugLogToSessionTab(message) {
  await ensureSessionRestored();
  const tabId = session?.tabId;
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "frameit-console-log",
      level: message.level || "error",
      label: message.label || "[frameit]",
      detail: message.detail ?? null,
    });
  } catch (_error) {
    // Tab may have closed or content script may not be ready.
  }
}

async function forwardTranscodeProgressToSessionTab(message) {
  await ensureSessionRestored();
  const tabId = session?.tabId;
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "frameit-transcode-progress",
      progress: message.progress,
      label: message.label || "Converting to MP4…",
    });
  } catch (_error) {
    // Tab may have closed or content script may not be ready.
  }
}

async function ensureSessionOverlay() {
  if (!session || session.tabId == null) return;
  if (
    session.phase !== "recording" &&
    session.phase !== "countdown" &&
    session.phase !== "outro"
  ) {
    return;
  }

  try {
    await injectOverlay(session.tabId);
  } catch (_error) {
    // Tab may disallow scripting momentarily.
    return;
  }

  if (session.phase === "countdown") {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "frameit-show-countdown",
      });
    } catch (_error) {
      // ignore
    }
    return;
  }

  if (session.phase === "outro") {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "frameit-show-outro",
        imageDataUrl: sessionOutroDataUrl || (await loadOutroDataUrl()),
      });
    } catch (_error) {
      // Overlay may be unavailable on restricted pages.
    }
    return;
  }

  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: "frameit-show-session-bar",
      startedAt: session.recordingStartedAt,
      includeLogo: session.includeLogo !== false,
      logoDataUrl: session.logoDataUrl || null,
      hideControls: session.hideControls !== false,
      includePointer: Boolean(session.includePointer),
      paused: Boolean(session.paused),
      pausedAt: session.pausedAt || 0,
      totalPausedMs: session.totalPausedMs || 0,
    });
  } catch (_error) {
    // Overlay may be unavailable on restricted pages.
  }
}

function serializeSession(value) {
  if (!value) return null;
  const { outroDataUrl: _omitOutro, ...rest } = value;
  return {
    ...rest,
    sessionStartedAt:
      value.sessionStartedAt instanceof Date
        ? value.sessionStartedAt.toISOString()
        : value.sessionStartedAt,
  };
}

function deserializeSession(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ...value,
    sessionStartedAt: value.sessionStartedAt
      ? new Date(value.sessionStartedAt)
      : new Date(),
  };
}

async function persistSession() {
  if (session) {
    await chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: serializeSession(session),
    });
  } else {
    await chrome.storage.session.remove(SESSION_STORAGE_KEY);
  }
}

async function ensureSessionRestored() {
  if (session) return session;
  if (!sessionRestorePromise) {
    sessionRestorePromise = restoreSession().finally(() => {
      sessionRestorePromise = null;
    });
  }
  return sessionRestorePromise;
}

async function restoreSession() {
  if (session) return session;

  let stored = null;
  try {
    const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
    stored = deserializeSession(result?.[SESSION_STORAGE_KEY]);
  } catch (_error) {
    stored = null;
  }

  if (!stored) {
    return null;
  }

  let recorder = null;
  try {
    if (await hasOffscreenDocument()) {
      recorder = await sendToOffscreen({ type: "frameit-recorder-status" });
    }
  } catch (_error) {
    recorder = null;
  }

  // Only an actively encoding recorder is safely recoverable after SW restart.
  // Holding a stream during countdown/acquire without MediaRecorder is discarded.
  if (!recorder?.ok || !recorder.recording) {
    await chrome.storage.session.remove(SESSION_STORAGE_KEY);
    try {
      await sendToOffscreen({ type: "frameit-discard" });
    } catch (_error) {
      // Offscreen may already be gone.
    }
    await closeOffscreenDocument();
    return null;
  }

  const wasOutro = stored.phase === "outro";
  session = {
    ...stored,
    mimeType: stored.mimeType || recorder.mimeType || "",
    paused: wasOutro ? false : Boolean(recorder.paused),
    phase: wasOutro ? "outro" : "recording",
    recordingStartedAt: stored.recordingStartedAt || Date.now(),
  };

  if (wasOutro && recorder.paused) {
    try {
      await sendToOffscreen({ type: "frameit-resume-recording" });
    } catch (_error) {
      // Continue; outro wait still proceeds toward stop.
    }
  }

  await persistSession();

  if (wasOutro || session.includeOutro) {
    sessionOutroDataUrl = await loadOutroDataUrl();
  }

  if (wasOutro) {
    queueMicrotask(() => {
      stopSession().catch(() => {
        abortSession().catch(() => {});
      });
    });
  }

  return session;
}

async function ensureOffscreenDocument() {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA", "BLOBS", "AUDIO_PLAYBACK"],
      justification:
        "Hold the tab MediaStream and MediaRecorder, and play an optional soundtrack.",
    });
  }

  await waitForOffscreenReady();
}

async function waitForOffscreenReady() {
  const deadline = Date.now() + 5000;
  let lastError = null;

  while (Date.now() < deadline) {
    if (!(await hasOffscreenDocument())) {
      await delay(50);
      continue;
    }

    try {
      // Only the offscreen page answers this; content scripts ignore it.
      const response = await chrome.runtime.sendMessage({
        type: "frameit-offscreen-ping",
      });
      if (response?.ok && response.source === "offscreen") {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }

  throw new Error(
    `Offscreen recorder did not become ready${
      lastError ? `: ${lastError.message || lastError}` : ""
    }`
  );
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  }

  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  return clients.some((client) => client.url === OFFSCREEN_URL);
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLogoDataUrl(value) {
  return normalizeImageDataUrl(value, 700_000);
}

async function loadOutroDataUrl() {
  try {
    const blob = await getOutroImage();
    if (!blob || blob.size <= 0) return null;
    return await blobToDataUrl(blob);
  } catch (_error) {
    return null;
  }
}

function normalizeImageDataUrl(value, maxLength) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("data:image/")) return null;
  if (value.length > maxLength) return null;
  return value;
}

function buildFilename(tabTitle, date, extension) {
  const safeTitle = sanitizeTitle(tabTitle);
  const stamp = formatSessionStamp(date);
  return `${safeTitle} ${stamp}${extension}`;
}

function sanitizeTitle(title) {
  const cleaned = String(title || "Session")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return (cleaned || "Session").slice(0, 80);
}

function formatSessionStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}_${minutes}`;
}

// Recover an in-flight session if the service worker was restarted mid-capture.
ensureSessionRestored().catch(() => {});
