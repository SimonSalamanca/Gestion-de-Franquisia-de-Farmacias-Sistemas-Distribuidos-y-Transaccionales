-- HU-02: dirección explícita de cada movimiento de inventario. Idempotente.
-- Excepción autorizada a la regla de no cambiar estructura: cantidad sigue siendo > 0
-- y el efecto en el stock es sentido * cantidad.

ALTER TABLE movimiento_inventario
    ADD COLUMN IF NOT EXISTS sentido smallint;

UPDATE movimiento_inventario
SET sentido = CASE WHEN tipo_movimiento IN ('VENTA', 'TRASLADO_SALIDA', 'AJUSTE') THEN -1 ELSE 1 END
WHERE sentido IS NULL;

ALTER TABLE movimiento_inventario
    ALTER COLUMN sentido SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'movimiento_sentido_check') THEN
        ALTER TABLE movimiento_inventario
            ADD CONSTRAINT movimiento_sentido_check CHECK (
                sentido IN (-1, 1)
                AND (
                    tipo_movimiento = 'AJUSTE'
                    OR (tipo_movimiento IN ('ENTRADA', 'DEVOLUCION', 'TRASLADO_ENTRADA') AND sentido = 1)
                    OR (tipo_movimiento IN ('VENTA', 'TRASLADO_SALIDA') AND sentido = -1)
                )
            );
    END IF;
END $$;
