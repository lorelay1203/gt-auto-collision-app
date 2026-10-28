# Poner en línea GT Auto Collision — guía paso a paso

Objetivo: publicar el app en **`app.gtautocollisionpr.com`** sin tocar tu web actual
(`www.gtautocollisionpr.com`), que sigue en Cloudflare. Cloudflare sigue manejando el
dominio y el HTTPS; el app corre en un hosting con disco.

> **Por qué un hosting aparte y no Cloudflare Pages:** este app es un servidor Node.js con
> base de datos (SQLite) y fotos guardadas en disco. Cloudflare Pages/Workers no corren un
> servidor así ni guardan esos archivos de forma permanente. Por eso: web en Cloudflare +
> app en Render (u otro), unidos por un subdominio.

---

## Parte A — Publicar el app (recomendado: Render)

Render es el más sencillo para esto y permite disco persistente.

1. **Crea una cuenta** en https://render.com (puedes entrar con GitHub).
2. **New → Web Service** y conecta el repositorio `lorelay1203/gt-auto-collision-app`.
3. Configura:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** el plan más pequeño con disco sirve para empezar.
4. **Agrega un Disco persistente** (Settings → Disks → Add Disk):
   - **Mount Path:** `/var/data`
   - **Size:** 1 GB (se puede subir después)
   > ⚠️ Sin este disco, la base de datos y las fotos se borran en cada despliegue.
5. **Variables de entorno** (Environment → Add Environment Variable):

   | Variable | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_BASE_URL` | `https://app.gtautocollisionpr.com` |
   | `DATA_DIR` | `/var/data/data` |
   | `STORAGE_DIR` | `/var/data/storage` |
   | `ADMIN_EMAIL` | tu correo de administrador del panel |
   | `ADMIN_PASSWORD` | una contraseña fuerte (mínimo 12 caracteres) |

   Deja **vacías** las de Stripe por ahora (los pagos se activan después; mientras tanto el
   taller registra pagos en persona desde el panel).

6. **Create Web Service** y espera a que despliegue. Render te da una dirección tipo
   `gt-auto-collision.onrender.com`. Ábrela para confirmar que carga.

---

## Parte B — Conectar el subdominio en Cloudflare

1. En **Render → Settings → Custom Domains**, agrega `app.gtautocollisionpr.com`.
   Render te mostrará un destino **CNAME** (algo como `gt-auto-collision.onrender.com`).
2. En **Cloudflare → tu dominio → DNS → Add record:**
   - **Type:** `CNAME`
   - **Name:** `app`
   - **Target:** el destino que te dio Render
   - **Proxy status:** empieza en **DNS only** (nube gris) para que Render pueda emitir su
     certificado SSL. Cuando Render confirme el dominio, puedes cambiarlo a **Proxied**
     (nube naranja).
3. Si activas el proxy naranja, ve a **Cloudflare → SSL/TLS → Overview** y pon el modo en
   **Full (strict)**. (Nunca "Flexible": causa bucles de redirección.)
4. Espera unos minutos. Cuando Render diga "Certificate issued", entra a
   **https://app.gtautocollisionpr.com** — debe cargar con candado de seguridad.

---

## Parte C — Enlazar desde tu web

En tu web de Cloudflare, haz que el botón **"Solicitar estimado"** apunte a:

```
https://app.gtautocollisionpr.com
```

Para el cliente es el mismo negocio y el mismo dominio; solo cambia a la sección `app.`

---

## Parte D — Activar pagos (Stripe) — cuando el taller lo decida

1. Crea la cuenta de Stripe del negocio y empieza en **modo prueba**.
2. En Stripe, crea un **webhook** a
   `https://app.gtautocollisionpr.com/webhooks/stripe` con los eventos
   `checkout.session.completed` y `checkout.session.async_payment_succeeded`.
3. En Render, agrega las variables `STRIPE_SECRET_KEY` (empieza con `sk_test_...`) y
   `STRIPE_WEBHOOK_SECRET`.
4. En el panel → **Configuración**, escribe las condiciones reales del depósito.
5. Prueba el flujo completo con las tarjetas de prueba de Stripe.
6. Cuando todo funcione: cambia a la clave real `sk_live_...` y habilita los pagos reales.

---

## Copias de seguridad (importante)

La base de datos y las fotos viven en el disco de `/var/data`. Configura copias de
seguridad del disco en Render (o copia `/var/data` periódicamente). Si se pierde ese disco,
se pierden los expedientes y las fotos.

---

## Alternativas de hosting

Si prefieres otro proveedor, el app funciona igual en **Railway**, **Fly.io** o un **VPS**.
Lo único imprescindible es: Node 22.13+, disco persistente para `data/` y `storage/`, y las
mismas variables de entorno de la Parte A.
