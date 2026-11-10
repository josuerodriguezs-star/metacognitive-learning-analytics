#!/usr/bin/env bash
# Impide que el contenedor del recolector alcance tu red local, tu tailnet o el
# propio endurance. El recolector abre páginas de internet; si una página
# maliciosa lograra algo, no debe poder tocar nada de tu casa.
#
#   sudo ./firewall.sh instalar   agrega las reglas (se pueden repetir sin duplicarse)
#   sudo ./firewall.sh quitar     las quita
#   sudo ./firewall.sh estado     las muestra
#
# Para que sobrevivan al reinicio, usa yohual-firewall.service (ver README).

set -euo pipefail

SUBRED="172.29.77.0/24"   # debe coincidir con la red "salida" de docker-compose.yml
BLOQUEADOS=(
  10.0.0.0/8        # redes privadas
  172.16.0.0/12
  192.168.0.0/16    # tu red local y tu router
  100.64.0.0/10     # Tailscale
  169.254.0.0/16    # enlace local y metadatos de nube
  127.0.0.0/8
  224.0.0.0/4       # multicast
)

[ "$(id -u)" -eq 0 ] || { echo "Ejecútalo con sudo."; exit 1; }
command -v iptables >/dev/null || { echo "Falta iptables."; exit 1; }
iptables -S DOCKER-USER >/dev/null 2>&1 || { echo "No existe la cadena DOCKER-USER: ¿Docker está corriendo?"; exit 1; }

accion="${1:-}"

agregar() {   # cadena, regla...
  local cadena="$1"; shift
  iptables -C "$cadena" "$@" 2>/dev/null || iptables -I "$cadena" 1 "$@"
}
quitar() {
  local cadena="$1"; shift
  while iptables -C "$cadena" "$@" 2>/dev/null; do iptables -D "$cadena" "$@"; done
}

case "$accion" in
  instalar)
    for destino in "${BLOQUEADOS[@]}"; do
      agregar DOCKER-USER -s "$SUBRED" -d "$destino" -m comment --comment yohual-recolector -j DROP
    done
    # Hacia el propio endurance (SSH, servicios locales...)
    agregar INPUT -s "$SUBRED" -m conntrack --ctstate NEW -m comment --comment yohual-recolector -j DROP
    echo "Reglas instaladas para $SUBRED."
    ;;
  quitar)
    for destino in "${BLOQUEADOS[@]}"; do
      quitar DOCKER-USER -s "$SUBRED" -d "$destino" -m comment --comment yohual-recolector -j DROP
    done
    quitar INPUT -s "$SUBRED" -m conntrack --ctstate NEW -m comment --comment yohual-recolector -j DROP
    echo "Reglas quitadas."
    ;;
  estado)
    iptables -S DOCKER-USER | grep yohual-recolector || echo "Sin reglas en DOCKER-USER."
    iptables -S INPUT | grep yohual-recolector || echo "Sin reglas en INPUT."
    ;;
  *)
    echo "Uso: sudo $0 instalar|quitar|estado"
    exit 2
    ;;
esac
