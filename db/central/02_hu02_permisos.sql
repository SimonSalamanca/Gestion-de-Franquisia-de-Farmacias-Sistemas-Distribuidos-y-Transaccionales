-- HU-02: permiso para registrar lotes, recibir pedidos y ajustar inventario. Idempotente.
-- Es un dato, no estructura (RNF-11). Se replica a las tiendas con PERMISO_UPSERT y
-- ROL_PERMISO_SET (este último reemplaza todos los permisos del rol, por eso lleva la lista completa).

DO $$
DECLARE
    v_cambio boolean := false;
    v_filas integer;
    v_permiso permiso%ROWTYPE;
    r record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM permiso WHERE codigo = 'INVENTARIO_GESTIONAR') THEN
        PERFORM setval('permiso_id_permiso_seq', (SELECT COALESCE(MAX(id_permiso), 1) FROM permiso));
        INSERT INTO permiso (codigo, descripcion)
        VALUES ('INVENTARIO_GESTIONAR', 'Registrar lotes, recibir pedidos y ajustar inventario');
        v_cambio := true;
    END IF;

    INSERT INTO rol_permiso (id_rol, id_permiso)
    SELECT r2.id_rol, p.id_permiso
    FROM rol r2
    JOIN permiso p ON p.codigo = 'INVENTARIO_GESTIONAR'
    WHERE r2.nombre IN ('administrador_tienda', 'administrador_general')
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_filas = ROW_COUNT;
    IF v_filas > 0 THEN
        v_cambio := true;
    END IF;

    -- Si el log de réplica está vacío, el catálogo inicial (migrate.mjs) ya incluirá el permiso.
    IF v_cambio AND EXISTS (SELECT 1 FROM replica_evento) THEN
        SELECT * INTO v_permiso FROM permiso WHERE codigo = 'INVENTARIO_GESTIONAR';
        PERFORM append_replica_evento(
            NULL, 'PERMISO_UPSERT', 1,
            jsonb_build_object('id_permiso', v_permiso.id_permiso, 'codigo', v_permiso.codigo, 'descripcion', v_permiso.descripcion)
        );
        FOR r IN SELECT id_rol FROM rol WHERE nombre IN ('administrador_tienda', 'administrador_general') ORDER BY id_rol LOOP
            PERFORM append_replica_evento(
                NULL, 'ROL_PERMISO_SET', 1,
                jsonb_build_object(
                    'id_rol', r.id_rol,
                    'permisos', (
                        SELECT COALESCE(jsonb_agg(jsonb_build_object('id_permiso', p.id_permiso, 'codigo', p.codigo) ORDER BY p.codigo), '[]'::jsonb)
                        FROM rol_permiso rp
                        JOIN permiso p ON p.id_permiso = rp.id_permiso
                        WHERE rp.id_rol = r.id_rol
                    )
                )
            );
        END LOOP;
    END IF;
END $$;
