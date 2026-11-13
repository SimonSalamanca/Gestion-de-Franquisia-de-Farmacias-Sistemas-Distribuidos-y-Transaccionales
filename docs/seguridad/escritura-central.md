# Escritura en el nodo central: regla y verificación

## Regla

Las tiendas no leen el central: reciben un **log de eventos** (`replica_evento`). Un cambio que se hace en una tabla del
central **sin publicar su evento** no llega nunca a las tiendas, y la red queda desalineada. Por eso:

1. **En la aplicación:** todo cambio replicable se publica en la misma transacción que el cambio (`append_replica_evento`).
2. **En las pruebas y el mantenimiento:** toda escritura sobre el central pasa por `scripts/lib/central.mjs`. Ese módulo
   publica el evento de cada cambio replicado. Las únicas escrituras sin evento son los resets de estado que el central
   no replica (política de acceso, reservas de recetas, consolidado de inventario), y están en el mismo módulo, marcadas.
3. **Transacciones de prueba que terminan en `rollback`** no dejan cambios y se permiten.

## Qué comprueba cada herramienta

| Herramienta | Qué hace | Cuándo corre |
|---|---|---|
| `scripts/verificar-escrituras.mjs` | Busca escrituras directas sobre el central fuera de `scripts/lib/` y las marca. | En `npm test` |
| `scripts/verificar-eventos.mjs` | Compara el último evento de cada registro replicado con la tabla del central: medicamentos, proveedores, tiendas, personal, precios y umbrales. | En `npm test` y cuando se quiera |
| `scripts/reparar-eventos.mjs` | Publica el estado actual de los registros que el log no refleja. No cambia ninguna tabla. | Solo tras verificar, para corregir |

## Historia de este cambio

El 2026-11-12 se encontró que las pruebas habían desactivado 148 medicamentos y 32 proveedores **directamente en la tabla
del central**, sin publicar eventos. Las tiendas seguían viéndolos activos. Se corrigió con eventos (fase B) y se dejó la
guardia para que no vuelva a pasar (fases C y D).

Al verificar, aparecieron también 11 cuentas y 11 precios con la misma causa. Se corrigieron con `reparar-eventos.mjs`.

## Detalle conocido

Los precios se publican con la fecha de la aplicación (JavaScript), que tiene precisión de milisegundos; la tabla guarda
microsegundos. La comparación del verificador se hace con milisegundos. No cambia lo que ve ninguna tienda.
