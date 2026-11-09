# HU-16: Consultar vista consolidada multi-tienda

Estado: **IMPLEMENTADA** (2026-11-09) en la rama de Git `hu-16`, con pruebas en verde en el clon Docker (copia de Neon). Falta integrarla y avisar a Simon del cambio en sus eventos (ver "Riesgos").

Requerimientos: RF de la vista consolidada de la red (falta confirmar el código en el documento UML), **RNF-13** (consolidado con un retraso de algunos minutos y la hora de la última actualización), **RNF-05** (respuesta < 2 s), **RNF-10** (auditoría del acceso denegado) y el requisito de compatibilidad con los navegadores comunes (falta confirmar su código).

## Historia

Como administrador general, quiero ver una vista consolidada del inventario, las ventas y los ingresos de todas las tiendas de la red, para evaluar el desempeño de la cadena y comparar resultados entre sucursales.

## Criterios de aceptación

1. El sistema agrega y muestra el inventario, las ventas y los ingresos de todas las tiendas activas de la red.
2. La información consolidada indica la hora de la última actualización, con un retraso máximo de algunos minutos respecto a la operación real.
3. La vista es accesible desde los navegadores web más comunes.
4. La vista consolidada permite filtrar por tienda, rango de fechas o categoría de producto.
5. Si una tienda no ha enviado su información más reciente al nodo central, la vista lo indica claramente en lugar de mostrar datos desactualizados sin advertencia.

## Tareas

1. Implementar el proceso de consolidación periódica de datos de todas las tiendas hacia el nodo central.
2. Construir la vista consolidada con indicador de última actualización.

## Decisiones (con el usuario, 2026-11-09)

1. **Ventas por categoría en una tabla nueva del central.** Hoy `venta_consolidada` guarda tienda, día y método de pago, pero no productos, así que no se puede filtrar por categoría. Se agrega `venta_categoria_consolidada (id_tienda, fecha, id_categoria, unidades, ingresos)`.
   - La alimentan los eventos de venta y de devolución que ya existen. Cada uno lleva además un resumen por categoría.
   - Es un **cambio de estructura autorizado por el usuario**. Toca el evento de HU-08 y HU-10 (Simon) y hay que avisarle.
   - De paso resuelve lo que HU-05 dejó fuera: las unidades vendidas por tienda en el central.
   - Las ventas anteriores a HU-16 no traen el resumen por categoría. Con el filtro de categoría solo se ven las ventas desde que la tienda corre HU-16, y la pantalla lo indica.
2. **La consolidación periódica es también el latido de cada tienda.**
   - La reconciliación de stock de HU-01 se acelera de cada 15 minutos a cada 2 (configurable) y cubre todos los medicamentos activos, no solo los que tienen lotes.
   - Como la foto llega aunque la tienda no haya vendido nada, el central sabe cuándo supo de cada tienda por última vez, sin tabla de latidos.
   - Va por el mismo outbox ordenado que las ventas, así que si llegó la foto de las 10:00, también llegó todo lo que la tienda hizo antes de esa hora.
3. **Frescura por tienda, con umbral configurable.**
   - **Al día:** la última foto tiene 5 minutos o menos. Es el valor por defecto de `CONSOLIDADO_MAX_RETRASO_MIN`.
   - **Desactualizada:** pasó ese tiempo. Se muestra en rojo con la hora de la última foto, y sus cifras van marcadas.
   - **Sin datos:** la tienda nunca envió información.
   - Nunca se muestra un número sin su hora.
4. **Pantalla nueva para el módulo existente `RED_VISIBILIDAD`** ("Vista de red"), que hoy solo muestra una tarjeta. No hay permiso nuevo: lo tiene el administrador general.
5. **Diferencia con HU-05:** el comparativo de HU-05 es un reporte por periodo que se exporta. La vista de HU-16 es un **monitoreo vivo**: se refresca sola, muestra la frescura de cada tienda, filtra por categoría y baja hasta el inventario por producto. Reutilizan las consultas y los gráficos. El comparativo de HU-05 también mostrará la frescura.

## Qué existe y qué falta

