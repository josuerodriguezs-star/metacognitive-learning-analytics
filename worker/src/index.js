// Worker de acceso de yohual.com (conversaciones, calendario y simulador).
//
//   Una persona se verifica una sola vez con su correo y elige, servicio por
//   servicio, a qué da su consentimiento. La sesión viaja como token Bearer o
//   como cookie (yh_sesion, válida en todo .yohual.com).
//
//   Personas (desde el navegador):
//     POST /api/registro        {email}              envía el código
//     POST /api/verificar       {email, codigo}      devuelve un token (2 h) y pone la cookie
//     POST /api/salir                                 borra la cookie
//     GET  /api/sesion?servicio=...                   correo y si aceptó el consentimiento vigente
//     POST /api/consentimiento  {version, servicio?}  guarda la aceptación de un servicio
//     POST /api/enviar          {enlace}             pone el enlace de conversación en la fila
//     GET  /api/estado/:id                            fase, turnos y si endurance está en línea
//     POST /api/envios          {servicio, tipo, carga, id_cliente?}  encuesta hacia endurance
//     GET  /api/suscripciones/:servicio               claves que la persona sigue
//     PUT  /api/suscripciones/:servicio {claves}      reemplaza esas claves
//
//   Endurance (solo con PULLER_TOKEN; endurance llama hacia acá, nunca al revés):
//     POST /interno/pendientes  {max}                reclama enlaces y marca el latido
//     POST /interno/latido      {}                   sigue en línea (mientras lee algo largo)
//     POST /interno/fase        {id, fase, turnos?}  avance de la lectura
//     POST /interno/resultado   {id, ok, turnos?, error?}
//     POST /interno/apagado     {}                   marca endurance como fuera de línea
//     POST /interno/envios/pendientes {max}          reclama envíos (encuestas)
//     POST /interno/envios/resultado  {id, ok, error?}  confirma y borra la carga de la nube
//
// Aquí nunca se guarda el texto de una conversación: solo correo,
// consentimientos, suscripciones y la fila de pendientes (enlaces y envíos),
// que se borran en cuanto endurance los recoge.

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
const SESION_VIGENCIA_SEG = 2 * 60 * 60;
const COOKIE_SESION = "yh_sesion";
const SERVICIOS = new Set(["conversaciones", "calendario", "simulador"]);
const TIPOS_DE_ENVIO = { simulador: new Set(["encuesta"]) };
const SERVICIOS_CON_SUSCRIPCION = new Set(["calendario"]);
const MAX_CARGA_ENVIO = 32768;          // caracteres del JSON de una encuesta
const MAX_ENVIOS_POR_DIA = 20;
const MAX_CLAVES_SUSCRIPCION = 50;
const RE_CLAVE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RE_ID_CLIENTE = /^[A-Za-z0-9_-]{8,64}$/;
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

const VERSIONES_POR_DEFECTO = { conversaciones: "2026-11-v2", calendario: "2026-11-v1", simulador: "2026-11-v1" };

function config(env) {
  let versiones = { ...VERSIONES_POR_DEFECTO };
  if (env.VERSION_CONSENTIMIENTO) versiones.conversaciones = env.VERSION_CONSENTIMIENTO;
  if (env.CONSENTIMIENTOS) {
    try { versiones = { ...versiones, ...JSON.parse(env.CONSENTIMIENTOS) }; } catch { /* se ignora */ }
  }
  return {
    version: versiones.conversaciones,
    versiones,
    maxPorDia: parseInt(env.MAX_CONVERSACIONES_POR_DIA || "5", 10),
    urlPublica: env.PUBLIC_URL || "https://conversaciones.yohual.com",
    cookieDominio: env.COOKIE_DOMINIO || "",
  };
}

/** Orígenes que pueden llamar a la API con credenciales: este mismo sitio y los de la lista. */
function origenesPermitidos(env, url) {
  const lista = String(env.ORIGENES_PERMITIDOS || "").split(",").map((o) => o.trim()).filter(Boolean);
  return new Set([url.origin, ...lista]);
}

