const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

/** Prefer explicit H.264/AAC MP4 for LinkedIn (no generic video/mp4). */
const LINKEDIN_NATIVE_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1.4D401F,mp4a.40.2",
];

/** High-quality WebM source for FFmpeg → H.264/AAC MP4 (local builds only). */
const LINKEDIN_WEBM_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const FFMPEG_WORKER_URL = chrome.runtime.getURL("ffmpeg/transcode-worker.js");

const OFFSCREEN_ONLY_TYPES = new Set([
  "frameit-offscreen-ping",
  "frameit-recorder-status",
  "frameit-acquire-stream",
  "frameit-start-recording",
  "frameit-pause-recording",
  "frameit-resume-recording",
  "frameit-fade-soundtrack",
  "frameit-stop-recording",
  "frameit-discard",
]);

const DEFAULT_VIDEO_BITS = 5_000_000;
const DEFAULT_AUDIO_BITS = 192_000;

let captureStream = null;
let tabCaptureStream = null;
let microphoneStream = null;
let audioContext = null;
let recordingDestination = null;
let mediaRecorder = null;
let recordedChunks = [];
let activeMimeType = "";
let includeAudio = true;
let includeVideo = true;
let preferLinkedIn = false;
let videoBitsPerSecond = DEFAULT_VIDEO_BITS;
let audioBitsPerSecond = DEFAULT_AUDIO_BITS;
let soundtrackBuffer = null;
let soundtrackGain = null;
let soundtrackSource = null;
let soundtrackLoop = false;
let soundtrackOffset = 0;
let soundtrackStartedAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  // Ignore anything originating from a tab content script.
  if (sender.tab || !OFFSCREEN_ONLY_TYPES.has(message.type)) {
    return false;
  }

  if (message.type === "frameit-offscreen-ping") {
    sendResponse({ ok: true, source: "offscreen" });
    return false;
  }

  if (message.type === "frameit-recorder-status") {
    sendResponse({ ok: true, ...getRecorderStatus() });
    return false;
  }

  if (message.type === "frameit-acquire-stream") {
    acquireStream(message.streamId, {
      includePointer: Boolean(message.includePointer),
      captureMode: message.captureMode,
      includeAudio: message.includeAudio !== false,
      includeVideo: message.includeVideo !== false,
      includeMicrophone: Boolean(message.includeMicrophone),
      includeSoundtrack: Boolean(message.includeSoundtrack),
      soundtrackLoop: Boolean(message.soundtrackLoop),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-start-recording") {
    startRecording({
      videoBitsPerSecond: message.videoBitsPerSecond,
      audioBitsPerSecond: message.audioBitsPerSecond,
      preferLinkedIn: Boolean(message.preferLinkedIn),
    })
      .then((mimeType) => sendResponse({ ok: true, mimeType }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-pause-recording") {
    try {
      pauseRecording();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  if (message.type === "frameit-resume-recording") {
    try {
      resumeRecording();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  if (message.type === "frameit-fade-soundtrack") {
    try {
      fadeSoundtrackPlayback(message.durationSec);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return false;
  }

  if (message.type === "frameit-stop-recording") {
    stopRecording(message.filename, message.durationSec)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  if (message.type === "frameit-discard") {
    cleanup();
    clearPendingRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) })
      );
    return true;
  }

  return false;
});

function getRecorderStatus() {
  const recorderState = mediaRecorder?.state || "inactive";
  const hasStream = Boolean(
    captureStream && captureStream.getTracks().some((track) => track.readyState === "live")
  );
  return {
    source: "offscreen",
    hasStream,
    recording: recorderState === "recording" || recorderState === "paused",
    paused: recorderState === "paused",
    mimeType: activeMimeType || mediaRecorder?.mimeType || "",
  };
}

async function acquireStream(
  streamId,
  {
    includePointer = false,
    captureMode,
    includeAudio: wantAudio = true,
    includeVideo: wantVideo = true,
    includeMicrophone = false,
    includeSoundtrack = false,
    soundtrackLoop: loopSoundtrack = false,
  } = {}
) {
  cleanup();

  const includeTabAudio =
    captureMode === "video" ? false : captureMode === "audio" ? true : Boolean(wantAudio);
  includeVideo =
    captureMode === "audio" ? false : captureMode === "video" ? true : wantVideo !== false;
  includeAudio = includeTabAudio || Boolean(includeMicrophone) || Boolean(includeSoundtrack);
  soundtrackLoop = Boolean(loopSoundtrack);
  const cursor = includePointer ? "always" : "never";

  async function openStream(withAudio) {
    // Prefer cursor constraint so the OS pointer is not baked into tab capture
    // unless the user opted in. Fall back if the browser rejects it.
    const attempts = [
      {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
          cursor,
        },
      },
      {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
    ];

    let lastError;
    for (const video of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: withAudio
            ? {
                mandatory: {
                  chromeMediaSource: "tab",
                  chromeMediaSourceId: streamId,
                },
              }
            : false,
          video,
        });
        await applyCursorConstraint(stream, cursor);
        await applyFrameRateConstraint(stream);
        return stream;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Failed to acquire tab stream");
  }

  if (includeTabAudio) {
    try {
      tabCaptureStream = await openStream(true);
    } catch (error) {
      cleanup();
      throw new Error(
        `Could not capture tab audio: ${String(error?.message || error)}. ` +
          "Switch to Video only to record without tab audio."
      );
    }
  } else {
    tabCaptureStream = await openStream(false);
  }

  const audioTracks = tabCaptureStream.getAudioTracks();
  if (includeTabAudio && audioTracks.length === 0) {
    cleanup();
    throw new Error(
      "Chrome returned a tab stream without audio. Switch to Video only to record without tab audio."
    );
  }
  if (includeMicrophone) {
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch (error) {
      cleanup();
      throw new Error(
        `Could not capture microphone audio: ${String(error?.message || error)}. ` +
          "Allow microphone access or disable Include microphone audio."
      );
    }
  }

  const hasTabAudio = includeTabAudio && audioTracks.length > 0;
  const hasMicrophoneAudio = Boolean(microphoneStream?.getAudioTracks().length);
  const videoTracks = includeVideo ? tabCaptureStream.getVideoTracks() : [];
  if (!includeVideo) {
    for (const track of tabCaptureStream.getVideoTracks()) {
      track.enabled = false;
    }
  }

  if (includeSoundtrack) {
    const blob = await getSoundtrackAudio();
    if (!blob) {
      cleanup();
      throw new Error("Choose a soundtrack, or turn off the soundtrack.");
    }
    try {
      audioContext = new AudioContext();
      const buffer = await blob.arrayBuffer();
      soundtrackBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    } catch (error) {
      cleanup();
      throw new Error(
        `Could not decode soundtrack: ${String(error?.message || error)}.`
      );
    }
  }

  if (hasTabAudio || hasMicrophoneAudio || soundtrackBuffer) {
    if (!audioContext) audioContext = new AudioContext();
    recordingDestination = audioContext.createMediaStreamDestination();

    if (hasTabAudio) {
      const tabSource = audioContext.createMediaStreamSource(tabCaptureStream);
      tabSource.connect(recordingDestination);
      tabSource.connect(audioContext.destination);
    }
    if (hasMicrophoneAudio) {
      const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
      microphoneSource.connect(recordingDestination);
    }
    if (soundtrackBuffer) {
      soundtrackGain = audioContext.createGain();
      soundtrackGain.gain.value = 1;
      soundtrackGain.connect(recordingDestination);
      soundtrackGain.connect(audioContext.destination);
    }

    captureStream = new MediaStream([
      ...videoTracks,
      ...recordingDestination.stream.getAudioTracks(),
    ]);
  } else {
    captureStream = videoTracks.length
      ? new MediaStream(videoTracks)
      : tabCaptureStream;
  }
}

async function applyCursorConstraint(stream, cursor) {
  const [track] = stream.getVideoTracks();
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({ advanced: [{ cursor }] });
  } catch (_error) {
    try {
      await track.applyConstraints({ cursor });
    } catch (_error2) {
      // Cursor constraint unsupported; content script hides/restores pointer.
    }
  }
}

async function applyFrameRateConstraint(stream) {
  const [track] = stream.getVideoTracks();
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({ frameRate: { ideal: 30, max: 30 } });
  } catch (_error) {
    // Frame-rate constraint unsupported; MediaRecorder defaults apply.
  }
}

function normalizeBitrate(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function buildRecorderOptions(mimeType) {
  const options = {};
  if (mimeType) options.mimeType = mimeType;
  if (includeVideo) {
    options.videoBitsPerSecond = videoBitsPerSecond;
  }
  if (includeAudio && captureStream?.getAudioTracks?.().some((t) => t.readyState === "live")) {
    options.audioBitsPerSecond = audioBitsPerSecond;
  }
  return options;
}

function isFfmpegTranscodingEnabled() {
  return typeof FRAMEIT_FFMPEG_TRANSCODING !== "undefined" && FRAMEIT_FFMPEG_TRANSCODING;
}

async function pickSupportedMime(stream, candidates) {
  for (const mimeType of candidates) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try {
      await probeRecorder(stream, mimeType);
      return mimeType;
    } catch (_error) {
      // Advertised types can still fail at start(); try the next candidate.
    }
  }
  return null;
}

async function pickMimeType(stream) {
  if (!includeVideo) {
    const audioMime = await pickSupportedMime(stream, AUDIO_MIME_CANDIDATES);
    if (audioMime) return audioMime;
    await probeRecorder(stream, undefined);
    return "";
  }

  if (preferLinkedIn) {
    const nativeMp4 = await pickSupportedMime(stream, LINKEDIN_NATIVE_MIME_CANDIDATES);
    if (nativeMp4) return nativeMp4;

    if (isFfmpegTranscodingEnabled()) {
      const webm = await pickSupportedMime(stream, LINKEDIN_WEBM_MIME_CANDIDATES);
      if (webm) return webm;
      throw new Error("This browser cannot record video for LinkedIn");
    }

    throw new Error("This browser cannot record MP4 for LinkedIn");
  }

  const mimeType = await pickSupportedMime(stream, MIME_CANDIDATES);
  if (mimeType) return mimeType;

  await probeRecorder(stream, undefined);
  return "";
}

function needsLinkedInTranscode(mimeType) {
  if (!includeVideo || !preferLinkedIn || !isFfmpegTranscodingEnabled()) return false;
  const mime = (mimeType || "").toLowerCase();
  return mime.includes("webm") || (!mime.includes("mp4") && !mime.includes("avc1"));
}

function reportTranscodeProgress(progress, label) {
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  try {
    chrome.runtime.sendMessage({
      type: "frameit-transcode-progress",
      progress: clamped,
      label: label || "Converting to MP4…",
    });
  } catch (_error) {
    // Best-effort UI update.
  }
}

function reportTranscodeDebug(message, detail) {
  console.log("[frameit-offscreen]", message, detail ?? "");
  try {
    chrome.runtime.sendMessage({
      type: "frameit-debug-log",
      level: "log",
      label: `[frameit] ${message}`,
      detail: detail ?? null,
    });
  } catch (_error) {
    // Best-effort tab console mirror.
  }
}

function transcodeWebmToMp4(blob, durationSec) {
  return new Promise(async (resolve, reject) => {
    let worker;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        worker?.terminate();
      } catch (_error) {
        // ignore
      }
      fn(value);
    };

    try {
      reportTranscodeProgress(0.01, "Preparing conversion…");
      reportTranscodeDebug("starting transcode worker", {
        blobSize: blob.size,
        blobType: blob.type,
        workerUrl: FFMPEG_WORKER_URL,
        hasSAB: typeof SharedArrayBuffer !== "undefined",
        crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
      });
      const inputBuffer = await blob.arrayBuffer();
      reportTranscodeDebug("input buffer ready", {
        bytes: inputBuffer.byteLength,
      });
      worker = new Worker(FFMPEG_WORKER_URL);
      reportTranscodeDebug("worker constructed");
      worker.onmessage = (event) => {
        const data = event.data || {};
        if (data.type === "debug") {
          reportTranscodeDebug(data.message, data.detail);
          return;
        }
        if (data.type === "progress") {
          reportTranscodeDebug("progress", {
            progress: data.progress,
            label: data.label,
          });
          reportTranscodeProgress(data.progress, data.label);
          return;
        }
        if (data.type === "done") {
          reportTranscodeDebug("worker done", {
            bytes: data.buffer?.byteLength ?? null,
          });
          finish(resolve, new Blob([data.buffer], { type: "video/mp4" }));
          return;
        }
        if (data.type === "error") {
          reportTranscodeDebug("worker error", {
            error: data.error,
            stack: data.stack,
          });
          finish(reject, new Error(data.error || "FFmpeg transcoding failed"));
        }
      };
      worker.onerror = (event) => {
        reportTranscodeDebug("worker onerror", {
          message: event?.message,
          filename: event?.filename,
          lineno: event?.lineno,
          colno: event?.colno,
        });
        finish(
          reject,
          new Error(event?.message || "FFmpeg worker failed to start")
        );
      };
      worker.postMessage(
        {
          type: "transcode",
          buffer: inputBuffer,
          durationSec: Number(durationSec) || null,
        },
        [inputBuffer]
      );
      reportTranscodeDebug("transcode message posted to worker");
    } catch (error) {
      reportTranscodeDebug("failed before worker run", {
        error: String(error?.message || error),
        stack: error?.stack || null,
      });
      finish(reject, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function probeRecorder(stream, mimeType) {
  return new Promise((resolve, reject) => {
    let recorder;
    try {
      recorder = new MediaRecorder(stream, buildRecorderOptions(mimeType));
    } catch (error) {
      reject(error);
      return;
    }

    const fail = (error) => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch (_e) {
        // ignore
      }
      reject(error || new Error("MediaRecorder probe failed"));
    };

    recorder.onerror = (event) => fail(event.error || new Error("probe error"));
    recorder.onstart = () => {
      try {
        recorder.stop();
      } catch (error) {
        fail(error);
      }
    };
    recorder.onstop = () => resolve();

    try {
      recorder.start(100);
    } catch (error) {
      fail(error);
    }
  });
}

async function startRecording({
  videoBitsPerSecond: videoBits,
  audioBitsPerSecond: audioBits,
  preferLinkedIn: wantLinkedIn = false,
} = {}) {
  if (!captureStream) {
    throw new Error("Capture stream is not ready");
  }

  preferLinkedIn = Boolean(wantLinkedIn);
  videoBitsPerSecond = normalizeBitrate(videoBits, DEFAULT_VIDEO_BITS);
  audioBitsPerSecond = normalizeBitrate(audioBits, DEFAULT_AUDIO_BITS);

  recordedChunks = [];
  activeMimeType = await pickMimeType(captureStream);

  mediaRecorder = new MediaRecorder(
    captureStream,
    buildRecorderOptions(activeMimeType || undefined)
  );

  activeMimeType = mediaRecorder.mimeType || activeMimeType || defaultRecorderMime();

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  if (audioContext?.state === "suspended") {
    try {
      await audioContext.resume();
    } catch (_error) {
      // Soundtrack may still start if the context is already allowed.
    }
  }

  mediaRecorder.start(1000);
  startSoundtrackPlayback();
  return activeMimeType;
}

function pauseRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") {
    throw new Error("Recorder is not recording");
  }
  pauseSoundtrackPlayback();
  mediaRecorder.pause();
}

function resumeRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "paused") {
    throw new Error("Recorder is not paused");
  }
  mediaRecorder.resume();
  resumeSoundtrackPlayback();
}

