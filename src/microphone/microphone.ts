// Standalone extension page whose only job is to obtain the microphone
// permission. Chrome does not surface the getUserMedia prompt inside the side
// panel, but it does in a normal top-level extension tab. Once granted here,
// the permission is stored for the extension's origin and the side panel can
// record audio for voice prompts.

const button = document.getElementById('allow') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

async function requestMic(): Promise<void> {
  statusEl.textContent = '';
  statusEl.className = 'status';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant — release the device immediately.
    stream.getTracks().forEach((t) => t.stop());
    statusEl.textContent = 'Microphone enabled. Return to CANChat Agent and tap the mic again — you can close this tab.';
    statusEl.classList.add('ok');
    button.disabled = true;
  } catch {
    statusEl.textContent =
      'Microphone access was denied. Click the camera/mic icon in the address bar (or the site settings) to allow it, then try again.';
    statusEl.classList.add('err');
  }
}

button.addEventListener('click', () => void requestMic());