| Necesidad | Ya existe | Qué falta |
| --- | --- | --- |
| Inventario de todas las tiendas | `inventario_consolidado` (por tienda y medicamento, con `fecha_sincronizacion`) por `STOCK_SNAPSHOT` (HU-01) y `umbral_stock` | Cubrir todos los medicamentos activos (hoy solo los que tienen lotes) y aplicar la foto en una sola sentencia |
| Ventas e ingresos por tienda | `venta_consolidada` por tienda, día y método de pago (HU-08 y HU-10) | — |
| Ventas por categoría | — | `venta_categoria_consolidada` y el resumen por categoría en los eventos |
| Categoría de un producto | `medicamento.id_categoria` y `categoria` en el central | — |
| Consolidación periódica | Outbox cada 10 s (`SYNC_INTERVALO_MS`) y reconciliación de stock cada 15 min | Bajarla a 2 min, configurable, sin acumular fotos sin conexión |
| Hora de la última actualización | `fecha_sincronizacion` por fila | La frescura por tienda (al día, desactualizada o sin datos) |
| Solo tiendas activas | `tienda.activa` (HU-15) | — |
| Permiso y módulo | `RED_VISIBILIDAD` y la tarjeta "Vista de red" | La pantalla |
| Gráficos, periodo y formato | `graficos.jsx`, `Periodo` y `periodoDe()` de HU-05 | — |

## Consolidación periódica (tarea 1)

- **En la tienda:** cada `CONSOLIDACION_INTERVALO_MS` (por defecto 120000) el ciclo del servidor encola un `STOCK_SNAPSHOT` completo.
  - La foto lleva el stock vendible de **todos los medicamentos activos** de `medicamento_ref`, con 0 si no tienen lotes, y la hora de cálculo.
  - **Sin conexión no se acumulan fotos.** Si ya hay una foto completa pendiente en el outbox, se descarta y la nueva queda al final de la cola, detrás de las ventas ya encoladas. Así su hora no promete más de lo que llegó. Al reconectar sube una sola, la más reciente.
- **En el central:** `stockSnapshot` aplica la foto con **una sola sentencia** (`jsonb_to_recordset` con upsert), en lugar de una consulta por medicamento.
  - Con 2.000 medicamentos y unos 130 ms por ida y vuelta, aplicar uno por uno tardaría minutos.
  - Sigue siendo idempotente (por `inbox_sync`) y monótona: una foto vieja no pisa una más nueva.
- **Latido:** la hora de la última foto de cada tienda es `max(inventario_consolidado.fecha_sincronizacion)`. Se registra aunque la tienda no tenga movimientos.
- **Ventas por categoría:**
  - `VENTA_REGISTRADA` lleva `categorias: [{ id_categoria, unidades, ingresos }]`, calculado al vender con las líneas de la factura.
  - `DEVOLUCION_REGISTRADA` lleva lo mismo con lo devuelto.
  - El central suma y resta en `venta_categoria_consolidada`, en la misma transacción e idempotencia del evento.
  - Un producto sin categoría va a la categoría 0 ("Sin categoría").
  - Un evento viejo sin `categorias` solo actualiza `venta_consolidada`, como hasta ahora.

## Vista consolidada (tarea 2)

Pantalla "Vista de red" en la consola (`RED_VISIBILIDAD`). Se refresca sola cada 30 s y también se puede refrescar con un botón.

- **Filtros** (en la URL, para compartir la vista):
  - Tienda: todas o una.
  - Rango de fechas: el mismo selector y los mismos límites de HU-05, hasta 366 días.
  - Categoría: todas o una.
- **Encabezado de frescura:**
  - "Actualizado hasta HH:MM" de la red: la foto más vieja entre las tiendas al día.
  - Un aviso rojo que nombra cada tienda **desactualizada** con su última hora, y cada tienda **sin datos**.
- **Ventas e ingresos:**
  - Totales de la red y por tienda: ingresos netos, facturas, unidades y ticket promedio.
  - Ingresos por método de pago.
  - Con una categoría elegida: ingresos y unidades de esa categoría por tienda.
  - Sin categoría elegida: ingresos por categoría de toda la red.
- **Inventario:**
  - Por tienda: unidades en stock, productos agotados, productos bajo el mínimo y productos sin reporte, filtrados por categoría.
  - Tabla de productos × tiendas, paginada y con búsqueda: stock de cada tienda con su estado (agotado, bajo o disponible) y el total de la red.
- **Cifras de una tienda desactualizada:** van con un ícono de advertencia y el texto "datos de las HH:MM", nunca como si fueran actuales.

## Rutas (solo nodo central, `RED_VISIBILIDAD`)

