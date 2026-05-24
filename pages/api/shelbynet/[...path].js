/**
 * pages/api/shelbynet/[...path].js
 * Generic server-side proxy for ShelbyNet API calls.
 * Adds the SHELBYNET_API_KEY (server-only env var) so it is never exposed to the browser.
 * Fixes CORS errors that occur when the browser hits https://api.shelbynet.shelby.xyz directly.
 */

export default async function handler(req, res) {
  const { path } = req.query;
  const shelbyPath = Array.isArray(path) ? path.join("/") : path || "";

  // Preserve any query string from the original request
  const rawUrl = req.url || "";
  const qIndex = rawUrl.indexOf("?");
  const qs = qIndex !== -1 ? rawUrl.slice(qIndex) : "";

  const targetUrl = `https://api.shelbynet.shelby.xyz/${shelbyPath}${qs}`;

  // Build upstream headers
  const upstreamHeaders = {
    "Content-Type": req.headers["content-type"] || "application/octet-stream",
  };
  if (process.env.SHELBYNET_API_KEY) {
    upstreamHeaders["Authorization"] = `Bearer ${process.env.SHELBYNET_API_KEY}`;
  }
  // Forward accept header if present
  if (req.headers["accept"]) {
    upstreamHeaders["Accept"] = req.headers["accept"];
  }

  const fetchOptions = { method: req.method, headers: upstreamHeaders };

  // Stream request body for non-GET/HEAD methods
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length > 0) {
      fetchOptions.body = Buffer.concat(chunks);
    }
  }

  try {
    const upstream = await fetch(targetUrl, fetchOptions);

    // Forward response headers
    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    res.status(upstream.status);
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Access-Control-Allow-Origin", "*");

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error("[shelbynet proxy] error:", err);
    res.status(502).json({ error: "Proxy error", message: err.message });
  }
}

// Disable Next.js body parsing so we can stream binary blobs correctly
export const config = {
  api: { bodyParser: false },
};