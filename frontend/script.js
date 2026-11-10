(function () {
  "use strict";

  const CFG = window.CONFIG || {};
  const params = new URLSearchParams(location.search);
  // La API vive en el mismo sitio (API_BASE_URL vacío). El modo demostración
  // solo se activa a propósito: ?demo, ?demo=error o ?demo=fila.
  const DEMO = params.has("demo");
  const DEMO_ERROR = params.get("demo") === "error"; // muestra la pantalla de error
  const DEMO_FILA = params.get("demo") === "fila";   // muestra "tu enlace quedó en fila"
  const MOVIMIENTO_REDUCIDO = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (sel, raiz = document) => raiz.querySelector(sel);
  const pasos = Array.from(document.querySelectorAll(".paso"));
  const nodos = Array.from(document.querySelectorAll("#progreso li"));

  const sesion = { email: "", token: null, turnos: [] };

  const NODO_DE_PASO = {
    correo: "correo",
    codigo: "codigo",
    consentimiento: "consentimiento",
    enlace: "enlace",
    extraccion: "enlace",
    gracias: "gracias",
  };
  const ORDEN_NODOS = ["correo", "codigo", "consentimiento", "enlace", "gracias"];

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------
  // Configuración visible: enlaces de inicio y contacto
  // ------------------------------------------------------------------

  ["#enlace-marca", "#enlace-inicio", "#btn-inicio"].forEach((sel) => {
    const el = $(sel);
    if (el && CFG.HOME_URL) el.href = CFG.HOME_URL;
  });
  if (CFG.CONTACTO_EMAIL) {
    const c = $("#enlace-contacto");
    c.href = "mailto:" + CFG.CONTACTO_EMAIL;
    c.textContent = CFG.CONTACTO_EMAIL;
  }
  if (DEMO) $("#aviso-demo").hidden = false;

  // ------------------------------------------------------------------
  // Cielo: estrellas fijas, dibujadas una vez (sin animación)
  // ------------------------------------------------------------------

  function pintarCielo() {
    const lienzo = $("#cielo");
    const ctx = lienzo.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    lienzo.width = w * dpr;
    lienzo.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let semilla = 1337;
    const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
    const cantidad = Math.round((w * h) / 9000);
    for (let i = 0; i < cantidad; i++) {
      const x = azar() * w;
      const y = azar() * h;
      const radio = azar() * 1.1 + 0.2;
      const brillo = 0.25 + azar() * 0.6;
      const calida = azar() < 0.12;
      ctx.globalAlpha = brillo * (1 - 0.4 * (y / h));
      ctx.fillStyle = calida ? "#F0D9B5" : "#DDE3FF";
      ctx.beginPath();
      ctx.arc(x, y, radio, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  pintarCielo();
  let temporizadorCielo = null;
  window.addEventListener("resize", () => {
    clearTimeout(temporizadorCielo);
    temporizadorCielo = setTimeout(pintarCielo, 150);
  });

  // ------------------------------------------------------------------
  // Navegación entre pasos
  // ------------------------------------------------------------------

  function irA(nombre) {
    pasos.forEach((p) => { p.hidden = p.dataset.paso !== nombre; });

    const nodoActual = NODO_DE_PASO[nombre];
    const indice = ORDEN_NODOS.indexOf(nodoActual);
    nodos.forEach((li, i) => {
      li.classList.toggle("hecho", i < indice);
      if (i === indice) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });

    const destino = $(`.paso[data-paso="${nombre}"]`);
    const titulo = $(".titulo", destino);
    if (titulo) titulo.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  // ------------------------------------------------------------------
  // Mensajes
  // ------------------------------------------------------------------

  function mostrar(el, texto, info) {
    el.textContent = texto;
    el.classList.toggle("error--info", Boolean(info));
    el.hidden = false;
  }
  function ocultar(el) {
    el.hidden = true;
    el.textContent = "";
  }

  // ------------------------------------------------------------------
  // Cliente de la API (con modo demostración)
  // ------------------------------------------------------------------

  class ErrorApi extends Error {
    constructor(mensaje, estado) {
      super(mensaje);
      this.estado = estado;
    }
  }

  function guardarToken(token) {
    sesion.token = token;
    if (DEMO) return;
    try { sessionStorage.setItem("yohual_token", token); } catch (_) { /* sin almacenamiento */ }
  }
  function olvidarToken() {
    sesion.token = null;
    try { sessionStorage.removeItem("yohual_token"); } catch (_) { /* sin almacenamiento */ }
  }
  function tokenGuardado() {
    try { return sessionStorage.getItem("yohual_token"); } catch (_) { return null; }
  }

  async function llamar(ruta, { metodo = "GET", cuerpo = null } = {}) {
    if (DEMO) return demo(ruta, cuerpo);

    const cabeceras = { "Content-Type": "application/json" };
    if (sesion.token) cabeceras.Authorization = "Bearer " + sesion.token;

    let respuesta;
    try {
      respuesta = await fetch((CFG.API_BASE_URL || "") + ruta, {
        method: metodo,
        headers: cabeceras,
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch (_) {
      throw new ErrorApi("No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.", 0);
    }

    let datos = null;
    try { datos = await respuesta.json(); } catch (_) { /* sin cuerpo JSON */ }

    if (!respuesta.ok) {
      const detalle = datos && typeof datos.detail === "string"
        ? datos.detail
        : "Algo salió mal. Inténtalo de nuevo.";
      throw new ErrorApi(detalle, respuesta.status);
    }
    return datos;
  }

  // --- Demostración: simula el backend sin enviar nada ---

  const demoTrabajo = { inicio: 0, turnos: [] };

  function turnosDemo() {
    const total = 16;
    const turnos = [];
    for (let i = 0; i < total; i++) turnos.push(i % 2 === 0 ? "user" : "assistant");
    turnos.splice(9, 0, "assistant"); // un asistente largo, dos mensajes seguidos
    return turnos;
  }

  async function demo(ruta, cuerpo) {
    await dormir(450);
    if (ruta === "/api/registro") return { enviado: true };
    if (ruta === "/api/verificar") {
      if (!/^\d{6}$/.test(cuerpo.codigo)) throw new ErrorApi("Escribe los 6 dígitos del código.", 400);
      return { token: "demo" };
    }
    if (ruta === "/api/sesion") return { consentimiento: false };
    if (ruta === "/api/consentimiento") return { consentimiento: true };
    if (ruta === "/api/enviar") {
      demoTrabajo.inicio = Date.now();
      demoTrabajo.turnos = turnosDemo();
      return { job_id: "demo", plataforma: "ChatGPT", servidor_en_linea: !DEMO_FILA };
    }
    if (ruta.indexOf("/api/estado/") === 0) {
      const t = (Date.now() - demoTrabajo.inicio) / 1000;
      if (DEMO_FILA) return { fase: "en_cola", turnos: [], error: null, servidor_en_linea: false };
      if (DEMO_ERROR && t > 2) {
        return {
          fase: "error",
          turnos: [],
          servidor_en_linea: true,
          error: "No encontramos mensajes en ese enlace. Revisa que la conversación esté compartida y que el enlace siga activo.",
        };
      }
      let fase = "listo";
      if (t < 1) fase = "abriendo";
      else if (t < 4) fase = "leyendo";
      else if (t < 5) fase = "procesando";
      else if (t < 6) fase = "guardando";
      const conTurnos = fase === "procesando" || fase === "guardando" || fase === "listo";
      return { fase, turnos: conTurnos ? demoTrabajo.turnos : [], error: null, servidor_en_linea: true };
    }
    throw new ErrorApi("Ruta de demostración desconocida.", 404);
  }

  function sesionVencida() {
    olvidarToken();
    irA("correo");
    mostrar($("#err-correo"), "Tu sesión venció. Ingresa tu correo para continuar.", true);
  }

  // ------------------------------------------------------------------
  // Paso 1 · correo
  // ------------------------------------------------------------------

  const REGEX_CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
  const formCorreo = $("#form-correo");
  const inCorreo = $("#in-correo");

  formCorreo.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#err-correo");
    ocultar(errEl);

    const email = inCorreo.value.trim().toLowerCase();
    if (!REGEX_CORREO.test(email)) {
      mostrar(errEl, "Escribe un correo válido, por ejemplo nombre@correo.com.");
      inCorreo.focus();
      return;
    }

    const boton = $("button[type=submit]", formCorreo);
    boton.disabled = true;
    try {
      await llamar("/api/registro", { metodo: "POST", cuerpo: { email } });
      sesion.email = email;
      $("#correo-destino").textContent = email;
      $("#in-codigo").value = "";
      ocultar($("#err-codigo"));
      irA("codigo");
      iniciarEsperaReenvio();
    } catch (err) {
      mostrar(errEl, err.message);
    } finally {
      boton.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Paso 2 · código
  // ------------------------------------------------------------------

  const formCodigo = $("#form-codigo");
  const inCodigo = $("#in-codigo");
  const btnReenviar = $("#btn-reenviar");
  let temporizadorReenvio = null;

  inCodigo.addEventListener("input", () => {
    inCodigo.value = inCodigo.value.replace(/\D/g, "").slice(0, 6);
  });

  function iniciarEsperaReenvio() {
    clearInterval(temporizadorReenvio);
    let restante = 30;
    btnReenviar.disabled = true;
    btnReenviar.textContent = `Reenviar código (${restante})`;
    temporizadorReenvio = setInterval(() => {
      restante -= 1;
      if (restante <= 0) {
        clearInterval(temporizadorReenvio);
        btnReenviar.disabled = false;
        btnReenviar.textContent = "Reenviar código";
      } else {
        btnReenviar.textContent = `Reenviar código (${restante})`;
      }
    }, 1000);
  }

  btnReenviar.addEventListener("click", async () => {
    const errEl = $("#err-codigo");
    ocultar(errEl);
    btnReenviar.disabled = true;
    try {
      await llamar("/api/registro", { metodo: "POST", cuerpo: { email: sesion.email } });
      mostrar(errEl, "Enviamos un código nuevo.", true);
      iniciarEsperaReenvio();
    } catch (err) {
      mostrar(errEl, err.message);
      btnReenviar.disabled = false;
    }
  });

  $("#btn-cambiar-correo").addEventListener("click", () => {
    clearInterval(temporizadorReenvio);
    irA("correo");
    inCorreo.focus();
  });

  async function siguientePasoTrasEntrar() {
    const s = await llamar("/api/sesion");
    irA(s.consentimiento ? "enlace" : "consentimiento");
  }

  formCodigo.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#err-codigo");
    ocultar(errEl);

    const codigo = inCodigo.value.replace(/\D/g, "");
    if (codigo.length !== 6) {
      mostrar(errEl, "Escribe los 6 dígitos del código.");
      inCodigo.focus();
      return;
    }

    const boton = $("button[type=submit]", formCodigo);
    boton.disabled = true;
    try {
      const r = await llamar("/api/verificar", {
        metodo: "POST",
        cuerpo: { email: sesion.email, codigo },
      });
      guardarToken(r.token);
      clearInterval(temporizadorReenvio);
      await siguientePasoTrasEntrar();
    } catch (err) {
      mostrar(errEl, err.message);
    } finally {
      boton.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Paso 3 · consentimiento
  // ------------------------------------------------------------------

  const inAcepto = $("#in-acepto");
  const btnAcepto = $("#btn-acepto");
  inAcepto.addEventListener("change", () => { btnAcepto.disabled = !inAcepto.checked; });

  $("#form-consentimiento").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#err-consentimiento");
    ocultar(errEl);
    if (!inAcepto.checked) return;

    btnAcepto.disabled = true;
    try {
      const version = $('.paso[data-paso="consentimiento"]').dataset.version;
      await llamar("/api/consentimiento", { metodo: "POST", cuerpo: { version } });
      irA("enlace");
      $("#in-enlace").focus();
    } catch (err) {
      if (err.estado === 401) return sesionVencida();
      mostrar(errEl, err.message);
      btnAcepto.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Paso 4 · enlace
  // ------------------------------------------------------------------

  const inEnlace = $("#in-enlace");
  const ayudaEnlace = $("#ayuda-enlace");
  const AYUDA_INICIAL = ayudaEnlace.textContent;
  const HOSTS_CHATGPT = ["chatgpt.com", "chat.openai.com"];

  function revisarEnlace(valor) {
    const texto = valor.replace(/[​‌‍﻿]/g, "").trim();
    if (!texto) return { ok: false, error: "Pega el enlace de tu conversación compartida." };

    let url;
    try { url = new URL(texto); } catch (_) {
      return { ok: false, error: "Ese enlace no parece válido. Cópialo de nuevo desde el botón Compartir." };
    }
    const host = url.hostname.toLowerCase();

    if (host === "claude.ai") return { ok: false, error: "Por ahora solo recibimos enlaces de ChatGPT. Los de Claude llegarán pronto." };
    if (host === "gemini.google.com" || host === "g.co") return { ok: false, error: "Por ahora solo recibimos enlaces de ChatGPT. Los de Gemini llegarán pronto." };
    if (url.protocol !== "https:" || HOSTS_CHATGPT.indexOf(host) === -1) {
      return { ok: false, error: "Por ahora solo recibimos enlaces de ChatGPT, como https://chatgpt.com/share/…" };
    }
    if (url.pathname.indexOf("/share/") !== 0 || url.pathname.length <= "/share/".length) {
      return { ok: false, error: "Falta el identificador de la conversación. Usa el enlace que aparece al pulsar Compartir y Crear enlace." };
    }
    return { ok: true, enlace: texto };
  }

  inEnlace.addEventListener("input", () => {
    ocultar($("#err-enlace"));
    const r = revisarEnlace(inEnlace.value);
    if (r.ok) {
      ayudaEnlace.textContent = "Enlace de ChatGPT reconocido.";
      ayudaEnlace.classList.add("ayuda--ok");
    } else {
      ayudaEnlace.textContent = AYUDA_INICIAL;
      ayudaEnlace.classList.remove("ayuda--ok");
    }
  });

  $("#form-enlace").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#err-enlace");
    ocultar(errEl);

    const r = revisarEnlace(inEnlace.value);
    if (!r.ok) {
      mostrar(errEl, r.error);
      inEnlace.focus();
      return;
    }

    const boton = $("button[type=submit]", e.currentTarget);
    boton.disabled = true;
    try {
      const envio = await llamar("/api/enviar", { metodo: "POST", cuerpo: { enlace: r.enlace } });
      if (!envio.servidor_en_linea) {
        // El servidor que lee las conversaciones está apagado: queda en fila y se avisa por correo.
        mostrarGracias({ enFila: true });
        return;
      }
      irA("extraccion");
      await seguirTrabajo(envio.job_id);
    } catch (err) {
      if (err.estado === 401) return sesionVencida();
      mostrar(errEl, err.message);
    } finally {
      boton.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Paso 5 · extracción (la constelación)
  // ------------------------------------------------------------------

  const NS = "http://www.w3.org/2000/svg";
  const figura = $("#trayectoria");
  const svg = $("#svg-trayectoria");
  const caminoBase = $("#camino-base");
  const caminoTrazo = $("#camino-trazo");
  const pulso = $("#pulso");
  const grupoEstrellas = $("#estrellas");
  const leyenda = $("#leyenda");
  const estadoFase = $("#estado-fase");
  let largoCamino = 0; // se mide cuando la figura ya es visible
  let animandoPulso = false;

  const FRASES = {
    en_cola: "Esperando turno…",
    abriendo: "Abriendo tu enlace…",
    leyendo: "Leyendo la conversación…",
    procesando: "Quitando correos y teléfonos…",
    guardando: "Guardando de forma segura…",
    listo: "Listo.",
  };
  const ORDEN_FASES = ["en_cola", "abriendo", "leyendo", "procesando", "guardando", "listo"];

  function colocarFigura(sitioId) {
    $(sitioId).appendChild(figura);
    figura.hidden = false;
    largoCamino = caminoBase.getTotalLength();
  }

  function reiniciarTrayectoria() {
    animandoPulso = false;
    figura.classList.remove("revelada");
    grupoEstrellas.textContent = "";
    leyenda.hidden = true;
    pulso.hidden = true;
    svg.style.setProperty("--largo", String(largoCamino));
    caminoTrazo.style.strokeDashoffset = "";
  }

  function iniciarPulso() {
    if (MOVIMIENTO_REDUCIDO) {
      const p0 = caminoBase.getPointAtLength(0);
      pulso.setAttribute("cx", p0.x);
      pulso.setAttribute("cy", p0.y);
      pulso.hidden = false;
      return;
    }
    animandoPulso = true;
    pulso.hidden = false;
    const periodo = 3400;
    const inicio = performance.now();
    function cuadro(ahora) {
      if (!animandoPulso) return;
      const fraccion = ((ahora - inicio) % periodo) / periodo;
      const p = caminoBase.getPointAtLength(largoCamino * fraccion);
      pulso.setAttribute("cx", p.x);
      pulso.setAttribute("cy", p.y);
      requestAnimationFrame(cuadro);
    }
    requestAnimationFrame(cuadro);
  }

  function detenerPulso() {
    animandoPulso = false;
    pulso.hidden = true;
  }

  function pintarFase(fase, turnos) {
    let texto = FRASES[fase] || "";
    if ((fase === "procesando" || fase === "guardando") && turnos.length) {
      texto = `Encontramos ${turnos.length} turnos. ${texto}`;
    }
    estadoFase.textContent = texto;
  }

  async function revelarTrayectoria(turnos) {
    detenerPulso();
    const n = turnos.length;
    if (!n) return;
    estadoFase.textContent = `Encontramos ${n} ${plural(n, "turno", "turnos")}.`;

    const radio = Math.max(3, Math.min(7, 8 - n / 20));
    const margen = 0.04;
    const duracion = MOVIMIENTO_REDUCIDO ? 0 : Math.max(1400, Math.min(3000, n * 110));
    const pasoMs = n > 1 ? duracion / n : 0;

    svg.style.setProperty("--dur-trazo", duracion + "ms");

    const estrellas = turnos.map((rol, i) => {
      const fraccion = margen + ((i + 0.5) / n) * (1 - 2 * margen);
      const largo = largoCamino * fraccion;
      const p = caminoBase.getPointAtLength(largo);
      const antes = caminoBase.getPointAtLength(Math.max(0, largo - 2));
      const despues = caminoBase.getPointAtLength(Math.min(largoCamino, largo + 2));
      let nx = -(despues.y - antes.y);
      let ny = despues.x - antes.x;
      const norma = Math.hypot(nx, ny) || 1;
      nx /= norma;
      ny /= norma;
      // La persona queda por encima del trazo; el asistente, por debajo.
      const lado = rol === "user" ? -1 : 1;
      const separacion = 11;

      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", (p.x + nx * lado * separacion).toFixed(1));
      c.setAttribute("cy", (p.y + ny * lado * separacion).toFixed(1));
      c.setAttribute("r", radio.toFixed(1));
      c.setAttribute("class", "estrella " + (rol === "user" ? "estrella--persona" : "estrella--asistente"));
      grupoEstrellas.appendChild(c);
      return c;
    });

    // Un fotograma para que el navegador registre el estado inicial.
    await dormir(30);
    figura.classList.add("revelada");
    estrellas.forEach((c, i) => {
      if (MOVIMIENTO_REDUCIDO) c.classList.add("encendida");
      else setTimeout(() => c.classList.add("encendida"), i * pasoMs);
    });

    await dormir(duracion + 500);
    leyenda.hidden = false;
  }

  async function seguirTrabajo(jobId) {
    const MINIMO_POR_FASE = 800;
    const LIMITE = 4 * 60 * 1000;

    ocultar($("#err-extraccion"));
    $("#acciones-error").hidden = true;
    $("#t-extraccion").textContent = "Leyendo tu conversación";
    estadoFase.textContent = FRASES.en_cola;
    colocarFigura("#sitio-trayectoria-extraccion");
    reiniciarTrayectoria();
    iniciarPulso();

    const limiteTiempo = Date.now() + LIMITE;
    let turnos = [];
    let mostrada = -1;
    let ultimoCambio = 0;
    let falla = null;
    let consultasSinServidor = 0;

    while (true) {
      if (Date.now() > limiteTiempo) {
        // El enlace sigue en fila en el servidor: se avisará por correo al terminar.
        detenerPulso();
        mostrarGracias({ enFila: true, tardo: true });
        return;
      }

      let estado;
      try {
        estado = await llamar("/api/estado/" + encodeURIComponent(jobId));
      } catch (err) {
        if (err.estado === 401) { detenerPulso(); return sesionVencida(); }
        falla = err.message;
        break;
      }

      // Si el servidor se apagó antes de tomar el enlace, no tiene caso seguir esperando aquí.
      if (estado.fase === "en_cola" && estado.servidor_en_linea === false) consultasSinServidor += 1;
      else consultasSinServidor = 0;
      if (consultasSinServidor >= 2) {
        detenerPulso();
        mostrarGracias({ enFila: true });
        return;
      }

      if (estado.turnos && estado.turnos.length) turnos = estado.turnos;
      if (estado.fase === "error") {
        falla = estado.error || "No pudimos leer esa conversación.";
        break;
      }

      // Cada fase se muestra al menos un momento, aunque el servidor vaya rápido.
      const destino = ORDEN_FASES.indexOf(estado.fase);
      while (mostrada < destino) {
        const espera = Math.max(0, MINIMO_POR_FASE - (Date.now() - ultimoCambio));
        if (mostrada >= 0 && espera > 0) await dormir(espera);
        mostrada += 1;
        ultimoCambio = Date.now();
        pintarFase(ORDEN_FASES[mostrada], turnos);
      }

      if (estado.fase === "listo") break;
      await dormir(900);
    }

    if (falla) {
      detenerPulso();
      estadoFase.textContent = "";
      $("#t-extraccion").textContent = "No pudimos leer tu conversación";
      $("#err-extraccion").textContent = falla;
      $("#err-extraccion").hidden = false;
      $("#acciones-error").hidden = false;
      return;
    }

    sesion.turnos = turnos;
    await revelarTrayectoria(turnos);
    await dormir(MOVIMIENTO_REDUCIDO ? 300 : 900);
    mostrarGracias();
  }

  $("#btn-otro-enlace").addEventListener("click", () => {
    detenerPulso();
    irA("enlace");
    inEnlace.focus();
  });

  // ------------------------------------------------------------------
  // Paso 6 · gracias e invitaciones
  // ------------------------------------------------------------------

  function plural(n, uno, varios) { return n === 1 ? uno : varios; }

  function mostrarGracias({ enFila = false, tardo = false } = {}) {
    const titulo = $("#t-gracias");
    const resumen = $("#resumen-gracias");

    if (enFila) {
      titulo.textContent = "Tu enlace quedó en fila";
      const destino = sesion.email ? "a " + sesion.email : "a tu correo";
      resumen.textContent =
        (tardo ? "Esto está tardando más de lo normal, pero tu enlace sigue en fila. " : "") +
        "Leemos las conversaciones cuando nuestro servidor está en línea, y a veces tarda unos días. " +
        `Te escribiremos ${destino} cuando esté lista. ` +
        "Mantén activo el enlace que compartiste hasta entonces.";
      reiniciarTrayectoria();
      figura.hidden = true;
    } else {
      titulo.textContent = "Gracias por compartir tu conversación";
      const total = sesion.turnos.length;
      const tuyos = sesion.turnos.filter((t) => t === "user").length;
      const asistente = total - tuyos;
      resumen.textContent =
        `Recibimos ${total} ${plural(total, "turno", "turnos")}: ` +
        `${tuyos} ${plural(tuyos, "tuyo", "tuyos")} y ` +
        `${asistente} del asistente. Ya quedó guardada.`;
      colocarFigura("#sitio-trayectoria-gracias");
      leyenda.hidden = false;
    }

    pintarServicios();
    irA("gracias");
  }

  function pintarServicios() {
    const lista = $("#lista-servicios");
    lista.textContent = "";
    (CFG.SERVICIOS || []).forEach((s) => {
      const li = document.createElement("li");
      const contenedor = document.createElement(s.url ? "a" : "div");
      contenedor.className = "servicio";
      if (s.url) {
        contenedor.href = s.url;
        contenedor.rel = "noopener";
      }

      const nombre = document.createElement("span");
      nombre.className = "servicio__nombre";
      nombre.textContent = s.nombre;
      contenedor.appendChild(nombre);

      const estado = document.createElement("span");
      estado.className = "servicio__estado";
      estado.textContent = s.url ? "Abrir" : "Próximamente";
      contenedor.appendChild(estado);

      if (s.descripcion) {
        const desc = document.createElement("span");
        desc.className = "servicio__desc";
        desc.textContent = s.descripcion;
        contenedor.appendChild(desc);
      }

      li.appendChild(contenedor);
      lista.appendChild(li);
    });
  }

  $("#btn-otra").addEventListener("click", () => {
    reiniciarTrayectoria();
    figura.hidden = true;
    inEnlace.value = "";
    ayudaEnlace.textContent = AYUDA_INICIAL;
    ayudaEnlace.classList.remove("ayuda--ok");
    ocultar($("#err-enlace"));
    irA("enlace");
    inEnlace.focus();
  });

  // ------------------------------------------------------------------
  // Arranque: retomar la sesión si el token sigue vigente
  // ------------------------------------------------------------------

  async function arrancar() {
    irA("correo");
    if (DEMO) return;
    const token = tokenGuardado();
    if (!token) return;
    sesion.token = token;
    try {
      await siguientePasoTrasEntrar();
    } catch (_) {
      olvidarToken();
      irA("correo");
    }
  }

  arrancar();
})();
