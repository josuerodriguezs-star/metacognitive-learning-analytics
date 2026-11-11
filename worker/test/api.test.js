import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker, { limpiar, enviarAlertas } from "../src/index.js";
import { crearD1 } from "./d1_shim.js";

const ORIGEN = "https://conversaciones.test";
const ENLACE = "https://chatgpt.com/share/abc-123";
const CORREO = "alumna.prueba@correo.com";
const TOKEN_ENDURANCE = "e".repeat(48);

let env;
let correos;       // lo que se mandó a "Resend"
let pendientes;    // promesas de ctx.waitUntil
let contadorIp;
const fetchOriginal = globalThis.fetch;

function nuevoEntorno() {
  return {
    DB: crearD1(),
    APP_SECRET: "a".repeat(48),
    PULLER_TOKEN: TOKEN_ENDURANCE,
    RESEND_API_KEY: "re_prueba",
    MAIL_FROM: "yohual <acceso@yohual.test>",
    PUBLIC_URL: ORIGEN,
    VERSION_CONSENTIMIENTO: "2026-11-v2",
    ASSETS: { fetch: async () => new Response("<html>estatico</html>", { headers: { "content-type": "text/html" } }) },
  };
}

beforeEach(() => {
  env = nuevoEntorno();
  correos = [];
  pendientes = [];
  contadorIp = 0;
  // El único fetch saliente del Worker es hacia Resend.
  globalThis.fetch = async (url, opciones) => {
    assert.equal(url, "https://api.resend.com/emails");
    correos.push(JSON.parse(opciones.body));
    return new Response("{}", { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

async function llamar(metodo, ruta, { cuerpo, token, ip, cabeceras = {} } = {}) {
  const h = { "cf-connecting-ip": ip || `10.0.0.${++contadorIp % 250}`, ...cabeceras };
  if (cuerpo !== undefined) h["content-type"] = "application/json";
  if (token) h.authorization = `Bearer ${token}`;
  const respuesta = await worker.fetch(
    new Request(ORIGEN + ruta, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }),
    env,
    { waitUntil: (p) => pendientes.push(p) },
  );
  await Promise.all(pendientes);
  const texto = await respuesta.text();
  let datos = null;
  try { datos = JSON.parse(texto); } catch { /* respuesta no JSON */ }
  return { estado: respuesta.status, datos, texto, cabeceras: respuesta.headers };
}

const ultimoCodigo = () => /\b(\d{6})\b/.exec(correos.at(-1).text)[1];

async function entrar(email = CORREO) {
  assert.equal((await llamar("POST", "/api/registro", { cuerpo: { email } })).estado, 200);
  const r = await llamar("POST", "/api/verificar", { cuerpo: { email, codigo: ultimoCodigo() } });
  assert.equal(r.estado, 200);
  return r.datos.token;
}

async function aceptar(token) {
  const r = await llamar("POST", "/api/consentimiento", { cuerpo: { version: "2026-11-v2" }, token });
  assert.equal(r.estado, 200);
}

const interno = (ruta, cuerpo = {}) => llamar("POST", ruta, { cuerpo, token: TOKEN_ENDURANCE, ip: "203.0.113.9" });

// ------------------------------------------------------------------

test("lo que no es /api ni /interno se sirve como archivo estático", async () => {
  const r = await llamar("GET", "/");
  assert.equal(r.estado, 200);
  assert.match(r.texto, /estatico/);
});

test("flujo completo con endurance en línea", async () => {
  const token = await entrar();
  assert.equal((await llamar("GET", "/api/sesion", { token })).datos.consentimiento, false);

  // Sin consentimiento no se puede enviar
  assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token })).estado, 403);
  await aceptar(token);
  assert.equal((await llamar("GET", "/api/sesion", { token })).datos.consentimiento, true);

  const envio = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  assert.equal(envio.estado, 200);
  assert.equal(envio.datos.servidor_en_linea, false);
  const id = envio.datos.job_id;

  // Endurance despierta y reclama el trabajo
  const lote = (await interno("/interno/pendientes", { max: 3 })).datos.trabajos;
  assert.equal(lote.length, 1);
  assert.equal(lote[0].id, id);
  assert.equal(lote[0].enlace, ENLACE);
  assert.equal(lote[0].version_consentimiento, "2026-11-v2");
  assert.equal((await interno("/interno/pendientes", { max: 3 })).datos.trabajos.length, 0, "no se entrega dos veces");

  assert.equal((await llamar("GET", `/api/estado/${id}`, { token })).datos.servidor_en_linea, true);

  await interno("/interno/fase", { id, fase: "leyendo" });
  assert.equal((await llamar("GET", `/api/estado/${id}`, { token })).datos.fase, "leyendo");

  await interno("/interno/fase", { id, fase: "procesando", turnos: ["user", "assistant", "user"] });
  const durante = (await llamar("GET", `/api/estado/${id}`, { token })).datos;
  assert.deepEqual(durante.turnos, ["user", "assistant", "user"]);

  await interno("/interno/resultado", { id, ok: true, turnos: ["user", "assistant", "user"] });
  const final = (await llamar("GET", `/api/estado/${id}`, { token })).datos;
  assert.equal(final.fase, "listo");
  assert.deepEqual(final.turnos, ["user", "assistant", "user"]);

  // Privacidad: el enlace ya no está en la nube y nunca hubo texto de conversación
  const fila = env.DB._db.prepare("SELECT * FROM trabajos WHERE id = ?").get(id);
  assert.equal(fila.enlace, null);
  assert.equal(JSON.stringify(fila).includes("chatgpt.com"), false);

  // La persona seguía mirando la pantalla (consultó hace segundos): no hay correo extra
  assert.equal(correos.length, 1, "solo el correo del código");

  // El mismo enlace no se recibe dos veces
  assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token })).estado, 409);
});

