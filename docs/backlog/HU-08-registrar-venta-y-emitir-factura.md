# HU-08 — Registrar una venta y emitir factura

Estado: **IMPLEMENTADA** (2026-11-04): API, esquemas en `db/local/07_hu08_ventas.sql` y `db/central/08_hu08_ventas.sql`, pantalla de caja en "Ventas y recetas" y pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor (GPT-5.6 Luna), igual que HU-03, HU-07 y HU-12.

Requerimientos: **RF-06** (venta y factura), reglas de negocio 1, 2 y 3, **RNF-04** (autonomía local), **RNF-05** (venta completa en ≤ 3 s), **RNF-06** (concurrencia), **RNF-10**, **RNF-12** (integridad financiera).

## Historia

Como cajero, quiero registrar la venta de uno o varios medicamentos y emitir la factura correspondiente con uno o varios métodos de pago, para completar la transacción de forma correcta y sin dejar operaciones parcialmente aplicadas.

## Criterios de aceptación

1. El sistema calcula el subtotal a partir del precio vigente, aplica impuestos y genera el total, permitiendo pagos combinados (efectivo, tarjeta débito, tarjeta crédito, transferencia).
2. La factura recibe un número consecutivo único.
3. La venta se ejecuta como una transacción atómica: registro de factura, descuento de stock del lote correspondiente y registro del movimiento de inventario ocurren todos o ninguno.
4. Si cualquier paso de la transacción falla, la operación completa se revierte sin dejar stock ni factura parcialmente registrados.
5. El sistema soporta el registro concurrente de múltiples ventas simultáneas en la misma tienda sin generar inconsistencias en el stock.

## Decisiones (con el usuario, 2026-11-04)

1. **Impuesto por medicamento.** `medicamento.tasa_impuesto` (porcentaje, 0 = exento) vive en el central y se replica a `medicamento_ref` dentro de `MEDICAMENTO_UPSERT`. Cada línea de la factura **fija** la tasa y el impuesto con que se vendió (`detalle_factura.tasa_impuesto` e `impuesto_linea`), igual que el precio. Demo: `MED-003` 5 %, `MED-010` y `MED-011` 19 %, el resto exento. Un evento anterior a la tasa no la trae y se toma como exento hasta que llegue el que sí.
2. **Lotes por FEFO, automáticos.** El cajero elige medicamento y cantidad; el sistema descuenta primero del lote que vence antes y completa con el siguiente. Una línea puede repartirse en varios lotes. Los vencidos y bloqueados no cuentan como stock vendible.
3. **Una venta, una moneda exacta.** Todo el cálculo es en centavos enteros. El impuesto se redondea por línea de lote (mitad hacia arriba) y la factura suma esas líneas, así que `total = subtotal + impuestos` y las líneas suman exactamente la factura. Los pagos deben sumar **exactamente** el total (no hay cambio ni pago excedente).
4. **Consecutivo sin saltos, por tienda:** `T{tienda}-{6 dígitos}` (`T1-000035`). El contador sube dentro de la transacción: si la venta falla, el número no se consume.
5. **Métodos de pago:** los códigos que ya existen en las bases (`efectivo`, `tarjeta_debito`, `tarjeta_credito`, `transferencia`); la API los muestra con su etiqueta ("Tarjeta débito"). Hasta HU-08 nadie los replicaba a la tienda: ahora viajan en `METODO_PAGO_UPSERT`.
6. **Receta (HU-12):** una línea de un controlado lleva `id_receta`. El paciente de la factura es el de la receta, y el trigger de HU-12 sigue siendo quien rechaza la línea sin receta válida.
7. **Fuera de alcance:** historial y reimpresión (HU-09), anulación y devolución (HU-10) y cierre de caja (HU-11).

## Nodos

- **Local (único escritor de la venta):** `factura`, `detalle_factura`, `factura_metodo_pago`, `lote`, `movimiento_inventario`, `secuencia_factura`, `registro_actividad`, `outbox_sync`. Funciona sin conexión con el central.
- **Central:** recibe por el outbox la venta (`VENTA_REGISTRADA`) y la suma en `venta_consolidada` (tienda, día UTC y método de pago), y el stock (`STOCK_SNAPSHOT`, ya existente). Es dueño de los métodos de pago y de la tasa de impuesto.
- **Desde HU-16 (2026-11-09):** el evento lleva además `categorias: [{ id_categoria, unidades, ingresos }]`, un resumen de las líneas por categoría (`porCategoria` en `apps/api/ventas.mjs`; 0 = sin categoría). El central lo suma en `venta_categoria_consolidada` en la misma transacción e idempotencia (`inbox_sync`). `DEVOLUCION_REGISTRADA` (HU-10) lleva lo devuelto y lo resta. Un evento anterior, sin `categorias`, solo alimenta `venta_consolidada`.

## Rutas (solo `/api/local`, permiso `VENTA_REGISTRAR`)

