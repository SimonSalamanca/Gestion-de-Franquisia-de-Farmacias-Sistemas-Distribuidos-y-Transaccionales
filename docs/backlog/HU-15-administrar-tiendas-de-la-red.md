# HU-15 — Administrar tiendas de la red

Estado: **IMPLEMENTADA** (2026-10-30): API con rutas registradas, script de esquema en `db/central/`, pantalla "Tiendas" en la consola central y pruebas de funciones y HTTP en verde (ver "Pruebas"). Pendiente el veredicto del auditor sobre este corte.

Este módulo vive solo en el nodo central. No es operación de mostrador: el punto de venta no lo llama ni en línea ni en cola.

## Historia

Como administrador general, quiero dar de alta, editar y desactivar tiendas de la red, y configurar de forma independiente los umbrales de stock mínimo de cada una, para gestionar el crecimiento y la operación de la cadena.

## Criterios de aceptación

1. El administrador general puede registrar una nueva tienda, editar su información y desactivarla si deja de operar.
2. Cada tienda puede configurar umbrales de stock mínimo independientes de las demás tiendas.
3. Incorporar una nueva tienda no requiere modificar el diseño ni la configuración de las tiendas existentes.
4. Una tienda desactivada deja de aparecer en las búsquedas de disponibilidad cruzada y en los reportes consolidados activos.
5. Solo un usuario con rol de administrador general puede dar de alta, editar o desactivar una tienda.

## Trazabilidad

| Fuente | Cobertura |
| --- | --- |
| RF-10 | CRUD tiendas, umbrales por tienda |
| RNF-08 / CA-03 | Nueva tienda = insert en catálogo + réplica estándar; ninguna tienda existente cambia |
| RNF-10 | Crear, editar, desactivar, umbral y acceso denegado quedan en auditoría central |
| RNF-07 | Offline de módulo de red responde 503 con estado real y hora de última sync |
| RNF-13 | Réplica eventual: el local ve el cambio al hacer pull; el listado del admin muestra `activa` por fila |

Fuera de alcance: crear la base de datos del nodo de la tienda nueva, provisionar su URL en `.env` (operación manual, no requiere este código), consolidar ventas/inventario (HU-16), mover stock entre tiendas (HU-17).

## Nodos

- Central: único dueño de `tienda` y `umbral_stock`. Único escritor. Publica `TIENDA_UPSERT` y `UMBRAL_UPSERT` en el log de réplica.
- Local: consume los eventos en su próxima sincronización (`tienda_ref`, `umbral_stock_ref`). No tiene rutas de alta/edición/desactivación.
- La desactivación es un cambio de estado, no borrado: sale de búsquedas y reportes activos, sigue visible para el admin y su historial persiste en el catálogo.

## Online

1. Todas las rutas exigen sesión vigente y permiso `TIENDA_GESTIONAR` (consultas de red: `RED_VISIBILIDAD` / `REPORTE_CONSOLIDADO_VER`). 401 o 403 antes de mutar; el 403 se audita `ACCESO_DENEGADO`.
2. `POST /api/central/tiendas` alta; `PATCH /api/central/tiendas/{id}` edición; `POST /api/central/tiendas/{id}/desactivar` baja; `GET/PUT /api/central/tiendas/{id}/umbrales` configuración de umbral.
3. Alta, edición y desactivación exigen `Idempotency-Key` UUID y guardan en `tienda_operacion` la respuesta canónica, keyeada por `(idempotency_key)`.
4. Edición y desactivación exigen `version_tienda` del cliente. Distinta a la del central: 409 `CONFLICTO`, cero escrituras.
5. El umbral es upsert por `(id_tienda, id_medicamento)` en `umbral_stock`; medicamento o tienda inexistente: 404 sin mutación.
6. Consultas de apoyo: `GET /api/central/tiendas` (listado con `activa` y `version_tienda`), `GET /api/central/medicamentos` (selector de umbrales), `GET /api/central/disponibilidad` y `GET /api/central/reportes/consolidado` (criterio 4).

## Implementación

