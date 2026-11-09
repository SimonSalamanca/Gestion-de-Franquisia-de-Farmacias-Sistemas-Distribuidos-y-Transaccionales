# HU-14 — Registrar la recepción de mercancía

Estado: **IMPLEMENTADA** (2026-11-09): API, esquema en `db/local/12_hu14_recepciones.sql`, pantalla "Lotes y recepción > Recibir pedido" con diferencias, historial de recepciones en la solicitud y pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor (GPT-5.6 Luna), igual que HU-13 y las demás.

Requerimientos: **RF-09** (proveedores, solicitudes de pedido y recepción), **RF-23** (recepción e ingreso de mercancía), **RF-04** (movimientos de inventario), **RF-15** (auditoría), regla de negocio 11 (la recepción pide lote y caducidad, actualiza el stock, se liga al pedido y permite registrar diferencias de cantidad), **RNF-04**, **RNF-06**, **RNF-10**.

## Historia

Como administrador de tienda, quiero registrar la recepción de un pedido y que el sistema actualice automáticamente el inventario, para cerrar el ciclo de abastecimiento sin errores manuales.

## Criterios de aceptación

1. Al registrar la recepción de un pedido, el sistema solicita los datos de lote y fecha de caducidad de las unidades recibidas.
2. El inventario se actualiza automáticamente con las nuevas unidades recibidas, asociadas a su lote y proveedor.
3. La recepción queda vinculada a la solicitud de reabastecimiento original.
4. Si la cantidad recibida no coincide con la solicitada, el sistema permite registrar la diferencia y deja constancia de ella.
5. La recepción queda registrada en el log de auditoría con usuario responsable, fecha y hora.

## Qué ya existía y qué agrega esta historia

HU-02 ya traía `recibirPedido` (`POST /api/local/pedidos/{id}/recepcion`): lote y caducidad obligatorios, entrada en el lote con su proveedor, `detalle_pedido.cantidad_recibida`, estado del pedido y auditoría `PEDIDO_RECIBIR`. HU-13 lo hizo aceptar solicitudes enviadas. **HU-14 cubre lo que faltaba**:

- **Vínculo de primera clase con la solicitud** (criterio 3): antes solo había una referencia de texto (`PEDIDO-<id>`) en el movimiento. Ahora cada recepción es un documento (`recepcion` + `detalle_recepcion`) ligado al pedido, con su lote, proveedor, responsable, fecha y hora.
- **Diferencias con constancia** (criterio 4): antes recibir de más era un error y no se podía terminar un pedido que no llegaba completo. Ahora el faltante y el sobrante se registran con su motivo, de forma inmutable.
- **Auditoría más completa** (criterio 5): `PEDIDO_RECIBIR` incluye el número de recepción y el documento del proveedor; las diferencias generan `RECEPCION_DIFERENCIA`.

## Decisiones (supuestos de la propuesta; pendientes de confirmar con el usuario)

1. **Sobrante.** Recibir más de lo pendiente se acepta **solo con motivo** (`motivo_diferencia`, 5 a 300 caracteres). Sin motivo sigue el error de HU-02 (400, "se reciben más unidades de las pendientes"). El inventario recibe todas las unidades; la constancia guarda lo solicitado y lo recibido acumulado.
2. **Faltante.** Una recepción con menos de lo pendiente deja el pedido `RECIBIDO_PARCIAL` y lo que falta sigue pendiente para otra entrega (sin constancia, porque todavía no es una diferencia). La diferencia nace cuando el administrador **cierra el pedido aunque falten unidades**: `cerrar_con_diferencia: true` en la misma recepción, o `POST /api/local/pedidos/{id}/cierre` si el proveedor avisa después que no entregará el resto. Ambas exigen motivo.
3. **Estado.** Un pedido cerrado con diferencia queda `RECIBIDO_TOTAL` (se ve "Recibida") con `pedido.con_diferencia = true`, que la lista de solicitudes muestra como "Con diferencia". No se agrega un estado nuevo: la diferencia es un dato del pedido, no un estado.
4. **Un pedido sin nada recibido no se "cierra con diferencia": se cancela** (HU-13). El cierre solo aplica a `RECIBIDO_PARCIAL`.
5. **Recepciones inmutables.** Una recepción registrada no se edita ni se borra (disparadores con error 42501, igual que la auditoría y las facturas). Un error de digitación se corrige con un ajuste de inventario (HU-02), que queda en el historial.
6. **Documento del proveedor** (remisión o factura): campo opcional para cruzarlo con el papel; no se valida su formato.
7. Sin commits: los cambios quedan en el árbol de trabajo para que el usuario los revise.