test("si la persona ya se fue, al terminar recibe un correo", async () => {
  const token = await entrar();
  await aceptar(token);
  const { datos } = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  await interno("/interno/pendientes", { max: 1 });
  const antes = correos.length;
  await interno("/interno/resultado", { id: datos.job_id, ok: true, turnos: ["user", "assistant"] });
  assert.equal(correos.length, antes + 1);
  assert.equal(correos.at(-1).to[0], CORREO);
  assert.match(correos.at(-1).subject, /Ya leímos/);
  assert.equal(env.DB._db.prepare("SELECT avisado FROM trabajos").get().avisado, 1);
});

test("un error de lectura llega al correo y deja reintentar el mismo enlace", async () => {
  const token = await entrar();
  await aceptar(token);
  const { datos } = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  await interno("/interno/pendientes", { max: 1 });
  await interno("/interno/resultado", { id: datos.job_id, ok: false, error: "No encontramos mensajes en ese enlace." });
  assert.match(correos.at(-1).text, /No encontramos mensajes/);
  const estado = (await llamar("GET", `/api/estado/${datos.job_id}`, { token })).datos;
  assert.equal(estado.fase, "error");
  assert.match(estado.error, /No encontramos/);
  assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token })).estado, 200);
});

test("un resultado repetido no se aplica dos veces ni manda otro correo", async () => {
  const token = await entrar();
  await aceptar(token);
  const { datos } = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  await interno("/interno/pendientes", { max: 1 });
  await interno("/interno/resultado", { id: datos.job_id, ok: true, turnos: ["user"] });
  const n = correos.length;
  await interno("/interno/resultado", { id: datos.job_id, ok: false, error: "tarde" });
  assert.equal(correos.length, n);
  assert.equal((await llamar("GET", `/api/estado/${datos.job_id}`, { token })).datos.fase, "listo");
});

test("un trabajo tomado que nunca se reporta vuelve a la fila", async () => {
  const token = await entrar();
  await aceptar(token);
  await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  await interno("/interno/pendientes", { max: 1 });
  env.DB._db.prepare("UPDATE trabajos SET tomado_ts = tomado_ts - 3600").run();
  assert.equal((await interno("/interno/pendientes", { max: 1 })).datos.trabajos.length, 1);
});

