# Relaciones del modelo de datos

Objetivo: que ninguna tabla quede sin relación, sin forzar relaciones artificiales, sin ciclos dirigidos y sin dos caminos
que guarden el mismo dato sin control. Se trabaja en fases para no romper lo que está en producción.

## Ejes del modelo

Todo el esquema se desprende de cuatro entidades:

| Eje | Responde a | Central | Tienda |
|---|---|---|---|
| Tienda | ¿dónde? | `tienda` | `tienda_ref` |
| Empleado | ¿quién? | `empleado` | `empleado_ref` |
| Medicamento | ¿qué? | `medicamento` | `medicamento_ref` |
| Lote | ¿cuánto hay físicamente? | (no existe) | `lote` |

Alrededor de los ejes hay cuatro capas, con una regla para cada una:

- **Documentos** (factura, nota, pedido, recepción, traslado, receta, cierre de caja): la cabecera apunta al empleado y
  la línea apunta al lote o al medicamento. Toda línea que mueve inventario termina en un lote (trazabilidad, RF-02).
- **Catálogo y configuración** (rol, permiso, categoría, precio, proveedor, política): cuelgan de un eje.
- **Consolidado de la red** (`venta_consolidada`, `venta_categoria_consolidada`, `medicamento_tienda`): tienda × algo.
- **Seguimiento** (registro de actividad, intentos, sesiones, sincronización): apuntan al empleado o a la tienda.

Las tablas `_ref` son la copia de referencia de los datos maestros del central en cada tienda (autonomía sin conexión,
RNF-04). Postgres no admite llaves foráneas entre bases distintas: la relación central → tienda es la réplica.

## Fase A: relaciones declaradas (`17_relaciones.sql`, sin cambios de código)

Central:

| Relación | Se lee |
|---|---|
| `tienda.id_politica` → `politica_sistema` | La tienda opera bajo la política de la red (una sola: el bloqueo por intentos vale en toda la red, HU-06) |
| `intento_acceso.id_empleado` → `empleado` | Un empleado registra 0..N intentos (opcional: el usuario escrito puede no existir) |
| `registro_actividad_central.id_empleado` → `empleado` | Un empleado realiza 0..N acciones auditadas |
| `registro_actividad_central.id_tienda` → `tienda` | Una tienda origina 0..N registros (vacío = acción del central) |
| `inbox_sync.id_tienda_origen` → `tienda` | Una tienda envía 0..N operaciones |
| `receta_conflicto.id_tienda_origen` → `tienda` | Una tienda origina 0..N conflictos de receta |
| `replica_evento.id_tienda_destino` → `tienda` (NOT VALID) | Una tienda recibe 0..N eventos (vacío = toda la red) |

Tienda:

| Relación | Se lee |
|---|---|
| `tienda_ref.id_politica` → `politica_sistema` | La tienda opera bajo la política de la red |
| `intento_acceso`, `outbox_sync`, `sync_conflicto` `.id_empleado` → `empleado_ref` | El empleado es dueño de sus intentos, operaciones por enviar y conflictos |
| `pedido.id_alerta` → `alerta` | Un pedido puede nacer de una alerta (HU-13) |
| `devolucion_pago.id_metodo_pago` → `metodo_pago_ref` | Cada reintegro se hace por un método de pago |
| `diferencia_recepcion (id_pedido, id_medicamento)` → `detalle_pedido` | La diferencia es de una línea del pedido |
| `diferencia_recepcion (id_recepcion, id_pedido)` → `recepcion` | Se registró en una recepción de ese mismo pedido |

En `diferencia_recepcion` se quitan las tres llaves simples (pedido, recepción, medicamento): las compuestas las cubren
y además impiden la contradicción que antes era posible.

### Decisiones

- **Empleados nunca se borran** (baja lógica con `fecha_baja`); por eso la llave del registro de actividad del central a
  `empleado` no rechaza filas legítimas que suben las tiendas. Reemplaza al disparador `auditoria_central_empleado`, que
  solo revisaba las filas del central (`04_hu07_cuentas.sql` ya no quita la llave en cada arranque).
- **`replica_evento` con NOT VALID:** el registro es contiguo e inmutable. Las tiendas lo leen en orden desde el evento 1
  y se detienen ante un hueco (`sync.mjs`), así que borrar los eventos históricos dirigidos a tiendas de prueba ya
  eliminadas congelaría a cualquier tienda nueva. Se conservan; la regla rige para todo evento nuevo.
- **Bloqueos:** las llaves nuevas toman un bloqueo `FOR KEY SHARE` sobre la fila referida, compatible con las
  actualizaciones normales (que no cambian la llave). Por eso `alerta → lote` espera a la fase B (la venta usa
  `FOR UPDATE` sobre el lote, que sí choca).

## Fase B1: relaciones con cambios pequeños de código (`18_relaciones_b.sql`)

