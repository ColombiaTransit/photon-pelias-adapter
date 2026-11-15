// Translate Photon (GeoJSON) responses into the Pelias format Digitransit-UI expects.

const CONFIDENCE_BOOST_STATION = 4;
const CONFIDENCE_BOOST_STOP = 2;

// Colombian house numbers name the crossing street and the distance to it:
// "5-20", "12A-34", "45 - 10", "23 Bis-15". They are written "Calle 26 # 5-20".
const COLOMBIAN_HOUSENUMBER = /^\d+\s*[A-Za-z]?(\s*bis)?\s*[A-Za-z]?\s*-\s*\d+/i;

const DEFAULT_OPTIONS = {
  // include the postcode in labels ("Bogotá" vs "110111 Bogotá")
  postcode: false,
};

const formatAddress = (street, housenumber) => {
  if (!housenumber) {
    return street;
  }
  if (COLOMBIAN_HOUSENUMBER.test(housenumber.trim())) {
    return `${street} # ${housenumber.trim()}`;
  }
  return `${street} ${housenumber}`.trim();
};

const getLabel = (properties, options = DEFAULT_OPTIONS) => {
  const { name, street, housenumber, postalcode, city } = properties;
  const result = [];
  if (name) {
    result.push(name);
  }
  if (street) {
    result.push(formatAddress(street, housenumber));
  }
  if (city) {
    const pc = options.postcode && postalcode ? `${postalcode} ` : "";
    result.push(`${pc}${city}`);
  }
  return result.join(", ");
};

// If we already have a name, we keep it. Exact addresses (with house numbers)
// don't have a name, so we use the label instead.
const getName = (properties) => properties.name || properties.label;

const translateResults = (photonResult, gtfsDataset = "", options = DEFAULT_OPTIONS) => {
  const peliasResponse = { features: [] };
  (photonResult.features || []).forEach((feature, idx) => {
    const p = feature.properties;
    if (p.state) {
      p.region = p.state;
      delete p.state;
    }
    if (p.postcode) {
      p.postalcode = p.postcode;
      delete p.postcode;
    }
    if (p.city) {
      p.locality = p.city;
    }

    // In Digitransit the name is shown on the first line and the label on the second.
    p.label = getLabel(p, options);
    p.name = getName(p);

    if (p.osm_value == "bus_stop" || p.osm_value == "tram_stop") {
      p.layer = "stop";
    } else if (p.osm_key == "railway" && (p.osm_value == "station" || p.osm_value == "halt")) {
      p.layer = "station";
    } else {
      // `venue` is also used for addresses; for Digitransit that does not matter.
      p.layer = "venue";
    }

    if (p.extra && p.extra["ref:IFOPT"]) {
      let ifoptid = p.extra["ref:IFOPT"];
      const parentId = /^\w*:\w*:\w*/.exec(ifoptid);
      if (parentId) {
        ifoptid = parentId[0];
      }
      p.id = "GTFS:" + gtfsDataset + ":" + ifoptid;
    }

    let confidence = 100 - idx;
    if (p.layer == "stop") {
      confidence += CONFIDENCE_BOOST_STOP;
    } else if (p.layer == "station") {
      confidence += CONFIDENCE_BOOST_STATION;
    }
    p.confidence = confidence / 100;
    p.source = "openstreetmap";

    peliasResponse.features.push(feature);
  });
  return peliasResponse;
};

// Nothing found near the point: return the coordinates themselves, so the UI
// can still use the location.
const coordinateFeature = (lat, lon) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [Number(lon), Number(lat)] },
  properties: {
    name: `${lat}, ${lon}`,
    label: `${lat}, ${lon}`,
    layer: "venue",
    source: "openstreetmap",
    country: null,
    countrycode: null,
    region: null,
    locality: null,
    postalcode: null,
    street: null,
  },
});

const translateReverseGeocoding = (lat, lon, results, options = DEFAULT_OPTIONS) => {
  if (!results.features || results.features.length === 0) {
    return { features: [coordinateFeature(lat, lon)] };
  }
  return translateResults(results, "", options);
};

module.exports = {
  translateResults,
  translateReverseGeocoding,
  formatAddress,
  DEFAULT_OPTIONS,
};
