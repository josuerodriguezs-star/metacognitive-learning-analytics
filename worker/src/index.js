// Worker de conversaciones.yohual.com
//
//   Participantes (desde el navegador):
//     POST /api/registro        {email}              envía el código
//     POST /api/verificar       {email, codigo}      devuelve un token (2 h)
//     GET  /api/sesion          (Bearer)             ¿ya aceptó el consentimiento vigente?
//     POST /api/consentimiento  {version}            guarda la aceptación
//     POST /api/enviar          {enlace}             pone el enlace en la fila
//     GET  /api/estado/:id      (Bearer)             fase, turnos y si endurance está en línea
//
//   Endurance (solo con PULLER_TOKEN; endurance llama hacia acá, nunca al revés):
//     POST /interno/pendientes  {max}                reclama enlaces y marca el latido
//     POST /interno/latido      {}                   sigue en línea (mientras lee algo largo)
//     POST /interno/fase        {id, fase, turnos?}  avance de la lectura
//     POST /interno/resultado   {id, ok, turnos?, error?}
//     POST /interno/apagado     {}                   marca endurance como fuera de línea
//
// Aquí nunca se guarda el texto de una conversación: solo correo,
// consentimiento y la fila de enlaces pendientes.

import {
  emitirToken, leerToken, normalizarEmail, hashEmail, generarCodigo, hashCodigo,
  iguales, sha256Hex, hostsPermitidos, validarEnlace,
} from "./seguridad.js";
import { enviarCorreo, mensajeCodigo, mensajeListo, mensajeError } from "./correo.js";

// ------------------------------------------------------------------
// Constantes
// ------------------------------------------------------------------

const CODIGO_VIGENCIA_SEG = 10 * 60;
const CODIGO_MAX_INTENTOS = 5;
const LATIDO_VIGENCIA_SEG = 120;       // endurance se considera en línea si avisó hace menos de esto
const RESERVA_VIGENCIA_SEG = 10 * 60;  // un trabajo "tomado" sin resultado vuelve a la fila
const AUSENCIA_PARA_AVISAR_SEG = 90;   // si la persona no consultó hace esto, se le avisa por correo
const MAX_ACTIVOS_POR_PERSONA = 3;
const FASES_VALIDAS = new Set(["abriendo", "leyendo", "procesando", "guardando"]);
const FASES_CON_TURNOS = new Set(["procesando", "guardando", "listo"]);

const MSG_SESION = "Tu sesión venció. Vuelve a ingresar tu correo.";
const MSG_CODIGO = "El código no es correcto o ya venció. Pide uno nuevo.";

const CABECERAS_JSON = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

class ErrorHttp extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

const ahora = () => Math.floor(Date.now() / 1000);

function json(datos, estado = 200) {
  return new Response(JSON.stringify(datos), { status: estado, headers: CABECERAS_JSON });
}

function config(env) {
  return {
    version: env.VERSION_CONSENTIMIENTO || "2026-11-v2",
    maxPorDia: parseInt(env.MAX_CONVERSACIONES_POR_DIA || "5", 10),
    urlPublica: env.PUBLIC_URL || "https://conversaciones.yohual.com",
  };
}

function ipDe(request) {
  return request.headers.get("cf-connecting-ip") || "desconocida";
}

async function leerJson(request, maxCaracteres = 8192) {
  const tipo = request.headers.get("content-type") || "";
  if (!tipo.includes("application/json")) throw new ErrorHttp(415, "Formato no admitido.");
  const texto = await request.text();
  if (texto.length > maxCaracteres) throw new ErrorHttp(413, "La petición es demasiado grande.");
  try {
    const datos = JSON.parse(texto);
    if (datos === null || typeof datos !== "object" || Array.isArray(datos)) throw new Error("forma");
    return datos;
  } catch {
    throw new ErrorHttp(400, "Petición no válida.");
  }
}

