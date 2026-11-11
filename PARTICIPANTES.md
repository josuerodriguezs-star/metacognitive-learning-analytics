# Recolector de conversaciones (conversaciones.yohual.com)

Una persona se registra con su correo, lee un consentimiento corto, pega el enlace de **una**
conversación compartida y ve cómo se lee. La lectura la hace **endurance**, tu laptop, cuando está
encendida; si está apagada, el enlace espera en una fila en Cloudflare y se avisa por correo al terminar.

La interfaz para profesores (formulario de actividad + `.zip` de Word) sigue en `frontend/profesores/` y
en `POST /generate` del backend FastAPI (`app.py`).

## Arquitectura

```
 navegador ──HTTPS──▶ Cloudflare Worker  (conversaciones.yohual.com)
                       · sirve la página y la API
                       · D1: correos, consentimiento y la FILA de enlaces
                       · nunca guarda texto de conversaciones
                            ▲
                            │ solo conexiones DE SALIDA desde endurance
                            │
 endurance (Docker, sin puertos publicados)
   ├─ recolector ──▶ jala la fila ──▶ abre chatgpt.com/share/… con Playwright
   │                                   quita correos y teléfonos
   └─ mongo (red interna, sin salida a internet) ◀── guarda la conversación
```

- **Qué se guarda dónde.** Cloudflare: correo, consentimiento y el enlace *mientras espera* (se borra al
  terminar). endurance: el texto de la conversación, anonimizado, con un identificador aleatorio de
  participante y sin correo.
- **Endurance no expone nada.** No escucha en ningún puerto. Habla hacia el Worker con un token propio
  (`PULLER_TOKEN`) y hacia chatgpt.com. Ver [`endurance/README.md`](endurance/README.md).
- **Si endurance está apagado.** La persona ve "Tu enlace quedó en fila" y recibe un correo cuando se lea.
  El Worker lo sabe por un latido que endurance manda cada 30 s.

## API del Worker

| Endpoint | Autenticación | Qué hace |
|---|---|---|
| `POST /api/registro` `{email}` | — | Envía un código de 6 dígitos. Responde igual exista o no el correo. |
| `POST /api/verificar` `{email, codigo}` | — | Devuelve un token firmado (2 h). Máx. 5 intentos por código. |
| `GET /api/sesion` | Bearer | Si ya aceptó la versión vigente del consentimiento. |
| `POST /api/consentimiento` `{version}` | Bearer | Guarda versión y fecha de aceptación. |
| `POST /api/enviar` `{enlace}` | Bearer | Valida el enlace y lo pone en la fila. |
| `GET /api/estado/:id` | Bearer | Fase, turnos y si endurance está en línea. |
| `POST /interno/pendientes`, `/latido`, `/fase`, `/resultado`, `/apagado` | `PULLER_TOKEN` | Solo para endurance. |

Protecciones: tokens firmados con HMAC, códigos guardados solo como hash, límites de frecuencia por IP y por
correo, validación estricta del enlace (solo `https://chatgpt.com/share/<id>`; se prueba en JS y en Python con
los mismos casos en `compartido/casos_enlaces.json`), comprobación de origen, política CSP estricta y bloqueo
de IP tras intentos fallidos del token de endurance.

## Publicar en Cloudflare

Desde `worker/`, en endurance o en cualquier equipo con Node 20+. Se hace una sola vez.

```bash
cd worker
npm install
npx wrangler login

# 1. Base de datos
npx wrangler d1 create yohual-conversaciones
#    Copia el "database_id" que imprime en worker/wrangler.toml (campo database_id).
npx wrangler d1 execute yohual-conversaciones --remote --file=schema.sql

# 2. Publicar (crea el dominio conversaciones.yohual.com y su certificado)
npx wrangler deploy

# 3. Secretos. Hasta que existan, la API responde "Servidor sin configurar".
openssl rand -hex 32 | npx wrangler secret put APP_SECRET
npx wrangler secret put RESEND_API_KEY
#    PULLER_TOKEN: lo genera endurance/instalar.sh (ver endurance/README.md)
```

