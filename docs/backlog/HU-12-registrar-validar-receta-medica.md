# HU-12 — Registrar y validar receta médica antes de la venta

Estado: **IMPLEMENTADA** (2026-11-04): API, esquemas en `db/local/05_hu12_recetas.sql`, `db/local/06_hu12_validacion_central.sql` y `db/central/07_hu12_recetas_emitidas.sql`, módulo "Ventas y recetas" en el POS, pantalla "Control de red" en la consola y pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor (GPT-5.6 Luna), igual que HU-03 y HU-07.

Requerimientos: **RF-08** (registro y validación de receta), regla de negocio 6 (receta), regla 15 y **RNF-02** (datos personales del cliente), **RNF-04** (autonomía local), **RNF-10** (auditoría), **RNF-12**.

## Historia

Como cajero, quiero registrar los datos de la receta médica (médico prescriptor, fecha y medicamento) antes de vender un medicamento controlado, para cumplir con la normativa sanitaria y proteger al cliente.

## Criterios de aceptación

1. Al intentar vender un medicamento que requiere prescripción, el sistema exige el registro de los datos de la receta (médico, fecha, medicamento) antes de continuar.
2. El sistema impide completar la venta si no existe una receta válida registrada para ese medicamento.
3. Los datos de la receta quedan asociados a la factura correspondiente para trazabilidad.
4. El sistema conserva el detalle de la receta (médico, fecha, medicamento) como parte del historial de auditoría, protegiendo los datos personales del cliente.
5. Si el medicamento no requiere prescripción médica, el sistema permite continuar la venta sin solicitar datos de receta.

## Ajuste: validación contra el sistema de salud (simulada) — opción A

Hoy la farmacia lee el código de la receta, el sistema consulta a la EPS para saber si es auténtica, vigente y no reclamada, y al entregar el medicamento la "quema" para que no se use en otra sucursal. El proyecto no puede conectarse a una EPS, así que **el nodo central simula a la EPS**. Los datos de la receta (médico, fecha, medicamentos) ya no los escribe el cajero: salen de la receta emitida en el central, con lo que los criterios 1 y 2 se cumplen con una receta auténtica.

```
Consola central (simulación)   emite la receta con su código
Cajero (POS)                   escribe o escanea el código
   → central: ¿existe, vigente, sin reclamar?          sin conexión: 503, no se despacha un controlado (opción A)
   → central: RESERVA atómica para esta tienda (15 min)
   → tienda: guarda su copia (médico, fecha, paciente, medicamentos)
Venta (HU-08)                  la línea de factura pasa por el trigger
   → trigger: descuenta la receta local y encola RECETA_DISPENSADA en el outbox
   → central: BAJA ("quema" el código), idempotente
```

### Decisiones (con el usuario, 2026-11-04)

1. **Opción A (estricta):** sin conexión con el central no se valida un medicamento controlado nuevo (503 `SIN_CONEXION`). Los medicamentos de venta libre siguen vendiéndose. Una receta ya reservada sigue valiendo hasta que termine su reserva, porque la reserva ya impide que otra tienda la use.
2. **Baja total en la primera dispensación**, como describe el flujo real: la primera factura que la usa la quema (otra factura recibe `RECETA_RECLAMADA`). Dentro de esa factura sí se respeta el saldo por medicamento.
3. **Reserva de 15 minutos** (`politica_receta.minutos_reserva` en el central) y **vigencia de 30 días** (`dias_vigencia`): datos, se cambian con un `UPDATE`.
4. **El central guarda el documento del paciente** porque hace de EPS. Los listados lo enmascaran siempre.
5. **Sin permisos nuevos.** Emitir exige `RED_CONTROL` (administrador general); validar y consultar en el POS, `VENTA_REGISTRAR`; ver los datos completos del paciente, `AUDITORIA_CONSULTAR`.
6. **El registro manual queda apagado** (`politica_receta.permitir_registro_manual = false` en la tienda). La base lo rechaza para un controlado con `RECETA_MANUAL_NO_PERMITIDA`. Existe solo para recetas que no estén en el sistema, y lo enciende quien administre la base.

