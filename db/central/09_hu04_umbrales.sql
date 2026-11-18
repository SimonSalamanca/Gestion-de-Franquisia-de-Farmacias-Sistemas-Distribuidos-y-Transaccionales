-- HU-04: el sistema de alertas solo vigila lo que tiene umbral, así que ningún producto activo puede existir sin
-- umbral en una tienda activa (stock mínimo y días de aviso de caducidad, por producto y por tienda). Idempotente.
-- La regla se comprueba al hacer commit (restricción diferida), para poder crear el producto y sus umbrales juntos:
--   * un medicamento activo exige un umbral en cada tienda activa;
--   * una tienda activa exige un umbral para cada medicamento activo.
-- Los datos que ya existían sin umbral no se tocan aquí: `npm run db:depurar-umbrales` los lista y, si se pide, los da
-- de baja. Una baja es lógica (activo = false): las facturas, recetas y movimientos que los referencian son inmutables.

-- Lo que el central sabe de cada medicamento en cada tienda, en una fila por (tienda, medicamento):
--   * su umbral (stock_minimo y dias_alerta_caducidad), que configura el central: ambos nulos = sin umbral;
--   * su stock consolidado (cantidad_disponible y fecha_sincronizacion), que envía la tienda: ambos nulos = la tienda
--     todavía no reportó ese medicamento.
-- Antes eran dos tablas con la misma clave (umbral_stock e inventario_consolidado); 16_reduccion_tablas.sql las fusiona.
CREATE TABLE IF NOT EXISTS medicamento_tienda (
    id_tienda integer NOT NULL REFERENCES tienda (id_tienda) ON DELETE CASCADE,
    id_medicamento integer NOT NULL REFERENCES medicamento (id_medicamento) ON DELETE CASCADE,
    stock_minimo integer,
    dias_alerta_caducidad integer,
    cantidad_disponible integer,
    fecha_sincronizacion timestamp without time zone,
    PRIMARY KEY (id_tienda, id_medicamento),
    CONSTRAINT medicamento_tienda_stock_minimo_check CHECK (stock_minimo >= 0),
    CONSTRAINT medicamento_tienda_dias_check CHECK (dias_alerta_caducidad >= 0),
    CONSTRAINT medicamento_tienda_umbral_check CHECK ((stock_minimo IS NULL) = (dias_alerta_caducidad IS NULL)),
    CONSTRAINT medicamento_tienda_stock_check CHECK ((cantidad_disponible IS NULL) = (fecha_sincronizacion IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_medicamento_tienda_medicamento ON medicamento_tienda (id_medicamento);

CREATE OR REPLACE FUNCTION exigir_umbral_medicamento() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.activo AND EXISTS (
        SELECT 1 FROM tienda t
         WHERE t.activa
           AND NOT EXISTS (SELECT 1 FROM medicamento_tienda u
                            WHERE u.id_tienda = t.id_tienda AND u.id_medicamento = NEW.id_medicamento AND u.stock_minimo IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'MEDICAMENTO_SIN_UMBRAL: % necesita stock mínimo y días de aviso en cada tienda activa', NEW.nombre_comercial
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS medicamento_con_umbral ON medicamento;
CREATE CONSTRAINT TRIGGER medicamento_con_umbral
    AFTER INSERT OR UPDATE OF activo ON medicamento
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION exigir_umbral_medicamento();

CREATE OR REPLACE FUNCTION exigir_umbral_tienda() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.activa AND EXISTS (
        SELECT 1 FROM medicamento m
         WHERE m.activo
           AND NOT EXISTS (SELECT 1 FROM medicamento_tienda u
                            WHERE u.id_tienda = NEW.id_tienda AND u.id_medicamento = m.id_medicamento AND u.stock_minimo IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'TIENDA_SIN_UMBRALES: la tienda % necesita un umbral para cada medicamento activo', NEW.nombre
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tienda_con_umbrales ON tienda;
CREATE CONSTRAINT TRIGGER tienda_con_umbrales
    AFTER INSERT OR UPDATE OF activa ON tienda
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION exigir_umbral_tienda();
