export default async function handler(req, res) {
  const { hash } = req.query;
  if (!hash) return res.status(400).json({ error: "Missing tx hash" });
  const url = `https://api.shelbynet.shelby.xyz/v1/transactions/by_hash/${hash}`;
  try {
    let response = await fetch(url, { headers: { "x-api-key": process.env.SHELBYNET_API_KEY ?? "" }});
    if (response.status === 401) {
      response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SHELBYNET_API_KEY ?? ""}` }});
    }
    const body = await response.text();
    res.status(response.status).send(body);
  } catch (err) {
    res.status(500).json({ error: "Shelby proxy failed", details: String(err) });
  }
}
