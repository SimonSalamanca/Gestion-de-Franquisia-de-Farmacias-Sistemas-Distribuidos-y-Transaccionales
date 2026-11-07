-- HU-10: anulación total y devolución parcial de facturas. Idempotente.
-- Cada operación genera una nota (NC-T{tienda}-{consecutivo}) inmutable con su motivo, las líneas devueltas, el valor
-- reintegrado repartido por método de pago y un movimiento DEVOLUCION por lote. Las garantías viven en la base: no se
-- puede anular dos veces, devolver más de lo vendido ni dejar una nota sin su inventario y sus importes coherentes.

-- Una sentencia por columna: db-verificar lee un ADD COLUMN por ALTER.
ALTER TABLE anulacion_devolucion ADD COLUMN IF NOT EXISTS numero_nota varchar(30);
ALTER TABLE anulacion_devolucion ADD COLUMN IF NOT EXISTS subtotal_devuelto numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE anulacion_devolucion ADD COLUMN IF NOT EXISTS impuestos_devueltos numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE anulacion_devolucion ADD COLUMN IF NOT EXISTS total_devuelto numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE detalle_devolucion ADD COLUMN IF NOT EXISTS subtotal_devuelto numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE detalle_devolucion ADD COLUMN IF NOT EXISTS impuesto_devuelto numeric(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anulacion_devolucion_motivo_check') THEN
        ALTER TABLE anulacion_devolucion
            ADD CONSTRAINT anulacion_devolucion_motivo_check CHECK (char_length(btrim(motivo)) >= 5) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'anulacion_devolucion_total_check') THEN
        ALTER TABLE anulacion_devolucion
            ADD CONSTRAINT anulacion_devolucion_total_check
            CHECK (total_devuelto = subtotal_devuelto + impuestos_devueltos AND total_devuelto >= 0) NOT VALID;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_anulacion_numero_nota ON anulacion_devolucion (numero_nota) WHERE numero_nota IS NOT NULL;
-- Una factura solo se anula una vez.
CREATE UNIQUE INDEX IF NOT EXISTS ux_anulacion_total_por_factura ON anulacion_devolucion (id_factura) WHERE tipo = 'ANULACION_TOTAL';
CREATE INDEX IF NOT EXISTS idx_anulacion_factura ON anulacion_devolucion (id_factura);
CREATE INDEX IF NOT EXISTS idx_anulacion_fecha ON anulacion_devolucion (fecha_hora);

-- Valor reintegrado por método de pago (el cliente pagó con uno o varios).
CREATE TABLE IF NOT EXISTS devolucion_pago (
    id_anulacion integer NOT NULL REFERENCES anulacion_devolucion (id_anulacion),
    id_metodo_pago integer NOT NULL,
    monto numeric(14,2) NOT NULL CHECK (monto > 0),
    PRIMARY KEY (id_anulacion, id_metodo_pago)
);

-- Consecutivo de notas sin saltos (mismo mecanismo que las facturas: sube dentro de la transacción).
CREATE TABLE IF NOT EXISTS secuencia_nota (
    id integer PRIMARY KEY,
    ultimo bigint NOT NULL DEFAULT 0,
    CONSTRAINT secuencia_nota_id_check CHECK (id = 1)
);
INSERT INTO secuencia_nota (id, ultimo) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION siguiente_numero_nota(p_tienda integer)
RETURNS text
LANGUAGE sql
AS $$
    UPDATE secuencia_nota
       SET ultimo = ultimo + 1
     WHERE id = 1
    RETURNING 'NC-T' || p_tienda::text || '-' || lpad(ultimo::text, 6, '0');
$$;

-- Las notas son permanentes: no se editan ni se borran.
CREATE OR REPLACE FUNCTION nota_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Una anulación o devolución registrada no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS anulacion_inmutable ON anulacion_devolucion;
CREATE TRIGGER anulacion_inmutable BEFORE UPDATE OR DELETE ON anulacion_devolucion
    FOR EACH ROW EXECUTE FUNCTION nota_inmutable();
DROP TRIGGER IF EXISTS detalle_devolucion_inmutable ON detalle_devolucion;
CREATE TRIGGER detalle_devolucion_inmutable BEFORE UPDATE OR DELETE ON detalle_devolucion
    FOR EACH ROW EXECUTE FUNCTION nota_inmutable();
DROP TRIGGER IF EXISTS devolucion_pago_inmutable ON devolucion_pago;
CREATE TRIGGER devolucion_pago_inmutable BEFORE UPDATE OR DELETE ON devolucion_pago
    FOR EACH ROW EXECUTE FUNCTION nota_inmutable();

-- Una factura anulada no vuelve a emitida.
CREATE OR REPLACE FUNCTION factura_estado_no_retrocede() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.estado = 'ANULADA' AND NEW.estado <> 'ANULADA' THEN
        RAISE EXCEPTION 'FACTURA_ANULADA: la factura % ya fue anulada', OLD.numero_factura USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS factura_estado_no_retrocede ON factura;
CREATE TRIGGER factura_estado_no_retrocede BEFORE UPDATE ON factura
    FOR EACH ROW EXECUTE FUNCTION factura_estado_no_retrocede();

-- Al registrar la nota: bloquea la factura (serializa operaciones simultáneas sobre ella) y rechaza una segunda
-- anulación o una anulación total con devoluciones previas.
CREATE OR REPLACE FUNCTION anulacion_valida() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_estado text;
BEGIN
    SELECT estado INTO v_estado FROM factura WHERE id_factura = NEW.id_factura FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'La factura % no existe', NEW.id_factura USING ERRCODE = '23503';
    END IF;
    IF v_estado = 'ANULADA' THEN
        RAISE EXCEPTION 'FACTURA_ANULADA: la factura ya fue anulada' USING ERRCODE = '23514';
    END IF;
    IF NEW.tipo = 'ANULACION_TOTAL' AND EXISTS (SELECT 1 FROM anulacion_devolucion WHERE id_factura = NEW.id_factura) THEN
        RAISE EXCEPTION 'FACTURA_CON_DEVOLUCIONES: la factura ya tiene devoluciones, no se puede anular completa' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS anulacion_valida ON anulacion_devolucion;