| Ruta | Uso |
| --- | --- |
| `GET /ventas/metodos-pago` | Métodos activos con su etiqueta |
| `POST /ventas/calcular` | Vista previa con el **mismo cálculo** de la venta: precio vigente, lotes por FEFO, impuesto, total y problemas (sin stock, sin precio). No escribe ni bloquea lotes |
| `POST /ventas` | Registra la venta. `Idempotency-Key`. Cuerpo: `lineas: [{ id_medicamento, cantidad, id_receta? }]`, `pagos: [{ id_metodo_pago, monto }]` |
| `GET /ventas/{id}` | La factura con líneas, lotes, impuestos, recetas y pagos |

Errores: 400 (datos, `PAGO_NO_CUADRA` con total y pagado, `SIN_PRECIO`, `MEDICAMENTO_NO_VALIDO`); 409 `STOCK_INSUFICIENTE` (con lo disponible) y los `RECETA_*` de HU-12.

## Cómo se garantiza la atomicidad (criterios 3 y 4)

Una sola transacción con `Idempotency-Key`:

1. **Cálculo con los lotes bloqueados** (`SELECT ... FOR UPDATE` en orden de `id_lote`, el mismo para todas las ventas).
2. Validación de los métodos de pago y de la suma exacta.
3. Factura numerada (`siguiente_numero_factura`).
4. Líneas, pagos, auditoría `VENTA_REGISTRAR` y el evento `VENTA_REGISTRADA` en una sola sentencia; las líneas pasan por los triggers de receta de HU-12.
5. Descuento de cada lote por `registrarMovimiento` (tipo `VENTA`, referencia = número de factura): bloquea, valida vencido/bloqueado/stock y deja el movimiento. El stock se publica al central una sola vez.

Cualquier error revierte todo: factura, líneas, pagos, stock, movimientos, eventos y el número.

**Refuerzo en la base:** el trigger diferido `factura_completa` revisa al hacer **commit** que las líneas sumen el subtotal y el impuesto, que los pagos sumen el total y que cada lote tenga su movimiento de venta por la misma cantidad. Si algo falta, el commit falla (`FACTURA_INCOMPLETA`, `FACTURA_PAGOS`, `FACTURA_SIN_MOVIMIENTO`) y no queda nada, aunque el código de la API se equivoque. Además `detalle_factura_subtotal_check` exige `subtotal_linea = cantidad × precio`.

## Concurrencia (criterio 5)

- Dos ventas sobre el mismo lote se serializan por el bloqueo de fila: la segunda espera, relee el saldo ya descontado y, si no alcanza, recibe `STOCK_INSUFICIENTE`. El stock nunca baja de cero.
- Los lotes se bloquean siempre en el mismo orden global, así que ventas con las mismas líneas en distinto orden no se interbloquean.
- El contador de facturas es una fila bloqueada hasta el commit: los números salen únicos y consecutivos aunque las ventas lleguen a la vez. Es el costo de un consecutivo sin saltos en una caja.

## Offline, duplicados y reconexión

- **Sin conexión:** la venta funciona igual (RNF-04). Solo un controlado **nuevo** exige el central (HU-12, opción A).
- **Reintento:** la misma `Idempotency-Key` y el mismo cuerpo devuelven la misma factura (sin segundo descuento); con otro cuerpo, 409. La pantalla conserva la clave mientras no haya respuesta definitiva.
- **Reconexión:** `VENTA_REGISTRADA` sale por el outbox en orden y el central lo aplica una sola vez (`inbox_sync`): un evento repetido no suma dos veces al consolidado. `total_facturas` cuenta la factura en cada método con que se pagó.

## Implementación

