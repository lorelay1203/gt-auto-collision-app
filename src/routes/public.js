'use strict';
const express = require('express');
const config = require('../config');
const { render, errorPage, csrfField } = require('../views/layout');
const { esc, PHOTO_KINDS } = require('../lib/format');
const { ILL } = require('../views/illustrations');
const { CONSENT_TEXT, noticeList } = require('../views/notices');
const { photoUpload, savePhoto, UploadError, multerErrorMessage } = require('../lib/files');
const { csrfCheck, rateLimit, upgradeSession, flash } = require('../lib/security');
const { createCase, accessLink } = require('../lib/cases');
const { db, now } = require('../db');

const router = express.Router();
const B = config.business;

// ---------------- Página principal ----------------
router.get('/', (req, res) => {
  render(res, {
    title: 'Estimados en línea',
    body: `
<section class="hero">
  <p class="eyebrow">Hojalatería · Pintura · Colisión</p>
  <h1>Tu reparación comienza desde tu celular</h1>
  <p class="lead">Sube fotos de los daños, recibe tu estimado y coordina tu reparación con ${esc(B.name)}.</p>
  <a class="btn btn-lg" href="/solicitar">Solicitar estimado</a>
  <p class="muted small">¿Ya enviaste tu solicitud? <a href="/mi-caso">Entra a tu caso</a></p>
</section>
<section class="steps-grid">
  <div class="step-card"><span>1</span><h3>Sube tus fotos</h3><p>Te guiamos foto por foto: frente, atrás, lados y el daño de cerca y de lejos.</p></div>
  <div class="step-card"><span>2</span><h3>El taller revisa</h3><p>Una persona del taller revisa tu caso. Si falta algo, te lo pedimos por aquí.</p></div>
  <div class="step-card"><span>3</span><h3>Recibe tu estimado</h3><p>Lo ves en tu expediente privado y decides si lo aceptas.</p></div>
  <div class="step-card"><span>4</span><h3>Depósito y cita</h3><p>Pagas el depósito en línea y pides tu cita. El taller la confirma.</p></div>
</section>
<section class="card soft">
  <h2>Antes de empezar</h2>
  ${noticeList()}
</section>`,
  });
});

// ---------------- Formulario de solicitud ----------------
const PHOTO_SLOTS = [
  { kind: 'frente', tip: 'Párate frente al carro. Que se vea completo.', required: false },
  { kind: 'trasera', tip: 'Desde atrás, con la tablilla visible.', required: false },
  { kind: 'lado_izq', tip: 'Lado del chofer, de esquina a esquina.', required: false },
  { kind: 'lado_der', tip: 'Lado del pasajero, de esquina a esquina.', required: false },
  { kind: 'cerca', tip: 'Acércate al golpe (1–2 pies). Puedes subir varias.', required: true, multiple: true },
  { kind: 'lejos', tip: 'Aléjate (6–8 pies) para ver el golpe y su área.', required: true },
  { kind: 'otra', tip: 'Opcional: interior, piezas sueltas, otros daños.', required: false, multiple: true },
];

const year = new Date().getFullYear();