/** Ventana fija: devuelve true si todavía hay cupo. */
async function permitir(env, clave, maximo, ventanaSeg) {
  const ventana = Math.floor(ahora() / ventanaSeg);
  const expira = (ventana + 1) * ventanaSeg;
  const fila = await env.DB.prepare(
    `INSERT INTO limites (clave, ventana, n, expira_ts) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (clave, ventana) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(clave, ventana, expira).first();
  return fila.n <= maximo;
}

async function participanteActual(request, env) {
  const cabecera = request.headers.get("authorization") || "";
  if (!/^bearer /i.test(cabecera)) throw new ErrorHttp(401, MSG_SESION);
  const pid = await leerToken(env.APP_SECRET, cabecera.slice(7).trim());
  if (!pid) throw new ErrorHttp(401, MSG_SESION);
  return pid;
}

async function servidorEnLinea(env) {
  const fila = await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'latido'").first();
  return Boolean(fila) && ahora() - Number(fila.valor) < LATIDO_VIGENCIA_SEG;
}

// ------------------------------------------------------------------
// Registro y verificación
// ------------------------------------------------------------------

async function registro(request, env) {
  const { email: bruto } = await leerJson(request);
  const email = normalizarEmail(bruto);
  if (!email) throw new ErrorHttp(400, "Escribe un correo válido, por ejemplo nombre@correo.com.");

  const emailHash = await hashEmail(env.APP_SECRET, email);
  const cupoIp = await permitir(env, `reg:ip:${ipDe(request)}`, 10, 900);
  const cupoCorreo = await permitir(env, `reg:mail:${emailHash}`, 3, 900);
  if (!cupoIp || !cupoCorreo) {
    throw new ErrorHttp(429, "Ya enviamos varios códigos. Espera unos minutos y vuelve a intentarlo.");
  }

  const codigo = generarCodigo();
  await env.DB.prepare(
    `INSERT INTO codigos (email_hash, codigo_hash, expira_ts, intentos) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (email_hash) DO UPDATE SET codigo_hash = ?2, expira_ts = ?3, intentos = 0`
  ).bind(emailHash, await hashCodigo(env.APP_SECRET, emailHash, codigo), ahora() + CODIGO_VIGENCIA_SEG).run();

  try {
    await enviarCorreo(env, { para: email, ...mensajeCodigo(codigo) });
  } catch (e) {
    console.error("Fallo al enviar el código:", e.message);
    throw new ErrorHttp(502, "No pudimos enviar el correo en este momento. Inténtalo de nuevo en unos minutos.");
  }

  // La respuesta es la misma exista o no el correo.
  return json({ enviado: true });
}

async function verificar(request, env) {
  if (!(await permitir(env, `ver:ip:${ipDe(request)}`, 30, 900))) {
    throw new ErrorHttp(429, "Demasiados intentos. Espera unos minutos.");
  }

  const datos = await leerJson(request);
  const email = normalizarEmail(datos.email);
  const codigo = String(datos.codigo || "").replace(/\s/g, "");
  if (!email || !/^\d{6}$/.test(codigo)) throw new ErrorHttp(400, "Escribe los 6 dígitos del código.");

  const emailHash = await hashEmail(env.APP_SECRET, email);

  // Sube el contador y lee el código en una sola sentencia: sin carreras entre intentos.
  const fila = await env.DB.prepare(
    "UPDATE codigos SET intentos = intentos + 1 WHERE email_hash = ?1 RETURNING codigo_hash, expira_ts, intentos"
  ).bind(emailHash).first();

  if (!fila || fila.expira_ts < ahora()) throw new ErrorHttp(400, MSG_CODIGO);
  if (fila.intentos > CODIGO_MAX_INTENTOS) {
    await env.DB.prepare("DELETE FROM codigos WHERE email_hash = ?1").bind(emailHash).run();
    throw new ErrorHttp(400, MSG_CODIGO);
  }
  if (!iguales(await hashCodigo(env.APP_SECRET, emailHash, codigo), fila.codigo_hash)) {
    throw new ErrorHttp(400, MSG_CODIGO);
  }

  // Un código se usa una sola vez.
  const borrado = await env.DB.prepare("DELETE FROM codigos WHERE email_hash = ?1").bind(emailHash).run();
  if (borrado.meta.changes !== 1) throw new ErrorHttp(400, MSG_CODIGO);

  await env.DB.prepare(
    "INSERT OR IGNORE INTO participantes (id, email, email_hash, creado_ts) VALUES (?1, ?2, ?3, ?4)"
  ).bind(crypto.randomUUID().replaceAll("-", ""), email, emailHash, ahora()).run();
  const persona = await env.DB.prepare("SELECT id FROM participantes WHERE email_hash = ?1").bind(emailHash).first();

  return json({ token: await emitirToken(env.APP_SECRET, persona.id) });
}

// ------------------------------------------------------------------
// Sesión y consentimiento
// ------------------------------------------------------------------

async function sesion(request, env) {
  const pid = await participanteActual(request, env);
  const persona = await env.DB.prepare(
    "SELECT consentimiento_version FROM participantes WHERE id = ?1"
  ).bind(pid).first();
  if (!persona) throw new ErrorHttp(401, MSG_SESION);
  const { version } = config(env);
  return json({ consentimiento: persona.consentimiento_version === version, version_consentimiento: version });
}

async function consentimiento(request, env) {
  const pid = await participanteActual(request, env);
  const { version: pedida } = await leerJson(request);
  const { version } = config(env);
  if (pedida !== version) {
    throw new ErrorHttp(409, "El texto de consentimiento cambió. Recarga la página para leer la versión vigente.");
  }
  const r = await env.DB.prepare(
    "UPDATE participantes SET consentimiento_version = ?2, consentimiento_ts = ?3 WHERE id = ?1"
  ).bind(pid, version, ahora()).run();
  if (r.meta.changes !== 1) throw new ErrorHttp(401, MSG_SESION);
  return json({ consentimiento: true });
}

// ------------------------------------------------------------------
// Enviar y consultar
// ------------------------------------------------------------------

async function enviar(request, env) {
  if (!(await permitir(env, `env:ip:${ipDe(request)}`, 20, 3600))) {
    throw new ErrorHttp(429, "Demasiados envíos desde esta conexión. Espera un rato.");
  }
  const pid = await participanteActual(request, env);
  const { version, maxPorDia } = config(env);

  const persona = await env.DB.prepare(
    "SELECT consentimiento_version FROM participantes WHERE id = ?1"
  ).bind(pid).first();
  if (!persona) throw new ErrorHttp(401, MSG_SESION);
  if (persona.consentimiento_version !== version) {
    throw new ErrorHttp(403, "Antes de enviar tu conversación necesitamos tu consentimiento.");
  }

  const { enlace: bruto } = await leerJson(request);
  const { enlace, plataforma, error } = validarEnlace(bruto, hostsPermitidos(env));
  if (error) throw new ErrorHttp(400, error);

  const hoy = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM trabajos WHERE participante_id = ?1 AND creado_ts >= ?2 AND estado <> 'error'"
  ).bind(pid, ahora() - 86400).first();
  if (hoy.n >= maxPorDia) {
    throw new ErrorHttp(429, "Ya enviaste varias conversaciones hoy. Puedes seguir mañana.");
  }

  const activos = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM trabajos WHERE participante_id = ?1 AND estado IN ('en_cola', 'tomado')"
  ).bind(pid).first();
  if (activos.n >= MAX_ACTIVOS_POR_PERSONA) {
    throw new ErrorHttp(409, "Todavía tienes conversaciones en fila. Espera a que las leamos para enviar más.");
  }

  const id = crypto.randomUUID().replaceAll("-", "");
  try {
    await env.DB.prepare(
      `INSERT INTO trabajos (id, participante_id, enlace, enlace_hash, plataforma, version_consentimiento, creado_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(id, pid, enlace, await sha256Hex(enlace), plataforma || "ChatGPT", version, ahora()).run();
  } catch (e) {
    if (String(e && e.message).includes("UNIQUE constraint failed")) {
      throw new ErrorHttp(409, "Ya recibimos esa conversación. Gracias.");
    }
    throw e;
  }

  return json({ job_id: id, plataforma, servidor_en_linea: await servidorEnLinea(env) });
}

async function estado(request, env, id) {
  const pid = await participanteActual(request, env);
  const t = await env.DB.prepare(
    "SELECT fase, turnos, error FROM trabajos WHERE id = ?1 AND participante_id = ?2"
  ).bind(id, pid).first();
  if (!t) throw new ErrorHttp(404, "No encontramos ese envío.");

  await env.DB.prepare("UPDATE trabajos SET ultima_consulta_ts = ?2 WHERE id = ?1").bind(id, ahora()).run();

  let turnos = [];
  if (FASES_CON_TURNOS.has(t.fase) && t.turnos) {
    try { turnos = JSON.parse(t.turnos); } catch { turnos = []; }
  }
  return json({ fase: t.fase, turnos, error: t.error || null, servidor_en_linea: await servidorEnLinea(env) });
}

// ------------------------------------------------------------------
// Endpoints internos (endurance)
// ------------------------------------------------------------------

async function autenticarEndurance(request, env) {
  const cabecera = request.headers.get("authorization") || "";
  const token = /^bearer /i.test(cabecera) ? cabecera.slice(7).trim() : "";
  if (token && iguales(token, env.PULLER_TOKEN)) return;

  // Token incorrecto: se cuenta el fallo y, pasado cierto número, se bloquea esa IP un rato.
  const cupo = await permitir(env, `interno:fallo:${ipDe(request)}`, 10, 600);
  throw cupo ? new ErrorHttp(401, "No autorizado.") : new ErrorHttp(429, "Demasiados intentos.");
}

function validarRoles(valor) {
  if (valor === undefined) return null;
  if (!Array.isArray(valor) || valor.length > 3000 || !valor.every((r) => r === "user" || r === "assistant")) {
    throw new ErrorHttp(400, "Lista de turnos no válida.");
  }
  return valor;
}

async function marcarLatido(env, n) {
  await env.DB.prepare(
    "INSERT INTO meta (clave, valor) VALUES ('latido', ?1) ON CONFLICT (clave) DO UPDATE SET valor = ?1"
  ).bind(String(n)).run();
}

/** Endurance avisa que sigue en línea mientras lee una conversación larga. */
async function internoLatido(request, env) {
  await marcarLatido(env, ahora());
  return json({ ok: true });
}

async function internoPendientes(request, env) {
  const { max } = await leerJson(request);
  const cantidad = Math.min(Math.max(parseInt(max, 10) || 1, 1), 5);
  const n = ahora();

  await marcarLatido(env, n);

  // Lo que se tomó hace demasiado y nunca se reportó vuelve a la fila.
  await env.DB.prepare(
    "UPDATE trabajos SET estado = 'en_cola', fase = 'en_cola', tomado_ts = NULL WHERE estado = 'tomado' AND tomado_ts < ?1"
  ).bind(n - RESERVA_VIGENCIA_SEG).run();

  const { results } = await env.DB.prepare(
    `UPDATE trabajos SET estado = 'tomado', tomado_ts = ?1
     WHERE id IN (SELECT id FROM trabajos WHERE estado = 'en_cola' ORDER BY creado_ts LIMIT ?2)
     RETURNING id, participante_id, enlace, plataforma, version_consentimiento, creado_ts`
  ).bind(n, cantidad).all();

  return json({ trabajos: results });
}

async function internoFase(request, env) {
  const datos = await leerJson(request, 65536);
  if (typeof datos.id !== "string" || !FASES_VALIDAS.has(datos.fase)) throw new ErrorHttp(400, "Fase no válida.");
  const roles = validarRoles(datos.turnos);
  await env.DB.prepare(
    "UPDATE trabajos SET fase = ?2, turnos = COALESCE(?3, turnos) WHERE id = ?1 AND estado = 'tomado'"
  ).bind(datos.id, datos.fase, roles ? JSON.stringify(roles) : null).run();
  return json({ ok: true });
}

async function internoResultado(request, env, ctx) {
  const datos = await leerJson(request, 65536);
  if (typeof datos.id !== "string") throw new ErrorHttp(400, "Identificador no válido.");
  const roles = validarRoles(datos.turnos);
  const ok = datos.ok === true;
  const motivo = ok ? null : String(datos.error || "No pudimos leer esa conversación.").slice(0, 300);
  const n = ahora();

  // Se borra el enlace: ya no hace falta y no debe quedarse en la nube.
  const r = await env.DB.prepare(
    `UPDATE trabajos
     SET estado = ?2, fase = ?2, turnos = ?3, error = ?4, enlace = NULL, terminado_ts = ?5
     WHERE id = ?1 AND estado = 'tomado'`
  ).bind(datos.id, ok ? "listo" : "error", ok ? JSON.stringify(roles || []) : null, motivo, n).run();

  if (r.meta.changes === 1) await avisarSiSeFue(env, ctx, datos.id, ok, motivo, n);
  return json({ ok: true });
}

/** Si la persona ya no está mirando la pantalla, se le avisa por correo. */
async function avisarSiSeFue(env, ctx, id, ok, motivo, n) {
  const t = await env.DB.prepare(
    `SELECT t.ultima_consulta_ts, p.email
     FROM trabajos t JOIN participantes p ON p.id = t.participante_id WHERE t.id = ?1`
  ).bind(id).first();
  if (!t) return;
  if (t.ultima_consulta_ts && n - t.ultima_consulta_ts < AUSENCIA_PARA_AVISAR_SEG) return;

  const { urlPublica } = config(env);
  const mensaje = ok ? mensajeListo(urlPublica) : mensajeError(urlPublica, motivo);
  const envio = enviarCorreo(env, { para: t.email, ...mensaje })
    .then(() => env.DB.prepare("UPDATE trabajos SET avisado = 1 WHERE id = ?1").bind(id).run())
    .catch((e) => console.error("Fallo al avisar por correo:", e.message));
  ctx.waitUntil(envio);
}

async function internoApagado(request, env) {
  await env.DB.prepare("DELETE FROM meta WHERE clave = 'latido'").run();
  return json({ ok: true });
}

// ------------------------------------------------------------------
// Limpieza programada
// ------------------------------------------------------------------

export async function limpiar(env) {
  const n = ahora();
  const dia = 86400;
  await env.DB.prepare("DELETE FROM codigos WHERE expira_ts < ?1").bind(n).run();
  await env.DB.prepare("DELETE FROM limites WHERE expira_ts < ?1").bind(n).run();
  // Enlaces que nadie leyó en 30 días: se descartan y se borra el enlace.
  await env.DB.prepare(
    `UPDATE trabajos SET estado = 'error', fase = 'error', enlace = NULL, terminado_ts = ?1,
       error = 'El enlace venció antes de que pudiéramos leerlo.'
     WHERE estado IN ('en_cola', 'tomado') AND creado_ts < ?2`
  ).bind(n, n - 30 * dia).run();
  await env.DB.prepare(
    "DELETE FROM trabajos WHERE estado IN ('listo', 'error') AND terminado_ts < ?1"
  ).bind(n - 60 * dia).run();
}

// ------------------------------------------------------------------
// Enrutamiento
// ------------------------------------------------------------------

async function manejar(request, env, ctx, url) {
  const { pathname } = url;
  const metodo = request.method;

  if (pathname.startsWith("/interno/")) {
    if (!env.PULLER_TOKEN || env.PULLER_TOKEN.length < 32) {
      console.error("PULLER_TOKEN no está definido o es demasiado corto.");
      throw new ErrorHttp(500, "Servidor sin configurar.");
    }
    if (metodo !== "POST") throw new ErrorHttp(405, "Método no permitido.");
    await autenticarEndurance(request, env);
    if (pathname === "/interno/pendientes") return internoPendientes(request, env);
    if (pathname === "/interno/latido") return internoLatido(request, env);
    if (pathname === "/interno/fase") return internoFase(request, env);
    if (pathname === "/interno/resultado") return internoResultado(request, env, ctx);
    if (pathname === "/interno/apagado") return internoApagado(request, env);
    throw new ErrorHttp(404, "No encontrado.");
  }

  if (!env.APP_SECRET || env.APP_SECRET.length < 32) {
    console.error("APP_SECRET no está definido o es demasiado corto.");
    throw new ErrorHttp(500, "Servidor sin configurar.");
  }

  // Si el navegador declara un origen, debe ser este mismo sitio.
  const origen = request.headers.get("origin");
  if (origen && origen !== url.origin) throw new ErrorHttp(403, "Origen no permitido.");

  if (metodo === "POST" && pathname === "/api/registro") return registro(request, env);
  if (metodo === "POST" && pathname === "/api/verificar") return verificar(request, env);
  if (metodo === "GET" && pathname === "/api/sesion") return sesion(request, env);
  if (metodo === "POST" && pathname === "/api/consentimiento") return consentimiento(request, env);
  if (metodo === "POST" && pathname === "/api/enviar") return enviar(request, env);
  const m = /^\/api\/estado\/([A-Za-z0-9]{1,64})$/.exec(pathname);
  if (metodo === "GET" && m) return estado(request, env, m[1]);

  throw new ErrorHttp(404, "No encontrado.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/interno/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await manejar(request, env, ctx, url);
    } catch (e) {
      if (e instanceof ErrorHttp) return json({ detail: e.message }, e.estado);
      console.error("Error inesperado:", e && e.stack ? e.stack : e);
      return json({ detail: "Algo salió mal de nuestro lado. Inténtalo de nuevo en unos minutos." }, 500);
    }
  },

  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(limpiar(env));
  },
};