async function stopRecording(filename, durationSec) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    throw new Error("Recorder is not active");
  }
  if (!filename || typeof filename !== "string") {
    throw new Error("Missing download filename");
  }

  const mimeType = activeMimeType || mediaRecorder.mimeType || defaultRecorderMime();
  stopSoundtrackPlayback();

  await new Promise((resolve, reject) => {
    mediaRecorder.onstop = () => resolve();
    mediaRecorder.onerror = (event) =>
      reject(event.error || new Error("Recorder failed while stopping"));
    try {
      if (mediaRecorder.state === "recording") {
        mediaRecorder.requestData();
      }
      mediaRecorder.stop();
    } catch (error) {
      reject(error);
    }
  });

  let blob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];

  if (blob.size === 0) {
    cleanup();
    throw new Error("Recording produced an empty file");
  }

  let finalMime = mimeType;
  let videoCodec = includeVideo ? await detectVideoCodec(blob, mimeType) : "";
  let finalFilename = replaceFilenameExtension(
    filename,
    extensionFromMimeType(mimeType)
  );

  if (needsLinkedInTranscode(mimeType)) {
    reportTranscodeProgress(0.01, "Converting to MP4…");
    try {
      blob = await transcodeWebmToMp4(blob, durationSec);
      finalMime = "video/mp4";
      videoCodec = "h264";
      finalFilename = replaceFilenameExtension(filename, ".mp4");
    } catch (error) {
      const detail = {
        mimeType,
        size: blob.size,
        videoCodec,
        error: String(error?.message || error),
        stack: error?.stack || null,
      };
      console.error("[frameit] LinkedIn MP4 transcoding failed", detail);
      try {
        chrome.runtime.sendMessage({
          type: "frameit-debug-log",
          level: "error",
          label: "[frameit] LinkedIn MP4 transcoding failed",
          detail,
        });
      } catch (_sendError) {
        // Best-effort tab console mirror.
      }
      cleanup();
      throw new Error(
        `LinkedIn MP4 transcoding failed: ${String(error?.message || error)}`
      );
    }
  }

  const codecFilename = appendCodecToFilename(finalFilename, videoCodec);

  // Offscreen cannot use chrome.downloads; hand the blob to the SW via IndexedDB.
  await putPendingRecording(blob);
  cleanup();

  return {
    mimeType: finalMime,
    videoCodec,
    size: blob.size,
    filename: codecFilename,
    extension: extensionFromMimeType(finalMime),
  };
}

