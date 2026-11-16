# Demostración de conectividad

Panel para demostrar el comportamiento distribuido de una tienda: operación sin el nodo central, corte automático de la
comunicación y puesta al día de la cola (outbox) cuando el central vuelve.

## Quién y dónde

- Solo **administradores** (administrador de tienda y administrador general: el permiso `AUDITORIA_CONSULTAR`, el mismo
  criterio que el acceso a datos personales). El cajero no lo ve y el API le responde 403.
- Solo si el servidor tiene `FARMAHUB_SIMULACION` habilitado (por defecto en desarrollo). En el despliegue (`render.yaml`)
  está apagado: el panel no aparece y el API responde 404.
- Menú **Herramientas → Conectividad**. Ya no hay botones de simulación en el login ni en la barra superior.
- API: `GET/POST /api/local/simulacion` o `/api/central/simulacion` (`{ "escenario": "caido" | "lento" | "intermitente" }`
  o `{ "restablecer": true }`). Reemplaza al antiguo `POST /api/conectividad/simular`, que no pedía sesión.

## Escenarios

| Escenario | Qué hace | Duración | Demuestra |
|---|---|---|---|
| Central caído | Cada chequeo al central falla: la tienda queda **Sin conexión** | 30 min o hasta restablecer | Ventas, inventario local, alertas, anulaciones y cierre siguen; lo que depende del central responde 503; la cola crece |
| Conexión lenta | Cada chequeo tarda más de 3 s: **Conexión lenta** (degradado) | 10 min o hasta restablecer | Todo funciona y sincroniza; no se confunde con una caída |
| Fallos intermitentes | Cinco fallos seguidos y luego chequeos reales | ≈ 30 s | El corte automático (30 s) y la recuperación sola |

La simulación reemplaza el **resultado del chequeo** (`probeCentral` en `apps/api/sync.mjs`), así el estado cambia por el mismo
camino que una falla real. No modifica `forzado`, que según HU-06 es un campo aparte que no pisa el estado real.

**Restablecer normalidad** quita la simulación y vuelve a consultar el central de verdad; la cola se envía en el siguiente ciclo
(unos 10 s).

## Lo que ven los demás

Mientras hay una simulación, todos los usuarios de la tienda ven el aviso «Demostración en curso», quién la inició y cuándo
termina, y el estado aparece como «(simulado)», también en el login. Así nadie la confunde con una falla real.

Cada inicio y cada restablecimiento queda en la auditoría de la tienda como `SIMULACION_CONECTIVIDAD`.

## Demostración en 1 minuto

1. Iniciar «Central caído».
2. Registrar una venta: se factura sin el central.
3. En el panel, «Cambios en cola» sube.
4. «Restablecer normalidad»: la cola baja a 0 y la venta llega a la vista de red.
