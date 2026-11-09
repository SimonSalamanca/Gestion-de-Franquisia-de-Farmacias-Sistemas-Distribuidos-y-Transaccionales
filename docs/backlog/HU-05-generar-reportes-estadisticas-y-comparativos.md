# HU-05: Generar reportes, estadísticas y comparativos entre tiendas

Estado: **IMPLEMENTADA** (2026-11-09) en la rama de Git `hu-05`, con pruebas en verde en el clon Docker (copia de Neon). Falta probarla en Neon, que todavía no tiene los esquemas de HU-08, HU-10 y HU-04 (ver "Riesgos").

Requerimientos: RF de reportes y estadísticas (falta confirmar el código en el documento UML), **RNF-04** (autonomía local), **RNF-05** (tiempo de respuesta), **RNF-13** (consolidado con retraso y hora de la última actualización) y **RNF-10** (auditoría del acceso denegado).

## Historia

Como administrador, quiero visualizar estadísticas de ventas e indicadores de inventario de mi tienda, y comparar estos indicadores contra otras tiendas de la red, para tomar decisiones basadas en información oportuna y exportarla cuando la necesite.

## Criterios de aceptación

1. El sistema calcula y muestra la cantidad de unidades vendidas y los ingresos generados en un periodo, desglosados por método de pago.
2. El sistema representa gráficamente los productos con niveles críticos de stock y los próximos a caducar.
3. Un administrador general puede comparar el volumen de ventas e indicadores de stock entre distintas tiendas de la red.
4. Los reportes pueden exportarse en formato PDF o Excel.
5. La generación de un reporte no debe superar un tiempo de respuesta razonable, incluso con un volumen alto de datos históricos.

## Tareas

1. Implementar el cálculo de estadísticas de ventas e ingresos por periodo y método de pago.
2. Desarrollar el dashboard visual con indicadores críticos de stock y caducidad.
3. Implementar el comparativo entre tiendas y la exportación de reportes a PDF y Excel.

## Decisiones (con el usuario, 2026-11-09)

1. **Dos reportes, cada uno en su nodo.**
   - **Reporte de la tienda:** criterios 1 y 2. Está en el POS y se calcula en el nodo local con las facturas y los lotes de la tienda, así que funciona sin conexión con el central (RNF-04).
   - **Comparativo de red:** criterio 3. Está en la consola y se calcula en el central con `venta_consolidada` e `inventario_consolidado`. Siempre muestra la hora de la última sincronización de cada tienda (RNF-13).
2. **Volumen entre tiendas = ingresos, número de facturas y ticket promedio.** El central no guarda unidades vendidas (`venta_consolidada` tiene total y facturas por tienda, día y método de pago). No se cambia la estructura ni el código de HU-08 y HU-10. Las unidades vendidas aparecen en el reporte de cada tienda.
3. **Exportación desde la web, sin tocar el API.**
   - **PDF:** con "Imprimir / Guardar como PDF" y una hoja de estilos de impresión. No usa librería y los gráficos salen nítidos porque son SVG.
   - **Excel:** un `.xlsx` real, generado en el navegador con una librería pequeña (por ejemplo `write-excel-file`, MIT). La librería se confirma al implementar.
   - Lo exportado es exactamente lo que se ve, con los mismos filtros.
4. **Permiso nuevo `REPORTE_TIENDA_VER`** para el administrador de tienda y el general. Es un dato, no estructura: se inserta igual que `INVENTARIO_GESTIONAR` en HU-02 y que `FACTURA_ANULAR` en HU-10, y se replica con `ROL_PERMISO_SET`. El cajero no lo recibe, así que conserva sus permisos actuales. El comparativo sigue con `REPORTE_CONSOLIDADO_VER`, que ya tiene el administrador general.
5. **Sin cambios de estructura.** Los índices que hacen falta ya existen: `idx_factura_fecha_id` y `idx_detalle_factura_factura` (de HU-09), `idx_lote_caducidad`, `idx_venta_consolidada_fecha` y la clave única de `venta_consolidada`. El único script SQL es el del permiso.
6. **Gráficos propios, sin librería de gráficos.** Las barras horizontales son HTML/CSS y la tendencia por día es SVG. Cada barra lleva su texto y su valor, así que no se depende solo del color, y la impresión a PDF sale igual que en pantalla, con sus colores.

