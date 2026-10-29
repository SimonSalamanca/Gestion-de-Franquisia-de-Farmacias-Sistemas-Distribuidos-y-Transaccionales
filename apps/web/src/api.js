export async function api(path, { method = "GET", body, token, key } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}
