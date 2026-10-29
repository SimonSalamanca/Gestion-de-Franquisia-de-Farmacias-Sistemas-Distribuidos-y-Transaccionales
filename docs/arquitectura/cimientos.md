# Cimientos de la API: cómo agregar una historia sin romper las demás

Guía para quien implemente una HU nueva sobre `apps/api`. Resume dónde va cada cosa y las reglas que mantienen el sistema distribuido consistente.

## Mapa del código

```
apps/api/
  config.mjs            Lee .env (las variables del proceso tienen prioridad) y valida la configuración
  db.mjs                Pools central/local, withTx, lectura de timestamp como UTC
  migrate.mjs           Aplica db/<nodo>/*.sql y siembra los datos demo
  http.mjs              readBody, send (CORS), tokenDe y el router mínimo
  server.mjs            Arranque, ciclo de sincronización y registro de rutas
  routes/<dominio>.mjs  Rutas HTTP de cada dominio (sistema, auth, ...)
  auth.mjs              Lógica de HU-06 (login, sesión, permisos)
  sync.mjs              Estado del enlace, pull del log de réplica y envío del outbox
  sync/handlers/        Un archivo por dominio con los handlers de cada tipo de evento
db/
  central/NN_*.sql      Scripts del nodo central, en orden
  local/NN_*.sql        Scripts del nodo local (farmacia), en orden
scripts/
  db-migrate.mjs        npm run db:migrate
  db-verificar.mjs      npm run db:verificar
```

`Script_BDFarmacias_nodo_*.sql` (en la raíz) son el entregable original del diseño de la base. `db/<nodo>/00_base.sql` es su copia ejecutable en Neon (sin `CREATE DATABASE` ni `\connect`).

## Scripts SQL

- Cada historia que necesite esquema agrega **un archivo nuevo** en `db/central/` y/o `db/local/` con el siguiente número: `02_hu15_tiendas.sql`, `03_hu20_ventas.sql`, ...
- **Todo script, salvo `00_base.sql`, debe ser idempotente**, porque se ejecuta en cada arranque: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `INSERT ... ON CONFLICT DO NOTHING` o `WHERE NOT EXISTS`.
- `00_base.sql` solo corre cuando la base está vacía (no existe `empleado` en el central ni `empleado_ref` en el local).
- No se edita un script que ya se aplicó en una base compartida; el cambio va en un script nuevo.
- La API aplica los scripts al arrancar. `npm run db:migrate` hace lo mismo sin levantar el servidor.

### Detectar bases desincronizadas

`npm run db:verificar` compara, en solo lectura, las tablas, columnas, restricciones, índices, vistas y funciones que definen los scripts con lo que tiene la base del `.env`. Si alguien aplicó un cambio en Neon sin subir su script, aparece aquí. Con `-- --estricto` devuelve código 1 cuando hay diferencias (útil en CI).

## Replicación central → local

El central publica eventos en `replica_evento` (con `append_replica_evento`); cada nodo local los lee en orden con su cursor y los aplica en una transacción.

Para un tipo de evento nuevo:

1. Publicarlo en el central: `select append_replica_evento(<id_tienda o null>, 'MI_EVENTO', <version>, <payload jsonb>)`. Con destino `null` llega a todas las tiendas.
2. Crear o ampliar `apps/api/sync/handlers/<dominio>.mjs`:
   ```js
   async function miEvento(client, event, idTienda) {
     // client: transacción del pull en el nodo local. event: { id_evento, tipo_evento, payload, ... }
   }
   export default { MI_EVENTO: miEvento };
   ```
3. Registrar el archivo en `sync/handlers/index.mjs` (si es un dominio nuevo).

Reglas:
- El handler debe ser **idempotente** (`on conflict do update`): un evento puede aplicarse más de una vez.
- Si falta una dependencia (por ejemplo, un medicamento que aún no llegó), registre un `sync_conflicto` y retorne. **No lance un error**, porque abortaría el lote y bloquearía la réplica de esa tienda.
- Un tipo sin handler queda registrado como `EVENTO_DESCONOCIDO` en `sync_conflicto` y el cursor avanza. El evento sigue en el central para reaplicarlo.

## Envío local → central (outbox)

Las operaciones que el central debe conocer se encolan en `outbox_sync` dentro de la misma transacción local, con una `idempotency_key` UUID. El ciclo de sincronización las envía en orden por empleado; el central las registra en `inbox_sync` para descartar duplicados.

## Identificadores entre nodos

Las tablas transaccionales del nodo local (`factura`, `lote`, `movimiento_inventario`, ...) usan IDs seriales **propios de cada tienda**: la factura 1 existe en todas las tiendas.

**Todo lo que suba al central se identifica por `(id_tienda, id_local)`**, nunca por el ID local solo. Incluya `id_tienda` en el payload y en la clave de cualquier tabla del central que guarde datos de tiendas. Los datos maestros (`tienda`, `empleado`, `medicamento`, ...) solo se crean en el central, así que su ID es global.

## Fechas

Neon corre en GMT. La API lee las columnas `timestamp without time zone` como UTC y envía las fechas en UTC (`db.mjs`). Use `now()` de la base para plazos (bloqueos, vencimientos), no la hora del servidor de la API. Muestre la hora local solo en el frontend.

## Rutas HTTP

Cree `apps/api/routes/<dominio>.mjs` y regístrelo en `server.mjs` con `.usar(...)`:

```js
import { readBody, send, tokenDe } from "../http.mjs";
import { sesionDe } from "../auth.mjs";

export default function ventas(router) {
  router.post("/api/local/ventas", async (req, res) => {
    const sesion = await sesionDe(tokenDe(req), "local");
    if (!sesion?.permisos.includes("VENTA_REGISTRAR")) return send(res, 403, { codigo: "ACCESO_DENEGADO" });
    const body = await readBody(req);
    // ...
  });
}
```

El permiso se valida en cada request (`sesionDe` devuelve los permisos vigentes). Ocultar un botón en el frontend no autoriza.

## Configuración

Ver `.env.example`. Las principales:

| Variable | Uso | Por defecto |
|---|---|---|
| `LOCAL_TIENDA_ID` | Tienda a la que pertenece el nodo local | `1` |
| `AUTH_PEPPER` | Secreto del HMAC de idempotencia (obligatorio en producción) | valor de desarrollo |
| `SEED_DEMO` | Crea los usuarios demo (`Farma123`) | `1` (`0` en producción) |
| `FARMAHUB_SIMULACION` | Habilita `/api/conectividad/simular` | `1` (`0` en producción) |
| `CORS_ORIGIN` | Orígenes permitidos | `localhost` y `127.0.0.1` en el puerto 5173 |

## Trabajar sin afectar al equipo

Ejecutar la API o las pruebas **escribe en la base del `.env`** (scripts, datos demo, sesiones, eventos). Para desarrollar una historia:

1. Cree una rama de Git desde la rama de integración.
2. Cree una rama en Neon (central y local) y apunte su `.env` a ella.
3. Antes del PR: `npm test` (pruebas de HU-06 y verificación del esquema).
4. Suba sus scripts de `db/` junto con el código; nunca aplique cambios en la base principal sin el script en el repositorio.