## Qué se reutiliza de lo que ya existe

| Necesidad | Ya existe | Historia |
| --- | --- | --- |
| Unidades vendidas por producto | `detalle_factura.cantidad` y `lote.id_medicamento` | HU-08 |
| Ingresos por método de pago | `factura_metodo_pago (id_factura, id_metodo_pago, monto)` y `metodo_pago_ref` | HU-08 |
| Restar anulaciones y devoluciones | `anulacion_devolucion`, `detalle_devolucion`, `devolucion_pago` (montos reintegrados por método) | HU-10 |
| Stock crítico de la tienda | Vista `alertas_calculadas`, tabla `alerta` y `evaluar_alertas()` (agotado, bajo, vencido, por caducar, con niveles) | HU-04 |
| Stock vendible | La regla de HU-01: lotes `DISPONIBLE` y no vencidos | HU-01 y HU-02 |
| Ventas por tienda en el central | `venta_consolidada (id_tienda, fecha, id_metodo_pago, total_vendido, total_facturas)`. Las ventas suman y las devoluciones restan, de forma idempotente por `inbox_sync` | HU-08 y HU-10 |
| Stock por tienda en el central | `inventario_consolidado` (por `STOCK_SNAPSHOT`) y `umbral_stock` (mínimo por tienda y producto) | HU-01 y HU-15 |
| Reporte de red básico | `GET /api/central/reportes/consolidado`: total vendido y facturas por tienda activa, sin periodo. No se modifica porque lo prueban las pruebas de HU-15 | HU-15 |
| Permisos, sesión, 401/403 y auditoría de acceso denegado | `exigir()` y `autorizar()` | HU-06 y HU-07 |

## Cálculos

### Reporte de la tienda (local, `REPORTE_TIENDA_VER`)

El periodo va de `desde` a `hasta`, con fechas inclusivas y un máximo de 366 días. Por defecto es el mes en curso.

- **Ventas brutas:** facturas del periodo según `fecha_hora`, en cualquier estado.
  - Unidades = `sum(detalle_factura.cantidad)`.
  - Ingresos = `sum(factura_metodo_pago.monto)`.
- **Devoluciones del periodo:** notas de HU-10 según su `fecha_hora`.
  - Unidades = `sum(detalle_devolucion.cantidad_devuelta)`.
  - Reintegro = `sum(devolucion_pago.monto)`.
  - Se cuentan en el día de la nota, igual que en el central (HU-10), para que el reporte de la tienda y el de la red cuadren.
- **Netos** = brutos − devoluciones. Se muestran las tres cifras.
- **Por método de pago (criterio 1):** ingresos brutos, reintegros, ingresos netos y número de facturas.
  - Las unidades no se pueden repartir por método cuando una factura se pagó combinada, porque el pago es de la factura y no de cada línea. Por eso las unidades se muestran en total, por producto y por día, y la tabla por método lleva una nota que lo explica.
  - Una factura pagada con dos métodos cuenta como factura en cada uno, la misma regla de `venta_consolidada`. El total de facturas del encabezado no la repite.
- **Más vendidos:** los 10 productos con más unidades netas y sus ingresos (subtotal de línea más impuesto).
- **Por día:** unidades e ingresos netos, para el gráfico de tendencia.
- **Inventario (criterio 2):**
  - Productos en nivel crítico: alertas activas `STOCK_AGOTADO` y `STOCK_BAJO`, por nivel, con stock vendible y mínimo.
  - Caducidad por tramos: lotes con unidades vencidos (bloqueados), a 7 días o menos, de 8 a 30 días y de 31 a 90 días. Para cada tramo se muestran las unidades y la lista.
  - Antes de calcular se ejecuta `evaluar_alertas()`, igual que el panel de HU-04, para que el reporte no muestre un estado viejo.

### Comparativo de red (central, `REPORTE_CONSOLIDADO_VER`)

Usa el mismo periodo, con un máximo de 366 días.

