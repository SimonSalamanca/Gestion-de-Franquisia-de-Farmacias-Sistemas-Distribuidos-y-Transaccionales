# HU-04 — Gestionar alertas de stock bajo y caducidad

Estado: **IMPLEMENTADA** (2026-11-04): esquemas en `db/local/08_hu04_alertas.sql` y `db/central/09_hu04_umbrales.sql`, panel "Alertas" en Inventario, indicador en la barra superior y pruebas en verde (ver "Pruebas"). Pendiente el veredicto del auditor (GPT-5.6 Luna), igual que HU-03, HU-07, HU-08 y HU-12.

Requerimientos: **RF-03** (alertas de stock bajo, próxima caducidad, bloqueo de vencidos y panel por urgencia), regla de negocio 4 (lote vencido bloqueado automáticamente) y 10 (alertas), **RNF-04** (autonomía local), **RNF-06** (concurrencia), **RNF-10**.

## Historia

Como empleado de tienda, quiero recibir alertas automáticas cuando el stock de un medicamento caiga por debajo de un umbral o cuando un lote esté próximo a caducar, para anticipar el desabastecimiento y evitar la venta de productos vencidos.

## Criterios de aceptación

1. El sistema compara continuamente el stock disponible de cada producto contra un umbral mínimo configurable por producto y tienda, generando una notificación automática cuando el stock cae por debajo del umbral.
2. El sistema notifica cuando un lote se aproxima a su fecha de caducidad, según un periodo de aviso configurable.
3. Un lote cuya fecha de caducidad ya se cumplió queda bloqueado automáticamente para venta.
4. Todas las alertas activas se muestran en un panel único, ordenado por nivel de urgencia.
5. El umbral mínimo de stock y el periodo de aviso de caducidad son configurables de forma independiente por producto y por tienda.

## Decisiones (con el usuario, 2026-11-04)

1. **Todo producto tiene umbral.** El sistema de alertas solo vigila lo que tiene umbral, así que ningún medicamento activo puede existir sin umbral (stock mínimo y días de aviso) en una tienda activa. Lo garantiza la base del central con restricciones diferidas: al hacer commit, un medicamento activo exige un umbral en cada tienda activa (`MEDICAMENTO_SIN_UMBRAL`) y una tienda activa exige un umbral para cada medicamento activo (`TIENDA_SIN_UMBRALES`). Crear el producto y sus umbrales va en la misma transacción.
2. **"Eliminar" los que no cumplen = darlos de baja.** Un medicamento no se puede borrar de la base: las facturas, recetas y movimientos que lo referencian son inmutables. `npm run db:depurar-umbrales` lista los productos activos sin umbral; con `-- --aplicar` los da de baja (`activo = false`), se publica a las tiendas y queda en la auditoría (`MEDICAMENTO_BAJA_SIN_UMBRAL`). Los que todavía tienen unidades en la red solo se dan de baja con `--incluir-con-stock`, porque dejan de venderse. Es una acción explícita: no corre sola al arrancar, para no dar de baja productos reales de producción por sorpresa.
3. **Una tienda nueva recibe sus umbrales.** `crearTienda` (HU-15) crea un umbral por cada medicamento activo con valores iniciales (mínimo 10, aviso 30 días) y los publica; luego se ajustan en "Tiendas > Umbrales". Los medicamentos demo reciben los suyos al sembrarse.
4. **Defensa en profundidad.** Si por un atraso de réplica o un dato heredado un producto activo llega sin umbral a una tienda, el panel muestra una alerta `SIN_UMBRAL` (alta), y sus lotes igual avisan la caducidad con un aviso de 30 días.
5. **Sin permisos nuevos.** Ven las alertas quienes pueden consultar el inventario (`INVENTARIO_CONSULTAR`, también el cajero): HU-06 fija los permisos del cajero (hoy tres, con `FACTURA_ANULAR` de HU-10). Los umbrales los configura el administrador general en la consola, como en HU-15.
6. **Stock bajo = igual o menor que el mínimo**, la misma regla que HU-01 usa para marcar "bajo".

