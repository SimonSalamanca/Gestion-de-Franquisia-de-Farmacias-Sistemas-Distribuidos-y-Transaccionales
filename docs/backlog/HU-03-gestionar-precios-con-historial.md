# HU-03 — Gestionar precios de medicamentos con historial de vigencia

Estado: **IMPLEMENTADA** (2026-11-03): API, esquema en `db/central/05_hu03_precios.sql` y `db/local/04_hu03_precios.sql`, pantalla "Precios" (POS y consola) y precio vigente en la búsqueda de Inventario. Pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor.

Jira: **SDGFCSDF-3** · Sprint 1. Requerimientos: **RF-02** (precios con historial), regla de negocio 9 (precios con vigencia; facturas pasadas inmutables), **RNF-04**, **RNF-10**, **RNF-12**.

## Historia

Como administrador de tienda, quiero definir y actualizar el precio de venta de cada medicamento conservando un historial de vigencia, para que las facturas emitidas siempre reflejen el precio correcto sin verse afectadas por cambios posteriores.

## Criterios de aceptación

1. Un usuario autorizado puede registrar un nuevo precio para un medicamento indicando la fecha desde la cual rige.
2. El sistema conserva el historial completo de precios anteriores con sus fechas de vigencia.
3. Al emitir una factura, el sistema toma el precio vigente en el momento exacto de la venta y lo fija en la factura, sin importar cambios posteriores.
4. Solo usuarios con rol de administrador pueden modificar precios.
5. El historial de precios de un producto puede consultarse en cualquier momento, mostrando cada precio junto con su fecha de inicio de vigencia.

## Decisiones (con el usuario, 2026-11-03)

1. **Precio único de red.** `precio_medicamento` (central) no tiene tienda: un cambio aplica a toda la cadena. Lo pueden hacer el administrador de tienda (desde el POS) y el administrador general (desde la consola); la auditoría registra quién y desde qué tienda. Resuelve la inconsistencia 5 de `FARMAHUB_CONTEXT.md`.
2. **Vigencia desde ahora o futura, nunca pasada.** El historial refleja lo que realmente rigió. Se tolera un desfase de 2 minutos con el reloj del navegador (se ajusta a "ahora").
3. **Un precio programado que aún no rige se puede corregir** (precio o fecha). Uno que ya empezó a regir queda fijo: para cambiarlo se registra uno nuevo.
4. Rama `hu-03`, sin commits.

## Nodos

- **Central:** único escritor de `precio_medicamento`. Cada alta o corrección se hace en una transacción con su auditoría (`registro_actividad_central`, entidad `medicamento`) y un `PRECIO_UPSERT` por cada fila que cambia (la nueva y la que se cierra), con destino a todas las tiendas.
- **Local:** `precio_ref` guarda el historial completo, incluidos los precios programados. La tienda aplica cada precio en su instante exacto aunque esté sin conexión, y consulta el historial offline. `precio_vigente_ref` (script base, un solo precio por medicamento) no sirve para programar y no se usa.

## Online

- Rutas iguales en los dos nodos: `GET /api/{local|central}/precios?q=` (medicamentos con precio vigente y próximo cambio), `GET /precios/{id_medicamento}` (historial), `POST /precios/{id_medicamento}` (registrar), `PATCH /precios/registro/{id_precio}` (corregir un programado).
- Consultar exige `INVENTARIO_CONSULTAR` (también el cajero). Registrar y corregir exigen `PRECIO_GESTIONAR` (solo administradores: criterio 4) y `Idempotency-Key`; el permiso se relee en el central.
- Precio: mayor que cero, máximo dos decimales (`numeric(12,2)`). Inicio: instante ISO o vacío (= ahora, `now()` de la base).
- Al registrar, el periodo anterior se cierra con el inicio del nuevo (`fecha_fin_vigencia`), con bloqueo `FOR UPDATE` del medicamento para serializar dos administradores.

## Historial inmutable (criterio 2)

