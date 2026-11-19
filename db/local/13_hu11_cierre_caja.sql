-- HU-11: cierre de caja por periodo, con comparación contra lo contado, justificación de diferencias, cierre inmutable y
-- bloqueo de ventas mientras la caja está cerrada. Idempotente.
-- Todo es local: la tienda cierra y abre su caja aunque no alcance al central (RNF-04). El cierre se audita en
-- registro_actividad, que ya sube al central (HU-07).
--
-- Modelo: la tienda tiene un PERIODO de caja abierto (un número). Cada factura queda en el periodo abierto en el que se
-- emitió (factura.periodo_caja); cada nota de devolución, en el periodo abierto cuando se emitió o, si la caja está
-- cerrada, en el siguiente. Cerrar la caja totaliza ese periodo y deja la caja CERRADA: no se registran ventas hasta que
-- un administrador abre un nuevo periodo. Asignar el periodo con una columna (y no con ventanas de tiempo) evita que una
-- venta en vuelo caiga entre dos periodos o en ninguno.

-- El periodo de caja es una entidad (periodo_caja, 19_periodo_caja.sql): reemplaza a caja_control (fila única con el
-- periodo vigente) y a apertura_caja. Allí están también los disparadores que asignan el periodo a facturas y notas.

-- Periodo de cada venta y de cada nota. Lo anterior a HU-11 queda en el periodo 1 (el primero, aún sin cerrar).
ALTER TABLE factura ADD COLUMN IF NOT EXISTS periodo_caja integer NOT NULL DEFAULT 1;
ALTER TABLE anulacion_devolucion ADD COLUMN IF NOT EXISTS periodo_caja integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_factura_periodo_caja ON factura (periodo_caja);
CREATE INDEX IF NOT EXISTS idx_anulacion_periodo_caja ON anulacion_devolucion (periodo_caja);

-- El cierre. Las tablas cierre_caja y cierre_caja_metodo_pago vienen del script base; aquí se completan. Una sentencia por
-- columna (db-verificar).
ALTER TABLE cierre_caja ADD COLUMN IF NOT EXISTS periodo_caja integer;
ALTER TABLE cierre_caja ADD COLUMN IF NOT EXISTS justificacion varchar(300);

ALTER TABLE cierre_caja_metodo_pago ADD COLUMN IF NOT EXISTS vendido numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE cierre_caja_metodo_pago ADD COLUMN IF NOT EXISTS devuelto numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE cierre_caja_metodo_pago ADD COLUMN IF NOT EXISTS diferencia numeric(14,2) NOT NULL DEFAULT 0;

-- Lo vendido y lo devuelto de cada empleado por método de pago (criterio 1: por empleado que operó la caja).
CREATE TABLE IF NOT EXISTS cierre_caja_empleado (
    id_cierre integer NOT NULL REFERENCES cierre_caja (id_cierre),
    id_empleado integer NOT NULL REFERENCES empleado_ref (id_empleado),
    id_metodo_pago integer NOT NULL REFERENCES metodo_pago_ref (id_metodo_pago),
    vendido numeric(14,2) NOT NULL DEFAULT 0,
    devuelto numeric(14,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (id_cierre, id_empleado, id_metodo_pago)
);

-- Un periodo se cierra una sola vez: dos administradores que cierran a la vez no duplican el cierre.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cierre_caja_periodo ON cierre_caja (periodo_caja) WHERE periodo_caja IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cierre_caja_fecha ON cierre_caja (fecha_hora_cierre);

DO $$
BEGIN
    -- Lo calculado de cada método es lo vendido menos lo devuelto, y la diferencia es lo reportado menos lo calculado.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cierre_caja_metodo_pago_calculo_check' AND conrelid = 'cierre_caja_metodo_pago'::regclass) THEN
        ALTER TABLE cierre_caja_metodo_pago ADD CONSTRAINT cierre_caja_metodo_pago_calculo_check
            CHECK (total_calculado_sistema = vendido - devuelto AND diferencia = total_reportado_empleado - total_calculado_sistema) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cierre_caja_justificacion_check' AND conrelid = 'cierre_caja'::regclass) THEN
        ALTER TABLE cierre_caja ADD CONSTRAINT cierre_caja_justificacion_check
            CHECK (estado = 'CONCILIADO' OR char_length(btrim(coalesce(justificacion, ''))) >= 10) NOT VALID;
    END IF;
END $$;

-- Garantía en la base, al hacer commit (RNF-12, criterio 3): un cierre solo existe completo y coherente. Los métodos suman el
-- total del sistema, el estado es CON_DIFERENCIA si y solo si algún método difiere, y un cierre con diferencia lleva su
-- justificación. Si algo no cuadra, el commit falla y no queda cierre ni caja cerrada.
CREATE OR REPLACE FUNCTION cierre_caja_integro() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_calculado numeric;
    v_con_diferencia integer;
    v_incoherentes integer;
BEGIN
    SELECT coalesce(sum(total_calculado_sistema), 0),
           count(*) FILTER (WHERE diferencia <> 0),
           count(*) FILTER (WHERE total_calculado_sistema <> vendido - devuelto OR diferencia <> total_reportado_empleado - total_calculado_sistema)
      INTO v_calculado, v_con_diferencia, v_incoherentes
      FROM cierre_caja_metodo_pago
     WHERE id_cierre = NEW.id_cierre;

    IF v_incoherentes > 0 OR v_calculado <> NEW.total_sistema THEN
        RAISE EXCEPTION 'CIERRE_INCOHERENTE: los métodos de pago del cierre % no suman su total o sus diferencias no cuadran', NEW.id_cierre USING ERRCODE = '23514';
    END IF;
    IF (v_con_diferencia > 0) <> (NEW.estado = 'CON_DIFERENCIA') THEN
        RAISE EXCEPTION 'CIERRE_INCOHERENTE: el estado del cierre % no corresponde a sus diferencias', NEW.id_cierre USING ERRCODE = '23514';
    END IF;
    IF v_con_diferencia > 0 AND char_length(btrim(coalesce(NEW.justificacion, ''))) < 10 THEN
        RAISE EXCEPTION 'CIERRE_SIN_JUSTIFICACION: un cierre con diferencia necesita su justificación' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS cierre_caja_integro_trg ON cierre_caja;
CREATE CONSTRAINT TRIGGER cierre_caja_integro_trg
    AFTER INSERT ON cierre_caja
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION cierre_caja_integro();

-- Criterio 4: el cierre es inmutable, igual que la auditoría y las facturas. Ni un UPDATE ni un DELETE lo altera; un error se
-- corrige con un nuevo periodo y su justificación, nunca reescribiendo el cierre.
CREATE OR REPLACE FUNCTION caja_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Un cierre de caja registrado no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE TRIGGER cierre_caja_inmutable_trg
    BEFORE UPDATE OR DELETE ON cierre_caja
    FOR EACH ROW EXECUTE FUNCTION caja_inmutable();
CREATE OR REPLACE TRIGGER cierre_caja_metodo_pago_inmutable_trg
    BEFORE UPDATE OR DELETE ON cierre_caja_metodo_pago
    FOR EACH ROW EXECUTE FUNCTION caja_inmutable();
CREATE OR REPLACE TRIGGER cierre_caja_empleado_inmutable_trg
    BEFORE UPDATE OR DELETE ON cierre_caja_empleado
    FOR EACH ROW EXECUTE FUNCTION caja_inmutable();
