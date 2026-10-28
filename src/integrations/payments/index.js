'use strict';
/**
 * Pagos de depósito.
 * - Stripe Checkout (página de pago alojada por Stripe): la app NUNCA ve ni guarda datos de tarjeta.
 * - El pago se confirma SOLO desde el servidor (consultando a Stripe o por webhook firmado).
 * - Protección contra cobros duplicados: se reutiliza o se cancela la sesión abierta antes de crear otra,
 *   claves de idempotencia en Stripe y un índice único en la base de datos.
 * - Simulador DEMO: solo fuera de producción y sin clave de Stripe. Nunca cobra dinero.
 */
const config = require('../../config');
const { db, now, getSetting, logEvent, tx } = require('../../db');
const { money } = require('../../lib/format');

let stripeClient = null;
function stripe() {
  if (!stripeClient) stripeClient = require('stripe')(config.payments.stripeSecretKey, { maxNetworkRetries: 2 });
  return stripeClient;
}

function getMode() {
  const key = config.payments.stripeSecretKey;
  const terms = getSetting('deposit_terms').trim();
  if (!terms) return { mode: 'off', label: 'Desactivado', reason: 'El taller todavía no ha configurado las condiciones del depósito.' };
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) {
    return { mode: 'test', label: 'Stripe – MODO DE PRUEBA', reason: 'Se usa el entorno de prueba de Stripe. No se cobra dinero real.' };
  }
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) {
    if (!config.isProd) return { mode: 'off', label: 'Desactivado', reason: 'Clave real de Stripe detectada fuera de producción. Se bloquea por seguridad.' };
    if (!config.payments.stripeWebhookSecret) return { mode: 'off', label: 'Desactivado', reason: 'Falta STRIPE_WEBHOOK_SECRET para confirmar pagos reales.' };
    if (getSetting('live_payments_enabled') !== '1') return { mode: 'off', label: 'Desactivado', reason: 'Pagos reales no habilitados por el administrador.' };
    return { mode: 'live', label: 'Stripe – PAGOS REALES', reason: 'Pagos reales activos.' };
  }
  if (config.payments.demoSimulator) {
    return { mode: 'demo', label: 'SIMULADOR DE DEMOSTRACIÓN', reason: 'No hay procesador configurado. El simulador no cobra dinero y solo existe para probar el flujo.' };
  }
  return { mode: 'off', label: 'Desactivado', reason: 'No hay un procesador de pagos configurado.' };
}

function latestEstimate(caseId) {
  return db.prepare('SELECT * FROM estimates WHERE case_id = ? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1').get(caseId);
}

function depositPaidCents(caseId) {
  return db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM payments WHERE case_id = ? AND kind = 'deposito' AND status = 'pagado'").get(caseId).s;
}

// Depósito pendiente = depósito del estimado vigente – depósitos ya pagados (nunca negativo).
function depositDue(caseId, estimate) {
  if (!estimate) return 0;
  return Math.max(0, estimate.deposit_cents - depositPaidCents(caseId));
}

/** Marca un pago como pagado (idempotente). Devuelve 'ok' | 'ya_pagado' | 'monto_no_coincide' | 'duplicado'. */
function markPaid(paymentId, { amountCents, providerRef = null, actor = 'sistema' }) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p) return 'no_existe';
    if (p.status === 'pagado') return 'ya_pagado';
    if (amountCents !== p.amount_cents) {
      db.prepare("UPDATE payments SET status = 'revisar' WHERE id = ?").run(p.id);
      logEvent(p.case_id, 'sistema', 'pago_revisar', `El monto confirmado (${money(amountCents)}) no coincide con el esperado (${money(p.amount_cents)}). Revisar en el procesador.`);
      return 'monto_no_coincide';
    }
    try {
      db.prepare("UPDATE payments SET status = 'pagado', paid_at = ?, provider_ref = COALESCE(?, provider_ref) WHERE id = ?").run(now(), providerRef, p.id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        db.prepare("UPDATE payments SET status = 'revisar' WHERE id = ?").run(p.id);
        logEvent(p.case_id, 'sistema', 'pago_duplicado', `Se detectó un segundo pago en línea para la misma versión del estimado (pago #${p.id}). Revisar y reembolsar en el procesador si aplica.`);
        return 'duplicado';
      }
      throw e;
    }
    const label = p.mode === 'demo' ? ' [SIMULADO – DEMO, sin cobro real]' : p.mode === 'test' ? ' [MODO DE PRUEBA de Stripe]' : '';
    logEvent(p.case_id, actor, 'pago_confirmado', `Depósito de ${money(p.amount_cents)} confirmado (${p.provider})${label}.`);
    const c = db.prepare('SELECT status FROM cases WHERE id = ?').get(p.case_id);
    if (['estimado_publicado', 'estimado_aceptado'].includes(c.status)) {
      db.prepare("UPDATE cases SET status = 'deposito_pagado', updated_at = ? WHERE id = ?").run(now(), p.case_id);
    }
    return 'ok';
  });
}