test("latido: en línea al consultar y fuera de línea al apagar o al pasar el tiempo", async () => {
  const token = await entrar();
  await aceptar(token);
  const { datos } = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  const consulta = async () => (await llamar("GET", `/api/estado/${datos.job_id}`, { token })).datos.servidor_en_linea;

  assert.equal(await consulta(), false);
  await interno("/interno/pendientes", { max: 1 });
  assert.equal(await consulta(), true);
  env.DB._db.prepare("UPDATE meta SET valor = valor - 600").run();
  assert.equal(await consulta(), false, "latido viejo");
  await interno("/interno/pendientes", { max: 1 });
  assert.equal(await consulta(), true);
  await interno("/interno/apagado");
  assert.equal(await consulta(), false);
});

test("el latido mantiene a endurance en línea sin tomar trabajos", async () => {
  const token = await entrar();
  await aceptar(token);
  const { datos } = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  await interno("/interno/latido");
  assert.equal((await llamar("GET", `/api/estado/${datos.job_id}`, { token })).datos.servidor_en_linea, true);
  assert.equal(env.DB._db.prepare("SELECT estado FROM trabajos").get().estado, "en_cola");
});

test("el estado de otra persona no se ve", async () => {
  const t1 = await entrar("uno@correo.com");
  await aceptar(t1);
  const { datos } = await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token: t1 });
  const t2 = await entrar("dos@correo.com");
  assert.equal((await llamar("GET", `/api/estado/${datos.job_id}`, { token: t2 })).estado, 404);
});

// ---------------- endurance ----------------

test("los endpoints internos exigen el token de endurance", async () => {
  const sin = await llamar("POST", "/interno/pendientes", { cuerpo: { max: 1 }, ip: "198.51.100.1" });
  assert.equal(sin.estado, 401);
  const mal = await llamar("POST", "/interno/pendientes", { cuerpo: { max: 1 }, token: "x".repeat(48), ip: "198.51.100.1" });
  assert.equal(mal.estado, 401);
  // Un token de participante tampoco sirve
  const tokenPersona = await entrar();
  const r = await llamar("POST", "/interno/pendientes", { cuerpo: { max: 1 }, token: tokenPersona, ip: "198.51.100.1" });
  assert.equal(r.estado, 401);
  // GET no está permitido
  assert.equal((await llamar("GET", "/interno/pendientes", { token: TOKEN_ENDURANCE })).estado, 405);
});

test("tras muchos intentos fallidos se bloquea esa IP, pero no a endurance", async () => {
  let ultimo;
  for (let i = 0; i < 12; i++) {
    ultimo = await llamar("POST", "/interno/pendientes", { cuerpo: { max: 1 }, token: "mal".repeat(16), ip: "198.51.100.77" });
  }
  assert.equal(ultimo.estado, 429);
  assert.equal((await interno("/interno/pendientes", { max: 1 })).estado, 200);
});

test("sin PULLER_TOKEN configurado, lo interno queda cerrado", async () => {
  env.PULLER_TOKEN = "corto";
  const r = await llamar("POST", "/interno/pendientes", { cuerpo: { max: 1 }, token: "corto" });
  assert.equal(r.estado, 500);
});

test("fase y resultado rechazan datos mal formados", async () => {
  assert.equal((await interno("/interno/fase", { id: "x", fase: "inventada" })).estado, 400);
  assert.equal((await interno("/interno/fase", { id: "x", fase: "leyendo", turnos: ["user", "root"] })).estado, 400);
  assert.equal((await interno("/interno/resultado", { id: 5, ok: true })).estado, 400);
});

// ---------------- registro y códigos ----------------

test("correo inválido", async () => {
  assert.equal((await llamar("POST", "/api/registro", { cuerpo: { email: "no-es-correo" } })).estado, 400);
});

test("el código se envía por correo y solo tiene 6 dígitos", async () => {
  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  assert.equal(correos.length, 1);
  assert.equal(correos[0].to[0], CORREO);
  assert.match(ultimoCodigo(), /^\d{6}$/);
});

test("límite de códigos por correo", async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } })).estado, 200);
  }
  assert.equal((await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } })).estado, 429);
});

test("límite de registros por IP", async () => {
  let ultimo;
  for (let i = 0; i < 12; i++) {
    ultimo = await llamar("POST", "/api/registro", { cuerpo: { email: `p${i}@correo.com` }, ip: "192.0.2.5" });
  }
  assert.equal(ultimo.estado, 429);
});