## Nodos

- **Central:** `receta_emitida`, `receta_emitida_medicamento`, `receta_conflicto`, `politica_receta`; reserva, liberación y baja en una transacción con auditoría (`RECETA_EMITIR`, `RECETA_RESERVAR`, `RECETA_LIBERAR`, `RECETA_RECLAMAR`).
- **Local:** `receta` (con `codigo_receta`, `origen`, `reservada_hasta`), `receta_medicamento`, `cliente`, `politica_receta`; trigger sobre `detalle_factura`; auditoría (`RECETA_VALIDAR_CENTRAL`, `RECETA_LIBERAR`, `CLIENTE_DATOS_CONSULTAR`).

## Rutas

| Nodo | Ruta | Uso |
| --- | --- | --- |
| Central | `POST /api/central/recetas-emitidas` | Emitir (simulación). `Idempotency-Key`; `RED_CONTROL` |
| Central | `GET /api/central/recetas-emitidas[?q=&estado=]`, `GET .../medicamentos` | Consola |
| Tienda | `POST /api/local/recetas/codigo` | Validar y reservar por código (503 sin conexión) |
| Tienda | `POST /api/local/recetas/{id}/liberar` | Cancelar la reserva (el cliente no compra) |
| Tienda | `POST /api/local/recetas/validar` | Anticipa qué líneas piden receta y si sirve; no modifica nada |
| Tienda | `GET /api/local/recetas`, `/recetas/{id}`, `/recetas/factura/{id}`, `/recetas/medicamentos`, `/recetas/politica` | Consulta (offline) |
| Tienda | `POST /api/local/recetas` | Registro manual (apagado por política) |

Errores de la validación por código: 404 `RECETA_NO_ENCONTRADA`; 409 `RECETA_VENCIDA`, `RECETA_RECLAMADA` (con tienda y hora), `RECETA_RESERVADA_OTRA_TIENDA`, `RECETA_ANULADA`; 503 `SIN_CONEXION` con `ultima_sync`.

## La garantía en la base (criterios 1, 2, 3 y 5)

El trigger `detalle_factura_receta` (BEFORE INSERT sobre `detalle_factura`) revisa cada línea de un medicamento con `requiere_receta`:

- sin `id_receta` → `RECETA_REQUERIDA`; receta que no incluye el medicamento → `RECETA_INVALIDA`; factura de otro cliente → `RECETA_CLIENTE`; más de lo autorizado → `RECETA_SALDO`;
- receta del central: reserva vencida → `RECETA_RESERVA_VENCIDA`; ya usada en otra factura → `RECETA_RECLAMADA`;
- receta manual: `RECETA_MANUAL_NO_PERMITIDA` con la política apagada, o `RECETA_VENCIDA` fuera de vigencia;
- si pasa, suma la cantidad a `cantidad_dispensada` y, para una receta del central, encola `RECETA_DISPENSADA` en `outbox_sync`, todo en la transacción de la venta: si la venta se revierte, la receta recupera su saldo y el evento desaparece.

SQLSTATE `23514` con el prefijo `RECETA_*`; `traducirErrorReceta(error)` lo convierte en un 409 que HU-08 puede responder. Un medicamento sin receta obligatoria no se revisa (criterio 5). La asociación con la factura (criterio 3) es `detalle_factura.id_receta`.

## Reserva, baja y conflictos en el central

- **Reserva:** `SELECT ... FOR UPDATE` de la receta y luego `UPDATE`. Dos tiendas a la vez: la segunda ve la reserva de la primera. La misma tienda que valida otra vez renueva el plazo. Una reserva vencida la puede tomar otra tienda.
- **Baja (`RECETA_DISPENSADA`)**: idempotente por `inbox_sync`. La primera baja en llegar gana y deja la receta `RECLAMADA`; otra línea de la misma tienda no hace nada.
- **Conflictos, nunca en silencio** (regla 5): una baja de otra tienda sobre una receta ya reclamada, de un código desconocido o de una receta anulada va a `receta_conflicto` con el aviso completo. Una baja que llega sobre una reserva ajena todavía activa gana (la dispensación ya ocurrió) y deja el aviso `RESERVA_ACTIVA_DE_TIENDA_n`.

