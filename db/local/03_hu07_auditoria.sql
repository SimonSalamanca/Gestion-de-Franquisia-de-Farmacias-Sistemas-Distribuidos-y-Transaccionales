-- HU-07: auditoría local no editable y cursor de subida al central. Idempotente.

-- Bitácora no editable (RNF-10): nada se actualiza; solo se borra lo que ya cumplió 2 años de retención.
CREATE OR REPLACE FUNCTION auditoria_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.fecha_hora < now()::timestamp - interval '2 years' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'La auditoría no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE TRIGGER registro_actividad_inmutable
    BEFORE UPDATE OR DELETE ON registro_actividad
    FOR EACH ROW EXECUTE FUNCTION auditoria_inmutable();
CREATE OR REPLACE TRIGGER registro_actividad_sin_truncate
    BEFORE TRUNCATE ON registro_actividad
    FOR EACH STATEMENT EXECUTE FUNCTION auditoria_inmutable();

CREATE INDEX IF NOT EXISTS idx_registro_actividad_fecha ON registro_actividad (fecha_hora);

-- Hasta qué id_registro ya subió la auditoría de esta tienda al central: columnas del cursor de la tienda (cursor_sync,
-- 01_hu06). Antes era la tabla auditoria_cursor, que 16_reduccion_tablas.sql fusiona.
ALTER TABLE cursor_sync
    ADD COLUMN IF NOT EXISTS ultimo_registro_enviado integer NOT NULL DEFAULT 0;
ALTER TABLE cursor_sync
    ADD COLUMN IF NOT EXISTS auditoria_enviada_en timestamp with time zone;