test("si el correo falla, la persona recibe un mensaje claro", async () => {
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  const r = await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  assert.equal(r.estado, 502);
  assert.match(r.datos.detail, /No pudimos enviar el correo/);
});

test("código incorrecto, agotado, vencido y reutilizado", async () => {
  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  const bueno = ultimoCodigo();
  const malo = bueno === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    assert.equal((await llamar("POST", "/api/verificar", { cuerpo: { email: CORREO, codigo: malo } })).estado, 400);
  }
  assert.equal((await llamar("POST", "/api/verificar", { cuerpo: { email: CORREO, codigo: bueno } })).estado, 400, "agotado");

  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  env.DB._db.prepare("UPDATE codigos SET expira_ts = 1").run();
  assert.equal((await llamar("POST", "/api/verificar", { cuerpo: { email: CORREO, codigo: ultimoCodigo() } })).estado, 400, "vencido");

  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  const codigo = ultimoCodigo();
  assert.equal((await llamar("POST", "/api/verificar", { cuerpo: { email: CORREO, codigo } })).estado, 200);
  assert.equal((await llamar("POST", "/api/verificar", { cuerpo: { email: CORREO, codigo } })).estado, 400, "reutilizado");
});

test("el código en la base no está en claro", async () => {
  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  const fila = JSON.stringify(env.DB._db.prepare("SELECT * FROM codigos").get());
  assert.equal(fila.includes(ultimoCodigo()), false);
  assert.equal(fila.includes(CORREO), false);
});

test("consentimiento con versión vieja", async () => {
  const token = await entrar();
  const r = await llamar("POST", "/api/consentimiento", { cuerpo: { version: "0000" }, token });
  assert.equal(r.estado, 409);
});

test("endpoints de participante protegidos y token manipulado", async () => {
  assert.equal((await llamar("GET", "/api/sesion")).estado, 401);
  assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE } })).estado, 401);
  const token = await entrar();
  assert.equal((await llamar("GET", "/api/sesion", { token: token.slice(0, -2) + "xx" })).estado, 401);
});

// ---------------- enlaces y límites ----------------

test("enlaces que intentan saltarse la validación", async () => {
  const token = await entrar();
  await aceptar(token);
  for (const enlace of [
    "https://evil.com/share/abc-123",
    "https://chatgpt.com@evil.com/share/abc-123",
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "https://chatgpt.com/c/abc-123",
  ]) {
    const r = await llamar("POST", "/api/enviar", { cuerpo: { enlace }, token });
    assert.equal(r.estado, 400, enlace);
  }
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) AS n FROM trabajos").get().n, 0);
});

test("límite diario y de conversaciones en fila", async () => {
  const token = await entrar();
  await aceptar(token);
  for (let i = 1; i <= 3; i++) {
    assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: `https://chatgpt.com/share/id-${i}` }, token })).estado, 200);
  }
  const cuarta = await llamar("POST", "/api/enviar", { cuerpo: { enlace: "https://chatgpt.com/share/id-4" }, token });
  assert.equal(cuarta.estado, 409);
  assert.match(cuarta.datos.detail, /en fila/);

  env.DB._db.prepare("UPDATE trabajos SET estado = 'listo'").run();
  assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: "https://chatgpt.com/share/id-4" }, token })).estado, 200);
  assert.equal((await llamar("POST", "/api/enviar", { cuerpo: { enlace: "https://chatgpt.com/share/id-5" }, token })).estado, 200);
  const sexta = await llamar("POST", "/api/enviar", { cuerpo: { enlace: "https://chatgpt.com/share/id-6" }, token });
  assert.equal(sexta.estado, 429);
});

// ---------------- protecciones generales ----------------

test("un origen distinto al del sitio se rechaza", async () => {
  const r = await llamar("POST", "/api/registro", { cuerpo: { email: CORREO }, cabeceras: { origin: "https://otro-sitio.com" } });
  assert.equal(r.estado, 403);
  const propio = await llamar("POST", "/api/registro", { cuerpo: { email: CORREO }, cabeceras: { origin: ORIGEN } });
  assert.equal(propio.estado, 200);
});

test("las respuestas de la API no se guardan en caché", async () => {
  const r = await llamar("GET", "/api/sesion");
  assert.equal(r.cabeceras.get("cache-control"), "no-store");
  assert.equal(r.cabeceras.get("x-content-type-options"), "nosniff");
});

