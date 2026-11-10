// Copy buttons for slugs (roadmap Phase 5): any element with a data-copy
// attribute copies that text to the clipboard when clicked. The site runs over
// plain HTTP on the LAN, where navigator.clipboard does not exist, so a hidden
// textarea and execCommand are the fallback.

const FEEDBACK_MS = 1500;

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy refused');
}

function flash(button, message) {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = original;
  }, FEEDBACK_MS);
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy]');
  if (!button) return;
  try {
    await copyText(button.dataset.copy);
    flash(button, 'Copied');
  } catch {
    flash(button, 'Copy failed');
  }
});
