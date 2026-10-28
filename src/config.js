'use strict';
// Configuración central. Todas las credenciales viven SOLO aquí (variables de entorno del servidor).
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const isProd = env.NODE_ENV === 'production';

module.exports = {
  ROOT,
  isProd,
  port: Number(env.PORT || 3000),
  // URL pública de la app, ej: https://app.gtautocollisionpr.com
  baseUrl: (env.APP_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  storageDir: path.resolve(ROOT, env.STORAGE_DIR || 'storage'),

  // Datos reales del negocio (tomados de www.gtautocollisionpr.com). Se pueden cambiar por variables de entorno.
  business: {
    name: env.BUSINESS_NAME || 'GT Auto Collision',
    phone: env.BUSINESS_PHONE || '787-600-5388',
    whatsapp: env.BUSINESS_WHATSAPP || '17876005388',
    address: env.BUSINESS_ADDRESS || 'Ave. Lomas Verdes, Bayamón, PR 00956',
    hours: env.BUSINESS_HOURS || 'Lunes a viernes, 7:00 a.m. – 4:00 p.m.',
    website: env.BUSINESS_WEBSITE || 'https://www.gtautocollisionpr.com',
    logoUrl: env.BUSINESS_LOGO_URL || 'https://www.gtautocollisionpr.com/gt-auto-collision-logo.png',
    timezone: 'America/Puerto_Rico',
  },

  admin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
  },

  payments: {
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // Simulador local para demostrar el flujo sin procesador. Nunca se activa en producción.
    demoSimulator: !isProd && env.DEMO_PAYMENTS !== '0',
    currency: 'usd',
  },

  notifications: {
    // Reservado para un proveedor de correo/SMS. Mientras esté vacío, NO se envían avisos.
    provider: env.NOTIFY_PROVIDER || '',
  },

  mitchell: {
    // Reservado. No existe conexión hasta que Mitchell confirme acceso a una API.
    apiBaseUrl: env.MITCHELL_API_BASE_URL || '',
    apiKey: env.MITCHELL_API_KEY || '',
  },

  uploads: {
    maxPhotoBytes: 12 * 1024 * 1024,
    maxPdfBytes: 15 * 1024 * 1024,
    maxPhotosPerRequest: 20,
  },

  consentVersion: '2026-10-v1',
  termsVersion: '2026-10-v1',
};
