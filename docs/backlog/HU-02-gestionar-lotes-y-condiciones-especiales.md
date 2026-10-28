# HU-02 — Gestionar lotes y condiciones especiales de almacenamiento

Estado: **IMPLEMENTADA** (2026-10-28): API, réplica de proveedores y permiso, y pantalla "Lotes y recepción" del POS con indicadores, detalle del medicamento e historial. Pruebas: `npm run test:hu02`. Especificación alineada con "Documentación proyecto UML" (RF y RNF).

Jira: **SDGFCSDF-2** · Sprint 1.

Requerimientos: **RF-02** Gestión de lotes y condiciones de almacenamiento y **RF-04** Registro de movimientos de inventario (Módulo 1, Control de Stock; prioridad Alta, obligatorios). Cubre además la parte de inventario de **RF-23** Recepción e ingreso de mercancía (Módulo 7): lote, caducidad y stock al recibir un pedido.

## Contexto del sprint 1

Historias del sprint: HU-06 (SDGFCSDF-6, terminada), HU-07 (SDGFCSDF-7, cuentas y auditoría), HU-15 (SDGFCSDF-15, tiendas), HU-01 (SDGFCSDF-1, existencias), HU-02 (esta) y HU-03 (SDGFCSDF-3, precios).

- **Ventas (RF-17), devoluciones (RF-19) y pedidos (RF-22) no están en el sprint.** En el sprint 1 los movimientos reales son `ENTRADA` (registro manual y recepción) y `AJUSTE`. El servicio de movimientos se construye completo (todos los tipos) para que esas historias solo lo llamen.
- **Recepción de pedido (criterio 1):** como nadie crea pedidos en el sprint 1, se demuestra con un pedido de los datos demo. El camino principal del sprint es el registro manual.
- **Alta de medicamentos: no hay historia en el sprint.** El catálogo viene de los datos demo del central y se replica con los eventos de HU-01. Los proveedores, con `PROVEEDOR_UPSERT` de esta historia.
- **HU-07 (auditoría):** esta historia escribe `LOTE_REGISTRAR`, `PEDIDO_RECIBIR`, `LOTE_AJUSTAR` y `ACCESO_DENEGADO` en `registro_actividad` con el formato de HU-06. Hay que acordar con HU-07 los nombres de acción para que su consulta de auditoría los muestre.
- **HU-03 (precios):** independiente; el lote no guarda precio.

Rama de trabajo: `hu-02` desde `dev-cimientos` (o desde `hu-01` si se integra primero). Sigue las reglas de `docs/arquitectura/cimientos.md`.

Restricción del proyecto: **sin cambios de estructura en la base** (tablas, columnas, índices), con **una excepción autorizada** para esta historia: la columna `movimiento_inventario.sentido` (ver "Movimientos"). Todo lo demás se resuelve con las tablas existentes, datos (inserts idempotentes) y código. Los contrastes de campos se hicieron leyendo `db/central/00_base.sql`, `db/local/00_base.sql` y `db/*/01_hu06.sql`.

Frontend previsto: React (POS de tienda). El permiso se relee en cada request; ocultar un botón no autoriza.

## Historia

Como administrador de tienda, quiero registrar cada lote de medicamento con su número de lote, fecha de caducidad, proveedor y condiciones especiales de almacenamiento, para poder rastrear el origen de cualquier unidad vendida y asegurar su correcta conservación.

## Criterios de aceptación

1. Al recibir un pedido o registrar manualmente un producto, el sistema exige número de lote, fecha de caducidad y proveedor de origen.
2. Los medicamentos que requieren refrigeración u otra condición especial se marcan visualmente en el catálogo y en la pantalla de detalle.
3. Cada movimiento de entrada o salida (venta, ajuste, recepción) queda registrado automáticamente con usuario responsable, fecha, hora y cantidad.
4. Es posible reconstruir el historial completo de movimientos de un lote específico.
5. El sistema no permite registrar un lote sin número de lote, fecha de caducidad o proveedor (campos obligatorios validados).

## Tareas

