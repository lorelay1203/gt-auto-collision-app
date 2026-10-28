'use strict';
// Textos legales/avisos al cliente en un solo lugar para que sean consistentes.
const config = require('../config');
const B = config.business;

const NOTICES = {
  preliminar: 'El estimado preparado a partir de fotos es preliminar. Está sujeto a una inspección física del vehículo y puede cambiar si aparecen daños ocultos.',
  autorizacion: 'Cualquier cambio de precio o trabajo adicional requiere tu autorización antes de realizarse.',
  aseguradora: 'Aceptar este estimado no equivale a una aprobación de tu aseguradora. Si usas seguro, la aseguradora decide por separado lo que cubre.',
};

const CONSENT_TEXT = `Autorizo a ${B.name} a usar mis datos de contacto, la información de mi vehículo y las fotografías que envío únicamente para evaluar los daños, preparar el estimado, coordinar la reparación y comunicarse conmigo sobre este caso. Si uso seguro, autorizo compartir esta información con mi aseguradora solo para la reclamación de este caso.`;

const noticeList = () => `<ul class="notices">
  <li><strong>Estimado preliminar:</strong> ${NOTICES.preliminar}</li>
  <li><strong>Cambios con tu permiso:</strong> ${NOTICES.autorizacion}</li>
  <li><strong>Seguro:</strong> ${NOTICES.aseguradora}</li>
</ul>`;

module.exports = { NOTICES, CONSENT_TEXT, noticeList };