| Pieza | Archivo |
| --- | --- |
| Cálculo, venta y factura | `apps/api/ventas.mjs` |
| Rutas | `apps/api/routes/ventas.mjs`, registradas en `apps/api/app.mjs` |
| Consolidado y réplica | `VENTA_REGISTRADA` en `apps/api/sync/central.mjs`; `METODO_PAGO_UPSERT` y la tasa en `apps/api/sync/handlers/catalogo.mjs`; emisión en `apps/api/migrate.mjs` |
| Esquemas | `db/central/08_hu08_ventas.sql`, `db/local/07_hu08_ventas.sql` |
| Interfaz | `apps/web/src/Ventas.jsx` (caja), `apps/web/src/Caja.jsx` (pestañas Venta y Recetas) |
| Impuestos demo | `IMPUESTOS` en `apps/api/demo.mjs` |
| Pruebas | `scripts/probar-hu08.mjs` (`npm run test:hu08`) |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-08 Registrar una venta y emitir factura

  Escenario: Cálculo con precio vigente e impuesto por medicamento
    Dado "Prueba A" a 1000.50 con 19 % de impuesto y "Prueba B" a 2500.00 exento
    Cuando el cajero vende 3 de A y 2 de B
    Entonces el subtotal es 8001.50, el impuesto 570.29 y el total 8571.79
    Y la factura guarda el precio y la tasa de cada línea

  Escenario: Pago combinado
    Dado una venta de 8571.79
    Cuando paga 3000.00 en efectivo, 3000.00 con débito y 2571.79 por transferencia
    Entonces la factura registra los tres pagos
    Pero si los pagos suman 8571.78 la venta se rechaza con PAGO_NO_CUADRA y no se escribe nada

  Escenario: Número consecutivo sin saltos
    Dado la última factura T1-000017
    Cuando una venta falla por falta de receta o de stock
    Entonces el número no se consume
    Y la siguiente venta exitosa es T1-000018

  Escenario: Todo o nada
    Dado una venta de un medicamento libre y un controlado sin receta
    Cuando se intenta registrar
    Entonces se rechaza con RECETA_REQUERIDA
    Y no queda factura, stock descontado, movimiento ni evento para el central

  Escenario: La base no deja una factura incompleta
    Cuando una transacción intenta hacer commit de una factura sin líneas, sin pagos que sumen el total o sin movimiento de inventario
    Entonces el commit falla con FACTURA_INCOMPLETA, FACTURA_PAGOS o FACTURA_SIN_MOVIMIENTO

  Escenario: Lotes por FEFO
    Dado un lote que vence en 30 días con 10 unidades, otro en 90 días, uno vencido y uno bloqueado
    Cuando se vende un total de 12 unidades
    Entonces salen primero las del lote que vence antes y el resto del siguiente
    Y el vencido y el bloqueado no se tocan

  Escenario: Ventas simultáneas
    Dado un lote con 3 unidades
    Cuando ocho ventas de una unidad llegan a la vez
    Entonces exactamente tres se registran y cinco reciben STOCK_INSUFICIENTE
    Y el stock es cero, nunca negativo, y los números de factura son únicos y consecutivos

  Escenario: Ventas simultáneas con las mismas líneas en distinto orden
    Cuando ocho ventas combinan dos medicamentos en órdenes opuestos
    Entonces todas se registran sin interbloqueo y el stock baja exactamente lo vendido

  Escenario: Reintento idempotente
    Cuando el cajero repite la venta con la misma Idempotency-Key
    Entonces recibe la misma factura y el stock no se descuenta dos veces

  Escenario: Controlado con receta
    Dado una receta validada con el central para "Prueba C" por 2 unidades
    Cuando se vende 2 con esa receta
    Entonces la factura queda ligada a la receta y al paciente
    Y una segunda venta con la misma receta recibe RECETA_RECLAMADA

  Escenario: Sin conexión con el central
    Dado que el estado real del POS es offline
    Cuando el cajero vende un medicamento libre
    Entonces la venta se registra y sus eventos esperan en el outbox
    Y al reconectar el central los suma una sola vez en venta_consolidada
```

## Pruebas

`npm run test:hu08` (`scripts/probar-hu08.mjs`, 85 casos por las rutas reales de `app.mjs` y por SQL para la garantía de la base). Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido. Cada corrida crea sus propios medicamentos, precios y lotes; las facturas son inmutables y permanentes, así que los medicamentos de prueba quedan inactivos al final.

Resultado (2026-11-04, rama de Neon `HU-Simon-Sprint2`): `test:hu08` 85/85. Regresión: `test:hu12` 71/71 y `probar-hu12-central` 70/70, `test:hu06` 37/37, `test:hu07` 63/63, `test:hu01` 39/39, `test:hu02` 38/38, `test:hu03` 44/44, `test:hu15` 47/47 y `db:verificar --estricto` sin diferencias. Recorrido en el navegador como cajero: búsqueda, carrito, vista previa con impuesto, pago combinado (efectivo y débito) y la factura `T1-000035`. No se ejecutó `test:sync` (requiere el API en marcha). La venta completa (2 líneas, 3 pagos) se confirma en unos 2,4 s contra Neon (RNF-05 ≤ 3 s), con ~14 idas y vueltas a la base.

Hallazgo corregido en el recorrido: la base ya traía los métodos de pago con códigos en minúscula; el primer borrador del script central sembraba otros con otro formato y la caja mostraba ocho métodos. Quedó con los códigos existentes y la rama de pruebas se limpió (desactivando los duplicados, que ya tenían facturas de prueba).

## Pendiente para otras historias

- **HU-09:** listado, búsqueda y reimpresión de facturas (aquí solo `GET /ventas/{id}`).
- **HU-10:** anulación y devolución: reingresar al lote de origen con el movimiento `DEVOLUCION`, restituir `cantidad_dispensada` de la receta y ajustar el consolidado del central.
- **HU-11:** cierre de caja por método de pago a partir de `factura_metodo_pago`.
- **Pago en efectivo con cambio:** hoy los pagos suman exactamente el total.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Plan y decisiones | Impuesto por medicamento, FEFO automático, rama de Git `hu-08` |
| Implementación y pruebas | En verde (2026-11-04) |
| Auditor GPT-5.6 Luna | pendiente |
