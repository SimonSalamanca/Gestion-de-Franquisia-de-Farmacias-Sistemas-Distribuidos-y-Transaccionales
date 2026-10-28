# HU-01 — Consultar, buscar y localizar existencias de medicamentos entre tiendas

Estado: **IMPLEMENTADA** (2026-10-28): API, réplica del catálogo, `STOCK_SNAPSHOT` e interfaz del POS. Pendiente de cerrar: ejecutar `npm run test:hu01` en un clon de las bases. Especificación alineada con "Documentación proyecto UML" (RF y RNF).

Jira: **SDGFCSDF-1** · Sprint 1.

Requerimientos: **RF-01** Consulta y localización de existencias y **RF-03** Búsqueda y filtrado de productos (Módulo 1, Control de Stock; prioridad Alta, obligatorios).

## Contexto del sprint 1

Historias del sprint: HU-06 (SDGFCSDF-6, terminada), HU-07 (SDGFCSDF-7, cuentas y auditoría), HU-15 (SDGFCSDF-15, tiendas), HU-01 (esta), HU-02 (SDGFCSDF-2, lotes) y HU-03 (SDGFCSDF-3, precios).

- **Ventas (RF-17) no está en el sprint.** En el sprint 1 el stock solo cambia por reabastecimiento y ajustes (HU-02). El criterio 4 se demuestra con esos movimientos; la venta, cuando llegue, solo tiene que usar el servicio de movimientos de HU-02 y el `STOCK_SNAPSHOT` sale solo.
- **Alta de medicamentos y categorías: no hay historia en el sprint.** HU-01, HU-02 y HU-03 dependen del catálogo. En el sprint 1 el catálogo viene de los datos demo del central y se replica con los eventos que agrega esta historia. Conviene que el equipo asigne una historia para administrar el catálogo.
- **HU-15** crea tiendas y publica umbrales: de ahí salen la lista de tiendas de la red y el estado "bajo".
- **HU-03** fija precios: esta historia no muestra precio; si el equipo lo quiere en los resultados, se agrega leyendo `precio_vigente_ref` cuando HU-03 lo replique.
- **HU-07** define la auditoría: el `ACCESO_DENEGADO` de esta historia usa `registro_actividad` con el mismo formato que HU-06 y HU-07.

Rama de trabajo: `hu-01` desde `dev-cimientos`. Sigue las reglas de `docs/arquitectura/cimientos.md`.

Restricción del proyecto: **sin cambios de estructura en la base** (tablas, columnas, índices). Todo se resuelve con las tablas existentes, datos (inserts idempotentes) y código. Los contrastes de campos se hicieron leyendo `db/central/00_base.sql`, `db/local/00_base.sql` y `db/*/01_hu06.sql`.

Frontend previsto: React (POS de tienda). El permiso se relee en cada request; ocultar la búsqueda no autoriza.

## Historia

Como empleado de tienda, quiero buscar un medicamento por nombre comercial, principio activo o código, y consultar su disponibilidad en mi tienda y en otras tiendas de la red, para atender al cliente rápidamente sin necesidad de llamar por teléfono a otras sucursales.

## Criterios de aceptación

1. Dado que un empleado autenticado busca un medicamento por nombre, principio activo o código, el sistema muestra los resultados coincidentes junto con la cantidad disponible en su tienda.
2. Si el producto no tiene stock en la tienda actual, el sistema muestra la lista de otras tiendas de la red que sí cuentan con existencias disponibles.
3. El empleado puede aplicar filtros combinables por tienda, categoría terapéutica y estado de stock (disponible, bajo, agotado).
4. La información de disponibilidad se actualiza en tiempo real al registrarse una venta o un reabastecimiento en cualquier tienda de la red.
5. Si la tienda pierde conectividad con el nodo central, la consulta y búsqueda del inventario local de la propia tienda debe seguir funcionando con normalidad.

## Tareas

| # | Tarea | Entregable |
| --- | --- | --- |
| 1 | Motor de búsqueda por nombre comercial, principio activo y código | `GET /api/local/inventario/buscar` sobre `medicamento_ref` + stock local |
| 2 | Consulta cruzada de stock entre tiendas | Publicación de stock local → `inventario_consolidado` del central y `GET /api/local/inventario/red/:id_medicamento` |
| 3 | Interfaz de búsqueda con filtros combinables y actualización continua | Módulo `INVENTARIO_CONSULTAR` del POS React |

