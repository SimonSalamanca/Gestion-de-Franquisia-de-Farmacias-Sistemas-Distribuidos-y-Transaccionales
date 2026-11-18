-- Modelo de datos del nodo central, fase B3 (docs/modelo-datos/relaciones.md). Idempotente: cada fusión corre una sola
-- vez, en la transacción del script, y verifica que no se pierda nada antes de eliminar lo viejo.

-- 1. Medicamentos que surte cada proveedor (M:N). Lo gestiona el administrador en la pantalla de proveedores; viaja a las
--    tiendas con PROVEEDOR_UPSERT (medicamento_proveedor_ref) y allí sugiere el proveedor al pedir desde una alerta (HU-13).
CREATE TABLE IF NOT EXISTS medicamento_proveedor (
    id_proveedor integer NOT NULL REFERENCES proveedor (id_proveedor),
    id_medicamento integer NOT NULL REFERENCES medicamento (id_medicamento),
    CONSTRAINT medicamento_proveedor_pkey PRIMARY KEY (id_proveedor, id_medicamento)
);
CREATE INDEX IF NOT EXISTS idx_medicamento_proveedor_medicamento ON medicamento_proveedor (id_medicamento);

-- 2. Traslado sin tabla de detalle. Un traslado mueve un solo medicamento (HU-17 y RF-26; la API inserta una sola línea),
--    así que detalle_traslado era una relación 1:1 disfrazada de 1:N. El traslado guarda el medicamento, la cantidad y los
--    lotes que envió el origen (la guía con la que el destino crea sus lotes: el central no tiene tabla de lotes).
ALTER TABLE traslado ADD COLUMN IF NOT EXISTS id_medicamento integer;
ALTER TABLE traslado ADD COLUMN IF NOT EXISTS cantidad integer;
ALTER TABLE traslado ADD COLUMN IF NOT EXISTS lotes_enviados jsonb;

DO $$
DECLARE
    v_varios bigint;
    v_detalles bigint;
    v_movidos bigint;
BEGIN
    IF to_regclass('detalle_traslado') IS NOT NULL THEN
        -- En una base nueva la columna lotes no existe (la agregaba 14_hu17_traslados.sql).
        ALTER TABLE detalle_traslado ADD COLUMN IF NOT EXISTS lotes jsonb;
        SELECT count(*) INTO v_varios FROM (SELECT 1 FROM detalle_traslado GROUP BY id_traslado HAVING count(*) > 1) x;
        IF v_varios > 0 THEN
            RAISE EXCEPTION 'TRASLADO: % traslado(s) tienen más de un medicamento; no se pueden fusionar', v_varios;
        END IF;
        UPDATE traslado t SET id_medicamento = d.id_medicamento, cantidad = d.cantidad, lotes_enviados = d.lotes
          FROM detalle_traslado d WHERE d.id_traslado = t.id_traslado AND t.id_medicamento IS NULL;
        SELECT count(*) INTO v_detalles FROM detalle_traslado;
        SELECT count(*) INTO v_movidos FROM detalle_traslado d JOIN traslado t ON t.id_traslado = d.id_traslado
         WHERE t.id_medicamento = d.id_medicamento AND t.cantidad = d.cantidad AND t.lotes_enviados IS NOT DISTINCT FROM d.lotes;
        IF v_movidos <> v_detalles THEN
            RAISE EXCEPTION 'TRASLADO: % de % líneas no pasaron al traslado', v_detalles - v_movidos, v_detalles;
        END IF;
        IF EXISTS (SELECT 1 FROM traslado WHERE id_medicamento IS NULL) THEN
            RAISE EXCEPTION 'TRASLADO: hay traslados sin medicamento';
        END IF;
        DROP TABLE detalle_traslado;
    END IF;
    ALTER TABLE traslado ALTER COLUMN id_medicamento SET NOT NULL;
    ALTER TABLE traslado ALTER COLUMN cantidad SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'traslado_cantidad_check' AND conrelid = 'traslado'::regclass) THEN
        ALTER TABLE traslado ADD CONSTRAINT traslado_cantidad_check CHECK (cantidad > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'traslado_id_medicamento_fkey' AND conrelid = 'traslado'::regclass) THEN
        ALTER TABLE traslado ADD CONSTRAINT traslado_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES medicamento (id_medicamento);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_traslado_origen_medicamento ON traslado (id_tienda_origen, id_medicamento) WHERE estado = 'SOLICITADO';