| Pieza | Archivo |
| --- | --- |
| Lógica (validación, idempotencia, versión, auditoría, eventos) | `apps/api/tiendas.mjs` |
| Rutas HTTP | `apps/api/routes/tiendas.mjs`, registradas en `apps/api/app.mjs` |
| Métodos `PUT`/`PATCH` en el router y en CORS | `apps/api/http.mjs` |
| Esquema (idempotente) | `db/central/03_hu15_tiendas.sql` |
| Réplica en el local | `sync/handlers/catalogo.mjs` (`TIENDA_UPSERT`) y `sync/handlers/tienda.mjs` (`UMBRAL_UPSERT`) |
| Interfaz | `apps/web/src/Tiendas.jsx` (módulo `TIENDA_GESTIONAR` de la consola central) |

El punto de venta ya filtra por tienda activa: la lista de tiendas de la red lee `tienda_ref.activa` y las existencias en la red unen con `tienda.activa = true` (`inventario/busqueda.mjs`, HU-01).

## Desactivación

- Con `activa=false` la tienda: no aparece en `/api/central/disponibilidad` (join exige `tienda.activa = true`), ni en `/api/central/reportes/consolidado` (where `t.activa = true`); el admin sigue viendola en `GET /api/central/tiendas` con su estado.
- `POST /desactivar` sobre una ya desactivada devuelve 200 con la fila tal cual (idempotente) y no publica evento ni audita de nuevo.
- Reactivar es posible (edición con `activa=true`), usa la misma regla de versión. No está en el CA; se tolera, no se publicita.

## Offline y latencia

- Si el estado real es no conectado, TODAS las rutas del módulo responden 503 `SIN_CONEXION` con `estado_real`, `forzado` y `ultima_sync`. No se encolan operaciones de red como éxitos pendientes: el catálogo de tiendas es del central y no hay camino offline.
- Probe real cada 10 s, timeout 3 s; cinco timeouts reales = offline, breaker abierto 30 s. La disponibilidad no se simula con `forzado`.

## Reconexión, duplicados y conflictos

- Reintento con misma clave y mismo payload: misma respuesta guardada, sin segunda tienda ni segundo evento. Clave reusada con otro payload: 409 `IDEMPOTENCY_CONFLICT`. Si la PK de `tienda_operacion` colisiona después de un fallo duro (mismo commit ya construido), la respuesta se recupera de la fila previa.
- Edición/desactivación concurrente: `where version_tienda = X` con `for update` en la baja. El perdedor recibe 409; ninguna fila cambia.
- La réplica es unicidad leída por el cursor ordinal: el local aplica los eventos `TIENDA_UPSERT`/`UMBRAL_UPSERT` al hacer pull; un `UMBRAL_UPSERT` de otra tienda se omite y el cursor avanza, nunca atasca.
- `UMBRAL_UPSERT` cuyo medicamento aún no está en `medicamento_ref`: deja fila en `sync_conflicto` (tipo `DEPENDENCIA_FALTANTE`), no aplica y no silencia. El próximo pull o la gestión del catálogo del central lo traen; hasta entonces, el local opera con su umbral anterior si existe.
- El evento replica solo `id_tienda, nombre, activa`: dirección y datos de contacto no bajan al punto de venta, que no los necesita.

## Validación de esquema

Encaje: ENCAJA con extensiones ya migradas.

