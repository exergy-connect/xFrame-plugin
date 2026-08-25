const allowButton = document.getElementById("allow");
const statusEl = document.getElementById("status");

allowButton.addEventListener("click", async () => {
  allowButton.disabled = true;
  setStatus("Waiting for permission…");

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    setStatus(
      "Microphone access enabled. You can close this tab and start your recording.",
      "success"
    );
    allowButton.textContent = "Access enabled";
  } catch (error) {
    setStatus(
      `Microphone access was not granted: ${String(error?.message || error)}. ` +
        "Check Chrome’s site settings for this extension and try again.",
      "error"
    );
    allowButton.disabled = false;
    allowButton.textContent = "Try again";
  } finally {
    for (const track of stream?.getTracks?.() || []) {
      track.stop();
    }
  }
});

function setStatus(message, state = "") {
  statusEl.textContent = message;
  statusEl.className = state;
}
