-- Relaciones del modelo de datos del nodo local, fase B1 (docs/modelo-datos/relaciones.md). Acompañan cambios de código
-- (bloqueo de lotes, fila de la tienda asegurada, numeración por tienda, empleado de cada operación idempotente).
-- Idempotente: cada cambio se aplica solo si falta, y antes se comprueba que ningún dato lo incumpla.

-- 1. La operación idempotente la ejecuta un empleado (vacío = inicio de sesión que no identificó a nadie).
ALTER TABLE auth_operacion ADD COLUMN IF NOT EXISTS id_empleado integer;

-- 2. Numeración de documentos por tienda: la llave pasa de (tipo) a (id_tienda, tipo). Las filas existentes son de la
--    tienda propia (tienda_ref.es_tienda_local); las semillas sin uso (ultimo = 0) se descartan: la función crea la fila
--    con el primer documento.
ALTER TABLE secuencia_documento ADD COLUMN IF NOT EXISTS id_tienda integer;

DO $$
DECLARE
    v_propia integer;
BEGIN
    IF EXISTS (SELECT 1 FROM secuencia_documento WHERE id_tienda IS NULL) THEN
        SELECT id_tienda INTO v_propia FROM tienda_ref WHERE es_tienda_local ORDER BY id_tienda LIMIT 1;
        UPDATE secuencia_documento SET id_tienda = v_propia WHERE id_tienda IS NULL AND v_propia IS NOT NULL;
        DELETE FROM secuencia_documento WHERE id_tienda IS NULL AND ultimo = 0;
        IF EXISTS (SELECT 1 FROM secuencia_documento WHERE id_tienda IS NULL) THEN
            RAISE EXCEPTION 'RELACIONES: hay consecutivos en uso y no se sabe cuál es la tienda propia (tienda_ref.es_tienda_local)';
        END IF;
    END IF;
    ALTER TABLE secuencia_documento ALTER COLUMN id_tienda SET NOT NULL;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'secuencia_documento_pkey' AND conrelid = 'secuencia_documento'::regclass
               AND array_length(conkey, 1) = 1) THEN
        ALTER TABLE secuencia_documento DROP CONSTRAINT secuencia_documento_pkey;
        ALTER TABLE secuencia_documento ADD CONSTRAINT secuencia_documento_pkey PRIMARY KEY (id_tienda, tipo);
    END IF;
END $$;

-- Número de factura único por tienda y por red: T{tienda}-{consecutivo de 6 dígitos}. Crea la fila con el primer
-- documento; después la bloquea la venta hasta su commit (serializa los números sin saltos: si la venta se revierte,
-- el número no se consume).
CREATE OR REPLACE FUNCTION siguiente_numero_factura(p_tienda integer)
RETURNS text
LANGUAGE sql
AS $$
    INSERT INTO secuencia_documento AS s (id_tienda, tipo, ultimo) VALUES (p_tienda, 'FACTURA', 1)
    ON CONFLICT (id_tienda, tipo) DO UPDATE SET ultimo = s.ultimo + 1
    RETURNING 'T' || p_tienda::text || '-' || lpad(ultimo::text, 6, '0');
$$;

-- Consecutivo de notas (anulación o devolución): NC-T{tienda}-{consecutivo}, mismo mecanismo.
CREATE OR REPLACE FUNCTION siguiente_numero_nota(p_tienda integer)
RETURNS text
LANGUAGE sql
AS $$
    INSERT INTO secuencia_documento AS s (id_tienda, tipo, ultimo) VALUES (p_tienda, 'NOTA', 1)
    ON CONFLICT (id_tienda, tipo) DO UPDATE SET ultimo = s.ultimo + 1
    RETURNING 'NC-T' || p_tienda::text || '-' || lpad(ultimo::text, 6, '0');
$$;

-- 3. La alerta de un lote apunta al lote y a su mismo medicamento (una sola ruta, sin contradicción posible). Las alertas
--    de stock no tienen lote y solo usan el medicamento. La venta y los movimientos bloquean el lote con
--    FOR NO KEY UPDATE, compatible con el FOR KEY SHARE de esta llave (antes chocaban; ver 08_hu04_alertas.sql).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lote_id_lote_id_medicamento_key' AND conrelid = 'lote'::regclass) THEN
        ALTER TABLE lote ADD CONSTRAINT lote_id_lote_id_medicamento_key UNIQUE (id_lote, id_medicamento);
    END IF;
END $$;

-- El cursor de sincronización es solo de la tienda propia. 01_hu06.sql sembraba siempre el de la tienda 1, también en las
-- bases de otras tiendas: esa fila sobrante se elimina cuando se sabe cuál es la tienda propia.
DELETE FROM cursor_sync c
 WHERE EXISTS (SELECT 1 FROM tienda_ref t WHERE t.es_tienda_local)
   AND NOT EXISTS (SELECT 1 FROM tienda_ref t WHERE t.es_tienda_local AND t.id_tienda = c.id_tienda);

DO $$
DECLARE
    -- tabla, restricción, columnas, tabla referida, columnas referidas, consulta de huérfanos
    r record;
    v_huerfanos bigint;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('auth_operacion', 'auth_operacion_id_empleado_fkey', 'id_empleado', 'empleado_ref', 'id_empleado',
         'SELECT count(*) FROM auth_operacion x WHERE x.id_empleado IS NOT NULL AND NOT EXISTS (SELECT 1 FROM empleado_ref y WHERE y.id_empleado = x.id_empleado)'),
        ('secuencia_documento', 'secuencia_documento_id_tienda_fkey', 'id_tienda', 'tienda_ref', 'id_tienda',
         'SELECT count(*) FROM secuencia_documento x WHERE NOT EXISTS (SELECT 1 FROM tienda_ref y WHERE y.id_tienda = x.id_tienda)'),
        -- La tienda tiene un estado de sincronización (1:1). El arranque asegura la fila de la tienda antes del cursor.
        ('cursor_sync', 'cursor_sync_id_tienda_fkey', 'id_tienda', 'tienda_ref', 'id_tienda',
         'SELECT count(*) FROM cursor_sync x WHERE NOT EXISTS (SELECT 1 FROM tienda_ref y WHERE y.id_tienda = x.id_tienda)'),
        -- El empleado pertenece a una tienda. La réplica asegura la fila de la tienda antes del empleado.
        ('empleado_ref', 'empleado_ref_id_tienda_fkey', 'id_tienda', 'tienda_ref', 'id_tienda',
         'SELECT count(*) FROM empleado_ref x WHERE x.id_tienda IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tienda_ref y WHERE y.id_tienda = x.id_tienda)'),
        ('alerta', 'alerta_lote_fkey', 'id_lote, id_medicamento', 'lote', 'id_lote, id_medicamento',
         'SELECT count(*) FROM alerta x WHERE x.id_lote IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lote y WHERE y.id_lote = x.id_lote AND y.id_medicamento = x.id_medicamento)')
    ) AS t(tabla, nombre, cols, ref_tabla, ref_cols, huerfanos)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.nombre AND conrelid = r.tabla::regclass) THEN
            CONTINUE;
        END IF;
        EXECUTE r.huerfanos INTO v_huerfanos;
        IF v_huerfanos > 0 THEN
            RAISE EXCEPTION 'RELACIONES: % fila(s) de % no existen en %; corrija los datos antes de crear %',
                v_huerfanos, r.tabla, r.ref_tabla, r.nombre;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I (%s)',
                       r.tabla, r.nombre, r.cols, r.ref_tabla, r.ref_cols);
    END LOOP;
END $$;
