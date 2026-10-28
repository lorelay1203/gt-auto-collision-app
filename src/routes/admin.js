'use strict';
const express = require('express');
const config = require('../config');
const { db, now, logEvent, getSetting, setSetting, tx } = require('../db');
const { render, csrfField } = require('../views/layout');
const { esc, money, parseMoney, dateTime, dateOnly, STATUS, statusLabel, PHOTO_KINDS, DRIVABLE, PAYER, SLOTS } = require('../lib/format');
const { pdfUpload, savePdf, UploadError, multerErrorMessage } = require('../lib/files');
const { csrfCheck, rateLimit, upgradeSession, destroySession, requireAdmin, verifyPassword, hashPassword, flash } = require('../lib/security');
// Hash de relleno para que un correo inexistente tarde lo mismo que uno real.
const DUMMY_HASH = hashPassword('dummy-password-not-used');
const { rotateToken, accessLink, setStatus, getCase } = require('../lib/cases');
const payments = require('../integrations/payments');
const mitchell = require('../integrations/mitchell');
const notifications = require('../integrations/notifications');

const router = express.Router();
const B = config.business;
const A = (opts) => ({ admin: true, ...opts });

// ---------------- Entrar / salir ----------------
router.get('/taller/entrar', (req, res) => {
  if (req.session?.kind === 'admin') return res.redirect('/taller');
  render(res, A({
    title: 'Entrar al panel',
    body: `<section class="card narrow"><h1>Panel del taller</h1>
<form method="post" action="/taller/entrar" class="stack">${csrfField(res)}
  <label>Correo<input name="email" type="email" required autocomplete="username"></label>
  <label>Contraseña<input name="password" type="password" required autocomplete="current-password"></label>
  <button class="btn">Entrar</button>
</form></section>`,
  }));
});

router.post('/taller/entrar', csrfCheck, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!rateLimit(`adm:${req.ip}`, 10, 15 * 60e3) || !rateLimit(`adm:${email}`, 10, 15 * 60e3)) {
    flash(req, 'error', 'Demasiados intentos. Espera 15 minutos.');
    return res.redirect('/taller/entrar');
  }
  const a = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  const ok = a ? verifyPassword(String(req.body.password || ''), a.password_hash) : (verifyPassword('x', DUMMY_HASH), false);
  if (!ok) { flash(req, 'error', 'Correo o contraseña incorrectos.'); return res.redirect('/taller/entrar'); }
  upgradeSession(req, res, 'admin', { adminId: a.id });
  res.redirect('/taller');
});

router.post('/taller/salir', csrfCheck, (req, res) => { destroySession(req, res); res.redirect('/taller/entrar'); });

router.use('/taller', requireAdmin);

function integrationsBox() {
  const pm = payments.getMode(); const mi = mitchell.status(); const no = notifications.status();
  const pill = (on, text) => `<span class="pill ${on ? 'on' : 'off'}">${esc(text)}</span>`;
  return `<div class="integrations">
    <div><strong>Pagos</strong> ${pill(pm.mode === 'live', pm.label)}<small>${esc(pm.reason)}</small></div>
    <div><strong>Mitchell</strong> ${pill(false, mi.label)}<small>${esc(mi.detail)}</small></div>
    <div><strong>Avisos al cliente</strong> ${pill(false, no.label)}<small>${esc(no.detail)}</small></div>
  </div>`;
}