| # | Tarea | Entregable |
| --- | --- | --- |
| 1 | Modelar la entidad Lote (número, caducidad, proveedor, condición especial) vinculada al producto | Servicio y rutas de lotes sobre la tabla `lote` existente; condición especial leída de `medicamento_ref` |
| 2 | Registro automático de movimientos (entradas/salidas) con auditoría de usuario, fecha y hora | Servicio único `registrarMovimiento` sobre `movimiento_inventario`, usado por toda operación que cambie stock |
| 3 | Indicador visual de condición especial en catálogo y detalle de producto | Componente de indicadores en el POS (resultados de HU-01 y detalle del medicamento) |

## Trazabilidad

| Fuente | Exigencia del documento | Cobertura en esta historia |
| --- | --- | --- |
| RF-02 | Lote con número, caducidad y proveedor; origen de cualquier unidad vendida; indicador visual de refrigeración u otra condición | Tabla `lote`, validación de obligatorios, contrato `detalle_factura.id_lote` para ventas, indicadores en catálogo y detalle |
| RF-04 | Registro automático de entradas y salidas (recepción, venta, ajuste manual) con tipo, usuario, fecha, hora y cantidad; reconstruir la variación del stock; respaldar el cierre de caja | Servicio único `registrarMovimiento`; historial con saldo acumulado; `referencia_documento` enlaza factura o pedido |
| RF-23 (parte de inventario) | Registrar la recepción del pedido y actualizar stock, lote y caducidad | `POST /api/local/pedidos/:id/recepcion` |
| RF-15 | Acciones críticas (incluidos ajustes de inventario) con fecha, hora y usuario | `registro_actividad`: `LOTE_REGISTRAR`, `PEDIDO_RECIBIR`, `LOTE_AJUSTAR` |
| RNF-01 | "Ajustes de inventario" es funcionalidad sensible; 100 % de accesos fuera de rol rechazados **y registrados** | Permiso `INVENTARIO_GESTIONAR`; 403 antes de mutar con `ACCESO_DENEGADO` |
| RNF-04 | Ninguna operación local depende del central | Lotes, recepción, ajustes e historial son 100 % locales |
| RNF-05 | Consultas en < 2 s; operaciones de registro en ≤ 3 s | Una transacción local por operación; historial paginado |
| RNF-06 | Dos operaciones concurrentes sobre el mismo lote dejan el stock correcto, sin pérdidas de actualización | `SELECT … FOR UPDATE` del lote dentro de `registrarMovimiento` |
| RNF-10 | 100 % de operaciones críticas en bitácora, conservada ≥ 2 años y no editable por usuarios finales | Ver "Auditoría" |
| RNF-11 | Agregar proveedor o categoría no requiere cambiar el esquema | Proveedores y permiso nuevo son inserts replicados |

Fuera de alcance: creación de pedidos y administración de proveedores (RF-22, otra historia), registro de ventas (RF-17) y devoluciones (RF-19), que deben usar el servicio de movimientos de esta historia; traslados entre tiendas (RF-26); alertas y bloqueo automático de lotes vencidos (RF-06, RF-07); alta del catálogo de medicamentos en el central.

## Roles y permisos

Hoy ningún permiso cubre registrar lotes. Se agrega **`INVENTARIO_GESTIONAR`** como dato (no es estructura): un insert idempotente en `permiso` y `rol_permiso` del central, replicado con `PERMISO_UPSERT` y `ROL_PERMISO_SET` (con la lista completa del rol, porque ese evento reemplaza los permisos del rol en el nodo local).

| Rol | Consultar lotes e historial (`INVENTARIO_CONSULTAR`) | Registrar, recibir y ajustar (`INVENTARIO_GESTIONAR`) |
| --- | --- | --- |
| cajero | Sí | No |
| administrador_tienda | Sí | Sí |
| administrador_general | Sí | Sí |

Se agrega `INVENTARIO_GESTIONAR` a `MODULES` en `apps/api/auth.mjs` (ámbito `tienda`).

## Nodos

- **Local**: todo lo de esta historia ocurre en el nodo de la tienda: lotes, movimientos, recepción de pedidos e historial. Funciona sin el central.
- **Central**: no guarda lotes. Recibe el efecto en stock por `STOCK_SNAPSHOT` (definido en HU-01), encolado en la misma transacción de cada movimiento.
- **Catálogo**: `medicamento_ref` y `proveedor_ref` deben estar replicados (ver Dependencias).

## Modelo: Lote

Se usa la tabla `lote` tal como está:

