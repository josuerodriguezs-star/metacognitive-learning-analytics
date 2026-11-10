# endurance · recolector aislado

Lo que corre en tu laptop para leer las conversaciones y guardarlas. Está pensado para que **endurance no
exponga ningún puerto**: todo es conexión de salida.

## Qué lo mantiene cerrado

| Capa | Qué hace |
|---|---|
| Sin puertos publicados | `docker-compose.yml` no tiene ningún `ports:`. Nada escucha hacia afuera. |
| Mongo en red interna | La red `interna` no tiene salida a internet; solo el recolector llega a Mongo. Mongo corre sin privilegios (`user 999`, `cap_drop ALL`) y con autenticación; el recolector usa un usuario que solo puede escribir en la base `transcripts`. |
| Recolector sin privilegios | Usuario `pwuser`, sistema de archivos de solo lectura, `cap_drop ALL`, `no-new-privileges`, límites de memoria, CPU y procesos. |
| Firewall del contenedor | `firewall.sh` impide que el recolector alcance tu red local, tu router, tu tailnet y a endurance mismo. Si una página maliciosa tomara el navegador, no tendría adónde ir. |
| Solo enlaces permitidos | El navegador solo visita `https://chatgpt.com/share/<id>` (se valida en la nube y otra vez aquí). |
| Token propio | El recolector se identifica ante el Worker con `PULLER_TOKEN`; el Worker bloquea la IP tras intentos fallidos. |
| Sin texto en logs | El log nunca incluye enlaces ni contenido de conversaciones. |

## Instalación

Requisitos: Docker con Compose, `iptables` y el repositorio clonado (por ejemplo en `/opt/yohual`).

```bash
cd /opt/yohual/endurance

# 1. Carpeta de datos de Mongo y archivo .env con contraseñas aleatorias
./instalar.sh

# 2. Pasa el PULLER_TOKEN al Worker sin mostrarlo en pantalla
grep '^PULLER_TOKEN=' .env | cut -d= -f2 | (cd ../worker && npx wrangler secret put PULLER_TOKEN)

# 3. Construir y encender
docker compose build
docker compose up -d

# 4. Firewall del contenedor (y que sobreviva al reinicio)
sudo ./firewall.sh instalar
sudo cp yohual-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable yohual-firewall.service     # edita la ruta dentro del archivo si no usaste /opt/yohual

# 5. Comprobar que quedó cerrado
./verificar.sh
```

`verificar.sh` revisa que ningún contenedor publique puertos, que Mongo no tenga salida, que las reglas estén
puestas y que el recolector **no** alcance tu router ni a endurance, pero **sí** a conversaciones.yohual.com.
Imprime OK o FALLA en cada línea y lista los puertos que escuchan en endurance.

## Uso diario

```bash
# Prender: jala mientras endurance esté encendida, y vuelve solo cada vez que la prendas
docker compose up -d

# Apagar: se detiene y no vuelve hasta el próximo "up -d"
docker compose stop

# Solo cuando tú decidas: lee todo lo pendiente y termina
docker compose run --rm recolector --una-vez
docker compose stop mongo

# Ver qué hace (el log no muestra enlaces ni contenido)
docker compose logs -f recolector

# Cuántas conversaciones hay guardadas
docker compose exec mongo sh -c 'mongosh -u "$MONGO_APP_USER" -p "$MONGO_APP_PASSWORD" transcripts --quiet --eval "db.conversaciones_participantes.countDocuments()"'
```

Al apagarse, el recolector avisa al Worker; si se apaga de golpe, el Worker lo da por desconectado a los 2
minutos. En ambos casos las personas ven "tu enlace quedó en fila" y reciben correo cuando se lea.

## Respaldo

```bash
docker compose exec -T mongo sh -c 'mongodump -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' > respaldo-$(date +%F).gz
```

Guarda ese archivo en un lugar cifrado: contiene las conversaciones.

## Cifrado del disco

Mongo guarda en `/srv/yohual/mongo`. Si alguien se llevara la laptop, esos datos se leerían. Comprueba si el
disco ya está cifrado:

```bash
lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT | grep -i crypt
```

Si aparece algo con `crypt` bajo `/`, ya estás cubierto. Si no, puedes crear un volumen cifrado solo para los
datos (cámbiale el tamaño a tu gusto; te pedirá una contraseña que debes guardar):

```bash
sudo fallocate -l 20G /var/lib/yohual.img
sudo cryptsetup luksFormat /var/lib/yohual.img
sudo cryptsetup open /var/lib/yohual.img yohual
sudo mkfs.ext4 /dev/mapper/yohual
sudo mkdir -p /srv/yohual && sudo mount /dev/mapper/yohual /srv/yohual
./instalar.sh        # vuelve a correrlo para crear /srv/yohual/mongo con los permisos correctos
```

Tras cada reinicio hay que abrirlo y montarlo antes de `docker compose up -d`
(`sudo cryptsetup open /var/lib/yohual.img yohual && sudo mount /dev/mapper/yohual /srv/yohual`).
Si el volumen no está montado, Mongo no arranca: es lo esperado.

## Más protección en endurance (opcional)

Con esto, nada del proyecto escucha en endurance. Si además quieres que endurance rechace conexiones entrantes
en general, ten en cuenta que puedes dejar de poder entrar por SSH:

```bash
sudo ufw default deny incoming
sudo ufw allow in on tailscale0          # solo si entras por Tailscale
# sudo ufw allow from 192.168.0.0/16 to any port 22     # solo si entras por SSH desde tu red local
sudo ufw enable
```

Confirma antes por dónde entras tú, para no quedarte fuera.

## Si algo falla

- **`docker compose up` no arranca Mongo:** casi siempre es permisos de la carpeta de datos. Corre
  `./instalar.sh` otra vez, o `sudo chown -R 999:999 /srv/yohual/mongo`.
- **El recolector dice "Falta la variable de entorno":** revisa `.env`.
- **El recolector no llega al Worker:** prueba
  `docker compose run --rm --no-deps --entrypoint python recolector -c "import urllib.request as u; print(u.urlopen('https://conversaciones.yohual.com/').status)"`.
- **El firewall bloquea el DNS de tu red:** no debería (Docker resuelve nombres desde el anfitrión); si pasa,
  `sudo ./firewall.sh quitar` y avísame para ajustarlo.
- **Quitar todo:** `docker compose down` conserva los datos; para borrarlos hay que eliminar `/srv/yohual/mongo`
  a propósito.

## Sin probar todavía

El entorno donde se escribió esto no tiene un servicio de Docker, así que **no se han ejecutado** los
contenedores, `mongo-init.sh`, `firewall.sh` ni `verificar.sh`; sí se validó la sintaxis de los scripts y la
configuración de Compose (`docker compose config`). La lógica del recolector y del Worker sí se probó de
extremo a extremo. Corre `./verificar.sh` en endurance y confirma que todo salga en OK antes de compartir el
enlace; si algo falla, el mensaje dice qué.