- Índice único `(id_medicamento, fecha_inicio_vigencia)`: dos precios no empiezan en el mismo instante (409 `PRECIO_DUPLICADO`).
- Trigger `precio_historial_inmutable()` en el central: un precio que ya empezó a regir no se borra ni se cambia; solo se le puede ajustar el fin hacia el futuro (al programar el siguiente). Un programado se puede corregir, pero no moverlo al pasado. La API responde 409 `PRECIO_EN_VIGOR` antes de llegar al trigger.

## La factura (criterio 3)

- Función local `precio_vigente(id_medicamento, instante)`: el precio que rige en ese instante (el de inicio más reciente que no sea posterior). Devuelve `NULL` si no hay precio: la venta debe rechazarse.
- **Para HU-08:** dentro de la transacción de la venta, `precio_unitario_aplicado = precio_vigente(id_medicamento, factura.fecha_hora)`. Como la tienda tiene el historial completo, funciona sin conexión.
- Trigger `factura_inmutable()` en `factura` y `detalle_factura`: después de emitida no cambian el precio, la cantidad, el lote ni los importes, ni se borran líneas. El estado de la factura sí puede cambiar (anulación y devolución, HU-10, que registran en sus propias tablas).
- Como la venta aún no existe, la prueba crea una factura dentro de una transacción que se revierte, cambia el precio después y comprueba que la factura conserva el suyo y no se puede modificar.

## Offline y latencia

- Consultar precios e historial en el POS: funciona sin conexión (réplica local). La búsqueda de Inventario muestra el precio vigente también offline.
- Registrar o corregir desde el POS: **503 `SIN_CONEXION`** con `ultima_sync`, sin encolar (el central es el único dueño del precio de red).
- Tras guardar, el POS muestra el historial que devolvió el central y vuelve a leer su réplica pasada la sincronización (~10 s).

## Reconexión, duplicados y conflictos

- Misma clave y mismo cuerpo: misma respuesta, sin segundo precio ni segundo evento. Clave con otro cuerpo: 409.
- Cambios simultáneos sobre un medicamento: se serializan con `FOR UPDATE`; el segundo ve el historial ya actualizado.
- `PRECIO_UPSERT` es idempotente por `id_precio` y se aplica en orden del log: la última versión de cada fila gana. Si el medicamento aún no está en `medicamento_ref`, queda en `sync_conflicto` (`DEPENDENCIA_FALTANTE`) sin frenar la réplica.
- Al arrancar, `migrate()` publica los precios sin evento (los demo y los cargados a mano), después de los medicamentos.

## Implementación

| Pieza | Archivo |
| --- | --- |
| Registro, corrección, historial y listado | `apps/api/precios.mjs` |
| Rutas | `apps/api/routes/precios.mjs`, registradas en `apps/api/app.mjs` |
| Réplica en la tienda | `apps/api/sync/handlers/precio.mjs` |
| Esquema | `db/central/05_hu03_precios.sql`, `db/local/04_hu03_precios.sql` |
| Interfaz | `apps/web/src/Precios.jsx`; precio en `Inventario.jsx` (formato en `inventarioUi.jsx`) |
| Precios demo | `PRECIOS` en `apps/api/demo.mjs` (Ibuprofeno con un precio programado a 30 días) |

Cambios en código existente: la búsqueda de HU-01 (`inventario/busqueda.mjs`) devuelve `precio`; `migrate.mjs` publica `PRECIO_UPSERT` pendientes (campo opcional `desde` en la emisión del catálogo); módulo `PRECIO_GESTIONAR` visible en POS y consola (`App.jsx`).

## Validación de esquema

