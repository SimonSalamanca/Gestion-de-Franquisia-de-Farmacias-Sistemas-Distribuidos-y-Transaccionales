-- Relaciones del modelo de datos del nodo local, fase A (docs/modelo-datos/relaciones.md).
-- Declara como llave foránea las relaciones que el esquema ya usaba sin declararlas y elimina las dobles rutas hacia un
-- mismo dato. No cambia datos ni código. Idempotente: cada restricción se crea solo si no existe, y antes se comprueba
-- que ningún dato la incumpla para fallar con un mensaje claro.
--
-- Quedan para la fase B, porque necesitan un cambio de código para no romper la operación:
--   alerta -> lote (la venta debe bloquear el lote con FOR NO KEY UPDATE; ver 08_hu04_alertas.sql),
--   cursor_sync y empleado_ref -> tienda_ref (el cursor se crea antes de que la réplica traiga la tienda).

-- Política de la red: cada tienda opera bajo la única política del sistema (id = 1).
ALTER TABLE tienda_ref ADD COLUMN IF NOT EXISTS id_politica integer NOT NULL DEFAULT 1;

DO $$
DECLARE
    r record;
    v_huerfanos bigint;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('tienda_ref', 'tienda_ref_id_politica_fkey', 'id_politica', 'politica_sistema', 'id'),
        -- Un empleado registra 0..N intentos de acceso (el usuario escrito puede no existir: columna opcional).
        ('intento_acceso', 'intento_acceso_id_empleado_fkey', 'id_empleado', 'empleado_ref', 'id_empleado'),
        -- Un empleado origina 0..N operaciones pendientes de envío al central (vacío = proceso del sistema).
        ('outbox_sync', 'outbox_sync_id_empleado_fkey', 'id_empleado', 'empleado_ref', 'id_empleado'),
        -- Un empleado está involucrado en 0..N conflictos de sincronización (vacío = conflicto de catálogo).
        ('sync_conflicto', 'sync_conflicto_id_empleado_fkey', 'id_empleado', 'empleado_ref', 'id_empleado'),
        -- Un pedido puede nacer de una alerta de stock (HU-13).
        ('pedido', 'pedido_id_alerta_fkey', 'id_alerta', 'alerta', 'id_alerta'),
        -- Cada reintegro de una nota se hace por un método de pago.
        ('devolucion_pago', 'devolucion_pago_id_metodo_pago_fkey', 'id_metodo_pago', 'metodo_pago_ref', 'id_metodo_pago')
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

-- Diferencia de recepción: una sola ruta a cada dato. Antes apuntaba por separado a pedido, recepción y medicamento, y
-- nada impedía que la recepción fuera de otro pedido o que el medicamento no estuviera en el pedido. Ahora:
--   la diferencia es de una línea del pedido   -> detalle_pedido (id_pedido, id_medicamento)
--   y se registró en una recepción de ese pedido -> recepcion (id_recepcion, id_pedido)
DO $$
DECLARE
    v_huerfanos bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recepcion_id_recepcion_id_pedido_key' AND conrelid = 'recepcion'::regclass) THEN
        ALTER TABLE recepcion ADD CONSTRAINT recepcion_id_recepcion_id_pedido_key UNIQUE (id_recepcion, id_pedido);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diferencia_recepcion_linea_pedido_fkey' AND conrelid = 'diferencia_recepcion'::regclass) THEN
        SELECT count(*) INTO v_huerfanos FROM diferencia_recepcion d
         WHERE NOT EXISTS (SELECT 1 FROM detalle_pedido x WHERE x.id_pedido = d.id_pedido AND x.id_medicamento = d.id_medicamento);
        IF v_huerfanos > 0 THEN
            RAISE EXCEPTION 'RELACIONES: % diferencia(s) de recepción no corresponden a una línea de su pedido', v_huerfanos;
        END IF;
        ALTER TABLE diferencia_recepcion ADD CONSTRAINT diferencia_recepcion_linea_pedido_fkey
            FOREIGN KEY (id_pedido, id_medicamento) REFERENCES detalle_pedido (id_pedido, id_medicamento);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diferencia_recepcion_recepcion_pedido_fkey' AND conrelid = 'diferencia_recepcion'::regclass) THEN
        SELECT count(*) INTO v_huerfanos FROM diferencia_recepcion d
         WHERE d.id_recepcion IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM recepcion x WHERE x.id_recepcion = d.id_recepcion AND x.id_pedido = d.id_pedido);
        IF v_huerfanos > 0 THEN
            RAISE EXCEPTION 'RELACIONES: % diferencia(s) apuntan a una recepción de otro pedido', v_huerfanos;
        END IF;
        ALTER TABLE diferencia_recepcion ADD CONSTRAINT diferencia_recepcion_recepcion_pedido_fkey
            FOREIGN KEY (id_recepcion, id_pedido) REFERENCES recepcion (id_recepcion, id_pedido);
    END IF;
END $$;

-- Las llaves simples quedan cubiertas por las compuestas (la línea del pedido ya exige pedido y medicamento).
ALTER TABLE diferencia_recepcion DROP CONSTRAINT IF EXISTS diferencia_recepcion_id_pedido_fkey;
ALTER TABLE diferencia_recepcion DROP CONSTRAINT IF EXISTS diferencia_recepcion_id_recepcion_fkey;
ALTER TABLE diferencia_recepcion DROP CONSTRAINT IF EXISTS diferencia_recepcion_id_medicamento_fkey;
