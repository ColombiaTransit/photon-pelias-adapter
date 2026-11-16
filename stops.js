// GTFS stop and station search from OpenTripPlanner, in Pelias format.
//
// Digitransit-UI searches stops and stations through the geocoder
// (sources=gtfs<feed>, layers=stop,station) and refreshes favourite stops with
// /v1/place?ids=gtfs<feed>:stop:GTFS:<feed>:<id>#<code>. Photon has no GTFS data,
// so these requests are answered from an in-memory index of all stops and
// stations, loaded from OTP's GTFS GraphQL API at start and reloaded once a day,
// after the nightly graph update (OTP_REFRESH_TIME).
//
// Matching is made for Colombian names: accents are ignored, street type
// abbreviations are unified (Cll./Cl./Calle, Cra./Kr./Carrera, ...), word order
// does not matter and the last word may be incomplete (search as you type).

const ALL_STOPS_QUERY = `{
  stops { gtfsId name code lat lon vehicleMode platformCode desc parentStation { gtfsId } }
  stations { gtfsId name code lat lon stops { vehicleMode } }
}`;

// abbreviation -> canonical words
const ABBREVIATIONS = {
  cl: ["calle"], cll: ["calle"], cal: ["calle"], call: ["calle"], clle: ["calle"],
  cra: ["carrera"], kra: ["carrera"], kr: ["carrera"], cr: ["carrera"], carr: ["carrera"], k: ["carrera"],
  av: ["avenida"], avda: ["avenida"], ave: ["avenida"],
  ak: ["avenida", "carrera"], ac: ["avenida", "calle"],
  tv: ["transversal"], tr: ["transversal"], trans: ["transversal"], tranv: ["transversal"],
  dg: ["diagonal"], diag: ["diagonal"],
  aut: ["autopista"], autop: ["autopista"],
  br: ["barrio"], bo: ["barrio"],
  est: ["estacion"],
  cc: ["centro", "comercial"],
};

const abbreviation = (t) => (Object.hasOwn(ABBREVIATIONS, t) ? ABBREVIATIONS[t] : null);

// words that only connect parts of a name ("Calle 72 con Carrera 35")
const CONNECTORS = new Set(["con", "y", "x", "entre", "no", "n", "nro"]);

const normalizeText = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // split letters from a leading number: "cll.76" -> "cll 76", "cra5" -> "cra 5"
    .replace(/([a-z])\.?(?=\d)/g, "$1 ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokenize = (s) => {
  const out = [];
  for (const t of normalizeText(s).split(" ")) {
    if (!t || CONNECTORS.has(t)) continue;
    out.push(...(abbreviation(t) || [t]));
  }
  return out;
};

// The query as typed may end in an abbreviation that is also the start of a word
// ("cr" -> carrera, or Cruz). Try both readings of the last word.
const queryVariants = (s) => {
  const words = normalizeText(s).split(" ").filter((t) => t && !CONNECTORS.has(t));
  const full = tokenize(s);
  const last = words[words.length - 1];
  if (!last || !abbreviation(last)) return [full];
  return [full, [...tokenize(words.slice(0, -1).join(" ")), last]];
};

// Milliseconds from `now` until the next "HH:MM" in the given time zone.
const msUntilNext = (hhmm, timeZone, now = new Date()) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const nowSec = parts.hour * 3600 + parts.minute * 60 + parts.second;
  let delta = (h * 3600 + m * 60 - nowSec + 86400) % 86400;
  if (delta === 0) delta = 86400;
  return delta * 1000 - now.getMilliseconds();
};