## Reglas de las alertas

| Tipo | Condición | Nivel |
| --- | --- | --- |
| `LOTE_VENCIDO` | `fecha_caducidad < hoy` y aún con unidades (el lote queda bloqueado) | **Crítica** |
| `STOCK_AGOTADO` | Sin unidades vendibles, con umbral configurado | **Crítica** |
| `CADUCIDAD_PROXIMA` | Faltan 7 días o menos | **Alta** |
| `CADUCIDAD_PROXIMA` | Dentro del periodo de aviso del umbral | Media |
| `STOCK_BAJO` | Stock vendible hasta la mitad del mínimo | **Alta** |
| `STOCK_BAJO` | Entre la mitad y el mínimo | Media |
| `SIN_UMBRAL` | Medicamento activo sin umbral en esta tienda | **Alta** |

- **Stock vendible:** lotes `DISPONIBLE` y no vencidos, la misma regla de HU-01 y de la venta. Los lotes vencidos o bloqueados no cuentan.
- **Orden del panel:** primero por nivel; dentro de un nivel, lo más vencido, lo más cercano a caducar o lo más escaso. Un lote vencido sale antes que un producto agotado.
- **Un lote que caduca hoy** sigue vendible hasta mañana (igual que la venta).
- Las reglas viven en una sola vista: `alertas_calculadas`.

## Cómo funciona

- **Evaluación continua:** la función `evaluar_alertas()` se ejecuta cada 30 s en el ciclo del servidor (antes de mirar la conexión con el central, así que también sin conexión) y cada vez que se abre el panel. En una sola llamada: bloquea los lotes vencidos, crea y actualiza las alertas y resuelve las que ya no aplican. Es idempotente.
- **Notificación:** cada alerta nueva es una fila en `alerta` (estado `ACTIVA`), visible en el panel y en el indicador de la barra superior ("⚠ 3 urgentes": críticas y altas sin ver, se refresca solo). Un empleado puede marcarla como vista (queda quién y cuándo). Al dejar de cumplirse la condición pasa sola a `RESUELTA` y queda el historial.
- **Bloqueo automático (criterio 3):** el lote vencido pasa a `BLOQUEADO`, se audita como `LOTE_BLOQUEO_AUTOMATICO` con el sistema como actor (la auditoría local admite un actor nulo) y se encola el nuevo stock para el central. La venta ya lo rechazaba por la fecha; el bloqueo hace el estado visible y consistente.
- **Concurrencia con ventas (RNF-06):** el bloqueo usa `FOR UPDATE SKIP LOCKED`: si una venta tiene el lote en ese instante, se bloquea en la siguiente pasada y nunca espera ni se interbloquea con ella. `alerta` no tiene clave foránea hacia `lote`: esa FK tomaba un bloqueo que chocaba con el `FOR UPDATE` de una venta (lo descubrió la prueba). Dos evaluaciones simultáneas no duplican alertas (bloqueo consultivo e índice único `uq_alerta_activa`).

## Rutas (solo `/api/local`, permiso `INVENTARIO_CONSULTAR`)

| Ruta | Uso |
| --- | --- |
| `GET /alertas[?estado=ACTIVA\|RESUELTA&tipo=&nivel=]` | Panel ordenado por urgencia (evalúa antes de listar) |
| `GET /alertas/resumen` | Contadores por nivel, sin ver y urgentes (indicador de la barra superior) |
| `POST /alertas/{id}/vista` | Marcar como vista (la primera confirmación queda) |

La configuración de los umbrales sigue en el central (HU-15): `PUT /api/central/tiendas/{id}/umbrales`.

## Offline y reconexión

- **Sin conexión con el central:** las alertas se calculan y se muestran igual; los umbrales ya están replicados (`umbral_stock_ref`). Un cambio de umbral exige el central (503 desde la consola) y llega a la tienda en la siguiente sincronización.
- **Configuración por tienda:** el umbral de una tienda viaja solo a esa tienda; el de otra tienda no cambia el suyo.
- **Reconexión:** el stock que cambió por un bloqueo automático sale por el outbox como `STOCK_SNAPSHOT` con cantidades absolutas, así que un reintento no descuadra el consolidado.

