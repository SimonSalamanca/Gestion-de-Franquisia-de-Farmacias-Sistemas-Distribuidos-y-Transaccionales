-- Periodo de caja como entidad (HU-11, fase B2 de docs/modelo-datos/relaciones.md). Reemplaza a caja_control (una fila con
-- el número del periodo vigente) y a apertura_caja (quién abrió cada periodo): el periodo pasa a ser la tabla padre de
-- las facturas, las notas y el cierre. Idempotente; la migración de datos corre una sola vez, en la transacción del
-- script, y verifica que no se pierda nada antes de eliminar las tablas viejas.
--
-- Ciclo de un periodo:  PENDIENTE -> ABIERTO -> CERRADO
--   ABIERTO    se vende; las notas (anulaciones y devoluciones) caen aquí.
--   CERRADO    tiene su cierre (cierre_caja); no admite ventas ni notas nuevas.
--   PENDIENTE  el siguiente periodo, creado al cerrar el anterior. No se vende hasta que un administrador lo abre, pero
--              las devoluciones hechas con la caja cerrada caen aquí (nunca en un periodo ya cerrado).
-- Siempre hay exactamente un periodo no cerrado: el vigente (índice único parcial).

CREATE TABLE IF NOT EXISTS periodo_caja (
    periodo integer PRIMARY KEY,
    estado varchar(10) NOT NULL,
    abierto_en timestamp without time zone,
    id_empleado_apertura integer REFERENCES empleado_ref (id_empleado),
    turno varchar(20),
    CONSTRAINT periodo_caja_estado_check CHECK (estado IN ('PENDIENTE', 'ABIERTO', 'CERRADO')),
    CONSTRAINT periodo_caja_pendiente_check CHECK (estado <> 'PENDIENTE' OR (abierto_en IS NULL AND id_empleado_apertura IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_periodo_caja_vigente ON periodo_caja ((true)) WHERE estado <> 'CERRADO';

-- Migración desde caja_control y apertura_caja (solo si todavía existen).
DO $$
DECLARE
    v_periodo integer;
    v_abierta boolean;
    v_abierta_en timestamp without time zone;
    v_aperturas bigint;
    v_movidas bigint;
BEGIN
    IF to_regclass('caja_control') IS NULL THEN
        RETURN;
    END IF;
    SELECT periodo, abierta, abierta_en INTO v_periodo, v_abierta, v_abierta_en FROM caja_control WHERE id = 1;

    -- Un periodo por cada número usado (facturas, notas, cierres, aperturas) más el vigente; con la caja cerrada, también
    -- el siguiente (PENDIENTE), donde ya pueden estar las devoluciones hechas después del cierre.
    INSERT INTO periodo_caja (periodo, estado, abierto_en, id_empleado_apertura, turno)
    SELECT p.periodo,
           CASE WHEN p.periodo < v_periodo THEN 'CERRADO'
                WHEN p.periodo = v_periodo THEN CASE WHEN v_abierta THEN 'ABIERTO' ELSE 'CERRADO' END
                ELSE 'PENDIENTE' END,
           CASE WHEN p.periodo > v_periodo THEN NULL
                ELSE coalesce(a.fecha_hora, CASE WHEN p.periodo = v_periodo THEN v_abierta_en END,
                              (SELECT k.abierto_en FROM cierre_caja k WHERE k.periodo_caja = p.periodo)) END,
           CASE WHEN p.periodo > v_periodo THEN NULL ELSE a.id_empleado END,
           CASE WHEN p.periodo > v_periodo THEN NULL ELSE a.turno END
      FROM (SELECT periodo_caja AS periodo FROM factura
            UNION SELECT periodo_caja FROM anulacion_devolucion
            UNION SELECT periodo_caja FROM cierre_caja WHERE periodo_caja IS NOT NULL
            UNION SELECT periodo_caja FROM apertura_caja
            UNION SELECT v_periodo
            UNION SELECT v_periodo + 1 WHERE NOT v_abierta) p
      LEFT JOIN apertura_caja a ON a.periodo_caja = p.periodo
    ON CONFLICT (periodo) DO NOTHING;

    -- Comprobaciones: ningún dato en un periodo posterior al siguiente, y ninguna apertura perdida.
    IF EXISTS (SELECT 1 FROM periodo_caja WHERE periodo > v_periodo + 1
               OR (periodo = v_periodo + 1 AND v_abierta)) THEN
        RAISE EXCEPTION 'PERIODO_CAJA: hay documentos en un periodo posterior al vigente (%); revise los datos', v_periodo;
    END IF;
    SELECT count(*) INTO v_aperturas FROM apertura_caja;
    SELECT count(*) INTO v_movidas FROM apertura_caja a
      JOIN periodo_caja p ON p.periodo = a.periodo_caja AND p.id_empleado_apertura = a.id_empleado AND p.abierto_en = a.fecha_hora;
    IF v_movidas <> v_aperturas THEN
        RAISE EXCEPTION 'PERIODO_CAJA: % de % aperturas no pasaron al periodo', v_aperturas - v_movidas, v_aperturas;
    END IF;

    DROP TABLE apertura_caja;
    DROP TABLE caja_control;
END $$;

-- Base nueva: el primer periodo nace abierto (como antes: el periodo 1 no tiene apertura registrada).
INSERT INTO periodo_caja (periodo, estado)
SELECT 1, 'ABIERTO' WHERE NOT EXISTS (SELECT 1 FROM periodo_caja);

-- El cierre guardaba una copia de la hora de apertura del periodo; ahora se lee del periodo (sin dato repetido).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cierre_caja' AND column_name = 'abierto_en'
               AND table_schema = current_schema()) THEN
        UPDATE periodo_caja p SET abierto_en = k.abierto_en
          FROM cierre_caja k WHERE k.periodo_caja = p.periodo AND p.abierto_en IS NULL AND k.abierto_en IS NOT NULL;
    END IF;
END $$;
ALTER TABLE cierre_caja DROP COLUMN IF EXISTS abierto_en;

-- Relaciones: la factura, la nota y el cierre pertenecen a un periodo.
DO $$
DECLARE
    r record;
    v_huerfanos bigint;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('factura', 'factura_periodo_caja_fkey'),
        ('anulacion_devolucion', 'anulacion_devolucion_periodo_caja_fkey'),
        ('cierre_caja', 'cierre_caja_periodo_caja_fkey')
    ) AS t(tabla, nombre)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.nombre AND conrelid = r.tabla::regclass) THEN
            CONTINUE;
        END IF;
        EXECUTE format('SELECT count(*) FROM %I x WHERE x.periodo_caja IS NOT NULL AND NOT EXISTS (SELECT 1 FROM periodo_caja p WHERE p.periodo = x.periodo_caja)',
                       r.tabla) INTO v_huerfanos;
        IF v_huerfanos > 0 THEN
            RAISE EXCEPTION 'PERIODO_CAJA: % fila(s) de % no tienen su periodo', v_huerfanos, r.tabla;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (periodo_caja) REFERENCES periodo_caja (periodo)', r.tabla, r.nombre);
    END LOOP;
