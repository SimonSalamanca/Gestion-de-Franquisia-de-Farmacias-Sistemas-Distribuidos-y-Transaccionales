# Decisión: latencia de la venta (RNF-05)

**Estado:** aceptada. **Fecha:** 2026-11-13. **Decide:** responsable del proyecto.

## Contexto
RNF-05 pide que una venta completa se confirme en **3 s o menos**. La prueba `test:hu08` mide la mediana de cuatro ventas completas (dos líneas, pago en efectivo) contra el API de la tienda. En las corridas de desarrollo la mediana queda entre **3,2 y 3,7 s**.

## Por qué pasa
- Las bases locales y la central están en **Neon (nube, sa-east-1)** y las pruebas corren desde una PC de desarrollo: cada ida y vuelta a la base cuesta unos 130 ms (también se anota en `apps/api/recetas.mjs`).
- La venta es una sola transacción con bloqueos de lote, factura, detalle, pagos, movimientos de inventario y auditoría, y por eso hace varias idas y vueltas.
- La diferencia con la meta es de 0,2 a 0,7 s: el usuario no la percibe en el mostrador.

## Decisión
Se **acepta** el tiempo actual y no se hace más optimización por ahora.
- Superar los 3 s en `test:hu08` se muestra como **`AVISO`**, no como `FALLO`. Esto no es un error del sistema.
- La prueba conserva un **tope de regresión de 5 s** (mediana): si se supera, sí falla, porque indicaría un empeoramiento real y no la latencia de la nube.

## Cuándo reabrirla
- Si la mediana pasa de 5 s en la prueba.
- Si la tienda real corre con una base local en la misma red (se espera que baje de 3 s); conviene medir entonces y volver a fijar la meta de 3 s como criterio estricto.
- Si hay quejas de los cajeros por la espera al cobrar.
