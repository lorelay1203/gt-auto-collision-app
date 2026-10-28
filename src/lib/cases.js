'use strict';
const crypto = require('node:crypto');
const { db, now, logEvent, tx } = require('../db');
const { sha256, randomToken } = require('./security');
const config = require('../config');

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCaseNumber() {
  const d = new Date();
  const ym = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  for (;;) {
    const bytes = crypto.randomBytes(5);
    const code = Array.from(bytes, (b) => ALPHA[b % ALPHA.length]).join('');
    const n = `GT-${ym}-${code}`;
    if (!db.prepare('SELECT 1 FROM cases WHERE case_number = ?').get(n)) return n;
  }
}

// El enlace privado se muestra una sola vez; en la base solo se guarda su huella (hash).
const accessLink = (token) => `${config.baseUrl}/e/${token}`;

function createCase(data, photos, { isDemo = false } = {}) {
  return tx(() => {
    const token = randomToken(32);
    const t = now();
    const r = db.prepare(`INSERT INTO cases(case_number, access_token_hash, is_demo, status, name, phone, email, make, model, year, vin,
        payer, insurer, claim_number, accident_desc, drivable, consent_at, consent_version, created_at, updated_at)
        VALUES(?,?,?,'recibido',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(newCaseNumber(), sha256(token), isDemo ? 1 : 0, data.name, data.phone, data.email, data.make, data.model, data.year,
        data.vin || null, data.payer, data.insurer || null, data.claim_number || null, data.accident_desc, data.drivable,
        t, config.consentVersion, t, t);
    const caseId = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO photos(case_id, kind, stored_name, mime, size, uploaded_by, created_at) VALUES(?,?,?,?,?,?,?)');
    for (const p of photos) ins.run(caseId, p.kind, p.stored_name, p.mime, p.size, 'cliente', t);
    logEvent(caseId, 'cliente', 'solicitud_creada', `Solicitud enviada con ${photos.length} foto(s). Consentimiento aceptado (versión ${config.consentVersion}).`);
    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    return { caseRow: row, token };
  });
}

function findByToken(token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token))) return null;
  return db.prepare('SELECT * FROM cases WHERE access_token_hash = ?').get(sha256(token)) || null;
}

function rotateToken(caseId) {
  const token = randomToken(32);
  db.prepare('UPDATE cases SET access_token_hash = ?, updated_at = ? WHERE id = ?').run(sha256(token), now(), caseId);
  // Cerrar sesiones de cliente abiertas con el enlace anterior.
  db.prepare("DELETE FROM sessions WHERE kind = 'cliente' AND case_id = ?").run(caseId);
  logEvent(caseId, 'taller', 'enlace_regenerado', 'Se generó un nuevo enlace privado. El enlace anterior dejó de funcionar.');
  return token;
}

function setStatus(caseId, status, actor, note = '') {
  db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), caseId);
  logEvent(caseId, actor, 'estado', `Estado cambiado a "${require('./format').statusLabel(status)}".${note ? ' ' + note : ''}`);
}

const getCase = (id) => db.prepare('SELECT * FROM cases WHERE id = ?').get(id);

module.exports = { createCase, findByToken, rotateToken, accessLink, setStatus, getCase };