| Campo | Regla |
| --- | --- |
| `id_medicamento` | Obligatorio; debe existir en `medicamento_ref` con `activo = true` |
| `id_proveedor` | **Obligatorio**; debe existir en `proveedor_ref` con `activo = true` |
| `numero_lote` | **Obligatorio**; `trim`, 1 a 60 caracteres. Una cadena vacía se rechaza (el `NOT NULL` de la base no la detecta) |
| `fecha_caducidad` | **Obligatoria**; fecha válida y posterior a la fecha actual de la base (`current_date`). No se registra un lote ya vencido |
| `fecha_ingreso` | `current_date` de la base |
| `cantidad_inicial` | Cantidad de la primera entrada, entero > 0 |
| `cantidad_disponible` | Solo la modifica `registrarMovimiento`. Nunca se escribe directo |
| `estado` | `DISPONIBLE` si hay unidades, `AGOTADO` al llegar a 0. `BLOQUEADO` queda reservado para el bloqueo automático de lotes vencidos de RF-07 (otra historia); esta historia lo respeta y nunca lo cambia |

Unicidad: `UNIQUE(id_medicamento, id_proveedor, numero_lote)`. Si llega otra vez el mismo lote:
- con la misma `fecha_caducidad`: se suma como nueva `ENTRADA` al lote existente;
- con otra fecha: 409 `LOTE_INCONSISTENTE` ("El lote X ya existe con caducidad DD/MM/AAAA"). No se crea ni se modifica nada.

### Condición especial

La condición especial es **del medicamento**, no del lote. Así lo modela el diagrama de clases del documento (`Medicamento: requiereReceta, requiereRefrigeracion`; `Lote: numeroLote, fechaCaducidad, cantidadDisponible, estado`) y así está en el esquema: `medicamento_ref.requiere_refrigeracion` y `medicamento_ref.requiere_receta`. Cada lote hereda la condición de su medicamento, que corresponde a la práctica: la cadena de frío es del producto.

"U otra condición especial" (RF-02): el modelo de clases solo define refrigeración. Esta historia muestra refrigeración como condición de almacenamiento y receta como condición de dispensación. Otra condición (fotosensible, controlado) exigiría ampliar el modelo de clases y el esquema; queda fuera mientras el documento no la defina.

## Movimientos (Tarea 2)

Un solo servicio, `apps/api/inventario/movimientos.mjs`, es el **único** camino para cambiar existencias. Lo usan esta historia, la venta y la devolución (otras historias) y los traslados.

`registrarMovimiento(client, { idLote, tipo, cantidad, idEmpleado, referencia, observaciones, idTraslado })`, dentro de la transacción del llamador:

1. `select … from lote where id_lote = $1 for update` (serializa movimientos concurrentes del mismo lote).
2. Aplica el sentido del movimiento:

   | Tipo (`movimiento_inventario.tipo_movimiento`) | `sentido` | Lo origina |
   | --- | --- | --- |
   | `ENTRADA` | +1 | Registro manual y recepción de pedido (esta historia) |
   | `DEVOLUCION` | +1 | Devolución de cliente (otra historia) |
   | `TRASLADO_ENTRADA` | +1 | Traslado recibido (otra historia) |
   | `VENTA` | −1 | Venta (otra historia) |
   | `TRASLADO_SALIDA` | −1 | Traslado enviado (otra historia) |
   | `AJUSTE` | +1 o −1 | Corrección manual: sobrante de conteo (+1) o merma, rotura, vencimiento (−1) (esta historia) |

   **Columna nueva (excepción autorizada):** `movimiento_inventario.sentido smallint NOT NULL`, con valores `+1` (suma) o `−1` (resta). `cantidad` sigue siendo siempre positiva (`CHECK (cantidad > 0)` sin cambios) y el efecto en el stock es `sentido × cantidad`. Una restricción `movimiento_sentido_check` obliga a que los tipos de dirección fija tengan el sentido correcto; solo `AJUSTE` admite los dos. Script: `db/local/02_hu02_movimiento_sentido.sql`, idempotente; rellena `sentido` en filas existentes a partir del tipo antes de marcarla `NOT NULL`.
3. Salida mayor que lo disponible: 409 `STOCK_INSUFICIENTE`, sin escrituras.
4. Actualiza `cantidad_disponible` y `estado` (`AGOTADO` en 0, `DISPONIBLE` si vuelve a tener unidades y no está `BLOQUEADO`).
5. Inserta en `movimiento_inventario`: `id_empleado` de la sesión, `fecha_hora = now()` de la base, `cantidad`, `referencia_documento` (número de factura, id de pedido, etc.) y `observaciones`.
6. Encola `STOCK_SNAPSHOT` (HU-01) con el stock vendible actualizado del medicamento.