| Ruta | Uso |
| --- | --- |
| `GET /api/central/red/consolidado?desde=&hasta=&tienda=&categoria=` | Frescura por tienda, ventas, ingresos, métodos, categorías y resumen de inventario |
| `GET /api/central/red/inventario?tienda=&categoria=&q=&pagina=` | Productos × tiendas, paginado (50 por página) |
| `GET /api/central/categorias` | Lista para el filtro, si no hay una ruta del central que la sirva ya |

- Sin sesión responde 401. Sin permiso responde 403, que se audita como `ACCESO_DENEGADO`.
- Sin conexión con el central responde 503 con la última sincronización.
- Si se filtra por una tienda inactiva o inexistente responde 404. Un periodo inválido responde 400.

## Rendimiento

La meta es **p95 < 2 s**, medido con un volumen alto dentro de una transacción que se revierte:
- 50 tiendas.
- 1 año de `venta_consolidada` y de `venta_categoria_consolidada`.
- 2.000 medicamentos × 50 tiendas en `inventario_consolidado` (100.000 filas).

Cómo se cumple:
- Una consulta por bloque.
- Índices por la clave primaria `(id_tienda, fecha, …)`.
- Tabla de productos paginada.

Además se mide la foto completa de una tienda con 2.000 medicamentos: debe aplicarse en el central en < 1 s.

## Plan de desarrollo

Rama de Git `hu-16` desde `main`. Las pruebas se corren en el clon Docker (copia de Neon), como en HU-05: el usuario no tiene acceso para crear ramas de Neon.

| Paso | Qué | Archivos |
| --- | --- | --- |
| 0 | Esquema: `venta_categoria_consolidada` en el central | `db/central/12_hu16_venta_categoria.sql` |
| 1 | **Tarea 1a:** foto completa periódica (todos los activos, cada 2 min, sin acumular sin conexión) y aplicación en una sola sentencia | `apps/api/inventario/stock.mjs`, `apps/api/server.mjs`, `apps/api/config.mjs`, `apps/api/sync/central.mjs` |
| 2 | **Tarea 1b:** resumen por categoría en los eventos de venta y devolución, y su consolidación | `apps/api/ventas.mjs`, `apps/api/devoluciones.mjs`, `apps/api/sync/central.mjs` |
| 3 | **Tarea 2a:** API de la vista: frescura, ventas, categorías, inventario y filtros | `apps/api/vista-red.mjs`, `apps/api/routes/vista-red.mjs`, `apps/api/app.mjs` |
| 4 | **Tarea 2b:** pantalla "Vista de red" con filtros, aviso de frescura, refresco y tabla de productos × tiendas | `apps/web/src/VistaRed.jsx`, `apps/web/src/App.jsx`, `apps/web/src/styles.css` |
| 5 | Frescura también en el comparativo de HU-05 | `apps/api/reportes.mjs`, `apps/web/src/ReportesRed.jsx` |
| 6 | Pruebas: consolidación, frescura, filtros, categorías con devoluciones, idempotencia, permisos, sin conexión y rendimiento | `scripts/probar-hu16.mjs`, `package.json` (`test:hu16`) |
| 7 | Interfaz en **Chrome y Edge**, y en celular. Firefox a mano si está instalado. Regresión completa | Esta HU, sección "Pruebas" |

## Implementación

| Pieza | Archivo |
| --- | --- |
| Tabla `venta_categoria_consolidada` (cambio de estructura autorizado) | `db/central/12_hu16_venta_categoria.sql` |
| Intervalo de la foto completa y umbral de frescura (`CONSOLIDACION_INTERVALO_MS`, `CONSOLIDADO_MAX_RETRASO_MIN`) | `apps/api/config.mjs` |
| Foto completa periódica: todos los activos; sin conexión se descarta la pendiente y queda la nueva al final de la cola; payload con `completo: true` | `apps/api/inventario/stock.mjs` (`encolarStockCompleto`), `apps/api/server.mjs` |
| Foto aplicada en el central en una sola sentencia (`jsonb_to_recordset`), idempotente y monótona | `apps/api/sync/central.mjs` (`stockSnapshot`) |
| Resumen `categorias` en `VENTA_REGISTRADA` y `DEVOLUCION_REGISTRADA`, y su suma o resta en el central | `apps/api/ventas.mjs` (`porCategoria`), `apps/api/devoluciones.mjs`, `apps/api/sync/central.mjs` (`sumarCategorias`) |
| Regla de frescura (compartida con HU-05) | `apps/api/frescura.mjs` |
| Vista consolidada, inventario por producto y filtros | `apps/api/vista-red.mjs`, rutas en `apps/api/routes/vista-red.mjs` |
| Pantalla "Vista de red" (módulo `RED_VISIBILIDAD`) | `apps/web/src/VistaRed.jsx`, `apps/web/src/App.jsx`, `apps/web/src/styles.css` |
| Frescura en el comparativo de HU-05 (pantalla y Excel) | `apps/api/reportes.mjs`, `apps/web/src/ReportesRed.jsx` |
| Pruebas | `scripts/probar-hu16.mjs` (`npm run test:hu16`) |

