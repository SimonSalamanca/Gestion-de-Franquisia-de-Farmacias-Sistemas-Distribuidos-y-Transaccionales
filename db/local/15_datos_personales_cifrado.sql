-- Datos personales (docs/seguridad/datos-personales.md, fase 4): el documento de cada cliente de la tienda se guarda cifrado.
-- documento_identidad deja de tener el valor en claro: queda enmascarado (****1234) y el valor real va en documento_cifrado
-- (AES-256-GCM, la clave está en DATOS_CLAVE). documento_hmac identifica al cliente sin revelarlo: reemplaza a documento_identidad
-- en la unicidad y en las búsquedas. La migración de los datos existentes la hace apps/api/migrate.mjs (cifrarDocumentosCliente),
-- porque cifrar necesita la clave de la aplicación. Idempotente.

ALTER TABLE cliente ADD COLUMN IF NOT EXISTS documento_hmac character varying(64);
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS documento_cifrado text;

-- El valor enmascarado puede repetirse (mismos 4 últimos dígitos): la unicidad pasa al HMAC.
ALTER TABLE cliente DROP CONSTRAINT IF EXISTS cliente_documento_identidad_key;
DROP INDEX IF EXISTS uq_cliente_documento;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_documento_hmac ON cliente (documento_hmac) WHERE documento_hmac IS NOT NULL;

-- Todo cliente nuevo con documento debe llegar cifrado. Los existentes se cifran al arrancar (migrate.mjs).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cliente_documento_cifrado_check' AND conrelid = 'cliente'::regclass) THEN
        ALTER TABLE cliente ADD CONSTRAINT cliente_documento_cifrado_check
            CHECK (documento_identidad IS NULL OR documento_cifrado IS NOT NULL) NOT VALID;
    END IF;
END $$;