## Datos personales y auditoría (criterio 4)

- **Auditoría:** `RECETA_VALIDAR_CENTRAL` en la tienda con código, médico, fecha y medicamentos, **sin** nombre, documento ni contacto del paciente; el central audita emisión, reserva, liberación y baja. La bitácora es de solo inserción (HU-07) y sube al central con el resto.
- **Receta inmutable:** `receta` y `receta_medicamento` no se editan ni se borran (42501). Solo se mueven `reservada_hasta` (renovar o liberar) y `cantidad_dispensada`.
- **Protección del paciente:** el documento sale enmascarado (`****1234`) y sin contacto, salvo para `AUDITORIA_CONSULTAR`, y cada consulta completa queda como `CLIENTE_DATOS_CONSULTAR`.

## Offline, duplicados y reconexión

- **Sin conexión:** un controlado nuevo no se valida (503); emitir y liberar tampoco. Se consultan las recetas guardadas y se evalúa una venta con una receta ya reservada. La venta libre sigue.
- **Reconexión:** la baja sale por el outbox con reintento en orden y es idempotente: el reintento no duplica filas ni conflictos.
- **Latencia alta:** `enCentral` distingue la caída (503) de una respuesta lenta, igual que HU-03 y HU-07.

## Pendiente para otras historias

- **HU-08 (venta):** llamar a `POST /recetas/validar` antes de facturar, ligar la factura al cliente de la receta, traducir los errores con `traducirErrorReceta` y terminar la venta dentro de la reserva.
- **HU-10 (devolución):** restituir `cantidad_dispensada` y decidir si la receta vuelve a estar disponible en el central.
- **Dispensación parcial en varias visitas:** no se soporta (decisión 2).

## Implementación

