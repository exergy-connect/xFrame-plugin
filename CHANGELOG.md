# Changelog

All notable changes to Exergy ∞ xFrame plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tab snapshots: full viewport or region select, delay (default 5s), popup controls, **Alt+Shift+S** shortcut.
- **Optimize for LinkedIn**: center-crop/scale to 1280×644 so LinkedIn does not resize again.
- Snapshot formats: **PNG (best)** for LinkedIn quality, **JPG** (95%), **GIF (smallest)** — 256-color single-frame.
- Recording **video quality** presets: Efficient (~2 Mbps), Standard (~5 Mbps, default), High (~8 Mbps).
- Optional **tab audio** capture (on by default); can be disabled per session.
- **Optimize for LinkedIn** (video): selects a ~6 Mbps LinkedIn profile and prefers H.264/AAC encoding.
- **Animate** popup tab: create an animated GIF from the last **Stop & save** recording (FPS default 10, speed 10–500%, optional **spiralflow** golden-ratio delay curve).
- Last recording kept in IndexedDB after download so Animate can convert it without re-picking a file.
- Session **Cancel** (discard): popup button, on-page control, and **Esc** — tears down without saving; does not replace the last Animate source.

### Fixed

- Popup layout stays compact after snapshot controls were added (no scrollbar).
- Popup uses **Record / Snapshot / Animate** tabs so quality, snapshot, and GIF options fit without scrolling.
- Pause/stop survive host pages that hide, remove, or restyle on-page controls (closed Shadow DOM overlay).
- Remount session overlay after navigations / DOM detach; re-inject when the popup checks status.
- Persist in-flight session state across MV3 service worker restarts.

### Changed

- Packaged zip artifact name includes `chrome-plugin`.
- MediaRecorder requests an ideal **30 fps** capture rate and explicit video/audio bitrates from the chosen quality preset.
- Extension version **1.1.0**.

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
