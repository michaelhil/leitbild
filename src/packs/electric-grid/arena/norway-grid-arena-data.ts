import type { SourceDerivedGridArenaData } from './types.ts'

export const norwayGridArenaData: SourceDerivedGridArenaData = {
  "sourceBuild": {
    "id": "source-derived-oslofjord-grid-arena-v1",
    "generatedAt": "2026-05-29T19:22:48.038Z",
    "sourceIds": [
      "osm:pbf-power:NO",
      "nve:vannkraftdatabase",
      "nve:vindkraftdatabase"
    ],
    "notes": [
      "Operational arena generated from the grid-norway OSM PBF reference sidecar.",
      "NVE hydropower and wind APIs are used to augment generator capacity, annual production, operator, and price-area provenance where names match.",
      "Co-located OSM plant/generator duplicates are collapsed when a larger plant-level feature covers smaller same-family unit nodes.",
      "Consumer load zones are inferred operational demand aggregates attached to real high-voltage buses."
    ]
  },
  "substations": [
    {
      "externalId": "relation/8243549",
      "name": "Abildsø trafostasjon",
      "lon": 10.820557,
      "lat": 59.889522,
      "voltageKv": [
        132,
        47
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/295444089",
      "name": "Ådal koblingsstasjon",
      "lon": 10.147593,
      "lat": 60.248686,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/753613423",
      "name": "Akersmyra koblingsstasjon",
      "lon": 10.323156,
      "lat": 59.273032,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7893972",
      "name": "Århus trafostasjon",
      "lon": 9.579256,
      "lat": 59.219204,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/551037431",
      "name": "Årlifoss koblingsstasjon",
      "lon": 9.144612,
      "lat": 59.68547,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/329581506",
      "name": "Åsnes trafostasjon",
      "lon": 11.959247,
      "lat": 60.6101,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/749676336",
      "name": "Bærum trafostasjon",
      "lon": 10.558365,
      "lat": 59.926838,
      "voltageKv": [
        300,
        47
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/206628449",
      "name": "Bamble trafostasjon",
      "lon": 9.595875,
      "lat": 59.040987,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10381726",
      "name": "Bentsrud trafostasjon",
      "lon": 10.312451,
      "lat": 59.471379,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10336704",
      "name": "Berger trafostasjon",
      "lon": 10.469582,
      "lat": 59.864254,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/39694172",
      "name": "Bødalen trafostasjon",
      "lon": 10.458047,
      "lat": 59.758714,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/660846340",
      "name": "Borgen trafostasjon",
      "lon": 10.41855,
      "lat": 59.828171,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/6078012478",
      "name": "Briskeby trafostasjon",
      "lon": 10.715275,
      "lat": 59.922501,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14071302",
      "name": "Bugården trafostasjon",
      "lon": 10.195936,
      "lat": 59.128136,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7847764",
      "name": "Dagali trafostasjon",
      "lon": 8.577467,
      "lat": 60.437711,
      "voltageKv": [
        420,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1165232853",
      "name": "Djupdal kraftverk",
      "lon": 9.339141,
      "lat": 59.939434,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/442950344",
      "name": "Dolven tranformatorstasjon",
      "lon": 9.896277,
      "lat": 59.013568,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550190735",
      "name": "Eggedal trafostasjon",
      "lon": 9.361773,
      "lat": 60.235514,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Midtkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10384523",
      "name": "Esso raffineriet trafostasjon",
      "lon": 10.513333,
      "lat": 59.312847,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/51522063",
      "name": "Firingen trafostasjon",
      "lon": 10.360156,
      "lat": 59.265806,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550033067",
      "name": "Flå trafo",
      "lon": 9.531618,
      "lat": 60.391176,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/287115458",
      "name": "Flesaker koblingsstasjon",
      "lon": 9.843725,
      "lat": 59.720307,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7871517",
      "name": "Flesaker trafostasjon",
      "lon": 9.847935,
      "lat": 59.717646,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett;Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100151486",
      "name": "Follo trafostasjon",
      "lon": 10.782977,
      "lat": 59.728775,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7867734",
      "name": "Follum trafostasjon",
      "lon": 10.23631,
      "lat": 60.182624,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1419567932",
      "name": "Fornebu trafostasjon",
      "lon": 10.624601,
      "lat": 59.90642,
      "voltageKv": [
        132,
        47,
        11
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9407966",
      "name": "Frogner trafostasjon",
      "lon": 9.612633,
      "lat": 59.212913,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/295444099",
      "name": "Frogner transformatorstasjon",
      "lon": 11.133591,
      "lat": 60.005617,
      "voltageKv": [
        420,
        300,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/551246032",
      "name": "Frøystul trafostasjon",
      "lon": 8.347549,
      "lat": 59.824746,
      "voltageKv": [
        132,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/80179519",
      "name": "Furuset trafostasjon",
      "lon": 10.884336,
      "lat": 59.94447,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14758048",
      "name": "Fusdal trafostasjon",
      "lon": 10.445018,
      "lat": 59.833444,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14071307",
      "name": "Gokstad trafostasjon",
      "lon": 10.25003,
      "lat": 59.144417,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11568632",
      "name": "Grenland trafostasjon",
      "lon": 9.47685,
      "lat": 59.128401,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1357912446",
      "name": "Gromstul koblingsstasjon",
      "lon": 9.524747,
      "lat": 59.274535,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/18303429",
      "name": "Grønvollfoss koblingsstasjon",
      "lon": 9.207796,
      "lat": 59.657838,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/18303428",
      "name": "Grønvollfoss kraftverk",
      "lon": 9.207718,
      "lat": 59.658167,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Skagerak Kraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7888662",
      "name": "Gvarv trafostasjon",
      "lon": 9.174652,
      "lat": 59.379145,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8206955",
      "name": "Hadeland trafostasjon",
      "lon": 10.577322,
      "lat": 60.2888,
      "voltageKv": [
        300,
        132,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/46832312",
      "name": "Hafskjold trafostasjon",
      "lon": 10.252906,
      "lat": 59.794801,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/232893576",
      "name": "Halden trafostasjon",
      "lon": 11.415557,
      "lat": 59.12384,
      "voltageKv": [
        420,
        47
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/584434419",
      "name": "Halmstad trafostasjon",
      "lon": 10.742081,
      "lat": 59.381304,
      "voltageKv": [
        132,
        47,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/187555858",
      "name": "Hamang transformatorstasjon",
      "lon": 10.498982,
      "lat": 59.896882,
      "voltageKv": [
        300,
        132,
        47
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1305324961",
      "name": "Hanekleiva trafostasjon",
      "lon": 10.188302,
      "lat": 59.574997,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/579583500",
      "name": "Harestua trafo",
      "lon": 10.699677,
      "lat": 60.21171,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/60495669",
      "name": "Hasle trafostasjon",
      "lon": 11.155404,
      "lat": 59.314144,
      "voltageKv": [
        420,
        300,
        132,
        47
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/551194981",
      "name": "Hjartdøla trafostasjon",
      "lon": 8.711947,
      "lat": 59.604108,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/355844786",
      "name": "Hof trafostasjon",
      "lon": 10.104273,
      "lat": 59.576632,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7812776",
      "name": "Hol I kraftverk koblingsstasjon",
      "lon": 8.1836,
      "lat": 60.626135,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11601413",
      "name": "Holtan trafostasjon",
      "lon": 10.403755,
      "lat": 59.142108,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8205422",
      "name": "Hurdal trafo",
      "lon": 11.077415,
      "lat": 60.43337,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14071300",
      "name": "Jåberg koblingsstasjon",
      "lon": 10.161371,
      "lat": 59.10757,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8206957",
      "name": "Jaren trafostasjon",
      "lon": 10.541499,
      "lat": 60.393708,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8207215",
      "name": "Jevnaker trafostasjon",
      "lon": 10.373407,
      "lat": 60.227268,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/111654009",
      "name": "Jordal trafostasjon",
      "lon": 10.782021,
      "lat": 59.908102,
      "voltageKv": [
        132,
        47,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550454471",
      "name": "Kaggefoss trafostasjon",
      "lon": 9.935082,
      "lat": 59.945707,
      "voltageKv": [
        132,
        45
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/28028051",
      "name": "Kjenner koblingsstasjon",
      "lon": 10.337976,
      "lat": 59.806244,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100666305",
      "name": "Kjørbekk trafostasjon",
      "lon": 9.607935,
      "lat": 59.17644,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/296269262",
      "name": "Kongsengen trafo",
      "lon": 10.7925,
      "lat": 60.690998,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8222072",
      "name": "Kongsvinger trafostasjon",
      "lon": 11.978477,
      "lat": 60.195167,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia;Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8205424",
      "name": "Krabyskogen trafo",
      "lon": 10.876034,
      "lat": 60.651651,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14347509",
      "name": "Kvelde trafostasjon",
      "lon": 9.963585,
      "lat": 59.202503,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/48306065",
      "name": "Langum trafostasjon",
      "lon": 10.112637,
      "lat": 59.745188,
      "voltageKv": [
        132,
        45
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10355950",
      "name": "Leinås trafostasjon",
      "lon": 10.270281,
      "lat": 59.563145,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8999774",
      "name": "Lillo trafostasjon",
      "lon": 10.772891,
      "lat": 59.945346,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14347510",
      "name": "Lofstad trafostasjon",
      "lon": 9.862292,
      "lat": 59.313596,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1078030962",
      "name": "Lunde koblingspunkt",
      "lon": 10.05876,
      "lat": 59.114267,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10582233",
      "name": "Meen koblingsstasjon",
      "lon": 9.657207,
      "lat": 59.17587,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/120279477",
      "name": "Minne transformatorstasjon",
      "lon": 11.232237,
      "lat": 60.388696,
      "voltageKv": [
        300,
        132,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/18555173",
      "name": "Mjøndalen trafostasjon",
      "lon": 10.016727,
      "lat": 59.744549,
      "voltageKv": [
        132,
        66,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14071303",
      "name": "Mo trafostasjon",
      "lon": 10.199778,
      "lat": 59.143757,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100666299",
      "name": "Moflata trafo",
      "lon": 9.589168,
      "lat": 59.192931,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100657505",
      "name": "Myrene trafostasjon",
      "lon": 9.666887,
      "lat": 59.133936,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7851611",
      "name": "Nes koblingsstasjon",
      "lon": 9.069989,
      "lat": 60.605756,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/325550726",
      "name": "Nes trafostasjon",
      "lon": 10.454225,
      "lat": 59.24832,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7851610",
      "name": "Nes trafostasjon",
      "lon": 9.068233,
      "lat": 60.606214,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7888664",
      "name": "Nordagutu trafostasjon",
      "lon": 9.326679,
      "lat": 59.414327,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7854485",
      "name": "Nore I trafostasjon",
      "lon": 8.961755,
      "lat": 60.266916,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7854480",
      "name": "Nore II trafostasjon",
      "lon": 9.000299,
      "lat": 60.238734,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/6074985684",
      "name": "Pipervika trafostasjon",
      "lon": 10.735622,
      "lat": 59.90981,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100648754",
      "name": "Porsgrunn trafostasjon",
      "lon": 9.672798,
      "lat": 59.115637,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/165500085",
      "name": "Rå trafostasjon",
      "lon": 10.98044,
      "lat": 59.244484,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11547182",
      "name": "Råde trafostasjon",
      "lon": 10.807829,
      "lat": 59.35859,
      "voltageKv": [
        132,
        47,
        17
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/405935304",
      "name": "Rakkås trafostasjon",
      "lon": 10.404031,
      "lat": 59.312113,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14071297",
      "name": "Ranvik trafostasjon",
      "lon": 10.216216,
      "lat": 59.118292,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/205115991",
      "name": "Ringerike trafostasjon",
      "lon": 10.204062,
      "lat": 60.168616,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7879879",
      "name": "Rjukan trafostasjon",
      "lon": 8.677965,
      "lat": 59.882471,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/290390502",
      "name": "Roa koblingsstasjon",
      "lon": 10.639101,
      "lat": 60.311543,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/18667238",
      "name": "Rød koblingsstasjon",
      "lon": 9.541599,
      "lat": 59.273712,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/18667239",
      "name": "Rød transformatorstasjon",
      "lon": 9.543747,
      "lat": 59.272381,
      "voltageKv": [
        420,
        300,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8999778",
      "name": "Rodeløkka trafostasjon",
      "lon": 10.769352,
      "lat": 59.923224,
      "voltageKv": [
        132,
        47,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550195650",
      "name": "Rollag trafostasjon",
      "lon": 9.304605,
      "lat": 59.984462,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/753706331",
      "name": "Rønningen trafostasjon",
      "lon": 10.461923,
      "lat": 59.267568,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/228400493",
      "name": "Røreåsen trafostasjon",
      "lon": 10.462583,
      "lat": 59.415751,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8239198",
      "name": "Røykås trafostasjon",
      "lon": 10.933454,
      "lat": 59.929978,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9008654",
      "name": "Sagene trafostasjon",
      "lon": 10.75569,
      "lat": 59.943262,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7879875",
      "name": "Såheim trafostasjon",
      "lon": 8.596549,
      "lat": 59.877185,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Hydro Energi",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/50881349",
      "name": "Sande trafostasjon",
      "lon": 10.218317,
      "lat": 59.575325,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550378158",
      "name": "Sandum trafostasjon",
      "lon": 9.598839,
      "lat": 60.221517,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550454423",
      "name": "Setersberg trafo",
      "lon": 9.888683,
      "lat": 59.899477,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/329581503",
      "name": "Skarnes trafostasjon",
      "lon": 11.676488,
      "lat": 60.244784,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia;Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1004193643",
      "name": "Skjøren koblingsstasjon",
      "lon": 11.103457,
      "lat": 59.331938,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7875593",
      "name": "Skollenborg",
      "lon": 9.667933,
      "lat": 59.618974,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13284557",
      "name": "Skotfoss trafostasjon",
      "lon": 9.532186,
      "lat": 59.206269,
      "voltageKv": [
        132,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/133756725",
      "name": "Skøyen trafostasjon",
      "lon": 10.689244,
      "lat": 59.919943,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10386410",
      "name": "Slagen trafostasjon",
      "lon": 10.430502,
      "lat": 59.283577,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/12765722163",
      "name": "Smestad trafostasjon",
      "lon": 10.66864,
      "lat": 59.934778,
      "voltageKv": [
        300,
        132,
        47
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10308957",
      "name": "Sogn trafostasjon",
      "lon": 10.721021,
      "lat": 59.95828,
      "voltageKv": [
        300,
        132,
        47
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/503746987",
      "name": "Sokna trafostasjon",
      "lon": 9.932655,
      "lat": 60.235338,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/6078012488",
      "name": "Solli trafostasjon",
      "lon": 10.720033,
      "lat": 59.912887,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/288812256",
      "name": "Songa koblingsstasjon",
      "lon": 7.725059,
      "lat": 59.774079,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1036809822",
      "name": "Songkjølen trafostasjon",
      "lon": 11.504142,
      "lat": 60.33591,
      "voltageKv": [
        132,
        33
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14347513",
      "name": "Sørtveit trafostasjon",
      "lon": 9.661,
      "lat": 59.307479,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11601416",
      "name": "Stangeby trafostasjon",
      "lon": 10.399874,
      "lat": 59.217797,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/26938543",
      "name": "Storsand trafostasjon",
      "lon": 10.573604,
      "lat": 59.655167,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11601417",
      "name": "Sundland trafostasjon",
      "lon": 10.286184,
      "lat": 59.229787,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7877635",
      "name": "Svelgfoss",
      "lon": 9.25819,
      "lat": 59.581718,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Hydro Energi",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10355948",
      "name": "Svelvik trafostasjon",
      "lon": 10.403238,
      "lat": 59.607944,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/128406208",
      "name": "Sylling trafostasjon",
      "lon": 10.215375,
      "lat": 59.867244,
      "voltageKv": [
        420,
        300,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/29578389",
      "name": "Tegneby koblingsstasjon",
      "lon": 10.747226,
      "lat": 59.51735,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/114414014",
      "name": "Tegneby trafostasjon",
      "lon": 10.737979,
      "lat": 59.516432,
      "voltageKv": [
        300,
        47
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/27030901",
      "name": "Tofte trafostasjon",
      "lon": 10.563748,
      "lat": 59.554204,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7883882",
      "name": "Tokke koblingsstasjon",
      "lon": 8.03656,
      "lat": 59.447937,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/104728501",
      "name": "Torshov trafostasjon",
      "lon": 10.770447,
      "lat": 59.933533,
      "voltageKv": [
        132,
        47,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/753593226",
      "name": "Trolldalen trafostasjon",
      "lon": 10.412198,
      "lat": 59.378164,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/51854396",
      "name": "Tveiten trafostasjon",
      "lon": 10.381549,
      "lat": 59.329143,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/550388264",
      "name": "Tyristrand trafostasjon",
      "lon": 10.096959,
      "lat": 60.088254,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/114897970",
      "name": "Ullevål trafostasjon",
      "lon": 10.731629,
      "lat": 59.935164,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/331597523",
      "name": "Ultvedt trafostasjon",
      "lon": 10.313784,
      "lat": 60.136483,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Glitre Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/113442999",
      "name": "Ulven trafostasjon",
      "lon": 10.812042,
      "lat": 59.922141,
      "voltageKv": [
        300,
        132,
        47,
        11
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/296229069",
      "name": "Usta trafostasjon",
      "lon": 8.412005,
      "lat": 60.574498,
      "voltageKv": [
        420,
        300,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9552168",
      "name": "Uvdal II",
      "lon": 8.923846,
      "lat": 60.258582,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9552170",
      "name": "Uvdal trafostasjon",
      "lon": 8.703233,
      "lat": 60.25454,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8251802",
      "name": "Vammafossen trafostasjon",
      "lon": 11.173823,
      "lat": 59.53994,
      "voltageKv": [
        132,
        47
      ],
      "maxVoltageKv": 132,
      "operator": "Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7879876",
      "name": "Vemorktoppen",
      "lon": 8.492923,
      "lat": 59.865425,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14071305",
      "name": "Vindal trafostasjon",
      "lon": 10.241468,
      "lat": 59.109196,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lede",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7883264",
      "name": "Vinje kraftverk",
      "lon": 7.851073,
      "lat": 59.624719,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    }
  ],
  "branches": [
    {
      "externalId": "merged/line/line|420|Statnett|Usta - Ådal|line/0",
      "name": "Usta - Ådal",
      "category": "line",
      "fromExternalId": "way/296229069",
      "toExternalId": "way/295444089",
      "nominalKv": 420,
      "lengthKm": 113.83,
      "operator": "Statnett",
      "path": [
        [
          8.410748,
          60.57386
        ],
        [
          8.502935,
          60.592165
        ],
        [
          8.592446,
          60.622666
        ],
        [
          8.69054,
          60.624926
        ],
        [
          8.784047,
          60.640145
        ],
        [
          8.877318,
          60.646875
        ],
        [
          8.986301,
          60.65465
        ],
        [
          9.088781,
          60.639052
        ],
        [
          9.183122,
          60.597251
        ],
        [
          9.282605,
          60.564588
        ],
        [
          9.367449,
          60.532095
        ],
        [
          9.460945,
          60.491266
        ],
        [
          9.571656,
          60.45927
        ],
        [
          9.671252,
          60.411641
        ],
        [
          9.798582,
          60.363265
        ],
        [
          9.921754,
          60.33211
        ],
        [
          10.041627,
          60.301747
        ],
        [
          10.148277,
          60.249186
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Dagali - Ringerike|line/0",
      "name": "Dagali - Ringerike",
      "category": "line",
      "fromExternalId": "relation/7847764",
      "toExternalId": "way/205115991",
      "nominalKv": 420,
      "lengthKm": 100.13,
      "operator": "Statnett",
      "path": [
        [
          8.576522,
          60.437578
        ],
        [
          8.66743,
          60.426597
        ],
        [
          8.745718,
          60.399269
        ],
        [
          8.802586,
          60.365445
        ],
        [
          8.858194,
          60.334152
        ],
        [
          8.907461,
          60.293153
        ],
        [
          8.986216,
          60.256673
        ],
        [
          9.106196,
          60.243571
        ],
        [
          9.205234,
          60.238251
        ],
        [
          9.304615,
          60.240192
        ],
        [
          9.412349,
          60.229702
        ],
        [
          9.516027,
          60.218937
        ],
        [
          9.634243,
          60.223748
        ],
        [
          9.744846,
          60.213253
        ],
        [
          9.861474,
          60.209149
        ],
        [
          9.976616,
          60.205534
        ],
        [
          10.088668,
          60.2004
        ],
        [
          10.185785,
          60.175008
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Nore I - Sylling|line/0",
      "name": "Nore I - Sylling",
      "category": "line",
      "fromExternalId": "relation/7854485",
      "toExternalId": "way/128406208",
      "nominalKv": 420,
      "lengthKm": 88.6,
      "operator": "Statnett",
      "path": [
        [
          8.962092,
          60.266719
        ],
        [
          9.039479,
          60.24493
        ],
        [
          9.086407,
          60.210567
        ],
        [
          9.131656,
          60.173031
        ],
        [
          9.194334,
          60.133631
        ],
        [
          9.262944,
          60.10832
        ],
        [
          9.334608,
          60.083188
        ],
        [
          9.40516,
          60.065328
        ],
        [
          9.473332,
          60.039121
        ],
        [
          9.567745,
          60.016877
        ],
        [
          9.642879,
          59.996451
        ],
        [
          9.713041,
          59.959952
        ],
        [
          9.781061,
          59.923154
        ],
        [
          9.842146,
          59.88501
        ],
        [
          9.940905,
          59.871768
        ],
        [
          10.038347,
          59.883562
        ],
        [
          10.134759,
          59.880415
        ],
        [
          10.214375,
          59.867785
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Frogner - Follo|line/0",
      "name": "Frogner - Follo",
      "category": "line",
      "fromExternalId": "way/295444099",
      "toExternalId": "way/100151486",
      "nominalKv": 420,
      "lengthKm": 45.97,
      "operator": "Statnett",
      "path": [
        [
          11.132382,
          60.005417
        ],
        [
          11.090441,
          60.007756
        ],
        [
          11.049199,
          59.99181
        ],
        [
          11.004353,
          59.986464
        ],
        [
          10.983571,
          59.969218
        ],
        [
          10.946103,
          59.948476
        ],
        [
          10.927118,
          59.932795
        ],
        [
          10.931894,
          59.909071
        ],
        [
          10.941291,
          59.876654
        ],
        [
          10.945679,
          59.853199
        ],
        [
          10.913891,
          59.837754
        ],
        [
          10.861632,
          59.835867
        ],
        [
          10.840983,
          59.831564
        ],
        [
          10.843302,
          59.812375
        ],
        [
          10.839979,
          59.788468
        ],
        [
          10.822373,
          59.76289
        ],
        [
          10.796189,
          59.742964
        ],
        [
          10.78253,
          59.729185
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ringerike - Sylling|line/0",
      "name": "Ringerike - Sylling",
      "category": "line",
      "fromExternalId": "way/205115991",
      "toExternalId": "way/128406208",
      "nominalKv": 420,
      "lengthKm": 41.44,
      "operator": "Statnett",
      "path": [
        [
          10.203811,
          60.168766
        ],
        [
          10.181505,
          60.163584
        ],
        [
          10.148765,
          60.151577
        ],
        [
          10.12314,
          60.13604
        ],
        [
          10.091195,
          60.118796
        ],
        [
          10.067232,
          60.102625
        ],
        [
          10.049079,
          60.082431
        ],
        [
          10.033227,
          60.059398
        ],
        [
          10.024579,
          60.042834
        ],
        [
          10.023093,
          60.022172
        ],
        [
          10.019762,
          60.00332
        ],
        [
          10.050849,
          59.980913
        ],
        [
          10.081292,
          59.959396
        ],
        [
          10.112541,
          59.932921
        ],
        [
          10.125499,
          59.91482
        ],
        [
          10.154365,
          59.896757
        ],
        [
          10.188191,
          59.882592
        ],
        [
          10.216052,
          59.86809
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Tegneby - Hasle|line/0",
      "name": "Tegneby - Hasle",
      "category": "line",
      "fromExternalId": "way/29578389",
      "toExternalId": "way/60495669",
      "nominalKv": 420,
      "lengthKm": 32.49,
      "operator": "Statnett",
      "path": [
        [
          10.747278,
          59.517421
        ],
        [
          10.765239,
          59.510015
        ],
        [
          10.7916,
          59.499782
        ],
        [
          10.819803,
          59.488801
        ],
        [
          10.845472,
          59.478813
        ],
        [
          10.872117,
          59.468446
        ],
        [
          10.897941,
          59.457026
        ],
        [
          10.918388,
          59.443358
        ],
        [
          10.940795,
          59.428362
        ],
        [
          10.958935,
          59.41621
        ],
        [
          10.981216,
          59.401273
        ],
        [
          11.003036,
          59.386622
        ],
        [
          11.022669,
          59.373438
        ],
        [
          11.048225,
          59.360184
        ],
        [
          11.072835,
          59.347994
        ],
        [
          11.097715,
          59.335663
        ],
        [
          11.12756,
          59.32483
        ],
        [
          11.155092,
          59.315331
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Dagali - Nore I|line/0",
      "name": "Dagali - Nore I",
      "category": "line",
      "fromExternalId": "relation/7847764",
      "toExternalId": "relation/7854485",
      "nominalKv": 420,
      "lengthKm": 30,
      "operator": "Statnett",
      "path": [
        [
          8.576276,
          60.43744
        ],
        [
          8.59964,
          60.43438
        ],
        [
          8.630281,
          60.431228
        ],
        [
          8.667156,
          60.426314
        ],
        [
          8.693238,
          60.420595
        ],
        [
          8.715291,
          60.411461
        ],
        [
          8.7453,
          60.39903
        ],
        [
          8.765647,
          60.389482
        ],
        [
          8.782083,
          60.375611
        ],
        [
          8.804764,
          60.363862
        ],
        [
          8.821281,
          60.355221
        ],
        [
          8.83922,
          60.345017
        ],
        [
          8.862501,
          60.331069
        ],
        [
          8.872535,
          60.314874
        ],
        [
          8.88441,
          60.303142
        ],
        [
          8.911302,
          60.290774
        ],
        [
          8.943466,
          60.279879
        ],
        [
          8.961888,
          60.266746
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Hasle - Halden|line/0",
      "name": "Hasle - Halden",
      "category": "line",
      "fromExternalId": "way/60495669",
      "toExternalId": "way/232893576",
      "nominalKv": 420,
      "lengthKm": 28.17,
      "operator": "Statnett",
      "path": [
        [
          11.154856,
          59.315198
        ],
        [
          11.172216,
          59.31353
        ],
        [
          11.196029,
          59.304099
        ],
        [
          11.212851,
          59.291647
        ],
        [
          11.230908,
          59.275491
        ],
        [
          11.248187,
          59.26377
        ],
        [
          11.268046,
          59.251561
        ],
        [
          11.289927,
          59.238817
        ],
        [
          11.30726,
          59.228908
        ],
        [
          11.329522,
          59.216174
        ],
        [
          11.356628,
          59.210391
        ],
        [
          11.377126,
          59.202844
        ],
        [
          11.390982,
          59.192123
        ],
        [
          11.398589,
          59.175953
        ],
        [
          11.411043,
          59.164397
        ],
        [
          11.427332,
          59.146133
        ],
        [
          11.426425,
          59.132429
        ],
        [
          11.415382,
          59.123922
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Follo - Tegneby|line/0",
      "name": "Follo - Tegneby",
      "category": "line",
      "fromExternalId": "way/29578389",
      "toExternalId": "way/100151486",
      "nominalKv": 420,
      "lengthKm": 27.56,
      "operator": "Statnett",
      "path": [
        [
          10.747206,
          59.517539
        ],
        [
          10.731009,
          59.529306
        ],
        [
          10.709523,
          59.538709
        ],
        [
          10.691712,
          59.543746
        ],
        [
          10.673849,
          59.558351
        ],
        [
          10.676069,
          59.572274
        ],
        [
          10.685347,
          59.587955
        ],
        [
          10.687954,
          59.601831
        ],
        [
          10.680257,
          59.620924
        ],
        [
          10.681546,
          59.632672
        ],
        [
          10.681012,
          59.649562
        ],
        [
          10.692138,
          59.660978
        ],
        [
          10.706634,
          59.672236
        ],
        [
          10.719295,
          59.682851
        ],
        [
          10.732956,
          59.700578
        ],
        [
          10.745232,
          59.712464
        ],
        [
          10.765185,
          59.723791
        ],
        [
          10.782518,
          59.728826
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Usta - Dagali|line/0",
      "name": "Usta - Dagali",
      "category": "line",
      "fromExternalId": "way/296229069",
      "toExternalId": "relation/7847764",
      "nominalKv": 420,
      "lengthKm": 19.52,
      "operator": "Statnett",
      "path": [
        [
          8.410754,
          60.574039
        ],
        [
          8.402556,
          60.569411
        ],
        [
          8.395727,
          60.561521
        ],
        [
          8.403436,
          60.550979
        ],
        [
          8.404402,
          60.543514
        ],
        [
          8.409379,
          60.534652
        ],
        [
          8.421128,
          60.528601
        ],
        [
          8.43574,
          60.521828
        ],
        [
          8.452092,
          60.513108
        ],
        [
          8.469483,
          60.503829
        ],
        [
          8.483892,
          60.495358
        ],
        [
          8.494277,
          60.482693
        ],
        [
          8.502996,
          60.472054
        ],
        [
          8.509861,
          60.463674
        ],
        [
          8.516547,
          60.455501
        ],
        [
          8.541126,
          60.447886
        ],
        [
          8.56144,
          60.44159
        ],
        [
          8.57675,
          60.437707
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Bamble - Grenland|line/0",
      "name": "Bamble - Grenland",
      "category": "line",
      "fromExternalId": "way/206628449",
      "toExternalId": "relation/11568632",
      "nominalKv": 420,
      "lengthKm": 14.94,
      "operator": "Statnett",
      "path": [
        [
          9.595945,
          59.040729
        ],
        [
          9.587781,
          59.044737
        ],
        [
          9.57318,
          59.049078
        ],
        [
          9.552703,
          59.052278
        ],
        [
          9.537839,
          59.053071
        ],
        [
          9.519404,
          59.059839
        ],
        [
          9.507103,
          59.06358
        ],
        [
          9.490474,
          59.068526
        ],
        [
          9.47739,
          59.072388
        ],
        [
          9.470124,
          59.080083
        ],
        [
          9.468707,
          59.083321
        ],
        [
          9.471792,
          59.091203
        ],
        [
          9.47588,
          59.096564
        ],
        [
          9.481729,
          59.105734
        ],
        [
          9.485849,
          59.110886
        ],
        [
          9.493606,
          59.120743
        ],
        [
          9.483073,
          59.125633
        ],
        [
          9.47655,
          59.128546
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ådal - Frogner / Furuset - Frogner|line/0",
      "name": "Ådal - Frogner / Furuset - Frogner",
      "category": "line",
      "fromExternalId": "way/80179519",
      "toExternalId": "way/295444099",
      "nominalKv": 420,
      "lengthKm": 14.6,
      "operator": "Statnett",
      "path": [
        [
          10.904944,
          59.988579
        ],
        [
          10.923752,
          59.989256
        ],
        [
          10.934899,
          59.989658
        ],
        [
          10.952862,
          59.995068
        ],
        [
          10.965863,
          60.000638
        ],
        [
          10.981495,
          60.007373
        ],
        [
          10.990013,
          60.011052
        ],
        [
          11.003253,
          60.018246
        ],
        [
          11.014735,
          60.023
        ],
        [
          11.024668,
          60.022727
        ],
        [
          11.047069,
          60.021979
        ],
        [
          11.059568,
          60.021853
        ],
        [
          11.068929,
          60.018703
        ],
        [
          11.083447,
          60.013008
        ],
        [
          11.096151,
          60.008854
        ],
        [
          11.110209,
          60.004974
        ],
        [
          11.121458,
          60.005073
        ],
        [
          11.131066,
          60.00576
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Hol 1 - (Hol 2) - Usta|line/0",
      "name": "Hol 1 - (Hol 2) - Usta",
      "category": "line",
      "fromExternalId": "relation/7812776",
      "toExternalId": "way/296229069",
      "nominalKv": 420,
      "lengthKm": 14.47,
      "operator": "Statnett",
      "path": [
        [
          8.183498,
          60.625932
        ],
        [
          8.189182,
          60.619132
        ],
        [
          8.208686,
          60.614575
        ],
        [
          8.22273,
          60.612477
        ],
        [
          8.238915,
          60.610764
        ],
        [
          8.252326,
          60.611706
        ],
        [
          8.262625,
          60.611667
        ],
        [
          8.276986,
          60.609102
        ],
        [
          8.290622,
          60.609253
        ],
        [
          8.308357,
          60.606191
        ],
        [
          8.320425,
          60.601104
        ],
        [
          8.333699,
          60.595532
        ],
        [
          8.344156,
          60.591131
        ],
        [
          8.352045,
          60.587818
        ],
        [
          8.366271,
          60.581828
        ],
        [
          8.382998,
          60.57846
        ],
        [
          8.400971,
          60.57488
        ],
        [
          8.41078,
          60.574757
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ådal - Ringerike|line/0",
      "name": "Ådal - Ringerike",
      "category": "line",
      "fromExternalId": "way/295444089",
      "toExternalId": "way/205115991",
      "nominalKv": 420,
      "lengthKm": 8.85,
      "operator": "Statnett",
      "path": [
        [
          10.147535,
          60.248508
        ],
        [
          10.14552,
          60.245478
        ],
        [
          10.143739,
          60.243302
        ],
        [
          10.138651,
          60.237109
        ],
        [
          10.144131,
          60.231119
        ],
        [
          10.147058,
          60.227927
        ],
        [
          10.152821,
          60.221625
        ],
        [
          10.159038,
          60.214838
        ],
        [
          10.160546,
          60.213266
        ],
        [
          10.165964,
          60.207725
        ],
        [
          10.166961,
          60.204595
        ],
        [
          10.169358,
          60.200658
        ],
        [
          10.174622,
          60.19586
        ],
        [
          10.178785,
          60.192033
        ],
        [
          10.182781,
          60.188369
        ],
        [
          10.185319,
          60.182163
        ],
        [
          10.18549,
          60.179858
        ],
        [
          10.185785,
          60.175008
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Nes kraftverk - Sogn|line/1",
      "name": "Nes kraftverk - Sogn",
      "category": "line",
      "fromExternalId": "relation/7851611",
      "toExternalId": "relation/10308957",
      "nominalKv": 300,
      "lengthKm": 125.18,
      "operator": "Statnett",
      "path": [
        [
          9.118862,
          60.623808
        ],
        [
          9.178733,
          60.561777
        ],
        [
          9.20208,
          60.496341
        ],
        [
          9.307013,
          60.445996
        ],
        [
          9.44571,
          60.43136
        ],
        [
          9.576634,
          60.397438
        ],
        [
          9.685076,
          60.356386
        ],
        [
          9.761025,
          60.299711
        ],
        [
          9.887186,
          60.25972
        ],
        [
          10.009505,
          60.232557
        ],
        [
          10.121096,
          60.222992
        ],
        [
          10.231267,
          60.196162
        ],
        [
          10.340232,
          60.159893
        ],
        [
          10.445681,
          60.13339
        ],
        [
          10.551108,
          60.10312
        ],
        [
          10.655469,
          60.066908
        ],
        [
          10.70075,
          60.010418
        ],
        [
          10.719142,
          59.958169
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Tokke - Rød|line/0",
      "name": "Tokke - Rød",
      "category": "line",
      "fromExternalId": "relation/7883882",
      "toExternalId": "relation/18667239",
      "nominalKv": 300,
      "lengthKm": 104.72,
      "operator": "Statnett",
      "path": [
        [
          8.036476,
          59.448253
        ],
        [
          8.114774,
          59.473399
        ],
        [
          8.229082,
          59.476948
        ],
        [
          8.328334,
          59.491634
        ],
        [
          8.41866,
          59.503143
        ],
        [
          8.532169,
          59.503855
        ],
        [
          8.629801,
          59.501025
        ],
        [
          8.737942,
          59.527095
        ],
        [
          8.837264,
          59.552905
        ],
        [
          8.952098,
          59.555135
        ],
        [
          9.067803,
          59.546833
        ],
        [
          9.133824,
          59.506598
        ],
        [
          9.20996,
          59.472324
        ],
        [
          9.27601,
          59.428877
        ],
        [
          9.338658,
          59.39593
        ],
        [
          9.429654,
          59.36915
        ],
        [
          9.501972,
          59.322024
        ],
        [
          9.545245,
          59.27297
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Vemorktoppen - Flesaker|line/0",
      "name": "Vemorktoppen - Flesaker",
      "category": "line",
      "fromExternalId": "relation/7879876",
      "toExternalId": "way/287115458",
      "nominalKv": 300,
      "lengthKm": 81.52,
      "operator": "Statnett",
      "path": [
        [
          8.493366,
          59.86558
        ],
        [
          8.562555,
          59.867703
        ],
        [
          8.644711,
          59.865459
        ],
        [
          8.708902,
          59.875659
        ],
        [
          8.785211,
          59.860802
        ],
        [
          8.838356,
          59.837511
        ],
        [
          8.919222,
          59.824465
        ],
        [
          8.990126,
          59.798861
        ],
        [
          9.05848,
          59.777355
        ],
        [
          9.139297,
          59.754213
        ],
        [
          9.244351,
          59.739636
        ],
        [
          9.334946,
          59.736092
        ],
        [
          9.423105,
          59.732945
        ],
        [
          9.514219,
          59.734218
        ],
        [
          9.605527,
          59.738168
        ],
        [
          9.684454,
          59.737625
        ],
        [
          9.784967,
          59.727497
        ],
        [
          9.843484,
          59.720139
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Røykås - Tegneby|line/0",
      "name": "Røykås - Tegneby",
      "category": "line",
      "fromExternalId": "relation/8239198",
      "toExternalId": "way/114414014",
      "nominalKv": 300,
      "lengthKm": 49.2,
      "operator": "Statnett",
      "path": [
        [
          10.933592,
          59.929551
        ],
        [
          10.934732,
          59.909144
        ],
        [
          10.941879,
          59.876686
        ],
        [
          10.945988,
          59.855657
        ],
        [
          10.949217,
          59.8284
        ],
        [
          10.952905,
          59.804292
        ],
        [
          10.961105,
          59.774482
        ],
        [
          10.950899,
          59.747273
        ],
        [
          10.920837,
          59.721139
        ],
        [
          10.911956,
          59.700608
        ],
        [
          10.901291,
          59.672026
        ],
        [
          10.890844,
          59.650706
        ],
        [
          10.866675,
          59.621787
        ],
        [
          10.8435,
          59.602168
        ],
        [
          10.819894,
          59.578681
        ],
        [
          10.797361,
          59.558535
        ],
        [
          10.767103,
          59.531814
        ],
        [
          10.74077,
          59.516823
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Frogner - Minne|line/0",
      "name": "Frogner - Minne",
      "category": "line",
      "fromExternalId": "way/295444099",
      "toExternalId": "way/120279477",
      "nominalKv": 300,
      "lengthKm": 48.32,
      "operator": "Statnett",
      "path": [
        [
          11.134892,
          60.006341
        ],
        [
          11.147365,
          60.023691
        ],
        [
          11.185997,
          60.030316
        ],
        [
          11.218709,
          60.05346
        ],
        [
          11.239126,
          60.08072
        ],
        [
          11.251545,
          60.104299
        ],
        [
          11.258111,
          60.129148
        ],
        [
          11.269918,
          60.150078
        ],
        [
          11.281553,
          60.176422
        ],
        [
          11.301407,
          60.202173
        ],
        [
          11.316208,
          60.225629
        ],
        [
          11.332247,
          60.253492
        ],
        [
          11.340079,
          60.283156
        ],
        [
          11.329613,
          60.310398
        ],
        [
          11.313123,
          60.339254
        ],
        [
          11.29961,
          60.36136
        ],
        [
          11.274148,
          60.373523
        ],
        [
          11.232263,
          60.387727
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Songa - Vemorktoppen|line/0",
      "name": "Songa - Vemorktoppen",
      "category": "line",
      "fromExternalId": "way/288812256",
      "toExternalId": "relation/7879876",
      "nominalKv": 300,
      "lengthKm": 47.75,
      "operator": "Statnett",
      "path": [
        [
          7.725787,
          59.774118
        ],
        [
          7.751327,
          59.789796
        ],
        [
          7.785157,
          59.79548
        ],
        [
          7.818975,
          59.794735
        ],
        [
          7.866431,
          59.785939
        ],
        [
          7.912953,
          59.778524
        ],
        [
          7.972325,
          59.778109
        ],
        [
          8.031258,
          59.78147
        ],
        [
          8.094192,
          59.785438
        ],
        [
          8.153771,
          59.79163
        ],
        [
          8.209367,
          59.789064
        ],
        [
          8.258741,
          59.791766
        ],
        [
          8.300117,
          59.794527
        ],
        [
          8.352227,
          59.803679
        ],
        [
          8.385159,
          59.814458
        ],
        [
          8.430226,
          59.831791
        ],
        [
          8.47062,
          59.849728
        ],
        [
          8.492838,
          59.865534
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Rød - Tveiten|line/1",
      "name": "Rød - Tveiten",
      "category": "line",
      "fromExternalId": "way/51854396",
      "toExternalId": "relation/18667239",
      "nominalKv": 300,
      "lengthKm": 46.82,
      "operator": "Statnett",
      "path": [
        [
          10.381088,
          59.329211
        ],
        [
          10.331601,
          59.32856
        ],
        [
          10.281929,
          59.331245
        ],
        [
          10.229247,
          59.328514
        ],
        [
          10.186054,
          59.325964
        ],
        [
          10.135507,
          59.32577
        ],
        [
          10.09355,
          59.322764
        ],
        [
          10.033016,
          59.320769
        ],
        [
          9.989206,
          59.320036
        ],
        [
          9.936242,
          59.318504
        ],
        [
          9.897654,
          59.316564
        ],
        [
          9.845803,
          59.313666
        ],
        [
          9.805562,
          59.317317
        ],
        [
          9.757442,
          59.317499
        ],
        [
          9.709266,
          59.310082
        ],
        [
          9.661401,
          59.307061
        ],
        [
          9.612312,
          59.301643
        ],
        [
          9.57167,
          59.29141
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Tegneby - Hasle|line/0",
      "name": "Tegneby - Hasle",
      "category": "line",
      "fromExternalId": "way/114414014",
      "toExternalId": "way/60495669",
      "nominalKv": 300,
      "lengthKm": 32.88,
      "operator": "Statnett",
      "path": [
        [
          10.74086,
          59.51615
        ],
        [
          10.768549,
          59.508384
        ],
        [
          10.794692,
          59.498219
        ],
        [
          10.820916,
          59.488018
        ],
        [
          10.845298,
          59.478535
        ],
        [
          10.871991,
          59.468147
        ],
        [
          10.897775,
          59.456677
        ],
        [
          10.918313,
          59.442943
        ],
        [
          10.938864,
          59.429193
        ],
        [
          10.96163,
          59.413939
        ],
        [
          10.981353,
          59.400716
        ],
        [
          11.002397,
          59.386587
        ],
        [
          11.022562,
          59.373046
        ],
        [
          11.048003,
          59.359891
        ],
        [
          11.072397,
          59.347822
        ],
        [
          11.097326,
          59.335466
        ],
        [
          11.1272,
          59.324611
        ],
        [
          11.156047,
          59.314187
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Hof - Tveiten|line/0",
      "name": "Hof - Tveiten",
      "category": "line",
      "fromExternalId": "way/355844786",
      "toExternalId": "way/51854396",
      "nominalKv": 300,
      "lengthKm": 32.08,
      "operator": "Statnett",
      "path": [
        [
          10.105607,
          59.576206
        ],
        [
          10.121163,
          59.563052
        ],
        [
          10.137792,
          59.54713
        ],
        [
          10.15924,
          59.52877
        ],
        [
          10.176972,
          59.514539
        ],
        [
          10.195917,
          59.500298
        ],
        [
          10.209646,
          59.4885
        ],
        [
          10.228072,
          59.468845
        ],
        [
          10.242228,
          59.453262
        ],
        [
          10.253632,
          59.436324
        ],
        [
          10.266789,
          59.417835
        ],
        [
          10.27586,
          59.408934
        ],
        [
          10.291851,
          59.397134
        ],
        [
          10.310137,
          59.383385
        ],
        [
          10.330877,
          59.368691
        ],
        [
          10.347919,
          59.35324
        ],
        [
          10.35912,
          59.336897
        ],
        [
          10.380997,
          59.329468
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Flesaker - Sylling|line/1",
      "name": "Flesaker - Sylling",
      "category": "line",
      "fromExternalId": "way/287115458",
      "toExternalId": "way/128406208",
      "nominalKv": 300,
      "lengthKm": 28.43,
      "operator": "Statnett",
      "path": [
        [
          9.818718,
          59.727486
        ],
        [
          9.838831,
          59.738528
        ],
        [
          9.859055,
          59.751502
        ],
        [
          9.867423,
          59.764676
        ],
        [
          9.879217,
          59.777592
        ],
        [
          9.895063,
          59.788562
        ],
        [
          9.920847,
          59.799253
        ],
        [
          9.943984,
          59.804439
        ],
        [
          9.974991,
          59.810401
        ],
        [
          10.010484,
          59.815627
        ],
        [
          10.039768,
          59.822078
        ],
        [
          10.063423,
          59.827692
        ],
        [
          10.084096,
          59.836104
        ],
        [
          10.112671,
          59.847404
        ],
        [
          10.13492,
          59.855858
        ],
        [
          10.159795,
          59.859256
        ],
        [
          10.192244,
          59.862555
        ],
        [
          10.214821,
          59.866372
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Tokke - Vinje|line/0",
      "name": "Tokke - Vinje",
      "category": "line",
      "fromExternalId": "relation/7883882",
      "toExternalId": "relation/7883264",
      "nominalKv": 300,
      "lengthKm": 22.86,
      "operator": "Statnett",
      "path": [
        [
          8.03479,
          59.448189
        ],
        [
          8.024198,
          59.455002
        ],
        [
          8.006933,
          59.464358
        ],
        [
          7.986873,
          59.475392
        ],
        [
          7.978958,
          59.481559
        ],
        [
          7.967352,
          59.496718
        ],
        [
          7.951682,
          59.504432
        ],
        [
          7.941511,
          59.515243
        ],
        [
          7.933212,
          59.523325
        ],
        [
          7.914451,
          59.536521
        ],
        [
          7.901906,
          59.545337
        ],
        [
          7.89144,
          59.554752
        ],
        [
          7.884332,
          59.56716
        ],
        [
          7.878951,
          59.57793
        ],
        [
          7.875829,
          59.592785
        ],
        [
          7.871693,
          59.607105
        ],
        [
          7.857032,
          59.619915
        ],
        [
          7.849988,
          59.624791
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Flesaker - Hof|line/0",
      "name": "Flesaker - Hof",
      "category": "line",
      "fromExternalId": "way/287115458",
      "toExternalId": "way/355844786",
      "nominalKv": 300,
      "lengthKm": 22.21,
      "operator": "Statnett",
      "path": [
        [
          9.844693,
          59.720099
        ],
        [
          9.858084,
          59.71862
        ],
        [
          9.875164,
          59.714271
        ],
        [
          9.893021,
          59.705233
        ],
        [
          9.910998,
          59.695195
        ],
        [
          9.924667,
          59.688464
        ],
        [
          9.946226,
          59.680336
        ],
        [
          9.960321,
          59.675392
        ],
        [
          9.978209,
          59.667716
        ],
        [
          10.004175,
          59.654565
        ],
        [
          10.018712,
          59.645133
        ],
        [
          10.027701,
          59.639299
        ],
        [
          10.042775,
          59.627642
        ],
        [
          10.056003,
          59.618302
        ],
        [
          10.067089,
          59.609544
        ],
        [
          10.083865,
          59.595342
        ],
        [
          10.097433,
          59.583989
        ],
        [
          10.10591,
          59.576299
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Rød - Porsgrunn|line/0",
      "name": "Rød - Porsgrunn",
      "category": "line",
      "fromExternalId": "relation/18667239",
      "toExternalId": "way/100648754",
      "nominalKv": 300,
      "lengthKm": 21.17,
      "operator": "Statnett",
      "path": [
        [
          9.545516,
          59.272562
        ],
        [
          9.555517,
          59.270531
        ],
        [
          9.572643,
          59.257134
        ],
        [
          9.586199,
          59.249888
        ],
        [
          9.596633,
          59.243593
        ],
        [
          9.608802,
          59.231513
        ],
        [
          9.6182,
          59.22089
        ],
        [
          9.627494,
          59.212584
        ],
        [
          9.640416,
          59.198634
        ],
        [
          9.647506,
          59.189774
        ],
        [
          9.657698,
          59.176598
        ],
        [
          9.672236,
          59.168898
        ],
        [
          9.687804,
          59.162545
        ],
        [
          9.697617,
          59.151579
        ],
        [
          9.699201,
          59.141216
        ],
        [
          9.697038,
          59.132504
        ],
        [
          9.683628,
          59.119854
        ],
        [
          9.672813,
          59.115449
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Songa-Vinje|line/0",
      "name": "Songa-Vinje",
      "category": "line",
      "fromExternalId": "way/288812256",
      "toExternalId": "relation/7883264",
      "nominalKv": 300,
      "lengthKm": 18.72,
      "operator": "Statnett",
      "path": [
        [
          7.725226,
          59.774168
        ],
        [
          7.721055,
          59.765018
        ],
        [
          7.72334,
          59.750827
        ],
        [
          7.726999,
          59.741323
        ],
        [
          7.729558,
          59.734664
        ],
        [
          7.73323,
          59.725126
        ],
        [
          7.737028,
          59.716653
        ],
        [
          7.741993,
          59.706898
        ],
        [
          7.758059,
          59.697368
        ],
        [
          7.76941,
          59.689915
        ],
        [
          7.783084,
          59.679225
        ],
        [
          7.788679,
          59.672069
        ],
        [
          7.800923,
          59.66188
        ],
        [
          7.81727,
          59.651525
        ],
        [
          7.827086,
          59.64608
        ],
        [
          7.83561,
          59.639508
        ],
        [
          7.846668,
          59.628831
        ],
        [
          7.850269,
          59.624811
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Frogner - Røykås|line/0",
      "name": "Frogner - Røykås",
      "category": "line",
      "fromExternalId": "relation/8239198",
      "toExternalId": "way/295444099",
      "nominalKv": 300,
      "lengthKm": 16.08,
      "operator": "Statnett",
      "path": [
        [
          10.932205,
          59.930249
        ],
        [
          10.931922,
          59.933586
        ],
        [
          10.937576,
          59.939684
        ],
        [
          10.950657,
          59.947128
        ],
        [
          10.957795,
          59.953418
        ],
        [
          10.971571,
          59.9608
        ],
        [
          10.98408,
          59.969111
        ],
        [
          10.98706,
          59.976669
        ],
        [
          10.995855,
          59.983369
        ],
        [
          11.010071,
          59.986444
        ],
        [
          11.025915,
          59.986675
        ],
        [
          11.040125,
          59.989956
        ],
        [
          11.0597,
          59.995463
        ],
        [
          11.0731,
          60.004016
        ],
        [
          11.090567,
          60.007481
        ],
        [
          11.109999,
          60.004581
        ],
        [
          11.126516,
          60.004723
        ],
        [
          11.134849,
          60.00551
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Sylling - Hamang 1|line/0",
      "name": "Sylling - Hamang 1",
      "category": "line",
      "fromExternalId": "way/128406208",
      "toExternalId": "way/187555858",
      "nominalKv": 300,
      "lengthKm": 15.84,
      "operator": "Statnett",
      "path": [
        [
          10.215929,
          59.866555
        ],
        [
          10.227412,
          59.869029
        ],
        [
          10.240482,
          59.869071
        ],
        [
          10.266352,
          59.872304
        ],
        [
          10.285103,
          59.87533
        ],
        [
          10.307197,
          59.87892
        ],
        [
          10.323031,
          59.87881
        ],
        [
          10.347281,
          59.878648
        ],
        [
          10.361222,
          59.878562
        ],
        [
          10.377932,
          59.881833
        ],
        [
          10.389276,
          59.883214
        ],
        [
          10.405301,
          59.885164
        ],
        [
          10.417668,
          59.886668
        ],
        [
          10.437148,
          59.88907
        ],
        [
          10.44839,
          59.891399
        ],
        [
          10.461266,
          59.896569
        ],
        [
          10.473301,
          59.898546
        ],
        [
          10.484984,
          59.898448
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Sylling - Hamang 2|line/0",
      "name": "Sylling - Hamang 2",
      "category": "line",
      "fromExternalId": "way/128406208",
      "toExternalId": "way/187555858",
      "nominalKv": 300,
      "lengthKm": 15.84,
      "operator": "Statnett",
      "path": [
        [
          10.215689,
          59.866335
        ],
        [
          10.227821,
          59.868841
        ],
        [
          10.239804,
          59.868792
        ],
        [
          10.266513,
          59.872043
        ],
        [
          10.285364,
          59.875083
        ],
        [
          10.307023,
          59.878645
        ],
        [
          10.323096,
          59.878532
        ],
        [
          10.347195,
          59.878369
        ],
        [
          10.361203,
          59.878296
        ],
        [
          10.378128,
          59.881566
        ],
        [
          10.389409,
          59.882942
        ],
        [
          10.405431,
          59.884883
        ],
        [
          10.417798,
          59.8864
        ],
        [
          10.437309,
          59.888807
        ],
        [
          10.448748,
          59.891199
        ],
        [
          10.461444,
          59.896305
        ],
        [
          10.473472,
          59.898282
        ],
        [
          10.484984,
          59.898448
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Bamble - Porsgrunn|line/0",
      "name": "Bamble - Porsgrunn",
      "category": "line",
      "fromExternalId": "way/100648754",
      "toExternalId": "way/206628449",
      "nominalKv": 300,
      "lengthKm": 11.04,
      "operator": "Statnett",
      "path": [
        [
          9.673026,
          59.115199
        ],
        [
          9.677879,
          59.112656
        ],
        [
          9.678132,
          59.107304
        ],
        [
          9.678371,
          59.102794
        ],
        [
          9.678597,
          59.09827
        ],
        [
          9.67882,
          59.093849
        ],
        [
          9.679223,
          59.085454
        ],
        [
          9.679461,
          59.080923
        ],
        [
          9.679687,
          59.076441
        ],
        [
          9.667849,
          59.074143
        ],
        [
          9.657047,
          59.073753
        ],
        [
          9.650652,
          59.073056
        ],
        [
          9.623921,
          59.058641
        ],
        [
          9.615135,
          59.052935
        ],
        [
          9.606034,
          59.047673
        ],
        [
          9.599563,
          59.044609
        ],
        [
          9.595409,
          59.041557
        ],
        [
          9.595712,
          59.041291
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|300|Statnett|Sogn - Ulven|cable/2",
      "name": "Sogn - Ulven",
      "category": "cable",
      "fromExternalId": "way/113442999",
      "toExternalId": "relation/10308957",
      "nominalKv": 300,
      "lengthKm": 7.93,
      "operator": "Statnett",
      "path": [
        [
          10.810639,
          59.922418
        ],
        [
          10.813674,
          59.923138
        ],
        [
          10.810714,
          59.92622
        ],
        [
          10.804905,
          59.929903
        ],
        [
          10.802393,
          59.932871
        ],
        [
          10.799253,
          59.936949
        ],
        [
          10.798144,
          59.940622
        ],
        [
          10.791702,
          59.943739
        ],
        [
          10.787566,
          59.947293
        ],
        [
          10.782219,
          59.950248
        ],
        [
          10.771569,
          59.952486
        ],
        [
          10.769198,
          59.957094
        ],
        [
          10.75893,
          59.958217
        ],
        [
          10.751865,
          59.959724
        ],
        [
          10.740488,
          59.961654
        ],
        [
          10.735016,
          59.961021
        ],
        [
          10.733128,
          59.959501
        ],
        [
          10.73301,
          59.958114
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Røykås - Ulven|line/0",
      "name": "Røykås - Ulven",
      "category": "line",
      "fromExternalId": "way/113442999",
      "toExternalId": "relation/8239198",
      "nominalKv": 300,
      "lengthKm": 6.98,
      "operator": "Statnett",
      "path": [
        [
          10.811582,
          59.922621
        ],
        [
          10.81172,
          59.922627
        ],
        [
          10.817006,
          59.923018
        ],
        [
          10.821211,
          59.923461
        ],
        [
          10.830564,
          59.924449
        ],
        [
          10.839147,
          59.92317
        ],
        [
          10.850418,
          59.924164
        ],
        [
          10.854668,
          59.925349
        ],
        [
          10.862014,
          59.927396
        ],
        [
          10.867681,
          59.927557
        ],
        [
          10.878149,
          59.92769
        ],
        [
          10.885271,
          59.927795
        ],
        [
          10.898083,
          59.928122
        ],
        [
          10.906811,
          59.928385
        ],
        [
          10.918986,
          59.92875
        ],
        [
          10.927,
          59.928988
        ],
        [
          10.932263,
          59.929747
        ],
        [
          10.932374,
          59.92982
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|300|Statnett|Sogn - Ulven|cable/1",
      "name": "Sogn - Ulven",
      "category": "cable",
      "fromExternalId": "way/113442999",
      "toExternalId": "relation/10308957",
      "nominalKv": 300,
      "lengthKm": 6.67,
      "operator": "Statnett",
      "path": [
        [
          10.80952,
          59.9223
        ],
        [
          10.80607,
          59.924969
        ],
        [
          10.802618,
          59.927093
        ],
        [
          10.802168,
          59.930119
        ],
        [
          10.800749,
          59.931503
        ],
        [
          10.797944,
          59.932638
        ],
        [
          10.793404,
          59.934082
        ],
        [
          10.790752,
          59.934997
        ],
        [
          10.781831,
          59.93941
        ],
        [
          10.777169,
          59.949246
        ],
        [
          10.774914,
          59.951228
        ],
        [
          10.76856,
          59.952695
        ],
        [
          10.766502,
          59.953328
        ],
        [
          10.751045,
          59.952633
        ],
        [
          10.749057,
          59.954721
        ],
        [
          10.744951,
          59.956972
        ],
        [
          10.73993,
          59.958249
        ],
        [
          10.73301,
          59.958114
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Bærum - Smestad|line/0",
      "name": "Bærum - Smestad",
      "category": "line",
      "fromExternalId": "way/749676336",
      "toExternalId": "node/12765722163",
      "nominalKv": 300,
      "lengthKm": 6.58,
      "operator": "Statnett",
      "path": [
        [
          10.557925,
          59.926572
        ],
        [
          10.566558,
          59.927082
        ],
        [
          10.573418,
          59.928469
        ],
        [
          10.582444,
          59.930287
        ],
        [
          10.590511,
          59.931906
        ],
        [
          10.60313,
          59.933357
        ],
        [
          10.612089,
          59.933968
        ],
        [
          10.618939,
          59.934447
        ],
        [
          10.625079,
          59.935272
        ],
        [
          10.630364,
          59.935995
        ],
        [
          10.636561,
          59.936859
        ],
        [
          10.640638,
          59.938944
        ],
        [
          10.645464,
          59.939076
        ],
        [
          10.652004,
          59.937336
        ],
        [
          10.659217,
          59.936198
        ],
        [
          10.665228,
          59.935699
        ],
        [
          10.66786,
          59.935175
        ],
        [
          10.668448,
          59.934869
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Hamang - Bærum|line/0",
      "name": "Hamang - Bærum",
      "category": "line",
      "fromExternalId": "way/187555858",
      "toExternalId": "way/749676336",
      "nominalKv": 300,
      "lengthKm": 4.64,
      "operator": "Statnett",
      "path": [
        [
          10.502186,
          59.897884
        ],
        [
          10.502425,
          59.897938
        ],
        [
          10.506685,
          59.899186
        ],
        [
          10.509639,
          59.900214
        ],
        [
          10.512399,
          59.90112
        ],
        [
          10.515591,
          59.902159
        ],
        [
          10.521774,
          59.903987
        ],
        [
          10.525089,
          59.904879
        ],
        [
          10.528169,
          59.905711
        ],
        [
          10.533725,
          59.909253
        ],
        [
          10.536084,
          59.910761
        ],
        [
          10.539763,
          59.912315
        ],
        [
          10.546778,
          59.915281
        ],
        [
          10.549732,
          59.917719
        ],
        [
          10.552249,
          59.919797
        ],
        [
          10.554877,
          59.921966
        ],
        [
          10.559078,
          59.925441
        ],
        [
          10.557817,
          59.926495
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Hadeland - Roa|line/0",
      "name": "Hadeland - Roa",
      "category": "line",
      "fromExternalId": "way/290390502",
      "toExternalId": "relation/8206955",
      "nominalKv": 300,
      "lengthKm": 4.28,
      "operator": "Statnett",
      "path": [
        [
          10.638886,
          60.31158
        ],
        [
          10.634613,
          60.310239
        ],
        [
          10.63207,
          60.309566
        ],
        [
          10.628425,
          60.308589
        ],
        [
          10.626376,
          60.308038
        ],
        [
          10.620083,
          60.306078
        ],
        [
          10.618182,
          60.305341
        ],
        [
          10.614547,
          60.303936
        ],
        [
          10.610897,
          60.302524
        ],
        [
          10.609011,
          60.301793
        ],
        [
          10.601726,
          60.298974
        ],
        [
          10.597177,
          60.297975
        ],
        [
          10.594795,
          60.297454
        ],
        [
          10.586604,
          60.294562
        ],
        [
          10.584402,
          60.293056
        ],
        [
          10.582344,
          60.291817
        ],
        [
          10.580445,
          60.290677
        ],
        [
          10.577633,
          60.288986
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|300|Statnett|Smestad - Sogn|cable/0",
      "name": "Smestad - Sogn",
      "category": "cable",
      "fromExternalId": "relation/10308957",
      "toExternalId": "node/12765722163",
      "nominalKv": 300,
      "lengthKm": 3.86,
      "operator": "Statnett",
      "path": [
        [
          10.718976,
          59.958259
        ],
        [
          10.71885,
          59.958225
        ],
        [
          10.718711,
          59.958178
        ],
        [
          10.674042,
          59.938505
        ],
        [
          10.668599,
          59.935195
        ],
        [
          10.668765,
          59.934895
        ],
        [
          10.66864,
          59.934778
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Nore I - Uvdal II|line/0",
      "name": "Nore I - Uvdal II",
      "category": "line",
      "fromExternalId": "relation/9552168",
      "toExternalId": "relation/7854485",
      "nominalKv": 300,
      "lengthKm": 2.61,
      "operator": "Statnett",
      "path": [
        [
          8.923924,
          60.258835
        ],
        [
          8.924085,
          60.258812
        ],
        [
          8.928468,
          60.258184
        ],
        [
          8.931525,
          60.25852
        ],
        [
          8.940377,
          60.261021
        ],
        [
          8.942453,
          60.260827
        ],
        [
          8.952607,
          60.259874
        ],
        [
          8.955499,
          60.260412
        ],
        [
          8.957469,
          60.26274
        ],
        [
          8.960828,
          60.266701
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Hjartdal - Gromstul|line/1",
      "name": "Hjartdal - Gromstul",
      "category": "line",
      "fromExternalId": "way/551194981",
      "toExternalId": "relation/18667239",
      "nominalKv": 132,
      "lengthKm": 70.05,
      "operator": "Lede",
      "path": [
        [
          8.7122,
          59.604343
        ],
        [
          8.7857,
          59.614189
        ],
        [
          8.859341,
          59.617478
        ],
        [
          8.933541,
          59.623069
        ],
        [
          8.983241,
          59.609579
        ],
        [
          9.026138,
          59.580065
        ],
        [
          9.068781,
          59.551031
        ],
        [
          9.107591,
          59.523556
        ],
        [
          9.154409,
          59.490519
        ],
        [
          9.217022,
          59.464432
        ],
        [
          9.258648,
          59.434004
        ],
        [
          9.299806,
          59.405567
        ],
        [
          9.335565,
          59.374869
        ],
        [
          9.341219,
          59.335447
        ],
        [
          9.369128,
          59.301143
        ],
        [
          9.412781,
          59.271594
        ],
        [
          9.462029,
          59.255537
        ],
        [
          9.523258,
          59.245908
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Kongsvinger - Åsnes|line/0",
      "name": "Kongsvinger - Åsnes",
      "category": "line",
      "fromExternalId": "way/329581506",
      "toExternalId": "relation/8222072",
      "nominalKv": 132,
      "lengthKm": 46.69,
      "operator": "Elvia",
      "path": [
        [
          11.959177,
          60.609772
        ],
        [
          11.944907,
          60.584088
        ],
        [
          11.938834,
          60.557355
        ],
        [
          11.933336,
          60.529654
        ],
        [
          11.9309,
          60.505745
        ],
        [
          11.932612,
          60.480806
        ],
        [
          11.934173,
          60.458233
        ],
        [
          11.935868,
          60.431876
        ],
        [
          11.937429,
          60.408046
        ],
        [
          11.938968,
          60.384777
        ],
        [
          11.942042,
          60.361172
        ],
        [
          11.943973,
          60.336255
        ],
        [
          11.945658,
          60.314041
        ],
        [
          11.947632,
          60.288016
        ],
        [
          11.95217,
          60.267992
        ],
        [
          11.959133,
          60.246978
        ],
        [
          11.966993,
          60.223195
        ],
        [
          11.977748,
          60.195493
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Svelgfoss - Gromstul|line/0",
      "name": "Svelgfoss - Gromstul",
      "category": "line",
      "fromExternalId": "way/1357912446",
      "toExternalId": "relation/7877635",
      "nominalKv": 132,
      "lengthKm": 41.4,
      "operator": "Lede",
      "path": [
        [
          9.524249,
          59.274842
        ],
        [
          9.509616,
          59.292871
        ],
        [
          9.47861,
          59.304769
        ],
        [
          9.444627,
          59.312167
        ],
        [
          9.417826,
          59.329118
        ],
        [
          9.386672,
          59.343555
        ],
        [
          9.360989,
          59.360844
        ],
        [
          9.356264,
          59.380417
        ],
        [
          9.342366,
          59.398127
        ],
        [
          9.332644,
          59.422195
        ],
        [
          9.330681,
          59.444161
        ],
        [
          9.327977,
          59.467157
        ],
        [
          9.320832,
          59.488174
        ],
        [
          9.325089,
          59.512148
        ],
        [
          9.308842,
          59.533888
        ],
        [
          9.292033,
          59.555023
        ],
        [
          9.287031,
          59.577698
        ],
        [
          9.291912,
          59.594079
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Såheim - Årlifoss|line/0",
      "name": "Såheim - Årlifoss",
      "category": "line",
      "fromExternalId": "relation/7879875",
      "toExternalId": "way/551037431",
      "nominalKv": 132,
      "lengthKm": 41.28,
      "operator": "Lede",
      "path": [
        [
          8.596902,
          59.877039
        ],
        [
          8.594307,
          59.866047
        ],
        [
          8.615229,
          59.852182
        ],
        [
          8.637215,
          59.837917
        ],
        [
          8.658825,
          59.820879
        ],
        [
          8.678097,
          59.802751
        ],
        [
          8.700214,
          59.789279
        ],
        [
          8.73195,
          59.772561
        ],
        [
          8.760813,
          59.757141
        ],
        [
          8.812076,
          59.741999
        ],
        [
          8.855495,
          59.727867
        ],
        [
          8.898588,
          59.719643
        ],
        [
          8.94182,
          59.712917
        ],
        [
          8.977284,
          59.702513
        ],
        [
          9.028769,
          59.693754
        ],
        [
          9.072062,
          59.69442
        ],
        [
          9.11972,
          59.698099
        ],
        [
          9.14452,
          59.685615
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Nore II - (Mykstufoss) - Rollag - (Djupdal) - Flesaker|line/2",
      "name": "Nore II - (Mykstufoss) - Rollag - (Djupdal) - Flesaker",
      "category": "line",
      "fromExternalId": "way/1165232853",
      "toExternalId": "relation/7871517",
      "nominalKv": 132,
      "lengthKm": 37.59,
      "operator": "Glitre Nett",
      "path": [
        [
          9.354885,
          59.941562
        ],
        [
          9.376112,
          59.927506
        ],
        [
          9.401287,
          59.911094
        ],
        [
          9.426409,
          59.894701
        ],
        [
          9.456372,
          59.877711
        ],
        [
          9.48163,
          59.861513
        ],
        [
          9.502836,
          59.847849
        ],
        [
          9.537367,
          59.82923
        ],
        [
          9.568137,
          59.813794
        ],
        [
          9.589112,
          59.802963
        ],
        [
          9.612678,
          59.789143
        ],
        [
          9.643684,
          59.772478
        ],
        [
          9.674068,
          59.763973
        ],
        [
          9.709468,
          59.753971
        ],
        [
          9.746761,
          59.745559
        ],
        [
          9.79083,
          59.736046
        ],
        [
          9.817795,
          59.72737
        ],
        [
          9.84423,
          59.718919
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Flå - Nes|line/0",
      "name": "Flå - Nes",
      "category": "line",
      "fromExternalId": "relation/7851610",
      "toExternalId": "way/550033067",
      "nominalKv": 132,
      "lengthKm": 36.06,
      "operator": "Glitre Nett",
      "path": [
        [
          9.104399,
          60.574377
        ],
        [
          9.117386,
          60.563639
        ],
        [
          9.136275,
          60.548246
        ],
        [
          9.152287,
          60.53309
        ],
        [
          9.159577,
          60.515122
        ],
        [
          9.171492,
          60.493229
        ],
        [
          9.194452,
          60.476619
        ],
        [
          9.222009,
          60.466361
        ],
        [
          9.260007,
          60.460099
        ],
        [
          9.294047,
          60.446506
        ],
        [
          9.327092,
          60.43226
        ],
        [
          9.355613,
          60.428312
        ],
        [
          9.395859,
          60.426473
        ],
        [
          9.42524,
          60.433798
        ],
        [
          9.45756,
          60.426031
        ],
        [
          9.48082,
          60.412573
        ],
        [
          9.502589,
          60.396074
        ],
        [
          9.531024,
          60.391281
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Nore II - (Mykstufoss) - Rollag - (Djupdal) - Flesaker|line/10",
      "name": "Nore II - (Mykstufoss) - Rollag - (Djupdal) - Flesaker",
      "category": "line",
      "fromExternalId": "relation/7854480",
      "toExternalId": "way/550195650",
      "nominalKv": 132,
      "lengthKm": 36.01,
      "operator": "Glitre Nett",
      "path": [
        [
          8.99868,
          60.239348
        ],
        [
          8.986511,
          60.228431
        ],
        [
          8.98996,
          60.209247
        ],
        [
          9.003092,
          60.186437
        ],
        [
          9.013834,
          60.170998
        ],
        [
          9.023255,
          60.15609
        ],
        [
          9.036207,
          60.139192
        ],
        [
          9.055376,
          60.119541
        ],
        [
          9.067289,
          60.099957
        ],
        [
          9.078226,
          60.09039
        ],
        [
          9.11133,
          60.083197
        ],
        [
          9.128442,
          60.064158
        ],
        [
          9.154755,
          60.054546
        ],
        [
          9.187065,
          60.042539
        ],
        [
          9.206299,
          60.033406
        ],
        [
          9.244663,
          60.012928
        ],
        [
          9.275755,
          59.999756
        ],
        [
          9.302113,
          59.986217
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Grønvollfoss - Nordagutu|line/1",
      "name": "Grønvollfoss - Nordagutu",
      "category": "line",
      "fromExternalId": "relation/7888664",
      "toExternalId": "relation/18303428",
      "nominalKv": 132,
      "lengthKm": 29.51,
      "operator": "Lede",
      "path": [
        [
          9.333186,
          59.416023
        ],
        [
          9.331142,
          59.43147
        ],
        [
          9.330786,
          59.446758
        ],
        [
          9.329538,
          59.46203
        ],
        [
          9.319437,
          59.476358
        ],
        [
          9.320875,
          59.492983
        ],
        [
          9.326674,
          59.510048
        ],
        [
          9.313451,
          59.526073
        ],
        [
          9.302083,
          59.542607
        ],
        [
          9.291794,
          59.555021
        ],
        [
          9.287527,
          59.571064
        ],
        [
          9.292071,
          59.585983
        ],
        [
          9.29026,
          59.599909
        ],
        [
          9.286205,
          59.61412
        ],
        [
          9.270117,
          59.625292
        ],
        [
          9.249684,
          59.637849
        ],
        [
          9.233046,
          59.648391
        ],
        [
          9.210564,
          59.659481
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Jåberg - Tveiten|line/0",
      "name": "Jåberg - Tveiten",
      "category": "line",
      "fromExternalId": "relation/14071300",
      "toExternalId": "way/51854396",
      "nominalKv": 132,
      "lengthKm": 28.56,
      "operator": "Lede",
      "path": [
        [
          10.161206,
          59.107746
        ],
        [
          10.16022,
          59.117941
        ],
        [
          10.16575,
          59.13287
        ],
        [
          10.176181,
          59.147227
        ],
        [
          10.184111,
          59.156719
        ],
        [
          10.19529,
          59.1712
        ],
        [
          10.2047,
          59.184975
        ],
        [
          10.217468,
          59.198579
        ],
        [
          10.227811,
          59.211455
        ],
        [
          10.242364,
          59.22364
        ],
        [
          10.25249,
          59.235815
        ],
        [
          10.267354,
          59.252722
        ],
        [
          10.284414,
          59.267003
        ],
        [
          10.299349,
          59.280406
        ],
        [
          10.313981,
          59.293151
        ],
        [
          10.33549,
          59.307527
        ],
        [
          10.360533,
          59.323807
        ],
        [
          10.379985,
          59.330457
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Grønvollfoss - Skollenborg|line/1",
      "name": "Grønvollfoss - Skollenborg",
      "category": "line",
      "fromExternalId": "relation/18303429",
      "toExternalId": "relation/7875593",
      "nominalKv": 132,
      "lengthKm": 28.03,
      "operator": "Glitre Nett",
      "path": [
        [
          9.208802,
          59.65804
        ],
        [
          9.236514,
          59.655032
        ],
        [
          9.266244,
          59.650495
        ],
        [
          9.293688,
          59.646313
        ],
        [
          9.319196,
          59.642451
        ],
        [
          9.352691,
          59.638255
        ],
        [
          9.379792,
          59.634977
        ],
        [
          9.410874,
          59.635593
        ],
        [
          9.437385,
          59.637173
        ],
        [
          9.456339,
          59.636887
        ],
        [
          9.485756,
          59.636452
        ],
        [
          9.523205,
          59.635894
        ],
        [
          9.551974,
          59.635479
        ],
        [
          9.576548,
          59.631595
        ],
        [
          9.600262,
          59.620441
        ],
        [
          9.635594,
          59.613592
        ],
        [
          9.659482,
          59.609066
        ],
        [
          9.683506,
          59.607813
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Krabyskogen - Hurdal|line/0",
      "name": "Krabyskogen - Hurdal",
      "category": "line",
      "fromExternalId": "relation/8205424",
      "toExternalId": "relation/8205422",
      "nominalKv": 132,
      "lengthKm": 27.47,
      "operator": "Elvia",
      "path": [
        [
          10.871915,
          60.650886
        ],
        [
          10.890441,
          60.637822
        ],
        [
          10.90789,
          60.625501
        ],
        [
          10.923843,
          60.613226
        ],
        [
          10.938427,
          60.601211
        ],
        [
          10.950049,
          60.58994
        ],
        [
          10.956328,
          60.573077
        ],
        [
          10.959509,
          60.556019
        ],
        [
          10.962073,
          60.540182
        ],
        [
          10.965533,
          60.526613
        ],
        [
          10.976957,
          60.510789
        ],
        [
          10.991379,
          60.497764
        ],
        [
          11.009484,
          60.487669
        ],
        [
          11.029635,
          60.476982
        ],
        [
          11.047323,
          60.467156
        ],
        [
          11.05826,
          60.452602
        ],
        [
          11.066514,
          60.440578
        ],
        [
          11.078689,
          60.433848
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Hjartdal - Grønvollfoss|line/1",
      "name": "Hjartdal - Grønvollfoss",
      "category": "line",
      "fromExternalId": "way/551194981",
      "toExternalId": "relation/18303429",
      "nominalKv": 132,
      "lengthKm": 26.47,
      "operator": "Lede",
      "path": [
        [
          8.712022,
          59.604339
        ],
        [
          8.741556,
          59.609362
        ],
        [
          8.769999,
          59.61276
        ],
        [
          8.803273,
          59.615925
        ],
        [
          8.83107,
          59.61804
        ],
        [
          8.859304,
          59.617584
        ],
        [
          8.885082,
          59.619744
        ],
        [
          8.91229,
          59.621813
        ],
        [
          8.942301,
          59.623602
        ],
        [
          8.975771,
          59.624543
        ],
        [
          9.002464,
          59.629477
        ],
        [
          9.026518,
          59.637049
        ],
        [
          9.043722,
          59.641845
        ],
        [
          9.063297,
          59.645641
        ],
        [
          9.086691,
          59.647557
        ],
        [
          9.112998,
          59.649707
        ],
        [
          9.13488,
          59.651482
        ],
        [
          9.164148,
          59.653853
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Skollenborg - Hof|line/1",
      "name": "Skollenborg - Hof",
      "category": "line",
      "fromExternalId": "way/355844786",
      "toExternalId": "relation/7875593",
      "nominalKv": 132,
      "lengthKm": 24.77,
      "operator": "Glitre Nett",
      "path": [
        [
          10.104219,
          59.576907
        ],
        [
          10.080447,
          59.578435
        ],
        [
          10.053361,
          59.575081
        ],
        [
          10.024668,
          59.572365
        ],
        [
          10.002311,
          59.571397
        ],
        [
          9.979518,
          59.569732
        ],
        [
          9.956564,
          59.569506
        ],
        [
          9.937933,
          59.572206
        ],
        [
          9.917178,
          59.579677
        ],
        [
          9.897507,
          59.586143
        ],
        [
          9.869826,
          59.589633
        ],
        [
          9.847422,
          59.590764
        ],
        [
          9.824814,
          59.59133
        ],
        [
          9.788234,
          59.596293
        ],
        [
          9.759958,
          59.601076
        ],
        [
          9.734665,
          59.603718
        ],
        [
          9.712746,
          59.60647
        ],
        [
          9.683506,
          59.607813
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Vammafossen - Skjøren|line/0",
      "name": "Vammafossen - Skjøren",
      "category": "line",
      "fromExternalId": "relation/8251802",
      "toExternalId": "way/1004193643",
      "nominalKv": 132,
      "lengthKm": 23.4,
      "operator": "Elvia",
      "path": [
        [
          11.172249,
          59.538432
        ],
        [
          11.16532,
          59.524062
        ],
        [
          11.161411,
          59.513954
        ],
        [
          11.158502,
          59.50244
        ],
        [
          11.156179,
          59.491181
        ],
        [
          11.154634,
          59.480051
        ],
        [
          11.150734,
          59.466871
        ],
        [
          11.1443,
          59.454541
        ],
        [
          11.138309,
          59.443007
        ],
        [
          11.13319,
          59.432575
        ],
        [
          11.129162,
          59.421643
        ],
        [
          11.127813,
          59.40813
        ],
        [
          11.129869,
          59.393684
        ],
        [
          11.13183,
          59.378375
        ],
        [
          11.128086,
          59.366473
        ],
        [
          11.126075,
          59.354747
        ],
        [
          11.118242,
          59.344601
        ],
        [
          11.105735,
          59.333917
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Hallingsdal - (Solum) - Meen|line/0",
      "name": "Hallingsdal - (Solum) - Meen",
      "category": "line",
      "fromExternalId": "way/1078030962",
      "toExternalId": "relation/10582233",
      "nominalKv": 132,
      "lengthKm": 22.66,
      "operator": "Lede",
      "path": [
        [
          10.010179,
          59.11638
        ],
        [
          10.008064,
          59.121081
        ],
        [
          9.985146,
          59.1251
        ],
        [
          9.958426,
          59.127753
        ],
        [
          9.924417,
          59.128389
        ],
        [
          9.894304,
          59.125793
        ],
        [
          9.874707,
          59.128436
        ],
        [
          9.854919,
          59.130839
        ],
        [
          9.837549,
          59.132893
        ],
        [
          9.801964,
          59.137754
        ],
        [
          9.781983,
          59.144949
        ],
        [
          9.768709,
          59.149841
        ],
        [
          9.75156,
          59.158589
        ],
        [
          9.73445,
          59.167271
        ],
        [
          9.715041,
          59.173798
        ],
        [
          9.697044,
          59.179615
        ],
        [
          9.679035,
          59.179741
        ],
        [
          9.660141,
          59.177034
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Nordagutu - Rød|line/1",
      "name": "Nordagutu - Rød",
      "category": "line",
      "fromExternalId": "relation/7888664",
      "toExternalId": "relation/18667238",
      "nominalKv": 132,
      "lengthKm": 21.01,
      "operator": "Lede",
      "path": [
        [
          9.333186,
          59.416023
        ],
        [
          9.334541,
          59.405351
        ],
        [
          9.346248,
          59.393263
        ],
        [
          9.352772,
          59.38354
        ],
        [
          9.359826,
          59.37278
        ],
        [
          9.359885,
          59.362185
        ],
        [
          9.368597,
          59.353436
        ],
        [
          9.382635,
          59.344601
        ],
        [
          9.403583,
          59.338418
        ],
        [
          9.418942,
          59.327252
        ],
        [
          9.427713,
          59.318997
        ],
        [
          9.449578,
          59.310251
        ],
        [
          9.469469,
          59.305941
        ],
        [
          9.485166,
          59.30318
        ],
        [
          9.503045,
          59.296344
        ],
        [
          9.516172,
          59.289723
        ],
        [
          9.536294,
          59.280498
        ],
        [
          9.543569,
          59.275813
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Nore II - Eggedal|line/0",
      "name": "Nore II - Eggedal",
      "category": "line",
      "fromExternalId": "relation/7854480",
      "toExternalId": "way/550190735",
      "nominalKv": 132,
      "lengthKm": 20.14,
      "operator": "Glitre Nett",
      "path": [
        [
          9.00044,
          60.238879
        ],
        [
          9.020655,
          60.241273
        ],
        [
          9.039881,
          60.243454
        ],
        [
          9.057745,
          60.244758
        ],
        [
          9.085919,
          60.244228
        ],
        [
          9.106218,
          60.243818
        ],
        [
          9.126806,
          60.243392
        ],
        [
          9.147245,
          60.242032
        ],
        [
          9.166186,
          60.239814
        ],
        [
          9.188154,
          60.238347
        ],
        [
          9.209665,
          60.238536
        ],
        [
          9.230672,
          60.238706
        ],
        [
          9.253229,
          60.238757
        ],
        [
          9.271351,
          60.238967
        ],
        [
          9.292974,
          60.239934
        ],
        [
          9.318852,
          60.240032
        ],
        [
          9.343845,
          60.237319
        ],
        [
          9.361419,
          60.2354
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Sandum - Flå|line/0",
      "name": "Sandum - Flå",
      "category": "line",
      "fromExternalId": "way/550378158",
      "toExternalId": "way/550033067",
      "nominalKv": 132,
      "lengthKm": 20.12,
      "operator": "Glitre Nett",
      "path": [
        [
          9.598681,
          60.221635
        ],
        [
          9.597201,
          60.231212
        ],
        [
          9.600833,
          60.240461
        ],
        [
          9.599422,
          60.252268
        ],
        [
          9.59203,
          60.262016
        ],
        [
          9.590383,
          60.274326
        ],
        [
          9.581671,
          60.28323
        ],
        [
          9.575304,
          60.292581
        ],
        [
          9.564098,
          60.299357
        ],
        [
          9.550552,
          60.31122
        ],
        [
          9.542313,
          60.321009
        ],
        [
          9.536441,
          60.333795
        ],
        [
          9.529167,
          60.345649
        ],
        [
          9.524674,
          60.356664
        ],
        [
          9.519981,
          60.368235
        ],
        [
          9.522008,
          60.37386
        ],
        [
          9.527335,
          60.38229
        ],
        [
          9.531511,
          60.391358
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skarnes - Kongsvinger|line/0",
      "name": "Skarnes - Kongsvinger",
      "category": "line",
      "fromExternalId": "way/329581503",
      "toExternalId": "relation/8222072",
      "nominalKv": 132,
      "lengthKm": 18.59,
      "operator": "Statnett",
      "path": [
        [
          11.676637,
          60.244478
        ],
        [
          11.691245,
          60.244252
        ],
        [
          11.70641,
          60.244355
        ],
        [
          11.729112,
          60.241385
        ],
        [
          11.750511,
          60.237451
        ],
        [
          11.767664,
          60.234292
        ],
        [
          11.788647,
          60.230432
        ],
        [
          11.808444,
          60.226204
        ],
        [
          11.818569,
          60.222523
        ],
        [
          11.835617,
          60.215068
        ],
        [
          11.850718,
          60.20845
        ],
        [
          11.866962,
          60.201323
        ],
        [
          11.88416,
          60.196292
        ],
        [
          11.903067,
          60.197533
        ],
        [
          11.925155,
          60.199598
        ],
        [
          11.945674,
          60.201728
        ],
        [
          11.961472,
          60.200715
        ],
        [
          11.977474,
          60.195375
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Sandum - Sokna|line/1",
      "name": "Sandum - Sokna",
      "category": "line",
      "fromExternalId": "way/550378158",
      "toExternalId": "way/503746987",
      "nominalKv": 132,
      "lengthKm": 18.11,
      "operator": "Glitre Nett",
      "path": [
        [
          9.600565,
          60.219957
        ],
        [
          9.625702,
          60.223509
        ],
        [
          9.639092,
          60.223538
        ],
        [
          9.658983,
          60.221612
        ],
        [
          9.675409,
          60.220013
        ],
        [
          9.70273,
          60.21729
        ],
        [
          9.724934,
          60.215049
        ],
        [
          9.741231,
          60.213788
        ],
        [
          9.757898,
          60.212475
        ],
        [
          9.775665,
          60.211105
        ],
        [
          9.796688,
          60.209444
        ],
        [
          9.808229,
          60.208537
        ],
        [
          9.829116,
          60.208882
        ],
        [
          9.851512,
          60.209243
        ],
        [
          9.869569,
          60.20953
        ],
        [
          9.887947,
          60.209823
        ],
        [
          9.906015,
          60.21009
        ],
        [
          9.924275,
          60.210372
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Hasle - Råde|line/0",
      "name": "Hasle - Råde",
      "category": "line",
      "fromExternalId": "way/1004193643",
      "toExternalId": "relation/11547182",
      "nominalKv": 132,
      "lengthKm": 17.99,
      "operator": "Elvia",
      "path": [
        [
          11.114498,
          59.328469
        ],
        [
          11.098107,
          59.330292
        ],
        [
          11.077295,
          59.332144
        ],
        [
          11.048024,
          59.334562
        ],
        [
          11.029681,
          59.336422
        ],
        [
          11.020558,
          59.337348
        ],
        [
          11.006152,
          59.338808
        ],
        [
          10.996003,
          59.339835
        ],
        [
          10.979585,
          59.342078
        ],
        [
          10.952335,
          59.343822
        ],
        [
          10.937867,
          59.340951
        ],
        [
          10.922864,
          59.337289
        ],
        [
          10.907137,
          59.334031
        ],
        [
          10.887604,
          59.335241
        ],
        [
          10.866069,
          59.33523
        ],
        [
          10.846266,
          59.334854
        ],
        [
          10.824014,
          59.339508
        ],
        [
          10.810284,
          59.343069
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Tyristrand - Kaggefoss|line/1",
      "name": "Tyristrand - Kaggefoss",
      "category": "line",
      "fromExternalId": "way/550388264",
      "toExternalId": "way/550454471",
      "nominalKv": 132,
      "lengthKm": 17.14,
      "operator": "Glitre Nett",
      "path": [
        [
          10.078132,
          60.109844
        ],
        [
          10.06993,
          60.105548
        ],
        [
          10.060623,
          60.097194
        ],
        [
          10.052812,
          60.087643
        ],
        [
          10.044658,
          60.077246
        ],
        [
          10.039793,
          60.070164
        ],
        [
          10.031204,
          60.056996
        ],
        [
          10.026634,
          60.047912
        ],
        [
          10.023249,
          60.041162
        ],
        [
          10.019773,
          60.032219
        ],
        [
          10.01429,
          60.025954
        ],
        [
          10.006657,
          60.01681
        ],
        [
          10.00001,
          60.007483
        ],
        [
          9.997816,
          59.998906
        ],
        [
          9.994453,
          59.989908
        ],
        [
          9.991561,
          59.980572
        ],
        [
          9.987296,
          59.973537
        ],
        [
          9.979169,
          59.965862
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Ringerike - Sokna|line/0",
      "name": "Ringerike - Sokna",
      "category": "line",
      "fromExternalId": "way/503746987",
      "toExternalId": "way/205115991",
      "nominalKv": 132,
      "lengthKm": 16.7,
      "operator": "Glitre Nett",
      "path": [
        [
          9.924275,
          60.210372
        ],
        [
          9.940497,
          60.209778
        ],
        [
          9.959643,
          60.20735
        ],
        [
          9.976648,
          60.205788
        ],
        [
          9.995842,
          60.20502
        ],
        [
          10.018619,
          60.204315
        ],
        [
          10.032312,
          60.204339
        ],
        [
          10.049197,
          60.203946
        ],
        [
          10.065644,
          60.202624
        ],
        [
          10.076311,
          60.201761
        ],
        [
          10.094955,
          60.200088
        ],
        [
          10.116308,
          60.199222
        ],
        [
          10.132656,
          60.195897
        ],
        [
          10.153266,
          60.190513
        ],
        [
          10.164301,
          60.18311
        ],
        [
          10.175459,
          60.178522
        ],
        [
          10.190758,
          60.173693
        ],
        [
          10.203412,
          60.169228
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Frøystul - Såheim|line/0",
      "name": "Frøystul - Såheim",
      "category": "line",
      "fromExternalId": "way/551246032",
      "toExternalId": "relation/7879875",
      "nominalKv": 132,
      "lengthKm": 16.08,
      "operator": "Lede",
      "path": [
        [
          8.34733,
          59.824733
        ],
        [
          8.349926,
          59.825663
        ],
        [
          8.370799,
          59.825649
        ],
        [
          8.384408,
          59.830775
        ],
        [
          8.402599,
          59.837622
        ],
        [
          8.423499,
          59.843799
        ],
        [
          8.433627,
          59.847589
        ],
        [
          8.44987,
          59.852247
        ],
        [
          8.469727,
          59.858429
        ],
        [
          8.482352,
          59.864247
        ],
        [
          8.493349,
          59.870168
        ],
        [
          8.504896,
          59.874872
        ],
        [
          8.518363,
          59.876886
        ],
        [
          8.536189,
          59.877123
        ],
        [
          8.550496,
          59.877317
        ],
        [
          8.565396,
          59.876454
        ],
        [
          8.584319,
          59.875659
        ],
        [
          8.596545,
          59.876956
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Flesaker - Setersberg / Hokksund - Setersberg|line/0",
      "name": "Flesaker - Setersberg / Hokksund - Setersberg",
      "category": "line",
      "fromExternalId": "relation/7871517",
      "toExternalId": "way/550454423",
      "nominalKv": 132,
      "lengthKm": 15.6,
      "operator": "Glitre Nett",
      "path": [
        [
          9.891367,
          59.766682
        ],
        [
          9.891623,
          59.775024
        ],
        [
          9.88302,
          59.778332
        ],
        [
          9.874861,
          59.784448
        ],
        [
          9.875786,
          59.794526
        ],
        [
          9.874908,
          59.8047
        ],
        [
          9.872818,
          59.811886
        ],
        [
          9.870356,
          59.821396
        ],
        [
          9.868288,
          59.830317
        ],
        [
          9.866562,
          59.835367
        ],
        [
          9.866134,
          59.842831
        ],
        [
          9.867151,
          59.851759
        ],
        [
          9.867895,
          59.85838
        ],
        [
          9.869058,
          59.868055
        ],
        [
          9.870067,
          59.876596
        ],
        [
          9.874425,
          59.884084
        ],
        [
          9.880676,
          59.890713
        ],
        [
          9.889138,
          59.899654
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skarnes - Songkjølen|line/0",
      "name": "Skarnes - Songkjølen",
      "category": "line",
      "fromExternalId": "way/329581503",
      "toExternalId": "way/1036809822",
      "nominalKv": 132,
      "lengthKm": 15.36,
      "operator": "Statnett",
      "path": [
        [
          11.676658,
          60.244567
        ],
        [
          11.66372,
          60.245602
        ],
        [
          11.645781,
          60.246731
        ],
        [
          11.629844,
          60.246702
        ],
        [
          11.612436,
          60.246675
        ],
        [
          11.598151,
          60.246728
        ],
        [
          11.576597,
          60.246803
        ],
        [
          11.563303,
          60.247354
        ],
        [
          11.549034,
          60.250814
        ],
        [
          11.534743,
          60.256095
        ],
        [
          11.523151,
          60.260587
        ],
        [
          11.510046,
          60.265675
        ],
        [
          11.495143,
          60.271451
        ],
        [
          11.482285,
          60.276433
        ],
        [
          11.469295,
          60.281474
        ],
        [
          11.45756,
          60.28602
        ],
        [
          11.44239,
          60.291903
        ],
        [
          11.43171,
          60.296034
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Songkjølen - Minne|line/0",
      "name": "Songkjølen - Minne",
      "category": "line",
      "fromExternalId": "way/1036809822",
      "toExternalId": "way/120279477",
      "nominalKv": 132,
      "lengthKm": 15.22,
      "operator": "Statnett",
      "path": [
        [
          11.43171,
          60.296034
        ],
        [
          11.421302,
          60.300059
        ],
        [
          11.40825,
          60.305808
        ],
        [
          11.399876,
          60.310128
        ],
        [
          11.389003,
          60.315742
        ],
        [
          11.377518,
          60.321655
        ],
        [
          11.3671,
          60.327014
        ],
        [
          11.356049,
          60.332702
        ],
        [
          11.344119,
          60.338835
        ],
        [
          11.334082,
          60.34399
        ],
        [
          11.320655,
          60.35089
        ],
        [
          11.30903,
          60.356863
        ],
        [
          11.298113,
          60.362472
        ],
        [
          11.284901,
          60.368843
        ],
        [
          11.273335,
          60.374189
        ],
        [
          11.26155,
          60.379604
        ],
        [
          11.240763,
          60.388071
        ],
        [
          11.23181,
          60.388496
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Kvelde - Lofstad|line/1",
      "name": "Kvelde - Lofstad",
      "category": "line",
      "fromExternalId": "relation/14347510",
      "toExternalId": "relation/14347509",
      "nominalKv": 132,
      "lengthKm": 13.94,
      "operator": "Lede",
      "path": [
        [
          9.861937,
          59.31378
        ],
        [
          9.864478,
          59.30782
        ],
        [
          9.868986,
          59.301514
        ],
        [
          9.874674,
          59.293826
        ],
        [
          9.87971,
          59.287025
        ],
        [
          9.88683,
          59.279381
        ],
        [
          9.897069,
          59.273649
        ],
        [
          9.904931,
          59.268825
        ],
        [
          9.91571,
          59.261223
        ],
        [
          9.925587,
          59.254258
        ],
        [
          9.932386,
          59.247462
        ],
        [
          9.933725,
          59.242744
        ],
        [
          9.942815,
          59.235869
        ],
        [
          9.947616,
          59.230882
        ],
        [
          9.957197,
          59.222866
        ],
        [
          9.960355,
          59.215001
        ],
        [
          9.962502,
          59.208298
        ],
        [
          9.963059,
          59.202481
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Aslakrud - Hadeland|line/0",
      "name": "Aslakrud - Hadeland",
      "category": "line",
      "fromExternalId": "relation/8207215",
      "toExternalId": "relation/8206955",
      "nominalKv": 132,
      "lengthKm": 13.78,
      "operator": "Glitre Nett",
      "path": [
        [
          10.379191,
          60.220492
        ],
        [
          10.386597,
          60.221271
        ],
        [
          10.39886,
          60.22624
        ],
        [
          10.41476,
          60.231643
        ],
        [
          10.426436,
          60.23438
        ],
        [
          10.436333,
          60.241112
        ],
        [
          10.443004,
          60.246433
        ],
        [
          10.451426,
          60.252745
        ],
        [
          10.462983,
          60.256468
        ],
        [
          10.477355,
          60.260456
        ],
        [
          10.488073,
          60.263421
        ],
        [
          10.49958,
          60.265921
        ],
        [
          10.516338,
          60.268536
        ],
        [
          10.531613,
          60.270915
        ],
        [
          10.545872,
          60.27314
        ],
        [
          10.556888,
          60.278326
        ],
        [
          10.569419,
          60.284229
        ],
        [
          10.576909,
          60.288522
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Sandum - Eggedal|line/0",
      "name": "Sandum - Eggedal",
      "category": "line",
      "fromExternalId": "way/550190735",
      "toExternalId": "way/550378158",
      "nominalKv": 132,
      "lengthKm": 13.43,
      "operator": "Glitre Nett",
      "path": [
        [
          9.362082,
          60.235329
        ],
        [
          9.367502,
          60.234752
        ],
        [
          9.375409,
          60.233891
        ],
        [
          9.390355,
          60.232237
        ],
        [
          9.406963,
          60.230426
        ],
        [
          9.423845,
          60.228956
        ],
        [
          9.436145,
          60.227872
        ],
        [
          9.452502,
          60.226444
        ],
        [
          9.471272,
          60.224044
        ],
        [
          9.481941,
          60.222685
        ],
        [
          9.499102,
          60.220682
        ],
        [
          9.516102,
          60.219187
        ],
        [
          9.524063,
          60.218489
        ],
        [
          9.54374,
          60.217314
        ],
        [
          9.564253,
          60.217079
        ],
        [
          9.575309,
          60.216952
        ],
        [
          9.583876,
          60.217253
        ],
        [
          9.600565,
          60.219957
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Sande - Bentsrud|line/0",
      "name": "Sande - Bentsrud",
      "category": "line",
      "fromExternalId": "way/50881349",
      "toExternalId": "relation/10381726",
      "nominalKv": 132,
      "lengthKm": 13.29,
      "operator": "Lede",
      "path": [
        [
          10.218244,
          59.575539
        ],
        [
          10.2157,
          59.570711
        ],
        [
          10.21749,
          59.564697
        ],
        [
          10.22339,
          59.555935
        ],
        [
          10.228263,
          59.547383
        ],
        [
          10.238009,
          59.540977
        ],
        [
          10.250491,
          59.533732
        ],
        [
          10.260014,
          59.528175
        ],
        [
          10.263922,
          59.524103
        ],
        [
          10.271949,
          59.515236
        ],
        [
          10.275869,
          59.510101
        ],
        [
          10.277946,
          59.503788
        ],
        [
          10.279998,
          59.497137
        ],
        [
          10.283579,
          59.491113
        ],
        [
          10.288192,
          59.486547
        ],
        [
          10.294959,
          59.479222
        ],
        [
          10.30467,
          59.474698
        ],
        [
          10.312154,
          59.471078
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Bødalen - Storsand|line/0",
      "name": "Bødalen - Storsand",
      "category": "line",
      "fromExternalId": "way/39694172",
      "toExternalId": "way/26938543",
      "nominalKv": 132,
      "lengthKm": 12.97,
      "operator": "Glitre Nett",
      "path": [
        [
          10.459525,
          59.75283
        ],
        [
          10.461156,
          59.749669
        ],
        [
          10.466279,
          59.740374
        ],
        [
          10.46924,
          59.734968
        ],
        [
          10.474639,
          59.725123
        ],
        [
          10.477665,
          59.719604
        ],
        [
          10.48104,
          59.712845
        ],
        [
          10.486547,
          59.705751
        ],
        [
          10.493928,
          59.699272
        ],
        [
          10.505755,
          59.69078
        ],
        [
          10.515318,
          59.684272
        ],
        [
          10.524704,
          59.678727
        ],
        [
          10.530888,
          59.676336
        ],
        [
          10.540376,
          59.67269
        ],
        [
          10.552722,
          59.667882
        ],
        [
          10.559827,
          59.664614
        ],
        [
          10.571323,
          59.658477
        ],
        [
          10.573597,
          59.65565
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Rød - Meen 1+2|line/0",
      "name": "Rød - Meen 1+2",
      "category": "line",
      "fromExternalId": "relation/10582233",
      "toExternalId": "relation/18667238",
      "nominalKv": 132,
      "lengthKm": 12.94,
      "operator": "Lede",
      "path": [
        [
          9.656862,
          59.17606
        ],
        [
          9.654703,
          59.179568
        ],
        [
          9.648633,
          59.187678
        ],
        [
          9.643864,
          59.193762
        ],
        [
          9.639331,
          59.199427
        ],
        [
          9.632816,
          59.207001
        ],
        [
          9.627432,
          59.21218
        ],
        [
          9.622776,
          59.21667
        ],
        [
          9.613431,
          59.224896
        ],
        [
          9.608671,
          59.230941
        ],
        [
          9.602822,
          59.237282
        ],
        [
          9.597448,
          59.242493
        ],
        [
          9.590421,
          59.248489
        ],
        [
          9.57955,
          59.251338
        ],
        [
          9.572238,
          59.257052
        ],
        [
          9.564452,
          59.263117
        ],
        [
          9.555003,
          59.270497
        ],
        [
          9.544914,
          59.275227
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Uvdal I - Uvdal II|line/0",
      "name": "Uvdal I - Uvdal II",
      "category": "line",
      "fromExternalId": "relation/9552170",
      "toExternalId": "relation/9552168",
      "nominalKv": 132,
      "lengthKm": 12.59,
      "operator": "Lede",
      "path": [
        [
          8.703429,
          60.254628
        ],
        [
          8.713703,
          60.255773
        ],
        [
          8.726867,
          60.257612
        ],
        [
          8.741604,
          60.259676
        ],
        [
          8.755857,
          60.261661
        ],
        [
          8.76834,
          60.263402
        ],
        [
          8.783113,
          60.264544
        ],
        [
          8.795253,
          60.26117
        ],
        [
          8.806298,
          60.258102
        ],
        [
          8.820991,
          60.256571
        ],
        [
          8.837423,
          60.254871
        ],
        [
          8.851848,
          60.25419
        ],
        [
          8.866417,
          60.255076
        ],
        [
          8.881506,
          60.255993
        ],
        [
          8.893138,
          60.256691
        ],
        [
          8.902253,
          60.257243
        ],
        [
          8.915432,
          60.258273
        ],
        [
          8.923924,
          60.258835
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Storsand - Tofte|line/0",
      "name": "Storsand - Tofte",
      "category": "line",
      "fromExternalId": "way/26938543",
      "toExternalId": "way/27030901",
      "nominalKv": 132,
      "lengthKm": 11.99,
      "operator": "Glitre Nett",
      "path": [
        [
          10.573431,
          59.655615
        ],
        [
          10.578721,
          59.649271
        ],
        [
          10.582263,
          59.64485
        ],
        [
          10.586937,
          59.637678
        ],
        [
          10.587692,
          59.631034
        ],
        [
          10.589011,
          59.621405
        ],
        [
          10.589931,
          59.614319
        ],
        [
          10.590678,
          59.608504
        ],
        [
          10.584838,
          59.599336
        ],
        [
          10.581167,
          59.594629
        ],
        [
          10.577932,
          59.588257
        ],
        [
          10.573044,
          59.583199
        ],
        [
          10.56388,
          59.577989
        ],
        [
          10.555263,
          59.571763
        ],
        [
          10.557782,
          59.566586
        ],
        [
          10.56051,
          59.561011
        ],
        [
          10.562355,
          59.556779
        ],
        [
          10.563972,
          59.554775
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Lunde - Kvelde|line/1",
      "name": "Lunde - Kvelde",
      "category": "line",
      "fromExternalId": "way/1078030962",
      "toExternalId": "relation/14347509",
      "nominalKv": 132,
      "lengthKm": 11.93,
      "operator": "Lede",
      "path": [
        [
          10.058991,
          59.114121
        ],
        [
          10.058369,
          59.114205
        ],
        [
          10.051555,
          59.116545
        ],
        [
          10.04824,
          59.123303
        ],
        [
          10.045313,
          59.127821
        ],
        [
          10.036512,
          59.135739
        ],
        [
          10.026702,
          59.139794
        ],
        [
          10.010574,
          59.148421
        ],
        [
          10.006738,
          59.15195
        ],
        [
          10.000067,
          59.158298
        ],
        [
          9.993024,
          59.16486
        ],
        [
          9.985821,
          59.171565
        ],
        [
          9.975343,
          59.177108
        ],
        [
          9.970604,
          59.181832
        ],
        [
          9.965241,
          59.187147
        ],
        [
          9.95805,
          59.192368
        ],
        [
          9.961405,
          59.200108
        ],
        [
          9.963059,
          59.202481
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Hadeland - Harestua|line/0",
      "name": "Hadeland - Harestua",
      "category": "line",
      "fromExternalId": "relation/8206955",
      "toExternalId": "way/579583500",
      "nominalKv": 132,
      "lengthKm": 11.84,
      "operator": "Glitre Nett",
      "path": [
        [
          10.577647,
          60.288169
        ],
        [
          10.579346,
          60.281752
        ],
        [
          10.582961,
          60.274866
        ],
        [
          10.583884,
          60.270047
        ],
        [
          10.582375,
          60.264843
        ],
        [
          10.582428,
          60.258471
        ],
        [
          10.591429,
          60.255209
        ],
        [
          10.601015,
          60.252949
        ],
        [
          10.619088,
          60.248674
        ],
        [
          10.627304,
          60.245976
        ],
        [
          10.638782,
          60.240612
        ],
        [
          10.647844,
          60.236383
        ],
        [
          10.656687,
          60.232861
        ],
        [
          10.668309,
          60.229052
        ],
        [
          10.676707,
          60.226302
        ],
        [
          10.682825,
          60.222424
        ],
        [
          10.692833,
          60.216088
        ],
        [
          10.699699,
          60.211743
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Sørtveit - Lofstad|line/1",
      "name": "Sørtveit - Lofstad",
      "category": "line",
      "fromExternalId": "relation/14347513",
      "toExternalId": "relation/14347510",
      "nominalKv": 132,
      "lengthKm": 11.74,
      "operator": "Lede",
      "path": [
        [
          9.661366,
          59.307326
        ],
        [
          9.669308,
          59.307753
        ],
        [
          9.680412,
          59.308358
        ],
        [
          9.690963,
          59.308941
        ],
        [
          9.7049,
          59.309981
        ],
        [
          9.713753,
          59.310736
        ],
        [
          9.729228,
          59.31284
        ],
        [
          9.736442,
          59.314101
        ],
        [
          9.753448,
          59.317077
        ],
        [
          9.770429,
          59.319631
        ],
        [
          9.786264,
          59.32019
        ],
        [
          9.797567,
          59.318699
        ],
        [
          9.812044,
          59.316677
        ],
        [
          9.822253,
          59.315254
        ],
        [
          9.835127,
          59.313463
        ],
        [
          9.84548,
          59.313913
        ],
        [
          9.859462,
          59.314519
        ],
        [
          9.862873,
          59.31466
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Hadeland - Jaren|line/0",
      "name": "Hadeland - Jaren",
      "category": "line",
      "fromExternalId": "relation/8206955",
      "toExternalId": "relation/8206957",
      "nominalKv": 132,
      "lengthKm": 11.7,
      "operator": "Glitre Nett",
      "path": [
        [
          10.575186,
          60.292236
        ],
        [
          10.574569,
          60.297485
        ],
        [
          10.575545,
          60.30334
        ],
        [
          10.573359,
          60.307916
        ],
        [
          10.570824,
          60.31414
        ],
        [
          10.569416,
          60.318484
        ],
        [
          10.56946,
          60.323959
        ],
        [
          10.567619,
          60.330768
        ],
        [
          10.56623,
          60.33502
        ],
        [
          10.564878,
          60.342809
        ],
        [
          10.563864,
          60.347409
        ],
        [
          10.557175,
          60.356494
        ],
        [
          10.551075,
          60.362547
        ],
        [
          10.547057,
          60.368118
        ],
        [
          10.541529,
          60.376174
        ],
        [
          10.539322,
          60.383159
        ],
        [
          10.537978,
          60.388746
        ],
        [
          10.541394,
          60.3936
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|||line/10",
      "name": "merged/line/line|132|||line/10",
      "category": "line",
      "fromExternalId": "relation/14071300",
      "toExternalId": "way/1078030962",
      "nominalKv": 132,
      "lengthKm": 10.99,
      "operator": null,
      "path": [
        [
          10.15862,
          59.107979
        ],
        [
          10.151753,
          59.102107
        ],
        [
          10.149529,
          59.092993
        ],
        [
          10.147794,
          59.086924
        ],
        [
          10.143958,
          59.07937
        ],
        [
          10.140499,
          59.072695
        ],
        [
          10.136738,
          59.065957
        ],
        [
          10.134674,
          59.058335
        ],
        [
          10.134724,
          59.056806
        ],
        [
          10.134727,
          59.056746
        ],
        [
          10.134743,
          59.056453
        ],
        [
          10.13117,
          59.051502
        ],
        [
          10.117579,
          59.047752
        ],
        [
          10.102153,
          59.044979
        ],
        [
          10.090591,
          59.045475
        ],
        [
          10.07977,
          59.045915
        ],
        [
          10.066373,
          59.048082
        ],
        [
          10.060285,
          59.047907
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Follum - Aslakrud|line/0",
      "name": "Follum - Aslakrud",
      "category": "line",
      "fromExternalId": "relation/7867734",
      "toExternalId": "relation/8207215",
      "nominalKv": 132,
      "lengthKm": 10.45,
      "operator": "Glitre Nett",
      "path": [
        [
          10.23619,
          60.182658
        ],
        [
          10.231195,
          60.187582
        ],
        [
          10.233142,
          60.192284
        ],
        [
          10.244123,
          60.192696
        ],
        [
          10.255617,
          60.189521
        ],
        [
          10.265215,
          60.191943
        ],
        [
          10.276868,
          60.194492
        ],
        [
          10.283825,
          60.195951
        ],
        [
          10.292634,
          60.197526
        ],
        [
          10.299854,
          60.197953
        ],
        [
          10.316355,
          60.198923
        ],
        [
          10.331637,
          60.202947
        ],
        [
          10.342757,
          60.207147
        ],
        [
          10.351337,
          60.210515
        ],
        [
          10.357618,
          60.212236
        ],
        [
          10.365491,
          60.215686
        ],
        [
          10.370809,
          60.218011
        ],
        [
          10.37904,
          60.220476
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Hurdal - Minne|line/0",
      "name": "Hurdal - Minne",
      "category": "line",
      "fromExternalId": "relation/8205422",
      "toExternalId": "way/120279477",
      "nominalKv": 132,
      "lengthKm": 10.17,
      "operator": "Elvia",
      "path": [
        [
          11.078825,
          60.433788
        ],
        [
          11.085779,
          60.430619
        ],
        [
          11.095596,
          60.426261
        ],
        [
          11.101298,
          60.423727
        ],
        [
          11.111204,
          60.41932
        ],
        [
          11.116957,
          60.41676
        ],
        [
          11.128804,
          60.414015
        ],
        [
          11.13783,
          60.412573
        ],
        [
          11.14755,
          60.408899
        ],
        [
          11.154441,
          60.405197
        ],
        [
          11.163037,
          60.400432
        ],
        [
          11.171663,
          60.398362
        ],
        [
          11.184817,
          60.398105
        ],
        [
          11.195331,
          60.397896
        ],
        [
          11.208699,
          60.393574
        ],
        [
          11.217138,
          60.391204
        ],
        [
          11.226262,
          60.389044
        ],
        [
          11.231505,
          60.388821
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Grønvollfoss - Svelgfoss|line/0",
      "name": "Grønvollfoss - Svelgfoss",
      "category": "line",
      "fromExternalId": "relation/18303429",
      "toExternalId": "relation/7877635",
      "nominalKv": 132,
      "lengthKm": 10.08,
      "operator": "Lede",
      "path": [
        [
          9.20898,
          59.657975
        ],
        [
          9.217282,
          59.656978
        ],
        [
          9.22501,
          59.652214
        ],
        [
          9.235819,
          59.647455
        ],
        [
          9.241645,
          59.64363
        ],
        [
          9.246527,
          59.639976
        ],
        [
          9.253305,
          59.635834
        ],
        [
          9.261501,
          59.630798
        ],
        [
          9.267944,
          59.626822
        ],
        [
          9.276801,
          59.621356
        ],
        [
          9.283584,
          59.61716
        ],
        [
          9.286561,
          59.612523
        ],
        [
          9.288342,
          59.606962
        ],
        [
          9.289683,
          59.603359
        ],
        [
          9.290866,
          59.598427
        ],
        [
          9.287106,
          59.594374
        ],
        [
          9.278142,
          59.594237
        ],
        [
          9.273704,
          59.594169
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Trolldalen - Esso|line/0",
      "name": "Trolldalen - Esso",
      "category": "line",
      "fromExternalId": "way/753593226",
      "toExternalId": "relation/10384523",
      "nominalKv": 132,
      "lengthKm": 10.04,
      "operator": "Lede",
      "path": [
        [
          10.411706,
          59.37824
        ],
        [
          10.410992,
          59.37498
        ],
        [
          10.412703,
          59.37081
        ],
        [
          10.416493,
          59.363176
        ],
        [
          10.418758,
          59.358961
        ],
        [
          10.422219,
          59.352833
        ],
        [
          10.424689,
          59.349709
        ],
        [
          10.429527,
          59.343597
        ],
        [
          10.433646,
          59.341388
        ],
        [
          10.445463,
          59.338263
        ],
        [
          10.451998,
          59.336218
        ],
        [
          10.461449,
          59.332835
        ],
        [
          10.469146,
          59.329439
        ],
        [
          10.478883,
          59.324597
        ],
        [
          10.484236,
          59.321932
        ],
        [
          10.493331,
          59.317417
        ],
        [
          10.501886,
          59.314194
        ],
        [
          10.512441,
          59.312864
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett;Bane NOR Energi|Langum - Hafskjold / Langum - (Bragernes) - Hafskjold / Sundhaug - Asker|line/0",
      "name": "Langum - Hafskjold / Langum - (Bragernes) - Hafskjold / Sundhaug - Asker",
      "category": "line",
      "fromExternalId": "way/48306065",
      "toExternalId": "way/46832312",
      "nominalKv": 132,
      "lengthKm": 10,
      "operator": "Glitre Nett;Bane NOR Energi",
      "path": [
        [
          10.113674,
          59.746693
        ],
        [
          10.118746,
          59.750962
        ],
        [
          10.130065,
          59.753973
        ],
        [
          10.142132,
          59.754847
        ],
        [
          10.153023,
          59.755628
        ],
        [
          10.157357,
          59.757356
        ],
        [
          10.16703,
          59.760002
        ],
        [
          10.169892,
          59.765214
        ],
        [
          10.174996,
          59.768949
        ],
        [
          10.181981,
          59.770986
        ],
        [
          10.191371,
          59.773591
        ],
        [
          10.201738,
          59.777258
        ],
        [
          10.210514,
          59.781386
        ],
        [
          10.218821,
          59.784666
        ],
        [
          10.225347,
          59.786997
        ],
        [
          10.234907,
          59.789755
        ],
        [
          10.243709,
          59.792502
        ],
        [
          10.252006,
          59.7954
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Sylling - (Tranby) - Kjenner|line/0",
      "name": "Sylling - (Tranby) - Kjenner",
      "category": "line",
      "fromExternalId": "way/128406208",
      "toExternalId": "way/28028051",
      "nominalKv": 132,
      "lengthKm": 9.75,
      "operator": "Glitre Nett",
      "path": [
        [
          10.216644,
          59.867089
        ],
        [
          10.219086,
          59.865084
        ],
        [
          10.227974,
          59.863409
        ],
        [
          10.234167,
          59.862235
        ],
        [
          10.24584,
          59.858023
        ],
        [
          10.258838,
          59.853331
        ],
        [
          10.267882,
          59.850067
        ],
        [
          10.27984,
          59.845783
        ],
        [
          10.285149,
          59.84107
        ],
        [
          10.288433,
          59.838155
        ],
        [
          10.29326,
          59.83401
        ],
        [
          10.297235,
          59.831022
        ],
        [
          10.301942,
          59.826923
        ],
        [
          10.308461,
          59.821552
        ],
        [
          10.316527,
          59.814803
        ],
        [
          10.32007,
          59.813966
        ],
        [
          10.326742,
          59.810659
        ],
        [
          10.335591,
          59.806279
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Ringerike - Tyristrand|line/0",
      "name": "Ringerike - Tyristrand",
      "category": "line",
      "fromExternalId": "way/205115991",
      "toExternalId": "way/550388264",
      "nominalKv": 132,
      "lengthKm": 9.75,
      "operator": "Glitre Nett",
      "path": [
        [
          10.203562,
          60.16859
        ],
        [
          10.199347,
          60.167836
        ],
        [
          10.189256,
          60.166101
        ],
        [
          10.181875,
          60.163421
        ],
        [
          10.172771,
          60.159484
        ],
        [
          10.164226,
          60.155787
        ],
        [
          10.154162,
          60.152861
        ],
        [
          10.14508,
          60.150226
        ],
        [
          10.138278,
          60.14695
        ],
        [
          10.135617,
          60.144683
        ],
        [
          10.128646,
          60.138768
        ],
        [
          10.123692,
          60.135952
        ],
        [
          10.115613,
          60.132471
        ],
        [
          10.106252,
          60.128212
        ],
        [
          10.100051,
          60.124162
        ],
        [
          10.092026,
          60.118905
        ],
        [
          10.084457,
          60.114153
        ],
        [
          10.078132,
          60.109844
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Nordagutu - Gvarv|line/0",
      "name": "Nordagutu - Gvarv",
      "category": "line",
      "fromExternalId": "relation/7888662",
      "toExternalId": "relation/7888664",
      "nominalKv": 132,
      "lengthKm": 9.62,
      "operator": "Lede",
      "path": [
        [
          9.174585,
          59.37908
        ],
        [
          9.182645,
          59.381961
        ],
        [
          9.192191,
          59.385324
        ],
        [
          9.199481,
          59.387795
        ],
        [
          9.209821,
          59.389229
        ],
        [
          9.214501,
          59.391174
        ],
        [
          9.220557,
          59.394511
        ],
        [
          9.228787,
          59.396061
        ],
        [
          9.241302,
          59.398574
        ],
        [
          9.252492,
          59.400973
        ],
        [
          9.264312,
          59.403538
        ],
        [
          9.273759,
          59.405518
        ],
        [
          9.281344,
          59.407101
        ],
        [
          9.29328,
          59.409157
        ],
        [
          9.302496,
          59.410544
        ],
        [
          9.313949,
          59.411638
        ],
        [
          9.320848,
          59.412651
        ],
        [
          9.326958,
          59.414417
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Stangeby - Holtan|line/0",
      "name": "Stangeby - Holtan",
      "category": "line",
      "fromExternalId": "relation/11601416",
      "toExternalId": "relation/11601413",
      "nominalKv": 132,
      "lengthKm": 9.52,
      "operator": "Lede",
      "path": [
        [
          10.400112,
          59.217709
        ],
        [
          10.398851,
          59.214893
        ],
        [
          10.396581,
          59.210986
        ],
        [
          10.395788,
          59.205783
        ],
        [
          10.394147,
          59.199944
        ],
        [
          10.391942,
          59.194661
        ],
        [
          10.389541,
          59.188883
        ],
        [
          10.386794,
          59.183674
        ],
        [
          10.382224,
          59.179446
        ],
        [
          10.377972,
          59.170969
        ],
        [
          10.381346,
          59.167249
        ],
        [
          10.389967,
          59.165301
        ],
        [
          10.39685,
          59.162531
        ],
        [
          10.399695,
          59.157726
        ],
        [
          10.398455,
          59.153153
        ],
        [
          10.397685,
          59.149625
        ],
        [
          10.399582,
          59.143034
        ],
        [
          10.40339,
          59.142105
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett;Bane NOR Energi|Flesaker - Mjøndalen|line/0",
      "name": "Flesaker - Mjøndalen",
      "category": "line",
      "fromExternalId": "relation/7871517",
      "toExternalId": "relation/18555173",
      "nominalKv": 132,
      "lengthKm": 9.36,
      "operator": "Glitre Nett;Bane NOR Energi",
      "path": [
        [
          9.860628,
          59.718056
        ],
        [
          9.865771,
          59.720605
        ],
        [
          9.87246,
          59.722777
        ],
        [
          9.882481,
          59.726363
        ],
        [
          9.889943,
          59.72811
        ],
        [
          9.898792,
          59.729956
        ],
        [
          9.905079,
          59.731464
        ],
        [
          9.916532,
          59.734207
        ],
        [
          9.925472,
          59.735265
        ],
        [
          9.938008,
          59.736752
        ],
        [
          9.945701,
          59.73766
        ],
        [
          9.958667,
          59.738936
        ],
        [
          9.965474,
          59.739574
        ],
        [
          9.977979,
          59.740653
        ],
        [
          9.986583,
          59.741393
        ],
        [
          9.998599,
          59.742261
        ],
        [
          10.006532,
          59.743114
        ],
        [
          10.01614,
          59.744144
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Kjenner - (Spikkestad) - Bødalen|line/1",
      "name": "Kjenner - (Spikkestad) - Bødalen",
      "category": "line",
      "fromExternalId": "way/28028051",
      "toExternalId": "way/39694172",
      "nominalKv": 132,
      "lengthKm": 9.28,
      "operator": "Glitre Nett",
      "path": [
        [
          10.337732,
          59.805991
        ],
        [
          10.34141,
          59.803389
        ],
        [
          10.345436,
          59.800939
        ],
        [
          10.354544,
          59.795373
        ],
        [
          10.363173,
          59.790098
        ],
        [
          10.371931,
          59.784745
        ],
        [
          10.376083,
          59.782203
        ],
        [
          10.38271,
          59.778198
        ],
        [
          10.387644,
          59.775136
        ],
        [
          10.392392,
          59.772235
        ],
        [
          10.399993,
          59.767606
        ],
        [
          10.40567,
          59.765975
        ],
        [
          10.410679,
          59.764528
        ],
        [
          10.421624,
          59.761387
        ],
        [
          10.433003,
          59.758112
        ],
        [
          10.445905,
          59.754452
        ],
        [
          10.447875,
          59.753894
        ],
        [
          10.459525,
          59.75283
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Leinås - Svelvik 1&2|line/0",
      "name": "Leinås - Svelvik 1&2",
      "category": "line",
      "fromExternalId": "relation/10355950",
      "toExternalId": "relation/10355948",
      "nominalKv": 132,
      "lengthKm": 8.83,
      "operator": "Lede",
      "path": [
        [
          10.272622,
          59.565963
        ],
        [
          10.280736,
          59.569849
        ],
        [
          10.286492,
          59.572207
        ],
        [
          10.295852,
          59.576047
        ],
        [
          10.298209,
          59.577016
        ],
        [
          10.311376,
          59.582427
        ],
        [
          10.323688,
          59.587478
        ],
        [
          10.326947,
          59.588808
        ],
        [
          10.335447,
          59.592296
        ],
        [
          10.339445,
          59.593966
        ],
        [
          10.349747,
          59.595953
        ],
        [
          10.355536,
          59.597073
        ],
        [
          10.367224,
          59.599322
        ],
        [
          10.375135,
          59.600055
        ],
        [
          10.379668,
          59.600479
        ],
        [
          10.388268,
          59.602918
        ],
        [
          10.394794,
          59.604766
        ],
        [
          10.403317,
          59.607733
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Sundland - Gokstad / Jåberg - Stangeby|line/0",
      "name": "Sundland - Gokstad / Jåberg - Stangeby",
      "category": "line",
      "fromExternalId": "relation/11601417",
      "toExternalId": "relation/14071303",
      "nominalKv": 132,
      "lengthKm": 8.3,
      "operator": "Lede",
      "path": [
        [
          10.283719,
          59.228288
        ],
        [
          10.27999,
          59.224985
        ],
        [
          10.276679,
          59.222044
        ],
        [
          10.270658,
          59.216631
        ],
        [
          10.266427,
          59.213629
        ],
        [
          10.259775,
          59.210126
        ],
        [
          10.253962,
          59.207254
        ],
        [
          10.246746,
          59.203696
        ],
        [
          10.246968,
          59.199615
        ],
        [
          10.247163,
          59.196068
        ],
        [
          10.247384,
          59.192002
        ],
        [
          10.245936,
          59.186542
        ],
        [
          10.242216,
          59.18308
        ],
        [
          10.238078,
          59.179217
        ],
        [
          10.234332,
          59.175718
        ],
        [
          10.228611,
          59.170375
        ],
        [
          10.224668,
          59.166698
        ],
        [
          10.221327,
          59.163832
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Bentsrød - Føske|line/0",
      "name": "Bentsrød - Føske",
      "category": "line",
      "fromExternalId": "relation/10381726",
      "toExternalId": "way/753593226",
      "nominalKv": 132,
      "lengthKm": 8.3,
      "operator": "Lede",
      "path": [
        [
          10.312282,
          59.471125
        ],
        [
          10.315109,
          59.469066
        ],
        [
          10.319002,
          59.463887
        ],
        [
          10.321407,
          59.460995
        ],
        [
          10.323515,
          59.458828
        ],
        [
          10.331771,
          59.452509
        ],
        [
          10.33727,
          59.448641
        ],
        [
          10.341021,
          59.445504
        ],
        [
          10.346666,
          59.439906
        ],
        [
          10.352573,
          59.434033
        ],
        [
          10.356623,
          59.431187
        ],
        [
          10.360046,
          59.426681
        ],
        [
          10.363832,
          59.423137
        ],
        [
          10.369754,
          59.41856
        ],
        [
          10.374903,
          59.416083
        ],
        [
          10.381307,
          59.412992
        ],
        [
          10.386966,
          59.410271
        ],
        [
          10.389106,
          59.408448
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Rød - Sørtveit|line/0",
      "name": "Rød - Sørtveit",
      "category": "line",
      "fromExternalId": "relation/18667238",
      "toExternalId": "relation/14347513",
      "nominalKv": 132,
      "lengthKm": 8.22,
      "operator": "Lede",
      "path": [
        [
          9.540629,
          59.274272
        ],
        [
          9.542419,
          59.275614
        ],
        [
          9.544586,
          59.276895
        ],
        [
          9.552105,
          59.279413
        ],
        [
          9.55642,
          59.284138
        ],
        [
          9.559299,
          59.284799
        ],
        [
          9.571131,
          59.290635
        ],
        [
          9.572204,
          59.291295
        ],
        [
          9.580057,
          59.296395
        ],
        [
          9.583273,
          59.296862
        ],
        [
          9.591762,
          59.298326
        ],
        [
          9.604095,
          59.300472
        ],
        [
          9.61216,
          59.301897
        ],
        [
          9.626717,
          59.304454
        ],
        [
          9.631034,
          59.305127
        ],
        [
          9.648533,
          59.30708
        ],
        [
          9.653976,
          59.307185
        ],
        [
          9.661366,
          59.307326
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Frogner - Rød|line/0",
      "name": "Frogner - Rød",
      "category": "line",
      "fromExternalId": "relation/9407966",
      "toExternalId": "relation/18667238",
      "nominalKv": 132,
      "lengthKm": 8.12,
      "operator": "Lede",
      "path": [
        [
          9.622566,
          59.216612
        ],
        [
          9.620486,
          59.218646
        ],
        [
          9.614837,
          59.22275
        ],
        [
          9.610077,
          59.228828
        ],
        [
          9.607288,
          59.232372
        ],
        [
          9.604159,
          59.235613
        ],
        [
          9.600618,
          59.239292
        ],
        [
          9.597236,
          59.24243
        ],
        [
          9.5928,
          59.246216
        ],
        [
          9.584107,
          59.250006
        ],
        [
          9.579373,
          59.251232
        ],
        [
          9.574325,
          59.255201
        ],
        [
          9.569132,
          59.259245
        ],
        [
          9.56425,
          59.263048
        ],
        [
          9.559385,
          59.266841
        ],
        [
          9.55067,
          59.272318
        ],
        [
          9.544842,
          59.274983
        ],
        [
          9.543569,
          59.275813
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|||line/2",
      "name": "merged/line/line|132|||line/2",
      "category": "line",
      "fromExternalId": "way/442950344",
      "toExternalId": "way/1078030962",
      "nominalKv": 132,
      "lengthKm": 7.24,
      "operator": null,
      "path": [
        [
          10.017622,
          59.005102
        ],
        [
          10.013145,
          59.007983
        ],
        [
          10.008338,
          59.011128
        ],
        [
          10.00489,
          59.014677
        ],
        [
          10.001507,
          59.019422
        ],
        [
          9.999904,
          59.021655
        ],
        [
          9.997208,
          59.025444
        ],
        [
          9.994532,
          59.02918
        ],
        [
          9.991579,
          59.033349
        ],
        [
          9.989697,
          59.036718
        ],
        [
          9.988482,
          59.041477
        ],
        [
          9.990426,
          59.046802
        ],
        [
          9.995455,
          59.050172
        ],
        [
          9.998327,
          59.052093
        ],
        [
          10.003273,
          59.055157
        ],
        [
          10.007654,
          59.055135
        ],
        [
          10.014378,
          59.055963
        ],
        [
          10.01958,
          59.057846
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Ringerike - (Ekli) - Ultvedt|line/0",
      "name": "Ringerike - (Ekli) - Ultvedt",
      "category": "line",
      "fromExternalId": "way/205115991",
      "toExternalId": "way/331597523",
      "nominalKv": 132,
      "lengthKm": 6.98,
      "operator": "Glitre Nett",
      "path": [
        [
          10.204605,
          60.168942
        ],
        [
          10.207071,
          60.167294
        ],
        [
          10.215724,
          60.163393
        ],
        [
          10.218693,
          60.162235
        ],
        [
          10.22291,
          60.16059
        ],
        [
          10.225656,
          60.159515
        ],
        [
          10.237429,
          60.15587
        ],
        [
          10.241017,
          60.154754
        ],
        [
          10.247704,
          60.152737
        ],
        [
          10.257245,
          60.14972
        ],
        [
          10.262942,
          60.148437
        ],
        [
          10.269068,
          60.14705
        ],
        [
          10.282581,
          60.143995
        ],
        [
          10.288232,
          60.142713
        ],
        [
          10.292637,
          60.141714
        ],
        [
          10.295568,
          60.141052
        ],
        [
          10.304267,
          60.138847
        ],
        [
          10.311926,
          60.136898
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Skjøren - Rå|line/0",
      "name": "Skjøren - Rå",
      "category": "line",
      "fromExternalId": "way/1004193643",
      "toExternalId": "way/165500085",
      "nominalKv": 132,
      "lengthKm": 6.74,
      "operator": "Elvia",
      "path": [
        [
          11.051592,
          59.291514
        ],
        [
          11.047971,
          59.289475
        ],
        [
          11.043848,
          59.287143
        ],
        [
          11.039275,
          59.284568
        ],
        [
          11.034039,
          59.281615
        ],
        [
          11.030096,
          59.27939
        ],
        [
          11.0254,
          59.277571
        ],
        [
          11.014765,
          59.275401
        ],
        [
          11.007796,
          59.273974
        ],
        [
          11.004889,
          59.271406
        ],
        [
          11.001826,
          59.268674
        ],
        [
          10.998367,
          59.265617
        ],
        [
          10.995214,
          59.262825
        ],
        [
          10.991805,
          59.259803
        ],
        [
          10.98854,
          59.2569
        ],
        [
          10.984208,
          59.253065
        ],
        [
          10.980435,
          59.249718
        ],
        [
          10.980028,
          59.246244
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Hof - Sande 1|line/0",
      "name": "Hof - Sande 1",
      "category": "line",
      "fromExternalId": "way/355844786",
      "toExternalId": "way/50881349",
      "nominalKv": 132,
      "lengthKm": 6.45,
      "operator": "Lede",
      "path": [
        [
          10.104486,
          59.57714
        ],
        [
          10.107812,
          59.577336
        ],
        [
          10.11532,
          59.576454
        ],
        [
          10.121211,
          59.575878
        ],
        [
          10.131569,
          59.576769
        ],
        [
          10.1351,
          59.576439
        ],
        [
          10.143834,
          59.576612
        ],
        [
          10.151819,
          59.576518
        ],
        [
          10.154145,
          59.576502
        ],
        [
          10.165123,
          59.576344
        ],
        [
          10.170937,
          59.576216
        ],
        [
          10.182973,
          59.575919
        ],
        [
          10.192433,
          59.575675
        ],
        [
          10.195768,
          59.57559
        ],
        [
          10.203493,
          59.575371
        ],
        [
          10.210672,
          59.575175
        ],
        [
          10.214027,
          59.57508
        ],
        [
          10.21808,
          59.575678
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Kongsengen - Krabyskogen|line/0",
      "name": "Kongsengen - Krabyskogen",
      "category": "line",
      "fromExternalId": "way/296269262",
      "toExternalId": "relation/8205424",
      "nominalKv": 132,
      "lengthKm": 6.32,
      "operator": "Elvia",
      "path": [
        [
          10.792816,
          60.691126
        ],
        [
          10.793202,
          60.690768
        ],
        [
          10.797981,
          60.689475
        ],
        [
          10.807367,
          60.686931
        ],
        [
          10.81266,
          60.685485
        ],
        [
          10.816048,
          60.68439
        ],
        [
          10.81875,
          60.681905
        ],
        [
          10.823666,
          60.679019
        ],
        [
          10.826565,
          60.677313
        ],
        [
          10.831256,
          60.674557
        ],
        [
          10.834242,
          60.673256
        ],
        [
          10.840204,
          60.670661
        ],
        [
          10.844209,
          60.668917
        ],
        [
          10.852405,
          60.664622
        ],
        [
          10.8557,
          60.6623
        ],
        [
          10.862562,
          60.657469
        ],
        [
          10.865841,
          60.655159
        ],
        [
          10.871915,
          60.650886
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Akersmyra - Tveiten / Askehaug - Tveiten|line/0",
      "name": "Akersmyra - Tveiten / Askehaug - Tveiten",
      "category": "line",
      "fromExternalId": "way/753613423",
      "toExternalId": "way/51854396",
      "nominalKv": 132,
      "lengthKm": 6.09,
      "operator": "Lede",
      "path": [
        [
          10.29959,
          59.280333
        ],
        [
          10.302084,
          59.282526
        ],
        [
          10.30412,
          59.284316
        ],
        [
          10.30827,
          59.287923
        ],
        [
          10.311081,
          59.29036
        ],
        [
          10.314218,
          59.293083
        ],
        [
          10.316849,
          59.295358
        ],
        [
          10.322072,
          59.299086
        ],
        [
          10.325536,
          59.301205
        ],
        [
          10.329031,
          59.303342
        ],
        [
          10.332267,
          59.305319
        ],
        [
          10.340598,
          59.310426
        ],
        [
          10.34374,
          59.31249
        ],
        [
          10.347374,
          59.314887
        ],
        [
          10.351152,
          59.317385
        ],
        [
          10.356096,
          59.320642
        ],
        [
          10.360753,
          59.323716
        ],
        [
          10.362141,
          59.324635
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Slagen - Esso|line/0",
      "name": "Slagen - Esso",
      "category": "line",
      "fromExternalId": "relation/10386410",
      "toExternalId": "relation/10384523",
      "nominalKv": 132,
      "lengthKm": 5.73,
      "operator": "Lede",
      "path": [
        [
          10.430774,
          59.283273
        ],
        [
          10.432272,
          59.283193
        ],
        [
          10.437246,
          59.28429
        ],
        [
          10.44068,
          59.28546
        ],
        [
          10.445892,
          59.287238
        ],
        [
          10.450295,
          59.288735
        ],
        [
          10.455666,
          59.290568
        ],
        [
          10.460104,
          59.292084
        ],
        [
          10.469311,
          59.295225
        ],
        [
          10.472169,
          59.296555
        ],
        [
          10.478436,
          59.299469
        ],
        [
          10.482661,
          59.301176
        ],
        [
          10.487632,
          59.303098
        ],
        [
          10.492073,
          59.30476
        ],
        [
          10.499091,
          59.30738
        ],
        [
          10.501946,
          59.308445
        ],
        [
          10.509959,
          59.311439
        ],
        [
          10.51255,
          59.312771
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Kaggefoss - Setersberg / Holgersmoen - Setersberg|line/0",
      "name": "Kaggefoss - Setersberg / Holgersmoen - Setersberg",
      "category": "line",
      "fromExternalId": "way/550454423",
      "toExternalId": "way/550454471",
      "nominalKv": 132,
      "lengthKm": 5.49,
      "operator": "Glitre Nett",
      "path": [
        [
          9.889138,
          59.899654
        ],
        [
          9.890796,
          59.901379
        ],
        [
          9.894806,
          59.905571
        ],
        [
          9.895769,
          59.906581
        ],
        [
          9.897354,
          59.908136
        ],
        [
          9.904062,
          59.912458
        ],
        [
          9.905189,
          59.913187
        ],
        [
          9.908423,
          59.915265
        ],
        [
          9.914614,
          59.919242
        ],
        [
          9.917699,
          59.921221
        ],
        [
          9.922569,
          59.924356
        ],
        [
          9.92508,
          59.925969
        ],
        [
          9.927252,
          59.927367
        ],
        [
          9.932247,
          59.930571
        ],
        [
          9.934055,
          59.931741
        ],
        [
          9.936217,
          59.93314
        ],
        [
          9.940626,
          59.93601
        ],
        [
          9.945494,
          59.939903
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Smestad - Solli|cable/0",
      "name": "Smestad - Solli",
      "category": "cable",
      "fromExternalId": "node/12765722163",
      "toExternalId": "node/6078012488",
      "nominalKv": 132,
      "lengthKm": 5.49,
      "operator": "Elvia",
      "path": [
        [
          10.66864,
          59.934778
        ],
        [
          10.674352,
          59.934663
        ],
        [
          10.676241,
          59.932927
        ],
        [
          10.676254,
          59.929887
        ],
        [
          10.675503,
          59.928575
        ],
        [
          10.678995,
          59.929157
        ],
        [
          10.682085,
          59.929541
        ],
        [
          10.683598,
          59.927752
        ],
        [
          10.687251,
          59.929063
        ],
        [
          10.691068,
          59.928359
        ],
        [
          10.693589,
          59.927188
        ],
        [
          10.695215,
          59.925556
        ],
        [
          10.697811,
          59.92427
        ],
        [
          10.699297,
          59.922336
        ],
        [
          10.702969,
          59.92144
        ],
        [
          10.708974,
          59.913119
        ],
        [
          10.712947,
          59.911882
        ],
        [
          10.720033,
          59.912887
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Myrene - Meen 1+2|line/0",
      "name": "Myrene - Meen 1+2",
      "category": "line",
      "fromExternalId": "relation/10582233",
      "toExternalId": "way/100657505",
      "nominalKv": 132,
      "lengthKm": 5.39,
      "operator": "Lede",
      "path": [
        [
          9.658755,
          59.175604
        ],
        [
          9.664184,
          59.172738
        ],
        [
          9.667078,
          59.171215
        ],
        [
          9.672109,
          59.168564
        ],
        [
          9.675256,
          59.166906
        ],
        [
          9.679545,
          59.164639
        ],
        [
          9.683665,
          59.162464
        ],
        [
          9.685602,
          59.161447
        ],
        [
          9.686447,
          59.159086
        ],
        [
          9.686894,
          59.157846
        ],
        [
          9.684514,
          59.155905
        ],
        [
          9.682834,
          59.153772
        ],
        [
          9.679998,
          59.150164
        ],
        [
          9.676872,
          59.14619
        ],
        [
          9.675315,
          59.144203
        ],
        [
          9.672258,
          59.140311
        ],
        [
          9.670774,
          59.138427
        ],
        [
          9.667886,
          59.134745
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Akersmyra - Sundland|line/0",
      "name": "Akersmyra - Sundland",
      "category": "line",
      "fromExternalId": "relation/11601417",
      "toExternalId": "way/753613423",
      "nominalKv": 132,
      "lengthKm": 5.21,
      "operator": "Lede",
      "path": [
        [
          10.285703,
          59.230111
        ],
        [
          10.285742,
          59.230146
        ],
        [
          10.287393,
          59.231722
        ],
        [
          10.289155,
          59.233544
        ],
        [
          10.290933,
          59.235386
        ],
        [
          10.294664,
          59.239317
        ],
        [
          10.296782,
          59.241612
        ],
        [
          10.298744,
          59.243733
        ],
        [
          10.30264,
          59.247953
        ],
        [
          10.304525,
          59.249991
        ],
        [
          10.308003,
          59.253836
        ],
        [
          10.310017,
          59.256139
        ],
        [
          10.311698,
          59.258057
        ],
        [
          10.315056,
          59.261893
        ],
        [
          10.316795,
          59.263881
        ],
        [
          10.318406,
          59.266184
        ],
        [
          10.321718,
          59.270923
        ],
        [
          10.322928,
          59.272863
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Mjøndalen - Langum / Sundhaug - Asker|line/0",
      "name": "Mjøndalen - Langum / Sundhaug - Asker",
      "category": "line",
      "fromExternalId": "relation/18555173",
      "toExternalId": "way/48306065",
      "nominalKv": 132,
      "lengthKm": 5.17,
      "operator": "Glitre Nett",
      "path": [
        [
          10.019166,
          59.744469
        ],
        [
          10.022303,
          59.744802
        ],
        [
          10.029452,
          59.745561
        ],
        [
          10.033751,
          59.745934
        ],
        [
          10.038882,
          59.746355
        ],
        [
          10.043002,
          59.746691
        ],
        [
          10.05194,
          59.747415
        ],
        [
          10.054278,
          59.747602
        ],
        [
          10.05871,
          59.747451
        ],
        [
          10.066848,
          59.747179
        ],
        [
          10.071126,
          59.747034
        ],
        [
          10.076035,
          59.746871
        ],
        [
          10.085526,
          59.746546
        ],
        [
          10.090449,
          59.74638
        ],
        [
          10.0958,
          59.746203
        ],
        [
          10.098898,
          59.746411
        ],
        [
          10.106953,
          59.746563
        ],
        [
          10.110844,
          59.746636
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Halmstad - Råde|line/0",
      "name": "Halmstad - Råde",
      "category": "line",
      "fromExternalId": "way/584434419",
      "toExternalId": "relation/11547182",
      "nominalKv": 132,
      "lengthKm": 5.04,
      "operator": "Elvia",
      "path": [
        [
          10.7423,
          59.381284
        ],
        [
          10.742379,
          59.381326
        ],
        [
          10.742081,
          59.381028
        ],
        [
          10.742195,
          59.380486
        ],
        [
          10.746413,
          59.378341
        ],
        [
          10.74722,
          59.377351
        ],
        [
          10.748535,
          59.375738
        ],
        [
          10.75628,
          59.371885
        ],
        [
          10.760416,
          59.369828
        ],
        [
          10.767697,
          59.366205
        ],
        [
          10.771472,
          59.364325
        ],
        [
          10.778458,
          59.361874
        ],
        [
          10.782468,
          59.361011
        ],
        [
          10.786377,
          59.360168
        ],
        [
          10.794971,
          59.358316
        ],
        [
          10.800518,
          59.357119
        ],
        [
          10.807413,
          59.358309
        ],
        [
          10.807648,
          59.358526
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Berger - Fusdal|cable/0",
      "name": "Berger - Fusdal",
      "category": "cable",
      "fromExternalId": "relation/14758048",
      "toExternalId": "relation/10336704",
      "nominalKv": 132,
      "lengthKm": 5,
      "operator": "Elvia",
      "path": [
        [
          10.444983,
          59.833452
        ],
        [
          10.443245,
          59.833928
        ],
        [
          10.438731,
          59.833469
        ],
        [
          10.437304,
          59.834541
        ],
        [
          10.435295,
          59.836967
        ],
        [
          10.434356,
          59.838255
        ],
        [
          10.433981,
          59.839829
        ],
        [
          10.438052,
          59.843174
        ],
        [
          10.441571,
          59.847832
        ],
        [
          10.44637,
          59.849097
        ],
        [
          10.449457,
          59.849548
        ],
        [
          10.451187,
          59.850049
        ],
        [
          10.455267,
          59.852036
        ],
        [
          10.466052,
          59.856814
        ],
        [
          10.469922,
          59.858114
        ],
        [
          10.470201,
          59.860471
        ],
        [
          10.470518,
          59.862485
        ],
        [
          10.469384,
          59.864303
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Såheim - Mår|line/0",
      "name": "Såheim - Mår",
      "category": "line",
      "fromExternalId": "relation/7879879",
      "toExternalId": "relation/7879875",
      "nominalKv": 132,
      "lengthKm": 4.96,
      "operator": "Lede",
      "path": [
        [
          8.676765,
          59.883764
        ],
        [
          8.677119,
          59.882524
        ],
        [
          8.673921,
          59.880234
        ],
        [
          8.670978,
          59.879571
        ],
        [
          8.663208,
          59.877839
        ],
        [
          8.660558,
          59.877758
        ],
        [
          8.652436,
          59.877503
        ],
        [
          8.648472,
          59.877379
        ],
        [
          8.640012,
          59.87711
        ],
        [
          8.63615,
          59.876986
        ],
        [
          8.627513,
          59.876708
        ],
        [
          8.623415,
          59.876581
        ],
        [
          8.615277,
          59.876315
        ],
        [
          8.612841,
          59.876243
        ],
        [
          8.607445,
          59.876143
        ],
        [
          8.604103,
          59.876122
        ],
        [
          8.597783,
          59.876087
        ],
        [
          8.59726,
          59.877122
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Frogner - Meen|line/0",
      "name": "Frogner - Meen",
      "category": "line",
      "fromExternalId": "relation/10582233",
      "toExternalId": "relation/9407966",
      "nominalKv": 132,
      "lengthKm": 4.96,
      "operator": "Lede",
      "path": [
        [
          9.657192,
          59.175879
        ],
        [
          9.656674,
          59.175967
        ],
        [
          9.655208,
          59.178346
        ],
        [
          9.654481,
          59.179552
        ],
        [
          9.651433,
          59.183579
        ],
        [
          9.649853,
          59.185692
        ],
        [
          9.646923,
          59.189614
        ],
        [
          9.645233,
          59.191719
        ],
        [
          9.642067,
          59.195681
        ],
        [
          9.640517,
          59.197616
        ],
        [
          9.637547,
          59.20133
        ],
        [
          9.636088,
          59.203153
        ],
        [
          9.632593,
          59.20695
        ],
        [
          9.630568,
          59.208901
        ],
        [
          9.627229,
          59.212114
        ],
        [
          9.625855,
          59.213435
        ],
        [
          9.622609,
          59.216571
        ],
        [
          9.622566,
          59.216612
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Hamang - Berger|cable/0",
      "name": "Hamang - Berger",
      "category": "cable",
      "fromExternalId": "way/187555858",
      "toExternalId": "relation/10336704",
      "nominalKv": 132,
      "lengthKm": 4.91,
      "operator": "Elvia",
      "path": [
        [
          10.498412,
          59.897233
        ],
        [
          10.499234,
          59.896144
        ],
        [
          10.498834,
          59.894885
        ],
        [
          10.496932,
          59.893323
        ],
        [
          10.491623,
          59.891638
        ],
        [
          10.492098,
          59.8906
        ],
        [
          10.493958,
          59.889599
        ],
        [
          10.494348,
          59.887692
        ],
        [
          10.489323,
          59.884924
        ],
        [
          10.48203,
          59.882382
        ],
        [
          10.475118,
          59.877351
        ],
        [
          10.471561,
          59.876151
        ],
        [
          10.467983,
          59.874661
        ],
        [
          10.465701,
          59.870255
        ],
        [
          10.46536,
          59.86891
        ],
        [
          10.466342,
          59.86761
        ],
        [
          10.469134,
          59.865457
        ],
        [
          10.469388,
          59.864387
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Årlifoss - Grønvollfoss|line/0",
      "name": "Årlifoss - Grønvollfoss",
      "category": "line",
      "fromExternalId": "relation/18303428",
      "toExternalId": "way/551037431",
      "nominalKv": 132,
      "lengthKm": 4.85,
      "operator": "Lede",
      "path": [
        [
          9.210564,
          59.659481
        ],
        [
          9.210458,
          59.659533
        ],
        [
          9.205186,
          59.662139
        ],
        [
          9.201415,
          59.664004
        ],
        [
          9.196699,
          59.666102
        ],
        [
          9.195857,
          59.66639
        ],
        [
          9.189704,
          59.668504
        ],
        [
          9.185839,
          59.669829
        ],
        [
          9.178428,
          59.672384
        ],
        [
          9.175319,
          59.673435
        ],
        [
          9.170314,
          59.676081
        ],
        [
          9.167109,
          59.678777
        ],
        [
          9.163244,
          59.682027
        ],
        [
          9.16043,
          59.683127
        ],
        [
          9.15457,
          59.684395
        ],
        [
          9.151166,
          59.684755
        ],
        [
          9.146566,
          59.685238
        ],
        [
          9.144472,
          59.685528
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Nore II - (Mykstufoss) - Rollag - (Djupdal) - Flesaker|line/7",
      "name": "Nore II - (Mykstufoss) - Rollag - (Djupdal) - Flesaker",
      "category": "line",
      "fromExternalId": "way/550195650",
      "toExternalId": "way/1165232853",
      "nominalKv": 132,
      "lengthKm": 4.83,
      "operator": "Glitre Nett",
      "path": [
        [
          9.306611,
          59.983753
        ],
        [
          9.309776,
          59.982019
        ],
        [
          9.311187,
          59.980683
        ],
        [
          9.313649,
          59.978356
        ],
        [
          9.315972,
          59.976163
        ],
        [
          9.317892,
          59.974348
        ],
        [
          9.319711,
          59.972636
        ],
        [
          9.321438,
          59.971014
        ],
        [
          9.324458,
          59.968147
        ],
        [
          9.329356,
          59.963515
        ],
        [
          9.331877,
          59.961112
        ],
        [
          9.33391,
          59.959208
        ],
        [
          9.335053,
          59.958123
        ],
        [
          9.336287,
          59.956949
        ],
        [
          9.339433,
          59.954246
        ],
        [
          9.341324,
          59.952617
        ],
        [
          9.345988,
          59.948611
        ],
        [
          9.349118,
          59.945917
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Hof - Hanekleiva|line/0",
      "name": "Hof - Hanekleiva",
      "category": "line",
      "fromExternalId": "way/355844786",
      "toExternalId": "way/1305324961",
      "nominalKv": 132,
      "lengthKm": 4.78,
      "operator": "Lede",
      "path": [
        [
          10.104397,
          59.577062
        ],
        [
          10.105715,
          59.576954
        ],
        [
          10.114206,
          59.576439
        ],
        [
          10.117042,
          59.576104
        ],
        [
          10.12088,
          59.575656
        ],
        [
          10.122117,
          59.575772
        ],
        [
          10.131602,
          59.57663
        ],
        [
          10.135073,
          59.576303
        ],
        [
          10.140894,
          59.576415
        ],
        [
          10.146387,
          59.576458
        ],
        [
          10.151731,
          59.576385
        ],
        [
          10.154076,
          59.576364
        ],
        [
          10.165073,
          59.576205
        ],
        [
          10.17093,
          59.576078
        ],
        [
          10.17663,
          59.575948
        ],
        [
          10.18299,
          59.575785
        ],
        [
          10.188474,
          59.575639
        ],
        [
          10.188577,
          59.575637
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett;Bane NOR Energi|Hafskjold - Kjenner / Sundhaug - Asker|line/0",
      "name": "Hafskjold - Kjenner / Sundhaug - Asker",
      "category": "line",
      "fromExternalId": "way/46832312",
      "toExternalId": "way/28028051",
      "nominalKv": 132,
      "lengthKm": 4.76,
      "operator": "Glitre Nett;Bane NOR Energi",
      "path": [
        [
          10.254896,
          59.794893
        ],
        [
          10.260005,
          59.795416
        ],
        [
          10.264817,
          59.79591
        ],
        [
          10.273084,
          59.796755
        ],
        [
          10.275797,
          59.797034
        ],
        [
          10.280809,
          59.797491
        ],
        [
          10.283451,
          59.797731
        ],
        [
          10.291423,
          59.798461
        ],
        [
          10.295997,
          59.798876
        ],
        [
          10.298716,
          59.799121
        ],
        [
          10.302071,
          59.79968
        ],
        [
          10.310301,
          59.801046
        ],
        [
          10.314972,
          59.801817
        ],
        [
          10.320364,
          59.802706
        ],
        [
          10.323101,
          59.803159
        ],
        [
          10.332018,
          59.804648
        ],
        [
          10.33564,
          59.805258
        ],
        [
          10.337143,
          59.805507
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Kjenner - Borgen|line/0",
      "name": "Kjenner - Borgen",
      "category": "line",
      "fromExternalId": "way/28028051",
      "toExternalId": "way/660846340",
      "nominalKv": 132,
      "lengthKm": 4.64,
      "operator": "Elvia",
      "path": [
        [
          10.337936,
          59.806026
        ],
        [
          10.338622,
          59.805826
        ],
        [
          10.343846,
          59.806705
        ],
        [
          10.345735,
          59.807022
        ],
        [
          10.352123,
          59.808091
        ],
        [
          10.358589,
          59.809516
        ],
        [
          10.364009,
          59.81124
        ],
        [
          10.369046,
          59.811158
        ],
        [
          10.3734,
          59.810869
        ],
        [
          10.3753,
          59.811708
        ],
        [
          10.379348,
          59.813486
        ],
        [
          10.385356,
          59.814573
        ],
        [
          10.390331,
          59.815803
        ],
        [
          10.39518,
          59.817873
        ],
        [
          10.399578,
          59.819735
        ],
        [
          10.401672,
          59.820614
        ],
        [
          10.405176,
          59.822088
        ],
        [
          10.409215,
          59.823783
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Smestad - (Pipervika) - Prestegata|cable/0",
      "name": "Smestad - (Pipervika) - Prestegata",
      "category": "cable",
      "fromExternalId": "node/12765722163",
      "toExternalId": "node/6074985684",
      "nominalKv": 132,
      "lengthKm": 4.57,
      "operator": "Elvia",
      "path": [
        [
          10.66864,
          59.934778
        ],
        [
          10.669951,
          59.934362
        ],
        [
          10.728192,
          59.912912
        ],
        [
          10.730764,
          59.912295
        ],
        [
          10.731058,
          59.912227
        ],
        [
          10.735539,
          59.911182
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Føske - Røreåsen|line/0",
      "name": "Føske - Røreåsen",
      "category": "line",
      "fromExternalId": "way/753593226",
      "toExternalId": "way/228400493",
      "nominalKv": 132,
      "lengthKm": 4.53,
      "operator": "Lede",
      "path": [
        [
          10.389106,
          59.408448
        ],
        [
          10.389182,
          59.408465
        ],
        [
          10.393639,
          59.409462
        ],
        [
          10.397536,
          59.410341
        ],
        [
          10.403974,
          59.411785
        ],
        [
          10.40992,
          59.413131
        ],
        [
          10.416851,
          59.414706
        ],
        [
          10.419564,
          59.41533
        ],
        [
          10.427609,
          59.417161
        ],
        [
          10.437058,
          59.417629
        ],
        [
          10.443111,
          59.416896
        ],
        [
          10.445131,
          59.416668
        ],
        [
          10.452025,
          59.41574
        ],
        [
          10.455005,
          59.41523
        ],
        [
          10.459184,
          59.414689
        ],
        [
          10.461233,
          59.414357
        ],
        [
          10.463018,
          59.415361
        ],
        [
          10.462961,
          59.415415
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Århus - Rød|line/0",
      "name": "Århus - Rød",
      "category": "line",
      "fromExternalId": "relation/7893972",
      "toExternalId": "relation/18667239",
      "nominalKv": 132,
      "lengthKm": 4.43,
      "operator": "Lede",
      "path": [
        [
          9.560868,
          59.234902
        ],
        [
          9.558229,
          59.236843
        ],
        [
          9.556987,
          59.238962
        ],
        [
          9.554967,
          59.242446
        ],
        [
          9.55368,
          59.244011
        ],
        [
          9.551963,
          59.246106
        ],
        [
          9.550155,
          59.248306
        ],
        [
          9.548889,
          59.250519
        ],
        [
          9.547779,
          59.252453
        ],
        [
          9.545247,
          59.256213
        ],
        [
          9.543608,
          59.25828
        ],
        [
          9.540896,
          59.261727
        ],
        [
          9.540096,
          59.264188
        ],
        [
          9.539281,
          59.266686
        ],
        [
          9.539579,
          59.269743
        ],
        [
          9.540992,
          59.271321
        ],
        [
          9.541671,
          59.271767
        ],
        [
          9.54239,
          59.272163
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Gokstad - Vindal|line/0",
      "name": "Gokstad - Vindal",
      "category": "line",
      "fromExternalId": "relation/14071307",
      "toExternalId": "relation/14071305",
      "nominalKv": 132,
      "lengthKm": 4.42,
      "operator": "Lede",
      "path": [
        [
          10.250472,
          59.144566
        ],
        [
          10.250595,
          59.144462
        ],
        [
          10.253578,
          59.141885
        ],
        [
          10.255292,
          59.140403
        ],
        [
          10.255664,
          59.138905
        ],
        [
          10.256668,
          59.134826
        ],
        [
          10.257986,
          59.132174
        ],
        [
          10.258845,
          59.13052
        ],
        [
          10.260374,
          59.127592
        ],
        [
          10.259285,
          59.124554
        ],
        [
          10.258394,
          59.121595
        ],
        [
          10.258002,
          59.120297
        ],
        [
          10.257492,
          59.118589
        ],
        [
          10.254173,
          59.116899
        ],
        [
          10.247948,
          59.113886
        ],
        [
          10.244029,
          59.112048
        ],
        [
          10.241591,
          59.109757
        ],
        [
          10.241717,
          59.109278
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Lede|Moflata - Århus|cable/0",
      "name": "Moflata - Århus",
      "category": "cable",
      "fromExternalId": "way/100666299",
      "toExternalId": "relation/7893972",
      "nominalKv": 132,
      "lengthKm": 4.34,
      "operator": "Lede",
      "path": [
        [
          9.589549,
          59.192944
        ],
        [
          9.592916,
          59.194937
        ],
        [
          9.594411,
          59.196067
        ],
        [
          9.599004,
          59.199952
        ],
        [
          9.601302,
          59.200729
        ],
        [
          9.601686,
          59.203365
        ],
        [
          9.601348,
          59.204473
        ],
        [
          9.599629,
          59.207765
        ],
        [
          9.598025,
          59.209068
        ],
        [
          9.599277,
          59.210707
        ],
        [
          9.597165,
          59.21377
        ],
        [
          9.595903,
          59.214665
        ],
        [
          9.593564,
          59.217343
        ],
        [
          9.591713,
          59.218109
        ],
        [
          9.590311,
          59.218731
        ],
        [
          9.584954,
          59.218315
        ],
        [
          9.580506,
          59.219069
        ],
        [
          9.579092,
          59.219268
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Sogn - Lillo|cable/0",
      "name": "Sogn - Lillo",
      "category": "cable",
      "fromExternalId": "relation/10308957",
      "toExternalId": "relation/8999774",
      "nominalKv": 132,
      "lengthKm": 4.08,
      "operator": "Elvia",
      "path": [
        [
          10.722919,
          59.957801
        ],
        [
          10.732618,
          59.958034
        ],
        [
          10.735654,
          59.958093
        ],
        [
          10.73662,
          59.957272
        ],
        [
          10.736652,
          59.956173
        ],
        [
          10.737242,
          59.954127
        ],
        [
          10.737752,
          59.952534
        ],
        [
          10.74899,
          59.952808
        ],
        [
          10.75105,
          59.95111
        ],
        [
          10.753169,
          59.949394
        ],
        [
          10.756661,
          59.947545
        ],
        [
          10.759955,
          59.945975
        ],
        [
          10.761385,
          59.945862
        ],
        [
          10.763427,
          59.94577
        ],
        [
          10.764678,
          59.945243
        ],
        [
          10.766046,
          59.944578
        ],
        [
          10.771759,
          59.944336
        ],
        [
          10.772725,
          59.945354
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Rakkås - Slagen|line/0",
      "name": "Rakkås - Slagen",
      "category": "line",
      "fromExternalId": "way/405935304",
      "toExternalId": "relation/10386410",
      "nominalKv": 132,
      "lengthKm": 3.94,
      "operator": "Lede",
      "path": [
        [
          10.404057,
          59.312573
        ],
        [
          10.404111,
          59.312543
        ],
        [
          10.407126,
          59.310825
        ],
        [
          10.409972,
          59.3092
        ],
        [
          10.412915,
          59.307523
        ],
        [
          10.41933,
          59.303855
        ],
        [
          10.422185,
          59.302228
        ],
        [
          10.425017,
          59.300614
        ],
        [
          10.426982,
          59.299492
        ],
        [
          10.428888,
          59.298059
        ],
        [
          10.430735,
          59.296669
        ],
        [
          10.433109,
          59.294887
        ],
        [
          10.434383,
          59.293922
        ],
        [
          10.434259,
          59.289989
        ],
        [
          10.434204,
          59.288179
        ],
        [
          10.433483,
          59.285605
        ],
        [
          10.432705,
          59.283766
        ],
        [
          10.430894,
          59.283645
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Jåberg - Stangeby|line/0",
      "name": "Jåberg - Stangeby",
      "category": "line",
      "fromExternalId": "relation/11601417",
      "toExternalId": "relation/11601416",
      "nominalKv": 132,
      "lengthKm": 3.94,
      "operator": "Lede",
      "path": [
        [
          10.285972,
          59.230141
        ],
        [
          10.286134,
          59.230089
        ],
        [
          10.286438,
          59.230065
        ],
        [
          10.290159,
          59.230387
        ],
        [
          10.295575,
          59.230793
        ],
        [
          10.300527,
          59.231157
        ],
        [
          10.302621,
          59.231315
        ],
        [
          10.308612,
          59.231592
        ],
        [
          10.312641,
          59.23176
        ],
        [
          10.314926,
          59.231857
        ],
        [
          10.318978,
          59.232029
        ],
        [
          10.328885,
          59.232816
        ],
        [
          10.333448,
          59.233294
        ],
        [
          10.336387,
          59.233587
        ],
        [
          10.339451,
          59.233891
        ],
        [
          10.344876,
          59.232928
        ],
        [
          10.348806,
          59.232232
        ],
        [
          10.353789,
          59.231344
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Århus - Skotfoss|line/0",
      "name": "Århus - Skotfoss",
      "category": "line",
      "fromExternalId": "relation/13284557",
      "toExternalId": "relation/7893972",
      "nominalKv": 132,
      "lengthKm": 3.92,
      "operator": "Lede",
      "path": [
        [
          9.532409,
          59.206309
        ],
        [
          9.532429,
          59.206339
        ],
        [
          9.533598,
          59.208046
        ],
        [
          9.534676,
          59.209602
        ],
        [
          9.537458,
          59.21356
        ],
        [
          9.537684,
          59.21452
        ],
        [
          9.538397,
          59.21731
        ],
        [
          9.539062,
          59.219924
        ],
        [
          9.538195,
          59.222256
        ],
        [
          9.537184,
          59.22495
        ],
        [
          9.541296,
          59.227486
        ],
        [
          9.543257,
          59.228692
        ],
        [
          9.54526,
          59.229947
        ],
        [
          9.546478,
          59.230677
        ],
        [
          9.549968,
          59.231855
        ],
        [
          9.55368,
          59.233104
        ],
        [
          9.557628,
          59.234414
        ],
        [
          9.560868,
          59.234902
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Stangeby - Nes|line/0",
      "name": "Stangeby - Nes",
      "category": "line",
      "fromExternalId": "relation/11601416",
      "toExternalId": "way/325550726",
      "nominalKv": 132,
      "lengthKm": 3.84,
      "operator": "Lede",
      "path": [
        [
          10.399763,
          59.217979
        ],
        [
          10.400896,
          59.218217
        ],
        [
          10.405755,
          59.220711
        ],
        [
          10.410292,
          59.221944
        ],
        [
          10.414139,
          59.222989
        ],
        [
          10.413826,
          59.22526
        ],
        [
          10.416953,
          59.226997
        ],
        [
          10.420584,
          59.229014
        ],
        [
          10.424507,
          59.231192
        ],
        [
          10.427207,
          59.232692
        ],
        [
          10.430773,
          59.234671
        ],
        [
          10.4348,
          59.236906
        ],
        [
          10.439015,
          59.238751
        ],
        [
          10.441168,
          59.239698
        ],
        [
          10.441829,
          59.241018
        ],
        [
          10.442666,
          59.242695
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Abildsø - Ulven|cable/0",
      "name": "Abildsø - Ulven",
      "category": "cable",
      "fromExternalId": "relation/8243549",
      "toExternalId": "way/113442999",
      "nominalKv": 132,
      "lengthKm": 3.77,
      "operator": "Elvia",
      "path": [
        [
          10.820605,
          59.889746
        ],
        [
          10.820959,
          59.889949
        ],
        [
          10.820057,
          59.895162
        ],
        [
          10.818787,
          59.901551
        ],
        [
          10.820085,
          59.902896
        ],
        [
          10.820836,
          59.907404
        ],
        [
          10.820235,
          59.908233
        ],
        [
          10.819031,
          59.909444
        ],
        [
          10.812392,
          59.916935
        ],
        [
          10.810289,
          59.917961
        ],
        [
          10.809648,
          59.918328
        ],
        [
          10.809176,
          59.918694
        ],
        [
          10.808911,
          59.919031
        ],
        [
          10.808659,
          59.919939
        ],
        [
          10.808763,
          59.920681
        ],
        [
          10.809015,
          59.921178
        ],
        [
          10.809577,
          59.921322
        ],
        [
          10.809855,
          59.921287
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Moflata - Skotfoss|line/0",
      "name": "Moflata - Skotfoss",
      "category": "line",
      "fromExternalId": "way/100666299",
      "toExternalId": "relation/13284557",
      "nominalKv": 132,
      "lengthKm": 3.68,
      "operator": "Lede",
      "path": [
        [
          9.589326,
          59.192843
        ],
        [
          9.588866,
          59.193612
        ],
        [
          9.585771,
          59.194806
        ],
        [
          9.578598,
          59.196058
        ],
        [
          9.575526,
          59.196593
        ],
        [
          9.572463,
          59.197134
        ],
        [
          9.568775,
          59.197779
        ],
        [
          9.566726,
          59.19879
        ],
        [
          9.563933,
          59.200161
        ],
        [
          9.559508,
          59.202173
        ],
        [
          9.557845,
          59.202853
        ],
        [
          9.553007,
          59.202967
        ],
        [
          9.547994,
          59.203086
        ],
        [
          9.543486,
          59.203979
        ],
        [
          9.541621,
          59.204348
        ],
        [
          9.533944,
          59.20587
        ],
        [
          9.532602,
          59.206144
        ],
        [
          9.532508,
          59.206163
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Sogn - Ullevål|cable/0",
      "name": "Sogn - Ullevål",
      "category": "cable",
      "fromExternalId": "relation/10308957",
      "toExternalId": "way/114897970",
      "nominalKv": 132,
      "lengthKm": 3.63,
      "operator": "Elvia",
      "path": [
        [
          10.722574,
          59.957543
        ],
        [
          10.720913,
          59.953823
        ],
        [
          10.717278,
          59.951767
        ],
        [
          10.71662,
          59.951259
        ],
        [
          10.717007,
          59.949278
        ],
        [
          10.71719,
          59.947611
        ],
        [
          10.7204,
          59.947533
        ],
        [
          10.723443,
          59.947898
        ],
        [
          10.725014,
          59.947529
        ],
        [
          10.72549,
          59.946892
        ],
        [
          10.725872,
          59.945187
        ],
        [
          10.725344,
          59.944349
        ],
        [
          10.724587,
          59.942267
        ],
        [
          10.727448,
          59.939179
        ],
        [
          10.727869,
          59.937618
        ],
        [
          10.729587,
          59.937657
        ],
        [
          10.730074,
          59.935535
        ],
        [
          10.731317,
          59.935142
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Smestad - Briskeby|cable/0",
      "name": "Smestad - Briskeby",
      "category": "cable",
      "fromExternalId": "node/12765722163",
      "toExternalId": "node/6078012478",
      "nominalKv": 132,
      "lengthKm": 3.56,
      "operator": "Elvia",
      "path": [
        [
          10.670235,
          59.934328
        ],
        [
          10.674071,
          59.934024
        ],
        [
          10.677504,
          59.93539
        ],
        [
          10.681157,
          59.935634
        ],
        [
          10.683845,
          59.93464
        ],
        [
          10.685046,
          59.934188
        ],
        [
          10.688619,
          59.933172
        ],
        [
          10.691403,
          59.93192
        ],
        [
          10.694788,
          59.929544
        ],
        [
          10.695351,
          59.928028
        ],
        [
          10.697175,
          59.927399
        ],
        [
          10.697663,
          59.925485
        ],
        [
          10.701789,
          59.923915
        ],
        [
          10.705361,
          59.923463
        ],
        [
          10.711134,
          59.92224
        ],
        [
          10.712898,
          59.922657
        ],
        [
          10.713773,
          59.922485
        ],
        [
          10.715275,
          59.922501
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Ulven - Torshov|cable/0",
      "name": "Ulven - Torshov",
      "category": "cable",
      "fromExternalId": "way/113442999",
      "toExternalId": "way/104728501",
      "nominalKv": 132,
      "lengthKm": 3.37,
      "operator": "Elvia",
      "path": [
        [
          10.809886,
          59.921352
        ],
        [
          10.802629,
          59.923673
        ],
        [
          10.800076,
          59.923748
        ],
        [
          10.796793,
          59.922576
        ],
        [
          10.79355,
          59.921853
        ],
        [
          10.792541,
          59.923266
        ],
        [
          10.791458,
          59.924011
        ],
        [
          10.78978,
          59.924511
        ],
        [
          10.78925,
          59.925735
        ],
        [
          10.786933,
          59.927937
        ],
        [
          10.78388,
          59.928584
        ],
        [
          10.783853,
          59.929211
        ],
        [
          10.778401,
          59.92982
        ],
        [
          10.776072,
          59.930751
        ],
        [
          10.773146,
          59.930057
        ],
        [
          10.771311,
          59.931218
        ],
        [
          10.769579,
          59.932597
        ],
        [
          10.770531,
          59.933367
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Abildsø - Jordal|cable/0",
      "name": "Abildsø - Jordal",
      "category": "cable",
      "fromExternalId": "relation/8243549",
      "toExternalId": "way/111654009",
      "nominalKv": 132,
      "lengthKm": 3.16,
      "operator": "Elvia",
      "path": [
        [
          10.820079,
          59.889448
        ],
        [
          10.792611,
          59.903012
        ],
        [
          10.791565,
          59.904316
        ],
        [
          10.790937,
          59.905164
        ],
        [
          10.790615,
          59.905371
        ],
        [
          10.790463,
          59.905415
        ],
        [
          10.789309,
          59.905435
        ],
        [
          10.788534,
          59.905461
        ],
        [
          10.78778,
          59.905558
        ],
        [
          10.785377,
          59.905792
        ],
        [
          10.785001,
          59.906102
        ],
        [
          10.784835,
          59.906193
        ],
        [
          10.782794,
          59.906782
        ],
        [
          10.782309,
          59.907353
        ],
        [
          10.78141,
          59.907529
        ],
        [
          10.781441,
          59.908214
        ],
        [
          10.781874,
          59.908301
        ],
        [
          10.781965,
          59.90819
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Bugården - Ranvik / Ranvik - Jåberg|line/0",
      "name": "Bugården - Ranvik / Ranvik - Jåberg",
      "category": "line",
      "fromExternalId": "relation/14071300",
      "toExternalId": "relation/14071297",
      "nominalKv": 132,
      "lengthKm": 3.13,
      "operator": "Lede",
      "path": [
        [
          10.163199,
          59.108414
        ],
        [
          10.167389,
          59.108868
        ],
        [
          10.171055,
          59.109375
        ],
        [
          10.17584,
          59.110181
        ],
        [
          10.181739,
          59.111172
        ],
        [
          10.185052,
          59.11173
        ],
        [
          10.188309,
          59.112471
        ],
        [
          10.192206,
          59.11337
        ],
        [
          10.19623,
          59.114299
        ],
        [
          10.20027,
          59.115188
        ],
        [
          10.206812,
          59.116624
        ],
        [
          10.212342,
          59.117807
        ],
        [
          10.214531,
          59.117995
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Ulven - Jordal|cable/0",
      "name": "Ulven - Jordal",
      "category": "cable",
      "fromExternalId": "way/113442999",
      "toExternalId": "way/111654009",
      "nominalKv": 132,
      "lengthKm": 3.06,
      "operator": "Elvia",
      "path": [
        [
          10.809875,
          59.921319
        ],
        [
          10.797097,
          59.920935
        ],
        [
          10.792816,
          59.920068
        ],
        [
          10.788751,
          59.919132
        ],
        [
          10.786033,
          59.918433
        ],
        [
          10.785334,
          59.918259
        ],
        [
          10.783773,
          59.917636
        ],
        [
          10.783148,
          59.917361
        ],
        [
          10.783548,
          59.916664
        ],
        [
          10.784442,
          59.916391
        ],
        [
          10.787475,
          59.91468
        ],
        [
          10.787779,
          59.912633
        ],
        [
          10.786156,
          59.912136
        ],
        [
          10.785664,
          59.911342
        ],
        [
          10.786601,
          59.910901
        ],
        [
          10.78641,
          59.910199
        ],
        [
          10.784985,
          59.908929
        ],
        [
          10.782296,
          59.908272
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elvia|Hasle - Råde / Hasle - Skjøren|line/0",
      "name": "Hasle - Råde / Hasle - Skjøren",
      "category": "line",
      "fromExternalId": "way/60495669",
      "toExternalId": "way/1004193643",
      "nominalKv": 132,
      "lengthKm": 2.75,
      "operator": "Elvia",
      "path": [
        [
          11.15314,
          59.314034
        ],
        [
          11.15146,
          59.315937
        ],
        [
          11.147021,
          59.317915
        ],
        [
          11.142669,
          59.319341
        ],
        [
          11.138527,
          59.3207
        ],
        [
          11.131367,
          59.323014
        ],
        [
          11.127151,
          59.324377
        ],
        [
          11.122405,
          59.325912
        ],
        [
          11.117747,
          59.327419
        ],
        [
          11.114498,
          59.328469
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Jordal - Rodeløkka|cable/0",
      "name": "Jordal - Rodeløkka",
      "category": "cable",
      "fromExternalId": "way/111654009",
      "toExternalId": "relation/8999778",
      "nominalKv": 132,
      "lengthKm": 2.74,
      "operator": "Elvia",
      "path": [
        [
          10.782022,
          59.908203
        ],
        [
          10.779024,
          59.907889
        ],
        [
          10.778022,
          59.908518
        ],
        [
          10.777412,
          59.909004
        ],
        [
          10.777371,
          59.911051
        ],
        [
          10.77696,
          59.915573
        ],
        [
          10.778983,
          59.915775
        ],
        [
          10.779948,
          59.916232
        ],
        [
          10.780929,
          59.917274
        ],
        [
          10.778728,
          59.917067
        ],
        [
          10.77784,
          59.917044
        ],
        [
          10.777255,
          59.917438
        ],
        [
          10.776687,
          59.918108
        ],
        [
          10.775423,
          59.918875
        ],
        [
          10.773295,
          59.920253
        ],
        [
          10.769815,
          59.921245
        ],
        [
          10.770559,
          59.922159
        ],
        [
          10.769495,
          59.923261
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Sogn - Sagene|cable/0",
      "name": "Sogn - Sagene",
      "category": "cable",
      "fromExternalId": "relation/10308957",
      "toExternalId": "relation/9008654",
      "nominalKv": 132,
      "lengthKm": 2.66,
      "operator": "Elvia",
      "path": [
        [
          10.72752,
          59.953499
        ],
        [
          10.729576,
          59.952281
        ],
        [
          10.73066,
          59.951183
        ],
        [
          10.731513,
          59.949958
        ],
        [
          10.736389,
          59.951158
        ],
        [
          10.737998,
          59.951314
        ],
        [
          10.741593,
          59.951134
        ],
        [
          10.742714,
          59.950718
        ],
        [
          10.742741,
          59.949246
        ],
        [
          10.742397,
          59.94775
        ],
        [
          10.745138,
          59.947919
        ],
        [
          10.746812,
          59.947897
        ],
        [
          10.748062,
          59.947532
        ],
        [
          10.752134,
          59.946991
        ],
        [
          10.752568,
          59.94589
        ],
        [
          10.754596,
          59.946198
        ],
        [
          10.754703,
          59.946116
        ],
        [
          10.755623,
          59.943482
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Jåberg - Stangeby / Bugården - Ranvik|line/0",
      "name": "Jåberg - Stangeby / Bugården - Ranvik",
      "category": "line",
      "fromExternalId": "relation/14071302",
      "toExternalId": "relation/14071300",
      "nominalKv": 132,
      "lengthKm": 2.55,
      "operator": "Lede",
      "path": [
        [
          10.181059,
          59.130578
        ],
        [
          10.180999,
          59.130525
        ],
        [
          10.178984,
          59.128788
        ],
        [
          10.177072,
          59.12689
        ],
        [
          10.175481,
          59.12531
        ],
        [
          10.173884,
          59.123726
        ],
        [
          10.171804,
          59.121425
        ],
        [
          10.169797,
          59.119213
        ],
        [
          10.167658,
          59.116853
        ],
        [
          10.16634,
          59.11539
        ],
        [
          10.164304,
          59.113141
        ],
        [
          10.163158,
          59.111872
        ],
        [
          10.161487,
          59.11002
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Sogn - Ullevål|cable/1",
      "name": "Sogn - Ullevål",
      "category": "cable",
      "fromExternalId": "relation/10308957",
      "toExternalId": "way/114897970",
      "nominalKv": 132,
      "lengthKm": 2.53,
      "operator": "Elvia",
      "path": [
        [
          10.72752,
          59.953499
        ],
        [
          10.727142,
          59.952837
        ],
        [
          10.72737,
          59.952044
        ],
        [
          10.730431,
          59.94987
        ],
        [
          10.730613,
          59.949357
        ],
        [
          10.731766,
          59.948727
        ],
        [
          10.732622,
          59.947521
        ],
        [
          10.732686,
          59.946811
        ],
        [
          10.731931,
          59.945066
        ],
        [
          10.729859,
          59.942676
        ],
        [
          10.729559,
          59.941812
        ],
        [
          10.729957,
          59.940748
        ],
        [
          10.733121,
          59.940598
        ],
        [
          10.732046,
          59.939215
        ],
        [
          10.731224,
          59.937907
        ],
        [
          10.730464,
          59.937306
        ],
        [
          10.731829,
          59.936186
        ],
        [
          10.731341,
          59.935153
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Tveiten - Rakkås|line/1",
      "name": "Tveiten - Rakkås",
      "category": "line",
      "fromExternalId": "way/51854396",
      "toExternalId": "way/405935304",
      "nominalKv": 132,
      "lengthKm": 2.53,
      "operator": "Lede",
      "path": [
        [
          10.380069,
          59.33022
        ],
        [
          10.381749,
          59.330293
        ],
        [
          10.382244,
          59.330241
        ],
        [
          10.384541,
          59.329986
        ],
        [
          10.385589,
          59.327841
        ],
        [
          10.386228,
          59.326537
        ],
        [
          10.387301,
          59.324348
        ],
        [
          10.388682,
          59.323074
        ],
        [
          10.391029,
          59.320903
        ],
        [
          10.392378,
          59.319694
        ],
        [
          10.395126,
          59.318005
        ],
        [
          10.397977,
          59.316265
        ],
        [
          10.400471,
          59.314752
        ],
        [
          10.404008,
          59.312603
        ],
        [
          10.404057,
          59.312573
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Slagen - Rønningen|line/0",
      "name": "Slagen - Rønningen",
      "category": "line",
      "fromExternalId": "relation/10386410",
      "toExternalId": "way/753706331",
      "nominalKv": 132,
      "lengthKm": 2.49,
      "operator": "Lede",
      "path": [
        [
          10.430749,
          59.283193
        ],
        [
          10.432225,
          59.283093
        ],
        [
          10.435109,
          59.281795
        ],
        [
          10.439117,
          59.279993
        ],
        [
          10.44198,
          59.278424
        ],
        [
          10.445032,
          59.276748
        ],
        [
          10.448352,
          59.274941
        ],
        [
          10.451345,
          59.273271
        ],
        [
          10.454123,
          59.271737
        ],
        [
          10.457258,
          59.270004
        ],
        [
          10.460538,
          59.268198
        ],
        [
          10.46163,
          59.267595
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Rønningen - Nes|line/0",
      "name": "Rønningen - Nes",
      "category": "line",
      "fromExternalId": "way/753706331",
      "toExternalId": "way/325550726",
      "nominalKv": 132,
      "lengthKm": 2.48,
      "operator": "Lede",
      "path": [
        [
          10.46163,
          59.267595
        ],
        [
          10.463149,
          59.266755
        ],
        [
          10.466049,
          59.265155
        ],
        [
          10.466879,
          59.263863
        ],
        [
          10.466112,
          59.261924
        ],
        [
          10.465046,
          59.259207
        ],
        [
          10.46398,
          59.256442
        ],
        [
          10.463036,
          59.254007
        ],
        [
          10.462247,
          59.251999
        ],
        [
          10.46001,
          59.250941
        ],
        [
          10.457134,
          59.249578
        ],
        [
          10.454299,
          59.248205
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Smestad - Koksa / Smestad - Lilleaker|cable/0",
      "name": "Smestad - Koksa / Smestad - Lilleaker",
      "category": "cable",
      "fromExternalId": "node/12765722163",
      "toExternalId": "way/1419567932",
      "nominalKv": 132,
      "lengthKm": 2.48,
      "operator": "Elvia",
      "path": [
        [
          10.66864,
          59.934778
        ],
        [
          10.67163,
          59.933203
        ],
        [
          10.669523,
          59.93233
        ],
        [
          10.668022,
          59.931657
        ],
        [
          10.665439,
          59.93059
        ],
        [
          10.664672,
          59.930224
        ],
        [
          10.6625,
          59.929721
        ],
        [
          10.661743,
          59.929595
        ],
        [
          10.660284,
          59.929535
        ],
        [
          10.65927,
          59.929289
        ],
        [
          10.658173,
          59.928767
        ],
        [
          10.654061,
          59.92748
        ],
        [
          10.648472,
          59.925442
        ],
        [
          10.64705,
          59.924762
        ],
        [
          10.644397,
          59.923708
        ],
        [
          10.644996,
          59.923068
        ],
        [
          10.643477,
          59.921618
        ],
        [
          10.642777,
          59.921278
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Sundland - Gokstad / Gokstad - Mo|line/0",
      "name": "Sundland - Gokstad / Gokstad - Mo",
      "category": "line",
      "fromExternalId": "relation/14071303",
      "toExternalId": "relation/14071307",
      "nominalKv": 132,
      "lengthKm": 2.47,
      "operator": "Lede",
      "path": [
        [
          10.221544,
          59.161203
        ],
        [
          10.225474,
          59.160159
        ],
        [
          10.22959,
          59.159178
        ],
        [
          10.232695,
          59.158426
        ],
        [
          10.235086,
          59.157837
        ],
        [
          10.237555,
          59.155699
        ],
        [
          10.240112,
          59.153491
        ],
        [
          10.242411,
          59.151508
        ],
        [
          10.244734,
          59.149512
        ],
        [
          10.246949,
          59.147606
        ],
        [
          10.249515,
          59.145409
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Akersmyra - Firingen|line/0",
      "name": "Akersmyra - Firingen",
      "category": "line",
      "fromExternalId": "way/51522063",
      "toExternalId": "way/753613423",
      "nominalKv": 132,
      "lengthKm": 2.33,
      "operator": "Lede",
      "path": [
        [
          10.360227,
          59.265619
        ],
        [
          10.358977,
          59.265628
        ],
        [
          10.353293,
          59.265808
        ],
        [
          10.348876,
          59.265937
        ],
        [
          10.343337,
          59.266821
        ],
        [
          10.340837,
          59.267221
        ],
        [
          10.339469,
          59.267647
        ],
        [
          10.334165,
          59.269291
        ],
        [
          10.329602,
          59.270862
        ],
        [
          10.326102,
          59.272066
        ],
        [
          10.323248,
          59.273119
        ],
        [
          10.323114,
          59.273143
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Sande - Leinås 1|line/0",
      "name": "Sande - Leinås 1",
      "category": "line",
      "fromExternalId": "way/50881349",
      "toExternalId": "relation/10355950",
      "nominalKv": 132,
      "lengthKm": 2.23,
      "operator": "Lede",
      "path": [
        [
          10.218326,
          59.57547
        ],
        [
          10.218704,
          59.57571
        ],
        [
          10.221354,
          59.575358
        ],
        [
          10.225143,
          59.574842
        ],
        [
          10.228912,
          59.574731
        ],
        [
          10.234015,
          59.57455
        ],
        [
          10.238487,
          59.574394
        ],
        [
          10.242741,
          59.574233
        ],
        [
          10.245355,
          59.574136
        ],
        [
          10.247506,
          59.573122
        ],
        [
          10.250877,
          59.571503
        ],
        [
          10.254151,
          59.56989
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Sande - Leinås 2|line/0",
      "name": "Sande - Leinås 2",
      "category": "line",
      "fromExternalId": "way/50881349",
      "toExternalId": "relation/10355950",
      "nominalKv": 132,
      "lengthKm": 2.22,
      "operator": "Lede",
      "path": [
        [
          10.218408,
          59.575401
        ],
        [
          10.218831,
          59.575602
        ],
        [
          10.221304,
          59.575273
        ],
        [
          10.225141,
          59.574752
        ],
        [
          10.228905,
          59.574641
        ],
        [
          10.234001,
          59.574461
        ],
        [
          10.238459,
          59.574303
        ],
        [
          10.24273,
          59.574146
        ],
        [
          10.245285,
          59.574052
        ],
        [
          10.247381,
          59.573053
        ],
        [
          10.250723,
          59.571466
        ],
        [
          10.254151,
          59.56989
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Glitre Nett|Ringerike - Follum|line/0",
      "name": "Ringerike - Follum",
      "category": "line",
      "fromExternalId": "way/205115991",
      "toExternalId": "relation/7867734",
      "nominalKv": 132,
      "lengthKm": 2.18,
      "operator": "Glitre Nett",
      "path": [
        [
          10.206967,
          60.168788
        ],
        [
          10.211915,
          60.170639
        ],
        [
          10.214657,
          60.172935
        ],
        [
          10.217559,
          60.174315
        ],
        [
          10.221333,
          60.175907
        ],
        [
          10.224999,
          60.177448
        ],
        [
          10.229535,
          60.17935
        ],
        [
          10.232517,
          60.180585
        ],
        [
          10.235076,
          60.182296
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Porsgrunn - Myrene 1+2|line/0",
      "name": "Porsgrunn - Myrene 1+2",
      "category": "line",
      "fromExternalId": "way/100657505",
      "toExternalId": "way/100648754",
      "nominalKv": 132,
      "lengthKm": 2.15,
      "operator": "Lede",
      "path": [
        [
          9.666445,
          59.13285
        ],
        [
          9.664654,
          59.130574
        ],
        [
          9.663612,
          59.12926
        ],
        [
          9.662057,
          59.128282
        ],
        [
          9.660802,
          59.127497
        ],
        [
          9.659272,
          59.126542
        ],
        [
          9.659244,
          59.125288
        ],
        [
          9.661639,
          59.123686
        ],
        [
          9.663763,
          59.122264
        ],
        [
          9.665993,
          59.120773
        ],
        [
          9.667955,
          59.119458
        ],
        [
          9.669787,
          59.118231
        ],
        [
          9.67193,
          59.116796
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lede|Kjørbekk/Hauen - Moflata|line/0",
      "name": "Kjørbekk/Hauen - Moflata",
      "category": "line",
      "fromExternalId": "way/100666305",
      "toExternalId": "way/100666299",
      "nominalKv": 132,
      "lengthKm": 2.03,
      "operator": "Lede",
      "path": [
        [
          9.604427,
          59.17733
        ],
        [
          9.600664,
          59.178201
        ],
        [
          9.597188,
          59.178998
        ],
        [
          9.595572,
          59.179687
        ],
        [
          9.593233,
          59.180674
        ],
        [
          9.592395,
          59.182833
        ],
        [
          9.591582,
          59.184895
        ],
        [
          9.59074,
          59.187052
        ],
        [
          9.590026,
          59.188854
        ],
        [
          9.589359,
          59.190562
        ],
        [
          9.589302,
          59.192007
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elvia|Smestad - Skøyen|cable/0",
      "name": "Smestad - Skøyen",
      "category": "cable",
      "fromExternalId": "node/12765722163",
      "toExternalId": "way/133756725",
      "nominalKv": 132,
      "lengthKm": 2.01,
      "operator": "Elvia",
      "path": [
        [
          10.66864,
          59.934778
        ],
        [
          10.669829,
          59.934321
        ],
        [
          10.689239,
          59.919982
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    }
  ],
  "generators": [
    {
      "externalId": "way/551453826",
      "name": "Tokke kraftverk",
      "generationKind": "hydro",
      "lon": 8.040444,
      "lat": 59.445535,
      "capacityMw": 430,
      "annualProductionGwh": 2396.042,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Tokke"
    },
    {
      "externalId": "relation/8251801",
      "name": "Vamma kraftverk",
      "generationKind": "hydro",
      "lon": 11.170343,
      "lat": 59.543117,
      "capacityMw": 344,
      "annualProductionGwh": 1565.42,
      "operator": "HAFSLUND KRAFT AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Vamma"
    },
    {
      "externalId": "way/576502805",
      "name": "Brokke kraftverk",
      "generationKind": "hydro",
      "lon": 7.506227,
      "lat": 59.1248,
      "capacityMw": 330,
      "annualProductionGwh": 1600.745,
      "operator": "OTRA KRAFT DA",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Brokke"
    },
    {
      "externalId": "way/551408917",
      "name": "Vinje kraftverk",
      "generationKind": "hydro",
      "lon": 7.853865,
      "lat": 59.625568,
      "capacityMw": 300,
      "annualProductionGwh": 1105.342,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Vinje"
    },
    {
      "externalId": "way/549830929",
      "name": "Nes kraftverk",
      "generationKind": "hydro",
      "lon": 9.065004,
      "lat": 60.603353,
      "capacityMw": 250,
      "annualProductionGwh": 1421.242,
      "operator": "HAFSLUND KRAFT AS",
      "priceArea": "5",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Nes"
    },
    {
      "externalId": "relation/8250944",
      "name": "Kykkelsrud Fossumfoss kraftverk",
      "generationKind": "hydro",
      "lon": 11.101913,
      "lat": 59.579923,
      "capacityMw": 230,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "relation/7812775",
      "name": "Hol I kraftverk",
      "generationKind": "hydro",
      "lon": 8.182059,
      "lat": 60.626638,
      "capacityMw": 220,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "relation/7854487",
      "name": "Nore I kraftstasjon",
      "generationKind": "hydro",
      "lon": 8.960358,
      "lat": 60.267066,
      "capacityMw": 206,
      "annualProductionGwh": 1164.664,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "5",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Nore I"
    },
    {
      "externalId": "way/549645130",
      "name": "Usta kraftverk",
      "generationKind": "hydro",
      "lon": 8.410248,
      "lat": 60.567393,
      "capacityMw": 205.22,
      "annualProductionGwh": 896.913,
      "operator": "HAFSLUND KRAFT AS",
      "priceArea": "5",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Usta"
    },
    {
      "externalId": "way/551246060",
      "name": "Vemork kraftverk",
      "generationKind": "hydro",
      "lon": 8.493596,
      "lat": 59.869508,
      "capacityMw": 204,
      "annualProductionGwh": 1280.288,
      "operator": "HYDRO ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Vemork"
    },
    {
      "externalId": "relation/9905563",
      "name": "Solbergfoss kraftverk",
      "generationKind": "hydro",
      "lon": 11.154801,
      "lat": 59.636981,
      "capacityMw": 201,
      "annualProductionGwh": 1048.157,
      "operator": "HAFSLUND KRAFT AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Solbergfoss"
    },
    {
      "externalId": "way/188088500",
      "name": "Såheim kraftverk",
      "generationKind": "hydro",
      "lon": 8.592941,
      "lat": 59.876613,
      "capacityMw": 189,
      "annualProductionGwh": 1121.36,
      "operator": "HYDRO ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Såheim"
    },
    {
      "externalId": "way/551246086",
      "name": "Mår kraftverk",
      "generationKind": "hydro",
      "lon": 8.673947,
      "lat": 59.885382,
      "capacityMw": 180,
      "annualProductionGwh": 1146.08,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Mår"
    },
    {
      "externalId": "relation/8229572",
      "name": "Rånåsfoss kraftverk",
      "generationKind": "hydro",
      "lon": 11.32372,
      "lat": 60.027509,
      "capacityMw": 128.4,
      "annualProductionGwh": 572.097,
      "operator": "GLOMMA KRAFTPRODUKSJON AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Rånåsfoss"
    },
    {
      "externalId": "node/4331180382",
      "name": "Songa kraftverk",
      "generationKind": "hydro",
      "lon": 7.728806,
      "lat": 59.779571,
      "capacityMw": 120,
      "annualProductionGwh": 619.461,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Songa"
    },
    {
      "externalId": "way/551194975",
      "name": "Hjartdøla kraftverk",
      "generationKind": "hydro",
      "lon": 8.713208,
      "lat": 59.608251,
      "capacityMw": 120,
      "annualProductionGwh": 448.303,
      "operator": "SKAGERAK KRAFT AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Hjartdøla"
    },
    {
      "externalId": "way/552936753",
      "name": "Finndøla kraftverk",
      "generationKind": "hydro",
      "lon": 8.039717,
      "lat": 59.187104,
      "capacityMw": 108,
      "annualProductionGwh": 296.525,
      "operator": "FINNDØLA KRAFTVERK DA",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Finndøla"
    },
    {
      "externalId": "way/551893756",
      "name": "Sundsbarm kraftverk",
      "generationKind": "hydro",
      "lon": 8.632795,
      "lat": 59.500774,
      "capacityMw": 103,
      "annualProductionGwh": 396.437,
      "operator": "SKAGERAK KRAFT AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Sundsbarm"
    },
    {
      "externalId": "way/671995703",
      "name": "Skollenborg kraftverk",
      "generationKind": "hydro",
      "lon": 9.667958,
      "lat": 59.621969,
      "capacityMw": 97,
      "annualProductionGwh": 379.688,
      "operator": "Å ENERGI VANNKRAFT AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Skollenborg"
    },
    {
      "externalId": "way/551074017",
      "name": "Svelgfoss kraftverk",
      "generationKind": "hydro",
      "lon": 9.256084,
      "lat": 59.582176,
      "capacityMw": 92,
      "annualProductionGwh": 563.691,
      "operator": "HYDRO ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Svelgfoss"
    },
    {
      "externalId": "way/550009029",
      "name": "Uvdal I",
      "generationKind": "hydro",
      "lon": 8.701727,
      "lat": 60.243826,
      "capacityMw": 90,
      "annualProductionGwh": 303.713,
      "operator": "SKAGERAK KRAFT AS",
      "priceArea": "5",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Uvdal 1"
    },
    {
      "externalId": "way/550454436",
      "name": "Kaggefoss kraftverk",
      "generationKind": "hydro",
      "lon": 9.934508,
      "lat": 59.947584,
      "capacityMw": 85.5,
      "annualProductionGwh": 582.162,
      "operator": "Å ENERGI VANNKRAFT AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Kaggefoss"
    },
    {
      "externalId": "way/110404716",
      "name": "Sarp kraftverk",
      "generationKind": "hydro",
      "lon": 11.133742,
      "lat": 59.276473,
      "capacityMw": 80,
      "annualProductionGwh": 507.308,
      "operator": "HAFSLUND KRAFT AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Sarp"
    },
    {
      "externalId": "relation/9640355",
      "name": "Embretsfoss kraftverk",
      "generationKind": "hydro",
      "lon": 9.927612,
      "lat": 59.900898,
      "capacityMw": 71,
      "annualProductionGwh": 337.228,
      "operator": "EMBRETSFOSSKRAFTVERKENE DA",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Embretsfoss"
    },
    {
      "externalId": "way/549619899",
      "name": "Hol III kraftverk",
      "generationKind": "hydro",
      "lon": 8.404621,
      "lat": 60.582868,
      "capacityMw": 60,
      "annualProductionGwh": 248.213,
      "operator": "HAFSLUND KRAFT AS",
      "priceArea": "5",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Hol 3"
    },
    {
      "externalId": "way/576502840",
      "name": "Hekni kraftverk",
      "generationKind": "hydro",
      "lon": 7.548294,
      "lat": 58.995396,
      "capacityMw": 56,
      "annualProductionGwh": 242.611,
      "operator": "Å ENERGI VANNKRAFT AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Hekni"
    },
    {
      "externalId": "way/576502867",
      "name": "Jørundland kraftverk",
      "generationKind": "hydro",
      "lon": 8.224908,
      "lat": 58.907337,
      "capacityMw": 55.2,
      "annualProductionGwh": 185.794,
      "operator": "Å ENERGI VANNKRAFT AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Jørundland"
    },
    {
      "externalId": "way/194919724",
      "name": "Borregaard kraftverk",
      "generationKind": "hydro",
      "lon": 11.130066,
      "lat": 59.276403,
      "capacityMw": 54,
      "annualProductionGwh": 271.286,
      "operator": "SARPSFOSS LIMITED NUF",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Borregaard"
    },
    {
      "externalId": "way/550009025",
      "name": "Nore II kraftstasjon",
      "generationKind": "hydro",
      "lon": 9.000784,
      "lat": 60.238176,
      "capacityMw": 52,
      "annualProductionGwh": 305.597,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Nore II"
    },
    {
      "externalId": "node/5337575576",
      "name": "Fjone kraftverk",
      "generationKind": "hydro",
      "lon": 8.450782,
      "lat": 59.217088,
      "capacityMw": 50,
      "annualProductionGwh": 128.707,
      "operator": "SKAGERAK KRAFT AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Fjone"
    },
    {
      "externalId": "way/550195658",
      "name": "Mykstufoss kraftverk",
      "generationKind": "hydro",
      "lon": 9.199862,
      "lat": 60.050248,
      "capacityMw": 48,
      "annualProductionGwh": 282.716,
      "operator": "Å ENERGI VANNKRAFT AS",
      "priceArea": "1",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Mykstufoss"
    },
    {
      "externalId": "node/408745408",
      "name": "Frøystul kraftverk",
      "generationKind": "hydro",
      "lon": 8.344074,
      "lat": 59.82477,
      "capacityMw": 45.6,
      "annualProductionGwh": 216.189,
      "operator": "HYDRO ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Frøystul"
    },
    {
      "externalId": "way/576502849",
      "name": "Hovatn kraftverk",
      "generationKind": "hydro",
      "lon": 7.672351,
      "lat": 58.98387,
      "capacityMw": 45,
      "annualProductionGwh": 93.717,
      "operator": "Å ENERGI VANNKRAFT AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Hovatn"
    },
    {
      "externalId": "node/671863072",
      "name": "Lio kraftverk",
      "generationKind": "hydro",
      "lon": 7.933074,
      "lat": 59.465876,
      "capacityMw": 43,
      "annualProductionGwh": 266.18,
      "operator": "STATKRAFT ENERGI AS",
      "priceArea": "2",
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": "nve:vannkraftdatabase:Lio"
    }
  ],
  "loads": [
    {
      "id": "oslo-west-urban",
      "label": "Oslo west urban load",
      "loadKind": "residential",
      "busExternalId": "node/12765722163",
      "lon": 10.68,
      "lat": 59.94,
      "demandMw": 280,
      "criticalMw": 105,
      "reactiveDemandMvar": 60,
      "priority": "normal"
    },
    {
      "id": "oslo-north-urban",
      "label": "Oslo north urban load",
      "loadKind": "residential",
      "busExternalId": "relation/10308957",
      "lon": 10.75,
      "lat": 59.96,
      "demandMw": 320,
      "criticalMw": 120,
      "reactiveDemandMvar": 70,
      "priority": "normal"
    },
    {
      "id": "oslo-east-urban",
      "label": "Oslo east urban load",
      "loadKind": "residential",
      "busExternalId": "way/113442999",
      "lon": 10.84,
      "lat": 59.93,
      "demandMw": 320,
      "criticalMw": 115,
      "reactiveDemandMvar": 70,
      "priority": "normal"
    },
    {
      "id": "oslo-hospital",
      "label": "Oslo hospital critical load",
      "loadKind": "hospital",
      "busExternalId": "way/114897970",
      "lon": 10.7387,
      "lat": 59.9369,
      "demandMw": 85,
      "criticalMw": 70,
      "reactiveDemandMvar": 22,
      "priority": "critical"
    },
    {
      "id": "gardermoen-airport",
      "label": "Oslo airport load",
      "loadKind": "airport",
      "busExternalId": "way/120279477",
      "lon": 11.1004,
      "lat": 60.1939,
      "demandMw": 120,
      "criticalMw": 55,
      "reactiveDemandMvar": 34,
      "priority": "high"
    },
    {
      "id": "grenland-industry",
      "label": "Grenland process industry",
      "loadKind": "industry",
      "busExternalId": "relation/18667239",
      "lon": 9.66,
      "lat": 59.12,
      "demandMw": 650,
      "criticalMw": 330,
      "reactiveDemandMvar": 220,
      "priority": "high"
    },
    {
      "id": "ostfold-industry",
      "label": "Østfold process industry",
      "loadKind": "industry",
      "busExternalId": "relation/8251802",
      "lon": 11.12,
      "lat": 59.28,
      "demandMw": 390,
      "criticalMw": 210,
      "reactiveDemandMvar": 120,
      "priority": "high"
    },
    {
      "id": "drammen-urban",
      "label": "Drammen urban load",
      "loadKind": "residential",
      "busExternalId": "way/187555858",
      "lon": 10.2,
      "lat": 59.74,
      "demandMw": 300,
      "criticalMw": 110,
      "reactiveDemandMvar": 65,
      "priority": "normal"
    },
    {
      "id": "vestfold-consumer",
      "label": "Vestfold consumer supply",
      "loadKind": "commercial",
      "busExternalId": "way/51854396",
      "lon": 10.25,
      "lat": 59.18,
      "demandMw": 260,
      "criticalMw": 95,
      "reactiveDemandMvar": 60,
      "priority": "normal"
    },
    {
      "id": "telemark-industry",
      "label": "Telemark industrial load",
      "loadKind": "industry",
      "busExternalId": "way/287115458",
      "lon": 9.65,
      "lat": 59.65,
      "demandMw": 330,
      "criticalMw": 160,
      "reactiveDemandMvar": 105,
      "priority": "high"
    },
    {
      "id": "ringerike-consumer",
      "label": "Ringerike consumer supply",
      "loadKind": "commercial",
      "busExternalId": "way/205115991",
      "lon": 10.25,
      "lat": 60.15,
      "demandMw": 190,
      "criticalMw": 70,
      "reactiveDemandMvar": 44,
      "priority": "normal"
    },
    {
      "id": "oslo-ev",
      "label": "Oslo EV fast-charging cluster",
      "loadKind": "ev_charging",
      "busExternalId": "way/113442999",
      "lon": 10.85,
      "lat": 59.94,
      "demandMw": 145,
      "criticalMw": 20,
      "reactiveDemandMvar": 28,
      "priority": "low",
      "controllable": true
    },
    {
      "id": "e18-truck-depot",
      "label": "E18 truck charging depot",
      "loadKind": "ev_charging",
      "busExternalId": "way/749676336",
      "lon": 10.49,
      "lat": 59.9,
      "demandMw": 95,
      "criticalMw": 10,
      "reactiveDemandMvar": 16,
      "priority": "low",
      "controllable": true
    },
    {
      "id": "oslo-data-center",
      "label": "Oslo data-center load",
      "loadKind": "data_center",
      "busExternalId": "relation/8239198",
      "lon": 10.98,
      "lat": 59.96,
      "demandMw": 230,
      "criticalMw": 165,
      "reactiveDemandMvar": 56,
      "priority": "high"
    }
  ]
} as const
