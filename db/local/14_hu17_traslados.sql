-- HU-17: el paso de cada tienda en un traslado entre tiendas. Idempotente.
-- traslado_local (script base) guarda el traslado visto desde esta tienda: rol ORIGEN o DESTINO, su estado local y el estado
-- de red que le comunica el central, para que las dos tiendas expliquen el mismo resultado.

-- Estados locales:
--   ORIGEN:  DESCONTADO (salió el stock) | RECHAZADO (no había stock: no se tocó nada) | COMPENSADO (se repuso)
--   DESTINO: PENDIENTE (solicitado, en camino) | RECIBIDO (ingresó) | FALLIDO (no pudo ingresar: el origen repone)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'traslado_local_estado_local_check' AND conrelid = 'traslado_local'::regclass
          AND pg_get_constraintdef(oid) LIKE '%RECHAZADO%'
    ) THEN
        ALTER TABLE traslado_local DROP CONSTRAINT IF EXISTS traslado_local_estado_local_check;
        ALTER TABLE traslado_local ADD CONSTRAINT traslado_local_estado_local_check
            CHECK (estado_local IN ('PENDIENTE', 'DESCONTADO', 'RECIBIDO', 'COMPENSADO', 'RECHAZADO', 'FALLIDO'));
    END IF;
END $$;

ALTER TABLE traslado_local ADD COLUMN IF NOT EXISTS estado_red varchar(20);
ALTER TABLE traslado_local ADD COLUMN IF NOT EXISTS motivo varchar(300);
ALTER TABLE traslado_local ADD COLUMN IF NOT EXISTS solicitante varchar(150);
ALTER TABLE traslado_local ADD COLUMN IF NOT EXISTS actualizado_en timestamp without time zone;

-- El descuento en la tienda origen y la compensación los hace el sistema al recibir la orden del central, no una persona de
-- esa tienda (quien solicitó es de otra tienda y no está en empleado_ref). El movimiento admite un responsable nulo, igual que
-- la auditoría local (HU-04); quién lo pidió queda en las observaciones y en traslado_local.solicitante.
ALTER TABLE movimiento_inventario
    ALTER COLUMN id_empleado DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_traslado_local_fecha ON traslado_local (fecha_hora);
