const root = document.querySelector('#app');
if (root) {
  // Draft text is always set with textContent, never as HTML (spec 11.5).
  root.textContent = 'qus.me';
}
