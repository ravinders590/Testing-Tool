/* ===== Playwright Pilot — Offscreen Recording Script ===== */

let mediaRecorder = null;
let recordedChunks = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START_RECORDING') {
    startRecording(msg.streamId)
      .then(() => sendResponse({ started: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP_RECORDING') {
    stopRecording()
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function startRecording(streamId) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder = null;
    recordedChunks = [];
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 1_500_000,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.start(500); // collect data every 500ms
}

function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve(null);
      return;
    }

    mediaRecorder.onstop = () => {
      // Stop all tracks to release the captured tab stream
      if (mediaRecorder.stream) {
        mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      }

      if (!recordedChunks.length) {
        resolve(null);
        return;
      }

      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      recordedChunks = [];

      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read recording blob'));
      reader.readAsDataURL(blob);
    };

    mediaRecorder.onerror = (e) => reject(new Error(e.error?.message || 'Recording error'));
    mediaRecorder.stop();
  });
}
