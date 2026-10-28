'use strict';
const express = require('express');
const config = require('../config');
const { db, now, logEvent, getSetting, tx } = require('../db');
const { render, csrfField } = require('../views/layout');
const { esc, money, dateTime, dateOnly, STATUS, statusLabel, PHOTO_KINDS, SLOTS } = require('../lib/format');
const { noticeList, NOTICES } = require('../views/notices');
const { photoUpload, savePhoto, UploadError, multerErrorMessage, safePath, sendPrivateFile } = require('../lib/files');
const { csrfCheck, rateLimit, upgradeSession, destroySession, requireCustomer, flash } = require('../lib/security');
const { findByToken, getCase } = require('../lib/cases');
const payments = require('../integrations/payments');
const notifications = require('../integrations/notifications');

const router = express.Router();
const B = config.business;

const TRACK = [
  ['recibido', 'Solicitud'], ['en_revision', 'Revisión'], ['estimado_publicado', 'Estimado'],
  ['estimado_aceptado', 'Aceptado'], ['deposito_pagado', 'Depósito'], ['cita_confirmada', 'Cita'],
];
const ORDER = ['recibido', 'en_revision', 'info_solicitada', 'estimado_publicado', 'estimado_aceptado', 'deposito_pagado', 'cita_solicitada', 'cita_confirmada', 'en_reparacion', 'completado'];

function tracker(status) {
  const pos = ORDER.indexOf(status);
  return `<ol class="tracker">${TRACK.map(([key, label]) => {
    const kpos = ORDER.indexOf(key);
    const cls = pos >= kpos ? 'done' : '';
    return `<li class="${cls}"><span></span>${esc(label)}</li>`;
  }).join('')}</ol>`;
}

function paymentBanner(mode) {
  if (mode.mode === 'demo') return '<div class="mode-banner demo">SIMULADOR DE DEMOSTRACIÓN — no se cobra dinero real</div>';
  if (mode.mode === 'test') return '<div class="mode-banner test">MODO DE PRUEBA DE STRIPE — no se cobra dinero real</div>';
  return '';
}

// ---------------- Entrar al expediente ----------------
router.get('/e/:token', (req, res) => {
  if (!rateLimit(`tok:${req.ip}`, 30, 15 * 60e3)) return res.status(429).send('Demasiados intentos. Espera unos minutos.');
  const c = findByToken(req.params.token);
  if (!c) {
    flash(req, 'error', 'Ese enlace no es válido o fue reemplazado. Usa el más reciente o entra con tus datos.');
    return res.redirect('/mi-caso');
  }
  upgradeSession(req, res, 'cliente', { caseId: c.id });
  logEvent(c.id, 'cliente', 'acceso', 'El cliente entró a su expediente con su enlace privado.');
  res.redirect('/mi-caso');
});

router.get('/mi-caso', (req, res, next) => {
  if (req.session?.kind === 'cliente' && req.session.case_id) return next();
  render(res, {
    title: 'Mi caso',
    body: `<section class="card narrow">
<h1>Entra a tu caso</h1>
<p>La forma más fácil es abrir el <strong>enlace privado</strong> que recibiste al enviar tu solicitud.</p>
<p>Si no lo tienes, escribe estos tres datos tal como los enviaste:</p>
<form method="post" action="/mi-caso/entrar" class="stack">
  ${csrfField(res)}
  <label>Número de caso<input name="case_number" required placeholder="GT-2610-ABCDE" autocapitalize="characters" maxlength="20"></label>
  <label>Correo electrónico<input name="email" type="email" required maxlength="120"></label>
  <label>Teléfono<input name="phone" type="tel" required maxlength="20"></label>
  <button class="btn">Entrar</button>
</form>
<p class="muted small">¿No tienes tu número de caso? Llámanos al <a href="tel:${esc(B.phone.replace(/\D/g, ''))}">${esc(B.phone)}</a> y te enviamos un enlace nuevo.</p>
</section>`,
  });
});

