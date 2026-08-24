(() => {
  if (window.__frameItOverlayLoaded) {
    return;
  }
  window.__frameItOverlayLoaded = true;

  const ROOT_ID = "frameit-root";
  const CURSOR_STYLE_ID = "frameit-cursor-style";

  let hostEl = null;
  let shadowRoot = null;
  let cssTextPromise = null;
  let timerId = null;
  let recordingStartedAt = 0;
  let totalPausedMs = 0;
  let pausedAt = 0;
  let isPaused = false;
  let pointerEl = null;
  let onPointerMove = null;
  let onSessionKeyDown = null;
  let sessionBusy = false;
  let sessionStopping = false;
  let frozenElapsedMs = null;
  let sessionUi = null; // { bar, pauseBtn, stopBtn, updateTime } when on-page bar exists
  let sessionActive = false;
  let sessionOptions = null;
  let guardTimerId = null;
  let remountScheduled = false;
  let regionCleanup = null;
  let snapshotActive = false;

  const ICON_PAUSE = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1"></rect>
      <rect x="14" y="5" width="4" height="14" rx="1"></rect>
    </svg>`;
  const ICON_CONTINUE = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z"></path>
    </svg>`;
  const ICON_STOP = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2"></rect>
    </svg>`;
  const ICON_CANCEL = `
    <svg class="frameit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"></path>
    </svg>`;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    // Only accept overlay commands from this extension.
    if (sender.id !== chrome.runtime.id) {
      return false;
    }

    if (message.type === "frameit-show-countdown") {
      showCountdown({
        seconds: 3,
        label: "Starting capture...",
        doneType: "frameit-countdown-done",
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message.type === "frameit-show-snapshot-countdown") {
      const seconds = Math.max(0, Math.min(60, Number(message.seconds) || 0));
      showCountdown({
        seconds,
        label: message.label || "Taking snapshot...",
        doneType: "frameit-snapshot-countdown-done",
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message.type === "frameit-start-region-select") {
      showRegionSelect()
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message.type === "frameit-show-session-bar") {
      recordingStartedAt = message.startedAt || Date.now();
      totalPausedMs = Number(message.totalPausedMs) || 0;
      pausedAt = Number(message.pausedAt) || 0;
      isPaused = Boolean(message.paused);
      showSessionBar({
        includeLogo: message.includeLogo !== false,
        logoDataUrl: normalizeLogoDataUrl(message.logoDataUrl),
        hideControls: message.hideControls !== false,
        includePointer: Boolean(message.includePointer),
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message.type === "frameit-ping-overlay") {
      sendResponse({
        ok: true,
        active: sessionActive,
        connected: Boolean(hostEl?.isConnected),
      });
      return false;
    }

    if (message.type === "frameit-teardown") {
      teardown();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "frameit-session-stopping") {
      beginStoppingUi();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "frameit-transcode-progress") {
      updateTranscodeProgress(
        Number(message.progress) || 0,
        message.label || "Converting to MP4…"
      );
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "frameit-console-log") {
      const level =
        message.level === "warn" ||
        message.level === "log" ||
        message.level === "info" ||
        message.level === "error"
          ? message.level
          : "error";
      const label = message.label || "[frameit]";
      const detail = message.detail;
      if (detail === undefined || detail === null) {
        console[level](label);
      } else {
        console[level](label, detail);
      }
      sendResponse({ ok: true });
      return false;
    }

    // Ignore internal offscreen/background traffic broadcast on this channel.
    return false;
  });

  document.addEventListener("fullscreenchange", () => {
    if ((!sessionActive && !snapshotActive) || !hostEl) return;
    placeHost(hostEl);
  });

  function loadCssText() {
    if (!cssTextPromise) {
      cssTextPromise = fetch(chrome.runtime.getURL("content.css"))
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to load overlay CSS (${response.status})`);
          }
          return response.text();
        })
        .catch((error) => {
          cssTextPromise = null;
          throw error;
        });
    }
    return cssTextPromise;
  }

  async function ensureRoot() {
    if (hostEl?.isConnected && shadowRoot) {
      placeHost(hostEl);
      return shadowRoot;
    }

    const cssText = await loadCssText();

    if (hostEl && !hostEl.isConnected) {
      hostEl.remove();
      hostEl = null;
      shadowRoot = null;
    }

    if (!hostEl) {
      hostEl = document.createElement("div");
      hostEl.id = ROOT_ID;
      hostEl.setAttribute("data-frameit", "true");
      // Closed shadow isolates controls from aggressive host-page CSS.
      shadowRoot = hostEl.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = cssText;
      shadowRoot.appendChild(style);
    }

    placeHost(hostEl);
    startDomGuard();
    return shadowRoot;
  }

  function canContainOverlay(el) {
    if (!el || el === hostEl) return false;
    if (el === document.documentElement || el === document.body) return true;
    if (el.nodeType !== 1) return false;
    const tag = el.tagName;
    // Replaced/media elements cannot host child overlay nodes.
    return !(
      tag === "VIDEO" ||
      tag === "AUDIO" ||
      tag === "IMG" ||
      tag === "CANVAS" ||
      tag === "IFRAME" ||
      tag === "EMBED" ||
      tag === "OBJECT"
    );
  }

  function placeHost(host) {
    const fullscreenEl = document.fullscreenElement;
    const parent =
      fullscreenEl && canContainOverlay(fullscreenEl)
        ? fullscreenEl
        : document.documentElement;
    if (host.parentElement !== parent) {
      parent.appendChild(host);
    }
  }

  function clearShadowContent() {
    if (!shadowRoot) return;
    for (const node of [...shadowRoot.childNodes]) {
      if (node.nodeName === "STYLE") continue;
      node.remove();
    }
  }

  function startDomGuard() {
    if (guardTimerId != null) return;
    // Poll lightly: busy SPAs mutate constantly, and fullscreen/top-layer
    // changes can detach the host without a reliable single mutation target.
    guardTimerId = window.setInterval(() => {
      if (!sessionActive && !snapshotActive) return;
      if (hostEl?.isConnected) {
        placeHost(hostEl);
        return;
      }
      if (sessionActive) scheduleRemount();
    }, 1000);
  }

  function stopDomGuard() {
    if (guardTimerId != null) {
      window.clearInterval(guardTimerId);
      guardTimerId = null;
    }
  }

  function scheduleRemount() {
    if (!sessionActive || sessionStopping || remountScheduled) return;
    remountScheduled = true;
    queueMicrotask(async () => {
      remountScheduled = false;
      if (!sessionActive || sessionStopping || hostEl?.isConnected) return;
      try {
        await showSessionBar(sessionOptions || {});
      } catch (_error) {
        // Page may be unloading.
      }
    });
  }

  async function showCountdown({
    seconds = 3,
    label = "Starting capture...",
    doneType = "frameit-countdown-done",
  } = {}) {
    const isSnapshot = doneType === "frameit-snapshot-countdown-done";
    if (isSnapshot) snapshotActive = true;
    else sessionActive = true;

    const root = await ensureRoot();
    clearShadowContent();
    clearTimer();
    stopPointer();
    unbindSessionKeys();
    clearRegionSelect();
    sessionUi = null;

    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    if (totalSeconds <= 0) {
      await waitFrames(2);
      await delay(50);
      try {
        await chrome.runtime.sendMessage({ type: doneType });
      } catch (_error) {
        // Session/snapshot may have been aborted.
      }
      return;
    }

    const logoUrl = chrome.runtime.getURL("assets/exergy_connect_logo.png");
    const safeLabel = escapeHtml(label);
    const overlay = document.createElement("div");
    overlay.className = "frameit-countdown";
    overlay.innerHTML = `
      <div class="frameit-countdown__card">
        <img
          class="frameit-countdown__logo"
          src="${logoUrl}"
          alt="Exergy Connect"
          width="56"
          height="56"
        />
        <div class="frameit-countdown__brand">Exergy ∞ xFrame</div>
        <div class="frameit-countdown__number" aria-live="polite">${totalSeconds}</div>
        <div class="frameit-countdown__label">${safeLabel}</div>
      </div>
    `;
    root.appendChild(overlay);

    const numberEl = overlay.querySelector(".frameit-countdown__number");
    let count = totalSeconds;

    return new Promise((resolve) => {
      let settled = false;
      const onCountdownKey = (event) => {
        if (isSnapshot) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
        if (isTypingTarget(event.target)) return;
        if (String(event.key || "").toLowerCase() !== "escape") return;
        event.preventDefault();
        if (settled) return;
        settled = true;
        clearTimer();
        window.removeEventListener("keydown", onCountdownKey, true);
        overlay.remove();
        cancelRecording().finally(() => resolve());
      };
      window.addEventListener("keydown", onCountdownKey, true);

      const finish = async () => {
        if (settled) return;
        settled = true;
        window.removeEventListener("keydown", onCountdownKey, true);
        overlay.remove();
        await waitFrames(2);
        await delay(100);
        try {
          await chrome.runtime.sendMessage({ type: doneType });
        } catch (_error) {
          // Session/snapshot may have been aborted.
        }
        resolve();
      };

      const tick = () => {
        if (settled) return;
        count -= 1;
        if (count > 0) {
          numberEl.textContent = String(count);
          timerId = window.setTimeout(tick, 1000);
          return;
        }
        finish();
      };

      timerId = window.setTimeout(tick, 1000);
    });
  }

  async function showRegionSelect() {
    snapshotActive = true;
    const root = await ensureRoot();
    clearShadowContent();
    clearTimer();
    stopPointer();
    unbindSessionKeys();
    clearRegionSelect();
    sessionUi = null;

    const surface = document.createElement("div");
    surface.className = "frameit-region";
    surface.innerHTML = `
      <div class="frameit-region__hint">Drag to select a region · Esc to cancel</div>
      <div class="frameit-region__shade frameit-region__shade--top"></div>
      <div class="frameit-region__shade frameit-region__shade--left"></div>
      <div class="frameit-region__shade frameit-region__shade--right"></div>
      <div class="frameit-region__shade frameit-region__shade--bottom"></div>
      <div class="frameit-region__rect">
        <div class="frameit-region__size"></div>
      </div>
    `;
    root.appendChild(surface);

    const shadeTop = surface.querySelector(".frameit-region__shade--top");
    const shadeLeft = surface.querySelector(".frameit-region__shade--left");
    const shadeRight = surface.querySelector(".frameit-region__shade--right");
    const shadeBottom = surface.querySelector(".frameit-region__shade--bottom");
    const rectEl = surface.querySelector(".frameit-region__rect");
    const sizeEl = surface.querySelector(".frameit-region__size");
    const hintEl = surface.querySelector(".frameit-region__hint");

    let originX = 0;
    let originY = 0;
    let currentRect = null;
    let dragging = false;
    let finished = false;

    const MIN_SIZE = 4;

    function viewportSize() {
      return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    }

    function normalizeRect(x0, y0, x1, y1) {
      const left = Math.min(x0, x1);
      const top = Math.min(y0, y1);
      const right = Math.max(x0, x1);
      const bottom = Math.max(y0, y1);
      return {
        x: Math.max(0, left),
        y: Math.max(0, top),
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
      };
    }

    function paintRect(rect) {
      currentRect = rect;
      const { viewportWidth, viewportHeight } = viewportSize();
      const hasRect = rect && rect.width > 0 && rect.height > 0;

      if (!hasRect) {
        shadeTop.style.height = `${viewportHeight}px`;
        shadeLeft.style.cssText = "display:none";
        shadeRight.style.cssText = "display:none";
        shadeBottom.style.cssText = "display:none";
        rectEl.style.display = "none";
        return;
      }

      shadeTop.style.cssText = `height:${rect.y}px;`;
      shadeLeft.style.cssText = `top:${rect.y}px;width:${rect.x}px;height:${rect.height}px;`;
      shadeRight.style.cssText = `top:${rect.y}px;left:${rect.x + rect.width}px;width:${Math.max(
        0,
        viewportWidth - rect.x - rect.width
      )}px;height:${rect.height}px;`;
      shadeBottom.style.cssText = `top:${rect.y + rect.height}px;height:${Math.max(
        0,
        viewportHeight - rect.y - rect.height
      )}px;`;
      rectEl.style.cssText = `display:block;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;`;
      sizeEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    }

    paintRect(null);

    async function finishOk(rect) {
      if (finished) return;
      finished = true;
      clearRegionSelect();
      surface.remove();
      await waitFrames(2);
      await delay(50);
      try {
        await chrome.runtime.sendMessage({
          type: "frameit-snapshot-selection-done",
          ...rect,
          ...viewportSize(),
        });
      } catch (_error) {
        // Snapshot may have been aborted.
      }
    }

    async function finishCancel() {
      if (finished) return;
      finished = true;
      clearRegionSelect();
      surface.remove();
      try {
        await chrome.runtime.sendMessage({ type: "frameit-snapshot-cancel" });
      } catch (_error) {
        // Snapshot may have been aborted.
      }
    }

    function onPointerDown(event) {
      if (event.button !== 0 || finished) return;
      event.preventDefault();
      dragging = true;
      originX = event.clientX;
      originY = event.clientY;
      hintEl.hidden = true;
      paintRect(normalizeRect(originX, originY, originX, originY));
      surface.setPointerCapture?.(event.pointerId);
    }

    function onPointerMove(event) {
      if (!dragging || finished) return;
      paintRect(normalizeRect(originX, originY, event.clientX, event.clientY));
    }

    function onPointerUp(event) {
      if (!dragging || finished) return;
      dragging = false;
      const rect = normalizeRect(originX, originY, event.clientX, event.clientY);
      paintRect(rect);
      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        paintRect(null);
        hintEl.hidden = false;
        return;
      }
      finishOk(rect);
    }

    function onKeyDown(event) {
      if (finished) return;
      if (event.key === "Escape") {
        event.preventDefault();
        finishCancel();
        return;
      }
      if (event.key === "Enter" && currentRect) {
        if (currentRect.width >= MIN_SIZE && currentRect.height >= MIN_SIZE) {
          event.preventDefault();
          finishOk(currentRect);
        }
      }
    }

    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown, true);

    regionCleanup = () => {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown, true);
      regionCleanup = null;
    };
  }

  function clearRegionSelect() {
    if (regionCleanup) {
      regionCleanup();
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function showSessionBar({
    includeLogo = true,
    logoDataUrl = null,
    hideControls = true,
    includePointer = false,
  } = {}) {
    sessionOptions = {
      includeLogo,
      logoDataUrl,
      hideControls,
      includePointer,
    };
    sessionActive = true;

    const root = await ensureRoot();
    clearShadowContent();
    stopPointer();
    unbindSessionKeys();
    clearTimer();
    sessionBusy = false;
    sessionStopping = false;
    frozenElapsedMs = null;
    sessionUi = null;

    if (includeLogo) {
      const customLogo = normalizeLogoDataUrl(logoDataUrl);
      const logoUrl =
        customLogo || chrome.runtime.getURL("assets/exergy_connect_logo.png");
      const watermark = document.createElement("img");
      watermark.className = "frameit-watermark";
      watermark.src = logoUrl;
      watermark.alt = customLogo ? "Recording logo" : "Exergy Connect";
      watermark.width = 48;
      watermark.height = 48;
      root.appendChild(watermark);
    }

    if (includePointer) {
      startPointer(root);
    }

    // Always hide the native cursor while recording (capture stays clean).
    // Use P = pause/continue and S = stop & save when the cursor is hidden.
    hideNativeCursor(true);
    bindSessionKeys();

    // When controls are hidden from the video, omit the on-page session bar.
    // The extension popup (and P/S keys) provide pause / stop instead.
    if (hideControls) {
      return;
    }

    const bar = document.createElement("div");
    bar.className = "frameit-session-bar";
    if (isPaused) {
      bar.classList.add("frameit-session-bar--paused");
    }
    bar.innerHTML = `
      <div class="frameit-session-bar__left">
        <span class="frameit-session-bar__dot" aria-hidden="true"></span>
        <span class="frameit-session-bar__title">Exergy ∞ xFrame</span>
        <span class="frameit-session-bar__time" aria-live="polite">00:00</span>
      </div>
      <div class="frameit-session-bar__controls">
        <button
          type="button"
          class="frameit-btn frameit-btn--pause"
          title="${isPaused ? "Continue (P)" : "Pause (P)"}"
          aria-label="${isPaused ? "Continue" : "Pause"}"
        >${isPaused ? ICON_CONTINUE : ICON_PAUSE}</button>
        <button
          type="button"
          class="frameit-btn frameit-btn--stop"
          title="Stop and save (S)"
          aria-label="Stop and save"
        >${ICON_STOP}</button>
        <button
          type="button"
          class="frameit-btn frameit-btn--cancel"
          title="Cancel recording (Esc)"
          aria-label="Cancel recording"
        >${ICON_CANCEL}</button>
      </div>
    `;
    root.appendChild(bar);

    const timeEl = bar.querySelector(".frameit-session-bar__time");
    const pauseBtn = bar.querySelector(".frameit-btn--pause");
    const stopBtn = bar.querySelector(".frameit-btn--stop");
    const cancelBtn = bar.querySelector(".frameit-btn--cancel");

    const updateTime = () => {
      if (sessionStopping) return;
      timeEl.textContent = formatElapsed(getElapsedMs());
    };
    updateTime();
    if (!sessionStopping) {
      timerId = window.setInterval(updateTime, 250);
    }

    sessionUi = { bar, pauseBtn, stopBtn, cancelBtn, updateTime, timeEl };

    pauseBtn.addEventListener("click", () => togglePause());
    stopBtn.addEventListener("click", () => stopAndSave());
    cancelBtn.addEventListener("click", () => cancelRecording());
  }

  function isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    const tag = target.tagName;
    return (
      target.isContentEditable ||
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT"
    );
  }

  function bindSessionKeys() {
    unbindSessionKeys();
    onSessionKeyDown = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      if (isTypingTarget(event.target)) return;
      const key = String(event.key || "").toLowerCase();
      if (key === "p") {
        event.preventDefault();
        togglePause();
      } else if (key === "s") {
        event.preventDefault();
        stopAndSave();
      } else if (key === "escape") {
        event.preventDefault();
        cancelRecording();
      }
    };
    window.addEventListener("keydown", onSessionKeyDown, true);
  }

  function unbindSessionKeys() {
    if (onSessionKeyDown) {
      window.removeEventListener("keydown", onSessionKeyDown, true);
      onSessionKeyDown = null;
    }
  }

  async function togglePause() {
    if (sessionBusy) return;
    sessionBusy = true;
    const { pauseBtn, stopBtn, cancelBtn, bar, updateTime } = sessionUi || {};
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    try {
      if (isPaused) {
        const result = await chrome.runtime.sendMessage({
          type: "frameit-resume-session",
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Could not continue recording.");
        }
        if (pausedAt) {
          totalPausedMs += Date.now() - pausedAt;
        }
        pausedAt = 0;
        isPaused = false;
        if (bar) bar.classList.remove("frameit-session-bar--paused");
        if (pauseBtn) {
          pauseBtn.innerHTML = ICON_PAUSE;
          pauseBtn.title = "Pause (P)";
          pauseBtn.setAttribute("aria-label", "Pause");
        }
      } else {
        const result = await chrome.runtime.sendMessage({
          type: "frameit-pause-session",
        });
        if (!result?.ok) {
          throw new Error(result?.error || "Could not pause recording.");
        }
        pausedAt = Date.now();
        isPaused = true;
        if (bar) bar.classList.add("frameit-session-bar--paused");
        if (pauseBtn) {
          pauseBtn.innerHTML = ICON_CONTINUE;
          pauseBtn.title = "Continue (P)";
          pauseBtn.setAttribute("aria-label", "Continue");
        }
      }
      if (sessionOptions) {
        sessionOptions = { ...sessionOptions };
      }
      if (updateTime) updateTime();
    } catch (error) {
      window.alert(String(error?.message || error));
    } finally {
      sessionBusy = false;
      if (pauseBtn) pauseBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    }
  }

  async function stopAndSave() {
    if (sessionBusy) return;
    sessionBusy = true;
    beginStoppingUi();
    try {
      const result = await chrome.runtime.sendMessage({
        type: "frameit-stop-session",
      });
      if (!result?.ok) {
        throw new Error(result?.error || "Could not save the recording.");
      }
    } catch (error) {
      sessionBusy = false;
      sessionStopping = false;
      frozenElapsedMs = null;
      hideTranscodeProgress();
      const { pauseBtn, stopBtn, cancelBtn } = sessionUi || {};
      if (pauseBtn) pauseBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      if (stopBtn) {
        stopBtn.disabled = false;
        stopBtn.title = "Stop and save (S)";
      }
      if (sessionUi?.bar) sessionUi.bar.style.display = "";
      // Restart timer only if the session bar is still visible after a failed stop.
      if (sessionUi?.updateTime && sessionActive && timerId == null) {
        timerId = window.setInterval(sessionUi.updateTime, 250);
      }
      window.alert(String(error?.message || error));
    }
  }

  function beginStoppingUi() {
    sessionStopping = true;
    if (frozenElapsedMs == null) {
      frozenElapsedMs = getElapsedMs();
    }
    clearTimer();
    unbindSessionKeys();
    const frozenTime = formatElapsed(frozenElapsedMs);
    const { pauseBtn, stopBtn, cancelBtn, bar, timeEl } = sessionUi || {};
    if (pauseBtn) pauseBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (stopBtn) {
      stopBtn.disabled = true;
      stopBtn.title = "Saving…";
    }
    if (timeEl) timeEl.textContent = frozenTime;
    if (bar) {
      bar.classList.add("frameit-session-bar--stopping");
    }
    showTranscodeProgress(frozenTime, 0, "Saving…");
  }

  async function showTranscodeProgress(frozenTime, progress = 0, label = "Saving…") {
    const root = await ensureRoot();
    if (sessionUi?.bar) {
      sessionUi.bar.style.display = "none";
    }
    let panel = root.querySelector(".frameit-transcode");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "frameit-transcode";
      panel.innerHTML = `
        <div class="frameit-transcode__card" role="status" aria-live="polite">
          <div class="frameit-transcode__label"></div>
          <div class="frameit-transcode__time"></div>
          <progress class="frameit-transcode__bar" max="100" value="0"></progress>
          <div class="frameit-transcode__pct">0%</div>
        </div>
      `;
      root.appendChild(panel);
    }
    const timeEl = panel.querySelector(".frameit-transcode__time");
    if (timeEl && frozenTime) timeEl.textContent = frozenTime;
    updateTranscodeProgress(progress, label);
  }

  function updateTranscodeProgress(progress, label) {
    const root = shadowRoot;
    const panel = root?.querySelector?.(".frameit-transcode");
    if (!panel) {
      showTranscodeProgress(
        formatElapsed(getElapsedMs()),
        progress,
        label || "Converting to MP4…"
      );
      return;
    }
    const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
    const pct = Math.round(clamped * 100);
    const labelEl = panel.querySelector(".frameit-transcode__label");
    const barEl = panel.querySelector(".frameit-transcode__bar");
    const pctEl = panel.querySelector(".frameit-transcode__pct");
    if (labelEl) labelEl.textContent = label || "Converting to MP4…";
    if (barEl) barEl.value = pct;
    if (pctEl) pctEl.textContent = `${pct}%`;
  }

  function hideTranscodeProgress() {
    const panel = shadowRoot?.querySelector?.(".frameit-transcode");
    if (panel) panel.remove();
    sessionUi?.bar?.classList.remove("frameit-session-bar--stopping");
  }

  async function cancelRecording() {
    if (sessionBusy) return;
    sessionBusy = true;
    const { pauseBtn, stopBtn, cancelBtn } = sessionUi || {};
    if (pauseBtn) pauseBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = true;
    if (cancelBtn) {
      cancelBtn.disabled = true;
      cancelBtn.title = "Cancelling…";
    }
    try {
      const result = await chrome.runtime.sendMessage({
        type: "frameit-cancel-session",
      });
      if (!result?.ok) {
        throw new Error(result?.error || "Could not cancel the recording.");
      }
    } catch (error) {
      sessionBusy = false;
      if (pauseBtn) pauseBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.title = "Cancel recording (Esc)";
      }
      window.alert(String(error?.message || error));
    }
  }

  function hideNativeCursor(hidden) {
    let style = document.getElementById(CURSOR_STYLE_ID);
    if (hidden) {
      if (!style) {
        style = document.createElement("style");
        style.id = CURSOR_STYLE_ID;
        style.textContent =
          "html.frameit-hide-cursor, html.frameit-hide-cursor * { cursor: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      }
      document.documentElement.classList.add("frameit-hide-cursor");
      return;
    }
    document.documentElement.classList.remove("frameit-hide-cursor");
    if (style) style.remove();
  }

  function startPointer(root) {
    stopPointer();
    pointerEl = document.createElement("div");
    pointerEl.className = "frameit-pointer";
    pointerEl.setAttribute("aria-hidden", "true");
    pointerEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="24" height="24">
        <path
          d="M4 3l12.5 9.2-5.3 1.2 3.4 7.4-2.6 1.2-3.5-7.5L4 17.8V3z"
          fill="#e8eef5"
          stroke="#0f1419"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      </svg>
    `;
    root.appendChild(pointerEl);

    onPointerMove = (event) => {
      pointerEl.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      pointerEl.classList.add("is-visible");
    };
    window.addEventListener("mousemove", onPointerMove, { passive: true });
  }

  function stopPointer() {
    if (onPointerMove) {
      window.removeEventListener("mousemove", onPointerMove);
      onPointerMove = null;
    }
    if (pointerEl) {
      pointerEl.remove();
      pointerEl = null;
    }
  }

  function getElapsedMs() {
    if (sessionStopping && frozenElapsedMs != null) {
      return frozenElapsedMs;
    }
    const pausedExtra = isPaused && pausedAt ? Date.now() - pausedAt : 0;
    return Math.max(
      0,
      Date.now() - recordingStartedAt - totalPausedMs - pausedExtra
    );
  }

  function teardown() {
    sessionActive = false;
    snapshotActive = false;
    sessionOptions = null;
    remountScheduled = false;
    sessionStopping = false;
    frozenElapsedMs = null;
    clearTimer();
    stopPointer();
    unbindSessionKeys();
    clearRegionSelect();
    hideNativeCursor(false);
    stopDomGuard();
    hideTranscodeProgress();
    sessionUi = null;
    sessionBusy = false;
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
      shadowRoot = null;
    }
  }

  function clearTimer() {
    if (timerId != null) {
      window.clearTimeout(timerId);
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function waitFrames(count) {
    return new Promise((resolve) => {
      const step = (left) => {
        if (left <= 0) {
          resolve();
          return;
        }
        requestAnimationFrame(() => step(left - 1));
      };
      step(count);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function normalizeLogoDataUrl(value) {
    return typeof value === "string" && value.startsWith("data:image/")
      ? value
      : null;
  }
})();
