-- HU-04: el sistema de alertas solo vigila lo que tiene umbral, así que ningún producto activo puede existir sin
-- umbral en una tienda activa (stock mínimo y días de aviso de caducidad, por producto y por tienda). Idempotente.
-- La regla se comprueba al hacer commit (restricción diferida), para poder crear el producto y sus umbrales juntos:
--   * un medicamento activo exige un umbral en cada tienda activa;
--   * una tienda activa exige un umbral para cada medicamento activo.
-- Los datos que ya existían sin umbral no se tocan aquí: `npm run db:depurar-umbrales` los lista y, si se pide, los da
-- de baja. Una baja es lógica (activo = false): las facturas, recetas y movimientos que los referencian son inmutables.

CREATE OR REPLACE FUNCTION exigir_umbral_medicamento() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.activo AND EXISTS (
        SELECT 1 FROM tienda t
         WHERE t.activa
           AND NOT EXISTS (SELECT 1 FROM umbral_stock u WHERE u.id_tienda = t.id_tienda AND u.id_medicamento = NEW.id_medicamento)
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
           AND NOT EXISTS (SELECT 1 FROM umbral_stock u WHERE u.id_tienda = NEW.id_tienda AND u.id_medicamento = m.id_medicamento)
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