function servicioDe(valor, porDefecto = null) {
  const servicio = valor === undefined || valor === null || valor === "" ? porDefecto : String(valor);
  if (!servicio || !SERVICIOS.has(servicio)) throw new ErrorHttp(400, "Servicio no válido.");
  return servicio;
}

function leerCookie(request, nombre) {
  for (const trozo of (request.headers.get("cookie") || "").split(";")) {
    const i = trozo.indexOf("=");
    if (i > 0 && trozo.slice(0, i).trim() === nombre) return trozo.slice(i + 1).trim();
  }
  return null;
}

function cookieSesion(env, token, vigenciaSeg) {
  const { cookieDominio } = config(env);
  const partes = [`${COOKIE_SESION}=${token}`, "Path=/", `Max-Age=${vigenciaSeg}`, "HttpOnly", "Secure", "SameSite=Lax"];
  if (cookieDominio) partes.push(`Domain=${cookieDominio}`);
  return partes.join("; ");
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
  if (/^bearer /i.test(cabecera)) {
    const pid = await leerToken(env.APP_SECRET, cabecera.slice(7).trim());
    if (!pid) throw new ErrorHttp(401, MSG_SESION);
    return pid;
  }

  // Sesión por cookie. El navegador la manda sola, así que en toda petición que
  // cambia algo se exige un origen declarado y permitido (ya validado en `manejar`).
  const token = leerCookie(request, COOKIE_SESION);
  if (!token) throw new ErrorHttp(401, MSG_SESION);
  if (request.method !== "GET" && request.method !== "HEAD" && !request.headers.get("origin")) {
    throw new ErrorHttp(403, "Origen no permitido.");
  }
  const pid = await leerToken(env.APP_SECRET, token);
  if (!pid) throw new ErrorHttp(401, MSG_SESION);
  return pid;
}

async function consentimientoVigente(env, pid, servicio) {
  const { versiones } = config(env);
  const fila = await env.DB.prepare(
    "SELECT version FROM consentimientos WHERE participante_id = ?1 AND servicio = ?2"
  ).bind(pid, servicio).first();
  return Boolean(fila) && fila.version === versiones[servicio];
}

async function exigirConsentimiento(env, pid, servicio, mensaje) {
  if (!(await consentimientoVigente(env, pid, servicio))) throw new ErrorHttp(403, mensaje);
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

  const token = await emitirToken(env.APP_SECRET, persona.id);
  const respuesta = json({ token });
  respuesta.headers.append("set-cookie", cookieSesion(env, token, SESION_VIGENCIA_SEG));
  return respuesta;
}

async function salir(request, env) {
  const respuesta = json({ ok: true });
  respuesta.headers.append("set-cookie", cookieSesion(env, "", 0));
  return respuesta;
}

// ------------------------------------------------------------------
// Sesión y consentimiento
// ------------------------------------------------------------------

async function sesion(request, env, url) {
  const pid = await participanteActual(request, env);
  const servicio = servicioDe(url.searchParams.get("servicio"), "conversaciones");
  const persona = await env.DB.prepare("SELECT email FROM participantes WHERE id = ?1").bind(pid).first();
  if (!persona) throw new ErrorHttp(401, MSG_SESION);
  const { versiones } = config(env);
  return json({
    email: persona.email,
    servicio,
    consentimiento: await consentimientoVigente(env, pid, servicio),
    version_consentimiento: versiones[servicio],
  });
}