test("cuerpos que no son JSON o son demasiado grandes", async () => {
  const sinTipo = await worker.fetch(
    new Request(ORIGEN + "/api/registro", { method: "POST", body: "email=a@a.com", headers: { "cf-connecting-ip": "1.1.1.1" } }),
    env, { waitUntil() {} },
  );
  assert.equal(sinTipo.status, 415);
  const grande = await llamar("POST", "/api/registro", { cuerpo: { email: "a".repeat(20000) } });
  assert.equal(grande.estado, 413);
});

test("sin APP_SECRET la API se cierra", async () => {
  env.APP_SECRET = "";
  assert.equal((await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } })).estado, 500);
});

test("rutas desconocidas", async () => {
  assert.equal((await llamar("GET", "/api/no-existe")).estado, 404);
  assert.equal((await llamar("POST", "/api/estado/abc")).estado, 404);
});

// ---------------- limpieza ----------------

test("la limpieza descarta enlaces viejos sin leer y borra su enlace", async () => {
  const token = await entrar();
  await aceptar(token);
  await llamar("POST", "/api/enviar", { cuerpo: { enlace: ENLACE }, token });
  env.DB._db.prepare("UPDATE trabajos SET creado_ts = creado_ts - ?").run(31 * 86400);
  env.DB._db.prepare("UPDATE codigos SET expira_ts = 1").run();
  await limpiar(env);
  const fila = env.DB._db.prepare("SELECT estado, enlace FROM trabajos").get();
  assert.equal(fila.estado, "error");
  assert.equal(fila.enlace, null);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) AS n FROM codigos").get().n, 0);
});

// ------------------------------------------------------------------
// Acceso compartido: cookie, CORS, consentimiento por servicio, envíos y suscripciones
// ------------------------------------------------------------------

const CAL = "https://calendario.test";

function conSitios() {
  env.ORIGENES_PERMITIDOS = `${CAL},https://simulador.test`;
  env.COOKIE_DOMINIO = ".yohual.test";
  env.CONSENTIMIENTOS = JSON.stringify({ calendario: "cal-v1", simulador: "sim-v1" });
}

async function sesionConCookie() {
  conSitios();
  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO } });
  const r = await llamar("POST", "/api/verificar", { cuerpo: { email: CORREO, codigo: ultimoCodigo() } });
  const cookie = r.cabeceras.get("set-cookie");
  return { token: r.datos.token, cookie, par: cookie.split(";")[0] };
}

test("verificar entrega una cookie de sesión compartida y segura", async () => {
  const { cookie } = await sesionConCookie();
  assert.match(cookie, /^yh_sesion=/);
  for (const a of ["HttpOnly", "Secure", "SameSite=Lax", "Domain=.yohual.test", "Path=/"]) assert.ok(cookie.includes(a), a);
});

test("la cookie autentica y /api/salir la borra", async () => {
  const { par } = await sesionConCookie();
  const h = { cookie: par, origin: CAL };
  const s = await llamar("GET", "/api/sesion?servicio=calendario", { cabeceras: h });
  assert.equal(s.estado, 200);
  assert.equal(s.datos.email, CORREO);
  assert.equal(s.datos.servicio, "calendario");
  assert.equal(s.datos.consentimiento, false);
  const o = await llamar("POST", "/api/salir", { cuerpo: {}, cabeceras: h });
  assert.equal(o.estado, 200);
  assert.match(o.cabeceras.get("set-cookie"), /Max-Age=0/);
});

test("escrituras con cookie sin Origin se rechazan (CSRF)", async () => {
  const { par } = await sesionConCookie();
  const r = await llamar("POST", "/api/consentimiento", { cuerpo: { version: "cal-v1", servicio: "calendario" }, cabeceras: { cookie: par } });
  assert.equal(r.estado, 403);
});

test("origen desconocido se rechaza; el permitido recibe CORS con credenciales", async () => {
  const { par } = await sesionConCookie();
  const malo = await llamar("GET", "/api/sesion", { cabeceras: { cookie: par, origin: "https://malo.example" } });
  assert.equal(malo.estado, 403);
  const bueno = await llamar("GET", "/api/sesion", { cabeceras: { cookie: par, origin: CAL } });
  assert.equal(bueno.cabeceras.get("access-control-allow-origin"), CAL);
  assert.equal(bueno.cabeceras.get("access-control-allow-credentials"), "true");
});