| Dato | Definición leída | Uso |
| --- | --- | --- |
| Alta de tienda | `tienda` del script central (nombre, dirección, ciudad, teléfono, fecha_apertura, activa) | Campos del formulario |
| Versión de tienda | `tienda.version_tienda bigint NOT NULL DEFAULT 1` (`db/central/03_hu15_tiendas.sql`) | Optimistic locking |
| Umbral | `umbral_stock` PK `(id_tienda, id_medicamento)`, FK a tienda y medicamento, CHECKs >= 0 | Umbral por tienda |
| Idempotencia de módulo | `tienda_operacion` (UUID PK, hmac, resultado_http, cuerpo_json) | Reintentos |
| Réplica de tienda | `tienda_ref` PK `id_tienda` + `es_tienda_local` | Visibilidad local |
| Réplica de umbral | `umbral_stock_ref` PK `id_medicamento` (por tienda hogar) | Alertas del nodo local |
| Auditoría | `registro_actividad_central` | Bitácora no editable |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-15 Administrar tiendas de la red

  Escenario: El admin general registra una tienda nueva
    Dado que "admin.general" tiene sesión en la consola central y permiso TIENDA_GESTIONAR
    Cuando registra una tienda con nombre, dirección y ciudad
    Entonces la respuesta es 201 con la tienda activa y su version_tienda
    Y queda TIENDA_CREAR en registro_actividad_central
    Y el central publicó un evento TIENDA_UPSERT
    Y no se tocó ninguna fila de otra tienda

  Escenario: Reintento idempotente no duplica
    Dado que la clave "k-1" ya creó la tienda "T-1"
    Cuando se reintenta la misma clave y el mismo payload
    Entonces vuelve la misma respuesta 201 con el mismo id_tienda
    Y existe una sola fila con ese nombre
    Cuando se reutiliza "k-1" con otro payload
    Entonces la respuesta es 409 y no hay escrituras

  Escenario: Edición con versión vieja no pisa el dato
    Dado que la tienda "T-1" está en version_tienda 3
    Cuando el admin edita con version_tienda 2
    Entonces recibe 409 CONFLICTO
    Y la ciudad en el central es la que estaba antes
    Cuando edita con version_tienda 3
    Entonces la edición es 200 y version_tienda pasa a 4

  Escenario: La baja es por desactivación, no borrado
    Dado que la tienda "T-1" está activa en version_tienda 4
    Cuando el admin la desactiva
    Entonces queda activa=false en version_tienda 5
    Y sigue listada para el admin con estado desactivada
    Cuando se intenta desactivar de nuevo sin subir versión
    Entonces recibe 409 CONFLICTO

  Escenario: Umbrales independientes por tienda
    Dado que las tiendas "T-1" y "T-2" tienen umbrales configurados
    Cuando el admin guarda el umbral de "T-1" para un medicamento con stock_minimo 7 y dias_alerta_caducidad 12
    Entonces el umbral de "T-1" queda con esos valores
    Y los umbrales de "T-2" y demás tiendas no cambiaron ningún conteo
    Y queda UMBRAL_CONFIGURAR en auditoría
    Y el central publicó un evento UMBRAL_UPSERT

  Escenario: Solo el admin general gestiona tiendas
    Dado que un usuario sin TIENDA_GESTIONAR (cajero o admin de tienda)
    Cuando intenta alta, edición, desactivación o umbral
    Entonces recibe 403 ACCESO_DENEGADO
    Y no hay mutación
    Y queda ACCESO_DENEGADO en registro_actividad_central

  Escenario: Tienda desactivada fuera del cruce y de los reportes activos
    Dado que "T-1" tiene inventario consolidado y está desactivada
    Cuando se consulta la disponibilidad cruzada
    Entonces "T-1" no aparece en ninguna fila
    Cuando se consulta el reporte consolidado
    Entonces "T-1" no aparece y el resto de tiendas activas sí

  Escenario: Sin central no se gestiona la red
    Dado que el estado real es offline tras 5 timeouts reales
    Cuando el admin intenta alta, edición o desactivación
    Entonces recibe 503 SIN_CONEXION con estado_real, forzado y ultima_sync
    Y no se crean filas ni eventos
    Y el outbox no encoló "alta de tienda" como éxito

  Escenario: Réplica de la desactivación llega al local sin atascar el cursor
    Dado que el central publicó TIENDA_UPSERT de "T-1" con activa=false
    Cuando el local sincroniza
    Entonces tienda_ref tiene "T-1" activa=false
    Y el cursor local avanza
    Y si hay eventos de otras tiendas intercalados se omiten sin detener

  Escenario: Umbral cuyo medicamento no está replicado queda en conflicto
    Dado que el evento UMBRAL_UPSERT referencia un medicamento ausente en medicamento_ref
    Cuando el local sincroniza
    Entonces no aplica el umbral
    Y existe fila en sync_conflicto con tipo DEPENDENCIA_FALTANTE y detalle del medicamento faltante
