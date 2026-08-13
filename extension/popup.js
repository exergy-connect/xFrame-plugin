const DEFAULT_LOGO_URL = "assets/exergy_connect_logo.png";
const LOGO_STORAGE_KEY = "customLogoDataUrl";
const INCLUDE_AUDIO_KEY = "includeAudio";
const VIDEO_QUALITY_KEY = "videoQuality";
const VIDEO_LINKEDIN_KEY = "videoLinkedIn";
const SNAPSHOT_MODE_KEY = "snapshotMode";
const SNAPSHOT_DELAY_KEY = "snapshotDelay";
const SNAPSHOT_LINKEDIN_KEY = "snapshotLinkedIn";
const SNAPSHOT_FORMAT_KEY = "snapshotFormat";
const SNAPSHOT_JPG_KEY = "snapshotJpg"; // legacy
const MAX_LOGO_BYTES = 500_000;
const DEFAULT_VIDEO_QUALITY = "standard";

const startBtn = document.getElementById("start");
const snapshotBtn = document.getElementById("snapshot");
const pauseBtn = document.getElementById("pause");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const hintEl = document.getElementById("hint");
const tabRecordEl = document.getElementById("tabRecord");
const tabSnapshotEl = document.getElementById("tabSnapshot");
const panelsEl = document.querySelector(".panels");
const recordPanelEl = document.getElementById("recordPanel");
const snapshotPanelEl = document.getElementById("snapshotPanel");
const includeLogoEl = document.getElementById("includeLogo");
const logoOptionsEl = document.getElementById("logoOptions");
const logoPreviewEl = document.getElementById("logoPreview");
const chooseLogoBtn = document.getElementById("chooseLogo");
const resetLogoBtn = document.getElementById("resetLogo");
const logoFileEl = document.getElementById("logoFile");
const hideControlsEl = document.getElementById("hideControls");
const includePointerEl = document.getElementById("includePointer");
const includeAudioEl = document.getElementById("includeAudio");
const videoLinkedInEl = document.getElementById("videoLinkedIn");
const videoQualityEl = document.getElementById("videoQuality");
const videoQualityLinkedInOption = videoQualityEl.querySelector(
  'option[value="linkedin"]'
);
const activeSessionEl = document.getElementById("activeSession");
const activeTimeEl = document.getElementById("activeTime");
const snapshotModeFullEl = document.getElementById("snapshotModeFull");
const snapshotModeRegionEl = document.getElementById("snapshotModeRegion");
const snapshotDelayEl = document.getElementById("snapshotDelay");
const snapshotLinkedInEl = document.getElementById("snapshotLinkedIn");
const snapshotFormatPngEl = document.getElementById("snapshotFormatPng");
const snapshotFormatJpgEl = document.getElementById("snapshotFormatJpg");
const snapshotFormatGifEl = document.getElementById("snapshotFormatGif");

const HINTS = {
  record:
    "3-second countdown, then recording begins. Reopen to pause or stop.",
  snapshot: "Shortcut: Alt+Shift+S (chrome://extensions/shortcuts).",
  active: "Session in progress. Pause or stop here, or press P / S on the tab.",
};

let timerId = null;
let statusSnapshot = null;
let customLogoDataUrl = null;
let activeTab = "record";
let uiBusy = false;
let lastManualVideoQuality = DEFAULT_VIDEO_QUALITY;

initLogoSettings();
initRecordingSettings();
initSnapshotSettings();
setCaptureTab("record");
lockPanelsHeight();
refreshStatus();
requestAnimationFrame(() => lockPanelsHeight());

tabRecordEl.addEventListener("click", () => setCaptureTab("record"));
tabSnapshotEl.addEventListener("click", () => setCaptureTab("snapshot"));

includeLogoEl.addEventListener("change", () => {
  syncLogoOptionsVisibility();
  lockPanelsHeight();
});
includeAudioEl.addEventListener("change", persistRecordingSettings);
videoLinkedInEl.addEventListener("change", () => {
  syncVideoLinkedInUi();
  persistRecordingSettings();
  lockPanelsHeight();
});
videoQualityEl.addEventListener("change", () => {
  if (!videoLinkedInEl.checked) {
    lastManualVideoQuality = selectedVideoQuality();
  }
  persistRecordingSettings();
});