## Nodos

- **Local:** todo ocurre en la base de la tienda: `recepcion`, `detalle_recepcion`, `diferencia_recepcion`, `lote`, `movimiento_inventario`, `pedido`, `detalle_pedido`, `registro_actividad`. Funciona sin el central (RNF-04).
- **Central:** no escribe nada de esta historia. Recibe lo de siempre: el nuevo stock por `STOCK_SNAPSHOT` (cantidades absolutas, idempotente) y la auditoría de la tienda (`auditoria_tienda`, HU-07), que incluye `PEDIDO_RECIBIR`, `RECEPCION_DIFERENCIA` y `PEDIDO_CERRAR_DIFERENCIA`.

## Online

| Ruta | Permiso | Uso |
| --- | --- | --- |
| `GET /api/local/pedidos` | `INVENTARIO_GESTIONAR` | Pedidos por recibir (pendiente, enviado o recibido en parte), con `con_diferencia` |
| `POST /api/local/pedidos/{id}/recepcion` | `INVENTARIO_GESTIONAR` + `Idempotency-Key` | Registrar una recepción: `{ lineas: [{ id_medicamento, numero_lote, fecha_caducidad, cantidad }], documento_proveedor?, observaciones?, motivo_diferencia?, cerrar_con_diferencia? }` |
| `POST /api/local/pedidos/{id}/cierre` | `INVENTARIO_GESTIONAR` + `Idempotency-Key` | Dar por terminado un pedido recibido en parte: `{ motivo_diferencia }` |
| `GET /api/local/pedidos/{id}/recepciones` | `INVENTARIO_GESTIONAR` | Recepciones del pedido y sus diferencias |
| `GET /api/local/solicitudes/{id}/recepciones` | `PROVEEDOR_GESTIONAR` | Lo mismo, desde la solicitud (HU-13) |

Respuesta de la recepción: `{ id_pedido, id_recepcion, estado, fecha_hora, lotes, con_diferencia, diferencias: [{ tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, ... }] }`.

- **Criterio 1:** cada línea exige número de lote y fecha de caducidad (campo exacto en el error, `400`); la caducidad debe ser posterior a hoy según la fecha de la base; el medicamento debe estar en el pedido y activo; el proveedor sale del pedido y no se puede cambiar.
- **Criterio 2:** cada línea hace una `ENTRADA` en el lote (lo crea si no existe, o le suma si el número de lote y la caducidad coinciden; si la caducidad difiere, `409 LOTE_INCONSISTENTE`), con el proveedor del pedido. El nuevo stock se encola para el central en la misma transacción.
- **Criterio 3:** `recepcion.id_pedido` (FK) y `detalle_recepcion` (medicamento, lote, proveedor, cantidad). Del pedido se llega a todas sus recepciones; de un lote, a su recepción y a su pedido.
- **Criterio 4:** `diferencia_recepcion` guarda tipo (`FALTANTE` o `SOBRANTE`), lo solicitado, lo recibido acumulado, la diferencia firmada (`recibido − solicitado`), el motivo, quién y cuándo. La base verifica que `diferencia = recibido − solicitado`, que el signo corresponda al tipo y que el motivo tenga al menos 5 caracteres.
- **Criterio 5:** `PEDIDO_RECIBIR` (usuario de la sesión, `fecha_hora` de la base, número de recepción, líneas, estado y documento) y, si hay diferencias, `RECEPCION_DIFERENCIA` con el resumen y el motivo; el cierre sin unidades nuevas escribe `PEDIDO_CERRAR_DIFERENCIA`. La auditoría local ya es inmutable (HU-07).

