-- HU-17: traslado de medicamentos entre tiendas coordinado por el central (saga con compensación). Idempotente.
-- El central es el orquestador: guarda el estado de cada traslado y manda a cada tienda su paso con un evento dirigido
-- (replica_evento con id_tienda_destino). Cada tienda ejecuta su paso en una transacción local y responde por su outbox.
--
--   SOLICITADO  --(origen descuenta)------------------>  EN_TRANSITO  --(destino ingresa)-->  COMPLETADO
--       |                                                    |
--       +--(origen no tiene stock)--> FALLIDO                +--(destino falla)--> COMPENSANDO --(origen repone)--> COMPENSADO

ALTER TABLE traslado ADD COLUMN IF NOT EXISTS motivo varchar(300);
ALTER TABLE traslado ADD COLUMN IF NOT EXISTS actualizado_en timestamp without time zone;
ALTER TABLE traslado ADD COLUMN IF NOT EXISTS idempotency_key uuid;

-- Lotes que salieron de la tienda origen (número, caducidad, proveedor y cantidad): la tienda destino los ingresa iguales.
ALTER TABLE detalle_traslado ADD COLUMN IF NOT EXISTS lotes jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'traslado_estado_check' AND conrelid = 'traslado'::regclass AND pg_get_constraintdef(oid) LIKE '%COMPENSANDO%'
    ) THEN
        ALTER TABLE traslado DROP CONSTRAINT IF EXISTS traslado_estado_check;
        ALTER TABLE traslado ADD CONSTRAINT traslado_estado_check
            CHECK (estado IN ('SOLICITADO', 'EN_TRANSITO', 'COMPLETADO', 'COMPENSANDO', 'COMPENSADO', 'FALLIDO'));
    END IF;
END $$;

-- Las claves de la tabla base (FK a tienda, empleado y medicamento) ya existen en 00_base.sql.
CREATE INDEX IF NOT EXISTS idx_traslado_origen_estado ON traslado (id_tienda_origen, estado);
CREATE INDEX IF NOT EXISTS idx_traslado_destino ON traslado (id_tienda_destino, fecha_solicitud);
CREATE UNIQUE INDEX IF NOT EXISTS ux_traslado_idempotency ON traslado (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Transiciones permitidas de la saga. Un evento repetido o fuera de orden no puede retroceder ni saltarse un paso.
CREATE OR REPLACE FUNCTION traslado_transicion() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.estado = OLD.estado THEN
        RETURN NEW;
    END IF;
    IF (OLD.estado = 'SOLICITADO' AND NEW.estado IN ('EN_TRANSITO', 'FALLIDO'))
       OR (OLD.estado = 'EN_TRANSITO' AND NEW.estado IN ('COMPLETADO', 'COMPENSANDO'))
       OR (OLD.estado = 'COMPENSANDO' AND NEW.estado = 'COMPENSADO') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'TRASLADO_TRANSICION: % -> % no permitida en el traslado %', OLD.estado, NEW.estado, OLD.id_traslado USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER traslado_transicion_trg
    BEFORE UPDATE OF estado ON traslado
    FOR EACH ROW EXECUTE FUNCTION traslado_transicion();