- **Por tienda activa:**
  - Ingresos netos = `sum(total_vendido)` (las devoluciones ya vienen restadas).
  - Facturas = `sum(total_facturas)`.
  - Ticket promedio = ingresos / facturas.
  - Participación en la red (%).
  - Ingresos por método de pago.
- **Indicadores de stock por tienda:**
  - Productos agotados (`cantidad_disponible = 0` con umbral).
  - Productos bajo el mínimo (`cantidad_disponible <= stock_minimo`).
  - Productos sin reporte de stock.
  - `max(fecha_sincronizacion)`, que es la hora de la última foto de stock.
- **Ranking** por ingresos y gráfico de barras por tienda. Una tienda sin datos aparece con "sin datos consolidados", no con cero.
- **Fuera de alcance:** la caducidad entre tiendas. El central no tiene fechas de lote, solo cantidades por producto, y llevarlas exige un evento nuevo. Queda para HU-16, la vista de red, que HU-04 ya dejó señalada.

## Rutas

| Ruta | Nodo | Permiso | Uso |
| --- | --- | --- | --- |
| `GET /api/local/reportes/tienda?desde=&hasta=` | local | `REPORTE_TIENDA_VER` | Ventas, métodos de pago, más vendidos, por día e inventario crítico |
| `GET /api/central/reportes/comparativo?desde=&hasta=` | central | `REPORTE_CONSOLIDADO_VER` | Comparativo por tienda con stock y última sincronización |

- Son solo de lectura: no requieren `Idempotency-Key` ni dejan movimientos.
- Validación de fechas: un formato inválido, `desde > hasta` o un periodo de más de 366 días devuelven 400.
- Sin sesión responde 401. Sin permiso responde 403, que se audita como `ACCESO_DENEGADO` (HU-07).
- Si el central no responde, el comparativo devuelve 503 con la última sincronización, igual que la consola en HU-15. El reporte de la tienda no depende del central.

## Rendimiento (criterio 5)

Para medir "un tiempo de respuesta razonable" se fija el mismo límite de RNF-05 para consultas: **p95 < 2 s**, medido contra Neon.

| Reporte | Volumen de prueba | Meta |
| --- | --- | --- |
| Tienda | 12 meses con **100.000 facturas** sintéticas (unas 250.000 líneas), dentro de una transacción que se revierte | p95 < 2 s |
| Red | 50 tiendas × 366 días × 4 métodos (unas 73.000 filas de `venta_consolidada`), dentro de una transacción que se revierte | p95 < 2 s |

Cómo se cumple:
- **Pocas consultas por reporte.** Neon tarda unos 130 ms por ida y vuelta, así que el reporte de la tienda se resuelve en una o dos consultas con CTE, como en la optimización de HU-01/HU-02.
- **Filtro por rango** sobre los índices existentes.
- **Periodo acotado** a 366 días.
- **Agregación en SQL**, no en JavaScript.

Si la prueba no llega a la meta, la alternativa es una tabla de resumen diaria en el nodo local. Eso es un cambio de estructura y se consulta antes de hacerlo.

## Offline y consistencia

- **Sin conexión con el central:** el reporte de la tienda funciona completo. El comparativo de red no está disponible y responde 503 con la hora de la última sincronización.
- **Datos atrasados (RNF-13):** el comparativo muestra la hora de la última actualización de ventas y de stock por tienda. Una venta hecha sin conexión aparece en el central cuando la tienda reconecta, porque el outbox es idempotente.
- **Reporte de la tienda contra la red:** para el mismo día, los ingresos netos de la tienda coinciden con su fila del comparativo cuando no hay nada pendiente en el outbox. Esto se comprueba en la prueba.

## Plan de desarrollo

Rama de Git `hu-05`, creada desde `main`, con PR hacia `main`. Las pruebas se corren en una rama de Neon, no en la base principal: hoy la base real no tiene los esquemas de HU-08, HU-10 y HU-04, de los que depende este reporte (ver "Riesgos").