async function detectVideoCodec(blob, mimeType) {
  const declaredCodec = codecFromMimeType(mimeType);
  if (declaredCodec) return declaredCodec;

  // MediaRecorder may report only "video/mp4" even when it writes VP9.
  // Codec metadata is near the start of both MP4 and WebM recordings.
  try {
    const bytes = await blob.slice(0, 4 * 1024 * 1024).arrayBuffer();
    const metadata = new TextDecoder("latin1").decode(bytes);
    const signatures = [
      [/\b(?:avc1|avc3)\b/i, "h264"],
      [/\b(?:vp09|V_VP9)\b/i, "vp9"],
      [/\b(?:vp08|V_VP8)\b/i, "vp8"],
      [/\b(?:av01|V_AV1)\b/i, "av1"],
      [/\b(?:hvc1|hev1)\b/i, "h265"],
    ];
    return signatures.find(([pattern]) => pattern.test(metadata))?.[1] || "unknown";
  } catch (_error) {
    return "unknown";
  }
}

function codecFromMimeType(mimeType) {
  const codecs = /codecs\s*=\s*"?([^";]+)/i.exec(mimeType || "")?.[1];
  if (!codecs) return "";

  for (const codec of codecs.toLowerCase().split(",").map((value) => value.trim())) {
    if (codec.startsWith("avc1") || codec.startsWith("avc3")) return "h264";
    if (codec.startsWith("vp9") || codec.startsWith("vp09")) return "vp9";
    if (codec.startsWith("vp8") || codec.startsWith("vp08")) return "vp8";
    if (codec.startsWith("av01")) return "av1";
    if (codec.startsWith("hvc1") || codec.startsWith("hev1")) return "h265";
  }
  return "";
}

