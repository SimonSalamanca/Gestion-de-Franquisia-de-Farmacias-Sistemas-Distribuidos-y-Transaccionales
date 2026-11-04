-- HU-03: réplica del historial de precios en la tienda y precio fijo en las facturas. Idempotente.

-- Copia del historial de red (precio_medicamento del central), incluidos los precios programados: así la
-- tienda aplica un precio nuevo en su instante exacto aunque esté sin conexión, y consulta el historial offline.
-- precio_vigente_ref (script base) guarda un solo precio por medicamento y no sirve para programar: no se usa.
CREATE TABLE IF NOT EXISTS precio_ref (
    id_precio integer PRIMARY KEY,
    id_medicamento integer NOT NULL REFERENCES medicamento_ref (id_medicamento),
    precio numeric(12,2) NOT NULL,
    fecha_inicio_vigencia timestamp without time zone NOT NULL,
    fecha_fin_vigencia timestamp without time zone,
    id_empleado_registro integer,
    registrado_por character varying(150),
    CONSTRAINT precio_ref_precio_check CHECK (precio >= 0)
);

CREATE INDEX IF NOT EXISTS idx_precio_ref_vigencia ON precio_ref (id_medicamento, fecha_inicio_vigencia);

-- Precio que rige para un medicamento en un instante (UTC). La venta (HU-08) la llama dentro de su
-- transacción con la hora de la factura y guarda el resultado en detalle_factura.precio_unitario_aplicado.
-- NULL si el medicamento no tiene precio en ese instante: la venta debe rechazarse.
CREATE OR REPLACE FUNCTION precio_vigente(p_medicamento integer, p_instante timestamp without time zone DEFAULT now()::timestamp)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
    SELECT precio
    FROM precio_ref
    WHERE id_medicamento = p_medicamento
      AND fecha_inicio_vigencia <= p_instante
    ORDER BY fecha_inicio_vigencia DESC
    LIMIT 1;
$$;

-- Facturas emitidas inmutables (regla 9): el precio, la cantidad, el lote y los importes de una factura no
-- cambian después de emitida, sin importar cambios de precio posteriores. El estado sí puede cambiar
-- (anulación, devolución: HU-10), y las devoluciones van en sus propias tablas.
CREATE OR REPLACE FUNCTION factura_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Condiciones anidadas: PL/pgSQL no garantiza cortocircuito y detalle_factura no tiene esos campos.
    IF TG_TABLE_NAME = 'factura' AND TG_OP = 'UPDATE' THEN
        IF NEW.numero_factura = OLD.numero_factura
           AND NEW.id_cliente IS NOT DISTINCT FROM OLD.id_cliente
           AND NEW.id_empleado = OLD.id_empleado
           AND NEW.fecha_hora = OLD.fecha_hora
           AND NEW.subtotal = OLD.subtotal
           AND NEW.impuestos = OLD.impuestos
           AND NEW.total = OLD.total THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Una factura emitida no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE TRIGGER factura_emitida_inmutable
    BEFORE UPDATE OR DELETE ON factura
    FOR EACH ROW EXECUTE FUNCTION factura_inmutable();
CREATE OR REPLACE TRIGGER detalle_factura_inmutable
    BEFORE UPDATE OR DELETE ON detalle_factura
    FOR EACH ROW EXECUTE FUNCTION factura_inmutable();
