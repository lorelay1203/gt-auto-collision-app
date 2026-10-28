'use strict';
// Dibujos simples (SVG) que muestran al cliente qué foto tomar. Usan currentColor para el tema.
const car = {
  side: '<path d="M14 58h92c4 0 6-3 6-6v-7c0-3-2-5-5-6l-14-3-12-12c-2-2-5-3-8-3H45c-3 0-6 1-8 3L25 36l-9 2c-3 1-5 3-5 6v8c0 3 1 6 3 6z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M40 36l10-10h17l10 10z" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="34" cy="58" r="9" fill="var(--bg)" stroke="currentColor" stroke-width="3"/><circle cx="88" cy="58" r="9" fill="var(--bg)" stroke="currentColor" stroke-width="3"/>',
  front: '<path d="M30 60V38l8-14h44l8 14v22" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M40 36l5-8h30l5 8z" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="33" y="44" width="12" height="6" rx="2" fill="currentColor"/><rect x="75" y="44" width="12" height="6" rx="2" fill="currentColor"/><rect x="50" y="46" width="20" height="5" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="28" y="58" width="10" height="8" rx="2" fill="currentColor"/><rect x="82" y="58" width="10" height="8" rx="2" fill="currentColor"/>',
  rear: '<path d="M30 60V38l8-14h44l8 14v22" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M40 36l5-8h30l5 8z" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="31" y="42" width="14" height="5" rx="1" fill="var(--red)"/><rect x="75" y="42" width="14" height="5" rx="1" fill="var(--red)"/><rect x="50" y="50" width="20" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><rect x="28" y="58" width="10" height="8" rx="2" fill="currentColor"/><rect x="82" y="58" width="10" height="8" rx="2" fill="currentColor"/>',
};

function frame(inner, { flip = false, extra = '' } = {}) {
  return `<svg viewBox="0 0 120 76" aria-hidden="true" class="ill"><g ${flip ? 'transform="translate(120 0) scale(-1 1)"' : ''}>${inner}</g>${extra}</svg>`;
}

const ILL = {
  frente: frame(car.front),
  trasera: frame(car.rear),
  lado_izq: frame(car.side),
  lado_der: frame(car.side, { flip: true }),
  cerca: `<svg viewBox="0 0 120 76" aria-hidden="true" class="ill"><path d="M10 40c20-6 40-6 60-2s30 2 40-2" fill="none" stroke="currentColor" stroke-width="3"/><path d="M45 34l6 10 5-8 6 12 4-9" fill="none" stroke="var(--red)" stroke-width="3" stroke-linejoin="round"/><circle cx="56" cy="40" r="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="4 3"/><text x="60" y="72" text-anchor="middle" font-size="9" fill="currentColor">a 1–2 pies</text></svg>`,
  lejos: `<svg viewBox="0 0 120 76" aria-hidden="true" class="ill"><rect x="4" y="4" width="112" height="62" rx="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4"/><g transform="translate(27 10) scale(.55)">${car.side}</g><circle cx="78" cy="32" r="5" fill="var(--red)"/><text x="60" y="74" text-anchor="middle" font-size="9" fill="currentColor">a 6–8 pies</text></svg>`,
  otra: `<svg viewBox="0 0 120 76" aria-hidden="true" class="ill"><rect x="30" y="16" width="60" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M60 28v20M50 38h20" stroke="currentColor" stroke-width="3"/></svg>`,
};

module.exports = { ILL };