function appendCodecToFilename(filename, codec) {
  if (!codec) return filename;
  const suffixIndex = filename.lastIndexOf(".");
  if (suffixIndex <= 0) return `${filename}.${codec}`;
  return `${filename.slice(0, suffixIndex)}.${codec}${filename.slice(suffixIndex)}`;
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

function defaultRecorderMime() {
  return includeVideo ? "video/webm" : "audio/webm";
}

function startSoundtrackPlayback() {
  if (!soundtrackBuffer || !audioContext || !soundtrackGain) return;
  resetSoundtrackGain(1);
  soundtrackOffset = 0;
  playSoundtrackFrom(0);
}

function fadeSoundtrackPlayback(durationSec) {
  if (!soundtrackGain || !audioContext) return;
  const duration = Math.max(0, Number(durationSec) || 0);
  const now = audioContext.currentTime;
  const param = soundtrackGain.gain;
  param.cancelScheduledValues(now);
  const current = Number.isFinite(param.value) ? Math.max(param.value, 0) : 1;
  param.setValueAtTime(Math.max(current, 0.0001), now);
  if (duration <= 0.02) {
    param.setValueAtTime(0, now);
    return;
  }
  param.exponentialRampToValueAtTime(0.001, now + duration);
  param.setValueAtTime(0, now + duration);
}

function resetSoundtrackGain(value) {
  if (!soundtrackGain || !audioContext) return;
  const now = audioContext.currentTime;
  const param = soundtrackGain.gain;
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, now);
}

