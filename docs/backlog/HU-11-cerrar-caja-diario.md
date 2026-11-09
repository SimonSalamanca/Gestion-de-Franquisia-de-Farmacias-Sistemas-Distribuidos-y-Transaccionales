# HU-11 — Cerrar caja diario

Estado: **IMPLEMENTADA** (2026-11-09): API, esquema en `db/local/13_hu11_cierre_caja.sql`, módulo "Cierre de caja" del POS, aviso de caja cerrada en "Ventas y recetas" y pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor (GPT-5.6 Luna), igual que HU-13 y HU-14.

Requerimientos: **RF-07** (anulación/devolución y cierre de caja), regla de negocio 8 (el cierre totaliza por método de pago y por empleado, compara contra efectivo y vouchers, no cierra con diferencia sin justificar, es inmutable y auditable, y tras cerrar no se registran ventas de ese periodo sin un nuevo cierre), regla 14 (auditoría), **RNF-04** (autonomía local), **RNF-06** (concurrencia), **RNF-10**, **RNF-12** (el cierre no pasa con diferencia sin justificar).

## Historia

Como administrador de tienda, quiero que el sistema calcule el total vendido por método de pago y por empleado al finalizar el turno o el día, y lo compare contra el efectivo y los vouchers físicos, para garantizar que no existan descuadres sin justificar.

## Criterios de aceptación

1. El sistema totaliza automáticamente las ventas del periodo por método de pago y por empleado que operó la caja.
2. El administrador puede registrar el efectivo contado físicamente y los vouchers de tarjeta para compararlos contra el total calculado por el sistema.
3. El cierre de caja no puede completarse si existe una diferencia entre lo calculado y lo reportado, salvo que se registre una justificación.
4. El cierre queda registrado de forma auditable e inmutable.
5. Una vez cerrada la caja del día, no es posible registrar nuevas ventas asociadas a ese periodo sin abrir un nuevo cierre.

## Qué ya existía

El esquema base traía `cierre_caja` y `cierre_caja_metodo_pago` (sin uso), `factura_metodo_pago` (lo cobrado por método, HU-08) y `devolucion_pago` (lo reintegrado por método, HU-10). El permiso `CAJA_CERRAR` y el módulo "Cierre de caja" ya estaban en el catálogo para el administrador de tienda (HU-06), sin pantalla.

## Decisiones (supuestos de la propuesta; pendientes de confirmar con el usuario)

1. **Quién cierra.** Resuelve la inconsistencia 2 de `FARMAHUB_CONTEXT.md` (el UML dice Cajero; la HU, Administrador de tienda): **solo el administrador de tienda** (`CAJA_CERRAR`) cuenta, justifica y cierra, como pide la HU. El cajero no cierra ni ve el resumen; sí ve si la caja está abierta (para el aviso de la pantalla de ventas).
2. **El periodo es una apertura y un cierre, no un día de calendario.** La tienda tiene un periodo abierto (un número). Cada factura queda en el periodo en que se emitió (`factura.periodo_caja`, asignado por la base) y cada nota de devolución en el periodo abierto al emitirse. Cerrar totaliza ese periodo y deja la caja **CERRADA**; **un administrador abre el periodo siguiente** ("abrir un nuevo cierre"). Así se cubren turno y día (el administrador cierra cuando termina cualquiera) y no depende de la zona horaria ni de ventanas de tiempo en las que una venta en vuelo podría quedar entre dos periodos o en ninguno. Antes del primer cierre la caja está abierta (periodo 1: todo lo anterior a esta historia).
3. **Una devolución con la caja cerrada se permite** (el cliente tiene derecho a devolver) y **cae en el periodo siguiente**, nunca en uno cerrado. Su reintegro resta en el cierre donde cae.
4. **Qué se compara.** Por método de pago, lo calculado es **vendido − devuelto**. Se cuenta: efectivo contado (efectivo), total de vouchers (tarjeta débito y crédito) y total de comprobantes (transferencia). **Cada método se compara por separado**: un sobrante en efectivo no tapa un faltante en tarjeta.
5. **Justificación.** Hay diferencia si algún método no coincide. Entonces el cierre exige una justificación (10 a 300 caracteres). Un método con movimiento no se puede dejar sin contar (`400 CONTEO_INCOMPLETO`); uno sin movimiento se toma como 0.
6. **Sin fondo inicial de caja.** El efectivo esperado es el vendido en efectivo menos lo reintegrado en efectivo; no se modela una base de cambio con la que empieza el turno (queda pendiente).
7. **Resumen desactualizado.** El resumen trae una `firma`; si llegan ventas o devoluciones mientras se cuenta, cerrar con la firma vieja da `409 RESUMEN_DESACTUALIZADO` con el resumen nuevo, para no comparar lo contado contra otro total.
8. Sin commits: los cambios quedan en el árbol de trabajo para que el usuario los revise.

