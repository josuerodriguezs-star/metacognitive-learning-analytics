// Configuración del recolector de conversaciones.
//
// API_BASE_URL    Vacío: la API vive en el mismo sitio (el Worker de
//                 Cloudflare sirve la página y la API juntas).
// HOME_URL        A dónde lleva "Volver al inicio".
// CONTACTO_EMAIL  Correo que aparece en el consentimiento para pedir el
//                 borrado de una conversación. Debe existir y atenderse.
// SERVICIOS       Invitaciones de la pantalla final. Una entrada sin "url"
//                 se muestra como "Próximamente".
//
// Para ver la interfaz sin servidor: abre la página con ?demo (recorrido
// completo), ?demo=fila (servidor apagado) o ?demo=error (fallo de lectura).
window.CONFIG = {
  API_BASE_URL: "",
  HOME_URL: "https://yohual.com",
  CONTACTO_EMAIL: "contacto@yohual.com",
  SERVICIOS: [
    {
      nombre: "Calendario EdTech",
      descripcion: "Convocatorias y fechas de premios de educación y tecnología, con avisos cercanos a cada cierre.",
      url: "https://calendario.yohual.com"
    },
    {
      nombre: "Simulador de proyectos QS",
      descripcion: "Practica la evaluación de un proyecto con la lógica de los criterios QS.",
      url: ""
    },
    {
      nombre: "Journalist",
      descripcion: "",
      url: ""
    }
  ]
};