function pauseSoundtrackPlayback() {
  if (!soundtrackSource || !audioContext) return;
  const elapsed = Math.max(0, audioContext.currentTime - soundtrackStartedAt);
  soundtrackOffset += elapsed;
  if (soundtrackLoop && soundtrackBuffer?.duration) {
    soundtrackOffset %= soundtrackBuffer.duration;
  } else if (soundtrackBuffer?.duration) {
    soundtrackOffset = Math.min(soundtrackOffset, soundtrackBuffer.duration);
  }
  stopSoundtrackSource();
}

function resumeSoundtrackPlayback() {
  if (!soundtrackBuffer || !audioContext || !soundtrackGain) return;
  playSoundtrackFrom(soundtrackOffset);
  if (audioContext.state === "suspended") {
    audioContext.resume().catch(() => {});
  }
}

function playSoundtrackFrom(offset) {
  stopSoundtrackSource();
  if (!soundtrackBuffer || !audioContext || !soundtrackGain) return;
  const duration = soundtrackBuffer.duration || 0;
  const startOffset = duration > 0 ? Math.max(0, Math.min(offset, duration)) : 0;
  if (!soundtrackLoop && duration > 0 && startOffset >= duration) return;

  soundtrackSource = audioContext.createBufferSource();
  soundtrackSource.buffer = soundtrackBuffer;
  soundtrackSource.loop = soundtrackLoop;
  soundtrackSource.connect(soundtrackGain);
  soundtrackStartedAt = audioContext.currentTime;
  soundtrackSource.start(0, startOffset);
}

