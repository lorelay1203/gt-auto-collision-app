'use strict';
/**
 * Avisos al cliente (correo / SMS). Estado: NO CONFIGURADO.
 * Mientras no haya proveedor, la app NO envía nada: deja una nota en el historial
 * para que el taller avise manualmente (por ejemplo, con el botón de WhatsApp del panel).
 */
const config = require('../config');
const { logEvent } = require('../db');

function status() {
  return config.notifications.provider
    ? { active: false, label: 'Proveedor indicado, sin implementar', detail: `NOTIFY_PROVIDER="${config.notifications.provider}" está definido, pero el envío no está implementado ni verificado.` }
    : { active: false, label: 'No configurado', detail: 'No se envían correos ni SMS. El taller avisa al cliente manualmente (WhatsApp o llamada).' };
}

// Devuelve false si no se envió. Nunca finge un envío.
async function notifyCustomer(caseRow, subject) {
  logEvent(caseRow.id, 'sistema', 'aviso_no_enviado', `Aviso pendiente para el cliente: "${subject}". Las notificaciones automáticas no están configuradas; avisar manualmente.`);
  return false;
}

module.exports = { status, notifyCustomer };