chooseLogoBtn.addEventListener("click", () => {
  logoFileEl.click();
});

resetLogoBtn.addEventListener("click", async () => {
  customLogoDataUrl = null;
  await chrome.storage.local.remove(LOGO_STORAGE_KEY);
  applyLogoPreview();
  lockPanelsHeight();
  setStatus("Using the Exergy logo.");
});

logoFileEl.addEventListener("change", async () => {
  const file = logoFileEl.files?.[0];
  logoFileEl.value = "";
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setStatus("Please choose an image file.", true);
    return;
  }
  if (file.size > MAX_LOGO_BYTES) {
    setStatus("Logo must be 500 KB or smaller.", true);
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    customLogoDataUrl = dataUrl;
    await chrome.storage.local.set({ [LOGO_STORAGE_KEY]: dataUrl });
    applyLogoPreview();
    lockPanelsHeight();
    setStatus("Custom logo saved.");
  } catch (error) {
    setStatus(String(error?.message || error), true);
  }
});

snapshotModeFullEl.addEventListener("change", persistSnapshotSettings);
snapshotModeRegionEl.addEventListener("change", persistSnapshotSettings);
snapshotDelayEl.addEventListener("change", persistSnapshotSettings);
snapshotLinkedInEl.addEventListener("change", persistSnapshotSettings);
snapshotFormatPngEl.addEventListener("change", persistSnapshotSettings);
snapshotFormatJpgEl.addEventListener("change", persistSnapshotSettings);
snapshotFormatGifEl.addEventListener("change", persistSnapshotSettings);

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  snapshotBtn.disabled = true;
  setStatus("Starting session…");

  try {
    await persistRecordingSettings();
    const result = await chrome.runtime.sendMessage({
      type: "frameit-start-session",
      includeLogo: includeLogoEl.checked,
      logoDataUrl: includeLogoEl.checked ? customLogoDataUrl : null,
      hideControls: hideControlsEl.checked,
      includePointer: includePointerEl.checked,
      includeAudio: includeAudioEl.checked,
      videoQuality: selectedVideoQuality(),
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not start session");
    }
    setStatus("Countdown running on the tab.");
    window.close();
  } catch (error) {
    setStatus(String(error?.message || error), true);
    startBtn.disabled = false;
    snapshotBtn.disabled = false;
  }
});

