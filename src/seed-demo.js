'use strict';
/**
 * Crea DATOS DE DEMOSTRACIÓN claramente identificados (is_demo = 1, nombres "DEMO", montos ficticios).
 * No se ejecuta en producción. Uso: npm run demo
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
if (config.isProd) { console.error('El seed de demostración no se ejecuta en producción.'); process.exit(1); }

const { db, now, setSetting, getSetting, logEvent } = require('./db');
const { hashPassword } = require('./lib/security');
const { createCase, accessLink } = require('./lib/cases');
const payments = require('./integrations/payments');

if (db.prepare('SELECT 1 FROM cases WHERE is_demo = 1').get()) {
  console.log('Los datos de demostración ya existen. (Borra la carpeta data/ y storage/ para empezar de cero.)');
  process.exit(0);
}

// --- Admin DEMO (solo si no hay ninguno y no se definió ADMIN_EMAIL) ---
const DEMO_ADMIN = { email: 'demo@taller.local', password: 'Demo-Taller-2026' };
if (!db.prepare('SELECT 1 FROM admins').get() && !config.admin.email) {
  db.prepare('INSERT INTO admins(email, password_hash, is_demo, created_at) VALUES(?,?,1,?)').run(DEMO_ADMIN.email, hashPassword(DEMO_ADMIN.password), now());
}

if (!getSetting('deposit_terms')) {
  setSetting('deposit_terms', '[TEXTO DE DEMOSTRACIÓN — el taller debe reemplazarlo por sus condiciones reales]\n\n• El depósito se aplica al total de la reparación.\n• Este texto es solo un ejemplo para probar el flujo.');
}

// --- Archivos de ejemplo ---
const photoDir = path.join(config.storageDir, 'photos');
const estDir = path.join(config.storageDir, 'estimates');
fs.mkdirSync(photoDir, { recursive: true }); fs.mkdirSync(estDir, { recursive: true });

function demoPhoto(label) {
  const name = `${crypto.randomUUID()}.svg`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="#1b1b1b"/><rect x="20" y="20" width="760" height="560" fill="none" stroke="#d7141a" stroke-width="8" stroke-dasharray="30 18"/><text x="400" y="270" fill="#fff" font-family="Arial" font-size="54" font-weight="700" text-anchor="middle">FOTO DE DEMOSTRACIÓN</text><text x="400" y="350" fill="#ffd84d" font-family="Arial" font-size="40" text-anchor="middle">${label}</text></svg>`;
  fs.writeFileSync(path.join(photoDir, name), svg);
  return { stored_name: name, mime: 'image/svg+xml', size: Buffer.byteLength(svg) };
}

function demoPdf(caseNumber, version, totalTxt, depTxt) {
  const lines = ['ESTIMADO DE DEMOSTRACION', 'NO ES UN ESTIMADO REAL', '', `Caso: ${caseNumber}   Version: ${version}`,
    `Total (ficticio): ${totalTxt}`, `Deposito (ficticio): ${depTxt}`, '', 'En produccion, aqui va el PDF exportado de Mitchell.'];
  const content = `BT /F1 20 Tf 60 740 Td 26 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const name = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(estDir, name), out);
  return name;
}

const KINDS = [['frente', 'Frente'], ['trasera', 'Parte trasera'], ['lado_izq', 'Lado del chofer'], ['lado_der', 'Lado del pasajero'], ['cerca', 'Daño de cerca'], ['lejos', 'Daño desde lejos']];
const photosFor = () => KINDS.map(([k, l]) => ({ kind: k, ...demoPhoto(l) }));

function base(n, extra) {
  return { name: `Cliente DEMO ${n}`, phone: `787-555-010${n}`, email: `demo${n}@example.com`, make: 'Marca DEMO', model: `Modelo ${n}`,
    year: 2020 + n, vin: '', payer: 'propio', insurer: '', claim_number: '', accident_desc: '[DEMOSTRACIÓN] Descripción ficticia del accidente para probar el sistema.', drivable: 'si', ...extra };
}
function publish(caseId, caseNumber, version, total, deposit) {
  const pdf = demoPdf(caseNumber, version, `$${(total / 100).toFixed(2)}`, `$${(deposit / 100).toFixed(2)}`);
  db.prepare('UPDATE estimates SET superseded_at = ? WHERE case_id = ? AND superseded_at IS NULL').run(now(), caseId);
  db.prepare("INSERT INTO estimates(case_id, version, pdf_stored_name, total_cents, deposit_cents, notes, source, published_at) VALUES(?,?,?,?,?,?, 'manual_pdf', ?)")
    .run(caseId, version, pdf, total, deposit, '[DEMO] Montos ficticios para demostración.', now());
  db.prepare("UPDATE cases SET status = 'estimado_publicado' WHERE id = ?").run(caseId);
  logEvent(caseId, 'taller', 'estimado_publicado', `[DEMO] Publicó la versión ${version} (montos ficticios).`);
}

const links = [];
// 1. Recién recibido
{ const { caseRow, token } = createCase(base(1), photosFor(), { isDemo: true }); links.push([caseRow.case_number, 'Solicitud recibida', token]); }
// 2. Taller pidió más fotos
{ const { caseRow, token } = createCase(base(2, { payer: 'seguro', insurer: 'Aseguradora DEMO', drivable: 'no' }), photosFor(), { isDemo: true });
  db.prepare("INSERT INTO info_requests(case_id, message, wants_photos, created_at) VALUES(?, '[DEMO] Envíe una foto del bonete abierto, por favor.', 1, ?)").run(caseRow.id, now());
  db.prepare("UPDATE cases SET status = 'info_solicitada' WHERE id = ?").run(caseRow.id);
  logEvent(caseRow.id, 'taller', 'info_solicitada', '[DEMO] Solicitó fotos adicionales.');
  links.push([caseRow.case_number, 'Necesita más fotos', token]); }
// 3. Estimado v2 publicado (v1 reemplazada), listo para aceptar
{ const { caseRow, token } = createCase(base(3), photosFor(), { isDemo: true });
  publish(caseRow.id, caseRow.case_number, 1, 140000, 25000);
  publish(caseRow.id, caseRow.case_number, 2, 165000, 30000);
  links.push([caseRow.case_number, 'Estimado v2 listo para aceptar y pagar', token]); }
// 4. Aceptado, depósito simulado pagado, cita solicitada
{ const { caseRow, token } = createCase(base(4), photosFor(), { isDemo: true });
  publish(caseRow.id, caseRow.case_number, 1, 98000, 20000);
  const est = payments.latestEstimate(caseRow.id);
  db.prepare("INSERT INTO acceptances(case_id, estimate_id, estimate_version, signer_name, accepted_at, recorded_by, terms_version) VALUES(?,?,1,'Cliente DEMO 4',?, 'cliente', ?)").run(caseRow.id, est.id, now(), config.termsVersion);
  const p = db.prepare("INSERT INTO payments(case_id, estimate_id, amount_cents, kind, provider, mode, provider_ref, status, created_at) VALUES(?,?,?,'deposito','demo','demo',?, 'pendiente', ?)")
    .run(caseRow.id, est.id, 20000, `demo_seed_${caseRow.id}`, now());
  payments.markPaid(Number(p.lastInsertRowid), { amountCents: 20000 });
  const d = new Date(Date.now() + 7 * 864e5); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  db.prepare("INSERT INTO appointments(case_id, requested_date, requested_slot, status, created_by, created_at, updated_at) VALUES(?,?,'manana','solicitada','cliente',?,?)").run(caseRow.id, d.toISOString().slice(0, 10), now(), now());
  db.prepare("UPDATE cases SET status = 'cita_solicitada' WHERE id = ?").run(caseRow.id);
  links.push([caseRow.case_number, 'Depósito (simulado) pagado y cita por confirmar', token]); }

const out = [
  'DATOS DE DEMOSTRACIÓN — todo es ficticio',
  '',
  'Panel del taller: ' + config.baseUrl + '/taller',
  config.admin.email ? `  Usa tu ADMIN_EMAIL (${config.admin.email})` : `  Correo: ${DEMO_ADMIN.email}\n  Contraseña: ${DEMO_ADMIN.password}`,
  '',
  'Enlaces privados de clientes DEMO:',
  ...links.map(([n, d, t]) => `  ${n} — ${d}\n    ${accessLink(t)}`),
  '',
];
fs.writeFileSync(path.join(config.dataDir, 'DEMO-ACCESOS.txt'), out.join('\n'));
console.log(out.join('\n'));