| Relación | Se lee | Cambio de código que la hace segura |
|---|---|---|
| `auth_operacion.id_empleado` → `empleado` / `empleado_ref` | Un empleado ejecuta 0..N operaciones idempotentes (vacío = sin sesión: inicio de sesión fallido o restablecimiento de contraseña) | `idempotencia.mjs`, `auth.mjs` y `tiendas.mjs` guardan quién la ejecutó; el restablecimiento ya no usa el centinela 0 |
| `alerta (id_lote, id_medicamento)` → `lote` | La alerta de un lote es de ese lote y de su medicamento (una sola ruta) | La venta, los movimientos, los traslados y `evaluar_alertas` bloquean el lote con `FOR NO KEY UPDATE`, compatible con la llave |
| `cursor_sync.id_tienda` → `tienda_ref` (1:1) | La tienda tiene un estado de sincronización | El arranque crea la fila de la tienda (nombre del central) antes del cursor |
| `empleado_ref.id_tienda` → `tienda_ref` | El empleado pertenece a una tienda | La réplica del empleado asegura la fila de su tienda; nunca detiene la réplica |
| `secuencia_documento.id_tienda` → `tienda_ref` | La tienda numera sus documentos (llave `(id_tienda, tipo)`) | `siguiente_numero_factura/nota(p_tienda)` crean la fila con el primer documento |
| `venta_categoria_consolidada.id_categoria` → `categoria` | La venta consolidada es de una categoría | "Sin categoría" (id 0) pasa a ser una fila del catálogo: la vista de red y el filtro del inventario la usan en lugar de agregarla a mano |

## Fase B2: el periodo de caja como entidad (`19_periodo_caja.sql`)

`periodo_caja` reemplaza a `caja_control` (una fila con el número del periodo vigente) y a `apertura_caja`. Es la tabla
padre de `factura`, `anulacion_devolucion` y `cierre_caja`, y guarda quién abrió el periodo, cuándo y en qué turno.

- Ciclo: `PENDIENTE` → `ABIERTO` → `CERRADO`. Al cerrar un periodo nace el siguiente como `PENDIENTE`: las devoluciones
  hechas con la caja cerrada caen allí (antes se asignaban a un número que todavía no existía).
- Siempre hay un único periodo no cerrado (índice único parcial); un disparador impide saltarse el ciclo, editar un
  periodo cerrado o borrarlo.
- `cierre_caja.abierto_en` se elimina: era una copia de la hora de apertura del periodo.
- La migración convierte los datos existentes y comprueba que ninguna apertura se pierda antes de eliminar las tablas.

## Fase B3: menos tablas, sin datos repetidos (`20_modelo_b3.sql`)

| Cambio | Se lee / motivo |
|---|---|
| `medicamento_proveedor` (central) y su réplica `medicamento_proveedor_ref` (tienda) | Un proveedor surte N medicamentos y un medicamento tiene N proveedores (M:N). El administrador lo marca en la pantalla de proveedores; viaja con `PROVEEDOR_UPSERT` y al pedir desde una alerta se sugiere un proveedor que surte el medicamento (HU-13, criterio 2; si no hay, el del último lote) |
| `traslado` y `traslado_local` guardan `id_medicamento` y `cantidad`; se eliminan `detalle_traslado` y `detalle_traslado_local` | Un traslado lleva un solo medicamento (HU-17, RF-26). Los lotes que envió el origen quedan en `traslado.lotes_enviados` (guía para el destino) y los movimientos por lote en `movimiento_inventario` |
| `detalle_recepcion` sin `id_medicamento` ni `id_proveedor` | Se deducen del lote; la migración verifica que coincidan antes de quitarlos |
| `01_hu06.sql` ya no siembra el cursor de la tienda 1 | Lo crea el arranque con la tienda del nodo; la fila sobrante en otras tiendas se elimina |

## Resultado

| Nodo | Tablas | Tablas sin relación | Ciclos dirigidos |
|---|---|---|---|
| Central | 27 (antes 27) | 0 (antes 7) | 0 |
| Tienda | 43 (antes 44) | 0 (antes 8) | 0 |

Validado sobre una copia de producción (las 17 historias, sincronización, datos personales y `npm test`), en bases vacías
(instalación de una tienda nueva) y con un ensayo sobre las tres bases de Neon dentro de una transacción revertida.

Caminos cerrados que se conservan porque cada ruta significa algo distinto:

- Venta con receta: la factura y la receta apuntan al cliente; un disparador exige que sea el mismo paciente.
- Anulación: el periodo de la venta y el del reintegro pueden ser distintos (una devolución de otro día cuenta en esa caja).
- Registro de actividad: la tienda donde ocurrió la acción y la tienda del empleado pueden diferir (administrador general).
- Receta emitida: la tienda de la reserva es la del momento; el empleado puede cambiar de tienda después.