router.get('/solicitar', (req, res) => {
  const slots = PHOTO_SLOTS.map((s) => `
    <label class="photo-slot" data-kind="${s.kind}">
      <div class="ill-wrap">${ILL[s.kind]}</div>
      <div class="slot-text">
        <strong>${esc(PHOTO_KINDS[s.kind])}${s.required ? ' <em class="req">obligatoria</em>' : ''}</strong>
        <span>${esc(s.tip)}</span>
        <span class="slot-status" aria-live="polite"></span>
      </div>
      <input type="file" name="photo_${s.kind}" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/*" ${s.multiple ? 'multiple' : ''} ${s.required ? 'data-required="1"' : ''}>
      <div class="thumbs"></div>
    </label>`).join('');

  render(res, {
    title: 'Solicitar estimado',
    body: `
<form id="solicitud" class="wizard" method="post" action="/solicitar" enctype="multipart/form-data" novalidate>
  ${csrfField(res)}
  <div class="progress" aria-hidden="true"><div class="progress-bar"></div></div>
  <p class="step-count muted small"></p>

  <fieldset class="step" data-step="1">
    <legend>Tus datos</legend>
    <p class="muted">Así te contactamos sobre tu caso.</p>
    <label>Nombre completo<input name="name" required maxlength="80" autocomplete="name"></label>
    <label>Teléfono<input name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="787-000-0000" maxlength="20"></label>
    <label>Correo electrónico<input name="email" type="email" required autocomplete="email" maxlength="120"></label>
  </fieldset>

  <fieldset class="step" data-step="2">
    <legend>Tu vehículo</legend>
    <div class="row2">
      <label>Marca<input name="make" required maxlength="40" placeholder="Ej: Toyota"></label>
      <label>Modelo<input name="model" required maxlength="40" placeholder="Ej: Corolla"></label>
    </div>
    <label>Año<input name="year" type="number" required min="1950" max="${year + 1}" inputmode="numeric" placeholder="${year - 3}"></label>
    <label>VIN <span class="muted">(opcional)</span><input name="vin" maxlength="17" autocapitalize="characters" placeholder="17 caracteres" pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{17}"></label>
    <p class="hint">El VIN está en la parte de abajo del cristal delantero (lado del chofer) o en la registración.</p>
  </fieldset>

  <fieldset class="step" data-step="3">
    <legend>¿Cómo vas a pagar la reparación?</legend>
    <div class="choices">
      <label class="choice"><input type="radio" name="payer" value="propio" required><span><strong>Por mi cuenta</strong><small>Pago yo directamente.</small></span></label>
      <label class="choice"><input type="radio" name="payer" value="seguro"><span><strong>Con mi seguro</strong><small>Tengo o voy a abrir una reclamación.</small></span></label>
    </div>
    <div class="insurer-fields" hidden>
      <label>Aseguradora<input name="insurer" maxlength="60" placeholder="Nombre de tu aseguradora"></label>
      <label>Número de reclamación <span class="muted">(si ya lo tienes)</span><input name="claim_number" maxlength="40"></label>
    </div>
  </fieldset>

  <fieldset class="step" data-step="4">
    <legend>¿Qué pasó?</legend>
    <label>Describe el accidente y los daños<textarea name="accident_desc" required minlength="10" maxlength="2000" rows="5" placeholder="Ej: Me chocaron por detrás en un semáforo. El bumper está hundido y la luz izquierda rota."></textarea></label>
    <p class="field-title">¿El vehículo se puede mover (guiar) de forma segura?</p>
    <div class="choices three">
      <label class="choice"><input type="radio" name="drivable" value="si" required><span><strong>Sí</strong></span></label>
      <label class="choice"><input type="radio" name="drivable" value="no"><span><strong>No</strong></span></label>
      <label class="choice"><input type="radio" name="drivable" value="no_seguro"><span><strong>No estoy seguro</strong></span></label>
    </div>
  </fieldset>

  <fieldset class="step" data-step="5">
    <legend>Fotos del vehículo</legend>
    <div class="tips">
      <strong>Consejos rápidos:</strong> toma las fotos de día o con buena luz, sin flash directo al golpe, y con el carro limpio si se puede. Las fotos de <em>cerca</em> y <em>de lejos</em> del daño son obligatorias; las demás ayudan mucho.
    </div>
    <div class="photo-grid">${slots}</div>
  </fieldset>

  <fieldset class="step" data-step="6">
    <legend>Revisa y envía</legend>
    <div class="review" id="review"></div>
    <div class="card soft">${noticeList()}</div>
    <label class="check"><input type="checkbox" name="consent" value="1" required>
      <span>${esc(CONSENT_TEXT)} <a href="/privacidad" target="_blank">Más información</a>.</span></label>
  </fieldset>

  <div class="form-error" role="alert" hidden></div>
  <div class="wizard-nav">
    <button type="button" class="btn ghost" data-prev>Atrás</button>
    <button type="button" class="btn" data-next>Continuar</button>
    <button type="submit" class="btn" data-submit>Enviar solicitud</button>
  </div>
  <div class="upload-progress" hidden><div class="bar"><span></span></div><p>Enviando fotos… no cierres esta página.</p></div>
</form>
<script src="/static/js/solicitud.js" defer></script>`,
  });
});

// ---------------- Recepción de la solicitud ----------------
const photoFields = PHOTO_SLOTS.map((s) => ({ name: `photo_${s.kind}`, maxCount: s.multiple ? 8 : 2 }));