## Implementación

| Pieza | Archivo |
| --- | --- |
| Evaluación, panel y resumen | `apps/api/alertas.mjs`, rutas en `apps/api/routes/alertas.mjs` |
| Ciclo de evaluación | `apps/api/server.mjs` (cada 30 s, antes de la sincronización) |
| Esquema local (alerta, vista, función, auditoría del sistema) | `db/local/08_hu04_alertas.sql` |
| Regla de umbrales (central) | `db/central/09_hu04_umbrales.sql`, `apps/api/umbrales.mjs` |
| Tienda nueva y demo con umbrales | `apps/api/tiendas.mjs` (`crearTienda`), `apps/api/demo.mjs`, publicación en `apps/api/migrate.mjs` |
| Depuración de productos sin umbral | `scripts/depurar-umbrales.mjs` (`npm run db:depurar-umbrales`) |
| Interfaz | `apps/web/src/Alertas.jsx`, pestañas en `apps/web/src/InventarioAlertas.jsx`, indicador en `apps/web/src/App.jsx` |
| Pruebas | `scripts/probar-hu04.mjs` (`npm run test:hu04`) |

Cambios en código existente: `db-verificar` reconoce `CONSTRAINT TRIGGER` y `DROP CONSTRAINT IF EXISTS`; las pruebas de HU-03, HU-08 y HU-15 crean sus medicamentos de prueba con sus umbrales en la misma transacción.

## Criterios Gherkin

```gherkin
# language: es
Característica: HU-04 Gestionar alertas de stock bajo y caducidad

  Escenario: Alerta de stock bajo en el umbral
    Dado "Prueba X" con mínimo 10 en esta tienda y 30 unidades vendibles
    Cuando el stock baja a 11
    Entonces no hay alerta
    Cuando baja a 10
    Entonces aparece STOCK_BAJO nivel Media
    Cuando baja a 5
    Entonces la misma alerta sube a nivel Alta sin duplicarse
    Cuando llega a 0
    Entonces es STOCK_AGOTADO nivel Crítica y la anterior queda resuelta

  Escenario: La alerta se resuelve al reponer
    Dado una alerta de stock bajo
    Cuando se repone el stock por encima del mínimo
    Entonces la alerta pasa a RESUELTA y queda en el historial

  Escenario: Aviso de caducidad con periodo configurable
    Dado un aviso de 10 días y lotes que caducan en 5, 9, 12 y 100 días
    Entonces avisan el de 5 (Alta) y el de 9 (Media)
    Cuando el administrador general cambia solo el aviso a 15 días
    Entonces también avisa el de 12 y el stock mínimo no cambia

  Escenario: Bloqueo automático de un lote vencido
    Dado un lote con 7 unidades cuya caducidad fue ayer
    Cuando corre la evaluación
    Entonces el lote queda BLOQUEADO y aparece LOTE_VENCIDO nivel Crítica
    Y queda LOTE_BLOQUEO_AUTOMATICO en la auditoría con el sistema como actor
    Y una venta de ese medicamento recibe STOCK_INSUFICIENTE

  Escenario: Un lote que caduca hoy sigue vendible
    Dado un lote que caduca hoy
    Cuando corre la evaluación
    Entonces no se bloquea

  Escenario: Panel único por urgencia
    Dado alertas de varios tipos y niveles
    Cuando el cajero abre el panel
    Entonces ve todas en una lista ordenada de Crítica a Media
    Y dentro de un nivel, lo que caduca antes va primero

  Escenario: Configuración independiente por producto y por tienda
    Dado el producto X con mínimo 10 en esta tienda y 500 en otra
    Entonces las alertas de esta tienda usan 10
    Y cambiar solo los días de aviso no cambia el mínimo, ni al revés

  Escenario: Ningún producto activo sin umbral
    Cuando se intenta crear un medicamento activo sin umbral en cada tienda activa
    Entonces el commit falla con MEDICAMENTO_SIN_UMBRAL y no queda guardado
    Y crear una tienda activa sin umbrales falla con TIENDA_SIN_UMBRALES

  Escenario: Depurar productos heredados sin umbral
    Dado dos productos activos heredados sin umbral, uno con 12 unidades en la red
    Cuando se ejecuta la depuración sin opciones
    Entonces los lista y no cambia nada
    Cuando se ejecuta con --aplicar
    Entonces se da de baja el que no tiene unidades
    Y con --incluir-con-stock también el otro, sin borrar nada y con auditoría

  Escenario: Una venta tiene el lote tomado
    Dado una venta que tiene bloqueado un lote vencido
    Cuando corre la evaluación
    Entonces termina sin esperar y deja ese lote para la siguiente pasada
    Y no hay interbloqueo con la venta

  Escenario: Evaluaciones simultáneas
    Cuando seis evaluaciones corren a la vez
    Entonces no se duplica ninguna alerta

  Escenario: Sin conexión con el central
    Dado que el estado real del POS es offline
    Cuando el cajero abre el panel
    Entonces las alertas se calculan y se muestran
```