async function consentimiento(request, env) {
  const pid = await participanteActual(request, env);
  const datos = await leerJson(request);
  const servicio = servicioDe(datos.servicio, "conversaciones");
  const { versiones } = config(env);
  if (datos.version !== versiones[servicio]) {
    throw new ErrorHttp(409, "El texto de consentimiento cambió. Recarga la página para leer la versión vigente.");
  }
  const existe = await env.DB.prepare("SELECT 1 AS x FROM participantes WHERE id = ?1").bind(pid).first();
  if (!existe) throw new ErrorHttp(401, MSG_SESION);
  await env.DB.prepare(
    `INSERT INTO consentimientos (participante_id, servicio, version, ts) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (participante_id, servicio) DO UPDATE SET version = ?3, ts = ?4`
  ).bind(pid, servicio, versiones[servicio], ahora()).run();
  return json({ consentimiento: true, servicio });
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

  await exigirConsentimiento(env, pid, "conversaciones", "Antes de enviar tu conversación necesitamos tu consentimiento.");

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
// Envíos (encuestas) y suscripciones
// ------------------------------------------------------------------

/** Una encuesta u otro envío: espera aquí solo hasta que endurance lo recoge. */
async function crearEnvio(request, env) {
  if (!(await permitir(env, `envio:ip:${ipDe(request)}`, 30, 3600))) {
    throw new ErrorHttp(429, "Demasiados envíos desde esta conexión. Espera un rato.");
  }
  const pid = await participanteActual(request, env);
  const datos = await leerJson(request, MAX_CARGA_ENVIO + 2048);

  const servicio = servicioDe(datos.servicio);
  const tipos = TIPOS_DE_ENVIO[servicio];
  if (!tipos || !tipos.has(datos.tipo)) throw new ErrorHttp(400, "Tipo de envío no válido.");
  if (datos.carga === null || typeof datos.carga !== "object" || Array.isArray(datos.carga)) {
    throw new ErrorHttp(400, "El envío no tiene el formato esperado.");
  }
  const carga = JSON.stringify(datos.carga);
  if (carga.length > MAX_CARGA_ENVIO) throw new ErrorHttp(413, "El envío es demasiado grande.");

  let idCliente = null;
  if (datos.id_cliente !== undefined) {
    if (typeof datos.id_cliente !== "string" || !RE_ID_CLIENTE.test(datos.id_cliente)) {
      throw new ErrorHttp(400, "Identificador no válido.");
    }
    idCliente = datos.id_cliente;
  }

  await exigirConsentimiento(env, pid, servicio, "Antes de enviar necesitamos tu consentimiento.");
  const { versiones } = config(env);

  // Reintento del mismo envío (por ejemplo, por mala conexión): se responde lo mismo.
  if (idCliente) {
    const previo = await env.DB.prepare(
      "SELECT id FROM envios WHERE participante_id = ?1 AND servicio = ?2 AND id_cliente = ?3"
    ).bind(pid, servicio, idCliente).first();
    if (previo) return json({ id: previo.id, repetido: true });
  }

  const hoy = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM envios WHERE participante_id = ?1 AND servicio = ?2 AND creado_ts >= ?3"
  ).bind(pid, servicio, ahora() - 86400).first();
  if (hoy.n >= MAX_ENVIOS_POR_DIA) throw new ErrorHttp(429, "Ya enviaste varias veces hoy. Puedes seguir mañana.");

  const id = crypto.randomUUID().replaceAll("-", "");
  try {
    await env.DB.prepare(
      `INSERT INTO envios (id, participante_id, servicio, tipo, carga, id_cliente, version_consentimiento, creado_ts)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(id, pid, servicio, datos.tipo, carga, idCliente, versiones[servicio], ahora()).run();
  } catch (e) {
    if (idCliente && String(e && e.message).includes("UNIQUE constraint failed")) {
      const previo = await env.DB.prepare(
        "SELECT id FROM envios WHERE participante_id = ?1 AND servicio = ?2 AND id_cliente = ?3"
      ).bind(pid, servicio, idCliente).first();
      if (previo) return json({ id: previo.id, repetido: true });
    }
    throw e;
  }
  return json({ id, servidor_en_linea: await servidorEnLinea(env) }, 201);
}

function suscribible(servicio) {
  if (!SERVICIOS_CON_SUSCRIPCION.has(servicio)) throw new ErrorHttp(404, "No encontrado.");
  return servicio;
}

async function leerSuscripciones(request, env, servicio) {
  const pid = await participanteActual(request, env);
  suscribible(servicio);
  const { results } = await env.DB.prepare(
    "SELECT clave FROM suscripciones WHERE participante_id = ?1 AND servicio = ?2 ORDER BY clave"
  ).bind(pid, servicio).all();
  return json({ servicio, claves: results.map((f) => f.clave) });
}

async function guardarSuscripciones(request, env, servicio) {
  const pid = await participanteActual(request, env);
  suscribible(servicio);
  const { claves } = await leerJson(request);
  if (!Array.isArray(claves) || claves.length > MAX_CLAVES_SUSCRIPCION
      || !claves.every((c) => typeof c === "string" && RE_CLAVE.test(c))) {
    throw new ErrorHttp(400, "La lista de seguimientos no es válida.");
  }
  await exigirConsentimiento(env, pid, servicio, "Antes de suscribirte necesitamos tu consentimiento.");

  const unicas = [...new Set(claves)];
  const n = ahora();
  for (const clave of unicas) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO suscripciones (participante_id, servicio, clave, creado_ts) VALUES (?1, ?2, ?3, ?4)"
    ).bind(pid, servicio, clave, n).run();
  }
  const marcas = unicas.map((_, i) => `?${i + 3}`).join(", ");
  await env.DB.prepare(
    unicas.length
      ? `DELETE FROM suscripciones WHERE participante_id = ?1 AND servicio = ?2 AND clave NOT IN (${marcas})`
      : "DELETE FROM suscripciones WHERE participante_id = ?1 AND servicio = ?2"
  ).bind(pid, servicio, ...unicas).run();
  return json({ servicio, claves: unicas.sort() });
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

async function internoEnviosPendientes(request, env) {
  const { max } = await leerJson(request);
  const cantidad = Math.min(Math.max(parseInt(max, 10) || 1, 1), 10);
  const n = ahora();

  await marcarLatido(env, n);
  await env.DB.prepare(
    "UPDATE envios SET estado = 'en_cola', tomado_ts = NULL WHERE estado = 'tomado' AND tomado_ts < ?1"
  ).bind(n - RESERVA_VIGENCIA_SEG).run();

  const { results } = await env.DB.prepare(
    `UPDATE envios SET estado = 'tomado', tomado_ts = ?1
     WHERE id IN (SELECT id FROM envios WHERE estado = 'en_cola' ORDER BY creado_ts LIMIT ?2)
     RETURNING id, participante_id, servicio, tipo, carga, version_consentimiento, creado_ts`
  ).bind(n, cantidad).all();

  return json({
    envios: results.map((f) => {
      let carga = null;
      try { carga = JSON.parse(f.carga); } catch { /* carga ilegible: llega como null */ }
      return { ...f, carga };
    }),
  });
}

/** Endurance ya guardó el envío: la carga se borra de la nube. */
async function internoEnviosResultado(request, env) {
  const datos = await leerJson(request);
  if (typeof datos.id !== "string") throw new ErrorHttp(400, "Identificador no válido.");
  const ok = datos.ok === true;
  const motivo = ok ? null : String(datos.error || "No se pudo guardar el envío.").slice(0, 300);
  await env.DB.prepare(
    `UPDATE envios SET estado = ?2, carga = NULL, error = ?3, terminado_ts = ?4
     WHERE id = ?1 AND estado = 'tomado'`
  ).bind(datos.id, ok ? "listo" : "error", motivo, ahora()).run();
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
  // Envíos: los pendientes esperan hasta 60 días a endurance; los terminados se olvidan a los 30.
  await env.DB.prepare(
    `UPDATE envios SET estado = 'error', carga = NULL, terminado_ts = ?1,
       error = 'El envío venció antes de que pudiéramos guardarlo.'
     WHERE estado IN ('en_cola', 'tomado') AND creado_ts < ?2`
  ).bind(n, n - 60 * dia).run();
  await env.DB.prepare(
    "DELETE FROM envios WHERE estado IN ('listo', 'error') AND terminado_ts < ?1"
  ).bind(n - 30 * dia).run();
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
    if (pathname === "/interno/envios/pendientes") return internoEnviosPendientes(request, env);
    if (pathname === "/interno/envios/resultado") return internoEnviosResultado(request, env);
    throw new ErrorHttp(404, "No encontrado.");
  }

  if (!env.APP_SECRET || env.APP_SECRET.length < 32) {
    console.error("APP_SECRET no está definido o es demasiado corto.");
    throw new ErrorHttp(500, "Servidor sin configurar.");
  }

  // Si el navegador declara un origen, debe ser este sitio o uno de la lista permitida.
  const origen = request.headers.get("origin");
  if (origen && !origenesPermitidos(env, url).has(origen)) throw new ErrorHttp(403, "Origen no permitido.");

  if (metodo === "POST" && pathname === "/api/registro") return registro(request, env);
  if (metodo === "POST" && pathname === "/api/verificar") return verificar(request, env);
  if (metodo === "POST" && pathname === "/api/salir") return salir(request, env);
  if (metodo === "GET" && pathname === "/api/sesion") return sesion(request, env, url);
  if (metodo === "POST" && pathname === "/api/consentimiento") return consentimiento(request, env);
  if (metodo === "POST" && pathname === "/api/enviar") return enviar(request, env);
  if (metodo === "POST" && pathname === "/api/envios") return crearEnvio(request, env);
  const m = /^\/api\/estado\/([A-Za-z0-9]{1,64})$/.exec(pathname);
  if (metodo === "GET" && m) return estado(request, env, m[1]);
  const sus = /^\/api\/suscripciones\/([a-z]{1,32})$/.exec(pathname);
  if (sus && metodo === "GET") return leerSuscripciones(request, env, sus[1]);
  if (sus && metodo === "PUT") return guardarSuscripciones(request, env, sus[1]);

  throw new ErrorHttp(404, "No encontrado.");
}

/** Cabeceras para que otro sitio de yohual.com pueda llamar a la API con su cookie. */
function conCors(respuesta, request, env, url) {
  const origen = request.headers.get("origin");
  if (!origen || origen === url.origin || !origenesPermitidos(env, url).has(origen)) return respuesta;
  const nueva = new Response(respuesta.body, respuesta);
  nueva.headers.set("access-control-allow-origin", origen);
  nueva.headers.set("access-control-allow-credentials", "true");
  nueva.headers.append("vary", "Origin");
  return nueva;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const esApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/interno/");

    // El host de acceso (acceso.yohual.com) solo sirve la API, no la página de conversaciones.
    if (!esApi && env.HOST_SOLO_API && url.hostname === env.HOST_SOLO_API) {
      return json({ detail: "No encontrado." }, 404);
    }
    if (!esApi) return env.ASSETS.fetch(request);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      const origen = request.headers.get("origin");
      if (!origen || !origenesPermitidos(env, url).has(origen)) return json({ detail: "Origen no permitido." }, 403);
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origen,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "600",
          vary: "Origin",
        },
      });
    }

    try {
      return conCors(await manejar(request, env, ctx, url), request, env, url);
    } catch (e) {
      if (e instanceof ErrorHttp) return conCors(json({ detail: e.message }, e.estado), request, env, url);
      console.error("Error inesperado:", e && e.stack ? e.stack : e);
      return conCors(json({ detail: "Algo salió mal de nuestro lado. Inténtalo de nuevo en unos minutos." }, 500), request, env, url);
    }
  },

  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(limpiar(env));
  },
};
