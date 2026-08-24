/* global createFFmpegCore */

const CORE_JS = "ffmpeg-to_mp4.js";
const CORE_WASM = new URL("ffmpeg-to_mp4.wasm", self.location.href).href;

let corePromise = null;

function debug(message, detail) {
  const payload = {
    type: "debug",
    message: String(message),
    detail: detail ?? null,
    t: Date.now(),
  };
  try {
    console.log("[frameit-ffmpeg-worker]", message, detail ?? "");
  } catch (_error) {
    // ignore
  }
  try {
    self.postMessage(payload);
  } catch (_error) {
    // ignore
  }
}

function installPthreadWorkerRedirect() {
  // importScripts() leaves _scriptName as this worker's URL, so Emscripten would
  // spawn em-pthread children as transcode-worker.js (which never bootstraps).
  // Redirect those nested Workers to the real ffmpeg glue script.
  const pthreadJs = new URL(CORE_JS, self.location.href).href;
  const OrigWorker = self.Worker;
  if (!OrigWorker || OrigWorker.__frameitPthreadRedirect) return pthreadJs;

  function PatchedWorker(url, options) {
    const requested = String(url);
    const useUrl =
      requested === String(self.location.href) ||
      requested.endsWith("/transcode-worker.js") ||
      requested.endsWith("transcode-worker.js")
        ? pthreadJs
        : requested;
    if (useUrl !== requested) {
      debug("pthread Worker redirected", { from: requested, to: useUrl, options });
    } else {
      debug("pthread Worker spawn", { url: useUrl, options });
    }
    const worker = new OrigWorker(useUrl, options);
    worker.addEventListener("error", (event) => {
      debug("pthread Worker error", {
        message: event?.message,
        filename: event?.filename,
        lineno: event?.lineno,
      });
    });
    return worker;
  }
  PatchedWorker.prototype = OrigWorker.prototype;
  PatchedWorker.__frameitPthreadRedirect = true;
  self.Worker = PatchedWorker;
  return pthreadJs;
}

function loadCore(onLog) {
  if (!corePromise) {
    corePromise = (async () => {
      debug("loadCore: start", {
        coreJs: CORE_JS,
        coreWasm: CORE_WASM,
        href: String(self.location?.href || ""),
        hasSAB: typeof SharedArrayBuffer !== "undefined",
        crossOriginIsolated: Boolean(self.crossOriginIsolated),
        userAgent: String(self.navigator?.userAgent || ""),
      });

      const pthreadJs = installPthreadWorkerRedirect();
      debug("loadCore: importScripts begin", { coreJs: CORE_JS, pthreadJs });
      importScripts(CORE_JS);
      debug("loadCore: importScripts done", {
        createFFmpegCoreType: typeof createFFmpegCore,
      });

      if (typeof createFFmpegCore !== "function") {
        throw new Error("FFmpeg WASM module is unavailable in worker");
      }

      const logs = [];
      let createSettled = false;
      const createStartedAt = Date.now();
      const hangTimer = setInterval(() => {
        if (createSettled) return;
        debug("loadCore: still waiting on createFFmpegCore", {
          waitedMs: Date.now() - createStartedAt,
          logLines: logs.length,
          lastLog: logs.length ? logs[logs.length - 1] : null,
        });
      }, 2000);

      debug("loadCore: createFFmpegCore begin");
      try {
        const core = await createFFmpegCore({
          locateFile(path) {
            const resolved = String(path).endsWith(".wasm")
              ? CORE_WASM
              : new URL(String(path), self.location.href).href;
            debug("loadCore: locateFile", { path: String(path), resolved });
            return resolved;
          },
          onRuntimeInitialized() {
            debug("loadCore: onRuntimeInitialized");
          },
          print(text) {
            const line = String(text);
            logs.push(line);
            debug("ffmpeg stdout", line);
            if (onLog) onLog(line);
          },
          printErr(text) {
            const line = String(text);
            logs.push(line);
            debug("ffmpeg stderr", line);
            if (onLog) onLog(line);
          },
        });
        createSettled = true;
        clearInterval(hangTimer);
        debug("loadCore: createFFmpegCore done", {
          waitedMs: Date.now() - createStartedAt,
          hasFS: Boolean(core?.FS),
          hasCallMain: typeof core?.callMain === "function",
        });
        core.__frameitLogs = logs;
        return core;
      } catch (error) {
        createSettled = true;
        clearInterval(hangTimer);
        debug("loadCore: createFFmpegCore failed", {
          error: String(error?.message || error),
          stack: error?.stack || null,
          waitedMs: Date.now() - createStartedAt,
          logLines: logs.length,
        });
        throw error;
      }
    })().catch((error) => {
      corePromise = null;
      throw error;
    });
  }
  return corePromise;
}

function consumeLogs(core) {
  const logs = Array.isArray(core?.__frameitLogs) ? core.__frameitLogs.splice(0) : [];
  return logs.join("\n").trim();
}

