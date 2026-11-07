-- HU-10: el cajero puede anular una factura o procesar una devolución (FACTURA_ANULAR). Idempotente.
-- Es un dato, no estructura (RNF-11): se replica a las tiendas con ROL_PERMISO_SET, que reemplaza todos los permisos
-- del rol y por eso lleva la lista completa.

DO $$
DECLARE
    v_filas integer;
    v_rol integer;
BEGIN
    INSERT INTO rol_permiso (id_rol, id_permiso)
    SELECT r.id_rol, p.id_permiso
    FROM rol r
    JOIN permiso p ON p.codigo = 'FACTURA_ANULAR'
    WHERE r.nombre = 'cajero'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_filas = ROW_COUNT;

    -- Si el log de réplica está vacío, el catálogo inicial (migrate.mjs) ya incluirá el permiso.
    IF v_filas > 0 AND EXISTS (SELECT 1 FROM replica_evento) THEN
        SELECT id_rol INTO v_rol FROM rol WHERE nombre = 'cajero';
        PERFORM append_replica_evento(
            NULL, 'ROL_PERMISO_SET', 1,
            jsonb_build_object(
                'id_rol', v_rol,
                'permisos', (
                    SELECT COALESCE(jsonb_agg(jsonb_build_object('id_permiso', p.id_permiso, 'codigo', p.codigo) ORDER BY p.codigo), '[]'::jsonb)
                    FROM rol_permiso rp
                    JOIN permiso p ON p.id_permiso = rp.id_permiso
                    WHERE rp.id_rol = v_rol
                )
            )
        );
    END IF;
END $$;