snapshotBtn.addEventListener("click", async () => {
  snapshotBtn.disabled = true;
  startBtn.disabled = true;
  setSnapshotControlsDisabled(true);
  setStatus("Starting snapshot…");

  const mode = snapshotModeRegionEl.checked ? "region" : "full";
  const delay = Number(snapshotDelayEl.value) || 0;
  const linkedIn = snapshotLinkedInEl.checked;
  const format = selectedSnapshotFormat();

  try {
    await persistSnapshotSettings();
    const result = await chrome.runtime.sendMessage({
      type: "frameit-start-snapshot",
      mode,
      delay,
      linkedIn,
      format,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not take snapshot");
    }
    setStatus(
      delay > 0
        ? "Countdown running on the tab."
        : mode === "region"
          ? "Select a region on the tab."
          : "Capturing snapshot…"
    );
    window.close();
  } catch (error) {
    setStatus(String(error?.message || error), true);
    snapshotBtn.disabled = false;
    startBtn.disabled = false;
    setSnapshotControlsDisabled(false);
  }
});

pauseBtn.addEventListener("click", async () => {
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  try {
    const type = statusSnapshot?.paused
      ? "frameit-resume-session"
      : "frameit-pause-session";
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not update recording.");
    }
    await refreshStatus();
  } catch (error) {
    setStatus(String(error?.message || error), true);
  } finally {
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", async () => {
  pauseBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus("Saving…");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-stop-session",
    });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not save the recording.");
    }
    clearTimer();
    statusSnapshot = null;
    showIdle();
    setStatus("Saved to Downloads.");
  } catch (error) {
    setStatus(String(error?.message || error), true);
    pauseBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

async function initLogoSettings() {
  try {
    const stored = await chrome.storage.local.get(LOGO_STORAGE_KEY);
    const value = stored?.[LOGO_STORAGE_KEY];
    customLogoDataUrl =
      typeof value === "string" && value.startsWith("data:image/")
        ? value
        : null;
  } catch (_error) {
    customLogoDataUrl = null;
  }
  applyLogoPreview();
  syncLogoOptionsVisibility();
}

async function initRecordingSettings() {
  try {
    const stored = await chrome.storage.local.get([
      INCLUDE_AUDIO_KEY,
      VIDEO_QUALITY_KEY,
      VIDEO_LINKEDIN_KEY,
    ]);
    includeAudioEl.checked = stored?.[INCLUDE_AUDIO_KEY] !== false;
    const storedQuality = normalizeVideoQuality(stored?.[VIDEO_QUALITY_KEY]);
    const linkedIn =
      stored?.[VIDEO_LINKEDIN_KEY] === true || storedQuality === "linkedin";
    lastManualVideoQuality =
      storedQuality === "linkedin" ? DEFAULT_VIDEO_QUALITY : storedQuality;
    videoLinkedInEl.checked = linkedIn;
    syncVideoLinkedInUi();
  } catch (_error) {
    includeAudioEl.checked = true;
    videoLinkedInEl.checked = false;
    lastManualVideoQuality = DEFAULT_VIDEO_QUALITY;
    syncVideoLinkedInUi();
  }
}

async function persistRecordingSettings() {
  await chrome.storage.local.set({
    [INCLUDE_AUDIO_KEY]: includeAudioEl.checked,
    [VIDEO_LINKEDIN_KEY]: videoLinkedInEl.checked,
    [VIDEO_QUALITY_KEY]: selectedVideoQuality(),
  });
}

function selectedVideoQuality() {
  if (videoLinkedInEl.checked) return "linkedin";
  return normalizeVideoQuality(videoQualityEl.value);
}

function normalizeVideoQuality(value) {
  if (
    value === "efficient" ||
    value === "high" ||
    value === "standard" ||
    value === "linkedin"
  ) {
    return value;
  }
  return DEFAULT_VIDEO_QUALITY;
}

function syncVideoLinkedInUi() {
  if (videoLinkedInEl.checked) {
    if (videoQualityLinkedInOption) {
      videoQualityLinkedInOption.hidden = false;
    }
    videoQualityEl.value = "linkedin";
    videoQualityEl.disabled = true;
  } else {
    if (videoQualityLinkedInOption) {
      videoQualityLinkedInOption.hidden = true;
    }
    const restore = normalizeVideoQuality(lastManualVideoQuality);
    videoQualityEl.value =
      restore === "linkedin" ? DEFAULT_VIDEO_QUALITY : restore;
    videoQualityEl.disabled = uiBusy;
  }
}

async function initSnapshotSettings() {
  try {
    const stored = await chrome.storage.local.get([
      SNAPSHOT_MODE_KEY,
      SNAPSHOT_DELAY_KEY,
      SNAPSHOT_LINKEDIN_KEY,
      SNAPSHOT_FORMAT_KEY,
      SNAPSHOT_JPG_KEY,
    ]);
    const mode = stored?.[SNAPSHOT_MODE_KEY] === "region" ? "region" : "full";
    snapshotModeFullEl.checked = mode === "full";
    snapshotModeRegionEl.checked = mode === "region";

    const delay = Number(stored?.[SNAPSHOT_DELAY_KEY]);
    const allowed = new Set(["0", "3", "5", "10"]);
    const delayValue = allowed.has(String(delay)) ? String(delay) : "5";
    snapshotDelayEl.value = delayValue;
    snapshotLinkedInEl.checked = stored?.[SNAPSHOT_LINKEDIN_KEY] === true;
    applySnapshotFormat(
      normalizePopupSnapshotFormat(
        stored?.[SNAPSHOT_FORMAT_KEY],
        stored?.[SNAPSHOT_JPG_KEY]
      )
    );
  } catch (_error) {
    snapshotModeFullEl.checked = true;
    snapshotDelayEl.value = "5";
    snapshotLinkedInEl.checked = false;
    applySnapshotFormat("png");
  }
}

async function persistSnapshotSettings() {
  const mode = snapshotModeRegionEl.checked ? "region" : "full";
  const delay = Number(snapshotDelayEl.value) || 0;
  await chrome.storage.local.set({
    [SNAPSHOT_MODE_KEY]: mode,
    [SNAPSHOT_DELAY_KEY]: delay,
    [SNAPSHOT_LINKEDIN_KEY]: snapshotLinkedInEl.checked,
    [SNAPSHOT_FORMAT_KEY]: selectedSnapshotFormat(),
  });
}

function selectedSnapshotFormat() {
  if (snapshotFormatGifEl.checked) return "gif";
  if (snapshotFormatJpgEl.checked) return "jpg";
  return "png";
}

function applySnapshotFormat(format) {
  snapshotFormatPngEl.checked = format === "png";
  snapshotFormatJpgEl.checked = format === "jpg";
  snapshotFormatGifEl.checked = format === "gif";
}

function normalizePopupSnapshotFormat(value, legacyJpg) {
  if (value === "jpg" || value === "gif" || value === "png") return value;
  if (legacyJpg === true) return "jpg";
  return "png";
}

function applyLogoPreview() {
  logoPreviewEl.src = customLogoDataUrl || DEFAULT_LOGO_URL;
  resetLogoBtn.classList.toggle("is-slot-hidden", !customLogoDataUrl);
}

function syncLogoOptionsVisibility() {
  logoOptionsEl.classList.toggle("is-collapsed", !includeLogoEl.checked);
}

function lockPanelsHeight() {
  if (!panelsEl) return;

  const previousHeight = panelsEl.style.height;
  panelsEl.style.height = "auto";

  const heights = [recordPanelEl, snapshotPanelEl].map((panel) => {
    const prev = {
      position: panel.style.position,
      visibility: panel.style.visibility,
      pointerEvents: panel.style.pointerEvents,
      inset: panel.style.inset,
      height: panel.style.height,
    };
    panel.style.position = "static";
    panel.style.visibility = "hidden";
    panel.style.pointerEvents = "none";
    panel.style.inset = "auto";
    panel.style.height = "auto";
    const height = panel.getBoundingClientRect().height;
    panel.style.position = prev.position;
    panel.style.visibility = prev.visibility;
    panel.style.pointerEvents = prev.pointerEvents;
    panel.style.inset = prev.inset;
    panel.style.height = prev.height;
    return height;
  });

  const next = `${Math.ceil(Math.max(0, ...heights))}px`;
  panelsEl.style.height = next || previousHeight;
}

function setPanelActive(panelEl) {
  recordPanelEl.classList.toggle("is-active", panelEl === recordPanelEl);
  snapshotPanelEl.classList.toggle("is-active", panelEl === snapshotPanelEl);
  activeSessionEl.classList.toggle("is-active", panelEl === activeSessionEl);
  recordPanelEl.setAttribute(
    "aria-hidden",
    String(panelEl !== recordPanelEl)
  );
  snapshotPanelEl.setAttribute(
    "aria-hidden",
    String(panelEl !== snapshotPanelEl)
  );
  activeSessionEl.setAttribute(
    "aria-hidden",
    String(panelEl !== activeSessionEl)
  );
}

function setCaptureTab(tab) {
  if (uiBusy) return;
  activeTab = tab === "snapshot" ? "snapshot" : "record";

  const isRecord = activeTab === "record";
  tabRecordEl.setAttribute("aria-selected", String(isRecord));
  tabSnapshotEl.setAttribute("aria-selected", String(!isRecord));
  setPanelActive(isRecord ? recordPanelEl : snapshotPanelEl);

  if (!statusSnapshot) {
    hintEl.textContent = HINTS[activeTab];
  }
}

function setTabsDisabled(disabled) {
  tabRecordEl.disabled = disabled;
  tabSnapshotEl.disabled = disabled;
}

async function refreshStatus() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "frameit-get-status",
    });
    if (result?.active) {
      statusSnapshot = result;
      showActive(result);
      setStatus(`Session in progress (${result.phase || "active"}).`);
      return;
    }
    if (result?.snapshotActive) {
      statusSnapshot = null;
      showSnapshotBusy(result);
      setStatus(`Snapshot in progress (${result.snapshotPhase || "active"}).`);
      return;
    }
    statusSnapshot = null;
    showIdle();
  } catch (_error) {
    // Service worker may still be waking up.
  }
}

