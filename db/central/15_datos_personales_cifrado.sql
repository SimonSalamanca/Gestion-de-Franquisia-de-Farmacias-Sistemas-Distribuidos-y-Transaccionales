-- Datos personales (docs/seguridad/datos-personales.md, fase 4): el documento del paciente de cada receta se guarda cifrado.
-- paciente_documento deja de tener el valor en claro: queda enmascarado y el valor real va en documento_cifrado (AES-256-GCM,
-- la clave está en DATOS_CLAVE). documento_hmac permite buscar sin revelar. La migración de los datos existentes la hace
-- apps/api/migrate.mjs (cifrarDocumentosCentral), porque cifrar necesita la clave de la aplicación. Idempotente.

ALTER TABLE receta_emitida ADD COLUMN IF NOT EXISTS documento_hmac character varying(64);
ALTER TABLE receta_emitida ADD COLUMN IF NOT EXISTS documento_cifrado text;

CREATE INDEX IF NOT EXISTS idx_receta_emitida_documento_hmac ON receta_emitida (documento_hmac);

-- Toda receta nueva debe llegar cifrada. Las existentes se cifran al arrancar (migrate.mjs).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receta_emitida_documento_cifrado_check' AND conrelid = 'receta_emitida'::regclass) THEN
        ALTER TABLE receta_emitida ADD CONSTRAINT receta_emitida_documento_cifrado_check
            CHECK (documento_cifrado IS NOT NULL) NOT VALID;
    END IF;
END $$;