Si cualquier paso falla, la transacción entera se revierte: no puede quedar un movimiento sin su efecto en el lote, ni al revés.

Equivale a `Lote.descontar(cantidad)` y `Lote.estaVencido()` del diagrama de clases (nodo tienda): el servicio rechaza salidas sobre lotes vencidos o `BLOQUEADO` para cualquier tipo de salida salvo `AJUSTE` (dar de baja un vencido es justamente un ajuste).

### Auditoría (RNF-10)

- `movimiento_inventario` y `registro_actividad` son **solo de inserción**: el API no expone ninguna ruta para editarlos ni borrarlos. Un error se corrige con un movimiento compensatorio, nunca reescribiendo el historial.
- No hay depuración automática: la bitácora se conserva al menos dos años.
- Las operaciones rechazadas por permiso dejan `ACCESO_DENEGADO`.

## Operaciones

Todas exigen sesión local válida. Las que escriben exigen `INVENTARIO_GESTIONAR` y la cabecera `Idempotency-Key` (UUID): un doble clic o un reintento devuelve la misma respuesta sin un segundo movimiento. El resultado se guarda en `auth_operacion` (idempotency_key, payload_hmac, resultado_http, cuerpo_json), la tabla de idempotencia que ya usa HU-06 (decisión aprobada): las claves son UUID únicos por operación, así que un login y un registro de lote no chocan; el único efecto es que la tabla crece con ambos tipos de operación. Misma clave con otros datos → 409 `IDEMPOTENCY_CONFLICT`. Dos peticiones simultáneas con la misma clave se serializan con `pg_advisory_xact_lock` sobre la clave, para que la segunda espere y devuelva el resultado de la primera.

### Registrar lote manualmente

`POST /api/local/lotes` — `{ id_medicamento, id_proveedor, numero_lote, fecha_caducidad, cantidad, observaciones? }`

En una transacción: valida campos (400 con el campo exacto que falta o es inválido), crea o reutiliza el lote, `registrarMovimiento(ENTRADA)`, `registro_actividad` (`LOTE_REGISTRAR`). Responde 201 con el lote y su saldo.

### Recibir un pedido (RF-23)

Equivale a `Pedido.confirmarRecepcion()` del diagrama de clases. Generar el pedido (RF-22) es de otra historia; esta lo recibe.

`POST /api/local/pedidos/:id/recepcion` — `{ lineas: [{ id_medicamento, numero_lote, fecha_caducidad, cantidad }] }`

- El pedido debe estar `SOLICITADO` o `RECIBIDO_PARCIAL`. El proveedor sale del pedido (`pedido.id_proveedor`); no se puede cambiar.
- Cada línea exige número de lote y fecha de caducidad igual que el registro manual. El medicamento debe estar en `detalle_pedido` y la cantidad no puede superar lo pendiente (`cantidad_solicitada − cantidad_recibida`).
- Todo o nada en una transacción: lotes y entradas (`referencia_documento = 'PEDIDO-<id>'`), `detalle_pedido.cantidad_recibida`, `pedido.estado` (`RECIBIDO_TOTAL` si todo quedó recibido, si no `RECIBIDO_PARCIAL`), `pedido.fecha_recepcion = now()` y `registro_actividad` (`PEDIDO_RECIBIR`).

### Ajustar un lote

`POST /api/local/lotes/:id/ajustes` — `{ sentido: "SUMA" | "RESTA", cantidad, motivo }`

`sentido` y `motivo` obligatorios (motivo de 5 a 300 caracteres, va a `observaciones`). `registrarMovimiento(AJUSTE, sentido)` y `registro_actividad` (`LOTE_AJUSTAR`).

### Consultar