## Trazabilidad

| Fuente | Exigencia del documento | Cobertura en esta historia |
| --- | --- | --- |
| RF-01 | Cantidades por tienda, localización cruzada, actualización conforme a ventas y reabastecimientos | Stock propio + consulta de la red sobre `inventario_consolidado` + `STOCK_SNAPSHOT` en cada movimiento |
| RF-03 | Búsqueda por nombre comercial, principio activo o código; filtros combinables por tienda, categoría y estado de stock | `GET /api/local/inventario/buscar` con filtros AND |
| RNF-01 | Ningún módulo sin sesión; 100 % de accesos fuera de rol rechazados **y registrados** | 401/403 antes de consultar; el 403 deja `ACCESO_DENEGADO` en `registro_actividad` |
| RNF-03 | Disponibilidad ≥ 99 % del horario de la tienda | La búsqueda solo depende de la base local; la caída del central no la detiene |
| RNF-04 | Ninguna operación local depende del central; solo lo que cruza tiendas se afecta y se reanuda al reconectar | Búsqueda y stock propio 100 % locales; la consulta de la red falla cerrada y el outbox reenvía al volver |
| RNF-05 | 95 % de búsquedas y consultas de stock en < 2 s | Ver "Rendimiento" |
| RNF-07 | Tareas frecuentes en máximo 3 pasos | Buscar = escribir el término (1 paso); ver otras tiendas = automático si no hay stock, o 1 clic |
| RNF-13 | Consolidado con retraso de "algunos minutos" como máximo e indicación de la hora de última actualización | Cada tienda de la red muestra `actualizado_en`; se marca desactualizada si supera 5 minutos |

Fuera de alcance: alta y edición del catálogo de medicamentos, registro de ventas, reabastecimiento y traslados entre tiendas (esta historia solo los **refleja**). Precios.

## Roles y permisos

Se usa el permiso existente `INVENTARIO_CONSULTAR`, que ya tienen `cajero`, `administrador_tienda` y `administrador_general`. No se crean permisos nuevos.

| Rol | Puede |
| --- | --- |
| cajero | Buscar en su tienda y ver existencias de la red |
| administrador_tienda | Igual que el cajero |
| administrador_general | Igual, desde el POS de su tienda hogar |

## Nodos

- **Local**: búsqueda sobre el catálogo replicado (`medicamento_ref`, `categoria_ref`) y el stock propio (`lote`). No depende del central.
- **Central**: guarda la última foto de stock de cada tienda en `inventario_consolidado` y los umbrales en `umbral_stock`. Responde la consulta de la red.
- **Flujo de stock**: cada movimiento que cambia existencias en una tienda (venta, recepción, ajuste) encola en `outbox_sync` un evento `STOCK_SNAPSHOT` con la cantidad **absoluta** de los medicamentos afectados. El central lo aplica en `inventario_consolidado`. Se usan cantidades absolutas, no deltas, para que un reintento o un duplicado nunca descuadre el total.

## Definiciones

| Término | Definición |
| --- | --- |
| Stock disponible de una tienda | `sum(lote.cantidad_disponible)` de lotes con `estado = 'DISPONIBLE'` y `fecha_caducidad >= current_date` (un lote vencido no se puede vender) |
| Agotado | stock disponible = 0 |
| Bajo | 0 < stock ≤ `stock_minimo` del umbral de esa tienda y medicamento |
| Disponible | stock > `stock_minimo`, o stock > 0 si la tienda no tiene umbral configurado |
| Umbral propio | `umbral_stock_ref` (local, llega por `UMBRAL_UPSERT` de HU-15) |
| Umbral de otra tienda | `umbral_stock` (central) |

## Búsqueda (Tarea 1)

`GET /api/local/inventario/buscar?q=&categoria=&estado=&pagina=`

