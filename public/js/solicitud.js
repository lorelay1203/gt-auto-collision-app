'use strict';
(function () {
  const form = document.getElementById('solicitud');
  if (!form || !window.FormData || !window.fetch) return; // sin JS: el formulario se envía normal
  document.documentElement.classList.add('js');

  const steps = Array.from(form.querySelectorAll('.step'));
  const bar = form.querySelector('.progress-bar');
  const count = form.querySelector('.step-count');
  const errBox = form.querySelector('.form-error');
  let current = 0;

  // Fotos procesadas por campo: { photo_frente: [File, ...] }
  const picked = {};

  function showError(msg) { errBox.textContent = msg; errBox.hidden = !msg; if (msg) errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

  function go(i) {
    current = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach((s, n) => s.classList.toggle('active', n === current));
    form.classList.toggle('first', current === 0);
    form.classList.toggle('last', current === steps.length - 1);
    bar.style.width = `${((current + 1) / steps.length) * 100}%`;
    count.textContent = `Paso ${current + 1} de ${steps.length}`;
    showError('');
    if (current === steps.length - 1) buildReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function val(name) { const el = form.elements[name]; return el ? (el.value || '').trim() : ''; }

  function validateStep(i) {
    const s = steps[i];
    for (const el of s.querySelectorAll('input, textarea, select')) {
      if (el.type === 'file' || el.type === 'hidden') continue;
      if (el.closest('[hidden]')) continue;
      if (!el.checkValidity()) {
        el.focus();
        const label = (el.closest('label') && el.closest('label').firstChild.textContent.trim()) || 'Este campo';
        if (el.type === 'radio') return 'Escoge una opción para continuar.';
        if (el.type === 'checkbox') return 'Debes aceptar para enviar la solicitud.';
        if (el.name === 'vin') return 'El VIN debe tener 17 letras y números (sin I, O ni Q). Puedes dejarlo en blanco.';
        return `Revisa: ${label}.`;
      }
    }
    if (i === 0) {
      const d = val('phone').replace(/\D/g, '');
      if (d.length < 10 || d.length > 11) return 'Escribe un teléfono válido de 10 dígitos.';
    }
    if (form.elements.payer.value === 'seguro' && i === 2 && !val('insurer')) return 'Escribe el nombre de tu aseguradora.';
    if (s.dataset.step === '5') {
      let missing = false;
      s.querySelectorAll('.photo-slot').forEach((slot) => {
        const input = slot.querySelector('input[type=file]');
        const need = input.dataset.required && !(picked[input.name] || []).length;
        slot.classList.toggle('missing', !!need);
        if (need) missing = true;
      });
      if (missing) return 'Faltan fotos obligatorias: el daño de cerca y desde lejos.';
    }
    return '';
  }

  form.querySelector('[data-next]').addEventListener('click', () => {
    const e = validateStep(current);
    if (e) return showError(e);
    go(current + 1);
  });
  form.querySelector('[data-prev]').addEventListener('click', () => go(current - 1));

  // Seguro -> mostrar campos de aseguradora
  const insurer = form.querySelector('.insurer-fields');
  form.querySelectorAll('input[name=payer]').forEach((r) => r.addEventListener('change', () => {
    insurer.hidden = form.elements.payer.value !== 'seguro';
    form.elements.insurer.required = !insurer.hidden;
  }));

  // VIN en mayúsculas
  form.elements.vin.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  // Reducir fotos grandes en el celular antes de subir (más rápido y menos datos).
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.2 * 1024 * 1024 || !window.createImageBitmap) return file;
    try {
      const bmp = await createImageBitmap(file);
      const max = 2200;
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }

  const MAX = 12 * 1024 * 1024;
  form.querySelectorAll('.photo-slot input[type=file]').forEach((input) => {
    const slot = input.closest('.photo-slot');
    const thumbs = slot.querySelector('.thumbs');
    const status = slot.querySelector('.slot-status');
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      status.textContent = 'Preparando…';
      const out = [];
      for (const f of files) {
        if (!/^image\//.test(f.type) && !/\.(heic|heif)$/i.test(f.name)) { showError(`"${f.name}" no es una foto.`); continue; }
        const s = await shrink(f);
        if (s.size > MAX) { showError(`"${f.name}" pesa más de 12 MB.`); continue; }
        out.push(s);
      }
      picked[input.name] = input.multiple ? (picked[input.name] || []).concat(out).slice(0, 8) : out.slice(0, 1);
      thumbs.innerHTML = '';
      for (const f of picked[input.name]) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = URL.createObjectURL(f);
        img.onerror = () => { img.replaceWith(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'Foto lista' })); };
        thumbs.appendChild(img);
      }
      const n = picked[input.name].length;
      status.textContent = n ? `✓ ${n} foto${n > 1 ? 's' : ''} lista${n > 1 ? 's' : ''}` : '';
      slot.classList.toggle('filled', n > 0);
      slot.classList.remove('missing');
      input.value = ''; // permite volver a escoger
    });
  });

  function buildReview() {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const total = Object.values(picked).reduce((a, l) => a + l.length, 0);
    const payer = form.elements.payer.value === 'seguro' ? `Seguro (${val('insurer')})` : 'Por mi cuenta';
    const drv = { si: 'Sí', no: 'No', no_seguro: 'No estoy seguro' }[form.elements.drivable.value] || '';
    document.getElementById('review').innerHTML = `<dl>
      <dt>Nombre</dt><dd>${esc(val('name'))}</dd><dt>Teléfono</dt><dd>${esc(val('phone'))}</dd><dt>Correo</dt><dd>${esc(val('email'))}</dd>
      <dt>Vehículo</dt><dd>${esc(val('year'))} ${esc(val('make'))} ${esc(val('model'))}${val('vin') ? ' · VIN ' + esc(val('vin')) : ''}</dd>
      <dt>Pago</dt><dd>${esc(payer)}</dd><dt>¿Se mueve?</dt><dd>${esc(drv)}</dd><dt>Fotos</dt><dd>${total}</dd></dl>`;
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    for (let i = 0; i < steps.length; i++) {
      const e = validateStep(i);
      if (e) { go(i); return showError(e); }
    }
    const fd = new FormData();
    for (const el of form.elements) {
      if (!el.name || el.type === 'file') continue;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
      fd.append(el.name, el.value);
    }
    for (const [name, list] of Object.entries(picked)) for (const f of list) fd.append(name, f, f.name);

    const btn = form.querySelector('[data-submit]');
    const prog = form.querySelector('.upload-progress');
    const pbar = prog.querySelector('.bar span');
    btn.disabled = true; prog.hidden = false; showError('');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', form.action);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) pbar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
    xhr.onload = () => {
      let r = {};
      try { r = JSON.parse(xhr.responseText); } catch { /* respuesta no JSON */ }
      if (xhr.status === 200 && r.ok) { window.location.href = r.redirect; return; }
      btn.disabled = false; prog.hidden = true;
      showError(r.error || (xhr.status === 403 ? 'La página estuvo abierta mucho tiempo. Recárgala e inténtalo otra vez.' : 'No pudimos enviar tu solicitud. Inténtalo otra vez.'));
    };
    xhr.onerror = () => { btn.disabled = false; prog.hidden = true; showError('Se perdió la conexión. Revisa tu internet e inténtalo otra vez.'); };
    xhr.send(fd);
  });

  go(0);
})();