| Ruta | Permiso | Devuelve |
| --- | --- | --- |
| `GET /api/local/lotes?id_medicamento=&estado=&vence_en_dias=` | `INVENTARIO_CONSULTAR` | Lotes con proveedor, caducidad, saldo y estado |
| `GET /api/local/lotes/:id/movimientos` | `INVENTARIO_CONSULTAR` | Lote, proveedor y movimientos en orden cronológico (tipo, cantidad con signo, empleado, fecha y hora, referencia, observaciones, saldo acumulado) |
| `GET /api/local/medicamentos/:id` | `INVENTARIO_CONSULTAR` | Detalle del medicamento con condiciones especiales y sus lotes |
| `GET /api/local/proveedores` | `INVENTARIO_GESTIONAR` | Proveedores activos para el formulario |

### Reconstrucción del historial (criterio 4)

El saldo de un lote es `Σ sentido × cantidad` de sus movimientos, empezando en 0: el lote se crea con `cantidad_disponible = 0` y su primera `ENTRADA` lo lleva a `cantidad_inicial`. La ruta de movimientos calcula el saldo acumulado y devuelve `consistente: true` si el último saldo coincide con `lote.cantidad_disponible`. Una diferencia indica una escritura que no pasó por el servicio y se muestra como alerta.

Contrato para la historia de ventas: cada unidad vendida debe registrar `detalle_factura.id_lote` y un movimiento `VENTA` con `referencia_documento = numero_factura`. Así, desde una factura se llega al lote, y desde el lote a su proveedor y su recepción.

## Interfaz (POS React) — Tarea 3

- **Indicadores** (componente compartido con HU-01):
  - ❄ "Refrigeración 2–8 °C" en azul cuando `requiere_refrigeracion`.
  - ℞ "Requiere receta" cuando `requiere_receta`.
  - Texto además de color e ícono (accesibilidad).
- **Catálogo** (resultados de búsqueda de HU-01) y **detalle del medicamento**: muestran los indicadores. El detalle lista los lotes ordenados por caducidad (primero los que vencen antes) y resalta los que vencen dentro de `dias_alerta_caducidad`.
- **Formulario de lote**: medicamento, proveedor (lista), número de lote, fecha de caducidad, cantidad. Al elegir un medicamento refrigerado muestra el aviso de conservación. Valida en el cliente los obligatorios, pero la validación que cuenta es la del API.
- **Recepción de pedido**: lista de líneas pendientes del pedido con lote, caducidad y cantidad por línea.
- **Historial del lote**: tabla cronológica con saldo acumulado y el aviso de inconsistencia si aplica.
- El cajero ve consulta e historial, pero no los botones de registrar, recibir ni ajustar.

## Dependencias

- **Catálogo replicado** (lo agrega HU-01): `CATEGORIA_UPSERT` y `MEDICAMENTO_UPSERT`.
- **Proveedores replicados** (lo agrega esta historia): handler `PROVEEDOR_UPSERT` (upsert en `proveedor_ref`, destino `null`) y emisión inicial de los proveedores del central que aún no tengan evento.
- **Permiso**: `db/central/02_hu02_permisos.sql`, idempotente, inserta `INVENTARIO_GESTIONAR`, lo asigna a `administrador_tienda` y `administrador_general` y publica los eventos de réplica solo si el permiso no existía.
- **Datos demo** (`SEED_DEMO`): proveedores y un pedido `SOLICITADO` para demostrar la recepción (en el sprint 1 no hay historia que cree pedidos).
- **HU-01**: consume los `STOCK_SNAPSHOT` que generan los movimientos.

## Validación de esquema

Encaje: ENCAJA con un cambio autorizado (`movimiento_inventario.sentido`). La condición especial por medicamento coincide con el diagrama de clases.