Rutas implementadas: `GET /api/central/red/consolidado`, `GET /api/central/red/inventario` y `GET /api/central/red/filtros`. Esta última devuelve las tiendas activas y las categorías con "Sin categoría", y reemplaza a `/api/central/categorias` del plan.

Cambios en código existente:
- **Consultas en paralelo** (`reportes.mjs` y `vista-red.mjs`): pasan por `todas()`. Con el pool corren en paralelo; con un cliente en transacción, que es como las corren las pruebas, en serie, porque pg no admite consultas simultáneas en un mismo cliente.
- **La consolidación periódica corre cada 2 min** y no cada 15. Es la misma función de HU-01, ahora con todos los activos y sin acumular.

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-16 Consultar vista consolidada multi-tienda

  Escenario: Vista de toda la red
    Dado dos tiendas activas que vendieron y reportaron stock en el periodo
    Cuando el administrador general abre la Vista de red
    Entonces ve ingresos, facturas, unidades e inventario de cada tienda y el total de la red
    Y una tienda desactivada no aparece

  Escenario: Consolidación periódica sin ventas
    Dado una tienda conectada que no vende nada durante 10 minutos
    Entonces su foto de stock llega al central cada 2 minutos
    Y la vista la muestra "al día" con la hora de la última foto

  Escenario: Tienda que no envió su información
    Dado una tienda cuya última foto es de hace 20 minutos
    Cuando se abre la Vista de red
    Entonces la tienda aparece como "desactualizada" con la hora 20 minutos atrás
    Y sus cifras van marcadas como datos de esa hora
    Y el aviso del encabezado la nombra

  Escenario: Tienda que nunca envió información
    Dado una tienda activa recién creada sin datos
    Entonces aparece como "sin datos" y no con ceros

  Escenario: Sin conexión no se acumulan fotos
    Dado una tienda sin conexión durante 10 minutos
    Entonces en su outbox hay una sola foto completa pendiente, la más reciente
    Y al reconectar el central recibe esa foto y la tienda vuelve a estar "al día"

  Escenario: Filtro por categoría
    Dado una venta de 3 unidades de Analgésicos y 2 de Antibióticos en la tienda 1
    Y la devolución de 1 unidad de Analgésicos
    Cuando se filtra por Analgésicos
    Entonces la tienda 1 muestra 2 unidades y sus ingresos netos de Analgésicos
    Y el inventario muestra solo productos de Analgésicos

  Escenario: Filtros por tienda y fechas
    Cuando se filtra por la tienda 1 y un rango de fechas
    Entonces ventas e inventario son solo de esa tienda en ese rango

  Escenario: Evento duplicado
    Cuando el central recibe dos veces el mismo evento de venta
    Entonces las ventas por categoría suman una sola vez

  Escenario: Permisos
    Dado un usuario sin RED_VISIBILIDAD
    Cuando pide la vista consolidada
    Entonces recibe 403 y queda ACCESO_DENEGADO en la auditoría

  Escenario: Navegadores
    Cuando la vista se abre en Chrome, Edge y en un celular
    Entonces se ve completa, sin errores y sin desplazamiento horizontal
