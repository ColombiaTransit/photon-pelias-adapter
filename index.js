// photon-pelias-adapter: answers the Pelias API calls of Digitransit-UI with Photon,
// and GTFS stop and station searches with OpenTripPlanner.
//
//   /v1/search    -> Photon /api, plus stops/stations from OTP for gtfs<feed> sources
//   /v1/reverse   -> Photon /reverse
//   /v1/place     -> GTFS stops and stations by gid (from OTP); other ids give nothing
//   /health       -> 200, for container health checks
//
// Configuration (environment):
//   PHOTON_URL           Photon base URL                    (https://photon.komoot.io)
//   PORT                 listen port                        (8080)
//   PHOTON_LANGUAGES     languages the Photon index has     (default,en,de,fr,it)
//                        other `lang` values are sent as "default" (local names)
//   PHOTON_TIMEOUT_MS    timeout of a Photon request        (10000)
//   LABEL_POSTCODE       "true" to show postcodes in labels (false)
//   OTP_URL              OTP GTFS GraphQL endpoint for stop and station search,
//                        e.g. http://otp-colombia:8080/otp/gtfs/v1 (off when empty)
//   OTP_REFRESH_TIME     daily reload of the stop index, after the graph update,
//                        in OTP_TIMEZONE                    (06:00)
//   OTP_TIMEZONE         time zone of OTP_REFRESH_TIME      (America/Bogota)
//   FEED_LABELS          area per feed for stop labels, "bogota=Bogotá,cali=Cali"

const http = require("http");
const { translateResults, translateReverseGeocoding } = require("./translate.js");
const { StopIndex, parseFeedLabels } = require("./stops.js");

const PHOTON_URL = (process.env.PHOTON_URL || "https://photon.komoot.io").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 8080);
const PHOTON_TIMEOUT_MS = Number(process.env.PHOTON_TIMEOUT_MS || 10000);
const PHOTON_LANGUAGES = (process.env.PHOTON_LANGUAGES || "default,en,de,fr,it")
  .split(",")
  .map((l) => l.trim().toLowerCase())
  .filter(Boolean);
const OPTIONS = { postcode: /^(1|true|yes)$/i.test(process.env.LABEL_POSTCODE || "") };

const MAX_SIZE = 40;

const stopIndex = new StopIndex({
  otpUrl: process.env.OTP_URL || "",
  refreshTime: process.env.OTP_REFRESH_TIME || "06:00",
  timeZone: process.env.OTP_TIMEZONE || "America/Bogota",
  feedLabels: parseFeedLabels(process.env.FEED_LABELS),
});
const STOP_LAYERS = ["stop", "station"];

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

const featureCollection = (features) => ({ type: "FeatureCollection", features });

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

const listParam = (params, name) =>
  (params.get(name) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const bboxParam = (params) => {
  const v = ["min_lat", "max_lat", "min_lon", "max_lon"].map((k) =>
    parseFloat(params.get(`boundary.rect.${k}`)),
  );
  if (!v.every(Number.isFinite)) return null;
  return { minLat: v[0], maxLat: v[1], minLon: v[2], maxLon: v[3] };
};

const focusParam = (params) => {
  const lat = parseFloat(params.get("focus.point.lat"));
  const lon = parseFloat(params.get("focus.point.lon"));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
};

// Which backends a search needs. Digitransit asks for stops with
// sources=gtfs<feed>,... and layers=stop,station; everything else is Photon.
const searchPlan = (params) => {
  const sources = listParam(params, "sources");
  const layers = listParam(params, "layers");
  const gtfsFeeds = sources.filter((s) => s.startsWith("gtfs")).map((s) => s.slice(4));
  const otherSources = sources.filter((s) => !s.startsWith("gtfs"));
  const stopLayers = layers.length ? layers.filter((l) => STOP_LAYERS.includes(l)) : STOP_LAYERS;
  const placeLayers = layers.filter((l) => !STOP_LAYERS.includes(l) && l !== "bikestation");
  return {
    stops:
      stopIndex.enabled &&
      stopLayers.length > 0 &&
      (gtfsFeeds.length > 0 || (sources.length === 0 && layers.length > 0)),
    feeds: gtfsFeeds.length ? new Set(gtfsFeeds) : null,
    stopLayers: new Set(stopLayers),
    photon: (sources.length === 0 || otherSources.length > 0) && (layers.length === 0 || placeLayers.length > 0),
  };
};

async function search(params, res) {
  const text = params.get("text");
  if (!text) {
    return sendJson(res, 400, { error: "text is required", features: [] });
  }
  const plan = searchPlan(params);
  const size = sizeParam(params.get("size")) || 10;

  let stops = [];
  if (plan.stops) {
    await stopIndex.ensure();
    stops = stopIndex.search(text, {
      feeds: plan.feeds,
      layers: plan.stopLayers,
      focus: focusParam(params),
      bbox: bboxParam(params),
      size,
      dedupe: params.get("dedupestops") === "1",
    });
  }
  if (!plan.photon) {
    return sendJson(res, 200, featureCollection(stops));
  }
  try {
    const json = await fetchPhoton(buildSearchUrl(params));
    const places = translateResults(json, "", OPTIONS);
    places.features = [...stops, ...places.features].slice(0, Math.max(size, stops.length));
    sendJson(res, 200, places);
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    if (stops.length > 0) {
      console.error(`${new Date().toISOString()} photon search ${e.message} (stops only)`);
      return sendJson(res, 200, featureCollection(stops));
    }
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

// Favourite stops and old searches are refreshed with
// /v1/place?ids=gtfs<feed>:stop:GTFS:<feed>:<id>#<code>,...
async function place(params, res) {
  const gids = (params.get("ids") || "").split(",").filter((id) => id.startsWith("gtfs"));
  if (!stopIndex.enabled || gids.length === 0) {
    return sendJson(res, 200, featureCollection([]));
  }
  await stopIndex.ensure();
  sendJson(res, 200, featureCollection(stopIndex.place(gids)));
}

const server = http.createServer((req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  const route = pathname.replace(/\/+$/, "");
  const handle = {
    "/v1/search": () => search(searchParams, res),
    "/v1/reverse": () => reverse(searchParams, res),
    "/v1/place": () => place(searchParams, res),
    "/health": () =>
      sendJson(res, 200, {
        status: "ok",
        ...(stopIndex.enabled ? { stops: stopIndex.entries.length } : {}),
      }),
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
      `photon-pelias-adapter on :${PORT}, photon ${PHOTON_URL}, ` +
        `languages ${PHOTON_LANGUAGES.join(",")}, stop search ${stopIndex.enabled ? "on" : "off"}`,
    );
    stopIndex.ensure(); // load the stop index right away, not on the first search
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

module.exports = { server, stopIndex, searchPlan, photonLanguage, buildSearchUrl, buildReverseUrl };
