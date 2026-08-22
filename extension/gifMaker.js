const PHI = (1 + Math.sqrt(5)) / 2;
const MAX_WIDTH = 1280;
const MAX_FRAMES = 1800;
const VIDEO_READY_TIMEOUT_MS = 30_000;
const SEEK_TIMEOUT_MS = 8_000;

const statusEl = document.getElementById("status");
const barEl = document.getElementById("bar");

(async () => {
  const params = new URLSearchParams(window.location.search);
  const fps = Math.max(1, Math.min(30, Math.round(Number(params.get("fps")) || 10)));
  const speedPercent = Math.max(
    10,
    Math.min(500, Math.round(Number(params.get("speed")) || 100))
  );
  const spiralflow = params.get("spiralflow") === "1";
  const filename = sanitizeFilename(params.get("filename") || "session.gif");
  let objectUrl = null;

  try {
    setUi(0.02, "Loading last recording…");
    await reportProgress(0.02, "loading");

    const blob = await getLastRecording();
    if (!blob || blob.size === 0) {
      throw new Error("No saved recording found");
    }
    setUi(0.04, `Loaded ${(blob.size / (1024 * 1024)).toFixed(1)} MB recording…`);

    objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    // Keep in DOM so Chrome reliably decodes/seeks MediaRecorder blobs.
    document.body.appendChild(video);
    video.src = objectUrl;
    video.load();

    setUi(0.06, "Reading video metadata…");
    await waitForVideoReady(video);

    let duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = await estimateDuration(video);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Could not read the recording duration");
    }

    const speed = speedPercent / 100;
    const outputDuration = duration / speed;
    const schedule = buildFrameSchedule({
      duration,
      outputDuration,
      speed,
      fps,
      spiralflow,
    });

    if (schedule.length > MAX_FRAMES) {
      throw new Error(
        `Too many frames (${schedule.length}). Lower FPS, raise speed, or use a shorter recording.`
      );
    }

    const srcW = video.videoWidth || 0;
    const srcH = video.videoHeight || 0;
    if (srcW <= 0 || srcH <= 0) {
      throw new Error("Could not read the recording size");
    }

    const scale = srcW > MAX_WIDTH ? MAX_WIDTH / srcW : 1;
    const outW = Math.max(1, Math.round(srcW * scale));
    const outH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Could not create a canvas for GIF frames");
    }

    setUi(
      0.08,
      `Sampling ${schedule.length} frames at ${fps} fps (${outW}×${outH})…`
    );

    const frames = [];
    for (let i = 0; i < schedule.length; i += 1) {
      const { videoTime, delaySeconds } = schedule[i];
      await seekVideo(video, videoTime);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(video, 0, 0, outW, outH);
      const imageData = ctx.getImageData(0, 0, outW, outH);
      frames.push({
        rgba: new Uint8ClampedArray(imageData.data),
        delaySeconds,
      });
      const progress = 0.08 + (0.72 * (i + 1)) / schedule.length;
      setUi(progress, `Sampling frame ${i + 1} / ${schedule.length}…`);
      await reportProgress(progress, "sampling");
      await delay(0);
    }

    setUi(0.85, "Encoding GIF…");
    await reportProgress(0.85, "encoding");
    // Yield so the status text paints before the heavy sync encode.
    await delay(30);
    const gifBytes = encodeRgbaFramesToGif(frames, outW, outH, { loop: true });
    const gifBlob = new Blob([gifBytes], { type: "image/gif" });

    setUi(0.95, "Downloading…");
    await reportProgress(0.95, "downloading");
    const downloadUrl = URL.createObjectURL(gifBlob);
    try {
      const downloadId = await chrome.downloads.download({
        url: downloadUrl,
        filename,
        saveAs: false,
      });
      await waitForDownloadSettled(downloadId);
    } finally {
      URL.revokeObjectURL(downloadUrl);
    }

    setUi(1, "Done.");
    await chrome.runtime.sendMessage({
      type: "frameit-gif-done",
      ok: true,
      filename,
    });
  } catch (error) {
    const message = String(error?.message || error);
    setUi(0, message, true);
    console.error("[xFrame gifMaker]", error);
    try {
      await chrome.runtime.sendMessage({
        type: "frameit-gif-done",
        ok: false,
        error: message,
      });
    } catch (_error) {
      // Service worker may have gone away.
    }
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
})();

function setUi(progress, text, isError = false) {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", Boolean(isError));
  }
  if (barEl) {
    barEl.value = Math.max(0, Math.min(100, Math.round(Number(progress) * 100)));
  }
}

