-- HU-12 (validación contra el sistema de salud, simulada): la receta de un medicamento controlado se valida y se
-- reserva en el central, y la tienda guarda una copia. Al dispensarse, la tienda informa la baja por el outbox.
-- Sin conexión con el central no se valida un controlado nuevo (opción A); una receta ya reservada sigue valiendo
-- hasta que termine su reserva. Idempotente.

-- De dónde viene la receta, su código en el central y hasta cuándo la tienda la tiene reservada.
ALTER TABLE receta
    ADD COLUMN IF NOT EXISTS codigo_receta character varying(40);

ALTER TABLE receta
    ADD COLUMN IF NOT EXISTS origen character varying(10) NOT NULL DEFAULT 'MANUAL'
        CONSTRAINT receta_origen_check CHECK (origen IN ('MANUAL', 'CENTRAL'));

ALTER TABLE receta
    ADD COLUMN IF NOT EXISTS reservada_hasta timestamp without time zone;

CREATE UNIQUE INDEX IF NOT EXISTS uq_receta_codigo ON receta (codigo_receta) WHERE codigo_receta IS NOT NULL;

-- El registro manual (sin pasar por el central) queda apagado: solo para recetas que no están en el sistema.
ALTER TABLE politica_receta
    ADD COLUMN IF NOT EXISTS permitir_registro_manual boolean NOT NULL DEFAULT false;

-- La receta sigue siendo inmutable; lo único que se puede mover es el plazo de la reserva (renovarla o liberarla).
CREATE OR REPLACE FUNCTION receta_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_TABLE_NAME = 'receta' AND TG_OP = 'UPDATE' THEN
        IF NEW.id_receta = OLD.id_receta
           AND NEW.medico_prescriptor = OLD.medico_prescriptor
           AND NEW.fecha_emision = OLD.fecha_emision
           AND NEW.id_cliente IS NOT DISTINCT FROM OLD.id_cliente
           AND NEW.fecha_registro = OLD.fecha_registro
           AND NEW.id_empleado_registro IS NOT DISTINCT FROM OLD.id_empleado_registro
           AND NEW.codigo_receta IS NOT DISTINCT FROM OLD.codigo_receta
           AND NEW.origen = OLD.origen THEN
            RETURN NEW;
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'receta_medicamento' AND TG_OP = 'UPDATE' THEN
        IF NEW.id_receta = OLD.id_receta
           AND NEW.id_medicamento = OLD.id_medicamento
           AND NEW.cantidad_autorizada = OLD.cantidad_autorizada THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Una receta registrada no se puede modificar ni borrar (% en %)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$;

-- Garantía en la base sobre la línea de factura. Para un medicamento que requiere receta:
--   * receta del central: la reserva debe estar vigente y la receta no puede haberse usado en otra factura
--     (la primera dispensación la "quema"); al aceptarse la línea se encola la baja RECETA_DISPENSADA en el
--     outbox, en la misma transacción (si la venta se revierte, el evento también);
--   * receta manual: solo si la política lo permite, y dentro de su vigencia.
-- Siempre: debe incluir el medicamento, ser del cliente de la factura y alcanzar en saldo. SQLSTATE 23514, RECETA_*.
CREATE OR REPLACE FUNCTION detalle_factura_exige_receta() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_med integer;
    v_nombre text;
    v_requiere boolean;
    v_cliente_factura integer;
    v_receta record;
BEGIN
    SELECT m.id_medicamento, m.nombre_comercial, m.requiere_receta
      INTO v_med, v_nombre, v_requiere
      FROM lote l
      JOIN medicamento_ref m ON m.id_medicamento = l.id_medicamento
     WHERE l.id_lote = NEW.id_lote;
    IF NOT FOUND OR NOT v_requiere THEN
        RETURN NEW;
    END IF;

    IF NEW.id_receta IS NULL THEN
        RAISE EXCEPTION 'RECETA_REQUERIDA: % requiere receta médica', v_nombre USING ERRCODE = '23514';
    END IF;

    SELECT r.fecha_emision, r.id_cliente, r.origen, r.codigo_receta, r.reservada_hasta,
           rm.cantidad_autorizada, rm.cantidad_dispensada
      INTO v_receta
      FROM receta r
      JOIN receta_medicamento rm ON rm.id_receta = r.id_receta AND rm.id_medicamento = v_med
     WHERE r.id_receta = NEW.id_receta
       FOR UPDATE OF rm;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RECETA_INVALIDA: la receta % no incluye %', NEW.id_receta, v_nombre USING ERRCODE = '23514';
    END IF;

    IF v_receta.origen = 'CENTRAL' THEN
        IF v_receta.reservada_hasta IS NULL OR v_receta.reservada_hasta < now()::timestamp THEN
            RAISE EXCEPTION 'RECETA_RESERVA_VENCIDA: la reserva de la receta % terminó; valídela de nuevo con el central', NEW.id_receta
                USING ERRCODE = '23514';
        END IF;
        IF EXISTS (SELECT 1 FROM detalle_factura d WHERE d.id_receta = NEW.id_receta AND d.id_factura <> NEW.id_factura) THEN
            RAISE EXCEPTION 'RECETA_RECLAMADA: la receta % ya se dispensó en otra factura', NEW.id_receta USING ERRCODE = '23514';
        END IF;
    ELSE
        IF NOT (SELECT permitir_registro_manual FROM politica_receta WHERE id = 1) THEN
            RAISE EXCEPTION 'RECETA_MANUAL_NO_PERMITIDA: un medicamento controlado exige una receta validada con el central'
                USING ERRCODE = '23514';
        END IF;
        IF NOT receta_vigente(v_receta.fecha_emision) THEN
            RAISE EXCEPTION 'RECETA_VENCIDA: la receta % no está vigente', NEW.id_receta USING ERRCODE = '23514';
        END IF;
    END IF;

    SELECT id_cliente INTO v_cliente_factura FROM factura WHERE id_factura = NEW.id_factura;
    IF v_cliente_factura IS DISTINCT FROM v_receta.id_cliente THEN
        RAISE EXCEPTION 'RECETA_CLIENTE: la receta % es de otro paciente', NEW.id_receta USING ERRCODE = '23514';
    END IF;

    IF v_receta.cantidad_dispensada + NEW.cantidad > v_receta.cantidad_autorizada THEN
        RAISE EXCEPTION 'RECETA_SALDO: la receta % autoriza % de % y ya se dispensaron %',
            NEW.id_receta, v_receta.cantidad_autorizada, v_nombre, v_receta.cantidad_dispensada USING ERRCODE = '23514';
    END IF;

    UPDATE receta_medicamento
       SET cantidad_dispensada = cantidad_dispensada + NEW.cantidad
     WHERE id_receta = NEW.id_receta AND id_medicamento = v_med;

    IF v_receta.origen = 'CENTRAL' THEN
        INSERT INTO outbox_sync (id_empleado, idempotency_key, tipo_evento, payload)
        VALUES (
            NULL, gen_random_uuid(), 'RECETA_DISPENSADA',
            jsonb_build_object(
                'codigo', v_receta.codigo_receta,
                'id_medicamento', v_med,
                'cantidad', NEW.cantidad,
                'id_factura', NEW.id_factura,
                'dispensado_en', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
        );
    END IF;
    RETURN NEW;
END;
$$;