CREATE TRIGGER anulacion_valida BEFORE INSERT ON anulacion_devolucion
    FOR EACH ROW EXECUTE FUNCTION anulacion_valida();

-- Cada línea devuelta existe en la factura y, sumada a lo ya devuelto, no excede lo vendido.
CREATE OR REPLACE FUNCTION devolucion_linea_valida() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_factura integer;
    v_vendida integer;
    v_previa bigint;
BEGIN
    SELECT id_factura INTO v_factura FROM anulacion_devolucion WHERE id_anulacion = NEW.id_anulacion;
    PERFORM 1 FROM factura WHERE id_factura = v_factura FOR UPDATE;
    SELECT cantidad INTO v_vendida FROM detalle_factura WHERE id_factura = v_factura AND id_lote = NEW.id_lote;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEVOLUCION_LINEA: el lote % no pertenece a la factura', NEW.id_lote USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(SUM(dd.cantidad_devuelta), 0) INTO v_previa
      FROM detalle_devolucion dd JOIN anulacion_devolucion a ON a.id_anulacion = dd.id_anulacion
     WHERE a.id_factura = v_factura AND dd.id_lote = NEW.id_lote;
    IF v_previa + NEW.cantidad_devuelta > v_vendida THEN
        RAISE EXCEPTION 'DEVOLUCION_EXCEDE: se vendieron % y ya se devolvieron %', v_vendida, v_previa USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devolucion_linea_valida ON detalle_devolucion;
CREATE TRIGGER devolucion_linea_valida BEFORE INSERT ON detalle_devolucion
    FOR EACH ROW EXECUTE FUNCTION devolucion_linea_valida();

-- Al hacer commit: la nota está completa. Sus líneas suman sus importes, el reintegro por método de pago suma el total,
-- cada lote devuelto tiene su movimiento DEVOLUCION por la misma cantidad, y el estado de la factura es el que
-- corresponde al tipo. Si algo falta, el commit falla y no queda ni nota ni stock parcial.
CREATE OR REPLACE FUNCTION nota_integra() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_lineas integer;
    v_subtotal numeric;
    v_impuestos numeric;
    v_pagos numeric;
    v_estado text;
BEGIN
    SELECT count(*), COALESCE(sum(subtotal_devuelto), 0), COALESCE(sum(impuesto_devuelto), 0)
      INTO v_lineas, v_subtotal, v_impuestos
      FROM detalle_devolucion WHERE id_anulacion = NEW.id_anulacion;
    IF v_lineas = 0 OR v_subtotal <> NEW.subtotal_devuelto OR v_impuestos <> NEW.impuestos_devueltos THEN
        RAISE EXCEPTION 'NOTA_INCOMPLETA: las líneas de % no suman sus importes', NEW.numero_nota USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(sum(monto), 0) INTO v_pagos FROM devolucion_pago WHERE id_anulacion = NEW.id_anulacion;
    IF v_pagos <> NEW.total_devuelto THEN
        RAISE EXCEPTION 'NOTA_PAGOS: el reintegro de % (%) no suma su total (%)', NEW.numero_nota, v_pagos, NEW.total_devuelto USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM (SELECT id_lote, sum(cantidad_devuelta) AS cantidad FROM detalle_devolucion WHERE id_anulacion = NEW.id_anulacion GROUP BY id_lote) d
          FULL JOIN (
              SELECT id_lote, sum(cantidad) AS cantidad
                FROM movimiento_inventario
               WHERE tipo_movimiento = 'DEVOLUCION' AND referencia_documento = NEW.numero_nota
               GROUP BY id_lote
          ) m ON m.id_lote = d.id_lote
         WHERE d.cantidad IS DISTINCT FROM m.cantidad
    ) THEN
        RAISE EXCEPTION 'NOTA_SIN_MOVIMIENTO: el inventario de % no coincide con sus líneas', NEW.numero_nota USING ERRCODE = '23514';
    END IF;

    SELECT estado INTO v_estado FROM factura WHERE id_factura = NEW.id_factura;
    IF (NEW.tipo = 'ANULACION_TOTAL' AND v_estado <> 'ANULADA') OR (NEW.tipo = 'DEVOLUCION_PARCIAL' AND v_estado <> 'DEVOLUCION_PARCIAL') THEN
        RAISE EXCEPTION 'NOTA_ESTADO: la factura de % quedó en estado %', NEW.numero_nota, v_estado USING ERRCODE = '23514';
    END IF;
    IF NEW.tipo = 'ANULACION_TOTAL' AND EXISTS (
        SELECT 1 FROM detalle_factura f
         WHERE f.id_factura = NEW.id_factura
           AND f.cantidad IS DISTINCT FROM (SELECT sum(cantidad_devuelta) FROM detalle_devolucion d WHERE d.id_anulacion = NEW.id_anulacion AND d.id_lote = f.id_lote)
    ) THEN
        RAISE EXCEPTION 'NOTA_ANULACION: la anulación de % no cubre todas las líneas de la factura', NEW.numero_nota USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS nota_completa ON anulacion_devolucion;
CREATE CONSTRAINT TRIGGER nota_completa
    AFTER INSERT ON anulacion_devolucion
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION nota_integra();