**Correo (Resend).** En resend.com agrega el dominio `yohual.com`, copia los registros DNS que te da al panel
DNS de Cloudflare y espera a que diga "Verified". Sin eso, Resend solo puede escribir a tu propio correo.
El remitente es `MAIL_FROM` en `worker/wrangler.toml`.

**Correo de contacto.** El consentimiento pide escribir a `contacto@yohual.com` para borrar una conversación.
En Cloudflare: Email → Email Routing → crea esa dirección y reenvíala a tu correo.

**Cambiar el texto del consentimiento.** Edítalo en `frontend/index.html` y sube la versión en `data-version`
**y** en `VERSION_CONSENTIMIENTO` de `worker/wrangler.toml`. Quien aceptó la anterior lo verá otra vez.

## Probar en local

```bash
cd worker
cp .dev.vars.example .dev.vars
npx wrangler d1 execute yohual-conversaciones --local --file=schema.sql
npx wrangler dev          # http://127.0.0.1:8787; los códigos salen en la terminal
npm test                  # 37 pruebas del Worker

cd .. && python3 -m pytest   # 43 pruebas de Python (enlaces, recolector, /generate)
```

La interfaz sola, sin servidor: `frontend/index.html?demo`, `?demo=fila` o `?demo=error` desde cualquier
servidor estático (`python3 -m http.server` dentro de `frontend/`).

## Limitaciones declaradas

- **Nombres propios.** Se quitan correos y teléfonos, no nombres ni otros datos escritos en la conversación;
  el consentimiento lo dice. La limpieza de teléfonos reemplaza cualquier secuencia de 10 a 15 dígitos.
- **El correo vive en Cloudflare** (D1), separado del texto. Si prefieres que no salga de endurance, hay que
  rediseñar el registro; dímelo.
- **Solo ChatGPT.** Claude y Gemini necesitan sus propios extractores; la interfaz ya avisa que llegarán.
- **Sin endpoint de borrado.** El borrado que ofrece el consentimiento se hace a mano por `participante_id`.
- **Lectura sin supervisión.** El extractor depende de la estructura de la página de ChatGPT; si cambia,
  las lecturas fallarán con un mensaje claro a la persona y quedarán en el log de endurance.

## Acceso compartido entre sitios (conversaciones, calendario y simulador)

Una sola cuenta por correo para todos los sitios de yohual.com:

- **Registro único.** La persona verifica su correo una vez; el Worker deja la cookie `yh_sesion`
  (`Domain=.yohual.com`, `HttpOnly`, `Secure`, `SameSite=Lax`) y los demás sitios la usan llamando a
  `https://acceso.yohual.com/api/...` con `credentials: "include"`.
- **Consentimiento por servicio.** Cada servicio tiene su propio texto y versión (`CONSENTIMIENTOS`);
  aceptar uno no habilita los otros.
- **CORS.** Solo los orígenes de `ORIGENES_PERMITIDOS`. Las escrituras con cookie exigen cabecera `Origin`.
- **Envíos** (`POST /api/envios`, p. ej. la encuesta del simulador): esperan en D1 solo hasta que endurance
  los recoge; entonces se guardan en Mongo (`envios_<servicio>`) y la carga se borra de la nube.
  Si endurance está apagada, los envíos esperan hasta 60 días.
- **Suscripciones** (`GET/PUT /api/suscripciones/calendario`): las claves de eventos que la persona quiere
  seguir. Viven en D1 (no en endurance) para que las alertas puedan salir aunque endurance esté apagada.

Al actualizar: `npx wrangler d1 execute yohual-conversaciones --remote --file=schema.sql`,
`npx wrangler deploy`, y reconstruir el contenedor del recolector.