END $$;

-- Criterio 5: con la caja cerrada no se emite ninguna factura. La venta lee el periodo vigente con FOR SHARE; el cierre y
-- la apertura lo toman con FOR UPDATE, así el cierre espera a las ventas en curso y ninguna se cuela después. Si el
-- periodo que se esperaba se cerró mientras tanto, la consulta no devuelve fila y la venta se rechaza.
CREATE OR REPLACE FUNCTION factura_periodo_caja() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v periodo_caja%ROWTYPE;
BEGIN
    SELECT * INTO v FROM periodo_caja WHERE estado <> 'CERRADO' FOR SHARE;
    IF NOT FOUND OR v.estado <> 'ABIERTO' THEN
        RAISE EXCEPTION 'CAJA_CERRADA: la caja está cerrada; un administrador debe abrir un nuevo periodo para vender' USING ERRCODE = '23514';
    END IF;
    NEW.periodo_caja := v.periodo;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER factura_periodo_caja_trg
    BEFORE INSERT ON factura
    FOR EACH ROW EXECUTE FUNCTION factura_periodo_caja();

-- Una devolución es dinero que sale de la caja y no se bloquea con ella cerrada (el cliente tiene derecho a devolver):
-- cae en el periodo vigente, ABIERTO o PENDIENTE, nunca en uno cerrado. Si un cierre terminó mientras esperaba, se vuelve
-- a leer: el cierre ya dejó creado el periodo siguiente.
CREATE OR REPLACE FUNCTION anulacion_periodo_caja() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_periodo integer;
BEGIN
    SELECT periodo INTO v_periodo FROM periodo_caja WHERE estado <> 'CERRADO' FOR SHARE;
    IF NOT FOUND THEN
        SELECT periodo INTO v_periodo FROM periodo_caja WHERE estado <> 'CERRADO' FOR SHARE;
    END IF;
    IF v_periodo IS NULL THEN
        RAISE EXCEPTION 'PERIODO_CAJA: no hay periodo vigente' USING ERRCODE = '23514';
    END IF;
    NEW.periodo_caja := v_periodo;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER anulacion_periodo_caja_trg
    BEFORE INSERT ON anulacion_devolucion
    FOR EACH ROW EXECUTE FUNCTION anulacion_periodo_caja();

-- Un periodo solo avanza en su ciclo y, una vez cerrado, no cambia. No se borra.
CREATE OR REPLACE FUNCTION periodo_caja_transicion() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Un periodo de caja no se puede borrar (periodo %)', OLD.periodo USING ERRCODE = '42501';
    END IF;
    IF NEW.periodo <> OLD.periodo THEN
        RAISE EXCEPTION 'El número de un periodo de caja no cambia' USING ERRCODE = '42501';
    END IF;
    IF OLD.estado = 'PENDIENTE' AND NEW.estado = 'ABIERTO' THEN
        RETURN NEW;
    END IF;
    -- Al cerrar, la hora de apertura solo puede completarse si faltaba (periodo inicial, sin apertura registrada).
    IF OLD.estado = 'ABIERTO' AND NEW.estado = 'CERRADO'
       AND (OLD.abierto_en IS NULL OR NEW.abierto_en IS NOT DISTINCT FROM OLD.abierto_en)
       AND NEW.id_empleado_apertura IS NOT DISTINCT FROM OLD.id_empleado_apertura
       AND NEW.turno IS NOT DISTINCT FROM OLD.turno THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Un periodo de caja % no puede pasar de % a % ni editarse', OLD.periodo, OLD.estado, NEW.estado USING ERRCODE = '42501';
END;
$$;

CREATE OR REPLACE TRIGGER periodo_caja_transicion_trg
    BEFORE UPDATE OR DELETE ON periodo_caja
    FOR EACH ROW EXECUTE FUNCTION periodo_caja_transicion();