function stopSoundtrackPlayback() {
  stopSoundtrackSource();
  soundtrackOffset = 0;
  soundtrackStartedAt = 0;
}

function stopSoundtrackSource() {
  if (!soundtrackSource) return;
  try {
    soundtrackSource.stop();
  } catch (_error) {
    // Already stopped.
  }
  try {
    soundtrackSource.disconnect();
  } catch (_error) {
    // ignore
  }
  soundtrackSource = null;
}

function replaceFilenameExtension(filename, extension) {
  const suffixIndex = filename.lastIndexOf(".");
  if (suffixIndex <= 0) return `${filename}${extension}`;
  return `${filename.slice(0, suffixIndex)}${extension}`;
}

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch (_error) {
      // ignore
    }
  }
  mediaRecorder = null;
  recordedChunks = [];
  activeMimeType = "";
  includeAudio = true;
  includeVideo = true;
  preferLinkedIn = false;
  videoBitsPerSecond = DEFAULT_VIDEO_BITS;
  audioBitsPerSecond = DEFAULT_AUDIO_BITS;
  stopSoundtrackPlayback();
  soundtrackBuffer = null;
  soundtrackLoop = false;
  if (soundtrackGain) {
    try {
      soundtrackGain.disconnect();
    } catch (_error) {
      // ignore
    }
    soundtrackGain = null;
  }
  recordingDestination = null;

  if (captureStream) {
    for (const track of captureStream.getTracks()) {
      track.stop();
    }
    captureStream = null;
  }

  if (tabCaptureStream) {
    for (const track of tabCaptureStream.getTracks()) {
      track.stop();
    }
    tabCaptureStream = null;
  }

  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) {
      track.stop();
    }
    microphoneStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}
