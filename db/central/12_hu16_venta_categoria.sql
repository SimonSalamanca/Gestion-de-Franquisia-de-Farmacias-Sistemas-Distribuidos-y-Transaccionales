-- HU-16: ventas consolidadas por tienda, día y categoría, para filtrar la vista de red por categoría (criterio 4).
-- Cambio de estructura autorizado por el usuario (2026-11-09). Idempotente.
-- La alimentan VENTA_REGISTRADA (suma) y DEVOLUCION_REGISTRADA (resta) con su resumen por categoría, en la misma
-- transacción e idempotencia (inbox_sync) que venta_consolidada. Las ventas anteriores a HU-16 no traen ese resumen.
-- id_categoria = 0: medicamento sin categoría (por eso no hay clave foránea hacia categoria).

CREATE TABLE IF NOT EXISTS venta_categoria_consolidada (
    id_tienda integer NOT NULL REFERENCES tienda (id_tienda),
    fecha date NOT NULL,
    id_categoria integer NOT NULL,
    unidades integer NOT NULL DEFAULT 0,
    ingresos numeric(14,2) NOT NULL DEFAULT 0,
    fecha_sincronizacion timestamp without time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (id_tienda, fecha, id_categoria)
);

CREATE INDEX IF NOT EXISTS idx_venta_categoria_fecha ON venta_categoria_consolidada (fecha);
