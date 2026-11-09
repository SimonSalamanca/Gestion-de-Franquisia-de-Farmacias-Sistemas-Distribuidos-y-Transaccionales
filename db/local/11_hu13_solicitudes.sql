-- HU-13: proveedores replicados con sus datos de contacto y solicitudes de reabastecimiento (pedido). Idempotente.
-- Todo es local salvo el registro de proveedores, que es del central: la tienda lo consulta y genera solicitudes aunque
-- no alcance al central (RNF-04). Una solicitud es una fila de pedido con sus líneas en detalle_pedido.

-- Datos de contacto del proveedor, replicados con PROVEEDOR_UPSERT. Una sentencia por columna (db-verificar).
ALTER TABLE proveedor_ref ADD COLUMN IF NOT EXISTS nit varchar(40);
ALTER TABLE proveedor_ref ADD COLUMN IF NOT EXISTS telefono varchar(30);
ALTER TABLE proveedor_ref ADD COLUMN IF NOT EXISTS correo varchar(120);
ALTER TABLE proveedor_ref ADD COLUMN IF NOT EXISTS direccion varchar(200);

-- Alerta de la que nace la solicitud (sin clave foránea: igual que alerta.id_lote, para no tomar bloqueos que choquen con
-- la evaluación de alertas), fecha en que se marcó enviada y observaciones (motivo de una cancelación).
ALTER TABLE pedido ADD COLUMN IF NOT EXISTS id_alerta bigint;
ALTER TABLE pedido ADD COLUMN IF NOT EXISTS fecha_envio timestamp without time zone;
ALTER TABLE pedido ADD COLUMN IF NOT EXISTS observaciones varchar(300);

-- Estados de la solicitud: SOLICITADO (pendiente), ENVIADO, RECIBIDO_PARCIAL / RECIBIDO_TOTAL (recibida, HU-02/HU-14)
-- y CANCELADO. Solo se reescribe la restricción si todavía no conoce ENVIADO.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pedido_estado_check' AND conrelid = 'pedido'::regclass AND pg_get_constraintdef(oid) LIKE '%ENVIADO%'
    ) THEN
        ALTER TABLE pedido DROP CONSTRAINT IF EXISTS pedido_estado_check;
        ALTER TABLE pedido ADD CONSTRAINT pedido_estado_check
            CHECK (estado IN ('SOLICITADO', 'ENVIADO', 'RECIBIDO_PARCIAL', 'RECIBIDO_TOTAL', 'CANCELADO'));
    END IF;
    -- Una solicitud nace de una alerta si y solo si su origen es ALERTA_AUTOMATICA.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedido_alerta_origen_check' AND conrelid = 'pedido'::regclass) THEN
        ALTER TABLE pedido ADD CONSTRAINT pedido_alerta_origen_check
            CHECK ((origen_solicitud = 'ALERTA_AUTOMATICA') = (id_alerta IS NOT NULL)) NOT VALID;
    END IF;
END $$;

-- Una alerta tiene a lo sumo una solicitud abierta: dos administradores que pulsan "generar solicitud" a la vez no la duplican.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pedido_alerta_abierta ON pedido (id_alerta)
    WHERE id_alerta IS NOT NULL AND estado IN ('SOLICITADO', 'ENVIADO', 'RECIBIDO_PARCIAL');
CREATE INDEX IF NOT EXISTS idx_pedido_estado ON pedido (estado, fecha_solicitud);

-- Sin proveedor no hay solicitud (pedido.id_proveedor es NOT NULL con clave foránea) y el proveedor debe estar activo.
CREATE OR REPLACE FUNCTION pedido_proveedor_activo() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM proveedor_ref WHERE id_proveedor = NEW.id_proveedor AND activo) THEN
        RAISE EXCEPTION 'El proveedor % no existe o está inactivo', NEW.id_proveedor USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER pedido_proveedor_activo_trg
    BEFORE INSERT ON pedido
    FOR EACH ROW EXECUTE FUNCTION pedido_proveedor_activo();

-- Transiciones permitidas (la API valida antes, la base garantiza aunque dos usuarios actúen a la vez):
--   SOLICITADO       -> ENVIADO | CANCELADO | RECIBIDO_PARCIAL | RECIBIDO_TOTAL
--   ENVIADO          -> CANCELADO | RECIBIDO_PARCIAL | RECIBIDO_TOTAL
--   RECIBIDO_PARCIAL -> RECIBIDO_PARCIAL | RECIBIDO_TOTAL
-- RECIBIDO_TOTAL y CANCELADO son finales; una solicitud con mercancía recibida no se cancela ni retrocede.
CREATE OR REPLACE FUNCTION pedido_transicion_estado() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.estado = OLD.estado THEN
        RETURN NEW;
    END IF;
    IF (OLD.estado = 'SOLICITADO' AND NEW.estado IN ('ENVIADO', 'CANCELADO', 'RECIBIDO_PARCIAL', 'RECIBIDO_TOTAL'))
       OR (OLD.estado = 'ENVIADO' AND NEW.estado IN ('CANCELADO', 'RECIBIDO_PARCIAL', 'RECIBIDO_TOTAL'))
       OR (OLD.estado = 'RECIBIDO_PARCIAL' AND NEW.estado = 'RECIBIDO_TOTAL') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Transición de estado no permitida: % -> %', OLD.estado, NEW.estado USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE TRIGGER pedido_transicion_estado_trg
    BEFORE UPDATE OF estado ON pedido
    FOR EACH ROW EXECUTE FUNCTION pedido_transicion_estado();
