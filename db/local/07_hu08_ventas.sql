-- HU-08: venta atómica con factura numerada, impuestos por medicamento y pago combinado. Idempotente.

-- Impuesto (%) de cada medicamento, replicado desde el central en MEDICAMENTO_UPSERT.
ALTER TABLE medicamento_ref
    ADD COLUMN IF NOT EXISTS tasa_impuesto numeric(5,2) NOT NULL DEFAULT 0
        CONSTRAINT medicamento_ref_tasa_impuesto_check CHECK (tasa_impuesto >= 0 AND tasa_impuesto <= 100);

-- Cada línea fija la tasa y el impuesto con que se vendió (como el precio): un cambio posterior no la afecta.
ALTER TABLE detalle_factura
    ADD COLUMN IF NOT EXISTS tasa_impuesto numeric(5,2) NOT NULL DEFAULT 0;

ALTER TABLE detalle_factura
    ADD COLUMN IF NOT EXISTS impuesto_linea numeric(14,2) NOT NULL DEFAULT 0
        CONSTRAINT detalle_factura_impuesto_check CHECK (impuesto_linea >= 0);

-- Importe de la línea = cantidad x precio aplicado (RNF-12).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'detalle_factura_subtotal_check') THEN
        ALTER TABLE detalle_factura
            ADD CONSTRAINT detalle_factura_subtotal_check CHECK (subtotal_linea = cantidad * precio_unitario_aplicado);
    END IF;
END $$;

-- Consecutivo de facturas de la tienda, sin saltos: el contador sube dentro de la transacción de la venta, así que
-- si la venta se revierte el número no se consume. La fila la bloquea la venta hasta su commit (serializa los números).
CREATE TABLE IF NOT EXISTS secuencia_factura (
    id integer PRIMARY KEY,
    ultimo bigint NOT NULL DEFAULT 0,
    CONSTRAINT secuencia_factura_id_check CHECK (id = 1)
);

INSERT INTO secuencia_factura (id, ultimo)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Número de factura único por tienda y por red: T{tienda}-{consecutivo de 6 dígitos}.
CREATE OR REPLACE FUNCTION siguiente_numero_factura(p_tienda integer)
RETURNS text
LANGUAGE sql
AS $$
    UPDATE secuencia_factura
       SET ultimo = ultimo + 1
     WHERE id = 1
    RETURNING 'T' || p_tienda::text || '-' || lpad(ultimo::text, 6, '0');
$$;

-- Garantía en la base, al hacer commit (RNF-12, criterios 3 y 4): una factura solo existe completa. Sus líneas suman
-- el subtotal y el impuesto, los pagos suman el total, y cada línea tiene su movimiento de venta en inventario por la
-- misma cantidad. Si algo falta, el commit falla y no queda ni factura ni stock parcial.
CREATE OR REPLACE FUNCTION factura_integra() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_lineas integer;
    v_subtotal numeric;
    v_impuestos numeric;
    v_pagos numeric;
BEGIN
    SELECT count(*), coalesce(sum(subtotal_linea), 0), coalesce(sum(impuesto_linea), 0)
      INTO v_lineas, v_subtotal, v_impuestos
      FROM detalle_factura WHERE id_factura = NEW.id_factura;
    IF v_lineas = 0 OR v_subtotal <> NEW.subtotal OR v_impuestos <> NEW.impuestos THEN
        RAISE EXCEPTION 'FACTURA_INCOMPLETA: las líneas de % no suman su subtotal e impuestos', NEW.numero_factura USING ERRCODE = '23514';
    END IF;

    SELECT coalesce(sum(monto), 0) INTO v_pagos FROM factura_metodo_pago WHERE id_factura = NEW.id_factura;
    IF v_pagos <> NEW.total THEN
        RAISE EXCEPTION 'FACTURA_PAGOS: los pagos de % (%) no suman su total (%)', NEW.numero_factura, v_pagos, NEW.total USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM (SELECT id_lote, sum(cantidad) AS cantidad FROM detalle_factura WHERE id_factura = NEW.id_factura GROUP BY id_lote) d
          FULL JOIN (
              SELECT id_lote, sum(cantidad) AS cantidad
                FROM movimiento_inventario
               WHERE tipo_movimiento = 'VENTA' AND referencia_documento = NEW.numero_factura
               GROUP BY id_lote
          ) m ON m.id_lote = d.id_lote
         WHERE d.cantidad IS DISTINCT FROM m.cantidad
    ) THEN
        RAISE EXCEPTION 'FACTURA_SIN_MOVIMIENTO: el inventario de % no coincide con sus líneas', NEW.numero_factura USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS factura_completa ON factura;
CREATE CONSTRAINT TRIGGER factura_completa
    AFTER INSERT ON factura
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION factura_integra();
