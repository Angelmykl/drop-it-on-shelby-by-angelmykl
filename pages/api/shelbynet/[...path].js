// Generic server-side proxy for ShelbyNet API to bypass browser CORS.
// Route: /api/shelbynet/<any path>
//
// Vercel → Project → Settings → Environment Variables:
//   SHELBYNET_API_KEY = <your key>
//
// NOTE: This is server-side only. Do NOT prefix it with NEXT_PUBLIC.

export const config = {
  api: {
    bodyParser: false,
  },
};

async function forward(req, targetUrl, headers) {
  const init = {
    method: req.method,
    headers,
  };

  // Stream body for non-GET/HEAD requests
  if (req.method && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    init.body = req;
  }

  return fetch(targetUrl, init);
}

export default async function handler(req, res) {
  const pathParts = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  const tailPath = pathParts.filter(Boolean).join("/");

  // Preserve querystring
  const qsIndex = (req.url || "").indexOf("?");
  const qs = qsIndex >= 0 ? (req.url || "").slice(qsIndex) : "";

  const targetUrl = `https://api.shelbynet.shelby.xyz/${tailPath}${qs}`;
  const apiKey = process.env.SHELBYNET_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing SHELBYNET_API_KEY",
      hint: "Set SHELBYNET_API_KEY in Vercel (Production + Preview + Development) and redeploy.",
    });
  }

  try {
    // Copy incoming headers except hop-by-hop / host
    const baseHeaders = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      const key = k.toLowerCase();
      if (["host", "connection", "content-length"].includes(key)) continue;
      if (typeof v === "string") baseHeaders[k] = v;
    }

    // Try a few common header conventions (stop on first non-401)
    const attempts = [
      { ...baseHeaders, "x-api-key": apiKey },
      { ...baseHeaders, "x-shelby-api-key": apiKey },
      { ...baseHeaders, "x-geomi-api-key": apiKey },
      { ...baseHeaders, Authorization: `Bearer ${apiKey}` },
      { ...baseHeaders, Authorization: apiKey },
    ];

    let response;
    for (const headers of attempts) {
      response = await forward(req, targetUrl, headers);
      if (response.status !== 401) break;
    }

    res.status(response.status);
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);

    const buf = Buffer.from(await response.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).json({
      error: "Shelby proxy failed",
      details: String(err),
      targetUrl,
    });
  }
}
