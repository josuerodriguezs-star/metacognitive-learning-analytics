# Frontend

Sitio estático (HTML/CSS/JS, sin frameworks ni build). Dos interfaces:

```
frontend/
  index.html       → recolector para participantes (correo, consentimiento, enlace, lectura, gracias)
  style.css        → diseño
  script.js        → lógica y modo demostración
  config.js        → enlace de inicio, correo de contacto e invitaciones de la pantalla final
  _headers         → cabeceras de seguridad (CSP estricta, HSTS, etc.)
  .assetsignore    → lo que el Worker NO publica (profesores/, README, vercel.json)
  fonts/           → Spectral y Hanken Grotesk, servidas desde el propio sitio (licencias OFL incluidas)
  profesores/      → formulario original para profesores (actividad + alumnos → .zip de Word)
```

`index.html` lo sirve el Worker de Cloudflare desde el mismo origen que la API
(ver [`../PARTICIPANTES.md`](../PARTICIPANTES.md)), así que no hay CORS ni URL de API que configurar.
La política de seguridad no permite scripts ni estilos en línea: todo va en `script.js` y `style.css`.

## Verlo sin servidor

```bash
cd frontend
python3 -m http.server 8000
# http://localhost:8000/?demo         recorrido completo
# http://localhost:8000/?demo=fila    servidor apagado: "tu enlace quedó en fila"
# http://localhost:8000/?demo=error   fallo de lectura
```

## Formulario de profesores

Vive en `profesores/` con sus propios `config.js`, `script.js` y `style.css`, y usa el backend FastAPI
(`POST /generate`). No se publica desde el Worker. Antes de usarlo, edita `profesores/config.js` con la URL de
ese backend y despliégalo como siempre (por ejemplo, en Vercel con *Root Directory* = `frontend/profesores`).
