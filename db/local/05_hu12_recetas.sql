-- HU-12: receta médica obligatoria para los medicamentos que la requieren. Idempotente. Solo nodo local:
-- la receta y los datos del paciente nunca salen de la tienda (RNF-02); al central solo sube la auditoría.

-- Quién registró la receta (trazabilidad) y cuánto de lo autorizado ya se dispensó (una receta no se reutiliza).
ALTER TABLE receta
    ADD COLUMN IF NOT EXISTS id_empleado_registro integer REFERENCES empleado_ref (id_empleado);

ALTER TABLE receta_medicamento
    ADD COLUMN IF NOT EXISTS cantidad_dispensada integer NOT NULL DEFAULT 0
        CONSTRAINT receta_medicamento_dispensada_check CHECK (cantidad_dispensada >= 0 AND cantidad_dispensada <= cantidad_autorizada);

-- Un paciente por documento: registrar dos recetas del mismo paciente reutiliza su fila (los reintentos no duplican).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_documento ON cliente (documento_identidad) WHERE documento_identidad IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receta_cliente ON receta (id_cliente);
CREATE INDEX IF NOT EXISTS idx_detalle_factura_receta ON detalle_factura (id_receta) WHERE id_receta IS NOT NULL;

-- Días que una receta sirve desde su fecha de emisión. Es un dato, no código: se ajusta con un UPDATE.
CREATE TABLE IF NOT EXISTS politica_receta (
    id integer PRIMARY KEY,
    dias_vigencia integer NOT NULL,
    CONSTRAINT politica_receta_id_check CHECK (id = 1),
    CONSTRAINT politica_receta_dias_check CHECK (dias_vigencia > 0)
);

INSERT INTO politica_receta (id, dias_vigencia)
VALUES (1, 30)
ON CONFLICT (id) DO NOTHING;

-- Una receta sirve si ya fue emitida y no pasó su vigencia. La fecha de hoy la decide la base, no el reloj del API.
CREATE OR REPLACE FUNCTION receta_vigente(p_fecha_emision date)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT p_fecha_emision <= current_date
       AND current_date - p_fecha_emision <= (SELECT dias_vigencia FROM politica_receta WHERE id = 1);
$$;

-- Los datos de la receta son parte del historial de auditoría: no se editan ni se borran. Lo único que cambia
-- es cuánto se ha dispensado (sube con la venta; la devolución, HU-10, lo restituye).
CREATE OR REPLACE FUNCTION receta_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'receta_medicamento' AND TG_OP = 'UPDATE' THEN
        IF NEW.id_receta = OLD.id_receta
           AND NEW.id_medicamento = OLD.id_medicamento
           AND NEW.cantidad_autorizada = OLD.cantidad_autorizada THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Una receta registrada no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE TRIGGER receta_registrada_inmutable
    BEFORE UPDATE OR DELETE ON receta
    FOR EACH ROW EXECUTE FUNCTION receta_inmutable();
CREATE OR REPLACE TRIGGER receta_medicamento_registrada_inmutable
    BEFORE UPDATE OR DELETE ON receta_medicamento
    FOR EACH ROW EXECUTE FUNCTION receta_inmutable();

-- Garantía en la base (criterios 1, 2, 3 y 5): ninguna línea de factura de un medicamento que requiere receta
-- se emite sin una receta válida, aunque falle la validación del API. La línea descuenta de la receta en la
-- misma transacción: dos ventas simultáneas no pueden gastar el mismo saldo (el bloqueo de la fila las
-- serializa) y, si la venta se revierte, la receta recupera lo que se había descontado.
-- Un medicamento sin receta obligatoria pasa sin pedir nada. Códigos de error: 23514 con prefijo RECETA_*.
CREATE OR REPLACE FUNCTION detalle_factura_exige_receta() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_med integer;
    v_nombre text;
    v_requiere boolean;
    v_cliente_factura integer;
    v_receta record;
BEGIN
    SELECT m.id_medicamento, m.nombre_comercial, m.requiere_receta
      INTO v_med, v_nombre, v_requiere
      FROM lote l
      JOIN medicamento_ref m ON m.id_medicamento = l.id_medicamento
     WHERE l.id_lote = NEW.id_lote;
    IF NOT FOUND OR NOT v_requiere THEN
        RETURN NEW;
    END IF;

    IF NEW.id_receta IS NULL THEN
        RAISE EXCEPTION 'RECETA_REQUERIDA: % requiere receta médica', v_nombre USING ERRCODE = '23514';
    END IF;

    SELECT r.fecha_emision, r.id_cliente, rm.cantidad_autorizada, rm.cantidad_dispensada
      INTO v_receta
      FROM receta r
      JOIN receta_medicamento rm ON rm.id_receta = r.id_receta AND rm.id_medicamento = v_med
     WHERE r.id_receta = NEW.id_receta
       FOR UPDATE OF rm;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RECETA_INVALIDA: la receta % no incluye %', NEW.id_receta, v_nombre USING ERRCODE = '23514';
    END IF;
    IF NOT receta_vigente(v_receta.fecha_emision) THEN
        RAISE EXCEPTION 'RECETA_VENCIDA: la receta % no está vigente', NEW.id_receta USING ERRCODE = '23514';
    END IF;

    SELECT id_cliente INTO v_cliente_factura FROM factura WHERE id_factura = NEW.id_factura;
    IF v_cliente_factura IS DISTINCT FROM v_receta.id_cliente THEN
        RAISE EXCEPTION 'RECETA_CLIENTE: la receta % es de otro paciente', NEW.id_receta USING ERRCODE = '23514';
    END IF;

    IF v_receta.cantidad_dispensada + NEW.cantidad > v_receta.cantidad_autorizada THEN
        RAISE EXCEPTION 'RECETA_SALDO: la receta % autoriza % de % y ya se dispensaron %',
            NEW.id_receta, v_receta.cantidad_autorizada, v_nombre, v_receta.cantidad_dispensada USING ERRCODE = '23514';
    END IF;

    UPDATE receta_medicamento
       SET cantidad_dispensada = cantidad_dispensada + NEW.cantidad
     WHERE id_receta = NEW.id_receta AND id_medicamento = v_med;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER detalle_factura_receta
    BEFORE INSERT ON detalle_factura
    FOR EACH ROW EXECUTE FUNCTION detalle_factura_exige_receta();