function parseClock(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function createProgressTracker(post, expectedDurationSec) {
  let durationSec =
    Number.isFinite(Number(expectedDurationSec)) && Number(expectedDurationSec) > 0
      ? Number(expectedDurationSec)
      : null;
  let lastEmit = 0;
  return (line) => {
    if (durationSec == null) {
      const durationMatch = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
      if (durationMatch) durationSec = parseClock(durationMatch[1]);
    }
    const timeMatch =
      /(?:^|\s)(?:out_time|time)=(\d+:\d+:\d+(?:\.\d+)?)/.exec(line);
    if (!timeMatch || !(durationSec > 0)) return;
    const current = parseClock(timeMatch[1]);
    if (current == null) return;
    const ratio = Math.max(0, Math.min(0.97, current / durationSec));
    const now = Date.now();
    if (now - lastEmit < 200 && ratio < 0.97) return;
    lastEmit = now;
    post({
      type: "progress",
      progress: 0.12 + ratio * 0.83,
      label: "Converting to MP4…",
    });
  };
}

function runMain(core, args) {
  debug("runMain: begin", { args });
  let exitCode = 0;
  try {
    const result = core.callMain(args);
    if (typeof result === "number") exitCode = result;
    debug("runMain: returned", { exitCode: result });
  } catch (error) {
    if (error && typeof error.status === "number") {
      exitCode = error.status;
      debug("runMain: ExitStatus", { exitCode });
    } else {
      const logs = consumeLogs(core);
      const message = String(error?.message || error);
      debug("runMain: threw", { message, logs });
      throw new Error(logs ? `${message}\n${logs}` : message);
    }
  }
  return { exitCode, logs: consumeLogs(core) };
}

async function transcode(inputBuffer, durationSec) {
  const inputName = "input.webm";
  const outputName = "output.mp4";
  const inputData = new Uint8Array(inputBuffer);
  debug("transcode: input ready", { bytes: inputData.byteLength });

  const attempts = [
    [
      "-y",
      "-nostats",
      "-stats_period",
      "0.25",
      "-progress",
      "/dev/stderr",
      "-threads:v",
      "1",
      "-i",
      inputName,
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputName,
    ],
    [
      "-y",
      "-nostats",
      "-stats_period",
      "0.25",
      "-progress",
      "/dev/stderr",
      "-threads:v",
      "1",
      "-i",
      inputName,
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      "-an",
      "-movflags",
      "+faststart",
      outputName,
    ],
  ];

  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    debug("transcode: attempt", { index: i, args: attempts[i] });
    corePromise = null;
    const onLog = createProgressTracker(
      (msg) => self.postMessage(msg),
      durationSec
    );
    self.postMessage({
      type: "progress",
      progress: 0.08,
      label: "Loading converter…",
    });
    const core = await loadCore(onLog);
    try {
      self.postMessage({
        type: "progress",
        progress: 0.1,
        label: "Converting to MP4…",
      });
      core.FS.writeFile(inputName, inputData);
      debug("transcode: wrote input", { inputName, bytes: inputData.byteLength });
      const { exitCode, logs } = runMain(core, attempts[i]);
      if (exitCode !== 0) {
        lastError = new Error(
          logs
            ? `FFmpeg exited with code ${exitCode}\n${logs}`
            : `FFmpeg exited with code ${exitCode}`
        );
        debug("transcode: attempt failed", {
          index: i,
          exitCode,
          logs,
        });
        continue;
      }
      self.postMessage({
        type: "progress",
        progress: 0.98,
        label: "Finishing…",
      });
      const outputData = core.FS.readFile(outputName);
      debug("transcode: read output", {
        bytes: outputData?.length || 0,
      });
      if (!outputData || outputData.length === 0) {
        lastError = new Error(
          logs ? `FFmpeg produced an empty MP4\n${logs}` : "FFmpeg produced an empty MP4"
        );
        continue;
      }
      const copy = outputData.slice();
      self.postMessage(
        {
          type: "done",
          progress: 1,
          label: "Conversion complete",
          buffer: copy.buffer,
        },
        [copy.buffer]
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      debug("transcode: attempt exception", {
        index: i,
        error: String(lastError.message || lastError),
        stack: lastError.stack || null,
      });
    } finally {
      try {
        core.FS.unlink(inputName);
      } catch (_error) {
        // ignore
      }
      try {
        core.FS.unlink(outputName);
      } catch (_error) {
        // ignore
      }
      corePromise = null;
    }
  }

  throw lastError || new Error("FFmpeg transcoding failed");
}

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== "transcode") return;
  try {
    debug("worker: transcode message received", {
      bufferBytes: data.buffer?.byteLength ?? null,
      hasSAB: typeof SharedArrayBuffer !== "undefined",
      crossOriginIsolated: Boolean(self.crossOriginIsolated),
    });
    if (typeof SharedArrayBuffer === "undefined") {
      throw new Error(
        "SharedArrayBuffer is unavailable, so the threaded FFmpeg WASM build cannot run in this context"
      );
    }
    self.postMessage({
      type: "progress",
      progress: 0.02,
      label: "Preparing conversion…",
    });
    await transcode(data.buffer, data.durationSec);
  } catch (error) {
    debug("worker: transcode failed", {
      error: String(error?.message || error),
      stack: error?.stack || null,
    });
    self.postMessage({
      type: "error",
      error: String(error?.message || error),
      stack: error?.stack || null,
    });
  }
};