## Pruebas

`npm run test:hu04` (`scripts/probar-hu04.mjs`, 64 casos por las rutas reales de `app.mjs` y por SQL). Escribe en las bases del `.env`; con Neon exige `PERMITIR_NEON=1`. Correr con el API detenido y **una sola corrida a la vez** (dos corridas simultáneas se pisan las bases). Cada corrida crea sus medicamentos y lotes y los deja inactivos al final.

Resultado (2026-11-04, rama de Neon `HU-Simon-Sprint2`): `test:hu04` 64/64. Regresión: `test:hu08` 85/85, `test:hu12` 71/71 y `probar-hu12-central` 70/70, `test:hu01` 39/39, `test:hu02` 38/38, `test:hu03` 44/44, `test:hu15` 47/47 y `db:verificar --estricto` sin diferencias. Recorrido en el navegador como cajero: el indicador "⚠ urgentes" abre la pestaña Alertas con el panel ordenado (Enalapril y Vacuna agotados, lote de Acetaminofén por caducar en 20 días, Amoxicilina con 8 de un mínimo de 10).

**Nota:** `test:hu06` (37/37) y `test:hu07` (63/63) fallaron una vez cada una durante la regresión porque había un `npm run dev` sincronizando contra las mismas bases; repetidas con el API detenido pasan completas. Las pruebas escriben en las bases del `.env`: no se deben correr con un API levantado sobre ellas. Lo que HU-04 cambia en la auditoría (actor nulo del bloqueo automático) se comprobó aparte: las filas `LOTE_BLOQUEO_AUTOMATICO` suben al central.

Hallazgos corregidos en el camino:
- La clave foránea `alerta.id_lote → lote` hacía que la evaluación esperara a las ventas y podía interbloquearse con ellas: se quitó.
- Una de las pruebas hizo notar que, sin lotes, un producto con umbral queda "agotado": es el comportamiento buscado (sin unidades vendibles no hay stock).

## Pendiente para otras historias

- **Alertas de toda la red en el central:** HU-16 (vista de red, 2026-11-09) muestra por tienda los productos agotados y bajo el mínimo con la hora de su información, pero no el panel de alertas ni la caducidad por lote, porque el central no tiene las fechas de los lotes. Queda para otra historia.
- **HU-13:** crear un pedido a proveedor desde una alerta.
- **Notificación fuera de la pantalla** (correo o push): hoy es el panel y el indicador, que se refrescan solos.

## Ciclo

| Paso | Resultado |
| --- | --- |
| Plan y decisiones | Todo producto con umbral; los que no cumplen se dan de baja (no se borran); rama de Git `hu-04` |
| Implementación y pruebas | En verde, incluida la regresión completa (2026-11-04) |
| Auditor GPT-5.6 Luna | pendiente |