## Offline y latencia

- La recepción es **100 % local**: lote, caducidad, inventario, vínculo, diferencias y auditoría se guardan en la tienda aunque no alcance al central (regla 1). No se encola nada nuevo: lo que viaja es el `STOCK_SNAPSHOT` de siempre.
- Una pérdida de conexión **a mitad** de la recepción no la deja a medias: todo va en una transacción de la base local y se revierte completo o se confirma completo.
- Latencia alta no equivale a desconexión: la recepción no consulta al central, así que no depende del estado del enlace.

## Reconexión, duplicados y conflictos

- **Reintentos:** `Idempotency-Key` obligatoria. Misma clave y mismo cuerpo devuelve la misma recepción (mismo `id_recepcion`) sin sumar unidades dos veces; dos clics simultáneos con la misma clave producen una sola recepción; la misma clave con otro cuerpo es `409`.
- **Dos usuarios sobre el mismo pedido:** `FOR UPDATE` sobre el pedido y sus líneas serializa las recepciones; la segunda ve lo ya recibido y calcula su diferencia sobre eso. Una recepción sobre un pedido ya terminado es `409 PEDIDO_CERRADO`.
- **Contra la venta y las alertas:** la entrada toma el lote y el stock como lo hace HU-02; la evaluación de alertas (HU-04) salta los lotes tomados (`SKIP LOCKED`) y nunca se interbloquea con la recepción.
- **Conflictos con el central:** no los hay: el central no es dueño de pedidos ni de recepciones. El stock viaja como cantidades absolutas, así que un reintento no descuadra el consolidado.
- **Resultado comparable tras sincronizar:** el stock por medicamento del central coincide con el de la tienda; la auditoría de la tienda llega al central con los mismos usuarios, fechas y detalles.

## Implementación

| Pieza | Archivo |
| --- | --- |
| Recepción, cierre con diferencia y consulta de recepciones | `recibirPedido`, `cerrarPedidoConDiferencia`, `listarRecepciones` en `apps/api/inventario/lotes.mjs` |
| Rutas | `apps/api/routes/lotes.mjs` (`/recepcion`, `/cierre`, `/recepciones`) y `apps/api/routes/solicitudes.mjs` (`/solicitudes/{id}/recepciones`) |
| Esquema | `db/local/12_hu14_recepciones.sql` |
| Interfaz | `RecibirPedido` en `apps/web/src/Lotes.jsx` (diferencia en vivo, motivo, cerrar con diferencia, recepciones anteriores); "Ver recepciones" y la marca "Con diferencia" en `apps/web/src/Solicitudes.jsx` |
| Pruebas | `scripts/probar-hu14.mjs` (`npm run test:hu14`) |

Cambios en código existente: `recibirPedido` (HU-02) conserva su contrato (mismo error al recibir de más sin motivo, mismo `PEDIDO_CERRADO`, mismas respuestas `estado` y `lotes`); `listarPedidosPendientes` y el detalle de solicitud devuelven `con_diferencia`.

## Validación de esquema