1. Exige sesión local válida y `INVENTARIO_CONSULTAR`. 401/403 antes de consultar; el 403 registra `ACCESO_DENEGADO` (RNF-01).
2. `q` de 2 a 80 caracteres después de `trim`. Puede ir vacío solo si hay al menos un filtro (explorar, p. ej., "todo lo agotado de Analgésicos"); sin término ni filtros, 400 "Escriba al menos 2 caracteres o elija un filtro". Busca en `nombre_comercial`, `principio_activo` y `codigo_interno` de `medicamento_ref` con `activo = true`.
3. Comparación sin mayúsculas ni tildes: `translate(lower(col), 'áéíóúüñ', 'aeiouun') like '%' || termino || '%'`, con el término normalizado igual. Se escapan `%`, `_` y `\` del término. Parámetros siempre ligados; nunca concatenación.
4. Orden de relevancia: código exacto, luego nombre que empieza por el término, luego coincidencia en cualquier parte; desempate por `nombre_comercial`.
5. Paginación de 25 resultados. Respuesta por ítem: `id_medicamento`, `codigo_interno`, `nombre_comercial`, `principio_activo`, `categoria`, `requiere_receta`, `requiere_refrigeracion`, `stock_tienda`, `estado_stock`, `stock_minimo`.
6. Los filtros `categoria` (id), `estado` (`disponible|bajo|agotado`) y `tienda` (id; vacío = la propia) se combinan con AND.
7. En la tienda propia el estado se calcula en SQL y el filtro, el orden y la paginación se aplican en la base, sin tope de coincidencias. Con `tienda` de otra sucursal el stock sale del central, así que el estado se calcula en el API sobre las primeras 5.000 coincidencias del catálogo (`truncado: true` si hay más). Cada ítem trae además `actualizado_en` (hora del reporte de esa tienda; `null` para la propia).

Índices: `medicamento_ref` ya tiene btree en `nombre_comercial` y `principio_activo`. Una búsqueda `like '%…%'` no los usa, pero el catálogo de una cadena de farmacias (miles de filas) se recorre completo en pocos milisegundos. Un índice trigram (`pg_trgm`) sería un cambio de estructura: queda como recomendación si el catálogo crece a cientos de miles.

## Consulta de la red (Tarea 2)

### Publicación de stock (local → central)

- Evento `STOCK_SNAPSHOT` en `outbox_sync`, en la **misma transacción** que el movimiento que cambia el stock:
  ```json
  { "id_tienda": 1, "calculado_en": "2026-10-22T16:00:00.000Z",
    "items": [{ "id_medicamento": 7, "cantidad": 42 }] }
  ```
  `calculado_en` sale de `now()` de la base local. `id_empleado` del outbox va en `NULL`: el outbox ordena por empleado, y así un evento de login atascado de quien hizo el movimiento no frena la publicación del stock. El responsable queda en `movimiento_inventario`.
- Reconciliación: al arrancar y cada 15 minutos el nodo encola un `STOCK_SNAPSHOT` completo (todos los medicamentos con lotes, incluidos los que quedaron en 0), para corregir cualquier deriva.
- El envío reutiliza `flushOutbox`. Hoy todo evento del outbox va a `fold_evento` (autenticación). Se agrega un despacho por `tipo_evento` en el código del API: los tipos de HU-06 siguen yendo a `fold_evento`; `STOCK_SNAPSHOT` lo aplica el API en el central, en una transacción:
  1. `insert into inbox_sync (id_tienda_origen, idempotency_key, tipo_evento, payload) … on conflict do nothing`. Si no insertó, es duplicado y no hace nada más.
  2. Por ítem: `insert into inventario_consolidado (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion) values (…) on conflict (id_tienda, id_medicamento) do update set … where inventario_consolidado.fecha_sincronizacion <= excluded.fecha_sincronizacion`. Una foto vieja que llega tarde no pisa una nueva.
- `fecha_sincronizacion` guarda `calculado_en` (hora en que la tienda calculó el stock), no la hora de llegada al central.

### Consulta (local → central)

`GET /api/local/inventario/red/:id_medicamento?tienda=&estado=`

1. Exige sesión local y `INVENTARIO_CONSULTAR`.
2. Si el estado real del enlace es `offline`, responde 503 `SIN_CONEXION` con `ultima_sync`. No devuelve una lista vacía (que se leería como "nadie tiene").
3. Con el central alcanzable, consulta `inventario_consolidado` unido a `tienda` (`activa = true`) y `umbral_stock`, excluyendo la tienda propia (su dato local es más fresco). Timeout de **1,5 s** para quedar dentro de los 2 s de RNF-05; si se excede, 503 igual que offline.
4. Respuesta por tienda: `id_tienda`, `nombre`, `ciudad`, `cantidad`, `estado_stock`, `actualizado_en`. Orden: con stock primero, luego por cantidad descendente.
5. Criterio 2: el POS llama a esta ruta automáticamente cuando el stock propio de un resultado es 0, y bajo demanda ("ver en la red") en los demás casos.

## Rendimiento (RNF-05)

| Operación | Meta (p95) | Cómo se cumple |
| --- | --- | --- |
| Búsqueda en la tienda | < 2 s | Una sola consulta a la base local con paginación de 25; catálogo de miles de filas |
| Consulta de la red | < 2 s | Una consulta al central con timeout de 1,5 s; si no responde, se muestra el aviso y la búsqueda local no espera |
| Refresco del POS | < 2 s | Mismas rutas, solo los resultados visibles |

La prueba de la historia mide el p95 de 100 búsquedas contra un catálogo demo de al menos 2.000 medicamentos.

## Actualización continua (Tarea 3)

RF-01 pide que la información se actualice "en tiempo real" conforme a las ventas y reabastecimientos. El mismo documento lo acota para lo que cruza tiendas: RNF-13 define la consolidación como **periódica, no en tiempo real estricto**, con retraso máximo de algunos minutos e indicación de la última actualización, y el diagrama de componentes dibuja la sincronización tienda-central como asíncrona y la localización como "consulta remota (RF-01)". Por eso:

| Origen del cambio | Llega a la pantalla |
| --- | --- |
| Venta o recepción en **la misma tienda** | En el siguiente refresco del POS (≤ 5 s) |
| Venta o recepción en **otra tienda** | Ciclo de outbox de esa tienda (10 s) + refresco del POS (≤ 15 s). Con su enlace caído, cuando se reconecte |

- El POS refresca los resultados visibles cada 5 s mientras la pantalla está activa (polling ligero sobre las mismas rutas; no requiere infraestructura nueva).
- Cada tienda de la red muestra "actualizado hace N s" a partir de `actualizado_en`. Si supera 5 minutos se marca como desactualizada (RNF-13).
- El polling cumple RF-01 en segundos, muy por debajo de los "algunos minutos" de RNF-13, sin agregar estado de conexión. Si más adelante se quiere empuje inmediato, Server-Sent Events desde el API local es una mejora compatible.

## Interfaz (POS React)

- Caja de búsqueda con espera de 300 ms tras teclear; mínimo 2 caracteres.
- Filtros combinables: tienda (propia o una de la red), categoría (`categoria_ref`), estado de stock. Se combinan con AND y se reflejan en la URL.
- Cada resultado: nombre, principio activo, código, categoría, stock de la tienda con su estado (disponible/bajo/agotado), indicadores de receta y refrigeración (los mismos de HU-02).
- Sin stock propio: panel "Disponible en otras tiendas" con la lista de la red. Sin conexión: aviso "Existencias de la red no disponibles — última sincronización HH:MM"; la búsqueda local sigue.
- Sin resultados: "No se encontraron medicamentos para «…»", distinto de "sin stock".
- RNF-07: la búsqueda se completa en un paso (escribir) y la localización en otra tienda en cero o un paso adicional; textos en lenguaje de mostrador, sin códigos técnicos.

## Dependencias

- **Catálogo replicado.** Hoy `medicamento_ref` y `categoria_ref` están vacías en el nodo local: ningún evento los replica. Esta historia agrega:
  - Handlers `CATEGORIA_UPSERT` y `MEDICAMENTO_UPSERT` en `apps/api/sync/handlers/catalogo.mjs` (upsert idempotente; destino `null`, llegan a todas las tiendas).
  - Emisión inicial desde el central de las categorías y medicamentos que aún no tengan evento (mismo patrón que `emitirEmpleadosPendientes`).
  - El alta y edición de medicamentos en el central es de otra historia; cuando exista, debe publicar estos eventos.
- **Datos demo** (`SEED_DEMO`): categorías, medicamentos (algunos con receta y refrigeración) y una segunda tienda con stock en `inventario_consolidado`, para poder demostrar el criterio 2. Son datos, no estructura.
- **HU-02** produce los movimientos que disparan `STOCK_SNAPSHOT`. La venta (otra historia) también debe encolarlo.
- **HU-15** publica `UMBRAL_UPSERT` (ya soportado) y define las tiendas activas.

## Validación de esquema

Encaje: ENCAJA sin cambios de estructura.

Correspondencia con el diagrama de clases del documento: `Medicamento.estaDisponibleEn(tienda)` (nodo tienda) es la búsqueda con stock propio; `Medicamento.consultarDisponibilidad()`, `Tienda.consolidarInventario()` e `InventarioConsolidado.actualizarSincronizacion()` (nodo central) son la publicación de `STOCK_SNAPSHOT` y la consulta de la red; `UmbralStock.evaluarAlertaStock()` da el estado "bajo".

| Dato | Definición leída | Uso |
| --- | --- | --- |
| Catálogo local | `medicamento_ref(id_medicamento, codigo_interno, nombre_comercial, principio_activo, id_categoria, requiere_receta, requiere_refrigeracion, activo)` | Búsqueda |
| Categoría local | `categoria_ref(id_categoria, nombre)` | Filtro |
| Stock propio | `lote.cantidad_disponible`, `estado`, `fecha_caducidad` | Suma de lotes vendibles |
| Vista existente | `vw_stock_tienda` suma lotes `DISPONIBLE` pero **no excluye vencidos** | No se usa para la búsqueda; se calcula con la definición de arriba |
| Umbral propio | `umbral_stock_ref(id_medicamento, stock_minimo)` | Estado "bajo" |
| Stock de la red | `inventario_consolidado(id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)` + `UNIQUE(id_tienda, id_medicamento)` | Upsert del snapshot |
| Umbral de la red | `umbral_stock(id_tienda, id_medicamento, stock_minimo)` | Estado "bajo" de otras tiendas |
| Tiendas | `tienda(activa, nombre, ciudad)` | Lista de la red |
| Idempotencia central | `inbox_sync PRIMARY KEY (id_tienda_origen, idempotency_key)` | Descartar duplicados del snapshot |
| Fechas | `inventario_consolidado.fecha_sincronizacion timestamp` sin zona | Se guarda en UTC (lectura UTC en `db.mjs`) |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-01 Consultar, buscar y localizar existencias entre tiendas

  Antecedentes:
    Dado que "cajero1" tiene sesión local válida en "Farmacia Centro"
    Y el catálogo replicado contiene "Acetaminofén 500 mg" (código "MED-001", principio activo "paracetamol")

  Escenario: Buscar por nombre comercial muestra el stock de la tienda
    Dado que "Farmacia Centro" tiene 40 unidades vendibles de "Acetaminofén 500 mg"
    Cuando busca "acetaminofen"
    Entonces ve "Acetaminofén 500 mg" con stock 40 en su tienda

  Escenario: Buscar por principio activo y por código
    Cuando busca "paracetamol"
    Entonces ve "Acetaminofén 500 mg"
    Cuando busca "MED-001"
    Entonces "Acetaminofén 500 mg" aparece primero

  Escenario: Los lotes vencidos no cuentan como disponibles
    Dado que la tienda solo tiene un lote de 10 unidades vencido ayer
    Cuando busca el medicamento
    Entonces su stock en la tienda es 0 y el estado es agotado

  Escenario: Sin stock propio se listan otras tiendas con existencias
    Dado que "Farmacia Centro" tiene 0 unidades
    Y "Farmacia Norte" reportó 12 unidades y "Farmacia Sur" reportó 0
    Cuando busca el medicamento
    Entonces ve "Farmacia Norte" con 12 unidades y la hora de su último reporte
    Y no ve "Farmacia Sur" como tienda con existencias

  Escenario: Filtros combinables
    Dado que hay medicamentos de las categorías "Analgésicos" y "Antibióticos" con estados disponible, bajo y agotado
    Cuando filtra por categoría "Analgésicos" y estado "bajo"
    Entonces solo ve analgésicos cuyo stock es mayor que 0 y menor o igual a su stock mínimo

  Escenario: Un reabastecimiento en otra tienda se refleja sin recargar
    Dado que "Farmacia Norte" tenía 12 unidades
    Cuando "Farmacia Norte" registra un lote de 30 unidades (HU-02) y su outbox se sincroniza
    Entonces en menos de 15 segundos el POS de "Farmacia Centro" muestra 42 para "Farmacia Norte"
    # Con ventas (RF-17, sprint posterior) aplica igual: toda salida pasa por el mismo servicio de movimientos

  Escenario: Una foto de stock vieja no pisa una nueva
    Dado que el central tiene 10 unidades de "Farmacia Norte" calculadas a las 10:05
    Cuando llega tarde un STOCK_SNAPSHOT calculado a las 10:00 con 12 unidades
    Entonces el central conserva 10

  Escenario: Un snapshot duplicado no se aplica dos veces
    Dado que el STOCK_SNAPSHOT con clave "k-9" ya se aplicó
    Cuando la tienda lo reenvía
    Entonces inbox_sync lo descarta y no hay escrituras en inventario_consolidado

  Escenario: Sin conexión la búsqueda local sigue
    Dado que el enlace con el central está offline
    Cuando busca "acetaminofen"
    Entonces ve los resultados con el stock de su tienda
    Y la sección de la red muestra "Existencias de la red no disponibles" con la hora de la última sincronización
    Y no muestra la red vacía

  Escenario: Sin permiso no hay búsqueda
    Dado que no hay sesión válida
    Cuando llama a la búsqueda
    Entonces recibe 401 y no se consulta la base

  Escenario: Término inválido
    Cuando busca "a"
    Entonces recibe 400 "Escriba al menos 2 caracteres o elija un filtro"

  Escenario: Acceso fuera de rol queda registrado
    Dado que una sesión no tiene INVENTARIO_CONSULTAR
    Cuando llama a la búsqueda
    Entonces recibe 403 y queda ACCESO_DENEGADO en registro_actividad

  Escenario: Tiempo de respuesta
    Dado un catálogo de 2.000 medicamentos
    Cuando se ejecutan 100 búsquedas
    Entonces el 95 % responde en menos de 2 segundos

  Escenario: El central lento no frena la búsqueda local
    Dado que el central tarda más de 1,5 segundos en responder
    Cuando busca un medicamento sin stock propio
    Entonces ve sus resultados locales en menos de 2 segundos
    Y la sección de la red muestra que no está disponible
```

