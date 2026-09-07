# Changelog

All notable changes to Exergy ∞ xFrame plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-09-07

### Changed

- Replace **Include tab audio** with a **Media** select: **Audio+video** (default), **Video only**, or **Audio only**.
- Extension version **1.3.0**.

### Fixed

- Outro overlay is shown after Stop & save even when the tab is in a fullscreen video player (exits fullscreen and promotes the overlay into the top layer).

## [1.2.0] - 2026-08-28

### Added

- Optional **outro** after Stop & save: a chosen image is shown centered on the recorded tab over a blurred background for 1–10 seconds (default 3).
- Optional microphone audio capture, including mixing with tab audio when both sources are enabled.
- Recording filenames include the detected video codec before the container extension (for example, `.vp8.webm`, `.vp9.mp4`, or `.h264.mp4`).
- Local/unpacked builds convert LinkedIn WebM recordings to H.264/AAC MP4 in the extension using FFmpeg WASM, with conversion progress shown in the session overlay.

### Fixed

- **Include mouse pointer** stays visible over modal dialogs and popovers by promoting the pointer overlay into the browser top layer.
- **Optimize for LinkedIn** no longer falls back to WebM; it saves MP4 or reports that MP4 recording is unavailable.
- Tab recording starts correctly when FFmpeg transcoding is enabled; extension-wide cross-origin isolation no longer prevents the offscreen recorder from consuming the tab stream.
- FFmpeg WebM-to-MP4 conversion avoids pthread deadlocks and VP9 decoder `Resource temporarily unavailable` failures by preloading a larger worker pool and constraining decoder threads.

### Changed

- Extension version **1.2.0**.

## [1.1.0] - 2026-08-22

### Added

- **Animate** popup tab: create an animated GIF from the last **Stop & save** recording (FPS default 10, speed 10–500%, optional **spiralflow** golden-ratio delay curve).
- Last recording kept in IndexedDB after download so Animate can convert it without re-picking a file.
- Session **Cancel** (discard): popup button, on-page control, and **Esc** — tears down without saving; does not replace the last Animate source.

### Fixed

- Popup uses **Record / Snapshot / Animate** tabs so quality, snapshot, and GIF options fit without scrolling.
- GIF maker no longer hangs loading the last recording (IndexedDB transaction wait); shows live progress on the encode page.

### Changed

- Extension version **1.1.0**.

## [1.0.3] - 2026-08-13

### Added

- Tab snapshots: full viewport or region select, delay (default 5s), popup controls, **Alt+Shift+S** shortcut.
- **Optimize for LinkedIn**: center-crop/scale to 1280×644 so LinkedIn does not resize again.
- Snapshot formats: **PNG (best)** for LinkedIn quality, **JPG** (95%), **GIF (smallest)** — 256-color single-frame.
- Recording **video quality** presets: Efficient (~2 Mbps), Standard (~5 Mbps, default), High (~8 Mbps).
- Optional **tab audio** capture (on by default); can be disabled per session.
- **Optimize for LinkedIn** (video): selects a ~6 Mbps LinkedIn profile and prefers H.264/AAC encoding.

### Fixed

- Popup layout stays compact after snapshot controls were added (no scrollbar).
- Popup uses **Record / Snapshot** tabs so quality and audio options fit without scrolling.
- Pause/stop survive host pages that hide, remove, or restyle on-page controls (closed Shadow DOM overlay).
- Remount session overlay after navigations / DOM detach; re-inject when the popup checks status.
- Persist in-flight session state across MV3 service worker restarts.

### Changed

- Packaged zip artifact name includes `chrome-plugin`.
- MediaRecorder requests an ideal **30 fps** capture rate and explicit video/audio bitrates from the chosen quality preset.
- Extension version **1.0.3**.

## [1.0.0] - 2026-07-28

### Added

- Chrome Manifest V3 tab capture: records the active tab (video + tab audio) to MP4 when supported, otherwise WebM.
- On-page countdown, optional logo watermark, optional captureable pointer, optional on-page session bar.
- Pause / continue and stop & save from the toolbar popup, on-page controls, or **P** / **S**.
- Hide native cursor during capture; hide on-page controls from the recording by default.
- Custom recording logo (extension storage).
- Offscreen `MediaRecorder`, IndexedDB handoff, and `saver.html` download path.
- GitHub Actions workflow to package the Chrome Web Store zip.
- Branded explainer (`index.html`) and project README.
