-- Reducción de tablas del nodo central (docs/reduccion-tablas/). Idempotente: cada bloque actúa solo si la tabla vieja
-- todavía existe, mueve sus datos a la estructura que crean los scripts anteriores, comprueba que no se pierda nada y la
-- elimina. En una instalación nueva limpia lo que crea 00_base.sql. El migrador ejecuta el archivo en una sola
-- transacción: si una comprobación falla, no se elimina nada.

-- 1. tienda_operacion -> auth_operacion (misma estructura; auth_operacion ya es la tabla de idempotencia común).
DO $$
DECLARE
    v_viejas bigint;
    v_movidas bigint;
BEGIN
    IF to_regclass('tienda_operacion') IS NULL THEN
        RETURN;
    END IF;
    SELECT count(*) INTO v_viejas FROM tienda_operacion;
    INSERT INTO auth_operacion (idempotency_key, payload_hmac, resultado_http, cuerpo_json, creado_en)
    SELECT idempotency_key, payload_hmac, resultado_http, cuerpo_json, creado_en FROM tienda_operacion
    ON CONFLICT (idempotency_key) DO NOTHING;
    SELECT count(*) INTO v_movidas
      FROM tienda_operacion t JOIN auth_operacion a ON a.idempotency_key = t.idempotency_key AND a.payload_hmac = t.payload_hmac;
    IF v_movidas <> v_viejas THEN
        RAISE EXCEPTION 'REDUCCION: % de % operaciones de tienda chocan con una clave de auth_operacion', v_viejas - v_movidas, v_viejas;
    END IF;
    DROP TABLE tienda_operacion;
END $$;

-- 2. politica_acceso + politica_receta -> politica_sistema (una fila, id = 1).
DO $$
BEGIN
    IF to_regclass('politica_acceso') IS NOT NULL THEN
        UPDATE politica_sistema s
           SET intentos_maximos = p.intentos_maximos, minutos_bloqueo = p.minutos_bloqueo
          FROM politica_acceso p
         WHERE s.id = 1 AND p.id = 1;
        DROP TABLE politica_acceso;
    END IF;
    IF to_regclass('politica_receta') IS NOT NULL THEN
        EXECUTE 'UPDATE politica_sistema s
                    SET dias_vigencia = p.dias_vigencia, minutos_reserva = p.minutos_reserva
                   FROM politica_receta p
                  WHERE s.id = 1 AND p.id = 1';
        DROP TABLE politica_receta;
    END IF;
END $$;

-- 3. medicamento_proveedor: ningún código la usa. Solo se elimina vacía; si tuviera filas, se detiene para revisarla.
DO $$
DECLARE
    v_filas bigint;
BEGIN
    IF to_regclass('medicamento_proveedor') IS NULL THEN
        RETURN;
    END IF;
    EXECUTE 'SELECT count(*) FROM medicamento_proveedor' INTO v_filas;
    IF v_filas > 0 THEN
        RAISE EXCEPTION 'REDUCCION: medicamento_proveedor tiene % fila(s); revíselas antes de eliminarla', v_filas;
    END IF;
    DROP TABLE medicamento_proveedor;
END $$;

-- 4. umbral_stock + inventario_consolidado -> medicamento_tienda (misma clave: tienda y medicamento).
DO $$
DECLARE
    v_viejas bigint;
    v_movidas bigint;