| Dato | Definición | Uso |
| --- | --- | --- |
| Recepción | `recepcion (id_recepcion, id_pedido FK, id_empleado FK, fecha_hora, documento_proveedor, observaciones)` | Documento ligado a la solicitud |
| Detalle | `detalle_recepcion (id_recepcion FK, id_medicamento FK, id_lote FK, id_proveedor FK, cantidad > 0)` | Lote y proveedor de cada línea |
| Diferencia | `diferencia_recepcion (id_pedido FK, id_recepcion FK nulo, id_medicamento FK, tipo, cantidad_solicitada, cantidad_recibida, diferencia, motivo, id_empleado FK, fecha_hora)` | Constancia |
| Coherencia | `diferencia_recepcion_tipo_check`, `diferencia_recepcion_cuadra_check`, `diferencia_recepcion_motivo_check` | Signo, cuenta y motivo |
| Inmutabilidad | `recepcion_inmutable_trg`, `detalle_recepcion_inmutable_trg`, `diferencia_recepcion_inmutable_trg` | Sin UPDATE ni DELETE (42501) |
| Marca en el pedido | `pedido.con_diferencia boolean NOT NULL DEFAULT false` | Lista de solicitudes |
| Cantidades del pedido | `detalle_pedido.cantidad_solicitada > 0`, `cantidad_recibida >= 0` (script base; el sobrante no lo viola) | Acumulado |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-14 Registrar la recepción de mercancía

  Escenario: La recepción pide lote y caducidad y actualiza el inventario
    Dado un pedido enviado a "Distribuidora X" de 30 "Ibuprofeno 400 mg"
    Cuando el administrador registra la recepción de 30 unidades sin número de lote
    Entonces recibe 400 en el campo numero_lote y no se guarda nada
    Cuando la registra con el lote "L-100", caducidad en 400 días y la remisión "REM-5"
    Entonces el lote queda con 30 unidades disponibles y el proveedor del pedido
    Y se registra una ENTRADA ligada al pedido con el usuario responsable

  Escenario: La recepción queda vinculada a la solicitud original
    Dado una recepción registrada sobre el pedido 12
    Cuando el administrador consulta las recepciones de la solicitud 12
    Entonces ve la recepción con su fecha, su responsable, su remisión y el lote y proveedor de cada línea

  Escenario: Recepción parcial y luego completa, sin diferencia
    Dado un pedido de 20 unidades
    Cuando se reciben 12 y después 8
    Entonces el pedido pasa de RECIBIDO_PARCIAL a RECIBIDO_TOTAL
    Y no queda constancia de diferencia

  Escenario: Faltante al cerrar el pedido
    Dado un pedido de 20 unidades del que se recibieron 14
    Cuando el administrador cierra el pedido sin indicar el motivo
    Entonces recibe 400 MOTIVO_DIFERENCIA_OBLIGATORIO y el pedido sigue sin cerrar
    Cuando lo cierra con el motivo "El proveedor no entregó el resto"
    Entonces el pedido queda RECIBIDO_TOTAL con diferencia
    Y queda constancia de un faltante de 6 con lo solicitado, lo recibido, el motivo, quién y cuándo
    Y queda RECEPCION_DIFERENCIA en la auditoría

  Escenario: Sobrante
    Dado un pedido de 10 unidades
    Cuando llegan 12 sin motivo
    Entonces recibe 400 y no se recibe nada
    Cuando se registran 12 con el motivo "Enviaron dos cajas de más"
    Entonces el inventario recibe las 12 unidades y queda constancia de un sobrante de 2

  Escenario: Cerrar con diferencia cuando el proveedor avisa después
    Dado un pedido recibido en parte con 15 unidades pendientes
    Cuando el administrador lo cierra con diferencia indicando el motivo
    Entonces queda RECIBIDO_TOTAL y la constancia de faltante sin recepción asociada
    Pero un pedido sin nada recibido no se cierra con diferencia (se cancela)

  Escenario: Reintentos y doble clic
    Dado una recepción con una Idempotency-Key
    Cuando se repite la misma petición, o llegan dos a la vez
    Entonces hay una sola recepción y las unidades se suman una sola vez
    Y la misma clave con otras cantidades recibe 409

  Escenario: Las constancias no se alteran
    Dado una recepción y su diferencia registradas
    Cuando cualquier usuario de la base intenta editarlas o borrarlas
    Entonces la base lo rechaza con error 42501
    Y una diferencia que no cuadra o sin motivo se rechaza con error 23514

  Escenario: Auditoría con responsable, fecha y hora
    Dado una recepción registrada por "admin.tienda"
    Entonces PEDIDO_RECIBIR queda con ese usuario, la hora de la base, el número de recepción y la remisión

  Escenario: Solo los administradores reciben mercancía
    Dado que "cajero1" tiene sesión en el POS
    Cuando intenta registrar o consultar una recepción, o cerrar un pedido
    Entonces recibe 403 y queda ACCESO_DENEGADO en la auditoría de la tienda

  Escenario: Recibir sin conexión con el central
    Dado que el estado real del POS es offline
    Cuando el administrador registra una recepción
    Entonces se guarda completa en la tienda y el historial se consulta
    Y el nuevo stock llega al central al reconectar, una sola vez
