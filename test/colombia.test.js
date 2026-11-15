// Colombian labels, language mapping and the HTTP server against a fake Photon.
const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const http = require("http");

const { translateResults, translateReverseGeocoding, formatAddress } = require("../translate.js");

const photonFeature = (props, coords = [-74.0758, 4.5981]) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coords },
  properties: { osm_type: "N", osm_id: 1, osm_key: "place", osm_value: "house", ...props },
});

describe("Colombian labels", () => {
  it("writes Colombian house numbers with #", () => {
    assert.equal(formatAddress("Calle 26", "5-20"), "Calle 26 # 5-20");
    assert.equal(formatAddress("Carrera 7", "12A-34"), "Carrera 7 # 12A-34");
    assert.equal(formatAddress("Avenida Boyacá", "23 Bis-15"), "Avenida Boyacá # 23 Bis-15");
    assert.equal(formatAddress("Calle 26", "45 - 10"), "Calle 26 # 45 - 10");
    assert.equal(formatAddress("Hauptstraße", "12"), "Hauptstraße 12");
    assert.equal(formatAddress("Calle 26", undefined), "Calle 26");
  });

  it("builds labels without postcode by default", () => {
    const { features } = translateResults({
      features: [
        photonFeature({ street: "Calle 26", housenumber: "5-20", city: "Bogotá", postcode: "110311" }),
        photonFeature({ name: "Museo del Oro", street: "Carrera 6", housenumber: "15-88", city: "Bogotá" }),
      ],
    });
    assert.equal(features[0].properties.label, "Calle 26 # 5-20, Bogotá");
    assert.equal(features[0].properties.name, "Calle 26 # 5-20, Bogotá");
    assert.equal(features[0].properties.postalcode, "110311");
    assert.equal(features[1].properties.name, "Museo del Oro");
    assert.equal(features[1].properties.label, "Museo del Oro, Carrera 6 # 15-88, Bogotá");
  });

  it("reverse without results returns the coordinates, not a made-up place", () => {
    const { features } = translateReverseGeocoding("4.6565", "-74.1223", { features: [] });
    assert.equal(features.length, 1);
    assert.equal(features[0].properties.label, "4.6565, -74.1223");
    assert.equal(features[0].properties.locality, null);
    assert.deepEqual(features[0].geometry.coordinates, [-74.1223, 4.6565]);
  });
});

describe("HTTP server", () => {
  let photon;
  let adapter;
  let base;
  const seen = [];
  let photonMode = "ok";

  before(async () => {
    photon = http.createServer((req, res) => {
      seen.push(new URL(req.url, "http://photon"));
      if (photonMode === "error") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end('{"message":"Language is not supported"}');
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      const empty = new URL(req.url, "http://photon").searchParams.get("lat") === "0";
      res.end(
        JSON.stringify({
          features: empty
            ? []
            : [photonFeature({ street: "Calle 26", housenumber: "5-20", city: "Bogotá" })],
        }),
      );
    });
    await new Promise((r) => photon.listen(0, "127.0.0.1", r));
    process.env.PHOTON_URL = `http://127.0.0.1:${photon.address().port}/`;
    delete require.cache[require.resolve("../index.js")];
    adapter = require("../index.js").server;
    await new Promise((r) => adapter.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${adapter.address().port}`;
  });

  after(() => {
    adapter.close();
    photon.close();
  });

  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };

  it("maps search parameters to Photon", async () => {
    seen.length = 0;
    const { status, body } = await get(
      "/v1/search?text=calle%2026&lang=es&size=3" +
        "&boundary.rect.min_lat=-4.2&boundary.rect.max_lat=16&boundary.rect.min_lon=-82&boundary.rect.max_lon=-66" +
        "&focus.point.lat=4.6&focus.point.lon=-74.1",
    );
    assert.equal(status, 200);
    assert.equal(body.features[0].properties.label, "Calle 26 # 5-20, Bogotá");
    const q = seen[0].searchParams;
    assert.equal(seen[0].pathname, "/api/");
    assert.equal(q.get("q"), "calle 26");
    assert.equal(q.get("lang"), "default"); // es is not in the Photon index
    assert.equal(q.get("limit"), "3");
    assert.equal(q.get("bbox"), "-82,-4.2,-66,16");
    assert.equal(q.get("lat"), "4.6");
    assert.ok(q.getAll("osm_tag").includes(":!platform"));
  });

  it("keeps supported languages", async () => {
    seen.length = 0;
    await get("/v1/search?text=museo&lang=en-US");
    assert.equal(seen[0].searchParams.get("lang"), "en");
  });

  it("maps reverse parameters, including size and radius", async () => {
    seen.length = 0;
    const { status, body } = await get(
      "/v1/reverse?point.lat=4.6565&point.lon=-74.1223&boundary.circle.radius=0.1&lang=es&size=1&layers=address&zones=1",
    );
    assert.equal(status, 200);
    assert.equal(body.features.length, 1);
    const q = seen[0].searchParams;
    assert.equal(seen[0].pathname, "/reverse");
    assert.equal(q.get("limit"), "1");
    assert.equal(q.get("radius"), "0.1");
    assert.equal(q.get("lang"), "default");
  });

  it("reverse with nothing found returns the coordinates", async () => {
    const { body } = await get("/v1/reverse?point.lat=0&point.lon=0");
    assert.equal(body.features[0].properties.label, "0, 0");
  });

  it("returns empty results for GTFS-only searches and place lookups", async () => {
    seen.length = 0;
    assert.deepEqual((await get("/v1/search?text=portal&sources=gtfsbogota,gtfschia")).body.features, []);
    assert.deepEqual((await get("/v1/place?ids=openstreetmap:venue:N1")).body.features, []);
    assert.equal(seen.length, 0);
  });

  it("hides upstream errors and internal host names", async () => {
    photonMode = "error";
    try {
      const { status, body } = await get("/v1/search?text=x");
      assert.equal(status, 502);
      assert.equal(body.error, "geocoding service unavailable");
      assert.ok(!JSON.stringify(body).includes("127.0.0.1"));
    } finally {
      photonMode = "ok";
    }
  });

  it("answers health checks and rejects bad requests", async () => {
    assert.equal((await get("/health")).status, 200);
    assert.equal((await get("/v1/reverse?point.lat=a&point.lon=b")).status, 400);
    assert.equal((await get("/v1/search")).status, 400);
    assert.equal((await get("/nope")).status, 404);
  });
});
