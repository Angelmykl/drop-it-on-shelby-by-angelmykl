export async function fetchShelbynetTxByHash(hash) {
  const r = await fetch(`/api/shelbynet/tx/${hash}`);
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, data: JSON.parse(text) };
  } catch {
    return { ok: r.ok, status: r.status, data: text };
  }
}
