photon-pelias-adapter is a small API proxy that answers the Pelias geocoder requests of
[Digitransit-UI](https://github.com/HSLdevcom/digitransit-ui/) with [Photon](https://github.com/komoot/photon).
ColombiaTransit uses it for https://colombiatransit.co.

## Supported Pelias APIs

| Pelias | Photon | Parameters |
|---|---|---|
| `/v1/search` | `/api` | `text`, `lang`, `size`, `boundary.rect.*`, `focus.point.*`; `sources`/`layers` only to answer GTFS-only or bike station searches with an empty result |
| `/v1/reverse` | `/reverse` | `point.lat`, `point.lon`, `lang`, `size`, `boundary.circle.radius` (km) |
| `/v1/place` | – | always an empty result: Photon cannot look up by id |
| `/health` | – | 200 for container health checks |

Not supported: searching GTFS stops and stations (Photon only has OpenStreetMap). For that, a
full Pelias with the GTFS importer is needed.

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
    # same Docker network as the photon container, so the name "photon" resolves
```
