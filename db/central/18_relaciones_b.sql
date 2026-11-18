-- Relaciones del modelo de datos del nodo central, fase B1 (docs/modelo-datos/relaciones.md). Acompañan cambios de
-- código (empleado de cada operación idempotente, categoría "Sin categoría" de la vista de red).
-- Idempotente: cada cambio se aplica solo si falta, y antes se comprueba que ningún dato lo incumpla.

-- 1. La operación idempotente la ejecuta un empleado (vacío = inicio de sesión que no identificó a nadie).
ALTER TABLE auth_operacion ADD COLUMN IF NOT EXISTS id_empleado integer;

-- 2. "Sin categoría" pasa a ser una fila del catálogo (id 0). La consolidación de ventas ya agrupaba con ese número a los
--    medicamentos sin categoría, y la vista de red lo agregaba a mano a la lista; ahora la venta consolidada por categoría
--    apunta siempre a una categoría real. No se replica a las tiendas: allí un medicamento sin categoría sigue en NULL.
INSERT INTO categoria (id_categoria, nombre) VALUES (0, 'Sin categoría') ON CONFLICT DO NOTHING;

DO $$
DECLARE
    r record;
    v_huerfanos bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM categoria WHERE id_categoria = 0) THEN
        RAISE EXCEPTION 'RELACIONES: no se pudo crear la categoría 0 "Sin categoría" (¿ya existe otra con ese nombre?)';
    END IF;
    FOR r IN SELECT * FROM (VALUES
        ('auth_operacion', 'auth_operacion_id_empleado_fkey', 'id_empleado', 'empleado', 'id_empleado'),
        ('venta_categoria_consolidada', 'venta_categoria_consolidada_id_categoria_fkey', 'id_categoria', 'categoria', 'id_categoria')
    ) AS t(tabla, nombre, col, ref_tabla, ref_col)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.nombre AND conrelid = r.tabla::regclass) THEN
            CONTINUE;
        END IF;
        EXECUTE format('SELECT count(*) FROM %I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I y WHERE y.%I = x.%I)',
                       r.tabla, r.col, r.ref_tabla, r.ref_col, r.col) INTO v_huerfanos;
        IF v_huerfanos > 0 THEN
            RAISE EXCEPTION 'RELACIONES: % fila(s) de %.% no existen en %; corrija los datos antes de crear %',
                v_huerfanos, r.tabla, r.col, r.ref_tabla, r.nombre;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I (%I)',
                       r.tabla, r.nombre, r.col, r.ref_tabla, r.ref_col);
    END LOOP;
END $$;
