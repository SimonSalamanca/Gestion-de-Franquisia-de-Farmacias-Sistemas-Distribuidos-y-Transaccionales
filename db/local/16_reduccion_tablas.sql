-- Reducción de tablas del nodo local (docs/reduccion-tablas/). Idempotente: cada bloque actúa solo si la tabla vieja
-- todavía existe, mueve sus datos a la estructura que crean los scripts anteriores, comprueba que no se pierda nada y la
-- elimina. En una instalación nueva limpia lo que crea 00_base.sql. El migrador ejecuta el archivo en una sola
-- transacción: si una comprobación falla, no se elimina nada.

-- 1. Vistas del script base que nadie consulta (las reemplazó alertas_calculadas, 08_hu04). La de stock bajo depende de
--    vw_stock_tienda: se elimina primero.
DROP VIEW IF EXISTS vw_alerta_stock_bajo;
DROP VIEW IF EXISTS vw_alerta_caducidad;
DROP VIEW IF EXISTS vw_stock_tienda;

-- 2. precio_vigente_ref: la reemplazaron precio_ref y precio_vigente() (04_hu03). Solo se elimina vacía.
DO $$
DECLARE
    v_filas bigint;
BEGIN
    IF to_regclass('precio_vigente_ref') IS NULL THEN
        RETURN;
    END IF;
    EXECUTE 'SELECT count(*) FROM precio_vigente_ref' INTO v_filas;
    IF v_filas > 0 THEN
        RAISE EXCEPTION 'REDUCCION: precio_vigente_ref tiene % fila(s); revíselas antes de eliminarla', v_filas;
    END IF;
    DROP TABLE precio_vigente_ref;
END $$;

-- 3. secuencia_factura + secuencia_nota -> secuencia_documento. Se conserva el mayor consecutivo: nunca se repite un número.
DO $$
BEGIN
    IF to_regclass('secuencia_factura') IS NOT NULL THEN
        EXECUTE 'UPDATE secuencia_documento d SET ultimo = GREATEST(d.ultimo, s.ultimo)
                   FROM secuencia_factura s WHERE d.tipo = ''FACTURA'' AND s.id = 1';
        DROP TABLE secuencia_factura;
    END IF;
    IF to_regclass('secuencia_nota') IS NOT NULL THEN
        EXECUTE 'UPDATE secuencia_documento d SET ultimo = GREATEST(d.ultimo, s.ultimo)
                   FROM secuencia_nota s WHERE d.tipo = ''NOTA'' AND s.id = 1';
        DROP TABLE secuencia_nota;
    END IF;
END $$;

-- 4. politica_acceso + politica_receta -> politica_sistema (una fila, id = 1).
DO $$
BEGIN
    IF to_regclass('politica_acceso') IS NOT NULL THEN
        EXECUTE 'UPDATE politica_sistema s SET intentos_maximos = p.intentos_maximos, minutos_bloqueo = p.minutos_bloqueo
                   FROM politica_acceso p WHERE s.id = 1 AND p.id = 1';
        DROP TABLE politica_acceso;
    END IF;
    IF to_regclass('politica_receta') IS NOT NULL THEN
        EXECUTE 'UPDATE politica_sistema s SET dias_vigencia = p.dias_vigencia, permitir_registro_manual = p.permitir_registro_manual
                   FROM politica_receta p WHERE s.id = 1 AND p.id = 1';
        DROP TABLE politica_receta;
    END IF;
END $$;

-- 5. replica_cursor + auditoria_cursor -> cursor_sync (misma clave, id_tienda). Se conserva el cursor más avanzado:
--    nunca se vuelve a pedir un evento ya aplicado ni a subir auditoría ya subida.
DO $$
BEGIN
    IF to_regclass('replica_cursor') IS NOT NULL THEN
        EXECUTE 'INSERT INTO cursor_sync (id_tienda, ultimo_evento_visto, ultimo_ack_en)
                 SELECT id_tienda, ultimo_evento_visto, ultimo_ack_en FROM replica_cursor
                 ON CONFLICT (id_tienda) DO UPDATE
                 SET ultimo_evento_visto = GREATEST(cursor_sync.ultimo_evento_visto, excluded.ultimo_evento_visto),
                     ultimo_ack_en = COALESCE(excluded.ultimo_ack_en, cursor_sync.ultimo_ack_en)';
        DROP TABLE replica_cursor;
    END IF;
    IF to_regclass('auditoria_cursor') IS NOT NULL THEN
        EXECUTE 'INSERT INTO cursor_sync (id_tienda, ultimo_registro_enviado, auditoria_enviada_en)
                 SELECT id_tienda, ultimo_registro_enviado, enviado_en FROM auditoria_cursor
                 ON CONFLICT (id_tienda) DO UPDATE
                 SET ultimo_registro_enviado = GREATEST(cursor_sync.ultimo_registro_enviado, excluded.ultimo_registro_enviado),
                     auditoria_enviada_en = COALESCE(excluded.auditoria_enviada_en, cursor_sync.auditoria_enviada_en)';
        DROP TABLE auditoria_cursor;
    END IF;
END $$;

-- 6. empleado_ref_cuarentena -> sync_conflicto (tipo EMPLEADO_CUARENTENA, la fila apartada en payload). Quedan
--    resueltas: la cuarentena ya se aplicó y nunca contó como conflicto pendiente.
DO $$
DECLARE
    v_viejas bigint;
    v_movidas integer;
BEGIN
    IF to_regclass('empleado_ref_cuarentena') IS NULL THEN
        RETURN;
    END IF;
    EXECUTE 'SELECT count(*) FROM empleado_ref_cuarentena' INTO v_viejas;
    EXECUTE 'INSERT INTO sync_conflicto (id_empleado, tipo, detalle, payload, creado_en, resuelto)
             SELECT c.id_empleado, ''EMPLEADO_CUARENTENA'', c.motivo, to_jsonb(c) - ''id_cuarentena'' - ''motivo'' - ''movido_en'',
                    c.movido_en, true
               FROM empleado_ref_cuarentena c ORDER BY c.id_cuarentena';
    GET DIAGNOSTICS v_movidas = ROW_COUNT;
    IF v_movidas <> v_viejas THEN
        RAISE EXCEPTION 'REDUCCION: se movieron % de % filas de empleado_ref_cuarentena', v_movidas, v_viejas;
    END IF;
    DROP TABLE empleado_ref_cuarentena;
END $$;
