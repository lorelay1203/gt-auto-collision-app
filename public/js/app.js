'use strict';
// Botones "Copiar" y formularios que solo se pueden enviar una vez (evita doble clic en pagos).
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const field = document.querySelector(btn.dataset.copy);
    if (!field) return;
    try { await navigator.clipboard.writeText(field.value); } catch { field.select(); document.execCommand('copy'); }
    const t = btn.textContent; btn.textContent = '✓ Copiado'; setTimeout(() => { btn.textContent = t; }, 2000);
  });
});
document.querySelectorAll('form[data-once]').forEach((f) => {
  f.addEventListener('submit', (e) => {
    if (f.dataset.sent) { e.preventDefault(); return; }
    f.dataset.sent = '1';
    setTimeout(() => f.querySelectorAll('button').forEach((b) => { b.disabled = true; }), 0);
  });
});