router.post('/mi-caso/entrar', csrfCheck, (req, res) => {
  const num = String(req.body.case_number || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const digits = String(req.body.phone || '').replace(/\D/g, '').slice(-10);
  if (!rateLimit(`login-c:${req.ip}`, 8, 15 * 60e3) || !rateLimit(`login-c:${num}`, 8, 60 * 60e3)) {
    flash(req, 'error', 'Demasiados intentos. Espera unos minutos o llámanos.');
    return res.redirect('/mi-caso');
  }
  const c = db.prepare('SELECT * FROM cases WHERE case_number = ?').get(num);
  const ok = c && c.email === email && c.phone.replace(/\D/g, '').slice(-10) === digits && digits.length === 10;
  if (!ok) {
    flash(req, 'error', 'Los datos no coinciden con ningún caso. Revisa e inténtalo otra vez.');
    return res.redirect('/mi-caso');
  }
  upgradeSession(req, res, 'cliente', { caseId: c.id });
  logEvent(c.id, 'cliente', 'acceso', 'El cliente entró a su expediente con número de caso, correo y teléfono.');
  res.redirect('/mi-caso');
});

router.post('/mi-caso/salir', csrfCheck, (req, res) => { destroySession(req, res); res.redirect('/'); });

// ---------------- Bienvenida (se ve una sola vez) ----------------
router.get('/mi-caso/bienvenida', requireCustomer, (req, res) => {
  const c = getCase(req.session.case_id);
  const f = res.locals.flash;
  if (!f || f.type !== 'nuevo') return res.redirect('/mi-caso');
  const link = f.text;
  const wa = `https://wa.me/?text=${encodeURIComponent(`Mi caso en ${B.name}: ${c.case_number} — ${link}`)}`;
  render(res, {
    title: 'Solicitud enviada', flash: null,
    body: `<section class="card narrow center">
<div class="big-check" aria-hidden="true">✓</div>
<h1>¡Recibimos tu solicitud!</h1>
<p>Tu número de caso es</p>
<p class="case-number">${esc(c.case_number)}</p>
<div class="callout">
  <strong>Guarda tu enlace privado.</strong> Con él entras a tu expediente para ver el estado y tu estimado. No lo compartas.
  <input class="copy-field" readonly value="${esc(link)}" aria-label="Enlace privado">
  <div class="row-btns">
    <button type="button" class="btn ghost" data-copy=".copy-field">Copiar enlace</button>
    <a class="btn ghost" href="${esc(wa)}" rel="noopener">Guardarlo en WhatsApp</a>
  </div>
  <p class="muted small">Este enlace solo se muestra ahora. Si lo pierdes, entra con tu número de caso, correo y teléfono.</p>
</div>
<p class="muted">${esc(notifications.status().active ? 'También te enviamos un aviso.' : 'El taller se comunicará contigo por teléfono o WhatsApp cuando revise tu caso.')}</p>
<a class="btn" href="/mi-caso">Ver mi expediente</a>
</section><script src="/static/js/app.js" defer></script>`,
  });
});

// ---------------- Expediente ----------------
router.get('/mi-caso', requireCustomer, (req, res) => {
  const c = getCase(req.session.case_id);
  if (!c) { destroySession(req, res); return res.redirect('/mi-caso'); }
  const photos = db.prepare('SELECT * FROM photos WHERE case_id = ? ORDER BY id').all(c.id);
  const requests = db.prepare('SELECT * FROM info_requests WHERE case_id = ? ORDER BY id DESC').all(c.id);
  const estimates = db.prepare('SELECT * FROM estimates WHERE case_id = ? ORDER BY version DESC').all(c.id);
  const latest = estimates.find((e) => !e.superseded_at);
  const acc = latest ? db.prepare('SELECT * FROM acceptances WHERE estimate_id = ?').get(latest.id) : null;
  const pays = db.prepare("SELECT * FROM payments WHERE case_id = ? AND status IN ('pagado','revisar') ORDER BY id").all(c.id);
  const appts = db.prepare('SELECT * FROM appointments WHERE case_id = ? ORDER BY id DESC').all(c.id);
  const mode = payments.getMode();
  const due = payments.depositDue(c.id, latest);
  const st = STATUS[c.status] || { label: c.status, help: '' };

  const openReqs = requests.filter((r) => r.status === 'abierta');
  const reqHtml = openReqs.map((r) => `
<section class="card alert-card" id="info-${r.id}">
  <h2>El taller necesita algo más</h2>
  <p class="quote">${esc(r.message)}</p>
  <form method="post" action="/mi-caso/info/${r.id}" enctype="multipart/form-data" class="stack">
    ${csrfField(res)}
    <label>Tu respuesta<textarea name="response_text" rows="3" maxlength="2000" ${r.wants_photos ? '' : 'required'}></textarea></label>
    ${r.wants_photos ? `<label>Fotos adicionales<input type="file" name="photos" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/*" required></label>` : ''}
    <button class="btn">Enviar respuesta</button>
  </form>
</section>`).join('');

  let estHtml = '<section class="card"><h2>Estimado</h2><p class="muted">Todavía no hay un estimado. Te avisaremos cuando el taller lo publique.</p></section>';
  if (latest) {
    const older = estimates.filter((e) => e.superseded_at);
    estHtml = `
<section class="card" id="estimado">
  <h2>Tu estimado <span class="badge">Versión ${latest.version}</span></h2>
  <p class="muted small">Publicado ${esc(dateTime(latest.published_at))}</p>
  <dl class="amounts">
    <div><dt>Total estimado</dt><dd>${money(latest.total_cents)}</dd></div>
    <div><dt>Depósito requerido</dt><dd>${money(latest.deposit_cents)}</dd></div>
  </dl>
  ${latest.notes ? `<p class="quote">${esc(latest.notes)}</p>` : ''}
  <p><a class="btn ghost" href="/archivos/estimado/${latest.id}" target="_blank" rel="noopener">Ver estimado completo (PDF)</a></p>
  ${noticeList()}
  ${acc
    ? `<div class="ok-box">✓ Aceptaste la <strong>versión ${acc.estimate_version}</strong> el ${esc(dateTime(acc.accepted_at))} (${esc(acc.signer_name)}).</div>`
    : `<form method="post" action="/mi-caso/aceptar" class="stack accept-form">
        ${csrfField(res)}
        <input type="hidden" name="estimate_id" value="${latest.id}">
        <h3>Aceptar la versión ${latest.version}</h3>
        <label class="check"><input type="checkbox" name="ack_preliminar" value="1" required><span>Entiendo que es preliminar y puede cambiar tras la inspección física o por daños ocultos.</span></label>
        <label class="check"><input type="checkbox" name="ack_autorizacion" value="1" required><span>Entiendo que cambios de precio o trabajos adicionales requieren mi autorización.</span></label>
        <label class="check"><input type="checkbox" name="ack_aseguradora" value="1" required><span>Entiendo que aceptar no equivale a aprobación de una aseguradora.</span></label>
        <label>Escribe tu nombre completo para aceptar<input name="signer_name" required maxlength="80" autocomplete="name"></label>
        <button class="btn">Acepto la versión ${latest.version} del estimado</button>
      </form>`}
  ${older.length ? `<details class="older"><summary>Versiones anteriores (${older.length})</summary><ul>${older.map((e) => `<li>Versión ${e.version} · ${money(e.total_cents)} · reemplazada ${esc(dateTime(e.superseded_at))} · <a href="/archivos/estimado/${e.id}" target="_blank" rel="noopener">PDF</a></li>`).join('')}</ul></details>` : ''}
</section>`;
  }

  let payHtml = '';
  if (latest && acc) {
    const paidList = pays.length ? `<ul class="plain">${pays.map((p) => `<li>${p.status === 'pagado' ? '✓' : '⚠'} ${money(p.amount_cents)} · ${esc(p.kind === 'deposito' ? 'Depósito' : 'Pago')} · ${esc(p.status === 'pagado' ? dateTime(p.paid_at) : 'En revisión por el taller')}${p.mode === 'demo' ? ' <span class="badge demo">SIMULADO</span>' : p.mode === 'test' ? ' <span class="badge test">PRUEBA</span>' : ''}</li>`).join('')}</ul>` : '';
    payHtml = `<section class="card" id="deposito"><h2>Depósito</h2>
      ${due > 0
        ? (mode.mode === 'off'
          ? `<p>Depósito pendiente: <strong>${money(due)}</strong>.</p><p class="muted">El pago en línea todavía no está disponible. El taller te indicará cómo pagar (efectivo, ATH Móvil o tarjeta en el taller).</p>`
          : `<p>Depósito pendiente: <strong>${money(due)}</strong>.</p><a class="btn" href="/mi-caso/pago">Revisar y pagar depósito</a>`)
        : '<div class="ok-box">✓ No tienes depósito pendiente.</div>'}
      ${paidList}</section>`;
  }

  let apptHtml = '';
  if (acc) {
    const current = appts[0];
    const canRequest = !current || ['cancelada', 'reprogramar'].includes(current.status);
    const tomorrow = new Date(Date.now() + 24 * 3600e3).toISOString().slice(0, 10);
    apptHtml = `<section class="card" id="cita"><h2>Cita</h2>
      ${current ? `<p>Pediste: <strong>${esc(dateOnly(current.requested_date))}</strong>, ${esc(SLOTS[current.requested_slot] || '')}.</p>
        <p>Estado: <strong>${esc({ solicitada: 'Pendiente de confirmación', confirmada: 'Confirmada', reprogramar: 'El taller pide otra fecha', cancelada: 'Cancelada' }[current.status])}</strong>
        ${current.confirmed_for ? ` — ${esc(current.confirmed_for)}` : ''}</p>
        ${current.admin_note ? `<p class="quote">${esc(current.admin_note)}</p>` : ''}` : ''}
      ${canRequest ? `
      ${due > 0 ? '<p class="muted small">Puedes pedir tu cita ahora; el taller la confirma cuando se reciba el depósito.</p>' : ''}
      <form method="post" action="/mi-caso/cita" class="stack">
        ${csrfField(res)}
        <label>Fecha que prefieres<input type="date" name="requested_date" required min="${tomorrow}"></label>
        <p class="hint">Horario del taller: ${esc(B.hours)}.</p>
        <fieldset class="choices"><legend class="field-title">Horario</legend>
          ${Object.entries(SLOTS).map(([k, v], i) => `<label class="choice"><input type="radio" name="requested_slot" value="${k}" ${i === 0 ? 'required' : ''}><span>${esc(v)}</span></label>`).join('')}
        </fieldset>
        <label>Nota <span class="muted">(opcional)</span><textarea name="client_note" rows="2" maxlength="500"></textarea></label>
        <button class="btn">Solicitar cita</button>
        <p class="muted small">La cita queda <strong>sujeta a confirmación</strong> del taller.</p>
      </form>` : ''}
    </section>`;
  }

  render(res, {
    title: `Caso ${c.case_number}`,
    banner: c.is_demo ? '<div class="mode-banner demo">CASO DE DEMOSTRACIÓN — datos ficticios</div>' : '',
    body: `
<section class="case-head">
  <p class="muted small">Caso</p>
  <h1 class="case-number">${esc(c.case_number)}</h1>
  <p>${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</p>
  <div class="status-box"><span class="badge status-${esc(c.status)}">${esc(st.label)}</span><p>${esc(st.help)}</p></div>
  ${tracker(c.status)}
</section>
${reqHtml}
${estHtml}
${payHtml}
${apptHtml}
<section class="card"><h2>Tus fotos (${photos.length})</h2>
  <div class="gallery">${photos.map((p) => `<a href="/archivos/foto/${p.id}" target="_blank" rel="noopener"><img src="/archivos/foto/${p.id}" alt="${esc(PHOTO_KINDS[p.kind] || p.kind)}" loading="lazy"><span>${esc(PHOTO_KINDS[p.kind] || p.kind)}</span></a>`).join('')}</div>
</section>
<section class="card soft"><h2>¿Preguntas?</h2>
  <p>Llámanos al <a href="tel:${esc(B.phone.replace(/\D/g, ''))}">${esc(B.phone)}</a> o escríbenos por <a href="https://wa.me/${esc(B.whatsapp)}?text=${encodeURIComponent(`Hola, tengo una pregunta sobre mi caso ${c.case_number}.`)}" rel="noopener">WhatsApp</a>. ${esc(B.hours)}.</p>
  <form method="post" action="/mi-caso/salir">${csrfField(res)}<button class="linklike">Salir de mi expediente</button></form>
</section>`,
  });
});

// ---------------- Responder solicitud de información ----------------
router.post('/mi-caso/info/:id', requireCustomer, (req, res, next) => {
  photoUpload.array('photos', 10)(req, res, (err) => {
    if (err) { flash(req, 'error', multerErrorMessage(err)); return res.redirect('/mi-caso'); }
    next();
  });
}, csrfCheck, (req, res) => {
  const caseId = req.session.case_id;
  const r = db.prepare("SELECT * FROM info_requests WHERE id = ? AND case_id = ? AND status = 'abierta'").get(Number(req.params.id), caseId);
  if (!r) return res.redirect('/mi-caso');
  const text = String(req.body.response_text || '').trim().slice(0, 2000);
  const files = req.files || [];
  if (r.wants_photos && !files.length) { flash(req, 'error', 'Sube al menos una foto.'); return res.redirect('/mi-caso'); }
  if (!r.wants_photos && !text) { flash(req, 'error', 'Escribe tu respuesta.'); return res.redirect('/mi-caso'); }
  let saved = [];
  try { saved = files.map(savePhoto); } catch (e) {
    if (e instanceof UploadError) { flash(req, 'error', e.message); return res.redirect('/mi-caso'); }
    throw e;
  }
  tx(() => {
    const ins = db.prepare("INSERT INTO photos(case_id, kind, stored_name, mime, size, info_request_id, uploaded_by, created_at) VALUES(?, 'adicional', ?, ?, ?, ?, 'cliente', ?)");
    for (const p of saved) ins.run(caseId, p.stored_name, p.mime, p.size, r.id, now());
    db.prepare("UPDATE info_requests SET status = 'respondida', response_text = ?, responded_at = ? WHERE id = ?").run(text || null, now(), r.id);
    const c = getCase(caseId);
    if (c.status === 'info_solicitada') db.prepare("UPDATE cases SET status = 'en_revision', updated_at = ? WHERE id = ?").run(now(), caseId);
    logEvent(caseId, 'cliente', 'info_respondida', `Respondió la solicitud #${r.id}${saved.length ? ` con ${saved.length} foto(s)` : ''}.`);
  });
  flash(req, 'ok', 'Gracias. Enviamos tu respuesta al taller.');
  res.redirect('/mi-caso');
});

// ---------------- Aceptar una versión específica ----------------
router.post('/mi-caso/aceptar', requireCustomer, csrfCheck, (req, res) => {
  const caseId = req.session.case_id;
  const est = payments.latestEstimate(caseId);
  const postedId = Number(req.body.estimate_id);
  if (!est || est.id !== postedId) {
    flash(req, 'error', 'El taller publicó una versión más reciente del estimado. Revísala antes de aceptar.');
    return res.redirect('/mi-caso#estimado');
  }
  const name = String(req.body.signer_name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (req.body.ack_preliminar !== '1' || req.body.ack_autorizacion !== '1' || req.body.ack_aseguradora !== '1' || name.length < 3) {
    flash(req, 'error', 'Marca las tres casillas y escribe tu nombre completo para aceptar.');
    return res.redirect('/mi-caso#estimado');
  }
  try {
    tx(() => {
      db.prepare("INSERT INTO acceptances(case_id, estimate_id, estimate_version, signer_name, accepted_at, ip, user_agent, recorded_by, terms_version) VALUES(?,?,?,?,?,?,?,'cliente',?)")
        .run(caseId, est.id, est.version, name, now(), req.ip, String(req.get('user-agent') || '').slice(0, 200), config.termsVersion);
      const c = getCase(caseId);
      const next = payments.depositDue(caseId, est) > 0 ? 'estimado_aceptado' : 'deposito_pagado';
      if (['estimado_publicado', 'en_revision', 'recibido', 'info_solicitada'].includes(c.status)) db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(next, now(), caseId);
      logEvent(caseId, 'cliente', 'estimado_aceptado', `Aceptó la versión ${est.version} (total ${money(est.total_cents)}, depósito ${money(est.deposit_cents)}). Firmó: "${name}". Reconoció: ${Object.keys(NOTICES).join(', ')}.`);
    });
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e;
  }
  flash(req, 'ok', `Aceptaste la versión ${est.version} del estimado.`);
  res.redirect('/mi-caso#deposito');
});

// ---------------- Pago del depósito ----------------
router.get('/mi-caso/pago', requireCustomer, (req, res) => {
  const c = getCase(req.session.case_id);
  const est = payments.latestEstimate(c.id);
  const acc = est && db.prepare('SELECT * FROM acceptances WHERE estimate_id = ?').get(est.id);
  const due = payments.depositDue(c.id, est);
  const mode = payments.getMode();
  if (!est || !acc || due <= 0) return res.redirect('/mi-caso');
  const terms = getSetting('deposit_terms');
  render(res, {
    title: 'Pagar depósito',
    banner: paymentBanner(mode),
    body: `<section class="card narrow">
<p><a href="/mi-caso">← Volver a mi caso</a></p>
<h1>Pagar depósito</h1>
${req.query.cancelado ? '<div class="flash flash-error">El pago no se completó. No se hizo ningún cobro. Puedes intentarlo otra vez.</div>' : ''}
<dl class="amounts big">
  <div><dt>Monto a pagar ahora</dt><dd>${money(due)}</dd></div>
</dl>
<p class="muted">Caso ${esc(c.case_number)} · Estimado versión ${est.version} (total ${money(est.total_cents)}).</p>
<h2>Condiciones del depósito</h2>
<div class="terms">${esc(terms).replace(/\n/g, '<br>')}</div>
${mode.mode === 'off'
  ? `<p class="flash flash-error">${esc(mode.reason)} El taller te indicará otra forma de pago.</p>`
  : `<form method="post" action="/mi-caso/pago" class="stack" data-once>
      ${csrfField(res)}
      <label class="check"><input type="checkbox" name="accept_terms" value="1" required><span>Leí y acepto las condiciones del depósito.</span></label>
      <button class="btn btn-lg">${mode.mode === 'demo' ? 'Continuar al simulador' : `Pagar ${money(due)} de forma segura`}</button>
      <p class="muted small">${mode.mode === 'demo' ? 'Es una demostración: no se pide tarjeta ni se cobra.' : 'Serás dirigido a la página segura de Stripe. Esta app no ve ni guarda los datos de tu tarjeta.'}</p>
    </form>`}
</section><script src="/static/js/app.js" defer></script>`,
  });
});

router.post('/mi-caso/pago', requireCustomer, csrfCheck, async (req, res, next) => {
  if (req.body.accept_terms !== '1') { flash(req, 'error', 'Debes aceptar las condiciones del depósito.'); return res.redirect('/mi-caso/pago'); }
  if (!rateLimit(`pay:${req.session.case_id}`, 10, 15 * 60e3)) { flash(req, 'error', 'Demasiados intentos de pago. Espera unos minutos.'); return res.redirect('/mi-caso'); }
  try {
    const c = getCase(req.session.case_id);
    const { redirect } = await payments.startDepositCheckout(c);
    res.redirect(303, redirect);
  } catch (e) {
    if (e.type?.startsWith?.('Stripe')) { console.error('Stripe:', e.message); flash(req, 'error', 'El procesador de pagos no respondió. No se hizo ningún cobro. Inténtalo más tarde.'); return res.redirect('/mi-caso'); }
    if (e instanceof Error && !e.code) { flash(req, 'error', e.message); return res.redirect('/mi-caso'); }
    next(e);
  }
});

router.get('/mi-caso/pago/retorno', requireCustomer, async (req, res, next) => {
  try {
    const r = await payments.confirmStripeReturn(String(req.query.session_id || ''), req.session.case_id);
    const msg = { ok: ['ok', '✓ Recibimos tu depósito. ¡Gracias!'], ya_pagado: ['ok', '✓ Tu depósito ya estaba registrado.'], pendiente: ['info', 'Tu pago se está procesando. Lo verás confirmado aquí en unos minutos.'] }[r]
      || ['error', 'No pudimos confirmar el pago automáticamente. El taller lo revisará. No intentes pagar otra vez.'];
    flash(req, msg[0], msg[1]);
    res.redirect('/mi-caso#deposito');
  } catch (e) { next(e); }
});

// Simulador DEMO (solo existe si no hay procesador y no es producción)
function demoPayment(req) {
  if (payments.getMode().mode !== 'demo') return null;
  return db.prepare("SELECT * FROM payments WHERE id = ? AND case_id = ? AND provider = 'demo'").get(Number(req.params.id), req.session.case_id);
}
router.get('/mi-caso/pago/simulador/:id', requireCustomer, (req, res) => {
  const p = demoPayment(req);
  if (!p || p.status !== 'pendiente') return res.redirect('/mi-caso');
  render(res, {
    title: 'Simulador de pago (DEMO)',
    banner: paymentBanner({ mode: 'demo' }),
    body: `<section class="card narrow center">
<h1>Simulador de pago</h1>
<p>Esto <strong>NO</strong> es un procesador real. No se cobra dinero ni se piden datos de tarjeta. Sirve solo para probar el flujo.</p>
<dl class="amounts big"><div><dt>Monto</dt><dd>${money(p.amount_cents)}</dd></div></dl>
<form method="post" action="/mi-caso/pago/simulador/${p.id}" class="row-btns" data-once>
  ${csrfField(res)}
  <button class="btn" name="result" value="ok">Simular pago aprobado</button>
  <button class="btn ghost" name="result" value="cancel">Simular pago cancelado</button>
</form></section><script src="/static/js/app.js" defer></script>`,
  });
});
router.post('/mi-caso/pago/simulador/:id', requireCustomer, csrfCheck, (req, res) => {
  const p = demoPayment(req);
  if (!p) return res.redirect('/mi-caso');
  if (req.body.result === 'ok') {
    const r = payments.markPaid(p.id, { amountCents: p.amount_cents, actor: 'cliente' });
    flash(req, r === 'ok' || r === 'ya_pagado' ? 'ok' : 'error', r === 'ok' || r === 'ya_pagado' ? '✓ Depósito registrado (SIMULADO – sin cobro real).' : 'El pago simulado no se pudo registrar.');
    return res.redirect('/mi-caso#deposito');
  }
  db.prepare("UPDATE payments SET status = 'cancelado' WHERE id = ? AND status = 'pendiente'").run(p.id);
  res.redirect('/mi-caso/pago?cancelado=1');
});

// ---------------- Cita ----------------
router.post('/mi-caso/cita', requireCustomer, csrfCheck, (req, res) => {
  const caseId = req.session.case_id;
  const est = payments.latestEstimate(caseId);
  const acc = est && db.prepare('SELECT 1 FROM acceptances WHERE case_id = ?').get(caseId);
  if (!acc) return res.redirect('/mi-caso');
  const date = String(req.body.requested_date || '');
  const slot = String(req.body.requested_slot || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const todayPR = new Date(new Date().toLocaleString('en-US', { timeZone: B.timezone }));
  const minDate = new Date(Date.UTC(todayPR.getFullYear(), todayPR.getMonth(), todayPR.getDate() + 1));
  const maxDate = new Date(minDate.getTime() + 90 * 24 * 3600e3);
  if (!d || isNaN(d) || d < minDate || d > maxDate) { flash(req, 'error', 'Escoge una fecha a partir de mañana y dentro de los próximos 90 días.'); return res.redirect('/mi-caso#cita'); }
  if ([0, 6].includes(d.getUTCDay())) { flash(req, 'error', 'El taller trabaja de lunes a viernes. Escoge un día de semana.'); return res.redirect('/mi-caso#cita'); }
  if (!SLOTS[slot]) { flash(req, 'error', 'Escoge un horario.'); return res.redirect('/mi-caso#cita'); }
  const current = db.prepare('SELECT * FROM appointments WHERE case_id = ? ORDER BY id DESC LIMIT 1').get(caseId);
  if (current && ['solicitada', 'confirmada'].includes(current.status)) return res.redirect('/mi-caso#cita');
  const note = String(req.body.client_note || '').trim().slice(0, 500);
  tx(() => {
    db.prepare("INSERT INTO appointments(case_id, requested_date, requested_slot, client_note, status, created_by, created_at, updated_at) VALUES(?,?,?,?,'solicitada','cliente',?,?)")
      .run(caseId, date, slot, note || null, now(), now());
    const c = getCase(caseId);
    if (['estimado_aceptado', 'deposito_pagado'].includes(c.status)) db.prepare("UPDATE cases SET status = 'cita_solicitada', updated_at = ? WHERE id = ?").run(now(), caseId);
    logEvent(caseId, 'cliente', 'cita_solicitada', `Solicitó cita para ${dateOnly(date)} (${SLOTS[slot]}).`);
  });
  flash(req, 'ok', 'Solicitamos tu cita. El taller la confirmará pronto.');
  res.redirect('/mi-caso#cita');
});

// ---------------- Archivos privados ----------------
function canSeeCase(req, caseId) {
  if (req.session?.kind === 'admin' && req.session.admin_id) return true;
  return req.session?.kind === 'cliente' && req.session.case_id === caseId;
}
router.get('/archivos/foto/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(req.params.id));
  if (!p || !canSeeCase(req, p.case_id)) return res.status(404).send('Archivo no encontrado');
  sendPrivateFile(res, safePath('photos', p.stored_name), p.mime, `foto-${p.id}.${p.stored_name.split('.').pop()}`);
});
router.get('/archivos/estimado/:id', (req, res) => {
  const e = db.prepare('SELECT e.*, c.case_number FROM estimates e JOIN cases c ON c.id = e.case_id WHERE e.id = ?').get(Number(req.params.id));
  if (!e || !canSeeCase(req, e.case_id)) return res.status(404).send('Archivo no encontrado');
  sendPrivateFile(res, safePath('estimates', e.pdf_stored_name), 'application/pdf', `estimado-${e.case_number}-v${e.version}.pdf`);
});

module.exports = router;