## Nodos

- **Local:** todo ocurre en la base de la tienda (`caja_control`, `apertura_caja`, `cierre_caja`, `cierre_caja_metodo_pago`, `cierre_caja_empleado`, `factura`, `anulacion_devolucion`, `registro_actividad`). Funciona sin el central (RNF-04).
- **Central:** no escribe nada de esta historia. Recibe la auditoría de la tienda (`CAJA_CERRAR`, `CAJA_ABRIR`) por la subida de HU-07, con el responsable, la fecha y el detalle (incluida la justificación).

## Online

| Ruta | Permiso | Uso |
| --- | --- | --- |
| `GET /api/local/caja/estado` | `VENTA_REGISTRAR` o `CAJA_CERRAR` | Si la caja está abierta, el periodo y el último cierre |
| `GET /api/local/caja/resumen` | `CAJA_CERRAR` | Totales del periodo abierto por método y por empleado, con la `firma` (con la caja cerrada, `resumen: null`) |
| `POST /api/local/caja/cierre` | `CAJA_CERRAR` + `Idempotency-Key` | Cerrar: `{ contado: [{ id_metodo_pago, monto }], justificacion?, turno?, firma? }` |
| `POST /api/local/caja/apertura` | `CAJA_CERRAR` + `Idempotency-Key` | Abrir el periodo siguiente: `{ turno? }` |
| `GET /api/local/caja/cierres` | `CAJA_CERRAR` | Últimos 50 cierres |
| `GET /api/local/caja/cierres/{id}` | `CAJA_CERRAR` | Un cierre con su detalle por método y por empleado |

- **Criterio 1:** el resumen suma `factura_metodo_pago` de las facturas del periodo (por método y por empleado que emitió la factura) y resta `devolucion_pago` de las notas del periodo (por método y por empleado que procesó la nota). Importes en centavos enteros.
- **Criterio 2:** `contado` lleva un monto por método (no negativo, máximo dos decimales). `total_efectivo_contado` es el contado en efectivo y `total_vouchers` la suma de las tarjetas; `total_sistema` es la suma de lo calculado.
- **Criterio 3:** con una diferencia en cualquier método y sin justificación: `409 CIERRE_CON_DIFERENCIA`, con cada método que no cuadra (calculado, contado y diferencia); nada se guarda y la caja sigue abierta. El estado del cierre es `CONCILIADO` o `CON_DIFERENCIA`; una justificación enviada sin diferencia no se guarda.
- **Criterio 4:** el cierre, sus métodos, sus empleados y la apertura son inmutables (disparadores con error 42501); la auditoría lo registra con responsable, fecha y hora.
- **Criterio 5:** con la caja cerrada, `POST /api/local/ventas` responde `409 CAJA_CERRADA`, sin factura ni descuento de stock.

## Concurrencia: ventas en curso contra el cierre

`caja_control` es una sola fila. La venta la lee con `FOR SHARE` como **primera** sentencia (antes de bloquear lotes), y el cierre y la apertura la toman con `FOR UPDATE`. Entonces: el cierre espera a que terminen las ventas ya iniciadas, así las incluye en sus totales; una venta que llega durante el cierre espera, y al continuar ya ve la caja cerrada y se rechaza. Ninguna venta queda sin contar ni se cuela después del cierre. La prueba lanza cinco ventas y un cierre a la vez y comprueba que el cierre incluye exactamente las aceptadas y que ninguna factura es posterior a él. Dos cierres a la vez tampoco duplican (`409 CAJA_YA_CERRADA`, más el índice único `ux_cierre_caja_periodo`).