function wantsJson(req) { return (req.get('accept') || '').includes('application/json'); }
function fail(req, res, msg, code = 400) {
  if (wantsJson(req)) return res.status(code).json({ ok: false, error: msg });
  return res.status(code).send(errorPage(msg, 'No pudimos enviar tu solicitud'));
}

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function validate(body) {
  const d = {
    name: clean(body.name, 80), phone: clean(body.phone, 20), email: clean(body.email, 120).toLowerCase(),
    make: clean(body.make, 40), model: clean(body.model, 40), year: Number(body.year), vin: clean(body.vin, 17).toUpperCase(),
    payer: body.payer, insurer: clean(body.insurer, 60), claim_number: clean(body.claim_number, 40),
    accident_desc: String(body.accident_desc ?? '').trim().slice(0, 2000), drivable: body.drivable,
  };
  const digits = d.phone.replace(/\D/g, '');
  if (d.name.length < 2) return [null, 'Escribe tu nombre completo.'];
  if (digits.length < 10 || digits.length > 11) return [null, 'Escribe un teléfono válido de 10 dígitos.'];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return [null, 'Escribe un correo electrónico válido.'];
  if (!d.make || !d.model) return [null, 'Escribe la marca y el modelo del vehículo.'];
  if (!Number.isInteger(d.year) || d.year < 1950 || d.year > year + 1) return [null, 'Escribe un año válido para el vehículo.'];
  if (d.vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(d.vin)) return [null, 'El VIN debe tener 17 letras y números (no lleva I, O ni Q). Puedes dejarlo en blanco.'];
  if (!['propio', 'seguro'].includes(d.payer)) return [null, 'Indica si pagarás por tu cuenta o con seguro.'];
  if (d.payer === 'seguro' && !d.insurer) return [null, 'Escribe el nombre de tu aseguradora.'];
  if (d.payer === 'propio') { d.insurer = ''; d.claim_number = ''; }
  if (d.accident_desc.length < 10) return [null, 'Describe brevemente lo que pasó (al menos una oración).'];
  if (!['si', 'no', 'no_seguro'].includes(d.drivable)) return [null, 'Indica si el vehículo se puede mover.'];
  if (body.consent !== '1') return [null, 'Para continuar debes aceptar el uso de tus datos y fotos para este caso.'];
  d.phone = digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : d.phone;
  return [d, null];
}

router.post('/solicitar', (req, res, next) => {
  if (!rateLimit(`sol:${req.ip}`, 10, 3600e3)) return fail(req, res, 'Recibimos demasiadas solicitudes desde esta conexión. Inténtalo más tarde o llámanos.', 429);
  photoUpload.fields(photoFields)(req, res, (err) => (err ? fail(req, res, multerErrorMessage(err)) : next()));
}, csrfCheck, (req, res) => {
  const [data, error] = validate(req.body);
  if (error) return fail(req, res, error);
  const files = req.files || {};
  if (!files.photo_cerca?.length || !files.photo_lejos?.length) return fail(req, res, 'Sube al menos una foto del daño de cerca y una desde lejos.');

  const saved = [];
  try {
    for (const s of PHOTO_SLOTS) for (const f of files[`photo_${s.kind}`] || []) saved.push({ kind: s.kind, ...savePhoto(f) });
  } catch (e) {
    if (e instanceof UploadError) return fail(req, res, e.message);
    throw e;
  }

  const { caseRow, token } = createCase(data, saved);
  // El cliente queda dentro de su expediente y ve su enlace privado una sola vez.
  upgradeSession(req, res, 'cliente', { caseId: caseRow.id });
  flash(req, 'nuevo', accessLink(token));
  if (wantsJson(req)) return res.json({ ok: true, redirect: '/mi-caso/bienvenida' });
  res.redirect(303, '/mi-caso/bienvenida');
});

// ---------------- Privacidad ----------------
router.get('/privacidad', (req, res) => {
  render(res, {
    title: 'Privacidad y uso de datos',
    body: `<section class="card narrow prose">
<h1>Privacidad y uso de datos</h1>
<p>${esc(CONSENT_TEXT)}</p>
<h2>Qué guardamos</h2>
<p>Tu nombre, teléfono, correo, datos del vehículo, la descripción del accidente, tus fotos, los estimados que publique el taller, tu aceptación (con fecha y hora), los pagos y las citas.</p>
<h2>Quién lo puede ver</h2>
<p>Solo tú (con tu enlace privado o tus datos de acceso) y el personal autorizado del taller. Las fotos y documentos no son públicos.</p>
<h2>Pagos</h2>
<p>Los pagos con tarjeta se procesan en la página segura del procesador de pagos. Esta aplicación no ve ni guarda los números de tu tarjeta.</p>
<h2>Preguntas</h2>
<p>Llámanos al <a href="tel:${esc(B.phone.replace(/\D/g, ''))}">${esc(B.phone)}</a> o escríbenos por <a href="https://wa.me/${esc(B.whatsapp)}">WhatsApp</a>.</p>
<p class="muted small">Versión del consentimiento: ${esc(config.consentVersion)}</p>
</section>`,
  });
});

module.exports = router;