// ---------------- Lista de casos ----------------
router.get('/taller', (req, res) => {
  const estado = STATUS[req.query.estado] ? req.query.estado : '';
  const q = String(req.query.q || '').trim().slice(0, 60);
  const where = []; const args = [];
  if (estado) { where.push('c.status = ?'); args.push(estado); }
  if (q) { where.push('(c.case_number LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.make LIKE ? OR c.model LIKE ?)'); args.push(...Array(6).fill(`%${q}%`)); }
  const rows = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM photos p WHERE p.case_id = c.id) AS n_photos,
      (SELECT COUNT(*) FROM info_requests r WHERE r.case_id = c.id AND r.status = 'respondida') AS n_answered,
      (SELECT COUNT(*) FROM appointments a WHERE a.case_id = c.id AND a.status = 'solicitada') AS n_appt
    FROM cases c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.updated_at DESC LIMIT 200`).all(...args);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM cases GROUP BY status').all().map((r) => [r.status, r.n]));

  render(res, A({
    title: 'Casos', wide: true,
    body: `
<h1>Casos</h1>
${integrationsBox()}
<form class="filters" method="get" action="/taller">
  <input name="q" value="${esc(q)}" placeholder="Buscar: caso, nombre, teléfono, vehículo">
  <select name="estado"><option value="">Todos los estados</option>
    ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === estado ? 'selected' : ''}>${esc(v.label)} (${counts[k] || 0})</option>`).join('')}
  </select>
  <button class="btn">Filtrar</button>
</form>
<div class="case-list">
${rows.length ? rows.map((c) => `
  <a class="case-row" href="/taller/caso/${c.id}">
    <div><strong>${esc(c.case_number)}</strong> ${c.is_demo ? '<span class="badge demo">DEMO</span>' : ''}<br><span class="muted">${esc(c.name)} · ${esc(c.phone)}</span></div>
    <div>${esc(c.year)} ${esc(c.make)} ${esc(c.model)}<br><span class="muted small">${esc(PAYER[c.payer])}${c.insurer ? ' · ' + esc(c.insurer) : ''} · ${c.n_photos} fotos</span></div>
    <div><span class="badge status-${esc(c.status)}">${esc(statusLabel(c.status))}</span>
      ${c.n_answered ? '<span class="badge warn">Respuesta del cliente</span>' : ''}${c.n_appt ? '<span class="badge warn">Cita por confirmar</span>' : ''}
      <br><span class="muted small">Actualizado ${esc(dateTime(c.updated_at))}</span></div>
  </a>`).join('') : '<p class="muted">No hay casos con ese filtro.</p>'}
</div>`,
  }));
});

// ---------------- Detalle del caso ----------------
function loadCase(req, res) {
  const c = getCase(Number(req.params.id));
  if (!c) { res.status(404); render(res, A({ title: 'No encontrado', body: '<p>Caso no encontrado.</p>' })); return null; }
  return c;
}

