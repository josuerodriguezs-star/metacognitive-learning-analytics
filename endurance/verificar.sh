#!/usr/bin/env bash
# Comprueba que endurance quedó cerrado. Ejecútalo después de `docker compose up -d`
# y de instalar el firewall. Cada línea dice OK o FALLA.
set -uo pipefail
cd "$(dirname "$0")"

fallas=0
ok()    { echo "OK     $*"; }
falla() { echo "FALLA  $*"; fallas=$((fallas + 1)); }

# 1. Ningún contenedor del proyecto publica puertos hacia el anfitrión.
publicados="$(docker ps --filter label=com.docker.compose.project=yohual --format '{{.Names}} {{.Ports}}' | grep -- '->' || true)"
[ -z "$publicados" ] && ok "ningún contenedor publica puertos" || falla "puertos publicados: $publicados"

# 2. Mongo está en una red sin salida.
interna="$(docker network inspect yohual_interna --format '{{.Internal}}' 2>/dev/null || echo "?")"
[ "$interna" = "true" ] && ok "la red de Mongo no tiene salida a internet" || falla "yohual_interna no es interna ($interna)"

# 3. El firewall está instalado.
if sudo -n iptables -S DOCKER-USER 2>/dev/null | grep -q yohual-recolector; then
  ok "reglas de firewall instaladas"
else
  falla "no veo las reglas de firewall (¿sudo ./firewall.sh instalar?)"
fi

# 4. Pruebas desde dentro del recolector.
prueba() {   # descripción, código python que imprime "alcanzable", "bloqueado" o "rechazado"
  docker compose run --rm --no-deps -T --entrypoint python recolector -c "$2" 2>/dev/null | tail -1
}

SALIDA="$(prueba salida 'import urllib.request as u
try:
    u.urlopen("https://conversaciones.yohual.com/", timeout=10); print("alcanzable")
except Exception as e:
    print("alcanzable" if getattr(e, "code", None) else "bloqueado")')"
[ "$SALIDA" = "alcanzable" ] && ok "el recolector llega al Worker en internet" || falla "el recolector no llega a conversaciones.yohual.com ($SALIDA)"

PROBAR_TCP='import socket,sys
h,p=sys.argv[1],int(sys.argv[2])
s=socket.socket(); s.settimeout(4)
try:
    s.connect((h,p)); print("alcanzable")
except socket.timeout:
    print("bloqueado")
except ConnectionRefusedError:
    print("rechazado")
except Exception:
    print("bloqueado")'

tcp() {   # host, puerto
  docker compose run --rm --no-deps -T --entrypoint python recolector -c "$PROBAR_TCP" "$1" "$2" 2>/dev/null | tail -1
}

PUERTA="$(ip route show default | awk '/default/ {print $3; exit}')"
LOCAL="$(ip route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"

for destino in "$PUERTA:80" "$PUERTA:443" "$LOCAL:22"; do
  host="${destino%%:*}"; puerto="${destino##*:}"
  [ -z "$host" ] && continue
  r="$(tcp "$host" "$puerto")"
  case "$r" in
    bloqueado)  ok "el recolector no puede alcanzar $destino" ;;
    *)          falla "el recolector pudo tocar $destino ($r): revisa firewall.sh" ;;
  esac
done

echo
echo "Puertos que escuchan en endurance (revisa que no haya nada inesperado):"
ss -tlnH 2>/dev/null | awk '{print "  " $4}' | sort -u

echo
[ "$fallas" -eq 0 ] && echo "Todo en orden." || echo "$fallas comprobación(es) fallaron."
exit "$fallas"