| Pieza | Archivo |
| --- | --- |
| Recetas de la tienda (registro manual, consulta, validación anticipada) | `apps/api/recetas.mjs` |
| Validación contra el central: emisión, reserva, liberación, baja | `apps/api/recetas-red.mjs` |
| Rutas | `apps/api/routes/recetas.mjs`, registradas en `apps/api/app.mjs` |
| Baja en el central | `RECETA_DISPENSADA` en `apps/api/sync/central.mjs` |
| Esquemas | `db/local/05_hu12_recetas.sql`, `db/local/06_hu12_validacion_central.sql`, `db/central/07_hu12_recetas_emitidas.sql` |
| Interfaz | `apps/web/src/Recetas.jsx` (POS), `apps/web/src/RecetasEmitidas.jsx` (consola, módulo "Control de red") |
| Recetas demo | `RECETAS_EMITIDAS` en `apps/api/demo.mjs`: `RX-DEMO-001`, `RX-DEMO-002` y `RX-DEMO-VENCIDA` |
| Pruebas | `scripts/probar-hu12.mjs`, `scripts/probar-hu12-central.mjs` (`npm run test:hu12`) |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-12 Registrar y validar receta médica antes de la venta

  Escenario: Un medicamento controlado exige receta
    Dado que "cajero1" tiene sesión en el POS
    Cuando valida una venta con "Amoxicilina 500 mg" sin receta
    Entonces el sistema responde que requiere receta y que no puede continuar
    Y facturar la línea sin receta es rechazado por la base con RECETA_REQUERIDA

  Escenario: El cajero valida la receta con su código
    Dado una receta emitida en el central con código "RX-DEMO-001"
    Cuando el cajero escribe o escanea el código
    Entonces el central la reserva para la tienda por 15 minutos
    Y la tienda guarda la receta con médico, fecha, paciente y medicamentos
    Y queda RECETA_VALIDAR_CENTRAL en la auditoría sin datos del paciente

  Escenario: Receta inexistente, vencida o ya reclamada
    Cuando el cajero valida un código inexistente, uno vencido o uno ya reclamado
    Entonces recibe RECETA_NO_ENCONTRADA, RECETA_VENCIDA o RECETA_RECLAMADA con la tienda
    Y la receta no queda reservada

  Escenario: Dos tiendas piden la misma receta
    Dado una receta emitida
    Cuando dos tiendas la validan al mismo tiempo
    Entonces solo una la reserva
    Y la otra recibe RECETA_RESERVADA_OTRA_TIENDA

  Escenario: Dispensar quema la receta
    Dado una receta reservada por la tienda
    Cuando se factura el medicamento con esa receta
    Entonces la línea guarda id_receta y encola RECETA_DISPENSADA
    Y el central la deja RECLAMADA y ninguna tienda puede volver a usarla
    Y una segunda factura con la misma receta es rechazada con RECETA_RECLAMADA

  Escenario: La reserva termina o se libera
    Dado una receta reservada
    Cuando el cliente se va sin comprar y el cajero libera la reserva
    Entonces la receta vuelve a EMITIDA en el central
    Y con la reserva terminada la base rechaza la línea con RECETA_RESERVA_VENCIDA

  Escenario: Sin conexión con el central (opción A)
    Dado que el estado real del POS es offline
    Cuando el cajero valida el código de un medicamento controlado nuevo
    Entonces recibe 503 SIN_CONEXION y no se crea nada
    Pero la venta de un medicamento de venta libre sigue
    Y una receta ya reservada sigue valiendo hasta que termine su reserva

  Escenario: Conflicto al reconectar
    Dado una baja de otra tienda sobre una receta que ya reclamó la primera
    Cuando llega al central
    Entonces queda en receta_conflicto y la receta sigue reclamada por la primera
    Y repetir la misma baja no crea nada nuevo

  Escenario: Un medicamento sin receta obligatoria no pide nada
    Cuando valida una venta de "Acetaminofén 500 mg" sin receta
    Entonces puede continuar y la línea de la factura se acepta sin receta

  Escenario: Datos personales por rol
    Dado una receta validada
    Cuando el cajero la consulta
    Entonces ve el documento enmascarado y sin teléfono ni correo
    Cuando el administrador de tienda la consulta
    Entonces ve los datos completos y queda CLIENTE_DATOS_CONSULTAR en la auditoría

  Escenario: La receta registrada no se altera
    Cuando cualquier usuario de la base intenta modificar o borrar una receta
    Entonces la base lo rechaza con error 42501
```

## Pruebas

`npm run test:hu12` corre dos scripts por las rutas reales de `app.mjs` (y por SQL para la garantía de la base). Escriben en las bases del `.env`; con Neon exigen `PERMITIR_NEON=1`. Correr con el API detenido.

- `scripts/probar-hu12.mjs`: la garantía de la base y la protección del paciente con la receta manual (enciende la política durante la corrida y la apaga al terminar).
- `scripts/probar-hu12-central.mjs`: emisión, validación por código, reserva, competencia entre tiendas (la segunda tienda es "Farmacia Norte", simulada desde el central), liberación, baja por el ciclo real del outbox, conflictos, sin conexión y auditoría.

Las recetas emitidas de prueba son permanentes (auditoría); las facturas viven en transacciones que se revierten.

Resultado (2026-11-04, rama de Neon `HU-Simon-Sprint2`): `probar-hu12` 71/71 y `probar-hu12-central` 70/70. Regresión de HU-01, 02, 03, 06, 07 y 15 y `db:verificar --estricto` en verde. Recorrido en el navegador: el cajero rechazó `RX-DEMO-VENCIDA` y validó `RX-DEMO-001` (el central la dejó `RESERVADA` por Farmacia Centro); la consola emite y lista recetas. No se ejecutó `test:sync` (requiere el API en marcha).

Hallazgo corregido en el recorrido: el listado hacía dos consultas por receta y tardaba varios segundos con la base remota; ahora usa dos consultas en total.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Plan y decisiones | Alcance sin venta completa; ajuste con la opción A; rama de Git `hu-12`, sin commits |
| Implementación y pruebas | En verde (2026-11-04) |
| Auditor GPT-5.6 Luna | pendiente |
