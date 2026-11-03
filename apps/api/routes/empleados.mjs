import { readBody, send, tokenDe } from "../http.mjs";
import { autorizar } from "../auth.mjs";
import { auditoriaLocal, auditoriaRed } from "../auditoria.mjs";
import {
  crearCuenta,
  desactivarCuenta,
  editarCuenta,
  enCentral,
  generarCodigo,
  listarCuentas,
  reactivarCuenta,
  restablecerContrasena,
} from "../empleados.mjs";

// HU-07: cuentas de empleados, restablecimiento de contraseña y consulta de auditoría (RF-05).
// Las mismas rutas en los dos nodos: /api/local/... (POS, admin de tienda) y /api/central/... (consola).
// Cuentas: EMPLEADO_GESTIONAR + Idempotency-Key en escrituras; siempre contra el central (503 sin conexión).
// Auditoría: AUDITORIA_CONSULTAR. La local funciona offline; la de red y la de cuentas exigen el central.
export default function empleados(router) {
  const claveDe = (req) => req.headers["idempotency-key"];
  const NODO = "(local|central)";

  // En el POS el permiso se relee en la réplica local (y se audita ahí un 403). En la consola, en el central,
  // que entonces debe estar alcanzable. En ambos casos el servicio vuelve a validar al actor en el central.
  async function sesionPara(req, nodo, codigo) {
    if (nodo === "local") return autorizar(tokenDe(req), "local", codigo);
    return enCentral(() => autorizar(tokenDe(req), "central", codigo));
  }

  const responder = (res, resultado) => send(res, resultado.status ?? 200, resultado.body ?? resultado);

  router.get(new RegExp(`^/api/${NODO}/empleados$`), async (req, res, { params, url }) => {
    const sesion = await sesionPara(req, params[0], "EMPLEADO_GESTIONAR");
    return responder(res, await enCentral(() => listarCuentas(sesion.id_empleado, Object.fromEntries(url.searchParams))));
  });

  router.post(new RegExp(`^/api/${NODO}/empleados$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "EMPLEADO_GESTIONAR");
    const body = await readBody(req);
    return responder(res, await enCentral(() => crearCuenta(sesion.id_empleado, claveDe(req), body)));
  });

  router.patch(new RegExp(`^/api/${NODO}/empleados/(\\d+)$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "EMPLEADO_GESTIONAR");
    const body = await readBody(req);
    return responder(res, await enCentral(() => editarCuenta(sesion.id_empleado, claveDe(req), Number(params[1]), body)));
  });

  const ACCIONES = { desactivar: desactivarCuenta, reactivar: reactivarCuenta };
  router.post(new RegExp(`^/api/${NODO}/empleados/(\\d+)/(desactivar|reactivar)$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "EMPLEADO_GESTIONAR");
    const body = await readBody(req);
    const accion = ACCIONES[params[2]];
    return responder(res, await enCentral(() => accion(sesion.id_empleado, claveDe(req), Number(params[1]), body)));
  });

  router.post(new RegExp(`^/api/${NODO}/empleados/(\\d+)/codigo$`), async (req, res, { params }) => {
    const sesion = await sesionPara(req, params[0], "EMPLEADO_GESTIONAR");
    return responder(res, await enCentral(() => generarCodigo(sesion.id_empleado, claveDe(req), Number(params[1]))));
  });

  // Sin sesión: el empleado canjea el código que le entregó su administrador.
  router.post(new RegExp(`^/api/${NODO}/auth/restablecer$`), async (req, res) => {
    const body = await readBody(req);
    return responder(res, await enCentral(() => restablecerContrasena(claveDe(req), body)));
  });

  router.get("/api/local/auditoria", async (req, res, { url }) => {
    const sesion = await autorizar(tokenDe(req), "local", "AUDITORIA_CONSULTAR");
    const query = Object.fromEntries(url.searchParams);
    if (query.origen === "cuentas") {
      return responder(res, await enCentral(() => auditoriaRed(query, { soloCuentasDe: sesion.id_tienda })));
    }
    return responder(res, await auditoriaLocal(query));
  });

  router.get("/api/central/auditoria", async (req, res, { url }) => {
    await sesionPara(req, "central", "AUDITORIA_CONSULTAR");
    return responder(res, await enCentral(() => auditoriaRed(Object.fromEntries(url.searchParams))));
  });
}