| Dato | Definición leída | Uso |
| --- | --- | --- |
| Lote | `lote(id_lote serial, id_medicamento, id_proveedor NOT NULL, numero_lote varchar(60) NOT NULL, fecha_ingreso, fecha_caducidad date NOT NULL, cantidad_inicial, cantidad_disponible, estado)` | Entidad Lote |
| Unicidad | `UNIQUE(id_medicamento, id_proveedor, numero_lote)` | Mismo lote recibido dos veces |
| Checks | `cantidad_inicial >= 0`, `cantidad_disponible >= 0`, `estado IN ('DISPONIBLE','BLOQUEADO','AGOTADO')` | Respaldo en la base de las reglas del servicio |
| FKs | `lote → medicamento_ref`, `lote → proveedor_ref` | Exigen catálogo y proveedores replicados |
| Movimiento | `movimiento_inventario(id_lote, tipo_movimiento, cantidad > 0, id_empleado NOT NULL → empleado_ref, fecha_hora default now(), referencia_documento, id_traslado, observaciones)` | Auditoría de usuario, fecha, hora y cantidad |
| Sentido | **Nuevo**: `sentido smallint NOT NULL` (+1/−1) + `movimiento_sentido_check`; `cantidad > 0` sin cambios | Dirección explícita de cada movimiento; `AJUSTE` en ambos sentidos |
| Condición especial | `medicamento_ref.requiere_refrigeracion`, `requiere_receta` | Indicadores; no hay condición por lote |
| Pedido | `pedido(id_proveedor, estado IN ('SOLICITADO','RECIBIDO_PARCIAL','RECIBIDO_TOTAL','CANCELADO'), fecha_recepcion)` + `detalle_pedido(cantidad_solicitada, cantidad_recibida)` | Recepción |
| Índices existentes | `idx_lote_medicamento`, `idx_lote_caducidad`, `idx_lote_estado`, `idx_movimiento_lote`, `idx_movimiento_fecha` | Cubren las consultas de esta historia |
| Auditoría | `registro_actividad(id_empleado NOT NULL, accion, entidad_afectada, id_entidad_afectada, detalle)` | `LOTE_REGISTRAR`, `PEDIDO_RECIBIR`, `LOTE_AJUSTAR` |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-02 Gestionar lotes y condiciones especiales de almacenamiento

  Antecedentes:
    Dado que "admin.tienda" tiene sesión local válida con INVENTARIO_GESTIONAR
    Y el catálogo replicado contiene "Insulina NPH" (requiere refrigeración) y "Ibuprofeno 400 mg"
    Y el proveedor "Distribuidora Andina" está activo

  Escenario: Registrar un lote manualmente
    Cuando registra el lote "L-2026-001" de "Ibuprofeno 400 mg", proveedor "Distribuidora Andina", caducidad dentro de un año, 100 unidades
    Entonces el lote queda DISPONIBLE con 100 unidades
    Y hay un movimiento ENTRADA de 100 con "admin.tienda", fecha y hora de la base
    Y queda LOTE_REGISTRAR en registro_actividad

  Esquema del escenario: Campos obligatorios
    Cuando intenta registrar un lote sin <campo>
    Entonces recibe 400 indicando que <campo> es obligatorio
    Y no se crea lote ni movimiento
    Ejemplos:
      | campo             |
      | número de lote    |
      | fecha de caducidad |
      | proveedor         |

  Escenario: Número de lote en blanco
    Cuando registra un lote con número "   "
    Entonces recibe 400 "El número de lote es obligatorio"

  Escenario: Lote vencido
    Cuando registra un lote con caducidad de ayer
    Entonces recibe 400 "La fecha de caducidad debe ser posterior a hoy"

  Escenario: Mismo lote con otra caducidad
    Dado que existe "L-2026-001" de "Ibuprofeno 400 mg" y "Distribuidora Andina" con caducidad 2027-10-01
    Cuando registra "L-2026-001" del mismo medicamento y proveedor con caducidad 2027-12-01
    Entonces recibe 409 LOTE_INCONSISTENTE y nada cambia

  Escenario: Mismo lote con la misma caducidad suma unidades
    Dado que "L-2026-001" tiene 100 unidades
    Cuando registra otra vez "L-2026-001" con la misma caducidad y 20 unidades
    Entonces el lote tiene 120 unidades y dos movimientos ENTRADA

  Escenario: Recepción parcial y total de un pedido
    Dado un pedido SOLICITADO a "Distribuidora Andina" de 50 "Ibuprofeno 400 mg" y 10 "Insulina NPH"
    Cuando recibe 50 de ibuprofeno con su lote y caducidad
    Entonces el pedido queda RECIBIDO_PARCIAL
    Cuando recibe las 10 insulinas con su lote y caducidad
    Entonces el pedido queda RECIBIDO_TOTAL con fecha de recepción
    Y cada lote tiene proveedor "Distribuidora Andina"

  Escenario: No se recibe más de lo pedido
    Dado un pedido con 10 "Insulina NPH" pendientes
    Cuando intenta recibir 12
    Entonces recibe 400 y no se registra ninguna línea del pedido

  Escenario: Ajuste por merma
    Dado que "L-2026-001" tiene 120 unidades
    Cuando ajusta restando 5 unidades con motivo "Blísteres dañados"
    Entonces el lote tiene 115 y hay un movimiento AJUSTE de 5 con sentido -1, el motivo y el responsable

  Escenario: Ajuste por sobrante de conteo
    Dado que "L-2026-001" tiene 115 unidades
    Cuando ajusta sumando 2 unidades con motivo "Sobrante en conteo físico"
    Entonces el lote tiene 117 y hay un movimiento AJUSTE de 2 con sentido +1

  Escenario: El sentido debe corresponder al tipo
    Cuando se intenta guardar un movimiento VENTA con sentido +1
    Entonces la base lo rechaza por movimiento_sentido_check

  Escenario: No se saca más de lo disponible
    Dado que un lote tiene 3 unidades
    Cuando intenta ajustar 5
    Entonces recibe 409 STOCK_INSUFICIENTE y el lote sigue con 3

  Escenario: Movimientos concurrentes no descuadran el saldo
    Dado que un lote tiene 10 unidades
    Cuando dos ajustes de 6 llegan al mismo tiempo
    Entonces uno se aplica, el otro recibe STOCK_INSUFICIENTE y el lote queda con 4

  Escenario: Historial completo y consistente de un lote
    Dado que "L-2026-001" tuvo una entrada de 100, otra de 20 y un ajuste de 5
    Cuando consulta su historial
    Entonces ve los tres movimientos en orden con responsable, fecha, hora, cantidad y saldo acumulado 100, 120, 115
    Y consistente es verdadero

  Escenario: Indicador de refrigeración
    Cuando busca "insulina" o abre el detalle de "Insulina NPH"
    Entonces ve el indicador "Refrigeración 2–8 °C"
    Y "Ibuprofeno 400 mg" no lo muestra

  Escenario: Reintento idempotente
    Dado que la clave "k-7" registró el lote "L-2026-002"
    Cuando se reenvía la misma clave con los mismos datos
    Entonces recibe la misma respuesta y no hay un segundo movimiento

  Escenario: El cajero no registra lotes
    Dado que "cajero1" tiene sesión local válida
    Cuando intenta registrar un lote
    Entonces recibe 403, no hay mutación y queda ACCESO_DENEGADO
    Pero puede consultar el historial de un lote

  Escenario: Funciona sin conexión con el central
    Dado que el enlace con el central está offline
    Cuando registra un lote
    Entonces el lote y su movimiento se guardan en el nodo local
    Y el STOCK_SNAPSHOT queda en el outbox hasta que vuelva la conexión

  Escenario: La bitácora no se edita
    Dado que existe un movimiento AJUSTE de -5 registrado por error
    Cuando el administrador quiere corregirlo
    Entonces no existe ruta para editarlo ni borrarlo
    Y la corrección se registra como un AJUSTE de +5 con motivo

  Escenario: No se descuenta de un lote vencido
    Dado que un lote venció ayer y tiene 8 unidades
    Cuando una operación intenta una salida de tipo VENTA
    Entonces recibe 409 y el lote sigue con 8
    Pero un AJUSTE de 8 con motivo "Vencido" sí se aplica
```

## Ciclo

| Paso | Resultado |
| --- | --- |
| Especificación inicial | `BORRADOR` |
| Alineación con el documento de requerimientos | RF-02, RF-04, parte de RF-23, RF-15 y RNF-01/04/05/06/10/11 incorporados. Condición especial por medicamento confirmada con el diagrama de clases. `BLOQUEADO` reservado para RF-07. Bitácora solo de inserción por RNF-10 |
| Contexto del sprint 1 | Ventas, devoluciones y pedidos fuera del sprint; recepción con pedido demo; catálogo demo; nombres de acción a acordar con HU-07 |
| Decisiones del equipo | Aprobado: columna `movimiento_inventario.sentido` (excepción a la regla de no cambiar estructura). Aprobado: `auth_operacion` como tabla de idempotencia también para inventario |
| Decisiones abiertas | Ninguna |
| Implementación (2026-10-28) | Backend en `f68dc71` (`npm run test:hu02` en verde). Interfaz: `apps/web/src/Lotes.jsx` (lotes con ajustes, registro manual, recepción de pedido) y `apps/web/src/inventarioUi.jsx` (indicadores ❄/℞, detalle del medicamento, historial con saldo acumulado), también usados desde Inventario (HU-01) para el cajero |