function showIdle() {
  clearTimer();
  uiBusy = false;
  startBtn.disabled = false;
  snapshotBtn.disabled = false;
  setOptionsDisabled(false);
  setSnapshotControlsDisabled(false);
  setTabsDisabled(false);
  setCaptureTab(activeTab || "record");
}

function showSnapshotBusy(_status) {
  clearTimer();
  uiBusy = false;
  setCaptureTab("snapshot");
  startBtn.disabled = true;
  snapshotBtn.disabled = true;
  setOptionsDisabled(false);
  setSnapshotControlsDisabled(true);
  setTabsDisabled(false);
  hintEl.textContent = HINTS.snapshot;
}

function showActive(status) {
  uiBusy = true;
  activeTab = "record";
  tabRecordEl.setAttribute("aria-selected", "true");
  tabSnapshotEl.setAttribute("aria-selected", "false");
  setPanelActive(activeSessionEl);
  snapshotBtn.disabled = true;
  setOptionsDisabled(true);
  setSnapshotControlsDisabled(true);
  setTabsDisabled(true);
  activeSessionEl.classList.toggle("is-paused", Boolean(status.paused));
  hintEl.textContent = HINTS.active;

  const canControl = status.phase === "recording";
  pauseBtn.disabled = !canControl;
  stopBtn.disabled = !canControl;
  pauseBtn.textContent = status.paused ? "Continue" : "Pause";

  if (status.recordingStartedAt) {
    updateActiveTime(status);
    clearTimer();
    timerId = window.setInterval(
      () => updateActiveTime(statusSnapshot || status),
      250
    );
  } else {
    activeTimeEl.textContent = "…";
    clearTimer();
  }
}