const distanceKm = (lat1, lon1, lat2, lon2) => {
  const r = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

const feedOf = (gtfsId) => gtfsId.split(":")[0].toLowerCase();

const parseFeedLabels = (s) =>
  Object.fromEntries(
    String(s || "")
      .split(",")
      .map((p) => p.split("="))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
  );

// Score how well the query tokens match a name: every query token must match a
// name token, the last one may be a prefix. Returns null when it does not match.
const matchScore = (queryTokens, nameTokens) => {
  if (queryTokens.length === 0) return null;
  const used = new Set();
  let score = 0;
  for (let i = 0; i < queryTokens.length; i++) {
    const q = queryTokens[i];
    const last = i === queryTokens.length - 1;
    let found = nameTokens.findIndex((t, j) => !used.has(j) && t === q);
    let points = 10;
    if (found === -1 && last && !/^\d+$/.test(q)) {
      found = nameTokens.findIndex((t, j) => !used.has(j) && t.startsWith(q));
      points = 6;
    } else if (found === -1 && last) {
      // a number being typed: "calle 7" may become "calle 72"
      found = nameTokens.findIndex((t, j) => !used.has(j) && t.startsWith(q));
      points = 4;
    }
    if (found === -1) return null;
    used.add(found);
    score += points;
    if (found === i) score += 1; // same word order
  }
  if (queryTokens.length === nameTokens.length) score += 8; // whole name typed
  score -= 0.5 * (nameTokens.length - queryTokens.length); // prefer specific names
  return score;
};

class StopIndex {
  constructor({
    otpUrl,
    refreshTime = "06:00",
    timeZone = "America/Bogota",
    timeoutMs = 30000,
    feedLabels = {},
    log = console,
  }) {
    this.otpUrl = otpUrl;
    this.refreshTime = refreshTime;
    this.timeZone = timeZone;
    this.timeoutMs = timeoutMs;
    this.feedLabels = feedLabels;
    this.log = log;
    this.entries = [];
    this.byId = new Map();
    this.loadedAt = 0;
    this.nextRefresh = 0; // load on first use
    this.lastAttempt = 0;
    this.loading = null;
  }

  get enabled() {
    return Boolean(this.otpUrl);
  }

  async load() {
    const res = await fetch(this.otpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: ALL_STOPS_QUERY }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`OTP HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors || !json.data) throw new Error(`OTP GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);

    const entries = [];
    for (const s of json.data.stations || []) {
      if (s.lat == null || s.lon == null) continue;
      const modes = [...new Set((s.stops || []).map((c) => c.vehicleMode).filter(Boolean))];
      entries.push(this.entry(s, "station", modes));
    }
    for (const s of json.data.stops || []) {
      if (s.lat == null || s.lon == null) continue;
      entries.push(this.entry(s, "stop", s.vehicleMode ? [s.vehicleMode] : [], s.parentStation?.gtfsId));
    }
    this.entries = entries;
    this.byId = new Map(entries.map((e) => [e.gtfsId, e]));
    this.loadedAt = Date.now();
    this.nextRefresh = this.loadedAt + msUntilNext(this.refreshTime, this.timeZone);
    const count = (layer) => entries.filter((e) => e.layer === layer).length;
    const perFeed = {};
    for (const e of entries) perFeed[e.feed] = (perFeed[e.feed] || 0) + 1;
    const feeds = Object.entries(perFeed)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([f, n]) => `${f}=${n}`)
      .join(" ");
    const skipped = (json.data.stops || []).length + (json.data.stations || []).length - entries.length;
    this.log.log(
      `${new Date().toISOString()} stop index loaded from OTP: ${count("stop")} stops, ` +
        `${count("station")} stations` +
        (skipped ? `, ${skipped} skipped without coordinates` : "") +
        `; per feed: ${feeds}; next reload ${new Date(this.nextRefresh).toISOString()}`,
    );
  }

  entry(s, layer, modes, parent) {
    return {
      gtfsId: s.gtfsId,
      feed: feedOf(s.gtfsId),
      layer,
      name: s.name,
      code: s.code || null,
      platform: s.platformCode || null,
      desc: s.desc || null,
      lat: s.lat,
      lon: s.lon,
      modes,
      parent: parent || null,
      tokens: tokenize(s.name),
      norm: normalizeText(s.name),
    };
  }

  // Load on first use and reload once a day in the background. A failed load
  // keeps the old index and is retried at most once a minute, on the next request.
  async ensure() {
    if (!this.enabled) return;
    const now = Date.now();
    const stale = now >= this.nextRefresh;
    const mayRetry = now - this.lastAttempt > 60000;
    if (stale && mayRetry && !this.loading) {
      this.lastAttempt = now;
      this.loading = this.load()
        .catch((e) => this.log.error(`${new Date().toISOString()} stop index refresh failed: ${e.message}`))
        .finally(() => {
          this.loading = null;
        });
    }
    if (this.entries.length === 0 && this.loading) await this.loading;
  }

  feature(e, confidence = 1) {
    const suffix = e.code ? `#${e.code}` : "";
    const area = e.desc || this.feedLabels[e.feed] || null;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.lon, e.lat] },
      properties: {
        id: `GTFS:${e.gtfsId}${suffix}`,
        gid: `gtfs${e.feed}:${e.layer}:GTFS:${e.gtfsId}${suffix}`,
        layer: e.layer,
        source: `gtfs${e.feed}`,
        name: e.name,
        label: area ? `${e.name}, ${area}` : e.name,
        locality: this.feedLabels[e.feed] || null,
        confidence,
        addendum: { GTFS: { modes: e.modes, ...(e.platform ? { platform: e.platform } : {}) } },
      },
    };
  }

  search(text, { feeds = null, layers = null, focus = null, bbox = null, size = 10, dedupe = false } = {}) {
    const variants = queryVariants(text).filter((v) => v.length > 0);
    if (variants.length === 0) return [];
    const hits = [];
    for (const e of this.entries) {
      if (feeds && !feeds.has(e.feed)) continue;
      if (layers && !layers.has(e.layer)) continue;
      if (bbox && (e.lat < bbox.minLat || e.lat > bbox.maxLat || e.lon < bbox.minLon || e.lon > bbox.maxLon)) continue;
      let score = null;
      for (const q of variants) {
        const sc = matchScore(q, e.tokens);
        if (sc !== null && (score === null || sc > score)) score = sc;
      }
      if (score === null) continue;
      if (e.layer === "station") score += 3;
      if (focus) score -= 3 * Math.log1p(distanceKm(focus.lat, focus.lon, e.lat, e.lon));
      hits.push({ e, score });
    }
    hits.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));

    const result = [];
    for (const { e, score } of hits) {
      if (dedupe && this.isDuplicate(e, result)) continue;
      result.push({ e, score });
      if (result.length >= size) break;
    }
    const top = result.length ? result[0].score : 1;
    return result.map(({ e, score }) => this.feature(e, Math.max(0.1, Math.min(1, score / Math.max(top, 1)))));
  }

  // One result per stop: drop a stop when its station, or a stop with the same
  // name nearby (the other direction), is already in the results.
  isDuplicate(e, kept) {
    return kept.some(({ e: k }) => {
      if (e.parent && k.gtfsId === e.parent) return true;
      if (k.norm !== e.norm || k.feed !== e.feed) return false;
      return distanceKm(k.lat, k.lon, e.lat, e.lon) < (k.layer === "station" ? 0.5 : 0.3);
    });
  }

  // gids like "gtfsbogota:stop:GTFS:bogota:12345#678"
  place(gids) {
    const out = [];
    for (const gid of gids) {
      const m = /GTFS:([^#]+)/.exec(gid);
      const e = m && this.byId.get(m[1]);
      if (e) out.push(this.feature(e));
    }
    return out;
  }
}

module.exports = { StopIndex, msUntilNext, tokenize, queryVariants, normalizeText, matchScore, parseFeedLabels };