test("preflight: responde al origen permitido y niega al resto", async () => {
  conSitios();
  const ok = await llamar("OPTIONS", "/api/envios", { cabeceras: { origin: CAL } });
  assert.equal(ok.estado, 204);
  assert.equal(ok.cabeceras.get("access-control-allow-origin"), CAL);
  const no = await llamar("OPTIONS", "/api/envios", { cabeceras: { origin: "https://malo.example" } });
  assert.equal(no.estado, 403);
});

test("el host solo-API no sirve la página", async () => {
  env.HOST_SOLO_API = "acceso.yohual.test";
  const r = await worker.fetch(new Request("https://acceso.yohual.test/"), env, { waitUntil() {} });
  assert.equal(r.status, 404);
});

test("el consentimiento es por servicio: aceptar uno no habilita otro", async () => {
  const { token } = await sesionConCookie();
  const c = await llamar("POST", "/api/consentimiento", { cuerpo: { version: "cal-v1", servicio: "calendario" }, token });
  assert.equal(c.estado, 200);
  const sc = await llamar("GET", "/api/sesion?servicio=calendario", { token });
  const ss = await llamar("GET", "/api/sesion?servicio=simulador", { token });
  assert.equal(sc.datos.consentimiento, true);
  assert.equal(ss.datos.consentimiento, false);
  const e = await llamar("POST", "/api/envios", { token, cuerpo: { servicio: "simulador", tipo: "encuesta", carga: { a: 1 } } });
  assert.equal(e.estado, 403);
});

test("una versión de consentimiento equivocada se rechaza", async () => {
  const { token } = await sesionConCookie();
  const c = await llamar("POST", "/api/consentimiento", { cuerpo: { version: "vieja", servicio: "simulador" }, token });
  assert.ok(c.estado >= 400 && c.estado < 500);
});

async function aceptarServicio(token, servicio, version) {
  const c = await llamar("POST", "/api/consentimiento", { cuerpo: { version, servicio }, token });
  assert.equal(c.estado, 200);
}

test("envíos: se encolan, endurance los recoge y al terminar la carga se borra", async () => {
  const { token } = await sesionConCookie();
  await aceptarServicio(token, "simulador", "sim-v1");
  const e = await llamar("POST", "/api/envios", { token, cuerpo: { servicio: "simulador", tipo: "encuesta", carga: { p1: "x", p2: [1, 2] }, id_cliente: "abc12345" } });
  assert.equal(e.estado, 201);
  const otra = await llamar("POST", "/api/envios", { token, cuerpo: { servicio: "simulador", tipo: "encuesta", carga: { p1: "x" }, id_cliente: "abc12345" } });
  assert.equal(otra.datos.repetido, true);
  assert.equal(otra.datos.id, e.datos.id);

  const sin = await llamar("POST", "/interno/envios/pendientes", { cuerpo: { max: 5 } });
  assert.equal(sin.estado, 401);

  const p = await interno("/interno/envios/pendientes", { max: 5 });
  assert.equal(p.datos.envios.length, 1);
  assert.deepEqual(p.datos.envios[0].carga, { p1: "x", p2: [1, 2] });
  assert.equal(p.datos.envios[0].servicio, "simulador");
  assert.equal(p.datos.envios[0].version_consentimiento, "sim-v1");
  assert.equal((await interno("/interno/envios/pendientes", { max: 5 })).datos.envios.length, 0);

  await interno("/interno/envios/resultado", { id: e.datos.id, ok: true });
  const fila = env.DB._db.prepare("SELECT estado, carga FROM envios WHERE id = ?").get(e.datos.id);
  assert.equal(fila.estado, "listo");
  assert.equal(fila.carga, null);
});

