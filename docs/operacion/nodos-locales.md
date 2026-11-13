# Operación de varios nodos locales en una misma PC (demostración)

Cada farmacia es un **nodo local** con su propio proyecto Neon y su propio API. Todos comparten el **nodo central** (proyecto `…nodo central`). Este documento describe cómo se levantan dos tiendas en esta PC.

| Nodo | Tienda (id) | Proyecto Neon | API | Interfaz |
|---|---|---|---|---|
| Central | — | `orange-mud-99595714` (…nodo central) | — | — |
| Farmacia Centro | 1 | `empty-breeze-80649012` (…nodo farmacia sur) | `localhost:4000` | `localhost:5173` |
| Farmacia Norte | 2 | `blue-bonus-52459987` (…nodo farmacia norte) | `localhost:4001` | `localhost:5174` |

## Configuración (`.env`)

El `.env` tiene la conexión al central, a la tienda 1 (`LOCAL_DATABASE_URL`, `LOCAL_DATABASE_URL_UNPOOLED`) y a la tienda 2 (`LOCAL_DATABASE_URL_TIENDA2`, `LOCAL_DATABASE_URL_UNPOOLED_TIENDA2`). Un proceso solo usa una base local: la que le pasan por variables de entorno, que tienen prioridad sobre el `.env` (`apps/api/config.mjs`).

Las dos tiendas tienen el mismo formato: las cadenas (`*_DATABASE_URL*`) y las variables sueltas (`LOCAL_PGHOST`, `LOCAL_PGUSER`, `LOCAL_PGPASSWORD`, `LOCAL_PGDATABASE`, `LOCAL_PGPORT`, `LOCAL_PGSSLMODE`; para la tienda 2 con el sufijo `_TIENDA2`). El API solo lee las cadenas; las variables sueltas son para clientes como `psql`.

**Importante:** `urlDe` prefiere `*_UNPOOLED` sobre `*_DATABASE_URL`. Para cambiar de base local hay que fijar **las dos** variables del nodo.

## Rol de aplicación y rol propietario
Cada base tiene dos conexiones: el **propietario** (`neondb_owner`, variables `*_DATABASE_URL`) y el **rol de aplicación** `farmahub_datos` (variables `*_DATABASE_URL_APP` y `*_DATABASE_URL_UNPOOLED_APP`). El API trabaja con el rol de aplicación, que no puede crear ni alterar tablas, no puede vaciarlas y no puede modificar ni borrar las tablas de auditoría. Las migraciones (`apps/api/migrate.mjs`) usan siempre el propietario. Para la tienda 2 se usan las variables con el sufijo `_TIENDA2_APP`.

`FARMAHUB_ROL=owner` hace que el API use el propietario también en tiempo de ejecución. Solo lo fijan las pruebas (`scripts/lib/owner.mjs`), que necesitan sembrar y limpiar datos; no debe usarse al operar un nodo. Los scripts de prueba que escriben en el central usan los helpers de `scripts/lib/central.mjs` para que cada cambio publique su evento de réplica (ver `docs/seguridad/escritura-central.md`).

## Arrancar la tienda 1
```bash
node apps/api/server.mjs
```

## Arrancar la tienda 2
```bash
export LOCAL_DATABASE_URL="$(grep -E '^LOCAL_DATABASE_URL_TIENDA2=' .env | cut -d= -f2- | tr -d '"')"
export LOCAL_DATABASE_URL_UNPOOLED="$(grep -E '^LOCAL_DATABASE_URL_UNPOOLED_TIENDA2=' .env | cut -d= -f2- | tr -d '"')"
export LOCAL_DATABASE_URL_APP="$(grep -E '^LOCAL_DATABASE_URL_TIENDA2_APP=' .env | cut -d= -f2- | tr -d '"')"
export LOCAL_DATABASE_URL_UNPOOLED_APP="$(grep -E '^LOCAL_DATABASE_URL_UNPOOLED_TIENDA2_APP=' .env | cut -d= -f2- | tr -d '"')"
export LOCAL_TIENDA_ID=2 SEED_DEMO=0 PORT=4001
export CORS_ORIGIN="http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174"
node apps/api/server.mjs
```
La primera vez tarda unos 2 minutos: aplica el esquema y replica el catálogo y el personal del central. Está listo cuando aparece `API FarmaHub en http://localhost:4001 (tienda 2)`.

## Interfaces
```bash
cd apps/web && npx vite --host 127.0.0.1 --port 5173                      # tienda 1 (por defecto)
cd apps/web && FARMAHUB_API=http://localhost:4001 npx vite --host 127.0.0.1 --port 5174   # tienda 2
```

## Cuentas de demostración
- Tienda 1: `cajero1`, `admin.tienda` (contraseña `Farma123`).
- Tienda 2: `cajero2`, `admin.tienda2` (contraseña `Farma123`).
- Central: `admin.general` (contraseña `Farma123`).

Las cuentas de la tienda 2 se crearon desde el central y se activaron con un código de un solo uso (HU-07). Son de demostración: no deben usarse fuera de ella.

## Dar de alta una tienda nueva (resumen)
1. Crear el proyecto Neon del nodo y guardar sus dos URLs en `.env` con el sufijo de la tienda.
2. Dar de alta la tienda en el central (`POST /api/central/tiendas`, HU-15). Anotar su id.
3. Aplicar el esquema del nodo: arrancarlo una vez con sus variables y `SEED_DEMO=0`, o correr `migrate` (ver `scripts/db-verificar.mjs` para comprobar que coincide con los scripts).
4. Crear el personal en el central (`POST /api/central/empleados`) y activarlo con `POST /api/central/empleados/{id}/codigo` y `POST /api/central/auth/restablecer`.
5. Arrancar el nodo con `LOCAL_TIENDA_ID` igual al id del paso 2.

## Verificación rápida
- `GET /api/health` responde `{"ok":true}` en cada puerto.
- Login de un cajero de cada tienda.
- Un traslado de la tienda 2 a la tienda 1 pasa por `SOLICITADO → EN_TRANSITO → COMPLETADO` en el central en unos 30 segundos.

## Limitaciones de esta demostración
- Ambos nodos corren en la misma PC; en un entorno real cada farmacia tiene su propio equipo y su conexión.
- La base local de cada nodo está en Neon (nube), igual que en el diseño actual del proyecto.
- Las tiendas de prueba de HU-17 (ids 108 a 318) siguen inactivas en el central; no afectan a las dos tiendas.
