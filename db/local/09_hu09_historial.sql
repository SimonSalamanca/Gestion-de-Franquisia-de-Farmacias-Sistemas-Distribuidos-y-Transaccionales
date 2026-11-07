-- HU-09: historial de compras y reimpresión de facturas. Idempotente. Solo índices: no cambia datos ni facturas.
-- Todo se consulta en la base de la tienda, así que funciona igual sin conexión con el central.

-- Orden del historial (más reciente primero) y paginación por cursor (fecha_hora, id_factura): cada página cuesta lo
-- mismo con 100 facturas o con millones, a diferencia de OFFSET.
CREATE INDEX IF NOT EXISTS idx_factura_fecha_id ON factura (fecha_hora DESC, id_factura DESC);

-- Historial de un cliente ya ordenado.
CREATE INDEX IF NOT EXISTS idx_factura_cliente_fecha ON factura (id_cliente, fecha_hora DESC, id_factura DESC);

-- Búsqueda por número de factura por prefijo ("T1-0004"): la restricción única no sirve para LIKE 'x%'.
CREATE INDEX IF NOT EXISTS idx_factura_numero_prefijo ON factura (numero_factura varchar_pattern_ops);

-- Búsqueda de cliente por parte del nombre. pg_trgm acelera LIKE '%texto%'; si la extensión no se puede crear,
-- la búsqueda sigue funcionando (más lenta) con el índice normal.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS idx_cliente_nombre_trgm ON cliente USING gin (lower(nombre) gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm no disponible: la búsqueda de clientes por nombre usará un recorrido normal (%)', SQLERRM;
END $$;

-- Líneas y pagos de una factura se leen siempre por id_factura.
CREATE INDEX IF NOT EXISTS idx_detalle_factura_factura ON detalle_factura (id_factura);
CREATE INDEX IF NOT EXISTS idx_factura_metodo_pago_factura ON factura_metodo_pago (id_factura);
