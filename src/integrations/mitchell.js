'use strict';
/**
 * Módulo independiente para una integración FUTURA con Mitchell Cloud Estimating.
 *
 * Estado actual: NO CONECTADO. El taller tiene cuenta de Mitchell, pero todavía no se ha
 * confirmado acceso a una API. Por eso la versión 1 funciona con carga manual:
 * el administrador sube el PDF exportado de Mitchell y escribe el total y el depósito.
 *
 * Este módulo NO simula una conexión y NO genera precios, piezas ni tiempos a partir de fotos.
 * Cuando Mitchell confirme el acceso (documentación, credenciales y términos de uso),
 * se implementan las funciones de abajo y se cambia `isConfigured()`.
 */
const config = require('../config');

class MitchellNotConnectedError extends Error {
  constructor() { super('La integración con Mitchell no está conectada. Usa la carga manual del PDF.'); }
}

function isConfigured() {
  // Aunque existan variables, la integración no se considera activa hasta implementarla y verificarla.
  return false;
}

function status() {
  const hasVars = Boolean(config.mitchell.apiBaseUrl && config.mitchell.apiKey);
  return {
    connected: false,
    label: 'No conectado',
    detail: hasVars
      ? 'Hay variables de Mitchell en el servidor, pero la integración todavía no está implementada ni verificada. Se usa la carga manual del PDF.'
      : 'Pendiente: confirmar con Mitchell si existe acceso a una API. Mientras tanto se usa la carga manual del PDF.',
  };
}

/**
 * FUTURO: traer un estimado ya preparado en Mitchell (no crearlo ni calcularlo).
 * Contrato esperado para que el resto de la app no cambie:
 *   { externalId, version, pdfBuffer, totalCents, depositCents? }
 */
async function fetchEstimate(/* { externalId } */) {
  throw new MitchellNotConnectedError();
}

module.exports = { isConfigured, status, fetchEstimate, MitchellNotConnectedError };
