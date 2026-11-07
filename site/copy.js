// Copy buttons: <button data-copy="id"> copies the value (an input) or the text (anything else)
// of the element with that id, says so on the button for two seconds, and announces it in the
// page's [data-copy-status] live region. No inline handlers, so the CSP needs no 'unsafe-inline'.
(() => {
  const RESET_MS = 2000;

  /** Copies text with the Clipboard API, falling back to a selection and execCommand. */
  async function copyText(text, source) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fall through to the selection fallback
      }
    }
    if (source instanceof HTMLInputElement) {
      source.focus();
      source.select();
      try {
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }
    return false;
  }

  function wire(button) {
    // The visible word is the button's own text node; a visually hidden span names what it copies.
    const label =
      [...button.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) ??
      null;
    const original = label ? label.textContent : '';
    let timer;
    button.addEventListener('click', async () => {
      const source = document.getElementById(button.dataset.copy ?? '');
      if (!source) return;
      const text = source instanceof HTMLInputElement ? source.value : (source.textContent ?? '');
      const ok = await copyText(text, source);
      if (label) label.textContent = ok ? 'Copied' : 'Not copied';
      const status = document.querySelector('[data-copy-status]');
      if (status)
        status.textContent = ok
          ? 'Copied to the clipboard.'
          : 'Copy failed; select the text and copy it.';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (label) label.textContent = original;
        if (status) status.textContent = '';
      }, RESET_MS);
    });
  }

  function init() {
    for (const button of document.querySelectorAll('button[data-copy]')) wire(button);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