| Paso | Qué | Archivos |
| --- | --- | --- |
| 0 | Permiso `REPORTE_TIENDA_VER` (dato) para el administrador de tienda y el general, y su texto en el menú | `db/central/11_hu05_permiso_reportes.sql`, `apps/api/auth.mjs`, `apps/web/src/App.jsx` |
| 1 | **Tarea 1:** cálculo del reporte de la tienda (ventas, métodos, devoluciones, más vendidos, por día) y validación del periodo | `apps/api/reportes.mjs`, `apps/api/routes/reportes.mjs`, `apps/api/app.mjs` |
| 2 | **Tarea 2:** bloque de inventario (críticos y caducidad por tramos) y pantalla "Reportes" del POS con gráficos propios | `apps/api/reportes.mjs`, `apps/web/src/Reportes.jsx`, `apps/web/src/graficos.jsx` |
| 3 | **Tarea 3a:** comparativo de red y pantalla en la consola | `apps/api/reportes.mjs` (`comparativoRed`), `apps/api/routes/reportes.mjs`, `apps/web/src/ReportesRed.jsx` |
| 4 | **Tarea 3b:** exportación a Excel (.xlsx) y PDF (impresión), en las dos pantallas | `apps/web/src/exportar.js`, `apps/web/src/styles.css` (`@media print`), `apps/web/package.json` |
| 5 | Pruebas: funcionales, de permisos, offline, cuadre tienda–red y rendimiento con volumen | `scripts/probar-hu05.mjs`, `package.json` (`test:hu05`) |
| 6 | Regresión completa y recorrido en el navegador como `admin.tienda` y como administrador general | Esta HU, sección "Pruebas" |

## Implementación

| Pieza | Archivo |
| --- | --- |
| Permiso `REPORTE_TIENDA_VER` (dato, replicado) | `db/central/11_hu05_permiso_reportes.sql`, catálogo de módulos en `apps/api/auth.mjs` |
| Reporte de la tienda: una consulta de ventas y otra de inventario, en paralelo, agregadas en SQL | `apps/api/reportes.mjs` (`reporteTienda`, `periodoDe`) |
| Comparativo de red: una consulta | `apps/api/reportes.mjs` (`comparativoRed`) |
| Rutas | `apps/api/routes/reportes.mjs`, registradas en `apps/api/app.mjs` |
| Pantalla del POS ("Reportes") | `apps/web/src/Reportes.jsx` |
| Pantalla de la consola ("Reportes de red") | `apps/web/src/ReportesRed.jsx` |
| Gráficos (barras, stock contra mínimo, columnas por día) | `apps/web/src/graficos.jsx` |
| Exportación: Excel con `write-excel-file` 4.1.1 (MIT), cargada solo al exportar; PDF con la impresión del navegador | `apps/web/src/exportar.js`, `@media print` en `apps/web/src/styles.css` |
| Pruebas | `scripts/probar-hu05.mjs` (`npm run test:hu05`) |

