import crypto from "crypto";
import { config } from "./config.mjs";

// Cifrado del documento de los pacientes en el central (docs/seguridad/datos-personales.md, fase 4).
// - documento_hmac: HMAC-SHA256 del documento. Sirve para buscar o comparar sin revelarlo.
// - documento_cifrado: AES-256-GCM con un IV aleatorio por valor. Solo el central lo abre, y únicamente para la copia de la
//   tienda que dispensa la receta.
// - paciente_documento: queda enmascarado (****1234) para que las consultas y los listados no tengan el valor en claro.

const CLAVE = crypto.createHash("sha256").update(`cifrado:${config.datosClave}`).digest();
const CLAVE_HMAC = crypto.createHash("sha256").update(`hmac:${config.datosClave}`).digest();

export const enmascararDocumento = (documento) => (documento ? `****${String(documento).slice(-4)}` : null);

// HMAC del documento: sirve para buscar o comparar sin tener el valor en claro (también en la tienda, tabla cliente).
export const hmacDocumento = (documento) => crypto.createHmac("sha256", CLAVE_HMAC).update(String(documento)).digest("hex");

// Valores que se guardan en receta_emitida (central) y en cliente (tienda) al registrar o migrar un paciente.
export function sellarDocumento(documento) {
  const doc = String(documento);
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv("aes-256-gcm", CLAVE, iv);
  const cifrado = Buffer.concat([cifrador.update(doc, "utf8"), cifrador.final()]);
  const tag = cifrador.getAuthTag();
  return {
    paciente_documento: enmascararDocumento(doc),
    documento_hmac: hmacDocumento(doc),
    documento_cifrado: Buffer.concat([iv, tag, cifrado]).toString("base64"),
  };
}

// Abre el valor cifrado. Falla si la clave no coincide o el dato fue alterado (GCM autentica).
export function abrirDocumento(cifrado) {
  if (!cifrado) throw new Error("Documento sin cifrar: ejecute la migración de datos personales");
  const b = Buffer.from(cifrado, "base64");
  const decifrador = crypto.createDecipheriv("aes-256-gcm", CLAVE, b.subarray(0, 12));
  decifrador.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([decifrador.update(b.subarray(28)), decifrador.final()]).toString("utf8");
}