## Garantías en la base

- `factura_periodo_caja_trg` (BEFORE INSERT en `factura`): con la caja cerrada rechaza la factura (`CAJA_CERRADA`, 23514) y fija `periodo_caja`. Es la garantía para cualquier camino; la API lo comprueba antes por rapidez.
- `anulacion_periodo_caja_trg`: asigna el periodo de la devolución (el abierto, o el siguiente si la caja está cerrada).
- `cierre_caja_integro_trg` (diferido al commit): los métodos suman el total del sistema, el estado es `CON_DIFERENCIA` si y solo si algún método difiere, y un cierre con diferencia lleva su justificación (≥ 10 caracteres). Si algo no cuadra, el commit falla y no queda cierre ni caja cerrada.
- `cierre_caja_metodo_pago_calculo_check`: calculado = vendido − devuelto y diferencia = contado − calculado.
- `ux_cierre_caja_periodo`: un periodo se cierra una sola vez.
- Inmutabilidad: `cierre_caja_inmutable_trg`, `cierre_caja_metodo_pago_inmutable_trg`, `cierre_caja_empleado_inmutable_trg`, `apertura_caja_inmutable_trg`.

## Offline y latencia

- Cerrar, abrir, resumir, vender y consultar son **100 % locales**: la prueba lo repite con el estado real offline. Nada se encola para el central salvo lo de siempre (la auditoría de la tienda sube cuando hay red).
- Una pérdida de conexión **a mitad** del cierre no lo deja a medias: cierre, métodos, empleados, auditoría y caja cerrada van en una sola transacción de la base local.
- Latencia alta no equivale a desconexión: el cierre no consulta al central, así que no depende del estado del enlace.

## Reconexión, duplicados y conflictos

- **Reintentos:** `Idempotency-Key` obligatoria. Misma clave y mismo cuerpo devuelve el mismo cierre (mismo `id_cierre`); misma clave con otro cuerpo, `409`.
- **Dos administradores:** se serializan con `FOR UPDATE`; el segundo recibe `409 CAJA_YA_CERRADA` (o `CAJA_YA_ABIERTA`).
- **Conflictos con el central:** no los hay: el central no es dueño del cierre. Lo que sube es auditoría (inmutable, append-only), idempotente por su identificador de registro (HU-07).
- **Resultado comparable tras sincronizar:** la auditoría del central y la de la tienda muestran los mismos usuarios, fechas y detalles; el cierre vive solo en la tienda que lo hizo.

## Implementación

| Pieza | Archivo |
| --- | --- |
| Totales, cierre, apertura y consulta | `apps/api/caja.mjs` |
| Rutas | `apps/api/routes/caja.mjs`, registradas en `apps/api/app.mjs` |
| Bloqueo de ventas | `apps/api/ventas.mjs` (primera sentencia de `registrarVenta`) y el disparador de la base |
| Esquema | `db/local/13_hu11_cierre_caja.sql` |
| Interfaz | `apps/web/src/CierreCaja.jsx` (módulo "Cierre de caja": cerrar y cierres anteriores), aviso en `apps/web/src/Caja.jsx`, registro en `apps/web/src/App.jsx` |
| Pruebas | `scripts/probar-hu11.mjs` (`npm run test:hu11`) |

Cambios en código existente: `registrarVenta` (HU-08) consulta primero si la caja está abierta; `factura` y `anulacion_devolucion` ganan la columna `periodo_caja`. Todo lo anterior queda en el periodo 1.

## Validación de esquema