/** Inicia el pago del depósito. Devuelve { redirect } o lanza un Error con mensaje para el cliente. */
async function startDepositCheckout(caseRow) {
  const mode = getMode();
  if (mode.mode === 'off') throw new Error(`Los pagos en línea no están disponibles: ${mode.reason}`);
  const est = latestEstimate(caseRow.id);
  if (!est) throw new Error('Todavía no hay un estimado publicado.');
  const acc = db.prepare('SELECT * FROM acceptances WHERE estimate_id = ?').get(est.id);
  if (!acc) throw new Error(`Primero debes aceptar la versión ${est.version} del estimado.`);
  const due = depositDue(caseRow.id, est);
  if (due <= 0) throw new Error('No hay depósito pendiente para este estimado.');

  const provider = mode.mode === 'demo' ? 'demo' : 'stripe';

  // ¿Hay un intento abierto? Reutilizarlo o cerrarlo antes de crear otro (evita dobles cobros).
  const open = db.prepare("SELECT * FROM payments WHERE case_id = ? AND estimate_id = ? AND status = 'pendiente' AND provider = ? ORDER BY id DESC").all(caseRow.id, est.id, provider);
  for (const p of open) {
    const ageMin = (Date.now() - Date.parse(p.created_at)) / 60000;
    if (p.amount_cents === due && ageMin < 20 && p.checkout_url) return { redirect: p.checkout_url };
    if (provider === 'stripe' && p.provider_ref) {
      const s = await stripe().checkout.sessions.retrieve(p.provider_ref);
      if (s.payment_status === 'paid') {
        markPaid(p.id, { amountCents: s.amount_total, providerRef: s.id });
        throw new Error('Este depósito ya fue pagado. Recarga tu expediente.');
      }
      if (s.status === 'open') await stripe().checkout.sessions.expire(s.id);
    }
    db.prepare("UPDATE payments SET status = 'cancelado' WHERE id = ? AND status = 'pendiente'").run(p.id);
  }

  const info = db.prepare("INSERT INTO payments(case_id, estimate_id, amount_cents, kind, provider, mode, status, created_at) VALUES(?,?,?,'deposito',?,?,'pendiente',?)")
    .run(caseRow.id, est.id, due, provider, mode.mode, now());
  const paymentId = Number(info.lastInsertRowid);

  if (provider === 'demo') {
    const url = `/mi-caso/pago/simulador/${paymentId}`;
    db.prepare('UPDATE payments SET checkout_url = ?, provider_ref = ? WHERE id = ?').run(url, `demo_${paymentId}`, paymentId);
    logEvent(caseRow.id, 'cliente', 'pago_iniciado', `Inició el pago del depósito (${money(due)}) en el SIMULADOR DE DEMOSTRACIÓN.`);
    return { redirect: url };
  }

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: caseRow.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: config.payments.currency,
        unit_amount: due,
        product_data: { name: `Depósito – Caso ${caseRow.case_number}`, description: `Estimado versión ${est.version}. ${config.business.name}.` },
      },
    }],
    metadata: { payment_id: String(paymentId), case_id: String(caseRow.id), estimate_id: String(est.id) },
    payment_intent_data: { metadata: { payment_id: String(paymentId), case_number: caseRow.case_number } },
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    success_url: `${config.baseUrl}/mi-caso/pago/retorno?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/mi-caso/pago?cancelado=1`,
  }, { idempotencyKey: `gt-deposit-${paymentId}` });

  db.prepare('UPDATE payments SET provider_ref = ?, checkout_url = ? WHERE id = ?').run(session.id, session.url, paymentId);
  logEvent(caseRow.id, 'cliente', 'pago_iniciado', `Inició el pago del depósito (${money(due)}) con Stripe (${mode.mode === 'test' ? 'modo de prueba' : 'real'}).`);
  return { redirect: session.url };
}

/** Al volver de Stripe: se confirma consultando a Stripe desde el servidor (no se confía en la URL). */
async function confirmStripeReturn(sessionId, caseId) {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(String(sessionId))) return 'invalido';
  const p = db.prepare("SELECT * FROM payments WHERE provider = 'stripe' AND provider_ref = ? AND case_id = ?").get(sessionId, caseId);
  if (!p) return 'invalido';
  if (p.status === 'pagado') return 'ya_pagado';
  const s = await stripe().checkout.sessions.retrieve(sessionId);
  if (s.payment_status !== 'paid' || s.metadata.payment_id !== String(p.id)) return 'pendiente';
  return markPaid(p.id, { amountCents: s.amount_total, providerRef: s.id });
}

/** Webhook firmado de Stripe (fuente principal de confirmación). */
function handleStripeWebhook(rawBody, signature) {
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.payments.stripeWebhookSecret);
  const seen = db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(event.id);
  if (seen) return 'repetido';
  db.prepare('INSERT INTO webhook_events(id, received_at) VALUES(?, ?)').run(event.id, now());
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const s = event.data.object;
    if (s.payment_status !== 'paid') return 'pendiente';
    const p = db.prepare("SELECT * FROM payments WHERE provider = 'stripe' AND provider_ref = ?").get(s.id);
    if (!p || String(p.id) !== s.metadata?.payment_id) return 'desconocido';
    return markPaid(p.id, { amountCents: s.amount_total, providerRef: s.id });
  }
  return 'ignorado';
}

module.exports = { getMode, latestEstimate, depositDue, depositPaidCents, markPaid, startDepositCheckout, confirmStripeReturn, handleStripeWebhook };
