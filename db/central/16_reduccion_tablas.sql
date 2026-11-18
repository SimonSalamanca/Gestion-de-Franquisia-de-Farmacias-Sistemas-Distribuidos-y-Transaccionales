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