| Dato | Definición | Uso |
| --- | --- | --- |
| Estado de la caja | `caja_control (id = 1, periodo, abierta, abierta_en)` | Periodo vigente y si se vende |
| Periodo de cada venta y nota | `factura.periodo_caja`, `anulacion_devolucion.periodo_caja` (`integer NOT NULL DEFAULT 1`) | Totales por periodo |
| Cierre | `cierre_caja` (base) + `periodo_caja`, `abierto_en`, `justificacion varchar(300)`; `total_sistema`, `total_efectivo_contado`, `total_vouchers`, `diferencia`, `estado IN ('CONCILIADO','CON_DIFERENCIA')`, `fecha_hora_cierre`, `id_empleado` | Cabecera |
| Por método | `cierre_caja_metodo_pago` (base) + `vendido`, `devuelto`, `diferencia`; `total_calculado_sistema`, `total_reportado_empleado` | Lo comparado |
| Por empleado | `cierre_caja_empleado (id_cierre, id_empleado, id_metodo_pago, vendido, devuelto)` | Criterio 1 |
| Apertura | `apertura_caja (periodo_caja UNIQUE, id_empleado, fecha_hora, turno)` | Quién abrió el periodo |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-11 Cerrar caja diario

  Escenario: El sistema totaliza por método de pago y por empleado
    Dado un periodo con ventas de la cajera y del administrador y una anulación procesada por el administrador
    Cuando el administrador abre el resumen de cierre
    Entonces ve por método vendido, devuelto y calculado (vendido menos devuelto)
    Y por empleado lo vendido, lo devuelto y el neto, con el detalle por método
    Y la suma por empleado coincide con el total del sistema

  Escenario: Registrar lo contado y compararlo
    Dado un resumen con efectivo 4000 y crédito 2000 calculados
    Cuando el administrador cuenta 3900 en efectivo y 2000 en vouchers
    Entonces ve que faltan 100 en efectivo y que el crédito cuadra
    Y un método con movimiento no se puede dejar sin contar

  Escenario: No se cierra con una diferencia sin justificar
    Dado un faltante de 100 en efectivo
    Cuando intenta cerrar sin justificación, o con una de menos de 10 caracteres
    Entonces recibe 409 CIERRE_CON_DIFERENCIA con el método que no cuadra y no se guarda nada
    Y un sobrante en efectivo no tapa un faltante en tarjeta

  Escenario: Cierre con diferencia justificada
    Cuando el administrador cierra con la justificación "Faltan 100 pesos: cambio mal entregado"
    Entonces el cierre queda CON_DIFERENCIA con total del sistema, efectivo contado, vouchers, diferencia y justificación
    Y queda CAJA_CERRAR en la auditoría con el responsable, la fecha y la hora
    Y repetir la petición con la misma clave devuelve el mismo cierre

  Escenario: El cierre es inmutable
    Dado un cierre registrado
    Cuando cualquier usuario de la base intenta editarlo o borrarlo, o a sus detalles o a la apertura
    Entonces la base lo rechaza con error 42501
    Y un cierre con diferencia sin justificación, o con métodos que no suman su total, se rechaza al hacer commit

  Escenario: Con la caja cerrada no se vende
    Dado que la caja del periodo está cerrada
    Cuando el cajero o el administrador intentan registrar una venta
    Entonces reciben 409 CAJA_CERRADA y no se crea factura ni se descuenta stock
    Y la base rechaza una factura insertada por cualquier otro camino

  Escenario: Abrir un nuevo periodo
    Dado que la caja está cerrada
    Cuando el cajero intenta abrirla recibe 403
    Y cuando el administrador abre un nuevo periodo se puede vender otra vez
    Pero abrir con la caja abierta da 409 CAJA_YA_ABIERTA

  Escenario: Una devolución con la caja cerrada cae en el periodo siguiente
    Dado que la caja está cerrada
    Cuando el administrador registra una devolución
    Entonces la nota queda en el periodo siguiente y el cierre ya hecho no cambia
    Y resta de lo calculado cuando ese periodo se cierre

  Escenario: Ventas en curso mientras se cierra
    Cuando cinco ventas y un cierre llegan a la vez
    Entonces cada venta se acepta (y entra en el cierre) o se rechaza por caja cerrada
    Y el cierre incluye exactamente las ventas aceptadas y ninguna factura es posterior a él

  Escenario: Hubo ventas mientras el administrador contaba
    Dado un resumen calculado y una venta posterior
    Cuando intenta cerrar con el resumen anterior
    Entonces recibe 409 RESUMEN_DESACTUALIZADO con el resumen nuevo

  Escenario: Cerrar sin conexión con el central
    Dado que el estado real del POS es offline
    Cuando el administrador vende, resume, cierra y abre la caja
    Entonces todo funciona con los datos de la tienda

  Escenario: Solo el administrador cierra la caja
    Dado que "cajero1" tiene sesión en el POS
    Cuando intenta ver el resumen, cerrar, abrir o consultar los cierres
    Entonces recibe 403 y queda ACCESO_DENEGADO en la auditoría de la tienda
    Pero puede ver si la caja está abierta