/**
 * Build output frame times and delays.
 * Uniform: constant 1/fps. Spiralflow: δ(t) = (1/fps) * φ^(1 - φ * t / T)
 * with sum of delays ≈ T (overall timing preserved).
 */
function buildFrameSchedule({
  duration,
  outputDuration,
  speed,
  fps,
  spiralflow,
}) {
  const T = outputDuration;
  const baseInterval = 1 / fps;
  const samples = [];

  if (!spiralflow) {
    const n = Math.max(1, Math.round(T * fps));
    const delay = T / n;
    for (let i = 0; i < n; i += 1) {
      const t = (i / n) * T;
      samples.push({
        videoTime: Math.min(duration, Math.max(0, t * speed)),
        delaySeconds: delay,
      });
    }
    return samples;
  }

  let t = 0;
  const raw = [];
  while (t < T - 1e-9) {
    const delta = baseInterval * PHI ** (1 - (PHI * t) / T);
    raw.push({ t, delta });
    t += delta;
    if (raw.length > MAX_FRAMES + 50) break;
  }
  if (raw.length === 0) {
    raw.push({ t: 0, delta: T });
  }

  const sum = raw.reduce((acc, row) => acc + row.delta, 0) || 1;
  const scale = T / sum;
  for (const row of raw) {
    samples.push({
      videoTime: Math.min(duration, Math.max(0, row.t * speed)),
      delaySeconds: row.delta * scale,
    });
  }
  return samples;
}

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for video metadata"));
    }, VIDEO_READY_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    }

    function onReady() {
      if (!Number.isFinite(video.duration) && video.readyState < 1) return;
      if (video.videoWidth <= 0) return;
      cleanup();
      resolve();
    }

    function onError() {
      cleanup();
      const mediaError = video.error;
      const detail = mediaError
        ? ` (code ${mediaError.code})`
        : "";
      reject(new Error(`Could not load the recording${detail}`));
    }

    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);

    if (video.readyState >= 1 && video.videoWidth > 0) {
      onReady();
    }
  });
}

/** Some MP4 MediaRecorder blobs report duration as Infinity until seeked. */
async function estimateDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }
  // Binary-search style probe used by many blob recorders.
  return new Promise((resolve) => {
    const previous = video.currentTime;
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      const dur = Number.isFinite(video.duration) ? video.duration : video.currentTime;
      video.currentTime = previous;
      resolve(Number.isFinite(dur) && dur > 0 ? dur : 0);
    };
    video.addEventListener("seeked", onSeeked);
    try {
      video.currentTime = 1e101;
    } catch (_error) {
      video.removeEventListener("seeked", onSeeked);
      resolve(0);
    }
    setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      resolve(dur > 0 ? dur : 0);
    }, SEEK_TIMEOUT_MS);
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const target = Math.min(
      Math.max(0, time),
      Math.max(0, (Number.isFinite(video.duration) ? video.duration : time) - 0.001)
    );

    if (Math.abs(video.currentTime - target) < 0.002 && video.readyState >= 2) {
      resolve();
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      // Best-effort: continue with whatever frame is current.
      resolve();
    }, SEEK_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeoutId);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }

    function onSeeked() {
      cleanup();
      resolve();
    }

    function onError() {
      cleanup();
      reject(new Error("Could not seek in the recording"));
    }

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    try {
      video.currentTime = target;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function reportProgress(progress, phase) {
  try {
    await chrome.runtime.sendMessage({
      type: "frameit-gif-progress",
      progress,
      phase,
    });
  } catch (_error) {
    // ignore
  }
}

function sanitizeFilename(name) {
  const cleaned = String(name || "session.gif")
    .replace(/[/\\?%*:|"<>]/g, "-")
    .trim();
  if (!cleaned) return "session.gif";
  return cleaned.toLowerCase().endsWith(".gif") ? cleaned : `${cleaned}.gif`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDownloadSettled(downloadId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }, 300_000);

    function finish() {
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve();
    }

    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        finish();
        return;
      }
      if (delta.state.current === "interrupted") {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("Download was interrupted before it completed"));
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.search({ id: downloadId }).then((results) => {
      const item = results && results[0];
      if (!item) return;
      if (item.state === "complete") {
        finish();
      } else if (item.state === "interrupted") {
        clearTimeout(timeoutId);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error("Download was interrupted before it completed"));
      }
    });
  });
}