```

## Pruebas

`npm run test:hu16` (`scripts/probar-hu16.mjs`) recorre las rutas reales de `app.mjs`. Con URLs de Neon exige `PERMITIR_NEON=1`. Se corre con el API detenido.

- **Datos de prueba:** medicamentos de prueba en dos categorías, con ventas y una devolución hechas con los servicios de HU-08 y HU-10.
- **Frescura:** se simula moviendo `fecha_sincronizacion` dentro de una transacción que se revierte.
- **Qué cubre:**
  - Foto completa con todos los activos.
  - Sin conexión, una sola foto pendiente.
  - Aplicación idempotente y monótona.
  - Ventas por categoría con venta y devolución.
  - Evento duplicado.
  - Evento viejo sin `categorias`.
  - Filtros por tienda, fechas y categoría.
  - Tienda desactivada fuera.
  - Tienda inexistente 404.
  - 401, 403 y auditoría.
  - 503 sin conexión.
  - Rendimiento con volumen.
- **Regresión completa:** HU-01, porque cambia la reconciliación, y HU-08 y HU-10, porque cambian sus eventos.
- **Interfaz:** Chrome y Edge con playwright, y celular de 390 px.

### Resultado (2026-11-09, clon Docker)

Se usaron las bases `hu16_central` y `hu16_local`, copiadas de la copia exacta de Neon del 2026-10-28. Al arrancar, el API aplicó los esquemas pendientes y el nuevo de HU-16. No se tocó ninguna base de Neon.

| Prueba | Resultado |
| --- | --- |
| `npm run test:hu16` | **56/56** |
| Rendimiento: vista de un año con 50 tiendas, 2.000 medicamentos (100.000 filas de inventario), 73.200 de ventas y 91.500 por categoría | p95 **514 ms** (con las consultas en serie, dentro de la transacción de prueba; con el pool van en paralelo) |
| Rendimiento: la misma vista filtrada por categoría | p95 **260 ms** |
| Rendimiento: inventario por producto (página de 50 × 52 tiendas) | p95 **66 ms** |
| Foto completa de 2.000 medicamentos aplicada en el central | **43 ms** (meta < 1 s) |
| Interfaz en **Chrome y Edge**: aviso de frescura, filtros por tienda y categoría en la URL, inventario filtrado, búsqueda sin tildes, celular de 390 px, frescura en HU-05 | **30/30** (15 por navegador), sin errores de JavaScript |
| `db:verificar --estricto` | Sin diferencias en los dos nodos |
| Regresión: `test:hu01` 39, `hu02` 38, `hu03` 44, `hu04` 64, `hu05` 64, `hu07` 63, `hu08` 85, `hu09` 49, `hu10` 65, `hu15` 47 | Todas en verde |
| `test:hu06` 38 y `test:hu12` 141 | En verde después de corregir sus pruebas (ver "Ajustes en partes de otras historias") |
| Ventas sin factura detrás en `venta_consolidada` | **0**, después de corregir las pruebas de HU-08 y HU-10 y limpiar el clon |

Hallazgos del recorrido:
- **Error de la primera versión de la prueba, no de la app.** La prueba creaba en el central una cuenta con un rol nuevo sin publicar el rol, y la réplica hacia la tienda se trabó en la base de prueba. Se corrigió: la prueba publica `ROL_UPSERT` antes de crear la cuenta, igual que la app. La base de prueba se destrabó a mano.
- **Restos de esa corrida cortada.** Dos medicamentos de prueba quedaron activos en la tienda y la regresión de HU-01 lo detectó. Se desactivaron a mano en el clon.
- **Farmacia Norte**, la tienda demo sin nodo propio, aparece correctamente como "desactualizada" desde el 2026-10-28: nunca envía información.

## Ajustes en partes de otras historias (2026-11-09)

HU-05 y HU-16 dejaron a la vista desajustes en pruebas y documentos de otras historias (Simon). Se corrigieron para que las pruebas pasen por las razones correctas y para que todo lo que entra a los consolidados tenga una operación real detrás.

| Dónde | Problema | Corrección |
| --- | --- | --- |
| `scripts/probar-hu06.mjs` | Esperaba que el cajero tuviera exactamente 2 permisos; desde HU-10 tiene 3 (`FACTURA_ANULAR`) | Espera los 3, documentados por historia, y verifica que el cajero no tenga permisos de administración ni de reportes (`REPORTE_TIENDA_VER`, `RED_VISIBILIDAD`, …) |
| `scripts/hu06-pruebas.mjs` (no está en `package.json`) | Listas de permisos del cajero y del admin de tienda anteriores a HU-02, HU-07, HU-10 y HU-05 | Listas actualizadas con la historia de cada permiso |
| `scripts/probar-hu12-central.mjs` | Usaba fija la tienda 2 como "otra tienda", que no existe en todas las bases | Toma la primera tienda activa distinta de la 1. Si no hay, se detiene con un mensaje claro |
| `scripts/probar-hu08.mjs` y `scripts/probar-hu10.mjs` | La prueba del evento duplicado dejaba en el central, en cada corrida, una venta de $10 (2026-01-02) y una devolución de −$10 (2026-01-03) sin factura ni nota detrás. Aparecían en los reportes de la red | La prueba corre dentro de una transacción que se revierte: verifica lo mismo y no deja rastro |
| `HU-06` (doc) | La tabla de roles no tenía los permisos agregados por HU-02, HU-05, HU-07, HU-10 y HU-16 | Tabla actualizada |
| `HU-08` (doc) | No describía el campo `categorias` del evento `VENTA_REGISTRADA` | Descrito, junto con su equivalente en `DEVOLUCION_REGISTRADA` (HU-10) |
| `HU-04` (doc) | Decía que HU-06 exige 2 permisos al cajero y que HU-16 haría la vista de alertas de red | Corregido: el cajero tiene 3 permisos, y HU-16 muestra agotados y bajo mínimo por tienda, pero no el panel de alertas ni la caducidad por lote |
| `HU-01` (doc) | La reconciliación corría cada 15 min y solo cubría medicamentos con lotes | Describe la consolidación de HU-16: cada 2 min, todos los activos y sin acumular |

**Bases que ya tienen esos restos.** La rama de Neon de Simon (`HU-Simon-Sprint2`) y cualquier base donde se hayan corrido `test:hu08` o `test:hu10` antes de esta corrección tienen esas filas. Se identifican y se borran con esta consulta: la venta y la devolución de prueba no tienen factura ni nota en ninguna tienda. Revisar antes de ejecutarla.

```sql
-- Central. Primero revisar qué se va a borrar:
select * from venta_consolidada
where (fecha = '2026-01-02' and total_vendido = 10.00 * total_facturas) or (fecha = '2026-01-03' and total_facturas = 0);
select * from inbox_sync
where tipo_evento in ('VENTA_REGISTRADA', 'DEVOLUCION_REGISTRADA') and payload ->> 'fecha' in ('2026-01-02', '2026-01-03') and payload ->> 'total' = '10.00';
-- Si coinciden (cada corrida suma 10.00 y resta 10.00), borrar esas filas.
```

## Riesgos y dependencias

1. **Cambio de estructura y de los eventos de Simon.** La tabla nueva y el campo `categorias` en `VENTA_REGISTRADA` y `DEVOLUCION_REGISTRADA` se coordinan con Simon antes de integrar.
   - Es compatible en los dos sentidos: un central nuevo acepta eventos viejos, y un central viejo ignora el campo nuevo.
2. **Neon real atrasado.** Neon real no tiene los esquemas de HU-08, HU-10 y HU-04, de los que depende esta vista. Se prueba en el clon Docker. Antes de arrancar el API contra Neon real hay que coordinar con Simon.
3. **Más tráfico al central.** Cada tienda manda una foto completa cada 2 minutos: 720 al día, cada una con una fila en `inbox_sync`.
   - Con pocas tiendas es poco.
   - A futuro conviene depurar `inbox_sync` de fotos viejas, en otra historia.
   - El intervalo es configurable.
4. **Relojes.** La frescura compara la hora de la foto (reloj de la base local) con la del central. Las dos son Neon (UTC con NTP), así que la diferencia es despreciable frente al umbral de 5 minutos.
5. **Ventas anteriores sin categoría.** El filtro por categoría no incluye ventas anteriores a HU-16. La pantalla lo aclara cuando el rango empieza antes de la primera venta con categoría.
6. **Firefox y Safari.** Las pruebas automáticas cubren Chrome y Edge, que son los navegadores instalados. Firefox se revisa a mano si está disponible. Safari no se puede probar en Windows.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Historia y criterios | Definidos por el usuario |
| Análisis y plan | 2026-11-09: consolidación periódica como latido; ventas por categoría en una tabla nueva (autorizada); pantalla para `RED_VISIBILIDAD` |
| Implementación | 2026-11-09 en la rama `hu-16` (ver "Implementación") |
| Pruebas | 2026-11-09 en el clon Docker: HU-16 56/56, interfaz 30/30 en Chrome y Edge, regresión completa en verde (13 suites, incluidas HU-06 y HU-12 tras corregir sus pruebas) |
