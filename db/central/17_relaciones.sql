-- Relaciones del modelo de datos del nodo central, fase A (docs/modelo-datos/relaciones.md).
-- Declara como llave foránea las relaciones que el esquema ya usaba sin declararlas: cada tabla técnica queda unida a la
-- entidad dueña de su dato (empleado, tienda o categoría). No cambia datos ni código. Idempotente: cada restricción se
-- crea solo si no existe, y antes se comprueba que ningún dato la incumpla para fallar con un mensaje claro.

-- Política de la red: la tienda opera bajo la única política del sistema (id = 1). Una sola política porque el bloqueo
-- por intentos fallidos vale en toda la red (HU-06) y el central lo calcula con ella.
ALTER TABLE tienda ADD COLUMN IF NOT EXISTS id_politica integer NOT NULL DEFAULT 1;

DO $$
DECLARE
    -- tabla, restricción, columnas, tabla referida, columnas referidas, NOT VALID
    r record;
    v_huerfanos bigint;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('tienda', 'tienda_id_politica_fkey', 'id_politica', 'politica_sistema', 'id', false),
        -- Un empleado registra 0..N intentos de acceso (el usuario escrito puede no existir: columna opcional).
        ('intento_acceso', 'intento_acceso_id_empleado_fkey', 'id_empleado', 'empleado', 'id_empleado', false),
        -- Un empleado realiza 0..N acciones auditadas. Los empleados nunca se borran (baja lógica con fecha_baja), así que
        -- la llave no rechaza filas legítimas de las tiendas y además impide borrar a alguien con historia.
        ('registro_actividad_central', 'registro_actividad_central_id_empleado_fkey', 'id_empleado', 'empleado', 'id_empleado', false),
        -- Una tienda origina 0..N registros de actividad (vacío = acción hecha en el central).
        ('registro_actividad_central', 'registro_actividad_central_id_tienda_fkey', 'id_tienda', 'tienda', 'id_tienda', false),
        -- Una tienda envía 0..N operaciones al central.
        ('inbox_sync', 'inbox_sync_id_tienda_origen_fkey', 'id_tienda_origen', 'tienda', 'id_tienda', false),
        -- Una tienda origina 0..N conflictos de receta.
        ('receta_conflicto', 'receta_conflicto_id_tienda_origen_fkey', 'id_tienda_origen', 'tienda', 'id_tienda', false),
        -- venta_categoria_consolidada -> categoria queda para la fase B: las ventas de medicamentos sin categoría se
        -- consolidan con id_categoria = 0 (no existe en categoria) y la llave detendría la consolidación.
        -- Una tienda recibe 0..N eventos (vacío = toda la red). NOT VALID: el registro es contiguo e inmutable (las tiendas
        -- lo leen en orden desde el evento 1 y se detienen ante un hueco), así que los eventos históricos dirigidos a tiendas
        -- que ya no existen se conservan; la regla rige para todo evento nuevo.
        ('replica_evento', 'replica_evento_id_tienda_destino_fkey', 'id_tienda_destino', 'tienda', 'id_tienda', true)
    ) AS t(tabla, nombre, cols, ref_tabla, ref_cols, sin_validar)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.nombre AND conrelid = r.tabla::regclass) THEN
            CONTINUE;
        END IF;
        IF NOT r.sin_validar THEN
            EXECUTE format('SELECT count(*) FROM %I x WHERE x.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %I y WHERE y.%I = x.%I)',
                           r.tabla, r.cols, r.ref_tabla, r.ref_cols, r.cols) INTO v_huerfanos;
            IF v_huerfanos > 0 THEN
                RAISE EXCEPTION 'RELACIONES: % fila(s) de %.% no existen en %; corrija los datos antes de crear %',
                    v_huerfanos, r.tabla, r.cols, r.ref_tabla, r.nombre;
            END IF;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I (%I)%s',
                       r.tabla, r.nombre, r.cols, r.ref_tabla, r.ref_cols, CASE WHEN r.sin_validar THEN ' NOT VALID' ELSE '' END);
    END LOOP;
END $$;

-- La llave foránea reemplaza al disparador que exigía el empleado solo en las filas del central (04_hu07_cuentas.sql):
-- ahora la regla vale para todas las filas y queda declarada en el modelo.
DROP TRIGGER IF EXISTS registro_actividad_central_empleado ON registro_actividad_central;
DROP FUNCTION IF EXISTS auditoria_central_empleado();
