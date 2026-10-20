import crypto from "crypto";
import { PEPPER } from "./db.mjs";

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = String(stored).split("$");
  if (algo !== "scrypt" || !saltHex || !hashHex) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 32);
  const expected = Buffer.from(hashHex, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function payloadHmac(usuario, operacion, tiendaId, password) {
  return crypto
    .createHmac("sha256", PEPPER)
    .update(`${usuario}|${operacion}|${tiendaId}|${password}`)
    .digest("hex");
}

export function newToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  return { token, hash };
}
