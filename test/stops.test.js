// GTFS stop and station search from a fake OTP, in the format Digitransit-UI expects.
const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const http = require("http");

const { tokenize, queryVariants, msUntilNext, StopIndex } = require("../stops.js");

const OTP_DATA = {
  stations: [
    {
      gtfsId: "bogota:P1", name: "Portal Norte", code: null, lat: 4.7546, lon: -74.0461,
      stops: [{ vehicleMode: "BUS" }, { vehicleMode: "BUS" }],
    },
  ],
  stops: [
    { gtfsId: "bogota:101", name: "Portal Norte", code: "101A", lat: 4.7547, lon: -74.0462, vehicleMode: "BUS", platformCode: "A", desc: null, parentStation: { gtfsId: "bogota:P1" } },
    { gtfsId: "bogota:200", name: "Cll. 72 - Cra. 11", code: "200", lat: 4.6573, lon: -74.0588, vehicleMode: "BUS", platformCode: null, desc: null, parentStation: null },
    { gtfsId: "bogota:201", name: "Calle 72 con Carrera 11", code: "201", lat: 4.6575, lon: -74.0590, vehicleMode: "BUS", platformCode: null, desc: null, parentStation: null },
    { gtfsId: "bogota:202", name: "Calle 72 con Carrera 11", code: "202", lat: 4.6577, lon: -74.0592, vehicleMode: "BUS", platformCode: null, desc: null, parentStation: null },
    { gtfsId: "bogota:300", name: "Calle 7", code: null, lat: 4.59, lon: -74.08, vehicleMode: "BUS", platformCode: null, desc: null, parentStation: null },
    { gtfsId: "bogota:301", name: "Cruz Verde", code: null, lat: 4.58, lon: -74.09, vehicleMode: "BUS", platformCode: null, desc: null, parentStation: null },
    { gtfsId: "medellin:9", name: "Estación San Antonio", code: null, lat: 6.247, lon: -75.569, vehicleMode: "SUBWAY", platformCode: null, desc: "Centro", parentStation: null },
    { gtfsId: "cali:5", name: "Calle 72", code: null, lat: 3.47, lon: -76.5, vehicleMode: "BUS", platformCode: null, desc: null, parentStation: null },
  ],
};

describe("stop name matching", () => {
  it("unifies accents and Colombian street abbreviations", () => {
    assert.deepEqual(tokenize("Cll. 72 - Cra. 11"), ["calle", "72", "carrera", "11"]);
    assert.deepEqual(tokenize("Calle 72 con Carrera 11"), ["calle", "72", "carrera", "11"]);
    assert.deepEqual(tokenize("AK 30 x Cl 45"), ["avenida", "carrera", "30", "calle", "45"]);
    assert.deepEqual(tokenize("Estación San Antonio"), ["estacion", "san", "antonio"]);
    assert.deepEqual(tokenize("Cra5"), ["carrera", "5"]);
  });

  it("keeps an unfinished abbreviation as a prefix too", () => {
    assert.deepEqual(queryVariants("cr"), [["carrera"], ["cr"]]);
    assert.deepEqual(queryVariants("portal"), [["portal"]]);
  });
});