| Dato | Definición | Uso |
| --- | --- | --- |
| Precio de red | `precio_medicamento` (central): `precio numeric(12,2) >= 0`, `fecha_inicio_vigencia`, `fecha_fin_vigencia`, `id_empleado_registro` | Historial |
| Unicidad | `uq_precio_medicamento_inicio (id_medicamento, fecha_inicio_vigencia)` | Sin choques |
| Coherencia | `precio_medicamento_vigencia_check` (fin > inicio) | Periodos válidos |
| Réplica | `precio_ref` (local) con FK a `medicamento_ref` y nombre de quien registró | Consulta offline y venta |
| Precio en la factura | `detalle_factura.precio_unitario_aplicado numeric(12,2)` (script base) | Fijado por la venta |

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-03 Gestionar precios con historial de vigencia

  Escenario: El administrador registra un precio que rige desde ahora
    Dado que "admin.tienda" tiene sesión en el POS y el central está en línea
    Cuando registra el precio 5300 para "Ibuprofeno 400 mg" sin fecha
    Entonces la respuesta es 201 y el precio vigente es 5300
    Y el precio anterior queda cerrado con fecha de fin igual al inicio del nuevo
    Y queda PRECIO_REGISTRAR en la auditoría del central

  Escenario: Programar y corregir un precio futuro
    Dado que el precio vigente es 1000
    Cuando el administrador programa 1500 desde dentro de 2 días
    Entonces el vigente sigue siendo 1000 y el historial muestra 1500 como programado
    Cuando corrige el programado a 1600
    Entonces el historial muestra 1600 y queda PRECIO_REPROGRAMAR en la auditoría
    Cuando intenta corregir el precio vigente
    Entonces recibe 409 PRECIO_EN_VIGOR

  Escenario: No se registran precios en el pasado
    Cuando el administrador registra un precio con inicio de ayer
    Entonces recibe 400 y el historial no cambia

  Escenario: Solo los administradores cambian precios
    Dado que "cajero1" tiene sesión en el POS
    Cuando intenta registrar un precio
    Entonces recibe 403 y queda ACCESO_DENEGADO en la auditoría de la tienda
    Pero puede consultar el historial y ver el precio vigente en Inventario

  Escenario: La tienda aplica el precio programado aunque esté sin conexión
    Dado que la tienda recibió el historial con un precio programado para mañana
    Y el estado real es offline
    Cuando llega la hora del precio programado
    Entonces precio_vigente devuelve el nuevo precio
    Y el historial se consulta en la tienda sin conexión
    Pero registrar un precio responde 503 SIN_CONEXION

  Escenario: La factura conserva el precio de la venta
    Dado una factura emitida con el precio vigente en el instante de la venta
    Cuando después cambia el precio del medicamento
    Entonces la línea de la factura conserva el precio con que se vendió
    Y cualquier intento de modificar su precio, cantidad o importes es rechazado por la base

  Escenario: El historial que ya rigió es inmutable
    Dado un precio que ya empezó a regir
    Cuando cualquier usuario de la base intenta cambiar su precio o borrarlo
    Entonces la base lo rechaza con error 42501
```

## Pruebas

`npm run test:hu03` (`scripts/probar-hu03.mjs`, 44 casos por las rutas reales de `app.mjs`). Usa un medicamento propio por corrida (queda inactivo al final; su historial no se borra). La factura de prueba vive en una transacción que se revierte. Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido.

Resultado (2026-11-03, ramas de prueba de Neon): `test:hu03` 44/44. Regresión: `test:hu06` 37/37, `test:hu07` 63/63, `test:hu01` 39/39 (incluida RNF-05 con el precio en la búsqueda), `test:hu02` 38/38, `test:hu15` 19/19 y 28/28, `test:sync` 12/12 y `db:verificar --estricto` sin diferencias. Recorrido en el navegador: alta "desde ahora", precio programado y su corrección desde el POS; el historial se ve al instante y la réplica llega en la siguiente sincronización; el cajero ve el precio en Inventario y no tiene el módulo Precios.

Hallazgo corregido en el recorrido: la fecha del "próximo cambio" del listado salía 5 horas corrida (iba dentro de un JSON sin zona horaria). Ahora viaja en UTC y la prueba lo verifica.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Plan y decisiones con el usuario | Precio único de red, vigencia ahora o futura, rama `hu-03` sin commits |
| Implementación y pruebas | 44/44 y regresión en verde (2026-11-03) |
| Auditor GPT-5.6 Luna | pendiente |