```

## Pruebas

`npm run test:hu11` (`scripts/probar-hu11.mjs`, casos por las rutas reales de `app.mjs` y por SQL). Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido y **una sola corrida a la vez**. **Cierra la caja de la tienda varias veces** (cada cierre es permanente) y la deja **abierta** al terminar, con un periodo nuevo; si la caja de la rama está cerrada al empezar, la abre.

Resultado (2026-11-09, rama de Neon `Sprint3_Simon_HU`): `test:hu11` 80/80, dos corridas seguidas. En la carrera de cinco ventas contra el cierre, el cierre incluyó exactamente las ventas aceptadas. Regresión: `test:hu08` (todas sus comprobaciones), `test:hu10` 65/65, `test:hu09` 49/49, `test:hu05` 64/64, `test:hu12` 71/71, `test:hu13` 94/94, `test:hu14` 57/57, `test:hu02` 38/38, `test:hu04` 64/64, `test:hu06` 38/38, `test:hu07` 63/63, `test:hu03` 44/44, `test:hu01` 39/39 y `test:sync` (con el API levantado) en verde; `db:verificar --estricto` sin diferencias en central ni en local. La interfaz compila (`vite build`).

Hallazgos en la regresión:
- **Corregido:** la primera versión de la prueba de HU-11 dejaba en el outbox los eventos de sus ventas. La siguiente prueba que envía el outbox (HU-08) los mandaba junto con los suyos y descuadraba sus sumas exactas del consolidado del central (débito y crédito). La prueba de HU-11 ahora envía su outbox al terminar, y HU-08 vuelve a pasar completa.
- **Corregido:** un periodo sin movimiento no se podía cerrar sin enviar un conteo. Ahora `contado` es opcional; un método con movimiento sigue exigiendo su conteo (`CONTEO_INCOMPLETO`).
- **No es de esta historia:** `test:hu16` falló en un umbral de rendimiento ("vista de un año con 50 tiendas: p95 < 2000 ms"; midió 3,4 s). Es latencia hacia Neon (~200 ms por ida y vuelta, igual que el umbral de HU-08 en la regresión de HU-14), y HU-11 no toca la vista de red. No se repitió.

Recorrido en el navegador como `admin.tienda`: el módulo "Cierre de caja" muestra el periodo abierto con lo vendido, devuelto y calculado por método y por empleado (con su detalle por método); al escribir lo contado, la columna Diferencia muestra "Faltan …" y aparece la justificación obligatoria; con métodos sin contar, el botón avisa cuáles faltan. "Cierres anteriores" lista los cierres con su estado y su detalle (justificación, calculado, contado y diferencia por método, y lo de cada empleado). No se confirmó un cierre desde la interfaz (la prueba los hace por las rutas) ni se vio el aviso de caja cerrada en "Ventas y recetas" (la caja estaba abierta); no se recorrió en un celular.

## Pendiente para otras historias

- **Fondo inicial de caja** (base de cambio con la que se abre el turno) y retiros parciales de efectivo durante el turno.
- **Cierre ciego** (que el cajero cuente sin ver el total del sistema) y la aprobación por un segundo usuario de los cierres con diferencia.
- **Reporte de cierres y diferencias de toda la red en el central** (hoy solo llega su auditoría).
- **Notificación** (correo o push) al administrador general cuando un cierre queda con diferencia.
- **Cierre automático** al final del día si nadie lo hace.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Propuesta (Grok 4.7) | Esta propuesta: decisiones, nodos, offline y conflictos. **Pendiente de revisión por el usuario** |
| Auditor GPT-5.6 Luna | pendiente (sin `APROBADO` la historia no está lista para el backlog según `AGENTS.md`) |
| Subagentes técnicos | `analista-contexto`, `redactor-criterios` y `disenador-flujos`: pendientes; el Gherkin de arriba es provisional |
| Implementación y pruebas | Ver "Pruebas" (2026-11-09) |