Cambios en código existente:
- `etiquetaMetodo` de `apps/api/ventas.mjs` (HU-08) ahora se exporta, para que los reportes usen las mismas etiquetas de método de pago.
- La regla de impresión de facturas (HU-09) oculta todo menos la factura. El reporte se imprime solo cuando `<body>` tiene la clase `imprimiendo-reporte`, que pone y quita `exportarPdf()`, así que la reimpresión de facturas no cambia.
- El reporte de la tienda ejecuta `evaluar_alertas()` antes de calcular, igual que el panel de HU-04. Si esa evaluación falla, el reporte usa lo último calculado.

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-05 Generar reportes, estadísticas y comparativos entre tiendas

  Escenario: Unidades e ingresos del periodo por método de pago
    Dado tres facturas del periodo: 2 unidades en efectivo por 10.000, 3 unidades en débito por 15.000
      y 1 unidad pagada 5.000 en efectivo y 5.000 en débito
    Cuando el administrador de tienda genera el reporte del periodo
    Entonces ve 6 unidades vendidas y 35.000 de ingresos
    Y efectivo 15.000 con 2 facturas, débito 20.000 con 2 facturas

  Escenario: Las devoluciones se descuentan en el día de la nota
    Dado una factura de ayer por 3 unidades en efectivo
    Y hoy una devolución parcial de 1 unidad con reintegro en efectivo
    Cuando se genera el reporte de hoy
    Entonces las devoluciones muestran 1 unidad y su reintegro
    Y el neto de efectivo de hoy descuenta ese reintegro

  Escenario: Gráfico de stock crítico y caducidad
    Dado un producto agotado, uno bajo el mínimo y lotes que caducan en 5, 20 y 60 días
    Cuando se abre el reporte
    Entonces el gráfico de stock muestra el agotado como crítico y el bajo con su mínimo
    Y la caducidad por tramos muestra los lotes en "≤ 7 días", "8–30 días" y "31–90 días"

  Escenario: Comparativo entre tiendas
    Dado dos tiendas activas con ventas consolidadas en el periodo y una sin datos
    Cuando el administrador general abre el comparativo
    Entonces ve por tienda ingresos, facturas, ticket promedio, participación, agotados y bajo mínimo
    Y la tienda sin datos aparece como "sin datos consolidados", no en cero
    Y cada tienda muestra la hora de su última sincronización

  Escenario: Una tienda desactivada sale del comparativo
    Dado una tienda desactivada con ventas históricas
    Cuando se abre el comparativo
    Entonces no aparece

  Escenario: Exportar
    Cuando el administrador descarga el reporte en Excel
    Entonces recibe un .xlsx con las mismas cifras y el mismo periodo de la pantalla
    Cuando elige PDF
    Entonces la versión de impresión incluye encabezado, periodo, tablas y gráficos, sin menús

  Escenario: Permisos
    Dado un cajero
    Cuando pide el reporte de la tienda
    Entonces recibe 403 y queda ACCESO_DENEGADO en la auditoría
    Y un administrador de tienda no puede abrir el comparativo de red

  Escenario: Periodo inválido
    Cuando se pide un periodo de más de 366 días o con desde posterior a hasta
    Entonces recibe 400 y no se ejecuta la consulta

  Escenario: Sin conexión con el central
    Dado que el POS está sin conexión
    Cuando el administrador de tienda abre el reporte de su tienda
    Entonces se genera completo
    Y el comparativo de red responde 503 con la última sincronización

  Escenario: Reporte con volumen alto
    Dado 100.000 facturas en 12 meses
    Cuando se genera el reporte del año 20 veces
    Entonces el p95 es menor de 2 s
