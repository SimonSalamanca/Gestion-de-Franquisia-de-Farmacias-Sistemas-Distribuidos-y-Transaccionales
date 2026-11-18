# Reducción de tablas: informe final

Experimento hecho el 2026-11-17/18 en la rama de git `reduccion-tablas` y en las ramas Neon `reduccion-tablas` de los tres
proyectos. **Producción no se tocó**: `main` sigue igual y las ramas Neon que usa la aplicación tampoco cambiaron.

## Resultado

| Nodo | Antes | Después | Cambio |
|---|---|---|---|
| Central | 33 tablas | **27 tablas** | −6 |
| Local (cada farmacia) | 50 tablas, 4 vistas | **44 tablas**, 1 vista | −6 tablas, −3 vistas sin uso |
| **Total de la red (central + 1 farmacia)** | 83 | **71** | −12 |

Las pruebas dan el mismo resultado que en la línea base (`linea-base.md`): **28 de 29** scripts pasan, y el único fallo
(`probar-hu01`) es el mismo fallo de datos que ya existía antes de empezar.

## Qué se fusionó

### Nodo Central (33 → 27)

| Antes | Después | Por qué es equivalente |
|---|---|---|
| `tienda_operacion` + `auth_operacion` | `auth_operacion` | Misma estructura; `auth_operacion` ya era la tabla de idempotencia común del nodo. |
| `politica_acceso` + `politica_receta` | `politica_sistema` | Ambas eran una sola fila (`id = 1`). |
| `medicamento_proveedor` | (eliminada) | Ningún código la usaba y estaba vacía. El script solo la elimina vacía. |
| `umbral_stock` + `inventario_consolidado` | `medicamento_tienda` | Misma clave (tienda, medicamento). Umbral nulo = sin umbral; stock y fecha nulos = la tienda no lo ha reportado. Dos `CHECK` obligan a que cada par sea nulo o no nulo a la vez. |
| `auditoria_tienda` + `registro_actividad_central` | `registro_actividad_central` | Las filas de las tiendas llevan `id_tienda` e `id_registro_tienda` (clave única: un reenvío no duplica); `id_tienda` nulo = registrado por el central. |
| `bloqueo_canonico` | columnas `epoch_bloqueo` y `bloqueo_canonico_hasta` de `control_acceso` | Las épocas de un empleado solo crecen: basta recordar la última época bloqueada y su fin. |

### Nodo Local (50 → 44)

| Antes | Después | Por qué es equivalente |
|---|---|---|
| `precio_vigente_ref` | (eliminada) | Sin uso; la reemplazaron `precio_ref` y `precio_vigente()`. |
| `secuencia_factura` + `secuencia_nota` | `secuencia_documento` (una fila por tipo) | Misma estructura. Cada tipo tiene su fila, así que facturas y notas no se bloquean entre sí. |
| `politica_acceso` + `politica_receta` | `politica_sistema` | Ambas eran una sola fila. |
| `replica_cursor` + `auditoria_cursor` | `cursor_sync` | Misma clave (`id_tienda`). |
| `empleado_ref_cuarentena` | `sync_conflicto` (tipo `EMPLEADO_CUARENTENA`, fila en `payload`) | Es un tipo de anomalía de sincronización; se guarda como resuelta para no cambiar el contador de conflictos pendientes. |
| `umbral_stock_ref` | columnas `stock_minimo` y `dias_alerta_caducidad` de `medicamento_ref` | Misma clave (`id_medicamento`); el nodo es de una sola tienda. `SIN_UMBRAL` = `stock_minimo` nulo. |
| Vistas `vw_stock_tienda`, `vw_alerta_caducidad`, `vw_alerta_stock_bajo` | (eliminadas) | Sin uso; las reemplazó `alertas_calculadas`. |

## Cómo se aplica

- Los scripts históricos (`db/<nodo>/01…15`) se editaron para crear directamente la estructura nueva. Era necesario porque
  el migrador los vuelve a ejecutar en cada arranque: si siguieran creando las tablas viejas, las recrearían.
