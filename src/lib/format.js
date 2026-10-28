'use strict';
const config = require('../config');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);

// "1,234.50" o "$1234.5" -> centavos (entero). Devuelve null si no es válido.
function parseMoney(input) {
  const s = String(input ?? '').replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [d, c = ''] = s.split('.');
  return Number(d) * 100 + Number((c + '00').slice(0, 2));
}

const dateTime = (iso) => iso ? new Intl.DateTimeFormat('es-PR', { dateStyle: 'medium', timeStyle: 'short', timeZone: config.business.timezone }).format(new Date(iso)) : '';
const dateOnly = (ymd) => {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('es-PR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
};

const STATUS = {
  recibido: { label: 'Solicitud recibida', help: 'Recibimos tus fotos. El taller las va a revisar.' },
  en_revision: { label: 'En revisión', help: 'El taller está revisando tu caso.' },
  info_solicitada: { label: 'Necesitamos más información', help: 'El taller te pidió información o fotos adicionales. Míralo abajo.' },
  estimado_publicado: { label: 'Estimado listo', help: 'Tu estimado está disponible. Revísalo y, si estás de acuerdo, acéptalo.' },
  estimado_aceptado: { label: 'Estimado aceptado', help: 'Aceptaste el estimado. El próximo paso es el depósito.' },
  deposito_pagado: { label: 'Depósito recibido', help: 'Recibimos tu depósito. Ya puedes solicitar una cita.' },
  cita_solicitada: { label: 'Cita solicitada', help: 'Tu cita está pendiente de confirmación por el taller.' },
  cita_confirmada: { label: 'Cita confirmada', help: 'Tu cita fue confirmada por el taller.' },
  en_reparacion: { label: 'En reparación', help: 'Tu vehículo está en reparación.' },
  completado: { label: 'Completado', help: 'La reparación fue completada.' },
  cancelado: { label: 'Cancelado', help: 'Este caso fue cancelado.' },
};
const statusLabel = (s) => (STATUS[s] || { label: s }).label;

const PHOTO_KINDS = {
  frente: 'Frente', trasera: 'Parte trasera', lado_izq: 'Lado del chofer', lado_der: 'Lado del pasajero',
  cerca: 'Daño de cerca', lejos: 'Daño desde lejos', otra: 'Otra', adicional: 'Adicional (solicitada)',
};

const DRIVABLE = { si: 'Sí, se puede mover', no: 'No se puede mover', no_seguro: 'No estoy seguro' };
const PAYER = { propio: 'Por cuenta propia', seguro: 'Mediante seguro' };
const SLOTS = { manana: 'Mañana (7:00 – 11:00 a.m.)', tarde: 'Mediodía/tarde (11:00 a.m. – 4:00 p.m.)' };

module.exports = { esc, money, parseMoney, dateTime, dateOnly, STATUS, statusLabel, PHOTO_KINDS, DRIVABLE, PAYER, SLOTS };
