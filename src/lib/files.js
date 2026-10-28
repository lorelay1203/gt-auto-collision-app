'use strict';
// Validación y almacenamiento privado de archivos. Los archivos NUNCA se sirven como estáticos:
// solo a través de rutas que verifican que el usuario tiene acceso al expediente.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('../config');

fs.mkdirSync(path.join(config.storageDir, 'photos'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'estimates'), { recursive: true });

// Detecta el tipo real por los primeros bytes (no confiamos en la extensión ni en el navegador).
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return { mime: 'image/heic', ext: 'heic' };
  }
  if (buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxPhotoBytes, files: config.uploads.maxPhotosPerRequest, fields: 40, fieldSize: 20000 },
});
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxPdfBytes, files: 1, fields: 20, fieldSize: 20000 },
});

class UploadError extends Error {}

function multerErrorMessage(err) {
  if (err && err.code === 'LIMIT_FILE_SIZE') return 'Uno de los archivos es demasiado grande. Las fotos pueden pesar hasta 12 MB y el PDF hasta 15 MB.';
  if (err && err.code === 'LIMIT_FILE_COUNT') return `Puedes subir hasta ${config.uploads.maxPhotosPerRequest} fotos a la vez.`;
  if (err && err.code === 'LIMIT_UNEXPECTED_FILE') return 'Se recibió un archivo en un campo no permitido.';
  return 'No pudimos procesar los archivos. Inténtalo otra vez.';
}

function savePhoto(file) {
  const t = sniff(file.buffer);
  if (!t || !PHOTO_MIMES.has(t.mime)) throw new UploadError(`"${String(file.originalname).slice(0, 60)}" no es una foto válida. Usa JPG, PNG, WEBP o HEIC.`);
  const name = `${crypto.randomUUID()}.${t.ext}`;
  fs.writeFileSync(path.join(config.storageDir, 'photos', name), file.buffer, { mode: 0o600 });
  return { stored_name: name, mime: t.mime, size: file.size };
}

function savePdf(file) {
  const t = sniff(file.buffer);
  if (!t || t.mime !== 'application/pdf') throw new UploadError('El estimado debe ser un archivo PDF válido.');
  const name = `${crypto.randomUUID()}.pdf`;
  fs.writeFileSync(path.join(config.storageDir, 'estimates', name), file.buffer, { mode: 0o600 });
  return { stored_name: name, size: file.size };
}

function safePath(folder, storedName) {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|heic|pdf|svg)$/.test(storedName)) return null;
  return path.join(config.storageDir, folder, storedName);
}

// Envía un archivo privado con cabeceras seguras.
function sendPrivateFile(res, filePath, mime, downloadName) {
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Archivo no encontrado');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Los PDF no llevan "sandbox" porque el visor de Chrome no los abre en modo sandbox.
  res.setHeader('Content-Security-Policy', mime === 'application/pdf'
    ? "default-src 'none'; object-src 'self'; plugin-types application/pdf"
    : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  fs.createReadStream(filePath).pipe(res);
}

module.exports = { sniff, photoUpload, pdfUpload, UploadError, multerErrorMessage, savePhoto, savePdf, safePath, sendPrivateFile };
