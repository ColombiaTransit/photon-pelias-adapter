photon-pelias-adapter is a small API proxy that answers the Pelias geocoder requests of
[Digitransit-UI](https://github.com/HSLdevcom/digitransit-ui/) with [Photon](https://github.com/komoot/photon)
for places and addresses, and with [OpenTripPlanner](https://www.opentripplanner.org/) for public
transport stops and stations.
ColombiaTransit uses it for https://colombiatransit.co.

## Supported Pelias APIs

| Pelias | Photon | Parameters |
|---|---|---|
| Pelias | Backend | Parameters |
|---|---|---|
| `/v1/search` | Photon `/api` | `text`, `lang`, `size`, `boundary.rect.*`, `focus.point.*` |
| `/v1/search` with `sources=gtfs<feed>,…` | OTP stop index | also `layers=stop,station`, `dedupestops=1` |
| `/v1/reverse` | Photon `/reverse` | `point.lat`, `point.lon`, `lang`, `size`, `boundary.circle.radius` (km) |
| `/v1/place` | OTP stop index | `ids` with GTFS gids (favourite stops); other ids give an empty result |
| `/health` | – | 200 for container health checks; with `OTP_URL` also the number of stops loaded |

Bike stations (`layers=bikestation`) get an empty result.

### Stops and stations

With `OTP_URL` set, the adapter loads all stops and stations from OTP's GTFS GraphQL API at start
and once a day at `OTP_REFRESH_TIME`, after the nightly graph update; when OTP is unreachable it
keeps the last index and tries again on a later request. After a graph update at another time,
restart the adapter to pick up new stops right away. Results have the
format of Pelias' GTFS importer, so Digitransit shows them as stops and opens the stop page:
`gid = gtfs<feed>:stop:GTFS:<feed>:<id>#<code>`, `layer` stop or station, `addendum.GTFS.modes`.

Matching is made for Colombian stop names:

- accents and punctuation are ignored: `estacion` finds *Estación*;
- street types are unified: `Cll.`, `Cl`, `Calle` → calle; `Cra.`, `Kr`, `K`, `Carrera` → carrera;
  also `Av`, `AK`, `AC`, `Tv`, `Dg`, …; `con`, `x` and `-` between streets are ignored;
- word order does not matter (`carrera 11 calle 72` finds *Cll. 72 - Cra. 11*), and the last word
  may be unfinished, so search-as-you-type works;
- exact names rank first, stations above their stops, and nearer stops above far ones when the UI
  sends a focus point;
- `dedupestops=1` gives one result per stop: no platforms next to their station and no second
  stop with the same name within 300 m (the other direction).

Behaviour:

- **Languages**: `lang` is passed on when the Photon index has that language (`PHOTON_LANGUAGES`);
  otherwise `default` is used, i.e. the local names (Spanish in Colombia).
- **Labels**: Colombian house numbers are written with `#`: `Calle 26 # 5-20, Bogotá`. Postcodes
  are left out unless `LABEL_POSTCODE=true`.
- **Errors**: when Photon fails, clients get `502 {"error": "geocoding service unavailable"}`; the
  details (including internal host names) only go to the container log.

## Configuration

| Variable | Default | |
|---|---|---|
| `PHOTON_URL` | `https://photon.komoot.io` (image: `http://photon:2322`) | Photon base URL |
| `PORT` | `8080` | listen port |
| `PHOTON_LANGUAGES` | `default,en,de,fr,it` | languages in the Photon index |
| `PHOTON_TIMEOUT_MS` | `10000` | timeout per Photon request |
| `LABEL_POSTCODE` | `false` | show postcodes in labels |
| `OTP_URL` | – (off) | OTP GTFS GraphQL endpoint, e.g. `http://otp-colombia:8080/otp/gtfs/v1` |
| `OTP_REFRESH_TIME` | `06:00` | daily reload of the stop index; set it after the graph update of OTP (03:15 in otp-docker) has finished |
| `OTP_TIMEZONE` | `America/Bogota` | time zone of `OTP_REFRESH_TIME` |
| `FEED_LABELS` | – | area per feed in stop labels, e.g. `bogota=Bogotá,medellin=Medellín`; a stop's GTFS `stop_desc` takes precedence |

## Run

Requires Node 20 or newer; there are no dependencies.

```sh
PHOTON_URL=http://localhost:2322 node index.js
curl 'http://localhost:8080/v1/search?text=Museo%20del%20Oro'
npm test
```

## Docker

Every push to `master` that passes the tests publishes
`ghcr.io/colombiatransit/photon-pelias-adapter` (`latest`, `YYYYMMDD`, `sha-<commit>`).

```yaml
services:
  photon-pelias-adapter:
    image: ghcr.io/colombiatransit/photon-pelias-adapter:latest
    restart: unless-stopped
    environment:
      PHOTON_URL: http://photon:2322
      OTP_URL: http://otp-colombia:8080/otp/gtfs/v1
      FEED_LABELS: bogota=Bogotá,medellin=Medellín,cali=Cali,monserrate=Bogotá,chia=Chía
    networks: [default, traefik]
    # "photon" resolves on the network of the photon container, "otp-colombia" on traefik_default

networks:
  traefik:
    external: true
    name: traefik_default
```