test("envíos: validaciones de tipo, tamaño y servicio", async () => {
  const { token } = await sesionConCookie();
  await aceptarServicio(token, "simulador", "sim-v1");
  const mal = (cuerpo) => llamar("POST", "/api/envios", { token, cuerpo });
  assert.equal((await mal({ servicio: "calendario", tipo: "encuesta", carga: {} })).estado, 400);
  assert.equal((await mal({ servicio: "simulador", tipo: "otro", carga: {} })).estado, 400);
  assert.equal((await mal({ servicio: "simulador", tipo: "encuesta", carga: [1] })).estado, 400);
  assert.equal((await mal({ servicio: "simulador", tipo: "encuesta", carga: { x: "y".repeat(40000) } })).estado, 413);
});

test("envíos: un envío vencido en la fila se reintenta si endurance no respondió", async () => {
  const { token } = await sesionConCookie();
  await aceptarServicio(token, "simulador", "sim-v1");
  const e = await llamar("POST", "/api/envios", { token, cuerpo: { servicio: "simulador", tipo: "encuesta", carga: { a: 1 } } });
  await interno("/interno/envios/pendientes", { max: 1 });
  env.DB._db.prepare("UPDATE envios SET tomado_ts = tomado_ts - 3600 WHERE id = ?").run(e.datos.id);
  const otra = await interno("/interno/envios/pendientes", { max: 1 });
  assert.equal(otra.datos.envios.length, 1);
});

test("suscripciones: reemplazan la lista, exigen consentimiento y solo existen para el calendario", async () => {
  const { token } = await sesionConCookie();
  const sin = await llamar("PUT", "/api/suscripciones/calendario", { token, cuerpo: { claves: ["premio-a"] } });
  assert.equal(sin.estado, 403);
  await aceptarServicio(token, "calendario", "cal-v1");
  let r = await llamar("PUT", "/api/suscripciones/calendario", { token, cuerpo: { claves: ["premio-a", "premio-b", "premio-a"] } });
  assert.deepEqual(r.datos.claves, ["premio-a", "premio-b"]);
  r = await llamar("PUT", "/api/suscripciones/calendario", { token, cuerpo: { claves: ["premio-b", "premio-c"] } });
  assert.deepEqual(r.datos.claves, ["premio-b", "premio-c"]);
  r = await llamar("GET", "/api/suscripciones/calendario", { token });
  assert.deepEqual(r.datos.claves, ["premio-b", "premio-c"]);
  r = await llamar("PUT", "/api/suscripciones/calendario", { token, cuerpo: { claves: [] } });
  assert.deepEqual(r.datos.claves, []);
  assert.equal((await llamar("PUT", "/api/suscripciones/calendario", { token, cuerpo: { claves: ["Mal Formato!"] } })).estado, 400);
  assert.equal((await llamar("GET", "/api/suscripciones/simulador", { token })).estado, 404);
});

test("limpiar: los envíos pendientes muy viejos se descartan sin conservar la carga", async () => {
  const { token } = await sesionConCookie();
  await aceptarServicio(token, "simulador", "sim-v1");
  const e = await llamar("POST", "/api/envios", { token, cuerpo: { servicio: "simulador", tipo: "encuesta", carga: { a: 1 } } });
  env.DB._db.prepare("UPDATE envios SET creado_ts = creado_ts - ? WHERE id = ?").run(61 * 86400, e.datos.id);
  await limpiar(env);
  const fila = env.DB._db.prepare("SELECT estado, carga FROM envios WHERE id = ?").get(e.datos.id);
  assert.equal(fila.estado, "error");
  assert.equal(fila.carga, null);
});

// ------------------------------------------------------------------
// Alertas del calendario y baja
// ------------------------------------------------------------------

const PREMIOS = {
  awards: [
    { id: 3, name: "ETIH", url: "https://etih.example/bases", events: [
      { date: "2026-12-18", label: "Fin de tarifa anticipada", kind: "Cierre" },
      { date: "2027-02-26", label: "Cierre final", kind: "Cierre" },
      { date: "2027-03", label: "Resultados", kind: "Resultados" } ] },
    { id: 4, name: "CODiE", url: "https://codie.example", events: [{ date: "2026-12-11", label: "Apertura", kind: "Apertura" }] },
  ],
};

function prepararAlertas() {
  env.URL_PREMIOS = "https://calendario.test/awards.json";
  env.PUBLIC_URL_ACCESO = "https://acceso.test";
  globalThis.fetch = async (url, opciones) => {
    if (url === env.URL_PREMIOS) return new Response(JSON.stringify(PREMIOS), { status: 200 });
    assert.equal(url, "https://api.resend.com/emails");
    correos.push(JSON.parse(opciones.body));
    return new Response("{}", { status: 200 });
  };
}

