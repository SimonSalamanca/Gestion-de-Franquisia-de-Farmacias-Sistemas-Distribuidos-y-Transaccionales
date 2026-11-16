import fs from "fs";
import path from "path";
import { ROOT } from "./config.mjs";

// Despliegue (Render): el mismo proceso del API entrega la web compilada (apps/web/dist), así la web llama a /api/... en
// su mismo dominio, igual que con el proxy de Vite en desarrollo. Si no hay compilación (npm run dev), no hace nada.
const DIST = path.join(ROOT, "apps", "web", "dist");
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const SEGURIDAD = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

export const hayWebCompilada = () => fs.existsSync(path.join(DIST, "index.html"));

function enviar(res, archivo, metodo, cache) {
  const datos = fs.readFileSync(archivo);
  res.writeHead(200, {
    "Content-Type": TIPOS[path.extname(archivo).toLowerCase()] || "application/octet-stream",
    "Content-Length": datos.length,
    "Cache-Control": cache,
    ...SEGURIDAD,
  });
  res.end(metodo === "HEAD" ? undefined : datos);
}

// Devuelve true si respondió. Solo GET/HEAD fuera de /api. Las rutas de la app (sin extensión) reciben index.html.
export function servirWeb(req, res, pathname) {
  if ((req.method !== "GET" && req.method !== "HEAD") || pathname.startsWith("/api/") || pathname === "/api") return false;
  if (!hayWebCompilada()) return false;
  let relativo;
  try {
    relativo = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const archivo = path.resolve(DIST, `.${path.posix.normalize(relativo)}`);
  // Nunca fuera de dist (../, rutas absolutas, etc.).
  if (archivo !== DIST && !archivo.startsWith(DIST + path.sep)) return false;
  if (fs.existsSync(archivo) && fs.statSync(archivo).isFile()) {
    // Los archivos de assets/ llevan hash en el nombre: se pueden cachear un año. index.html siempre se revalida.
    const inmutable = archivo.startsWith(path.join(DIST, "assets") + path.sep);
    enviar(res, archivo, req.method, inmutable ? "public, max-age=31536000, immutable" : "no-cache");
    return true;
  }
  if (path.extname(relativo)) return false; // archivo inexistente: 404 normal
  enviar(res, path.join(DIST, "index.html"), req.method, "no-cache");
  return true;
}
