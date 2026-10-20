const base = "http://localhost:4000";

async function login(nodo, usuario) {
  const response = await fetch(`${base}/api/${nodo}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ usuario, password: "Farma123" }),
  });
  const data = await response.json();
  return { status: response.status, data };
}

const casos = [
  ["local", "cajero1"],
  ["local", "admin.tienda"],
  ["local", "admin.general"],
  ["central", "admin.general"],
  ["central", "cajero1"],
];

for (const [nodo, usuario] of casos) {
  const result = await login(nodo, usuario);
  const permisos = result.data.permisos || [];
  console.log(nodo, usuario, result.status, result.data.rol || result.data.codigo, permisos.join(",") || result.data.mensaje);
  if (result.data.token && nodo === "local" && usuario === "cajero1") {
    const denied = await fetch(`${base}/api/local/modulos/CAJA_CERRAR`, {
      headers: { Authorization: `Bearer ${result.data.token}` },
    });
    const body = await denied.json();
    console.log("cajero caja", denied.status, body.codigo);
    const ok = await fetch(`${base}/api/local/modulos/INVENTARIO_CONSULTAR`, {
      headers: { Authorization: `Bearer ${result.data.token}` },
    });
    console.log("cajero inventario", ok.status);
  }
}
