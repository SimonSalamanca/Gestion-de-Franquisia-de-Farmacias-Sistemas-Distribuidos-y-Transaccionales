# Línea base de la reducción de tablas

Tomada el 2026-11-18 sobre las ramas Neon `reduccion-tablas`, con el código de `main` (commit 4581f49) más la fase 0, que no cambia el esquema.

| Nodo | Endpoint de la rama | Copia de | Tablas | Vistas |
|---|---|---|---|---|
| Central | ep-snowy-leaf-acbyiiie | Sprint3_Simon_HU | 33 | 0 |
| Tienda 1 | ep-autumn-frost-acnt19b7 | Sprint3_Simon_HU | 50 | 4 |
| Tienda 2 | ep-twilight-firefly-b6d8buqn | production | 50 | 4 |

Filas por tabla antes de cualquier prueba: `filas-linea-base.json`.

## Pruebas

Todas con `FARMAHUB_ENV_FILE=.env.rama.local PERMITIR_NEON=1`. Las de HTTP, con el API de la tienda 1 levantado contra la rama.

| Prueba | Código de salida | OK | Fallos | Segundos |
|---|---|---|---|---|
| probar-hu06 | 0 | 38 | 0 | 139 |
| db-verificar | 0 | 0 | 0 | 6 |
| verificar-escrituras | 0 | 0 | 0 | 1 |
| verificar-eventos | 0 | 6 | 0 | 3 |
| probar-hu01 | 1 | 38 | 1 | 64 |
| probar-hu02 | 0 | 38 | 0 | 75 |
| probar-hu03 | 0 | 44 | 0 | 166 |
| probar-hu04 | 0 | 64 | 0 | 174 |
| probar-hu05 | 0 | 64 | 0 | 199 |
| probar-hu07 | 0 | 63 | 0 | 143 |
| probar-hu08 | 0 | 85 | 0 | 190 |
| probar-hu09 | 0 | 49 | 0 | 192 |
| probar-hu10 | 0 | 65 | 0 | 215 |
| probar-hu11 | 0 | 80 | 0 | 207 |
| probar-hu12 | 0 | 71 | 0 | 95 |
| probar-hu12-central | 0 | 70 | 0 | 142 |
| probar-hu13 | 0 | 94 | 0 | 165 |
| probar-hu14 | 0 | 57 | 0 | 167 |
| probar-hu15 | 0 | 19 | 0 | 143 |
| probar-hu15-http | 0 | 28 | 0 | 142 |
| probar-hu16 | 0 | 56 | 0 | 210 |
| probar-hu17 | 0 | 65 | 0 | 717 |
| hu06-pruebas-offline | 0 | 0 | 0 | 11 |
| probar-login | 0 | 0 | 0 | 17 |
| probar-rol-aplicacion | 0 | 13 | 0 | 23 |
| probar-datos-personales | 0 | 39 | 0 | 34 |
| hu06-pruebas | 0 | 0 | 0 | 78 |
| hu06-extra | 0 | 0 | 0 | 21 |
| probar-sincronizacion | 0 | 12 | 0 | 51 |

Las pruebas con OK 0 informan con su propio formato ("49/49 pruebas OK", "Sin diferencias", etc.) y terminaron sin fallos.

## Fallo conocido de partida

`probar-hu01`: «estado=agotado cuenta todo el catálogo (más de 500)», con api=2000 y sql=2000. La API y el SQL coinciden; la prueba exige un total **mayor** que los 2000 productos que ella misma crea, es decir, que exista al menos un producto agotado previo. En esta copia de datos no hay ninguno. Es un supuesto de datos de la prueba, no un defecto del código, y sirve de referencia: después de la reducción debe fallar igual o pasar, nunca empeorar.
