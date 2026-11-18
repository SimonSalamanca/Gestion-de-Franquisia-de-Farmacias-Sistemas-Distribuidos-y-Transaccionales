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

## Fase B (pendiente, con cambios de código)

| Cambio | Motivo |
|---|---|
| `alerta (id_lote, id_medicamento)` → `lote` y la venta con `FOR NO KEY UPDATE` | Relación sin interbloqueo con las ventas |
| `cursor_sync` y `empleado_ref` → `tienda_ref` | Requieren asegurar la fila de la tienda antes (arranque de una tienda nueva y réplica) |
| `periodo_caja` reemplaza a `caja_control` y `apertura_caja` | El periodo pasa a ser entidad padre de factura, nota y cierre |
| `secuencia_documento.id_tienda` → `tienda_ref` | La tienda numera sus documentos |
| `auth_operacion.id_empleado` → empleado | Un empleado ejecuta 0..N operaciones idempotentes |
| `medicamento_proveedor` (central) | Un proveedor surte N medicamentos; sugiere el proveedor al pedir desde una alerta |
| Traslado sin tablas de detalle | Un traslado lleva un solo medicamento; los lotes quedan en `movimiento_inventario` |
| `detalle_recepcion` sin `id_medicamento` ni `id_proveedor` | Se deducen del lote |
| `venta_categoria_consolidada.id_categoria` → `categoria` | Hoy las ventas sin categoría se consolidan con el valor centinela 0, que no existe en `categoria`; hay que reemplazar el centinela antes de declarar la llave (en la copia, la llave detuvo la consolidación) |

Caminos cerrados que se conservan porque cada ruta significa algo distinto:

- Venta con receta: la factura y la receta apuntan al cliente; un disparador exige que sea el mismo paciente.
- Anulación: el periodo de la venta y el del reintegro pueden ser distintos (una devolución de otro día cuenta en esa caja).
- Registro de actividad: la tienda donde ocurrió la acción y la tienda del empleado pueden diferir (administrador general).
- Receta emitida: la tienda de la reserva es la del momento; el empleado puede cambiar de tienda después.