- `db/<nodo>/16_reduccion_tablas.sql` mueve los datos de cada tabla vieja **solo si existe**, comprueba que no se pierda
  ninguna fila (si algo no cuadra, aborta) y la elimina. El migrador ejecuta el archivo en una sola transacción.
- En una base existente actúa una vez. En una instalación nueva, limpia lo que crea `00_base.sql`.

## Verificación

| Prueba | Resultado |
|---|---|
| Conteo de tablas (`scripts/contar-tablas.mjs`) | Central 27, tienda 1 44, tienda 2 44 |
| `db-verificar --estricto` (los tres nodos) | Sin diferencias entre la base y los scripts |
| Datos movidos | 218 umbrales y 81 filas de stock en `medicamento_tienda`; 1287 + 2934 filas de auditoría; 72 umbrales de la tienda 1; consecutivos (T1-000710, NC-T1-000102), políticas y cursores conservados |
| Suite en proceso (23 scripts) | Igual que la línea base |
| Suite por HTTP con el API de la rama (6 scripts) | Igual que la línea base, incluida sincronización sin conexión y reconexión |
| Instalación desde cero (base vacía) | Llega a 27/44 sin diferencias; `verificar-eventos`, HU-04 y HU-08 pasan sobre ella |
| Prueba manual en el navegador (web actual) | Inventario (estado "Bajo" con el umbral nuevo), existencias en la red, alertas, vista de red y auditoría unificada |

Durante la fase 2, `probar-hu05` y `probar-hu16` fallaron una vez solo en el límite de tiempo de sus pruebas de volumen
(p95 de 2048 y 2763 ms contra 2000 ms). Esas consultas no usan ninguna tabla tocada; repetidas solas pasaron (64/64 y
56/56), y en la fase 3 pasaron completas. Es variación del cómputo gratuito de Neon.

## Decisiones y concesiones

- **FK de la auditoría del central.** `registro_actividad_central` tenía FK a `empleado` y `auditoria_tienda` no ("es
  historia"). Al fusionarlas, la FK pasó a un disparador que solo revisa las filas del central: al insertar, las dos reglas
  quedan iguales. Diferencia: la FK también impedía borrar un empleado con auditoría; el disparador no. Los empleados no se
  borran (baja lógica con `fecha_baja`).
- **`ON DELETE CASCADE` en `medicamento_tienda`.** `umbral_stock` tenía cascada y `inventario_consolidado` no. La tabla
  fusionada usa cascada. Solo importa si se borra una tienda o un medicamento, cosa que la aplicación no hace (bajas lógicas).
- **`cursor_sync` lo escriben dos ciclos.** El de réplica y el de auditoría actualizan columnas distintas de la misma fila.
  No hay pérdida de datos, pero uno puede esperar a que el otro termine su transacción.
- **El nombre `registro_actividad_central` se conservó** aunque ahora también guarda lo que suben las tiendas. Así no cambió
  ninguna de las inserciones del central.

## Si algún día se lleva a producción

1. Pasar por el ciclo de `AGENTS.md` (propuesta de Grok, `APROBADO` de GPT-5.6 Luna, subagentes técnicos). No se hizo.
2. Desplegar todos los nodos a la vez. El central lo migra el primer nodo que arranca, y un nodo con el código viejo
   buscaría tablas que ya no existen (`tienda_operacion`, `umbral_stock`, `auditoria_tienda`…). Ningún mensaje de
   sincronización entre nodos cambió de forma: un evento viejo pendiente en una cola se sigue aplicando bien.
3. Hacer antes una rama de respaldo de cada base en Neon.
4. Fusionar la rama de git a `main`. Ojo: Render despliega `main` automáticamente y migra al arrancar.

## Archivos

- `linea-base.md` y `filas-linea-base.json`: estado antes de empezar.
- `docs/database/central_schema.sql` y `docs/database/local_schema.sql`: esquema final generado desde el catálogo de las ramas.
- Commits en la rama `reduccion-tablas`: fase 0 (entorno), fase 1 (línea base), fase 2 (riesgo bajo), fase 3 (riesgo medio)
  y este informe.