```

## Pruebas

`npm run test:hu15` corre las dos suites. Escriben en las bases del `.env` y deben correr **con el API detenido**. La suite HTTP se niega a correr contra Neon salvo `PERMITIR_NEON=1` (rama de prueba).

- `scripts/probar-hu15.mjs` (funciones directas, 19 casos): alta, reintento sin duplicado, tiendas existentes intactas, edición, versión vieja 409 sin pisar, umbral propio sin tocar otras tiendas, offline 503 sin alta, 403 sin permiso y sin inserción, desactivación, fuera del cruce y del reporte, el admin la sigue viendo, réplica al local y estado original restaurado.
- `scripts/probar-hu15-http.mjs` (rutas reales de `app.mjs`, 28 casos): CORS con `PUT`/`PATCH`, 401 sin sesión y con token del POS, 400 sin `Idempotency-Key`, con JSON inválido y sin campos obligatorios, 201 y reintento con la misma tienda, misma clave con otros datos 409, `PATCH` 200/409/404, `PUT` de umbral 200/400 y su lectura, el POS ve la tienda nueva tras la réplica y deja de verla al desactivarla, disponibilidad y reporte sin la desactivada, 503 offline, auditoría de las cuatro acciones y 404 de ruta.

Resultado (2026-10-30, ramas de prueba de Neon): `test:hu15` 19/19 y 28/28. Regresión en verde: `test:hu06` 37/37, `test:hu01` 39/39, `test:hu02` 38/38, `test:sync` 12/12 (API levantada) y `db:verificar --estricto` sin diferencias. Recorrido en el navegador: alta, edición, umbral y desactivación desde la consola central (escritorio y 375 px, sin errores de consola); con el ciclo real de sincronización, la tienda desactivada desaparece de la lista de tiendas del POS.

Hallazgo de la regresión (no es de HU-15): en una base recién migrada, `probar-hu06.mjs` falla una vez en "snapshot viejo no rebloquea", porque supone que el empleado 1 ya tiene un snapshot local mayor que 1. Desde la segunda corrida pasa. Además, si la suite se interrumpe a mitad, deja el usuario `hu06.lock` y la siguiente corrida falla por clave duplicada hasta borrarlo.

## Decisiones

1. **Decidido (2026-10-30): la desactivación no bloquea el punto de venta.** Solo la saca de la búsqueda cruzada y de los reportes consolidados activos (lo que exige el criterio 4). El POS de una tienda desactivada sigue admitiendo logins locales y operando. Si más adelante se quiere cortar, el evento `TIENDA_UPSERT` con `activa=false` debe revocar sesiones de empleados de esa tienda en la réplica, igual que `EMPLEADO_UPSERT`, y el login local debe rechazar tienda inactiva.
2. **Provisión del nodo nuevo es manual:** crear la BD en Neon, copiar `LOCAL_DATABASE_URL`, desplegar el esquema estándar (`Script_BDFarmacias_nodo_farmacia.sql` + extensiones) y arrancar el nodo. Este módulo solo la inscribe en el catálogo; nada en tiendas existentes cambia.
3. `UMBRAL_UPSERT` viaja con versión fija 1 y el fold no controla versiones de umbral. Riesgo bajo (cada nodo local aplica solo umbrales de su tienda hogar y no edita umbrales concurrentemente), pero conviene versionar el umbral si se habilita edición concurrente en la red.
4. **Resuelto:** la validación HTTP de las rutas tiene su suite (`probar-hu15-http.mjs`).

## Ciclo

| Paso | Resultado |
| --- | --- |
| Suite `scripts/probar-hu15.mjs` | 19/19 OK (2026-10-22 y 2026-10-30) |
| Rutas, esquema e interfaz integrados | Hecho (2026-10-30) |
| Suite `scripts/probar-hu15-http.mjs` | 28/28 OK (2026-10-30) |
| Regresión HU-06, HU-01, HU-02 y sincronización | En verde (2026-10-30) |
| Auditor GPT-5.6 Luna, este documento + corte actual | pendiente |
