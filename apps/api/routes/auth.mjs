import { readBody, send, tokenDe } from "../http.mjs";
import { login, sesionDe, abrirModulo, cerrarSesion, perfil, MODULES } from "../auth.mjs";

// HU-06: inicio de sesión por nodo, perfil, cierre y apertura de módulos según rol.
export default function auth(router) {
  router.post(/^\/api\/(local|central)\/auth\/login$/, async (req, res, { params }) => {
    const body = await readBody(req);
    const result = await login({
      nodo: params[0],
      usuario: body.usuario,
      password: body.password,
      idempotencyKey: req.headers["idempotency-key"],
    });
    return send(res, result.status, result.body);
  });

  router.get("/api/auth/me", async (req, res, { url }) => {
    const sesion = await sesionDe(tokenDe(req), url.searchParams.get("nodo"));
    if (!sesion) return send(res, 401, { codigo: "SESION", mensaje: "Sesión inválida o expirada" });
    return send(res, 200, perfil(sesion));
  });

  router.post("/api/auth/logout", async (req, res) => {
    const body = await readBody(req);
    await cerrarSesion(tokenDe(req), body.nodo);
    return send(res, 204, null);
  });

  router.get(/^\/api\/(local|central)\/modulos\/([A-Z0-9_]+)$/, async (req, res, { params }) => {
    const result = await abrirModulo(tokenDe(req), params[0], params[1]);
    return send(res, result.status, result.body);
  });

  router.get("/api/modulos", (req, res) => send(res, 200, MODULES));
}
