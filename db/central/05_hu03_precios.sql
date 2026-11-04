-- HU-03: precios de red con historial de vigencia. Idempotente.
-- precio_medicamento ya existe en el script base (precio, inicio, fin, quién lo registró). Es un precio único
-- para toda la red (decisión de HU-03): no lleva tienda.

-- Un medicamento no puede tener dos precios que empiecen en el mismo instante.
CREATE UNIQUE INDEX IF NOT EXISTS uq_precio_medicamento_inicio
    ON precio_medicamento (id_medicamento, fecha_inicio_vigencia);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precio_medicamento_vigencia_check') THEN
        ALTER TABLE precio_medicamento
            ADD CONSTRAINT precio_medicamento_vigencia_check
            CHECK (fecha_fin_vigencia IS NULL OR fecha_fin_vigencia > fecha_inicio_vigencia);
    END IF;
END $$;

-- Historial inmutable: un precio que ya empezó a regir no se borra ni se cambia. Lo único que se le puede
-- ajustar es su fin, y solo hacia el futuro (cuando se programa el siguiente). Un precio que aún no rige sí
-- se puede corregir: nunca se cobró. fecha_* es timestamp sin zona en UTC (Neon corre en GMT).
CREATE OR REPLACE FUNCTION precio_historial_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.fecha_inicio_vigencia > now()::timestamp THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        IF NEW.fecha_inicio_vigencia < now()::timestamp THEN
            RAISE EXCEPTION 'Un precio no puede empezar en el pasado' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.id_medicamento = OLD.id_medicamento
       AND NEW.precio = OLD.precio
       AND NEW.fecha_inicio_vigencia = OLD.fecha_inicio_vigencia
       AND NEW.id_empleado_registro IS NOT DISTINCT FROM OLD.id_empleado_registro
       AND (NEW.fecha_fin_vigencia IS NULL OR NEW.fecha_fin_vigencia >= now()::timestamp)
       AND (OLD.fecha_fin_vigencia IS NULL OR OLD.fecha_fin_vigencia >= now()::timestamp) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'El historial de precios no se puede modificar (precio % ya rigió)', OLD.id_precio
        USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE TRIGGER precio_medicamento_historial
    BEFORE UPDATE OR DELETE ON precio_medicamento
    FOR EACH ROW EXECUTE FUNCTION precio_historial_inmutable();