```

## Pruebas

`npm run test:hu14` (`scripts/probar-hu14.mjs`, casos por las rutas reales de `app.mjs` y por SQL). Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido y **una sola corrida a la vez**. Cada corrida crea sus proveedor y medicamentos y los deja inactivos al final; los lotes, recepciones y constancias que genera no se pueden borrar (son inmutables).

Resultado (2026-11-09, rama de Neon `Sprint3_Simon_HU`): `test:hu14` 57/57. Regresión: `test:hu13` 94/94, `test:hu02` 38/38 (la recepción de HU-02 conserva su contrato), `test:hu04` 64/64, `test:hu06` 38/38, `test:hu01` 39/39, `test:hu03` 44/44, `test:hu10` 65/65 y `test:sync` (con el API levantado) en "TODO OK"; `db:verificar --estricto` sin diferencias en central ni en local. La interfaz compila (`vite build`).

**Falla que no es de esta historia:** `test:hu08` 84/86 por un solo umbral, "la venta completa se confirma en ≤ 3 s (mediana)": 3,4 a 3,5 s en tres corridas seguidas. HU-14 no toca ventas (`ventas.mjs` y sus rutas no tienen cambios) y la causa es la latencia hacia Neon: cada ida y vuelta a la base mide hoy ~200 ms (en el documento de HU-04 se anotaban ~130 ms) y la venta hace unas 14, es decir ~2,8 s solo de red. El resto de la prueba de HU-08 pasa. Conviene repetirla desde una red mejor o con la rama más cerca.

Recorrido en el navegador como `admin.tienda`: en "Lotes y recepción > Recibir pedido" el pedido pendiente aparece con su botón; al elegirlo, la columna Diferencia muestra "Coincide", "Sobran 2" (pide motivo) o "Faltan 4" (ofrece cerrar el pedido con la diferencia), y confirmar un faltante con "Cerrar" sin motivo se rechaza con el aviso del motivo obligatorio. No se confirmó una recepción desde la interfaz (para no sumar inventario real a la rama); esa parte está cubierta por `test:hu14` por las rutas. No se recorrió en un celular.

## Pendiente para otras historias

- **Notificación al proveedor y conciliación con su factura:** el documento del proveedor es un texto libre; no hay cruce automático ni cuentas por pagar.
- **Devolución al proveedor** de lo que llega dañado o vencido (hoy se corrige con un ajuste de inventario, HU-02).
- **Recepción por lector de código de barras o importación de la remisión.**
- **Vista de diferencias de toda la red en el central:** las constancias son locales y solo su auditoría llega al central.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Propuesta (Grok 4.7) | Esta propuesta: decisiones, nodos, offline y conflictos. **Pendiente de revisión por el usuario** |
| Auditor GPT-5.6 Luna | pendiente (sin `APROBADO` la historia no está lista para el backlog según `AGENTS.md`) |
| Subagentes técnicos | `analista-contexto`, `redactor-criterios` y `disenador-flujos`: pendientes; el Gherkin de arriba es provisional |
| Implementación y pruebas | Ver "Pruebas" (2026-11-09) |