router.get('/taller/caso/:id', (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const photos = db.prepare('SELECT * FROM photos WHERE case_id = ? ORDER BY id').all(c.id);
  const reqs = db.prepare('SELECT * FROM info_requests WHERE case_id = ? ORDER BY id DESC').all(c.id);
  const ests = db.prepare('SELECT e.*, a.signer_name, a.accepted_at, a.recorded_by FROM estimates e LEFT JOIN acceptances a ON a.estimate_id = e.id WHERE e.case_id = ? ORDER BY e.version DESC').all(c.id);
  const latest = ests.find((e) => !e.superseded_at);
  const pays = db.prepare('SELECT * FROM payments WHERE case_id = ? ORDER BY id DESC').all(c.id);
  const appts = db.prepare('SELECT * FROM appointments WHERE case_id = ? ORDER BY id DESC').all(c.id);
  const events = db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY id DESC').all(c.id);
  const due = payments.depositDue(c.id, latest);
  const csrf = csrfField(res);
  const f = res.locals.flash;
  const newLink = f && f.type === 'enlace' ? f.text : null;
  const phoneDigits = c.phone.replace(/\D/g, '');
  const waBase = `https://wa.me/${phoneDigits.length === 10 ? '1' + phoneDigits : phoneDigits}?text=`;
  const waStatus = waBase + encodeURIComponent(`Hola ${c.name.split(' ')[0]}, le escribe ${B.name} sobre su caso ${c.case_number}. Estado: ${statusLabel(c.status)}. Puede verlo en su expediente en línea.`);

  const ph = photos.map((p) => `<a href="/archivos/foto/${p.id}" target="_blank" rel="noopener"><img src="/archivos/foto/${p.id}" alt="" loading="lazy"><span>${esc(PHOTO_KINDS[p.kind] || p.kind)}${p.info_request_id ? ` (resp. #${p.info_request_id})` : ''}</span></a>`).join('');

  render(res, A({
    title: c.case_number, wide: true, flash: newLink ? null : f,
    banner: c.is_demo ? '<div class="mode-banner demo">CASO DE DEMOSTRACIÓN — datos ficticios</div>' : '',
    body: `
<p><a href="/taller">← Todos los casos</a></p>
<div class="admin-head">
  <div><h1>${esc(c.case_number)}</h1><span class="badge status-${esc(c.status)}">${esc(statusLabel(c.status))}</span></div>
  <div class="row-btns"><a class="btn ghost" href="${esc(waStatus)}" rel="noopener" target="_blank">WhatsApp al cliente</a><a class="btn ghost" href="tel:${esc(phoneDigits)}">Llamar</a></div>
</div>
${newLink ? `<div class="callout"><strong>Nuevo enlace privado del cliente</strong> (se muestra una sola vez):
  <input class="copy-field" readonly value="${esc(newLink)}"><div class="row-btns"><button type="button" class="btn ghost" data-copy=".copy-field">Copiar</button>
  <a class="btn ghost" target="_blank" rel="noopener" href="${esc(waBase + encodeURIComponent(`Hola ${c.name.split(' ')[0]}, este es su enlace privado para ver su caso ${c.case_number} en ${B.name}: ${newLink}`))}">Enviar por WhatsApp</a></div></div>` : ''}

<div class="admin-grid">
<div class="col">
  <section class="card"><h2>Cliente y vehículo</h2>
    <dl class="kv">
      <dt>Nombre</dt><dd>${esc(c.name)}</dd><dt>Teléfono</dt><dd>${esc(c.phone)}</dd><dt>Correo</dt><dd>${esc(c.email)}</dd>
      <dt>Vehículo</dt><dd>${esc(c.year)} ${esc(c.make)} ${esc(c.model)}</dd><dt>VIN</dt><dd>${esc(c.vin || '—')}</dd>
      <dt>Pago</dt><dd>${esc(PAYER[c.payer])}${c.insurer ? ` · ${esc(c.insurer)}` : ''}${c.claim_number ? ` · Reclamación ${esc(c.claim_number)}` : ''}</dd>
      <dt>¿Se mueve?</dt><dd>${esc(DRIVABLE[c.drivable])}</dd>
      <dt>Consentimiento</dt><dd>${esc(dateTime(c.consent_at))} (v. ${esc(c.consent_version)})</dd>
    </dl>
    <p class="quote">${esc(c.accident_desc)}</p>
  </section>

  <section class="card"><h2>Fotos (${photos.length})</h2><div class="gallery">${ph}</div></section>

  <section class="card"><h2>Solicitar información</h2>
    ${reqs.map((r) => `<div class="req ${r.status}"><p><strong>#${r.id}</strong> · ${esc(dateTime(r.created_at))} · <span class="badge">${esc(r.status)}</span>${r.wants_photos ? ' · pide fotos' : ''}</p>
      <p>${esc(r.message)}</p>${r.response_text ? `<p class="quote">Cliente: ${esc(r.response_text)}</p>` : ''}
      ${r.status !== 'cerrada' ? `<form method="post" action="/taller/caso/${c.id}/info/${r.id}/cerrar">${csrf}<button class="linklike">Marcar como resuelta</button></form>` : ''}</div>`).join('')}
    <form method="post" action="/taller/caso/${c.id}/info" class="stack">${csrf}
      <label>Mensaje para el cliente<textarea name="message" rows="3" required maxlength="1000" placeholder="Ej: Envíe una foto del bonete abierto y del radiador."></textarea></label>
      <label class="check"><input type="checkbox" name="wants_photos" value="1" checked><span>Pedir fotos adicionales</span></label>
      <button class="btn">Enviar solicitud al cliente</button>
    </form>
  </section>
</div>

<div class="col">
  <section class="card"><h2>Estado del caso</h2>
    <form method="post" action="/taller/caso/${c.id}/estado" class="inline-form">${csrf}
      <select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      <button class="btn">Guardar</button>
    </form>
  </section>

  <section class="card"><h2>Estimado</h2>
    <p class="muted small">Mitchell: <strong>${esc(mitchell.status().label)}</strong> — se sube el PDF preparado en Mitchell y se escriben los importes a mano.</p>
    ${ests.length ? `<table class="tbl"><thead><tr><th>Versión</th><th>Total</th><th>Depósito</th><th>Estado</th></tr></thead><tbody>
      ${ests.map((e) => `<tr><td><a href="/archivos/estimado/${e.id}" target="_blank" rel="noopener">v${e.version} (PDF)</a><br><span class="muted small">${esc(dateTime(e.published_at))}</span></td>
        <td>${money(e.total_cents)}</td><td>${money(e.deposit_cents)}</td>
        <td>${e.superseded_at ? 'Reemplazada' : 'Vigente'}${e.accepted_at ? `<br><span class="badge ok">Aceptada por ${esc(e.signer_name)} (${esc(e.recorded_by)})</span>` : ''}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">Sin estimados todavía.</p>'}
    <form method="post" action="/taller/caso/${c.id}/estimado" enctype="multipart/form-data" class="stack boxed">${csrf}
      <h3>Publicar ${latest ? `nueva versión (v${latest.version + 1})` : 'estimado (v1)'}</h3>
      <label>PDF del estimado (Mitchell)<input type="file" name="pdf" accept="application/pdf,.pdf" required></label>
      <div class="row2"><label>Total ($)<input name="total" inputmode="decimal" required placeholder="0.00"></label>
      <label>Depósito requerido ($)<input name="deposit" inputmode="decimal" required placeholder="0.00"></label></div>
      <label>Nota para el cliente <span class="muted">(opcional)</span><textarea name="notes" rows="2" maxlength="1000"></textarea></label>
      ${latest ? '<p class="hint">Al publicar, la versión anterior queda como "reemplazada" y el cliente debe aceptar la nueva.</p>' : ''}
      <button class="btn">Publicar estimado</button>
    </form>
    ${latest && !latest.accepted_at ? `<form method="post" action="/taller/caso/${c.id}/aceptacion" class="stack boxed">${csrf}
      <h3>Registrar aceptación en persona (v${latest.version})</h3>
      <input type="hidden" name="estimate_id" value="${latest.id}">
      <label>Nombre de quien acepta<input name="signer_name" required maxlength="80"></label>
      <label class="check"><input type="checkbox" name="confirm" value="1" required><span>El cliente recibió los avisos (preliminar, autorización de cambios, no es aprobación de aseguradora) y aceptó esta versión.</span></label>
      <button class="btn ghost">Registrar aceptación</button></form>` : ''}
  </section>

  <section class="card"><h2>Pagos</h2>
    <p>Depósito pendiente: <strong>${money(due)}</strong></p>
    ${pays.length ? `<table class="tbl"><thead><tr><th>#</th><th>Monto</th><th>Vía</th><th>Estado</th></tr></thead><tbody>
      ${pays.map((p) => `<tr><td>${p.id}</td><td>${money(p.amount_cents)}<br><span class="muted small">${esc(p.kind)}</span></td>
      <td>${esc(p.provider)}${p.mode === 'demo' ? ' <span class="badge demo">SIMULADO</span>' : p.mode === 'test' ? ' <span class="badge test">PRUEBA</span>' : ''}${p.method_note ? `<br><span class="muted small">${esc(p.method_note)}</span>` : ''}</td>
      <td>${esc(p.status)}${p.paid_at ? `<br><span class="muted small">${esc(dateTime(p.paid_at))}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    <form method="post" action="/taller/caso/${c.id}/pago" class="stack boxed">${csrf}
      <h3>Registrar pago recibido en el taller</h3>
      <div class="row2"><label>Monto ($)<input name="amount" inputmode="decimal" required></label>
      <label>Tipo<select name="kind"><option value="deposito">Depósito</option><option value="otro">Otro pago</option></select></label></div>
      <label>Método<select name="method"><option>Efectivo</option><option>ATH Móvil</option><option>Tarjeta en el taller</option><option>KIWI Pay</option><option>Aseguradora</option><option>Otro</option></select></label>
      <label>Referencia / nota<input name="note" maxlength="120"></label>
      <button class="btn ghost">Registrar pago</button>
    </form>
  </section>

  <section class="card"><h2>Citas</h2>
    ${appts.map((a) => `<div class="req ${a.status}"><p><strong>${esc(dateOnly(a.requested_date))}</strong> · ${esc(SLOTS[a.requested_slot] || a.requested_slot)} · <span class="badge">${esc(a.status)}</span> <span class="muted small">(${esc(a.created_by)})</span></p>
      ${a.client_note ? `<p class="quote">${esc(a.client_note)}</p>` : ''}${a.confirmed_for ? `<p>Confirmada para: <strong>${esc(a.confirmed_for)}</strong></p>` : ''}
      ${['solicitada', 'confirmada'].includes(a.status) ? `<form method="post" action="/taller/caso/${c.id}/cita/${a.id}" class="stack">${csrf}
        <label>Fecha y hora confirmada<input name="confirmed_for" maxlength="80" placeholder="Ej: lunes 3 de nov., 8:00 a.m." value="${esc(a.confirmed_for || '')}"></label>
        <label>Nota al cliente<input name="admin_note" maxlength="300" value="${esc(a.admin_note || '')}"></label>
        <div class="row-btns"><button class="btn" name="action" value="confirmar">Confirmar</button><button class="btn ghost" name="action" value="reprogramar">Pedir otra fecha</button><button class="btn ghost" name="action" value="cancelar">Cancelar</button></div>
      </form>` : ''}</div>`).join('') || '<p class="muted">Sin citas.</p>'}
    <details><summary>Registrar cita acordada por teléfono</summary>
      <form method="post" action="/taller/caso/${c.id}/cita" class="stack">${csrf}
        <label>Fecha<input type="date" name="requested_date" required></label>
        <label>Horario<select name="requested_slot">${Object.entries(SLOTS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label>Fecha y hora confirmada<input name="confirmed_for" required maxlength="80"></label>
        <button class="btn ghost">Registrar cita confirmada</button>
      </form></details>
  </section>

  <section class="card"><h2>Acceso del cliente</h2>
    <p class="muted small">El enlace privado se guarda cifrado y no se puede volver a mostrar. Si el cliente lo perdió, genera uno nuevo (el anterior deja de funcionar).</p>
    <form method="post" action="/taller/caso/${c.id}/enlace">${csrf}<button class="btn ghost">Generar nuevo enlace privado</button></form>
  </section>

  <section class="card"><h2>Nota interna</h2>
    <form method="post" action="/taller/caso/${c.id}/nota" class="stack">${csrf}<textarea name="note" rows="2" required maxlength="1000"></textarea><button class="btn ghost">Agregar al historial</button></form>
  </section>
</div>
</div>

<section class="card"><h2>Historial del expediente</h2>
  <ol class="timeline">${events.map((e) => `<li class="actor-${esc(e.actor)}"><span class="muted small">${esc(dateTime(e.created_at))} · ${esc(e.actor)}</span><br>${esc(e.detail || e.type)}</li>`).join('')}</ol>
</section>
<script src="/static/js/app.js" defer></script>`,
  }));
});

// ---------------- Acciones ----------------
const back = (c, hash = '') => `/taller/caso/${c.id}${hash}`;

router.post('/taller/caso/:id/estado', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  if (!STATUS[req.body.status]) return res.redirect(back(c));
  if (req.body.status !== c.status) setStatus(c.id, req.body.status, 'taller');
  flash(req, 'ok', 'Estado actualizado.');
  res.redirect(back(c));
});

router.post('/taller/caso/:id/info', csrfCheck, async (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const msg = String(req.body.message || '').trim().slice(0, 1000);
  if (msg.length < 3) { flash(req, 'error', 'Escribe el mensaje.'); return res.redirect(back(c)); }
  tx(() => {
    db.prepare('INSERT INTO info_requests(case_id, message, wants_photos, created_at) VALUES(?,?,?,?)').run(c.id, msg, req.body.wants_photos === '1' ? 1 : 0, now());
    db.prepare("UPDATE cases SET status = 'info_solicitada', updated_at = ? WHERE id = ?").run(now(), c.id);
    logEvent(c.id, 'taller', 'info_solicitada', `Solicitó información${req.body.wants_photos === '1' ? ' y fotos' : ''}: "${msg}"`);
  });
  await notifications.notifyCustomer(c, 'El taller necesita más información');
  flash(req, 'ok', 'Solicitud enviada. El cliente la verá en su expediente. Avísale por WhatsApp (los avisos automáticos no están configurados).');
  res.redirect(back(c));
});

router.post('/taller/caso/:id/info/:rid/cerrar', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  db.prepare("UPDATE info_requests SET status = 'cerrada' WHERE id = ? AND case_id = ?").run(Number(req.params.rid), c.id);
  logEvent(c.id, 'taller', 'info_cerrada', `Marcó la solicitud #${Number(req.params.rid)} como resuelta.`);
  res.redirect(back(c));
});

router.post('/taller/caso/:id/estimado', (req, res, next) => {
  pdfUpload.single('pdf')(req, res, (err) => {
    if (err) { flash(req, 'error', multerErrorMessage(err)); return res.redirect(`/taller/caso/${Number(req.params.id)}`); }
    next();
  });
}, csrfCheck, async (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const total = parseMoney(req.body.total); const deposit = parseMoney(req.body.deposit);
  if (!req.file) { flash(req, 'error', 'Sube el PDF del estimado.'); return res.redirect(back(c)); }
  if (total === null || total <= 0) { flash(req, 'error', 'Escribe un total válido (ej: 1250.00).'); return res.redirect(back(c)); }
  if (deposit === null || deposit > total) { flash(req, 'error', 'El depósito debe ser un monto válido y no mayor que el total.'); return res.redirect(back(c)); }
  if (deposit > 0 && deposit < 50) { flash(req, 'error', 'Si se requiere depósito, debe ser de al menos $0.50.'); return res.redirect(back(c)); }
  let pdf;
  try { pdf = savePdf(req.file); } catch (e) {
    if (e instanceof UploadError) { flash(req, 'error', e.message); return res.redirect(back(c)); }
    throw e;
  }
  const notes = String(req.body.notes || '').trim().slice(0, 1000);
  const version = tx(() => {
    const prev = db.prepare('SELECT * FROM estimates WHERE case_id = ? AND superseded_at IS NULL').all(c.id);
    const v = (db.prepare('SELECT MAX(version) m FROM estimates WHERE case_id = ?').get(c.id).m || 0) + 1;
    for (const p of prev) db.prepare('UPDATE estimates SET superseded_at = ? WHERE id = ?').run(now(), p.id);
    db.prepare("INSERT INTO estimates(case_id, version, pdf_stored_name, total_cents, deposit_cents, notes, source, published_at) VALUES(?,?,?,?,?,?,'manual_pdf',?)")
      .run(c.id, v, pdf.stored_name, total, deposit, notes || null, now());
    // Cancelar intentos de pago abiertos de versiones anteriores (evita cobrar un monto viejo).
    db.prepare("UPDATE payments SET status = 'cancelado' WHERE case_id = ? AND status = 'pendiente'").run(c.id);
    db.prepare("UPDATE cases SET status = 'estimado_publicado', updated_at = ? WHERE id = ?").run(now(), c.id);
    logEvent(c.id, 'taller', 'estimado_publicado', `Publicó la versión ${v} del estimado (carga manual de PDF): total ${money(total)}, depósito ${money(deposit)}.${prev.length ? ` Reemplaza la versión ${prev.map((p) => p.version).join(', ')}.` : ''}`);
    return v;
  });
  await notifications.notifyCustomer(c, `Estimado versión ${version} disponible`);
  flash(req, 'ok', `Versión ${version} publicada. Avísale al cliente por WhatsApp.`);
  res.redirect(back(c));
});

router.post('/taller/caso/:id/aceptacion', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const est = payments.latestEstimate(c.id);
  const name = String(req.body.signer_name || '').trim().slice(0, 80);
  if (!est || est.id !== Number(req.body.estimate_id) || req.body.confirm !== '1' || name.length < 3) {
    flash(req, 'error', 'Revisa los datos. Solo se puede registrar la aceptación de la versión vigente.');
    return res.redirect(back(c));
  }
  try {
    tx(() => {
      db.prepare("INSERT INTO acceptances(case_id, estimate_id, estimate_version, signer_name, accepted_at, ip, user_agent, recorded_by, terms_version) VALUES(?,?,?,?,?,NULL,NULL,'taller',?)")
        .run(c.id, est.id, est.version, name, now(), config.termsVersion);
      db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(payments.depositDue(c.id, est) > 0 ? 'estimado_aceptado' : 'deposito_pagado', now(), c.id);
      logEvent(c.id, 'taller', 'estimado_aceptado', `Registró aceptación en persona de la versión ${est.version} por "${name}".`);
    });
  } catch (e) { if (!String(e.message).includes('UNIQUE')) throw e; }
  flash(req, 'ok', 'Aceptación registrada.');
  res.redirect(back(c));
});

router.post('/taller/caso/:id/pago', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const amount = parseMoney(req.body.amount);
  const kind = req.body.kind === 'otro' ? 'otro' : 'deposito';
  const method = String(req.body.method || 'Otro').slice(0, 40);
  const note = String(req.body.note || '').trim().slice(0, 120);
  if (!amount || amount <= 0) { flash(req, 'error', 'Escribe un monto válido.'); return res.redirect(back(c)); }
  const est = payments.latestEstimate(c.id);
  tx(() => {
    db.prepare("INSERT INTO payments(case_id, estimate_id, amount_cents, kind, provider, mode, status, method_note, created_at, paid_at) VALUES(?,?,?,?,'manual','manual','pagado',?,?,?)")
      .run(c.id, est ? est.id : null, amount, kind, `${method}${note ? ' · ' + note : ''}`, now(), now());
    logEvent(c.id, 'taller', 'pago_manual', `Registró pago recibido en el taller: ${money(amount)} (${kind}, ${method}${note ? ', ' + note : ''}).`);
    const fresh = getCase(c.id);
    if (kind === 'deposito' && fresh.status === 'estimado_aceptado' && payments.depositDue(c.id, est) === 0) {
      db.prepare("UPDATE cases SET status = 'deposito_pagado', updated_at = ? WHERE id = ?").run(now(), c.id);
    }
  });
  flash(req, 'ok', 'Pago registrado.');
  res.redirect(back(c));
});

router.post('/taller/caso/:id/cita/:aid', csrfCheck, async (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND case_id = ?').get(Number(req.params.aid), c.id);
  if (!a) return res.redirect(back(c));
  const action = req.body.action;
  const when = String(req.body.confirmed_for || '').trim().slice(0, 80);
  const note = String(req.body.admin_note || '').trim().slice(0, 300);
  if (action === 'confirmar' && !when) { flash(req, 'error', 'Escribe la fecha y hora confirmada.'); return res.redirect(back(c)); }
  const status = { confirmar: 'confirmada', reprogramar: 'reprogramar', cancelar: 'cancelada' }[action];
  if (!status) return res.redirect(back(c));
  tx(() => {
    db.prepare('UPDATE appointments SET status = ?, confirmed_for = ?, admin_note = ?, updated_at = ? WHERE id = ?').run(status, status === 'confirmada' ? when : a.confirmed_for, note || null, now(), a.id);
    if (status === 'confirmada') db.prepare("UPDATE cases SET status = 'cita_confirmada', updated_at = ? WHERE id = ?").run(now(), c.id);
    logEvent(c.id, 'taller', 'cita', `Cita ${status}${status === 'confirmada' ? ` para ${when}` : ''}${note ? `. Nota: "${note}"` : ''}.`);
  });
  await notifications.notifyCustomer(c, `Cita ${status}`);
  flash(req, 'ok', 'Cita actualizada. Avísale al cliente.');
  res.redirect(back(c));
});

router.post('/taller/caso/:id/cita', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const date = String(req.body.requested_date || ''); const slot = SLOTS[req.body.requested_slot] ? req.body.requested_slot : 'manana';
  const when = String(req.body.confirmed_for || '').trim().slice(0, 80);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !when) { flash(req, 'error', 'Completa la fecha y la hora confirmada.'); return res.redirect(back(c)); }
  tx(() => {
    db.prepare("UPDATE appointments SET status = 'cancelada', updated_at = ? WHERE case_id = ? AND status IN ('solicitada','reprogramar')").run(now(), c.id);
    db.prepare("INSERT INTO appointments(case_id, requested_date, requested_slot, status, confirmed_for, created_by, created_at, updated_at) VALUES(?,?,?,'confirmada',?,'taller',?,?)").run(c.id, date, slot, when, now(), now());
    db.prepare("UPDATE cases SET status = 'cita_confirmada', updated_at = ? WHERE id = ?").run(now(), c.id);
    logEvent(c.id, 'taller', 'cita', `Registró cita confirmada para ${when}.`);
  });
  flash(req, 'ok', 'Cita registrada.');
  res.redirect(back(c));
});

router.post('/taller/caso/:id/enlace', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const token = rotateToken(c.id);
  flash(req, 'enlace', accessLink(token));
  res.redirect(back(c));
});

router.post('/taller/caso/:id/nota', csrfCheck, (req, res) => {
  const c = loadCase(req, res); if (!c) return;
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (note) logEvent(c.id, 'taller', 'nota', `Nota interna: ${note}`);
  res.redirect(back(c, '#historial'));
});

// ---------------- Configuración ----------------
router.get('/taller/configuracion', (req, res) => {
  const pm = payments.getMode();
  const key = config.payments.stripeSecretKey;
  const keyKind = key.startsWith('sk_live_') || key.startsWith('rk_live_') ? 'real (live)' : key ? 'de prueba (test)' : 'no configurada';
  render(res, A({
    title: 'Configuración', wide: true,
    body: `<h1>Configuración</h1>
${integrationsBox()}
<div class="admin-grid">
<section class="card"><h2>Condiciones del depósito</h2>
  <p class="muted small">El cliente las ve y las acepta antes de pagar. Sin condiciones, el pago en línea queda desactivado.</p>
  <form method="post" action="/taller/configuracion" class="stack">${csrfField(res)}
    <textarea name="deposit_terms" rows="9" maxlength="4000" placeholder="Escriba aquí las condiciones del depósito del taller (reembolsos, aplicación al total, vigencia, etc.)">${esc(getSetting('deposit_terms'))}</textarea>
    <label class="check"><input type="checkbox" name="live_payments_enabled" value="1" ${getSetting('live_payments_enabled') === '1' ? 'checked' : ''}>
      <span>Habilitar pagos <strong>reales</strong> (solo funciona en producción con clave live de Stripe y webhook configurado).</span></label>
    <button class="btn">Guardar</button>
  </form>
</section>
<section class="card"><h2>Estado de integraciones</h2>
  <dl class="kv">
    <dt>Pagos</dt><dd>${esc(pm.label)}<br><span class="muted small">${esc(pm.reason)}</span></dd>
    <dt>Clave de Stripe</dt><dd>${esc(keyKind)} (se guarda solo en el servidor)</dd>
    <dt>Webhook de Stripe</dt><dd>${config.payments.stripeWebhookSecret ? 'Configurado' : 'No configurado'} · URL: <code>${esc(config.baseUrl)}/webhooks/stripe</code></dd>
    <dt>Mitchell</dt><dd>${esc(mitchell.status().label)}<br><span class="muted small">${esc(mitchell.status().detail)}</span></dd>
    <dt>Avisos</dt><dd>${esc(notifications.status().label)}<br><span class="muted small">${esc(notifications.status().detail)}</span></dd>
  </dl>
</section>
</div>`,
  }));
});

router.post('/taller/configuracion', csrfCheck, (req, res) => {
  const terms = String(req.body.deposit_terms || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  const before = getSetting('deposit_terms');
  setSetting('deposit_terms', terms);
  const live = req.body.live_payments_enabled === '1' && terms ? '1' : '0';
  setSetting('live_payments_enabled', live);
  if (before !== terms) logEvent(null, 'taller', 'config', 'Actualizó las condiciones del depósito.');
  flash(req, 'ok', req.body.live_payments_enabled === '1' && !terms ? 'Guardado. No se habilitaron pagos reales porque faltan las condiciones del depósito.' : 'Configuración guardada.');
  res.redirect('/taller/configuracion');
});

module.exports = router;
