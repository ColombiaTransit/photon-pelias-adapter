// photon-pelias-adapter: answers the Pelias API calls of Digitransit-UI with Photon.
//
//   /v1/search    -> Photon /api
//   /v1/reverse   -> Photon /reverse
//   /v1/place     -> empty result (Photon has no lookup by id)
//   /health       -> 200, for container health checks
//
// Configuration (environment):
//   PHOTON_URL           Photon base URL                    (https://photon.komoot.io)
//   PORT                 listen port                        (8080)
//   PHOTON_LANGUAGES     languages the Photon index has     (default,en,de,fr,it)
//                        other `lang` values are sent as "default" (local names)
//   PHOTON_TIMEOUT_MS    timeout of a Photon request        (10000)
//   LABEL_POSTCODE       "true" to show postcodes in labels (false)

const http = require("http");
const { translateResults, translateReverseGeocoding } = require("./translate.js");

const PHOTON_URL = (process.env.PHOTON_URL || "https://photon.komoot.io").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8080);
const PHOTON_TIMEOUT_MS = Number(process.env.PHOTON_TIMEOUT_MS || 10000);
const PHOTON_LANGUAGES = (process.env.PHOTON_LANGUAGES || "default,en,de,fr,it")
  .split(",")
  .map((l) => l.trim().toLowerCase())
  .filter(Boolean);
const OPTIONS = { postcode: /^(1|true|yes)$/i.test(process.env.LABEL_POSTCODE || "") };

const MAX_SIZE = 40;

const OSM_TAG_FILTERS = [
  "!amenity:car_sharing",
  "!amenity:bike_rental",
  "!historic:memorial",
  "!boundary",
  "!landuse:construction",
  "!highway:service",
  // exclude unnecessarily detailed public transport nodes
  ":!stop_position",
  ":!platform",
  "!tunnel:yes",
  "!place:county",
  "!railway:razed",
  "!landuse:military",
];

const DEFAULT_ZOOM_FACTOR = 14;
const DEFAULT_LOCATION_BIAS_SCALE = 0.5;

// Pelias `lang` -> a language Photon knows; unknown ones get local names.
const photonLanguage = (lang) => {
  const l = (lang || "").toLowerCase().split(/[-_]/)[0];
  return PHOTON_LANGUAGES.includes(l) ? l : "default";
};

const sizeParam = (size) => {
  const n = parseInt(size, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_SIZE) : null;
};

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
};

class UpstreamError extends Error {}

const fetchPhoton = async (url) => {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS) });
  } catch (e) {
    throw new UpstreamError(`request failed: ${e.cause?.code || e.name || e.message}`);
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    throw new UpstreamError(`HTTP ${response.status}: ${text}`);
  }
  const json = await response.json();
  if (!json || !Array.isArray(json.features)) {
    throw new UpstreamError("response without features");
  }
  return json;
};

// Details go to the log; clients get a generic message without internal hosts.
const upstreamFailed = (res, what, err) => {
  console.error(`${new Date().toISOString()} photon ${what} ${err.message}`);
  sendJson(res, 502, { error: "geocoding service unavailable", features: [] });
};

const emptyResult = (res, reason) => sendJson(res, 200, { error: reason, features: [] });

const buildSearchUrl = (params) => {
  const q = new URLSearchParams();
  q.set("q", params.get("text") || "");
  q.set("lang", photonLanguage(params.get("lang")));
  const limit = sizeParam(params.get("size"));
  if (limit) q.set("limit", String(limit));

  const [minLat, maxLat, minLon, maxLon] = [
    "boundary.rect.min_lat",
    "boundary.rect.max_lat",
    "boundary.rect.min_lon",
    "boundary.rect.max_lon",
  ].map((k) => params.get(k));
  if (minLat && maxLat && minLon && maxLon) {
    q.set("bbox", `${minLon},${minLat},${maxLon},${maxLat}`);
  }

  const lat = params.get("focus.point.lat");
  const lon = params.get("focus.point.lon");
  if (lat && lon) {
    q.set("lat", lat);
    q.set("lon", lon);
    q.set("zoom", String(DEFAULT_ZOOM_FACTOR));
    q.set("location_bias_scale", String(DEFAULT_LOCATION_BIAS_SCALE));
  }
  OSM_TAG_FILTERS.forEach((f) => q.append("osm_tag", f));
  return `${PHOTON_URL}/api/?${q}`;
};

const buildReverseUrl = (params) => {
  const q = new URLSearchParams();
  q.set("lat", params.get("point.lat"));
  q.set("lon", params.get("point.lon"));
  q.set("lang", photonLanguage(params.get("lang")));
  const limit = sizeParam(params.get("size"));
  if (limit) q.set("limit", String(limit));
  const radius = parseFloat(params.get("boundary.circle.radius")); // km in both APIs
  if (Number.isFinite(radius) && radius > 0) q.set("radius", String(radius));
  return `${PHOTON_URL}/reverse?${q}`;
};

async function search(params, res) {
  if ((params.get("layers") || "").includes("bikestation")) {
    return emptyResult(res, "no bike stations");
  }
  const sources = (params.get("sources") || "").split(",").filter(Boolean);
  if (sources.length > 0 && sources.every((s) => s.startsWith("gtfs"))) {
    return emptyResult(res, "no gtfs");
  }
  if (!params.get("text")) {
    return sendJson(res, 400, { error: "text is required", features: [] });
  }
  try {
    const json = await fetchPhoton(buildSearchUrl(params));
    sendJson(res, 200, translateResults(json, "", OPTIONS));
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    upstreamFailed(res, "search", e);
  }
}

async function reverse(params, res) {
  const lat = params.get("point.lat");
  const lon = params.get("point.lon");
  if (!lat || !lon || !Number.isFinite(+lat) || !Number.isFinite(+lon)) {
    return sendJson(res, 400, { error: "point.lat and point.lon are required", features: [] });
  }
  try {
    const json = await fetchPhoton(buildReverseUrl(params));
    sendJson(res, 200, translateReverseGeocoding(lat, lon, json, OPTIONS));
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    upstreamFailed(res, "reverse", e);
  }
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  const route = pathname.replace(/\/+$/, "");
  const handle = {
    "/v1/search": () => search(searchParams, res),
    "/v1/reverse": () => reverse(searchParams, res),
    "/v1/place": () => emptyResult(res, "place lookup is not supported"),
    "/health": () => sendJson(res, 200, { status: "ok" }),
  }[route];
  if (!handle) {
    return sendJson(res, 404, { error: "path not found" });
  }
  Promise.resolve(handle()).catch((e) => {
    console.error(`${new Date().toISOString()} internal error`, e);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error", features: [] });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(
      `photon-pelias-adapter on :${PORT}, photon ${PHOTON_URL}, languages ${PHOTON_LANGUAGES.join(",")}`,
    );
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

module.exports = { server, photonLanguage, buildSearchUrl, buildReverseUrl };