BEGIN
    IF to_regclass('umbral_stock') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM umbral_stock' INTO v_viejas;
        EXECUTE 'INSERT INTO medicamento_tienda (id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad)
                 SELECT id_tienda, id_medicamento, stock_minimo, dias_alerta_caducidad FROM umbral_stock
                 ON CONFLICT (id_tienda, id_medicamento) DO UPDATE
                 SET stock_minimo = excluded.stock_minimo, dias_alerta_caducidad = excluded.dias_alerta_caducidad';
        EXECUTE 'SELECT count(*) FROM umbral_stock u JOIN medicamento_tienda m USING (id_tienda, id_medicamento)
                  WHERE m.stock_minimo = u.stock_minimo AND m.dias_alerta_caducidad = u.dias_alerta_caducidad' INTO v_movidas;
        IF v_movidas <> v_viejas THEN
            RAISE EXCEPTION 'REDUCCION: se movieron % de % umbrales', v_movidas, v_viejas;
        END IF;
        DROP TABLE umbral_stock;
    END IF;
    IF to_regclass('inventario_consolidado') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM inventario_consolidado' INTO v_viejas;
        EXECUTE 'INSERT INTO medicamento_tienda (id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion)
                 SELECT id_tienda, id_medicamento, cantidad_disponible, fecha_sincronizacion FROM inventario_consolidado
                 ON CONFLICT (id_tienda, id_medicamento) DO UPDATE
                 SET cantidad_disponible = excluded.cantidad_disponible, fecha_sincronizacion = excluded.fecha_sincronizacion';
        EXECUTE 'SELECT count(*) FROM inventario_consolidado i JOIN medicamento_tienda m USING (id_tienda, id_medicamento)
                  WHERE m.cantidad_disponible = i.cantidad_disponible AND m.fecha_sincronizacion = i.fecha_sincronizacion' INTO v_movidas;
        IF v_movidas <> v_viejas THEN
            RAISE EXCEPTION 'REDUCCION: se movieron % de % filas de stock consolidado', v_movidas, v_viejas;
        END IF;
        DROP TABLE inventario_consolidado;
        -- Su id sustituto usaba una secuencia propia del script base, que no se elimina con la tabla.
        DROP SEQUENCE IF EXISTS inventario_consolidado_id_inventario_consolidado_seq;
    END IF;
END $$;

-- 5. auditoria_tienda -> registro_actividad_central (filas con id_tienda e id_registro_tienda).
DO $$
DECLARE
    v_viejas bigint;
    v_movidas bigint;
BEGIN
    IF to_regclass('auditoria_tienda') IS NULL THEN
        RETURN;
    END IF;
    EXECUTE 'SELECT count(*) FROM auditoria_tienda' INTO v_viejas;
    EXECUTE 'INSERT INTO registro_actividad_central (id_tienda, id_registro_tienda, id_empleado, accion, entidad_afectada,
                                                     id_entidad_afectada, fecha_hora, detalle, recibido_en)
             SELECT id_tienda, id_registro, id_empleado, accion, entidad_afectada, id_entidad_afectada, fecha_hora, detalle, recibido_en
               FROM auditoria_tienda
              ORDER BY recibido_en, id_tienda, id_registro
             ON CONFLICT (id_tienda, id_registro_tienda) DO NOTHING';
    EXECUTE 'SELECT count(*) FROM auditoria_tienda t JOIN registro_actividad_central r
                ON r.id_tienda = t.id_tienda AND r.id_registro_tienda = t.id_registro
               AND r.accion = t.accion AND r.fecha_hora = t.fecha_hora' INTO v_movidas;
    IF v_movidas <> v_viejas THEN
        RAISE EXCEPTION 'REDUCCION: se movieron % de % filas de auditoría de tiendas', v_movidas, v_viejas;
    END IF;
    DROP TABLE auditoria_tienda;
END $$;

-- 6. bloqueo_canonico -> control_acceso (epoch_bloqueo, bloqueo_canonico_hasta): por empleado, el de su última época.
DO $$
BEGIN
    IF to_regclass('bloqueo_canonico') IS NULL THEN
        RETURN;
    END IF;
    EXECUTE 'UPDATE control_acceso c
                SET epoch_bloqueo = b.epoch, bloqueo_canonico_hasta = b.bloqueado_hasta
               FROM (SELECT DISTINCT ON (id_empleado) id_empleado, epoch, bloqueado_hasta
                       FROM bloqueo_canonico ORDER BY id_empleado, epoch DESC) b
              WHERE c.id_empleado = b.id_empleado';
    DROP TABLE bloqueo_canonico;
END $$;