describe("HTTP server with OTP", () => {
  let otp;
  let adapter;
  let base;
  let otpRequests = 0;

  before(async () => {
    otp = http.createServer((req, res) => {
      otpRequests++;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        assert.match(JSON.parse(body).query, /stations/);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: OTP_DATA }));
      });
    });
    await new Promise((r) => otp.listen(0, "127.0.0.1", r));
    process.env.OTP_URL = `http://127.0.0.1:${otp.address().port}/otp/gtfs/v1`;
    process.env.FEED_LABELS = "bogota=Bogotá,medellin=Medellín";
    process.env.PHOTON_URL = "http://127.0.0.1:9"; // unreachable
    delete require.cache[require.resolve("../index.js")];
    adapter = require("../index.js").server;
    await new Promise((r) => adapter.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${adapter.address().port}`;
  });

  after(() => {
    adapter.close();
    otp.close();
    delete process.env.OTP_URL;
    delete process.env.FEED_LABELS;
  });

  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  const STOPS = "&sources=gtfsbogota,gtfsmedellin,gtfscali&layers=stop,station";

  it("finds stations and stops in the Digitransit format", async () => {
    const { status, body } = await get(`/v1/search?text=portal%20nor${STOPS}`);
    assert.equal(status, 200);
    const [station, stop] = body.features;
    assert.equal(station.properties.layer, "station");
    assert.equal(station.properties.gid, "gtfsbogota:station:GTFS:bogota:P1");
    assert.equal(station.properties.id, "GTFS:bogota:P1");
    assert.equal(station.properties.source, "gtfsbogota");
    assert.equal(station.properties.label, "Portal Norte, Bogotá");
    assert.deepEqual(station.properties.addendum.GTFS.modes, ["BUS"]);
    assert.deepEqual(station.geometry.coordinates, [-74.0461, 4.7546]);
    assert.equal(stop.properties.gid, "gtfsbogota:stop:GTFS:bogota:101#101A");
    assert.equal(stop.properties.addendum.GTFS.platform, "A");
  });

  it("matches abbreviations, word order and accents", async () => {
    const names = async (text, extra = "") =>
      (await get(`/v1/search?text=${encodeURIComponent(text)}${STOPS}${extra}`)).body.features.map(
        (f) => f.properties.id,
      );
    assert.deepEqual((await names("carrera 11 calle 72")).sort(), ["GTFS:bogota:200#200", "GTFS:bogota:201#201", "GTFS:bogota:202#202"]);
    assert.ok((await names("estacion san antonio")).includes("GTFS:medellin:9"));
    assert.ok((await names("cr")).includes("GTFS:bogota:301")); // Cruz Verde, not only carrera
    // "Calle 7" typed: the exact stop first, then Calle 72...
    assert.equal((await names("calle 7", "&focus.point.lat=4.6&focus.point.lon=-74.08"))[0], "GTFS:bogota:300");
  });

  it("filters on feeds and bounding box and uses the focus point", async () => {
    const onlyCali = await get("/v1/search?text=calle%2072&sources=gtfscali&layers=stop,station");
    assert.deepEqual(onlyCali.body.features.map((f) => f.properties.id), ["GTFS:cali:5"]);
    const near = await get(`/v1/search?text=calle%2072${STOPS}&focus.point.lat=3.47&focus.point.lon=-76.5`);
    assert.equal(near.body.features[0].properties.id, "GTFS:cali:5");
    const box = await get(
      `/v1/search?text=calle%2072${STOPS}&boundary.rect.min_lat=4&boundary.rect.max_lat=5&boundary.rect.min_lon=-75&boundary.rect.max_lon=-74`,
    );
    assert.ok(box.body.features.every((f) => f.properties.source === "gtfsbogota"));
  });

  it("dedupestops keeps one result per stop", async () => {
    const all = await get(`/v1/search?text=portal%20norte${STOPS}`);
    assert.equal(all.body.features.length, 2);
    const one = await get(`/v1/search?text=portal%20norte${STOPS}&dedupestops=1`);
    assert.deepEqual(one.body.features.map((f) => f.properties.layer), ["station"]);
    const both = await get(`/v1/search?text=calle%2072%20con%20carrera%2011${STOPS}&dedupestops=1`);
    // 201 and 202 have the same name 25 m apart (two directions); 200 is written differently
    assert.equal(both.body.features.filter((f) => f.properties.name === "Calle 72 con Carrera 11").length, 1);
  });

  it("looks up stops by gid for favourites", async () => {
    const ids = ["gtfsbogota:stop:GTFS:bogota:101#101A", "gtfsmedellin:stop:GTFS:medellin:9", "gtfsbogota:stop:GTFS:bogota:nope"];
    const { body } = await get(`/v1/place?ids=${encodeURIComponent(ids.join(","))}`);
    assert.deepEqual(body.features.map((f) => f.properties.gid), ids.slice(0, 2));
    assert.equal(body.features[1].properties.label, "Estación San Antonio, Centro");
  });

  it("returns stops when Photon is down in a mixed search", async () => {
    const { status, body } = await get("/v1/search?text=portal&sources=osm,gtfsbogota");
    assert.equal(status, 200);
    assert.ok(body.features.length > 0);
  });

  it("loads OTP once and reports the index in /health", async () => {
    const { body } = await get("/health");
    assert.equal(body.stops, 9);
    assert.equal(otpRequests, 1);
  });
});

describe("stop index refresh", () => {
  it("reloads once a day at the configured time in Bogotá", () => {
    // 2026-11-16 05:30 in Bogotá (UTC-5) = 10:30 UTC
    const now = new Date("2026-11-16T10:30:00Z");
    assert.equal(msUntilNext("06:00", "America/Bogota", now), 30 * 60 * 1000);
    assert.equal(msUntilNext("05:30", "America/Bogota", now), 24 * 3600 * 1000);
    assert.equal(msUntilNext("05:00", "America/Bogota", now), 23.5 * 3600 * 1000);
  });

  it("does not reload before the next refresh time", async () => {
    let loads = 0;
    const index = new StopIndex({ otpUrl: "http://x/", log: { log() {}, error() {} } });
    index.load = async () => {
      loads++;
      index.entries = [{}];
      index.nextRefresh = Date.now() + 3600 * 1000;
    };
    await index.ensure();
    await index.ensure();
    await index.ensure();
    assert.equal(loads, 1);
  });

  it("keeps the old index when OTP fails", async () => {
    const index = new StopIndex({ otpUrl: "http://127.0.0.1:9/", log: { log() {}, error() {} } });
    index.entries = [{ gtfsId: "x:1" }];
    await index.ensure();
    await index.loading;
    assert.equal(index.entries.length, 1);
  });
});
