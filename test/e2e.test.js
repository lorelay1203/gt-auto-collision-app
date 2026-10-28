'use strict';
// Prueba de principio a fin con una base de datos temporal. Ejecutar: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'storage');
process.env.ADMIN_EMAIL = 'admin@prueba.local';
process.env.ADMIN_PASSWORD = 'clave-de-prueba-123';
process.env.STRIPE_SECRET_KEY = '';
process.env.APP_BASE_URL = 'http://127.0.0.1:0';

const { createApp, ensureAdmin } = require('../src/server');
const { db } = require('../src/db');
const payments = require('../src/integrations/payments');

let server; let base;
before(async () => {
  ensureAdmin();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Cliente HTTP mínimo con cookies
function client() {
  let cookie = '';
  async function req(method, url, { body, headers = {} } = {}) {
    const r = await fetch(base + url, { method, body, headers: { ...headers, cookie }, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text, type: r.headers.get('content-type') };
  }
  const csrfOf = (html) => (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1];
  return {
    get: (u) => req('GET', u),
    async form(u, fields, csrfFrom = '/') {
      const page = await req('GET', csrfFrom);
      const body = new URLSearchParams({ _csrf: csrfOf(page.text), ...fields });
      return req('POST', u, { body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    },
    async multipart(u, fields, files, csrfFrom = '/', json = false) {
      const page = await req('GET', csrfFrom);
      const fd = new FormData();
      fd.append('_csrf', csrfOf(page.text));
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const [k, buf, name, type] of files) fd.append(k, new Blob([buf], { type }), name);
      return req('POST', u, { body: fd, headers: json ? { accept: 'application/json' } : {} });
    },
    raw: req,
  };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(200, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const FIELDS = { name: 'Prueba Uno', phone: '787-555-0199', email: 'uno@example.com', make: 'Toyota', model: 'Corolla', year: '2019', vin: '', payer: 'propio', accident_desc: 'Me chocaron por detrás en un semáforo.', drivable: 'si', consent: '1' };
const PHOTOS = [['photo_cerca', JPEG, 'cerca.jpg', 'image/jpeg'], ['photo_lejos', JPEG, 'lejos.jpg', 'image/jpeg'], ['photo_frente', JPEG, 'frente.jpg', 'image/jpeg']];

const A = client(); const B = client(); const admin = client();
let caseA; let caseB;

test('el cliente envía la solicitud y recibe número de caso y enlace privado', async () => {
  const r = await A.multipart('/solicitar', FIELDS, PHOTOS, '/solicitar', true);
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.parse(r.text).redirect, '/mi-caso/bienvenida');
  const w = await A.get('/mi-caso/bienvenida');
  assert.match(w.text, /GT-\d{4}-[A-Z0-9]{5}/);
  assert.match(w.text, /\/e\/[A-Za-z0-9_-]{43}/);
  caseA = db.prepare("SELECT * FROM cases WHERE email = 'uno@example.com'").get();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM photos WHERE case_id = ?').get(caseA.id).n, 3);
  assert.ok(caseA.consent_at);
  // la bienvenida se muestra una sola vez
  assert.equal((await A.get('/mi-caso/bienvenida')).status, 302);
});

test('se rechazan archivos que no son fotos, falta de consentimiento y fotos obligatorias', async () => {
  const fake = await B.multipart('/solicitar', { ...FIELDS, email: 'b@example.com' }, [['photo_cerca', Buffer.from('hola, no soy foto'), 'x.jpg', 'image/jpeg'], PHOTOS[1]], '/solicitar', true);
  assert.equal(fake.status, 400); assert.match(JSON.parse(fake.text).error, /no es una foto/);
  const noConsent = await B.multipart('/solicitar', { ...FIELDS, consent: '' }, PHOTOS, '/solicitar', true);
  assert.equal(noConsent.status, 400);
  const missing = await B.multipart('/solicitar', { ...FIELDS, email: 'b@example.com' }, [PHOTOS[2]], '/solicitar', true);
  assert.match(JSON.parse(missing.text).error, /cerca/);
});

test('un cliente no puede ver fotos ni datos de otro expediente', async () => {
  const r = await B.multipart('/solicitar', { ...FIELDS, name: 'Prueba Dos', email: 'dos@example.com' }, PHOTOS, '/solicitar', true);
  assert.equal(r.status, 200);
  caseB = db.prepare("SELECT * FROM cases WHERE email = 'dos@example.com'").get();
  const photoA = db.prepare('SELECT id FROM photos WHERE case_id = ?').get(caseA.id).id;
  assert.equal((await B.get(`/archivos/foto/${photoA}`)).status, 404);
  assert.equal((await A.get(`/archivos/foto/${photoA}`)).status, 200);
  const anon = client();
  assert.equal((await anon.get(`/archivos/foto/${photoA}`)).status, 404);
  const page = await B.get('/mi-caso');
  assert.ok(!page.text.includes(caseA.case_number));
});

test('sin token CSRF se rechaza el envío', async () => {
  const r = await A.raw('POST', '/mi-caso/aceptar', { body: new URLSearchParams({ estimate_id: '1' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 403);
});

test('el panel exige iniciar sesión y la contraseña correcta', async () => {
  assert.equal((await admin.get('/taller')).location, '/taller/entrar');
  await admin.form('/taller/entrar', { email: 'admin@prueba.local', password: 'incorrecta' }, '/taller/entrar');
  assert.equal((await admin.get('/taller')).location, '/taller/entrar');
  const ok = await admin.form('/taller/entrar', { email: 'admin@prueba.local', password: 'clave-de-prueba-123' }, '/taller/entrar');
  assert.equal(ok.location, '/taller');
  const list = await admin.get('/taller');
  assert.match(list.text, new RegExp(caseA.case_number));
  // el cliente no entra al panel
  assert.equal((await A.get(`/taller/caso/${caseA.id}`)).location, '/taller/entrar');
});

test('el taller pide más fotos y el cliente responde', async () => {
  await admin.form(`/taller/caso/${caseA.id}/info`, { message: 'Envíe foto del bonete abierto', wants_photos: '1' }, `/taller/caso/${caseA.id}`);
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get(caseA.id).status, 'info_solicitada');
  const rq = db.prepare('SELECT id FROM info_requests WHERE case_id = ?').get(caseA.id);
  const r = await A.multipart(`/mi-caso/info/${rq.id}`, { response_text: 'Aquí está' }, [['photos', JPEG, 'bonete.jpg', 'image/jpeg']], '/mi-caso');
  assert.equal(r.status, 302);
  assert.equal(db.prepare('SELECT status FROM info_requests WHERE id = ?').get(rq.id).status, 'respondida');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM photos WHERE case_id = ? AND kind = 'adicional'").get(caseA.id).n, 1);
});

test('publicar estimado: valida PDF e importes, y versiona', async () => {
  const bad = await admin.multipart(`/taller/caso/${caseA.id}/estimado`, { total: '1000', deposit: '200' }, [['pdf', JPEG, 'x.pdf', 'application/pdf']], `/taller/caso/${caseA.id}`);
  assert.equal(bad.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM estimates WHERE case_id = ?').get(caseA.id).n, 0);
  const tooBig = await admin.multipart(`/taller/caso/${caseA.id}/estimado`, { total: '100', deposit: '200' }, [['pdf', PDF, 'e.pdf', 'application/pdf']], `/taller/caso/${caseA.id}`);
  assert.equal(tooBig.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM estimates WHERE case_id = ?').get(caseA.id).n, 0);
  await admin.multipart(`/taller/caso/${caseA.id}/estimado`, { total: '1,250.00', deposit: '250' }, [['pdf', PDF, 'e.pdf', 'application/pdf']], `/taller/caso/${caseA.id}`);
  await admin.multipart(`/taller/caso/${caseA.id}/estimado`, { total: '1400.50', deposit: '300' }, [['pdf', PDF, 'e2.pdf', 'application/pdf']], `/taller/caso/${caseA.id}`);
  const ests = db.prepare('SELECT * FROM estimates WHERE case_id = ? ORDER BY version').all(caseA.id);
  assert.equal(ests.length, 2);
  assert.ok(ests[0].superseded_at); assert.equal(ests[1].superseded_at, null);
  assert.equal(ests[1].total_cents, 140050); assert.equal(ests[1].deposit_cents, 30000);
  // el cliente ve su PDF; otro cliente no
  assert.equal((await A.get(`/archivos/estimado/${ests[1].id}`)).type, 'application/pdf');
  assert.equal((await B.get(`/archivos/estimado/${ests[1].id}`)).status, 404);
});

test('el cliente solo puede aceptar la versión vigente', async () => {
  const [v1, v2] = db.prepare('SELECT * FROM estimates WHERE case_id = ? ORDER BY version').all(caseA.id);
  const acks = { ack_preliminar: '1', ack_autorizacion: '1', ack_aseguradora: '1', signer_name: 'Prueba Uno' };
  await A.form('/mi-caso/aceptar', { estimate_id: String(v1.id), ...acks }, '/mi-caso');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acceptances WHERE case_id = ?').get(caseA.id).n, 0);
  await A.form('/mi-caso/aceptar', { estimate_id: String(v2.id), ...acks, ack_aseguradora: '' }, '/mi-caso');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM acceptances WHERE case_id = ?').get(caseA.id).n, 0);
  await A.form('/mi-caso/aceptar', { estimate_id: String(v2.id), ...acks }, '/mi-caso');
  const acc = db.prepare('SELECT * FROM acceptances WHERE case_id = ?').get(caseA.id);
  assert.equal(acc.estimate_version, 2);
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get(caseA.id).status, 'estimado_aceptado');
});

test('pagos desactivados hasta que el taller configure las condiciones del depósito', async () => {
  assert.equal(payments.getMode().mode, 'off');
  const r = await A.form('/mi-caso/pago', { accept_terms: '1' }, '/mi-caso');
  assert.equal(r.location, '/mi-caso');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
  await admin.form('/taller/configuracion', { deposit_terms: 'Condiciones de prueba.' }, '/taller/configuracion');
  assert.equal(payments.getMode().mode, 'demo');
});

test('pago del depósito (simulador) sin cobros duplicados', async () => {
  const page = await A.get('/mi-caso/pago');
  assert.match(page.text, /\$300\.00/); assert.match(page.text, /Condiciones de prueba/); assert.match(page.text, /SIMULADOR/);
  const noTerms = await A.form('/mi-caso/pago', {}, '/mi-caso/pago');
  assert.equal(noTerms.location, '/mi-caso/pago');
  const r1 = await A.form('/mi-caso/pago', { accept_terms: '1' }, '/mi-caso/pago');
  const r2 = await A.form('/mi-caso/pago', { accept_terms: '1' }, '/mi-caso/pago');
  assert.equal(r1.location, r2.location, 'el segundo intento reutiliza el mismo pago abierto');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE case_id = ? AND status = 'pendiente'").get(caseA.id).n, 1);
  // otro cliente no puede usar el simulador de A
  const pid = Number(r1.location.split('/').pop());
  await B.form(`/mi-caso/pago/simulador/${pid}`, { result: 'ok' }, '/mi-caso');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(pid).status, 'pendiente');
  await A.form(`/mi-caso/pago/simulador/${pid}`, { result: 'ok' }, r1.location);
  await A.form(`/mi-caso/pago/simulador/${pid}`, { result: 'ok' }, '/mi-caso');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments WHERE case_id = ? AND status = 'pagado'").get(caseA.id).n, 1);
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get(caseA.id).status, 'deposito_pagado');
  // ya no hay depósito pendiente
  await A.form('/mi-caso/pago', { accept_terms: '1' }, '/mi-caso');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments WHERE case_id = ?').get(caseA.id).n, 1);
  // una segunda confirmación en línea para la misma versión queda bloqueada por la base de datos
  const est = payments.latestEstimate(caseA.id);
  const dup = db.prepare("INSERT INTO payments(case_id, estimate_id, amount_cents, kind, provider, mode, status, created_at) VALUES(?,?,30000,'deposito','demo','demo','pendiente',datetime())").run(caseA.id, est.id);
  assert.equal(payments.markPaid(Number(dup.lastInsertRowid), { amountCents: 30000 }), 'duplicado');
  assert.equal(payments.markPaid(pid, { amountCents: 30000 }), 'ya_pagado');
});

test('nueva versión con depósito mayor solo cobra la diferencia', async () => {
  await admin.multipart(`/taller/caso/${caseA.id}/estimado`, { total: '1600', deposit: '400' }, [['pdf', PDF, 'e3.pdf', 'application/pdf']], `/taller/caso/${caseA.id}`);
  const est = payments.latestEstimate(caseA.id);
  assert.equal(est.version, 3);
  assert.equal(payments.depositDue(caseA.id, est), 10000);
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get(caseA.id).status, 'estimado_publicado');
  const page = await A.get('/mi-caso');
  assert.match(page.text, /Acepto la versión 3/);
});

test('cita: no fines de semana; el taller confirma', async () => {
  const est = payments.latestEstimate(caseA.id);
  await A.form('/mi-caso/aceptar', { estimate_id: String(est.id), ack_preliminar: '1', ack_autorizacion: '1', ack_aseguradora: '1', signer_name: 'Prueba Uno' }, '/mi-caso');
  const d = new Date(Date.now() + 5 * 864e5);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  await A.form('/mi-caso/cita', { requested_date: d.toISOString().slice(0, 10), requested_slot: 'manana' }, '/mi-caso');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM appointments WHERE case_id = ?').get(caseA.id).n, 0);
  d.setUTCDate(d.getUTCDate() + 2); // lunes
  await A.form('/mi-caso/cita', { requested_date: d.toISOString().slice(0, 10), requested_slot: 'tarde' }, '/mi-caso');
  const ap = db.prepare('SELECT * FROM appointments WHERE case_id = ?').get(caseA.id);
  assert.equal(ap.status, 'solicitada');
  await admin.form(`/taller/caso/${caseA.id}/cita/${ap.id}`, { action: 'confirmar', confirmed_for: 'lunes 8:00 a.m.' }, `/taller/caso/${caseA.id}`);
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id = ?').get(ap.id).status, 'confirmada');
  assert.equal(db.prepare('SELECT status FROM cases WHERE id = ?').get(caseA.id).status, 'cita_confirmada');
});

test('el historial registra cada paso y el enlace nuevo invalida el anterior', async () => {
  const types = db.prepare('SELECT type FROM events WHERE case_id = ?').all(caseA.id).map((e) => e.type);
  for (const t of ['solicitud_creada', 'info_solicitada', 'info_respondida', 'estimado_publicado', 'estimado_aceptado', 'pago_confirmado', 'cita_solicitada', 'cita']) assert.ok(types.includes(t), t);
  assert.ok(types.includes('aviso_no_enviado'), 'los avisos no se presentan como enviados');
  await admin.form(`/taller/caso/${caseA.id}/enlace`, {}, `/taller/caso/${caseA.id}`);
  assert.equal((await A.get('/mi-caso')).status, 200);
  assert.match((await A.get('/mi-caso')).text, /Entra a tu caso/, 'la sesión anterior del cliente se cerró');
});

test('entrar con número de caso, correo y teléfono', async () => {
  const C = client();
  await C.form('/mi-caso/entrar', { case_number: caseB.case_number, email: 'dos@example.com', phone: '0000000000' }, '/mi-caso');
  assert.match((await C.get('/mi-caso')).text, /Entra a tu caso/);
  await C.form('/mi-caso/entrar', { case_number: caseB.case_number.toLowerCase(), email: 'DOS@example.com', phone: '(787) 555-0199' }, '/mi-caso');
  assert.match((await C.get('/mi-caso')).text, new RegExp(caseB.case_number));
});
