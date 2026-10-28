# GT Auto Collision — Estimados en línea

App web para que los clientes de **GT Auto Collision** (Bayamón, PR) suban fotos de su vehículo chocado, reciban un estimado revisado por el taller, lo acepten y paguen un depósito.

> Proyecto independiente. Pensado para vivir en un subdominio, por ejemplo `app.gtautocollisionpr.com`, mientras la web actual (`www.gtautocollisionpr.com`) sigue igual. El botón "Solicitar estimado" de la web puede apuntar a esta app.

## ¿Qué hace?

**Cliente (desde el celular)**
1. Datos de contacto → 2. Vehículo (marca, modelo, año, VIN opcional) → 3. ¿Paga por cuenta propia o con seguro? → 4. Qué pasó y si el carro se mueve → 5. Fotos guiadas con dibujos (frente, atrás, ambos lados, daño de cerca y de lejos) → 6. Revisa, acepta el consentimiento y envía.
7. Recibe un **número de caso** y un **enlace privado** a su expediente (estado, pedidos de fotos, estimado).
8. Acepta **una versión específica** del estimado.
9. Paga el **depósito** (monto y condiciones visibles antes de pagar).
10. Pide una **cita**, sujeta a confirmación del taller.

**Panel del taller** (`/taller`)
- Ver casos, filtros y fotos · pedir información o fotos · cambiar estado
- Subir el **PDF de Mitchell** + escribir total y depósito · publicar nuevas versiones
- Registrar aceptación en persona, pagos recibidos en el taller (efectivo, ATH Móvil, tarjeta, KIWI) y citas
- Historial completo de cada expediente · botón de WhatsApp al cliente · generar nuevo enlace privado

## Qué está activo y qué falta configurar

| Función | Estado | Qué hace falta |
|---|---|---|
| Solicitudes, fotos, expediente, panel, versiones, citas | ✅ Funciona | — |
| Pagos con Stripe | ⚙️ Preparado, **no activo** | Cuenta de Stripe del negocio, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, y las condiciones del depósito en *Configuración* |
| Simulador de pagos | 🧪 Solo demostración | Se apaga solo en producción. Nunca cobra |
| Mitchell Cloud Estimating | ⛔ No conectado | Confirmar con Mitchell si hay acceso a una API. Hoy: carga manual del PDF (`src/integrations/mitchell.js`) |
| Avisos por correo/SMS | ⛔ No configurado | Escoger proveedor. Hoy el taller avisa por WhatsApp desde el panel |

La app **no inventa** precios, piezas ni tiempos a partir de las fotos. Todo importe lo escribe el taller.

## Probarlo en tu computadora

Necesitas Node.js 22.13 o más nuevo.

```bash
npm install
npm run demo      # crea datos DEMO y arranca en http://localhost:3000
npm test          # 14 pruebas de principio a fin
```

Los accesos de demostración quedan en `data/DEMO-ACCESOS.txt` (panel: `demo@taller.local` / `Demo-Taller-2026`). Todo lo DEMO está marcado con una banda amarilla.

## Poner en línea (resumen)

1. Hosting con disco persistente (Render, Railway, Fly.io o un VPS). La base de datos (SQLite) y las fotos se guardan en `data/` y `storage/`: **hacer copias de seguridad**.
2. Copiar `.env.example` como `.env` en el servidor y llenar los valores (nunca subir `.env` a GitHub).
3. Apuntar `app.gtautocollisionpr.com` al hosting (registro CNAME) con HTTPS.
4. En Stripe (modo prueba primero): crear el webhook a `https://app.gtautocollisionpr.com/webhooks/stripe` con los eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`.
5. En el panel → *Configuración*: escribir las condiciones reales del depósito.
6. Cuando todo esté probado: clave `sk_live_...` + marcar "Habilitar pagos reales".

## Seguridad (resumen)

- Cada cliente solo ve su expediente (enlace privado de 256 bits guardado como hash, o número de caso + correo + teléfono, con límite de intentos).
- Fotos y PDF fuera de la carpeta pública; se sirven solo tras verificar acceso. Se revisa el tipo real del archivo y su tamaño.
- Contraseñas con scrypt, sesiones en servidor, cookies HttpOnly, protección CSRF y cabeceras de seguridad.
- Tarjetas: se pagan en la página de Stripe; la app nunca ve ni guarda datos de tarjeta. El pago se confirma desde el servidor y hay protección contra cobros duplicados.
- Credenciales solo en variables de entorno del servidor.

## Estructura

```
src/server.js                 arranque y seguridad general
src/routes/public.js          inicio, formulario por pasos, privacidad
src/routes/customer.js        expediente, aceptar, pagar, cita, archivos privados
src/routes/admin.js           panel del taller
src/integrations/payments/    Stripe + simulador
src/integrations/mitchell.js  módulo futuro (no conectado)
src/integrations/notifications.js  avisos (no configurado)
src/seed-demo.js              datos de demostración
test/e2e.test.js              pruebas
```
