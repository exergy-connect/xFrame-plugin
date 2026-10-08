/** Map a viewport selection to decoded video pixels, including HiDPI captures. */
function recordingRegionRect(selection, videoWidth, videoHeight) {
  const values = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'];
  const rect = Object.fromEntries(values.map((key) => [key, Number(selection?.[key])]));
  if (values.some((key) => !Number.isFinite(rect[key])) ||
      rect.width <= 0 || rect.height <= 0 || rect.viewportWidth <= 0 || rect.viewportHeight <= 0 ||
      videoWidth <= 0 || videoHeight <= 0) {
    throw new Error('Invalid recording region');
  }
  const x = Math.max(0, Math.min(videoWidth, rect.x / rect.viewportWidth * videoWidth));
  const y = Math.max(0, Math.min(videoHeight, rect.y / rect.viewportHeight * videoHeight));
  const right = Math.max(0, Math.min(videoWidth, (rect.x + rect.width) / rect.viewportWidth * videoWidth));
  const bottom = Math.max(0, Math.min(videoHeight, (rect.y + rect.height) / rect.viewportHeight * videoHeight));
  if (right - x < 2 || bottom - y < 2) throw new Error('Recording region is too small');
  return { x, y, width: right - x, height: bottom - y };
}

/** Crop video only; keep the existing tab/microphone/soundtrack audio tracks. */
async function createRegionRecordingStream(source, selection, signal) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  let timer = null;
  let output = null;
  function stop() {
    clearInterval(timer);
    video.pause();
    video.srcObject = null;
    output?.getVideoTracks().forEach((track) => track.stop());
    signal.removeEventListener('abort', stop);
  }
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) throw new Error('Recording cancelled');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out loading the recording region')), 30_000);
      function finish(error) {
        clearTimeout(timeout);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        signal.removeEventListener('abort', cancelled);
        error ? reject(error) : resolve();
      }
      function ready() { finish(); }
      function failed() { finish(new Error('Could not load video for region recording')); }
      function cancelled() { finish(new Error('Recording cancelled')); }
      video.addEventListener('loadeddata', ready);
      video.addEventListener('error', failed);
      signal.addEventListener('abort', cancelled, { once: true });
      video.srcObject = source;
      video.play().catch(finish);
    });
    if (signal.aborted) throw new Error('Recording cancelled');
    const initial = recordingRegionRect(selection, video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    // Even dimensions work with H.264 encoders as well as WebM.
    canvas.width = Math.max(2, Math.floor(initial.width / 2) * 2);
    canvas.height = Math.max(2, Math.floor(initial.height / 2) * 2);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Could not create the recording region canvas');
    function draw() {
      if (video.readyState < 2) return;
      const rect = recordingRegionRect(selection, video.videoWidth, video.videoHeight);
      ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height,
        0, 0, canvas.width, canvas.height);
    }
    draw();
    output = canvas.captureStream(30);
    timer = setInterval(draw, 1000 / 30);
    return new MediaStream([...output.getVideoTracks(), ...source.getAudioTracks()]);
  } catch (error) {
    stop();
    throw error;
  }
}