## Pruebas

`npm run test:hu01` (`scripts/probar-hu01.mjs`). Escribe en las bases del `.env`; si las URLs son de Neon se niega a correr salvo `PERMITIR_NEON=1` (para una rama de prueba). Cubre:

- Catálogo replicado y listas de tiendas y categorías.
- Búsqueda sin tildes ni mayúsculas, por principio activo y por código (código exacto primero), escape de comodines, validaciones 400 y campos de la respuesta.
- Filtros combinables (categoría AND estado, solo filtros sin término) y paginación.
- Filtro por otra tienda, 404 de tienda inexistente, existencias de la red sin la tienda propia y en orden.
- 401 sin sesión; 403 con `ACCESO_DENEGADO` registrado.
- `STOCK_SNAPSHOT`: duplicado y foto vieja no cambian el consolidado.
- Sin conexión: la búsqueda local sigue y la red responde 503 `SIN_CONEXION`.
- RNF-05: p95 de 100 búsquedas con 2.000 medicamentos extra creados en una transacción que se revierte; el filtro de estado cuenta todo el catálogo.

No se prueba automáticamente el timeout de 1,5 s del central ni la interfaz (se revisa a mano con `npm run dev`).

## Ciclo

| Paso | Resultado |
| --- | --- |
| Especificación inicial | `BORRADOR` |
| Alineación con el documento de requerimientos | RF-01, RF-03 y RNF-01/03/04/05/07/13 incorporados. "Tiempo real" resuelto con RNF-13 y el diagrama de componentes. Timeout de la red ajustado a 1,5 s por RNF-05 |
| Contexto del sprint 1 | Sin ventas en el sprint: el criterio 4 se demuestra con reabastecimientos y ajustes de HU-02. Catálogo desde datos demo (no hay historia de alta de medicamentos) |
| Decisiones abiertas | Ninguna |
| Implementación (2026-10-28) | API y réplica en `dev-cimientos`; interfaz `apps/web/src/Inventario.jsx`; filtro de estado movido a SQL para no perder resultados con catálogos grandes; campo `stock_tienda` como dice la especificación; pruebas `probar-hu01.mjs` |
