'use strict';
const crypto = require('node:crypto');
const { db, now } = require('../db');
const config = require('../config');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// ---------- Contraseñas (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

// ---------- Sesiones en servidor (cookie solo guarda un id aleatorio) ----------
const COOKIE = config.isProd ? '__Host-gt_sid' : 'gt_sid';
const TTL = { visitante: 2 * 3600e3, cliente: 7 * 24 * 3600e3, admin: 10 * 3600e3 };

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAgeMs) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (config.isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function createSession(res, kind, { adminId = null, caseId = null } = {}) {
  const sid = randomToken();
  const csrf = randomToken(24);
  const expires = new Date(Date.now() + TTL[kind]).toISOString();
  db.prepare('INSERT INTO sessions(id_hash, kind, admin_id, case_id, csrf, created_at, expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(sha256(sid), kind, adminId, caseId, csrf, now(), expires);
  setCookie(res, sid, TTL[kind]);
  return { idHash: sha256(sid), kind, admin_id: adminId, case_id: caseId, csrf, flash: null };
}

function destroySession(req, res) {
  if (req.session) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(req.session.id_hash);
  setCookie(res, '', 0);
  req.session = null;
}

// Middleware: carga sesión; si no existe, crea una de visitante (necesaria para el token CSRF).
function sessionMiddleware(req, res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  let s = null;
  if (sid) {
    s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(sha256(sid));
    if (s && s.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash); s = null; }
  }
  if (!s && req.method === 'GET' && !req.path.startsWith('/static/') && !req.path.startsWith('/webhooks/')) {
    const created = createSession(res, 'visitante');
    s = { id_hash: created.idHash, ...created };
  }
  req.session = s;
  res.locals.csrf = s ? s.csrf : '';
  // Mensaje "flash" de una sola vez
  if (s && s.flash) {
    try { res.locals.flash = JSON.parse(s.flash); } catch { res.locals.flash = null; }
    db.prepare('UPDATE sessions SET flash = NULL WHERE id_hash = ?').run(s.id_hash);
  }
  next();
}

function flash(req, type, text) {
  if (!req.session) return;
  db.prepare('UPDATE sessions SET flash = ? WHERE id_hash = ?').run(JSON.stringify({ type, text }), req.session.id_hash);
}

// Cambia el tipo de sesión rotando el id (evita fijación de sesión).
function upgradeSession(req, res, kind, ids) {
  destroySession(req, res);
  const s = createSession(res, kind, ids);
  req.session = { id_hash: s.idHash, ...s };
  return req.session;
}

function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!req.session || !token || token.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
    return res.status(403).send(require('../views/layout').errorPage('La sesión expiró o el formulario no es válido. Vuelve atrás, recarga la página e inténtalo otra vez.'));
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.kind === 'admin' && req.session.admin_id) return next();
  return res.redirect('/taller/entrar');
}
function requireCustomer(req, res, next) {
  if (req.session && req.session.kind === 'cliente' && req.session.case_id) return next();
  return res.redirect('/mi-caso');
}

// ---------- Límite de intentos (memoria) ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key) || { n: 0, reset: t + windowMs };
  if (t > b.reset) { b.n = 0; b.reset = t + windowMs; }
  b.n += 1;
  buckets.set(key, b);
  return b.n <= max;
}

module.exports = {
  sha256, randomToken, hashPassword, verifyPassword,
  sessionMiddleware, createSession, destroySession, upgradeSession, flash,
  csrfCheck, requireAdmin, requireCustomer, rateLimit,
};
