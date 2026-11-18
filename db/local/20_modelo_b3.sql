-- Modelo de datos del nodo local, fase B3 (docs/modelo-datos/relaciones.md). Idempotente: cada fusión corre una sola vez,
-- en la transacción del script, y verifica que no se pierda nada antes de eliminar lo viejo.

-- 1. Réplica de los medicamentos que surte cada proveedor (medicamento_proveedor del central, por PROVEEDOR_UPSERT).
--    Al pedir desde una alerta se sugiere un proveedor que surte el medicamento (HU-13, criterio 2).
CREATE TABLE IF NOT EXISTS medicamento_proveedor_ref (
    id_proveedor integer NOT NULL REFERENCES proveedor_ref (id_proveedor),
    id_medicamento integer NOT NULL REFERENCES medicamento_ref (id_medicamento),
    CONSTRAINT medicamento_proveedor_ref_pkey PRIMARY KEY (id_proveedor, id_medicamento)
);
CREATE INDEX IF NOT EXISTS idx_medicamento_proveedor_ref_medicamento ON medicamento_proveedor_ref (id_medicamento);

-- 2. Traslado sin tabla de detalle: el traslado lleva un solo medicamento. Los lotes que salieron o entraron ya están en
--    movimiento_inventario (con su traslado); detalle_traslado_local.id_lote nunca se usó.
ALTER TABLE traslado_local ADD COLUMN IF NOT EXISTS id_medicamento integer;
ALTER TABLE traslado_local ADD COLUMN IF NOT EXISTS cantidad integer;

DO $$
DECLARE
    v_varios bigint;
    v_detalles bigint;
    v_movidos bigint;
BEGIN
    IF to_regclass('detalle_traslado_local') IS NOT NULL THEN
        SELECT count(*) INTO v_varios FROM (SELECT 1 FROM detalle_traslado_local GROUP BY id_traslado, rol_tienda HAVING count(*) > 1) x;
        IF v_varios > 0 THEN
            RAISE EXCEPTION 'TRASLADO: % traslado(s) locales tienen más de un medicamento; no se pueden fusionar', v_varios;
        END IF;
        UPDATE traslado_local t SET id_medicamento = d.id_medicamento, cantidad = d.cantidad
          FROM detalle_traslado_local d
         WHERE d.id_traslado = t.id_traslado AND d.rol_tienda = t.rol_tienda AND t.id_medicamento IS NULL;
        SELECT count(*) INTO v_detalles FROM detalle_traslado_local;
        SELECT count(*) INTO v_movidos FROM detalle_traslado_local d
          JOIN traslado_local t ON t.id_traslado = d.id_traslado AND t.rol_tienda = d.rol_tienda
         WHERE t.id_medicamento = d.id_medicamento AND t.cantidad = d.cantidad;
        IF v_movidos <> v_detalles THEN
            RAISE EXCEPTION 'TRASLADO: % de % líneas locales no pasaron al traslado', v_detalles - v_movidos, v_detalles;
        END IF;
        IF EXISTS (SELECT 1 FROM traslado_local WHERE id_medicamento IS NULL) THEN
            RAISE EXCEPTION 'TRASLADO: hay traslados locales sin medicamento';
        END IF;
        DROP TABLE detalle_traslado_local;
    END IF;
    ALTER TABLE traslado_local ALTER COLUMN id_medicamento SET NOT NULL;
    ALTER TABLE traslado_local ALTER COLUMN cantidad SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'traslado_local_cantidad_check' AND conrelid = 'traslado_local'::regclass) THEN
        ALTER TABLE traslado_local ADD CONSTRAINT traslado_local_cantidad_check CHECK (cantidad > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'traslado_local_id_medicamento_fkey' AND conrelid = 'traslado_local'::regclass) THEN
        ALTER TABLE traslado_local ADD CONSTRAINT traslado_local_id_medicamento_fkey FOREIGN KEY (id_medicamento) REFERENCES medicamento_ref (id_medicamento);
    END IF;
END $$;

-- 3. La línea de recepción toma el medicamento y el proveedor de su lote (sin dato repetido que pueda contradecirse).
DO $$
DECLARE
    v_distintos bigint;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
               AND table_name = 'detalle_recepcion' AND column_name = 'id_medicamento') THEN
        EXECUTE 'SELECT count(*) FROM detalle_recepcion d JOIN lote l ON l.id_lote = d.id_lote
                  WHERE d.id_medicamento <> l.id_medicamento OR d.id_proveedor <> l.id_proveedor' INTO v_distintos;
        IF v_distintos > 0 THEN
            RAISE EXCEPTION 'RECEPCION: % línea(s) no coinciden con el medicamento o el proveedor de su lote', v_distintos;
        END IF;
    END IF;
END $$;
ALTER TABLE detalle_recepcion DROP COLUMN IF EXISTS id_medicamento;
ALTER TABLE detalle_recepcion DROP COLUMN IF EXISTS id_proveedor;
