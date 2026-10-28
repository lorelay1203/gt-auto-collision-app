'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { db, now } = require('./db');
const { sessionMiddleware, hashPassword } = require('./lib/security');
const { errorPage } = require('./views/layout');
const payments = require('./integrations/payments');

// ---------- Administrador inicial (desde variables de entorno) ----------
function ensureAdmin() {
  const { email, password } = config.admin;
  if (!email || !password) {
    if (!db.prepare('SELECT 1 FROM admins').get()) console.warn('⚠  No hay administrador. Define ADMIN_EMAIL y ADMIN_PASSWORD en .env (o usa "npm run demo").');
    return;
  }
  if (password.length < 12) throw new Error('ADMIN_PASSWORD debe tener al menos 12 caracteres.');
  const e = email.trim().toLowerCase();
  if (!db.prepare('SELECT 1 FROM admins WHERE email = ?').get(e)) {
    db.prepare('INSERT INTO admins(email, password_hash, created_at) VALUES(?,?,?)').run(e, hashPassword(password), now());
    console.log(`✓ Administrador creado: ${e}`);
  }
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // detrás del proxy HTTPS del hosting
  app.disable('x-powered-by');

  const logoOrigin = new URL(config.business.logoUrl).origin;
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', logoOrigin],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        formAction: ["'self'", 'https://checkout.stripe.com'],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd,
  }));

  // Webhook de Stripe: necesita el cuerpo sin procesar para verificar la firma. Va antes de los parsers.
  app.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!config.payments.stripeSecretKey || !config.payments.stripeWebhookSecret) return res.status(503).send('Webhook no configurado');
    try {
      const r = payments.handleStripeWebhook(req.body, req.get('stripe-signature'));
      res.json({ received: true, result: r });
    } catch (e) {
      console.error('Webhook Stripe rechazado:', e.message);
      res.status(400).send('Firma inválida');
    }
  });

  app.use('/static', express.static(path.join(config.ROOT, 'public'), { maxAge: config.isProd ? '1d' : 0, index: false }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(sessionMiddleware);
  app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/salud', (req, res) => res.json({ ok: true }));
  app.use(require('./routes/public'));
  app.use(require('./routes/customer'));
  app.use(require('./routes/admin'));

  app.use((req, res) => res.status(404).send(errorPage('La página que buscas no existe.', 'Página no encontrada')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send(errorPage('Ocurrió un error inesperado. Inténtalo otra vez o llámanos.'));
  });
  return app;
}

if (require.main === module) {
  ensureAdmin();
  // Limpieza periódica de sesiones vencidas
  setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600e3).unref();
  const app = createApp();
  app.listen(config.port, () => {
    const pm = payments.getMode();
    console.log(`\n${config.business.name} — app de estimados`);
    console.log(`→ ${config.baseUrl}`);
    console.log(`→ Panel del taller: ${config.baseUrl}/taller`);
    console.log(`→ Pagos: ${pm.label} — ${pm.reason}`);
    console.log('→ Mitchell: no conectado (carga manual de PDF)');
    console.log('→ Avisos al cliente: no configurados\n');
  });
}

module.exports = { createApp, ensureAdmin };
