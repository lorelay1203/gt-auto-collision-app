'use strict';
const config = require('../config');
const { esc } = require('../lib/format');

const B = config.business;

function layout({ title, body, admin = false, flash = null, banner = '', wide = false, csrf = '' }) {
  const flashHtml = flash ? `<div class="flash flash-${esc(flash.type)}" role="status">${esc(flash.text)}</div>` : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${admin ? 'noindex, nofollow' : 'index, follow'}">
<title>${esc(title)} · ${esc(B.name)}</title>
<link rel="stylesheet" href="/static/css/app.css">
<link rel="icon" href="${esc(B.logoUrl)}">
</head>
<body class="${admin ? 'is-admin' : ''}">
<header class="topbar">
  <div class="wrap topbar-in">
    <a class="brand" href="${admin ? '/taller' : '/'}">
      <img src="${esc(B.logoUrl)}" alt="${esc(B.name)}" height="40">
      <span>${esc(B.name)}${admin ? ' <small>· Panel del taller</small>' : ''}</span>
    </a>
    <nav class="topnav">
      ${admin
        ? `<a href="/taller">Casos</a><a href="/taller/configuracion">Configuración</a>
           <form method="post" action="/taller/salir" class="inline"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="linklike">Salir</button></form>`
        : `<a href="/mi-caso">Mi caso</a><a href="tel:${esc(B.phone.replace(/\D/g, ''))}" class="hide-sm">☎ ${esc(B.phone)}</a>`}
    </nav>
  </div>
</header>
${banner}
<main class="wrap ${wide ? 'wide' : ''}">
${flashHtml}
${body}
</main>
<footer class="footer">
  <div class="wrap">
    <strong>${esc(B.name)}</strong> · Hojalatería y pintura en Bayamón, PR<br>
    ☎ <a href="tel:${esc(B.phone.replace(/\D/g, ''))}">${esc(B.phone)}</a> ·
    <a href="https://wa.me/${esc(B.whatsapp)}" rel="noopener">WhatsApp</a> ·
    ${esc(B.address)}<br>
    ${esc(B.hours)} · <a href="${esc(B.website)}" rel="noopener">${esc(B.website.replace(/^https?:\/\//, ''))}</a> ·
    <a href="/privacidad">Privacidad y uso de datos</a>
  </div>
</footer>
</body>
</html>`;
}

function render(res, opts) {
  res.send(layout({ flash: res.locals.flash, csrf: res.locals.csrf || '', ...opts }));
}

function errorPage(message, title = 'Algo salió mal') {
  return layout({ title, body: `<section class="card narrow"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a class="btn" href="/">Volver al inicio</a></p></section>` });
}

const csrfField = (res) => `<input type="hidden" name="_csrf" value="${esc(res.locals.csrf)}">`;

module.exports = { layout, render, errorPage, csrfField };