async function suscribirse(claves) {
  const { token } = await sesionConCookie();
  await aceptarServicio(token, "calendario", "cal-v1");
  const r = await llamar("PUT", "/api/suscripciones/calendario", { token, cuerpo: { claves } });
  assert.equal(r.estado, 200);
  correos.length = 0;
}

test("alertas: avisa a quien sigue el premio, un solo correo con enlace de baja, sin repetir", async () => {
  await suscribirse(["3"]);
  prepararAlertas();
  // 2026-12-11 → el cierre del 18 está a 7 días; el premio 4 no se sigue.
  const r = await enviarAlertas(env, "2026-12-11");
  assert.equal(r.enviados, 1);
  assert.equal(correos.length, 1);
  const c = correos[0];
  assert.deepEqual(c.to, [CORREO]);
  assert.match(c.subject, /ETIH: cierre en 7 días/);
  assert.ok(!c.text.includes("CODiE"));
  assert.match(c.text, /https:\/\/acceso\.test\/api\/baja\?t=/);
  assert.match(c.headers["List-Unsubscribe"], /\/api\/baja\?t=/);
  assert.equal(c.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // Segunda corrida el mismo día: no repite.
  assert.equal((await enviarAlertas(env, "2026-12-11")).enviados, 0);
  assert.equal(correos.length, 1);
});

test("alertas: sin consentimiento vigente o en un día sin fechas, no manda nada", async () => {
  await suscribirse(["3"]);
  prepararAlertas();
  assert.equal((await enviarAlertas(env, "2026-12-01")).enviados, 0);
  env.DB._db.prepare("DELETE FROM consentimientos WHERE servicio = 'calendario'").run();
  assert.equal((await enviarAlertas(env, "2026-12-11")).enviados, 0);
  assert.equal(correos.length, 0);
});

test("alertas: si el correo falla no se marca como enviado y se reintenta", async () => {
  await suscribirse(["3"]);
  prepararAlertas();
  const buena = globalThis.fetch;
  globalThis.fetch = async (url, o) => (url === "https://api.resend.com/emails" ? new Response("{}", { status: 500 }) : buena(url, o));
  assert.equal((await enviarAlertas(env, "2026-12-11")).enviados, 0);
  globalThis.fetch = buena;
  assert.equal((await enviarAlertas(env, "2026-12-11")).enviados, 1);
});

test("alertas: si no se puede leer la lista de premios, no hace nada", async () => {
  await suscribirse(["3"]);
  env.URL_PREMIOS = "https://calendario.test/awards.json";
  globalThis.fetch = async () => new Response("no", { status: 500 });
  assert.equal((await enviarAlertas(env, "2026-12-11")).enviados, 0);
});

test("baja: GET solo muestra el botón; POST borra las suscripciones; token alterado no sirve", async () => {
  await suscribirse(["3", "4"]);
  prepararAlertas();
  await enviarAlertas(env, "2026-12-11");
  const enlace = /api\/baja\?t=([^\s"]+)/.exec(correos[0].text)[1];
  const ruta = `/api/baja?t=${enlace}`;

  const g = await llamar("GET", ruta);
  assert.equal(g.estado, 200);
  assert.ok(g.texto.includes("<form"));
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) AS n FROM suscripciones").get().n, 2);

  const mal = await llamar("POST", ruta.slice(0, -2) + "00");
  assert.equal(mal.estado, 400);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) AS n FROM suscripciones").get().n, 2);

  const p = await llamar("POST", ruta);
  assert.equal(p.estado, 200);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) AS n FROM suscripciones").get().n, 0);
});

test("el código de acceso menciona el servicio desde el que se registra", async () => {
  conSitios();
  await llamar("POST", "/api/registro", { cuerpo: { email: CORREO, servicio: "calendario" } });
  assert.match(correos.at(-1).text, /calendario de premios/);
  const r = await llamar("POST", "/api/registro", { cuerpo: { email: CORREO, servicio: "otro" } });
  assert.equal(r.estado, 400);
});