function setOptionsDisabled(disabled) {
  includeLogoEl.disabled = disabled;
  hideControlsEl.disabled = disabled;
  includePointerEl.disabled = disabled;
  includeAudioEl.disabled = disabled;
  videoLinkedInEl.disabled = disabled;
  chooseLogoBtn.disabled = disabled;
  resetLogoBtn.disabled = disabled;
  logoFileEl.disabled = disabled;
  if (disabled) {
    videoQualityEl.disabled = true;
  } else {
    syncVideoLinkedInUi();
  }
}

function setSnapshotControlsDisabled(disabled) {
  snapshotModeFullEl.disabled = disabled;
  snapshotModeRegionEl.disabled = disabled;
  snapshotDelayEl.disabled = disabled;
  snapshotLinkedInEl.disabled = disabled;
  snapshotFormatPngEl.disabled = disabled;
  snapshotFormatJpgEl.disabled = disabled;
  snapshotFormatGifEl.disabled = disabled;
}

function updateActiveTime(status) {
  if (!status?.recordingStartedAt) {
    activeTimeEl.textContent = "00:00";
    return;
  }
  const pausedExtra =
    status.paused && status.pausedAt ? Date.now() - status.pausedAt : 0;
  const elapsed = Math.max(
    0,
    Date.now() -
      status.recordingStartedAt -
      (status.totalPausedMs || 0) -
      pausedExtra
  );
  activeTimeEl.textContent = formatElapsed(elapsed);
}

function clearTimer() {
  if (timerId != null) {
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

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the image."));
    };
    reader.onerror = () => reject(new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}