```

## Pruebas

`npm run test:hu05` (`scripts/probar-hu05.mjs`) recorre las rutas reales de `app.mjs` con el mismo candado que las demás pruebas: con URLs de Neon exige `PERMITIR_NEON=1` y solo se corre en una rama de prueba de Neon. Se ejecuta con el API detenido.

- **Datos de la prueba:** crea sus propias ventas y devoluciones con los servicios de HU-08 y HU-10. Las facturas son permanentes, así que los medicamentos de prueba quedan inactivos al final, como en HU-08.
- **Pruebas de volumen:** van dentro de una transacción que se revierte.
- **Qué cubre:**
  - Cifras exactas del Gherkin y pago combinado.
  - Devoluciones en el día de la nota.
  - Tramos de caducidad.
  - 401, 403 y auditoría.
  - Periodo inválido.
  - Offline y 503.
  - Tienda desactivada fuera del comparativo.
  - Cuadre entre tienda y red después de sincronizar.
  - p95 con volumen.
  - Cifras del archivo Excel iguales a las del API.
- **Regresión:** se corren todas las pruebas de las demás historias.

### Resultado (2026-11-09, clon Docker)

No hubo acceso para crear una rama de Neon, así que todo se probó en el clon Docker local (`farmahub-pg-prueba`, puerto 55432). Se usaron las bases `hu05_central` y `hu05_local`, copiadas de la copia exacta de Neon del 2026-10-28. Al arrancar, el API les aplicó los esquemas de HU-03 a HU-10 y el permiso de HU-05. No se tocó ninguna base de Neon.

| Prueba | Resultado |
| --- | --- |
| `npm run test:hu05` | **64/64** |
| Rendimiento: reporte de la tienda de un año con 100.000 facturas (250.000 líneas) | p95 **420 ms** (meta < 2 s) |
| Rendimiento: comparativo de un año con 50 tiendas (73.200 filas) | p95 **31 ms** (meta < 2 s) |
| Interfaz en Chrome (cajero, admin de tienda, admin general, celular de 390 px, Excel descargado y abierto, PDF) | **25/25**, sin errores de JavaScript |
| `db:verificar --estricto` | Sin diferencias en los dos nodos |
| Regresión: `test:hu01` 39, `hu02` 38, `hu03` 44, `hu04` 64, `hu07` 63, `hu08` 85, `hu09` 49, `hu10` 65, `hu15` 47 | Todas en verde |
| `test:hu06` | 36/37: falla "cajero permisos". La prueba espera que el cajero tenga 2 permisos, pero HU-10 le dio `FACTURA_ANULAR`. HU-05 no cambia al cajero; la prueba de HU-06 debe actualizarse (Simon) |
| `test:hu12` | 129/132: `probar-hu12-central` usa fija la tienda 2 como "otra tienda", y en la copia de Neon esa tienda no existe (están la 1 y la 5). Es del entorno, no de HU-05 |

- **Tiempos medidos en Docker local**, con latencia casi nula. En Neon cada ida y vuelta cuesta unos 130 ms. El reporte de la tienda hace la evaluación de alertas (una transacción corta) y luego las dos consultas en paralelo, así que en Neon se esperan unos 400–600 ms más. Sigue bajo la meta, pero hay que medirlo allá cuando la base esté al día.
- **Cuadre comprobado en la interfaz:** la tienda y la red mostraron los mismos $ 286.036,94 netos para el mismo periodo.
- **Hallazgos corregidos en el recorrido:**
  - En un celular, una tabla ancha ensanchaba toda la página. Ahora `.content`, `.reporte` y `.rep-bloque` tienen `min-width: 0` y la tabla se desplaza dentro de su contenedor.
  - Un producto agotado no se distinguía en la barra de stock, porque una barra vacía no se ve. Ahora la pista se pinta de rojo.
  - "Más vendidos" mostraba productos con 0 unidades netas (devueltos por completo). Ahora los excluye.

## Riesgos y dependencias

1. **Neon real atrasado.** Al 2026-11-09, `db:verificar` marca 80 diferencias: faltan los esquemas de HU-12, HU-08, HU-04, HU-09 y HU-10. HU-05 lee facturas, devoluciones y alertas, así que no se puede probar en la base real hasta que Simon aplique esos scripts. Mientras tanto se probó en el clon Docker. Antes de arrancar el API contra Neon real hay que coordinar con Simon, porque `npm run dev` aplicaría todos los scripts pendientes.
2. **Zona horaria.** `factura.fecha_hora` es `timestamp without time zone` con `now()` del servidor (UTC en Neon). HU-08 y HU-10 mandan al central la fecha con `toISOString()`, también en UTC.
   - Los dos nodos usan el mismo día, así que los reportes cuadran entre sí.
   - Ese día es el de UTC, no el de Colombia: una venta a las 8 p. m. hora de Colombia cuenta en el día siguiente.
   - El reporte agrupa en UTC para cuadrar con el central, y en pantalla se indica la zona.
   - Antes de implementar hay que acordar con Simon si se pasa todo a hora de Colombia. Eso tocaría HU-08 y HU-10 y no forma parte de esta historia.
3. **`total_facturas` y devoluciones.** HU-10 resta el valor en el central pero no descuenta facturas, porque la factura sigue existiendo. El ticket promedio de la red usa facturas emitidas e ingresos netos; esto se explica en la pantalla.
4. **Librería de Excel.** `write-excel-file` 4.1.1 (MIT, una sola dependencia: `fflate`), solo en `apps/web`. Se carga cuando alguien exporta, así que no pesa en la carga inicial.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Historia y criterios | Definidos por el usuario |
| Análisis y plan | 2026-11-09: se reutiliza HU-04, HU-08, HU-10 y HU-15; sin cambios de estructura; permiso nuevo como dato |
| Implementación | 2026-11-09 en la rama `hu-05` (ver "Implementación") |
| Pruebas | 2026-11-09 en el clon Docker: HU-05 64/64, interfaz 25/25, regresión en verde salvo dos fallas ajenas a HU-05 (ver "Pruebas") |
| Pruebas en Neon | Pendientes hasta que Neon tenga los esquemas de HU-08, HU-10 y HU-04 |
