import type { SourceDerivedGridArenaData } from './types.ts'

export const norwayGridArenaData: SourceDerivedGridArenaData = {
  "sourceBuild": {
    "id": "source-derived-norway-grid-arena-v1",
    "generatedAt": "2026-05-30T21:14:23.792Z",
    "sourceIds": [
      "osm:pbf-power:NO",
      "nve:vannkraftdatabase",
      "nve:vindkraftdatabase"
    ],
    "notes": [
      "Operational arena generated from the grid-norway OSM PBF reference sidecar at national Norway scope.",
      "The operational graph is transmission-focused: dense OSM reference segments remain reference map geometry, while the runtime arena keeps national 300 kV+ backbone assets, northern 132 kV+ regional assets, eastern 220 kV+ regional assets, major generation, and aggregate consumer zones.",
      "NVE hydropower and wind APIs are used to augment generator capacity, annual production, operator, and price-area provenance where names match.",
      "Co-located OSM plant/generator duplicates are collapsed when a larger plant-level feature covers smaller same-family unit nodes.",
      "Consumer load zones are inferred operational demand aggregates attached to real high-voltage buses."
    ]
  },
  "substations": [
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
      "externalId": "way/552672002",
      "name": "Adamselv trafostasjon",
      "lon": 26.695875,
      "lat": 70.409645,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Stattnet",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/615122824",
      "name": "Åfjord trafostasjon",
      "lon": 10.221688,
      "lat": 63.89062,
      "voltageKv": [
        420,
        132,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett;Tensio TS",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/548201553",
      "name": "Ålfoten trafostasjon",
      "lon": 5.548602,
      "lat": 61.828883,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8278085",
      "name": "Alta(Raipas) trafostasjon",
      "lon": 23.373256,
      "lat": 69.952156,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10175479",
      "name": "Åna-Sira trafostasjon",
      "lon": 6.453799,
      "lat": 58.294949,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Lyse Elnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/358915801",
      "name": "Arendal trafostasjon",
      "lon": 8.729507,
      "lat": 58.588311,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8834935",
      "name": "Arna trafostasjon",
      "lon": 5.457013,
      "lat": 60.394554,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8279949",
      "name": "Aronnes trafostasjon",
      "lon": 23.28492,
      "lat": 69.966321,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Alut",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/638183341",
      "name": "Åsen trafostasjon",
      "lon": 6.628987,
      "lat": 60.129008,
      "voltageKv": [
        300,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7839720",
      "name": "Aura trafostasjon",
      "lon": 8.522888,
      "lat": 62.66409,
      "voltageKv": [
        420,
        300,
        132,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/3993780",
      "name": "Aurland 1 trafostasjon",
      "lon": 7.301308,
      "lat": 60.862925,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/37907251",
      "name": "Aurland III kraftverk trafo",
      "lon": 7.565874,
      "lat": 60.78884,
      "voltageKv": [
        420,
        66,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett;Hafslund E-CO Vannkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/166227080",
      "name": "Bærheim trafostasjon",
      "lon": 5.693315,
      "lat": 58.883163,
      "voltageKv": [
        300,
        50
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Lnett",
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
      "externalId": "way/554551085",
      "name": "Balbergskaret koblingsstasjon",
      "lon": 10.448102,
      "lat": 61.163729,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587726948",
      "name": "Ballangen koblingsstasjon",
      "lon": 16.733247,
      "lat": 68.261144,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898616",
      "name": "Balsfjord trafostasjon",
      "lon": 19.203097,
      "lat": 69.189707,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
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
      "externalId": "relation/8285905",
      "name": "Bardu trafostasjon",
      "lon": 18.31986,
      "lat": 68.863381,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8283263",
      "name": "Bardufoss kraftverk",
      "lon": 18.589494,
      "lat": 69.043772,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva; Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898618",
      "name": "Bardufoss trafostasjon",
      "lon": 18.592552,
      "lat": 69.033987,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett; Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/657434624",
      "name": "Båtsfjord trafostasjon",
      "lon": 29.713204,
      "lat": 70.639777,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/610484703",
      "name": "Bjerka kraftverk",
      "lon": 13.997639,
      "lat": 66.062512,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/799370310",
      "name": "Bjerkreim trafostasjon",
      "lon": 5.920248,
      "lat": 58.590198,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Lyse",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8293880",
      "name": "Bjørkåsen trafostasjon",
      "lon": 16.782841,
      "lat": 68.321894,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8269872",
      "name": "Bjørnevatn trafostasjon",
      "lon": 30.005446,
      "lat": 69.665695,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/440170580",
      "name": "Blåfalli III kraftverk",
      "lon": 6.07339,
      "lat": 59.871389,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/432965765",
      "name": "Blåfalli koblingsstasjon",
      "lon": 6.009814,
      "lat": 59.863367,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1156551462",
      "name": "Boltås trafostasjon",
      "lon": 16.664133,
      "lat": 68.530592,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7845549",
      "name": "Borgund trafostasjon",
      "lon": 7.818716,
      "lat": 61.059392,
      "voltageKv": [
        300,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett; Sygnir",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8846916",
      "name": "Børtveit koblingsstasjon",
      "lon": 5.510349,
      "lat": 59.884905,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8281952",
      "name": "Brensholmeneidet trafostasjon",
      "lon": 18.072413,
      "lat": 69.568733,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/244179408",
      "name": "Brokke kraftverk",
      "lon": 7.509847,
      "lat": 59.123629,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/923057959",
      "name": "Bybanen Transformator Stasjon",
      "lon": 5.347549,
      "lat": 60.334936,
      "voltageKv": [
        750
      ],
      "maxVoltageKv": 750,
      "operator": "Bybanen AS",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9344645",
      "name": "Charlottenlund Transformatorstasjon",
      "lon": 18.95063,
      "lat": 69.664041,
      "voltageKv": [
        132,
        66,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "way/114669733",
      "name": "Dale koblingsstasjon",
      "lon": 5.809595,
      "lat": 60.581459,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/261717967",
      "name": "Duge kraftverk",
      "lon": 6.894942,
      "lat": 59.125702,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/19581816",
      "name": "Eidum trafostasjon",
      "lon": 11.003994,
      "lat": 63.448134,
      "voltageKv": [
        300,
        132,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Tensio TN",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588443638",
      "name": "Enga trafostasjon",
      "lon": 13.532234,
      "lat": 66.78709,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8890887",
      "name": "Ertsmyra like- og vekselretter stasjon",
      "lon": 6.754876,
      "lat": 58.669306,
      "voltageKv": [
        525,
        420
      ],
      "maxVoltageKv": 525,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8890888",
      "name": "Ertsmyra trafostasjon",
      "lon": 6.752945,
      "lat": 58.670654,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/307323708",
      "name": "Evanger transformatorstasjon",
      "lon": 6.11174,
      "lat": 60.656261,
      "voltageKv": [
        300,
        132,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;BKK",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/297388897",
      "name": "Fåberg trafostasjon",
      "lon": 10.42168,
      "lat": 61.13848,
      "voltageKv": [
        300,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett; Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/830770515",
      "name": "Fagrafjell trafostasjon",
      "lon": 5.761878,
      "lat": 58.790268,
      "voltageKv": [
        420,
        300,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett;Lnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8836351",
      "name": "Fana transformatorstasjon",
      "lon": 5.341813,
      "lat": 60.287366,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;BKK",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296010",
      "name": "Fauske trafostasjon",
      "lon": 15.419068,
      "lat": 67.271269,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11981383",
      "name": "Feda like- og vekselretter stasjon",
      "lon": 6.866706,
      "lat": 58.282544,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12627235",
      "name": "Finneidfjord trafostasjon",
      "lon": 13.796482,
      "lat": 66.188699,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Linea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8285305",
      "name": "Finnfjordbotn trafostasjon",
      "lon": 18.083238,
      "lat": 69.221255,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/640796702",
      "name": "Fjotland trafostasjon",
      "lon": 7.019131,
      "lat": 58.768294,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
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
      "externalId": "relation/8721337",
      "name": "Førre trafostasjon",
      "lon": 6.603666,
      "lat": 59.327473,
      "voltageKv": [
        300,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8679746",
      "name": "Fortun trafostasjon",
      "lon": 7.69985,
      "lat": 61.505699,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7839089",
      "name": "Fræna trafostasjon",
      "lon": 7.111346,
      "lat": 62.859537,
      "voltageKv": [
        420,
        132,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett;Elinett",
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
      "externalId": "way/587356986",
      "name": "Fygle trafostasjon",
      "lon": 13.637827,
      "lat": 68.149152,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elmea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8271257",
      "name": "Gandvik trafostasjon",
      "lon": 29.121194,
      "lat": 70.008615,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Pasvik Kraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292077",
      "name": "Gåra trafostasjon",
      "lon": 16.253904,
      "lat": 68.758249,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292079",
      "name": "Gåsvatn koblingsstasjon",
      "lon": 16.324422,
      "lat": 68.765933,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9344646",
      "name": "Gimle trafostasjon",
      "lon": 18.978689,
      "lat": 69.687402,
      "voltageKv": [
        132,
        66,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/690859516",
      "name": "Gjerelvmo trafostasjon",
      "lon": 15.979756,
      "lat": 67.638266,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Kystnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8301307",
      "name": "Glomfjord trafostasjon",
      "lon": 13.934691,
      "lat": 66.817434,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/711130655",
      "name": "Govddesåga kraftverk",
      "lon": 14.387577,
      "lat": 66.924855,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Salten Kraftsamband Produksjon",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/106934339",
      "name": "Grefsen likeretterstasjon",
      "lon": 10.785634,
      "lat": 59.951278,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
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
      "externalId": "relation/8307477",
      "name": "Gullsmedvik trafostasjon",
      "lon": 14.152988,
      "lat": 66.326412,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Sameiet Langvatn – Gullsmedvik",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898605",
      "name": "Guolášjohka trafostasjon",
      "lon": 20.918226,
      "lat": 69.460558,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "way/586667770",
      "name": "Håkøybotn koblingsstasjon",
      "lon": 18.699972,
      "lat": 69.623219,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "relation/8301304",
      "name": "Halsa trafostasjon",
      "lon": 13.598652,
      "lat": 66.748943,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "way/586152359",
      "name": "Hammerfest trafostasjon",
      "lon": 23.713873,
      "lat": 70.657574,
      "voltageKv": [
        132,
        66,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Lucerna",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990796",
      "name": "Hamnefjellet trafostasjon",
      "lon": 29.708871,
      "lat": 70.660486,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Hamnefjell Vindkraft",
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
      "externalId": "relation/12969006",
      "name": "Haugsneset likeretter",
      "lon": 5.552513,
      "lat": 59.273789,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/648848845",
      "name": "Haugsvær trafostasjon",
      "lon": 5.527141,
      "lat": 60.889704,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;BKK",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13989591",
      "name": "Håvik trafostasjon",
      "lon": 5.315615,
      "lat": 59.31725,
      "voltageKv": [
        300,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Fagne",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587607517",
      "name": "Heggen trafostasjon",
      "lon": 16.521912,
      "lat": 68.795647,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/549449182",
      "name": "Hemsil 1 koblingsstasjon",
      "lon": 8.641281,
      "lat": 60.807675,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12277754",
      "name": "Hemsil 2 koblingsstasjon",
      "lon": 8.971704,
      "lat": 60.705327,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/8396776075",
      "name": "Hemsil 2 trafostasjon",
      "lon": 8.969394,
      "lat": 60.704905,
      "voltageKv": [
        300,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13284562",
      "name": "Herøya 3 trafostasjon",
      "lon": 9.634219,
      "lat": 59.117065,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Herøya Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/179044834",
      "name": "Hinnøy koblingsstasjon",
      "lon": 15.499916,
      "lat": 68.683248,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
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
      "externalId": "way/613587460",
      "name": "Hofstad trafostasjon",
      "lon": 10.540355,
      "lat": 64.1642,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
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
      "externalId": "relation/8182117",
      "name": "Holen trafo",
      "lon": 7.249484,
      "lat": 59.346154,
      "voltageKv": [
        420,
        66,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/577998803",
      "name": "Honna trafostasjon",
      "lon": 7.476093,
      "lat": 58.680608,
      "voltageKv": [
        420,
        110
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8297300",
      "name": "Hopen trafostasjon",
      "lon": 14.739019,
      "lat": 67.319301,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/546262583",
      "name": "Hove koblingsstasjon",
      "lon": 6.595907,
      "lat": 61.069885,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/9519270911",
      "name": "Hove kraftverk",
      "lon": 6.589203,
      "lat": 61.066619,
      "voltageKv": [
        300,
        66
      ],
      "maxVoltageKv": 300,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/547743430",
      "name": "Høyanger trafostasjon",
      "lon": 6.149269,
      "lat": 61.243975,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280652",
      "name": "Hungeren trafostasjon",
      "lon": 18.973974,
      "lat": 69.639512,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7809753",
      "name": "Husnes",
      "lon": 5.766283,
      "lat": 59.862529,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/511117400",
      "name": "Hyggevatn trafostasjon",
      "lon": 23.725382,
      "lat": 70.680616,
      "voltageKv": [
        132,
        110,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Lucerna",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12274653",
      "name": "Hylen koblingsstasjon",
      "lon": 6.602133,
      "lat": 59.560348,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587053818",
      "name": "Innset kraftverk",
      "lon": 18.820048,
      "lat": 68.657717,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/865236489",
      "name": "Jar likeretterstasjon",
      "lon": 10.618756,
      "lat": 59.926276,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/646643191",
      "name": "Jomfrubråten likeretterstasjon",
      "lon": 10.771221,
      "lat": 59.887738,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8288539",
      "name": "Kanstadbotn trafostasjon",
      "lon": 15.881989,
      "lat": 68.506872,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8864887",
      "name": "Kårstø trafostasjon",
      "lon": 5.505199,
      "lat": 59.278246,
      "voltageKv": [
        300,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Gassco",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1021851013",
      "name": "Kastellet likeretterstasjon",
      "lon": 10.79016,
      "lat": 59.871448,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/120105564",
      "name": "Kilbotn trafostasjon",
      "lon": 16.510541,
      "lat": 68.714677,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/962052314",
      "name": "Kiosk 134",
      "lon": 5.357257,
      "lat": 60.328857,
      "voltageKv": [
        320,
        11
      ],
      "maxVoltageKv": 320,
      "operator": "BKK",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8269874",
      "name": "Kirkenes trafostasjon",
      "lon": 30.033642,
      "lat": 69.722853,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1156161502",
      "name": "Kjela kraftverk",
      "lon": 7.444101,
      "lat": 59.736308,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8332571",
      "name": "Kjelland transformatorstasjon",
      "lon": 6.032434,
      "lat": 58.494858,
      "voltageKv": [
        300,
        50
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1203811851",
      "name": "Kjelling trafostasjon",
      "lon": 14.346683,
      "lat": 67.074342,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/867043428",
      "name": "Kjelsås likeretterstasjon",
      "lon": 10.784529,
      "lat": 59.964261,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587793855",
      "name": "Kjøpsvik trafostasjon",
      "lon": 16.371057,
      "lat": 68.098623,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Kystnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/287685850",
      "name": "Klæbu transformatorstasjon",
      "lon": 10.419003,
      "lat": 63.326743,
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
      "externalId": "way/587348300",
      "name": "Kleppstad trafostasjon",
      "lon": 14.282186,
      "lat": 68.262271,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elmea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8293948",
      "name": "Kobbelv kraftverk",
      "lon": 15.990332,
      "lat": 67.622688,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990791",
      "name": "Kobbkroken trafostasjon",
      "lon": 29.28578,
      "lat": 70.712113,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/842385259",
      "name": "Kobbvatnet trafostasjon",
      "lon": 15.988455,
      "lat": 67.63753,
      "voltageKv": [
        420,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/636875282",
      "name": "Kollsnes Martin Linge trafostasjon",
      "lon": 4.846431,
      "lat": 60.552502,
      "voltageKv": [
        300,
        100
      ],
      "maxVoltageKv": 300,
      "operator": "Equinor",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8839478",
      "name": "Kollsnes trafostasjon",
      "lon": 4.844507,
      "lat": 60.550682,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;BKK",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8482013",
      "name": "Kolsvik trafostasjon",
      "lon": 12.792462,
      "lat": 65.20452,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7928148",
      "name": "Kristiansand trafostasjon",
      "lon": 7.900937,
      "lat": 58.259273,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587053901",
      "name": "Krogstad koblingspunkt",
      "lon": 18.424259,
      "lat": 68.884168,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280181",
      "name": "Kvænangen trafostasjon",
      "lon": 22.054563,
      "lat": 69.719919,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8281954",
      "name": "Kvaløya trafostasjon",
      "lon": 18.881218,
      "lat": 69.698447,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8277461",
      "name": "Kvalsund trafostasjon",
      "lon": 23.969922,
      "lat": 70.488067,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Lucerna",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/430780474",
      "name": "Kvanndal kraftverk",
      "lon": 6.984078,
      "lat": 59.658134,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/252924745",
      "name": "Kvanndal trafostasjon",
      "lon": 17.61092,
      "lat": 68.577497,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8857439",
      "name": "Kvilldal koblingsstasjon",
      "lon": 6.654463,
      "lat": 59.528666,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/285481596",
      "name": "Kvinen kraftverk",
      "lon": 7.087828,
      "lat": 58.93136,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Sira-Kvina kraftselskap",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8894066",
      "name": "Kvinesdal trafostasjon",
      "lon": 6.847959,
      "lat": 58.276129,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1158040163",
      "name": "Kvitfjell trafostasjon",
      "lon": 18.156133,
      "lat": 69.56866,
      "voltageKv": [
        132,
        33
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/709830245",
      "name": "Kvitfossen trafostasjon",
      "lon": 14.653932,
      "lat": 68.327089,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elmea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/228085650",
      "name": "Kvitnes trafostasjon",
      "lon": 16.598149,
      "lat": 68.629118,
      "voltageKv": [
        132,
        33,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/128291126",
      "name": "Lakselv trafostasjon",
      "lon": 24.972881,
      "lat": 70.003185,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett;Area Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11636421",
      "name": "Langvatn trafostasjon",
      "lon": 14.166329,
      "lat": 66.336674,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Linea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7814748",
      "name": "Leirdøla trafostasjon",
      "lon": 7.246237,
      "lat": 61.437056,
      "voltageKv": [
        300,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett; Breheim Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8306711",
      "name": "Leirosen trafostasjon",
      "lon": 13.064744,
      "lat": 66.079608,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Linea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990787",
      "name": "Leirpollen trafostasjon",
      "lon": 28.522662,
      "lat": 70.426798,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/20598970",
      "name": "Lindås trafostasjon",
      "lon": 5.041276,
      "lat": 60.79452,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10547156",
      "name": "Lio kraftverk",
      "lon": 7.939084,
      "lat": 59.463268,
      "voltageKv": [
        300,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8896922",
      "name": "Lista trafostasjon",
      "lon": 6.775357,
      "lat": 58.077101,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8837899",
      "name": "Litlesotra trafostasjon",
      "lon": 5.132171,
      "lat": 60.36555,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett; BKK",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/953796939",
      "name": "Lødingen trafostasjon",
      "lon": 15.969191,
      "lat": 68.401447,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett; Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280563",
      "name": "Lyngen trafostasjon",
      "lon": 20.27116,
      "lat": 69.589315,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8886202",
      "name": "Lyse trafostasjon",
      "lon": 6.663454,
      "lat": 59.059991,
      "voltageKv": [
        420,
        300
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/116250420",
      "name": "Majorstuen likeretterstasjon",
      "lon": 10.708166,
      "lat": 59.932964,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8476872",
      "name": "Marka trafostasjon",
      "lon": 13.289685,
      "lat": 65.851807,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Linea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7805329",
      "name": "Mauranger trafostasjon",
      "lon": 6.3312,
      "lat": 60.132044,
      "voltageKv": [
        300,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292075",
      "name": "Medkila trafostasjon",
      "lon": 16.545247,
      "lat": 68.770977,
      "voltageKv": [
        132,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8288766",
      "name": "Melbu trafostasjon",
      "lon": 14.851928,
      "lat": 68.510547,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/685025511",
      "name": "Melkøya trafostasjon",
      "lon": 23.594344,
      "lat": 70.690504,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Equinor",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588074294",
      "name": "Messiosen trafostasjon",
      "lon": 14.556801,
      "lat": 67.294282,
      "voltageKv": [
        132,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586502774",
      "name": "Mestervik koblingsstasjon",
      "lon": 18.88399,
      "lat": 69.337948,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett; Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8846883",
      "name": "Midtfjellet trafostasjon",
      "lon": 5.395603,
      "lat": 59.930925,
      "voltageKv": [
        300,
        66,
        33
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
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
      "externalId": "relation/7802012",
      "name": "Modalen koblingsstasjon",
      "lon": 6.012658,
      "lat": 60.888193,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587607521",
      "name": "Møkkeland trafostasjon",
      "lon": 16.438134,
      "lat": 68.808946,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13447791",
      "name": "Moskog trafostasjon",
      "lon": 6.016208,
      "lat": 61.44603,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/254428135",
      "name": "Namsos (Statnett) trafostasjon",
      "lon": 11.775509,
      "lat": 64.478159,
      "voltageKv": [
        420,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/400655824",
      "name": "Namsskogan koblingsstasjon",
      "lon": 13.225751,
      "lat": 64.986593,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292614",
      "name": "Narvik/Furumoen trafostasjon",
      "lon": 17.463282,
      "lat": 68.443359,
      "voltageKv": [
        132,
        33,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett;Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8527323",
      "name": "Nea trafostasjon",
      "lon": 11.687625,
      "lat": 63.029452,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8473044",
      "name": "Nedre Røssåga trafostasjon",
      "lon": 13.78186,
      "lat": 66.051575,
      "voltageKv": [
        420,
        300,
        220,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/265770276",
      "name": "Nedre Vinstra",
      "lon": 9.804179,
      "lat": 61.577739,
      "voltageKv": [
        300,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/585733410",
      "name": "Neiden trafostasjon",
      "lon": 29.349381,
      "lat": 69.70328,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
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
      "externalId": "relation/8857363",
      "name": "Nesflaten koblingsstasjon",
      "lon": 6.816601,
      "lat": 59.649633,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/589009876",
      "name": "Nesna trafostasjon",
      "lon": 13.039305,
      "lat": 66.197154,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Linea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280502",
      "name": "Nordreisa trafostasjon",
      "lon": 21.313686,
      "lat": 69.622359,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett;Vissi",
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
      "externalId": "relation/12832053",
      "name": "North Sea Link like- og vekselretterstasjon",
      "lon": 6.654636,
      "lat": 59.530133,
      "voltageKv": [
        515,
        420
      ],
      "maxVoltageKv": 515,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1467919656",
      "name": "NS13310",
      "lon": 6.431974,
      "lat": 60.622659,
      "voltageKv": [
        400,
        22
      ],
      "maxVoltageKv": 400,
      "operator": "Tendranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292143",
      "name": "Nygårdsfjellet vindpark",
      "lon": 17.872035,
      "lat": 68.504651,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10104222",
      "name": "Nyhamna trafostasjon",
      "lon": 6.945476,
      "lat": 62.842325,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Norske Shell",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1467919662",
      "name": "Nyre 2",
      "lon": 6.436019,
      "lat": 60.623447,
      "voltageKv": [
        400,
        230,
        22
      ],
      "maxVoltageKv": 400,
      "operator": "Tendranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898626",
      "name": "Ofoten trafostasjon",
      "lon": 17.558674,
      "lat": 68.158808,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/229806969",
      "name": "Ogndal trafostasjon",
      "lon": 11.621265,
      "lat": 64.027856,
      "voltageKv": [
        420,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/549449181",
      "name": "Øljusjøen koblingsstasjon",
      "lon": 8.084443,
      "lat": 61.003898,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1026999469",
      "name": "Olsborg koblingspunkt",
      "lon": 18.60155,
      "lat": 69.178342,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8283740",
      "name": "Olsborg trafostasjon",
      "lon": 18.579216,
      "lat": 69.174778,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8306512",
      "name": "Øresvik trafostasjon",
      "lon": 13.20547,
      "lat": 66.454542,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8536441",
      "name": "Orkdal transformatorstasjon",
      "lon": 9.802928,
      "lat": 63.245946,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/548709529",
      "name": "Ørskog trafostasjon",
      "lon": 6.866362,
      "lat": 62.473153,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/548473094",
      "name": "Ørsta trafostasjon",
      "lon": 6.259386,
      "lat": 62.157009,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8469203",
      "name": "Ørtfjell trafostasjon",
      "lon": 14.650567,
      "lat": 66.416011,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Mo Industripark",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7842286",
      "name": "Øvre Vinstra",
      "lon": 9.312625,
      "lat": 61.482837,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
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
      "externalId": "way/671990789",
      "name": "Raggovidda trafostasjon",
      "lon": 29.0852,
      "lat": 70.763033,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/197866182",
      "name": "Rana trafostasjon",
      "lon": 14.264279,
      "lat": 66.302608,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1158040189",
      "name": "Raudfjell trafostasjon",
      "lon": 18.217563,
      "lat": 69.573762,
      "voltageKv": [
        132,
        33
      ],
      "maxVoltageKv": 132,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/546262597",
      "name": "Refsdal koblingsstasjon",
      "lon": 6.568484,
      "lat": 61.020533,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8211981",
      "name": "Rendalen kraftverk",
      "lon": 11.121985,
      "lat": 61.813093,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Elvia",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14018338",
      "name": "Reppa trafostasjon",
      "lon": 13.562427,
      "lat": 66.644867,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "way/163116969",
      "name": "Risøyhamn trafostasjon",
      "lon": 15.634272,
      "lat": 68.966543,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
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
      "externalId": "relation/8298078",
      "name": "Rognan trafostasjon",
      "lon": 15.387523,
      "lat": 67.089596,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8857031",
      "name": "Røldal trafostasjon",
      "lon": 6.816998,
      "lat": 59.821268,
      "voltageKv": [
        300,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292228",
      "name": "Rombak omformer",
      "lon": 17.781301,
      "lat": 68.404287,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Bane NOR",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/71356608",
      "name": "Roskrepp kraftverk",
      "lon": 7.085481,
      "lat": 59.025665,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Sira-Kvina kraftselskap",
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
      "externalId": "way/1140662370",
      "name": "Salten trafostasjon",
      "lon": 15.713974,
      "lat": 67.325839,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296013",
      "name": "Salten verk",
      "lon": 15.583693,
      "lat": 67.362182,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Elkem",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/20459254",
      "name": "Samnanger trafostasjon",
      "lon": 5.841681,
      "lat": 60.398106,
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
      "externalId": "relation/8280921",
      "name": "Sandvika trafostasjon",
      "lon": 18.993895,
      "lat": 69.544126,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8860331",
      "name": "Sauda trafostasjon",
      "lon": 6.410691,
      "lat": 59.669038,
      "voltageKv": [
        420,
        300,
        66,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11036958",
      "name": "Saurdal transformatorstasjon",
      "lon": 6.670763,
      "lat": 59.484629,
      "voltageKv": [
        420,
        300,
        66,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8276522",
      "name": "Sautso (Alta kraftverk)",
      "lon": 23.802264,
      "lat": 69.719693,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1065776932",
      "name": "Sildvik koblingsstasjon",
      "lon": 17.797475,
      "lat": 68.409445,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9347309",
      "name": "Silsand trafostasjon",
      "lon": 17.94996,
      "lat": 69.249579,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10220813",
      "name": "Sima kraftverk",
      "lon": 7.143533,
      "lat": 60.499289,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587829506",
      "name": "Siso koblingsstasjon",
      "lon": 15.714889,
      "lat": 67.324238,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Siso Energi",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588985297",
      "name": "Sjona koblingsstasjon",
      "lon": 13.562041,
      "lat": 66.311216,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Linea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587922055",
      "name": "Sjønstå koblingsstasjon",
      "lon": 15.704584,
      "lat": 67.19426,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586116281",
      "name": "Skaidi trafostasjon",
      "lon": 24.542482,
      "lat": 70.433011,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13009239",
      "name": "Skibotn trafostasjon",
      "lon": 20.358682,
      "lat": 69.315218,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/672093604",
      "name": "Skillemoen koblingspunkt",
      "lon": 23.232252,
      "lat": 69.910414,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Alut",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/883151328",
      "name": "Skillemoen trafostasjon",
      "lon": 23.216576,
      "lat": 69.904699,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/968741818",
      "name": "Skjomen koblingsstasjon",
      "lon": 17.360997,
      "lat": 68.203968,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett;Statkraft",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9346333",
      "name": "Skoddevarre trafostasjon",
      "lon": 23.229494,
      "lat": 69.941276,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Alut",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1263740209",
      "name": "Skoglund trafostasjon",
      "lon": 17.584851,
      "lat": 68.576671,
      "voltageKv": [
        132,
        33
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/643494389",
      "name": "Smelror trafostasjon",
      "lon": 31.01364,
      "lat": 70.385129,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
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
      "externalId": "way/1050275156",
      "name": "Smibelg kraftverk",
      "lon": 13.338841,
      "lat": 66.459875,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/633840104",
      "name": "Snilldal trafostasjon",
      "lon": 9.60673,
      "lat": 63.400719,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
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
      "externalId": "way/469098816",
      "name": "Sogndal trafostasjon",
      "lon": 7.021204,
      "lat": 61.217861,
      "voltageKv": [
        420,
        132,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/154904137",
      "name": "Solbjørn trafostasjon",
      "lon": 13.161886,
      "lat": 68.005927,
      "voltageKv": [
        132,
        33,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Elmea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/864968263",
      "name": "Sollerud likeretterstasjon",
      "lon": 10.639633,
      "lat": 59.921374,
      "voltageKv": [
        750,
        11
      ],
      "maxVoltageKv": 750,
      "operator": "Sporveien",
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
      "externalId": "way/289304185",
      "name": "Sønnå kraftverk",
      "lon": 6.378187,
      "lat": 59.644571,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Aktieselskabet Saudefaldene",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1160239696",
      "name": "Sørfjord 1 trafostasjon",
      "lon": 16.663103,
      "lat": 68.06437,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Nordkraft Energidrift",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/842686943",
      "name": "Sørfjord vindpark",
      "lon": 16.670935,
      "lat": 68.041953,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Nordkraft Energidrift",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8285302",
      "name": "Sørreisa trafostasjon",
      "lon": 18.170462,
      "lat": 69.158647,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8289305",
      "name": "Sortland trafostasjon",
      "lon": 15.384507,
      "lat": 68.712299,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett; Vestall",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/118231876",
      "name": "Spanne trafostasjon",
      "lon": 5.334701,
      "lat": 59.379652,
      "voltageKv": [
        300,
        66,
        22,
        11
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett;Fagne",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10086891",
      "name": "Steinsland koblingsstasjon",
      "lon": 5.976383,
      "lat": 60.926527,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1156216252",
      "name": "Stokmarknes trafostasjon",
      "lon": 14.990329,
      "lat": 68.552604,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8288762",
      "name": "Stokmarknes trafostasjon",
      "lon": 14.900716,
      "lat": 68.558041,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Noranett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8847096",
      "name": "Stord trafostasjon",
      "lon": 5.412825,
      "lat": 59.78718,
      "voltageKv": [
        300,
        66,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/848422115",
      "name": "Storforshei trafostasjon",
      "lon": 14.499535,
      "lat": 66.409925,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Mo Industripark",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8283080",
      "name": "Storsteinnes trafostasjon",
      "lon": 19.24352,
      "lat": 69.210232,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587053918",
      "name": "Straumsmo kraftverk",
      "lon": 18.651629,
      "lat": 68.740703,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/222759850",
      "name": "Strinda koblingsstasjon",
      "lon": 10.449022,
      "lat": 63.394712,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8520950",
      "name": "Strinda trafostasjon",
      "lon": 10.440169,
      "lat": 63.392118,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296003",
      "name": "Sulitjelma trafostasjon",
      "lon": 16.077322,
      "lat": 67.119715,
      "voltageKv": [
        132,
        66
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8300691",
      "name": "Sundsfjord trafostasjon",
      "lon": 14.150979,
      "lat": 66.971348,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/633896066",
      "name": "Surna koblingsstasjon",
      "lon": 9.010866,
      "lat": 62.996512,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/589085618",
      "name": "Svabo trafostasjon",
      "lon": 14.177963,
      "lat": 66.305794,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Mo Industripark",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/475820066",
      "name": "Svartisen trafostasjon",
      "lon": 13.91399,
      "lat": 66.729183,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/840096758",
      "name": "Svolvær trafostasjon",
      "lon": 14.531739,
      "lat": 68.225094,
      "voltageKv": [
        132,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Elmea",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/551964031",
      "name": "Sykkylven trafostasjon",
      "lon": 6.636135,
      "lat": 62.375399,
      "voltageKv": [
        420,
        132,
        22
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett;Linja",
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
      "externalId": "relation/8274347",
      "name": "Tana Bru trafostasjon",
      "lon": 28.187718,
      "lat": 70.194326,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
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
      "externalId": "way/588074267",
      "name": "Tjønndal trafostasjon",
      "lon": 14.461369,
      "lat": 67.283959,
      "voltageKv": [
        132,
        66,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/240202234",
      "name": "Tjørhom koblingsstasjon",
      "lon": 6.815215,
      "lat": 58.879139,
      "voltageKv": [
        420
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
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
      "externalId": "relation/8890360",
      "name": "Tonstad koblingsstasjon",
      "lon": 6.724921,
      "lat": 58.657757,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8481866",
      "name": "Trofors trafostasjon",
      "lon": 13.427305,
      "lat": 65.534587,
      "voltageKv": [
        300,
        22
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8488332",
      "name": "Tunnsjødal trafostasjon",
      "lon": 12.836053,
      "lat": 64.704069,
      "voltageKv": [
        420,
        300,
        132,
        66
      ],
      "maxVoltageKv": 420,
      "operator": "Statnett",
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
      "externalId": "way/1158040166",
      "name": "Tverråsan koblingsstasjon",
      "lon": 18.155684,
      "lat": 69.568398,
      "voltageKv": [
        132
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586436581",
      "name": "Ullsfjord trafostasjon",
      "lon": 19.821434,
      "lat": 69.602986,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "way/675049925",
      "name": "Usta kraftverk",
      "lon": 8.412105,
      "lat": 60.570283,
      "voltageKv": [
        300
      ],
      "maxVoltageKv": 300,
      "operator": null,
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
      "externalId": "relation/8271838",
      "name": "Vadsø trafostasjon",
      "lon": 29.763969,
      "lat": 70.07863,
      "voltageKv": [
        132,
        66,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/290360704",
      "name": "Vågåmo trafo stasjon",
      "lon": 9.080689,
      "lat": 61.881171,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296015",
      "name": "Valljord trafostasjon",
      "lon": 15.554244,
      "lat": 67.34045,
      "voltageKv": [
        132,
        22
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/114336709",
      "name": "Vang trafostasjon",
      "lon": 11.267219,
      "lat": 60.83565,
      "voltageKv": [
        300,
        132,
        66
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/257192868",
      "name": "Varangerbotn trafostasjon",
      "lon": 28.541497,
      "lat": 70.171822,
      "voltageKv": [
        220,
        132,
        66,
        22
      ],
      "maxVoltageKv": 220,
      "operator": "Barents Nett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/290373414",
      "name": "Vardal trafostasjon",
      "lon": 10.565369,
      "lat": 60.802002,
      "voltageKv": [
        300,
        132
      ],
      "maxVoltageKv": 300,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671956023",
      "name": "Varden trafostasjon",
      "lon": 19.002544,
      "lat": 69.699735,
      "voltageKv": [
        132,
        22,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
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
      "externalId": "way/229806970",
      "name": "Verdal trafostasjon",
      "lon": 11.50391,
      "lat": 63.752875,
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
      "externalId": "way/542630292",
      "name": "Vestbyen trafostasjon",
      "lon": 14.379671,
      "lat": 67.274093,
      "voltageKv": [
        132,
        11
      ],
      "maxVoltageKv": 132,
      "operator": "Arva",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/202200066",
      "name": "Viklandet trafostasjon",
      "lon": 8.495627,
      "lat": 62.689376,
      "voltageKv": [
        420,
        132
      ],
      "maxVoltageKv": 420,
      "operator": null,
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
    },
    {
      "externalId": "way/842077312",
      "name": "Vollesfjord muffestasjon",
      "lon": 6.679918,
      "lat": 58.266496,
      "voltageKv": [
        525
      ],
      "maxVoltageKv": 525,
      "operator": "Statnett",
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/6421181679",
      "name": "Vorset",
      "lon": 9.078342,
      "lat": 59.973802,
      "voltageKv": [
        400
      ],
      "maxVoltageKv": 400,
      "operator": null,
      "sourceId": "osm:pbf-power:NO"
    }
  ],
  "branches": [
    {
      "externalId": "merged/line/line|525|Statnett|NordLink|line/0",
      "name": "NordLink",
      "category": "line",
      "fromExternalId": "way/842077312",
      "toExternalId": "relation/8890887",
      "nominalKv": 525,
      "lengthKm": 53.2,
      "operator": "Statnett",
      "path": [
        [
          6.679625,
          58.266463
        ],
        [
          6.719384,
          58.271181
        ],
        [
          6.78016,
          58.291262
        ],
        [
          6.808251,
          58.311075
        ],
        [
          6.853052,
          58.330607
        ],
        [
          6.88345,
          58.350366
        ],
        [
          6.875211,
          58.383128
        ],
        [
          6.865114,
          58.411877
        ],
        [
          6.852728,
          58.436534
        ],
        [
          6.824079,
          58.467987
        ],
        [
          6.804048,
          58.488771
        ],
        [
          6.784025,
          58.517946
        ],
        [
          6.774579,
          58.540251
        ],
        [
          6.764901,
          58.567275
        ],
        [
          6.759542,
          58.58805
        ],
        [
          6.739212,
          58.622736
        ],
        [
          6.739935,
          58.647226
        ],
        [
          6.754465,
          58.668153
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Balsfjord - Skillemoen|line/0",
      "name": "Balsfjord - Skillemoen",
      "category": "line",
      "fromExternalId": "way/572898616",
      "toExternalId": "way/883151328",
      "nominalKv": 420,
      "lengthKm": 211.96,
      "operator": "Statnett",
      "path": [
        [
          19.204276,
          69.188828
        ],
        [
          19.454942,
          69.216754
        ],
        [
          19.7381,
          69.185258
        ],
        [
          19.974362,
          69.249702
        ],
        [
          20.259266,
          69.239036
        ],
        [
          20.452643,
          69.294183
        ],
        [
          20.730182,
          69.345386
        ],
        [
          20.917196,
          69.427213
        ],
        [
          21.135873,
          69.49811
        ],
        [
          21.318259,
          69.544756
        ],
        [
          21.348329,
          69.658043
        ],
        [
          21.613997,
          69.712366
        ],
        [
          21.817705,
          69.772205
        ],
        [
          22.088415,
          69.718644
        ],
        [
          22.429801,
          69.754366
        ],
        [
          22.714351,
          69.760751
        ],
        [
          23.005795,
          69.829037
        ],
        [
          23.216686,
          69.904875
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Nedre Røssåga - Tunnsjødal|line/0",
      "name": "Nedre Røssåga - Tunnsjødal",
      "category": "line",
      "fromExternalId": "relation/8473044",
      "toExternalId": "relation/8488332",
      "nominalKv": 420,
      "lengthKm": 168.13,
      "operator": "Statnett",
      "path": [
        [
          13.785593,
          66.049293
        ],
        [
          13.761765,
          65.971451
        ],
        [
          13.732159,
          65.877257
        ],
        [
          13.61312,
          65.812179
        ],
        [
          13.463131,
          65.734593
        ],
        [
          13.427796,
          65.658613
        ],
        [
          13.419188,
          65.561512
        ],
        [
          13.441901,
          65.461662
        ],
        [
          13.385459,
          65.381988
        ],
        [
          13.366708,
          65.301918
        ],
        [
          13.383893,
          65.220954
        ],
        [
          13.399984,
          65.13543
        ],
        [
          13.354783,
          65.043452
        ],
        [
          13.229575,
          64.988056
        ],
        [
          13.217288,
          64.907424
        ],
        [
          13.115125,
          64.83072
        ],
        [
          12.987189,
          64.756679
        ],
        [
          12.838194,
          64.704949
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Holen - Rød|line/1",
      "name": "Holen - Rød",
      "category": "line",
      "fromExternalId": "relation/8182117",
      "toExternalId": "relation/18667239",
      "nominalKv": 420,
      "lengthKm": 132.16,
      "operator": "Statnett",
      "path": [
        [
          7.249483,
          59.346207
        ],
        [
          7.360521,
          59.368819
        ],
        [
          7.488795,
          59.365411
        ],
        [
          7.598763,
          59.36429
        ],
        [
          7.723389,
          59.343916
        ],
        [
          7.856228,
          59.364602
        ],
        [
          7.978868,
          59.355284
        ],
        [
          8.117856,
          59.364421
        ],
        [
          8.266791,
          59.376972
        ],
        [
          8.398145,
          59.36553
        ],
        [
          8.53355,
          59.335466
        ],
        [
          8.652592,
          59.295794
        ],
        [
          8.773844,
          59.269882
        ],
        [
          8.89906,
          59.256491
        ],
        [
          9.025116,
          59.227509
        ],
        [
          9.147576,
          59.208136
        ],
        [
          9.310071,
          59.208864
        ],
        [
          9.438176,
          59.224537
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kvilldal - Rjukan|line/0",
      "name": "Kvilldal - Rjukan",
      "category": "line",
      "fromExternalId": "relation/12832053",
      "toExternalId": "relation/7879879",
      "nominalKv": 420,
      "lengthKm": 127.01,
      "operator": "Statnett",
      "path": [
        [
          6.684334,
          59.541861
        ],
        [
          6.767329,
          59.573735
        ],
        [
          6.888815,
          59.603643
        ],
        [
          6.970226,
          59.649815
        ],
        [
          7.110879,
          59.671931
        ],
        [
          7.225903,
          59.684449
        ],
        [
          7.325059,
          59.711844
        ],
        [
          7.44276,
          59.72933
        ],
        [
          7.579901,
          59.751483
        ],
        [
          7.691157,
          59.770981
        ],
        [
          7.809249,
          59.807637
        ],
        [
          7.949856,
          59.787049
        ],
        [
          8.094067,
          59.785868
        ],
        [
          8.239961,
          59.791125
        ],
        [
          8.355073,
          59.804637
        ],
        [
          8.455573,
          59.843734
        ],
        [
          8.598615,
          59.867656
        ],
        [
          8.67883,
          59.882448
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kristiansand - Brokke|line/0",
      "name": "Kristiansand - Brokke",
      "category": "line",
      "fromExternalId": "way/244179408",
      "toExternalId": "relation/7928148",
      "nominalKv": 420,
      "lengthKm": 120.4,
      "operator": "Statnett",
      "path": [
        [
          7.510434,
          59.123066
        ],
        [
          7.595501,
          59.086604
        ],
        [
          7.648284,
          59.035783
        ],
        [
          7.705356,
          58.987844
        ],
        [
          7.801605,
          58.938347
        ],
        [
          7.867228,
          58.894469
        ],
        [
          7.964787,
          58.862092
        ],
        [
          8.032336,
          58.821306
        ],
        [
          8.08748,
          58.76326
        ],
        [
          8.084417,
          58.697053
        ],
        [
          8.128121,
          58.635285
        ],
        [
          8.159317,
          58.576656
        ],
        [
          8.182336,
          58.513403
        ],
        [
          8.18365,
          58.440507
        ],
        [
          8.152108,
          58.380486
        ],
        [
          8.080482,
          58.336586
        ],
        [
          7.962878,
          58.305518
        ],
        [
          7.901944,
          58.260034
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
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
      "externalId": "merged/line/line|420|Statnett|Kvanndal - Balsfjord|line/0",
      "name": "Kvanndal - Balsfjord",
      "category": "line",
      "fromExternalId": "way/252924745",
      "toExternalId": "way/572898616",
      "nominalKv": 420,
      "lengthKm": 103.1,
      "operator": "Statnett",
      "path": [
        [
          17.613523,
          68.577522
        ],
        [
          17.687876,
          68.623017
        ],
        [
          17.776447,
          68.657412
        ],
        [
          17.918057,
          68.673505
        ],
        [
          18.058691,
          68.694086
        ],
        [
          18.070815,
          68.734224
        ],
        [
          18.125848,
          68.785989
        ],
        [
          18.131197,
          68.844618
        ],
        [
          18.195183,
          68.889944
        ],
        [
          18.304987,
          68.93391
        ],
        [
          18.412303,
          68.970941
        ],
        [
          18.502846,
          69.011313
        ],
        [
          18.602654,
          69.037395
        ],
        [
          18.699042,
          69.077613
        ],
        [
          18.80847,
          69.111101
        ],
        [
          18.948122,
          69.12795
        ],
        [
          19.077212,
          69.149929
        ],
        [
          19.203542,
          69.189076
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Sima-Dagali|line/0",
      "name": "Sima-Dagali",
      "category": "line",
      "fromExternalId": "relation/10220813",
      "toExternalId": "relation/7847764",
      "nominalKv": 420,
      "lengthKm": 101.85,
      "operator": "Statnett",
      "path": [
        [
          7.14585,
          60.49853
        ],
        [
          7.118879,
          60.558313
        ],
        [
          7.167851,
          60.608368
        ],
        [
          7.269714,
          60.617937
        ],
        [
          7.340167,
          60.624409
        ],
        [
          7.442033,
          60.615426
        ],
        [
          7.52748,
          60.609749
        ],
        [
          7.578812,
          60.569082
        ],
        [
          7.665968,
          60.550478
        ],
        [
          7.762345,
          60.532377
        ],
        [
          7.834474,
          60.495062
        ],
        [
          7.942241,
          60.487064
        ],
        [
          8.044779,
          60.474361
        ],
        [
          8.154778,
          60.466224
        ],
        [
          8.25062,
          60.446951
        ],
        [
          8.367114,
          60.447176
        ],
        [
          8.470228,
          60.436557
        ],
        [
          8.57606,
          60.437318
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
      "externalId": "merged/line/line|420|Statnett|Viklandet - Ørskog|line/0",
      "name": "Viklandet - Ørskog",
      "category": "line",
      "fromExternalId": "way/202200066",
      "toExternalId": "way/548709529",
      "nominalKv": 420,
      "lengthKm": 99.78,
      "operator": "Statnett",
      "path": [
        [
          8.496568,
          62.688749
        ],
        [
          8.405218,
          62.706078
        ],
        [
          8.28499,
          62.710227
        ],
        [
          8.175464,
          62.698252
        ],
        [
          8.095886,
          62.668124
        ],
        [
          8.023034,
          62.633222
        ],
        [
          7.963631,
          62.58526
        ],
        [
          7.860401,
          62.569683
        ],
        [
          7.828066,
          62.528919
        ],
        [
          7.730121,
          62.524025
        ],
        [
          7.633824,
          62.499282
        ],
        [
          7.510711,
          62.495154
        ],
        [
          7.40571,
          62.499408
        ],
        [
          7.319298,
          62.502843
        ],
        [
          7.220775,
          62.502249
        ],
        [
          7.094556,
          62.484735
        ],
        [
          6.989869,
          62.467218
        ],
        [
          6.867047,
          62.473107
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Viklandet - Fræna|line/0",
      "name": "Viklandet - Fræna",
      "category": "line",
      "fromExternalId": "way/202200066",
      "toExternalId": "relation/7839089",
      "nominalKv": 420,
      "lengthKm": 93.63,
      "operator": "Statnett",
      "path": [
        [
          8.496338,
          62.689092
        ],
        [
          8.412293,
          62.702572
        ],
        [
          8.315001,
          62.714519
        ],
        [
          8.217779,
          62.698035
        ],
        [
          8.150348,
          62.727771
        ],
        [
          8.152207,
          62.774586
        ],
        [
          8.083692,
          62.795907
        ],
        [
          7.973757,
          62.785457
        ],
        [
          7.863411,
          62.779387
        ],
        [
          7.753385,
          62.791865
        ],
        [
          7.642295,
          62.809739
        ],
        [
          7.52376,
          62.807317
        ],
        [
          7.450436,
          62.837997
        ],
        [
          7.424105,
          62.871868
        ],
        [
          7.340452,
          62.905722
        ],
        [
          7.253557,
          62.90854
        ],
        [
          7.168536,
          62.885148
        ],
        [
          7.109798,
          62.85944
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
      "externalId": "merged/line/line|420|Statnett|Klæbu - Surna|line/0",
      "name": "Klæbu - Surna",
      "category": "line",
      "fromExternalId": "way/287685850",
      "toExternalId": "way/633896066",
      "nominalKv": 420,
      "lengthKm": 83.14,
      "operator": "Statnett",
      "path": [
        [
          10.420364,
          63.326871
        ],
        [
          10.341359,
          63.320081
        ],
        [
          10.237274,
          63.301928
        ],
        [
          10.141762,
          63.29627
        ],
        [
          10.035274,
          63.284175
        ],
        [
          9.956517,
          63.263684
        ],
        [
          9.845971,
          63.249344
        ],
        [
          9.756514,
          63.242294
        ],
        [
          9.686186,
          63.211456
        ],
        [
          9.623192,
          63.179072
        ],
        [
          9.56844,
          63.141247
        ],
        [
          9.500004,
          63.118314
        ],
        [
          9.41951,
          63.095082
        ],
        [
          9.336137,
          63.075685
        ],
        [
          9.257027,
          63.052797
        ],
        [
          9.171338,
          63.028594
        ],
        [
          9.087775,
          63.008542
        ],
        [
          9.011407,
          62.996211
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Namsos - Hofstad|line/0",
      "name": "Namsos - Hofstad",
      "category": "line",
      "fromExternalId": "way/254428135",
      "toExternalId": "way/613587460",
      "nominalKv": 420,
      "lengthKm": 81.78,
      "operator": "Statnett",
      "path": [
        [
          11.775473,
          64.477725
        ],
        [
          11.794918,
          64.452236
        ],
        [
          11.778897,
          64.410397
        ],
        [
          11.752222,
          64.374572
        ],
        [
          11.708202,
          64.335109
        ],
        [
          11.672199,
          64.299302
        ],
        [
          11.594331,
          64.274828
        ],
        [
          11.487746,
          64.270084
        ],
        [
          11.365861,
          64.264748
        ],
        [
          11.260796,
          64.26413
        ],
        [
          11.155846,
          64.265113
        ],
        [
          11.06588,
          64.261438
        ],
        [
          10.951969,
          64.243462
        ],
        [
          10.854519,
          64.240028
        ],
        [
          10.762278,
          64.2343
        ],
        [
          10.685073,
          64.221746
        ],
        [
          10.59096,
          64.196336
        ],
        [
          10.541277,
          64.164328
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Verdal - Klæbu|line/0",
      "name": "Verdal - Klæbu",
      "category": "line",
      "fromExternalId": "way/287685850",
      "toExternalId": "way/229806970",
      "nominalKv": 420,
      "lengthKm": 78.61,
      "operator": "Statnett",
      "path": [
        [
          10.421667,
          63.32729
        ],
        [
          10.501651,
          63.331513
        ],
        [
          10.605151,
          63.331828
        ],
        [
          10.697898,
          63.346607
        ],
        [
          10.773878,
          63.357871
        ],
        [
          10.85847,
          63.364012
        ],
        [
          10.924215,
          63.381628
        ],
        [
          10.980556,
          63.404141
        ],
        [
          11.022767,
          63.434945
        ],
        [
          11.062634,
          63.474737
        ],
        [
          11.124907,
          63.505549
        ],
        [
          11.187991,
          63.542631
        ],
        [
          11.249262,
          63.579957
        ],
        [
          11.320236,
          63.611159
        ],
        [
          11.392085,
          63.641576
        ],
        [
          11.447665,
          63.681584
        ],
        [
          11.48568,
          63.71874
        ],
        [
          11.500892,
          63.752691
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Lyse - Sauda|line/0",
      "name": "Lyse - Sauda",
      "category": "line",
      "fromExternalId": "relation/8886202",
      "toExternalId": "relation/8860331",
      "nominalKv": 420,
      "lengthKm": 78.18,
      "operator": "Statnett",
      "path": [
        [
          6.66237,
          59.059921
        ],
        [
          6.62607,
          59.094304
        ],
        [
          6.614883,
          59.138252
        ],
        [
          6.597934,
          59.18331
        ],
        [
          6.612691,
          59.219855
        ],
        [
          6.631193,
          59.260677
        ],
        [
          6.615179,
          59.305784
        ],
        [
          6.58108,
          59.345452
        ],
        [
          6.536036,
          59.384336
        ],
        [
          6.546792,
          59.42504
        ],
        [
          6.55663,
          59.465691
        ],
        [
          6.568682,
          59.514035
        ],
        [
          6.596138,
          59.552239
        ],
        [
          6.545963,
          59.577585
        ],
        [
          6.481267,
          59.582188
        ],
        [
          6.452046,
          59.609789
        ],
        [
          6.434163,
          59.642645
        ],
        [
          6.409286,
          59.669905
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Aurland 1 - Usta|line/0",
      "name": "Aurland 1 - Usta",
      "category": "line",
      "fromExternalId": "relation/3993780",
      "toExternalId": "way/296229069",
      "nominalKv": 420,
      "lengthKm": 77.81,
      "operator": "Statnett",
      "path": [
        [
          7.301331,
          60.862574
        ],
        [
          7.341064,
          60.826109
        ],
        [
          7.421104,
          60.789526
        ],
        [
          7.507699,
          60.775479
        ],
        [
          7.566611,
          60.752119
        ],
        [
          7.592781,
          60.714841
        ],
        [
          7.650854,
          60.70277
        ],
        [
          7.729177,
          60.723072
        ],
        [
          7.807733,
          60.723635
        ],
        [
          7.883731,
          60.703246
        ],
        [
          7.960104,
          60.693322
        ],
        [
          8.030088,
          60.672083
        ],
        [
          8.094274,
          60.64652
        ],
        [
          8.168128,
          60.637332
        ],
        [
          8.222961,
          60.612161
        ],
        [
          8.290944,
          60.608982
        ],
        [
          8.34711,
          60.589546
        ],
        [
          8.410761,
          60.574219
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Honna - Arendal|line/0",
      "name": "Honna - Arendal",
      "category": "line",
      "fromExternalId": "way/577998803",
      "toExternalId": "way/358915801",
      "nominalKv": 420,
      "lengthKm": 75.08,
      "operator": "Statnett",
      "path": [
        [
          7.476691,
          58.681388
        ],
        [
          7.548698,
          58.681389
        ],
        [
          7.627827,
          58.669139
        ],
        [
          7.694014,
          58.653757
        ],
        [
          7.757589,
          58.64821
        ],
        [
          7.822798,
          58.643274
        ],
        [
          7.888181,
          58.623896
        ],
        [
          7.97027,
          58.61628
        ],
        [
          8.043907,
          58.610753
        ],
        [
          8.127426,
          58.614233
        ],
        [
          8.191319,
          58.616732
        ],
        [
          8.262373,
          58.608448
        ],
        [
          8.341187,
          58.596216
        ],
        [
          8.416815,
          58.587844
        ],
        [
          8.487818,
          58.587818
        ],
        [
          8.564063,
          58.589462
        ],
        [
          8.653058,
          58.589618
        ],
        [
          8.72963,
          58.588977
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Nea - Klæbu|line/0",
      "name": "Nea - Klæbu",
      "category": "line",
      "fromExternalId": "relation/8527323",
      "toExternalId": "way/287685850",
      "nominalKv": 420,
      "lengthKm": 74.97,
      "operator": "Statnett",
      "path": [
        [
          11.687221,
          63.029117
        ],
        [
          11.608395,
          63.040717
        ],
        [
          11.531983,
          63.051335
        ],
        [
          11.449838,
          63.045064
        ],
        [
          11.374116,
          63.0641
        ],
        [
          11.293466,
          63.088256
        ],
        [
          11.216871,
          63.111373
        ],
        [
          11.155802,
          63.131447
        ],
        [
          11.072119,
          63.152521
        ],
        [
          10.989646,
          63.168724
        ],
        [
          10.914387,
          63.181053
        ],
        [
          10.839551,
          63.200506
        ],
        [
          10.763572,
          63.220773
        ],
        [
          10.667523,
          63.233882
        ],
        [
          10.580125,
          63.245599
        ],
        [
          10.504834,
          63.263188
        ],
        [
          10.458648,
          63.293762
        ],
        [
          10.421015,
          63.32708
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Arendal - Bamble|line/0",
      "name": "Arendal - Bamble",
      "category": "line",
      "fromExternalId": "way/206628449",
      "toExternalId": "way/358915801",
      "nominalKv": 420,
      "lengthKm": 72.43,
      "operator": "Statnett",
      "path": [
        [
          9.595701,
          59.0406
        ],
        [
          9.53649,
          59.022735
        ],
        [
          9.479705,
          59.005586
        ],
        [
          9.417437,
          58.990218
        ],
        [
          9.347402,
          58.968638
        ],
        [
          9.289557,
          58.938623
        ],
        [
          9.24102,
          58.909182
        ],
        [
          9.203126,
          58.877711
        ],
        [
          9.165328,
          58.848763
        ],
        [
          9.124357,
          58.81494
        ],
        [
          9.076783,
          58.785458
        ],
        [
          9.023107,
          58.75674
        ],
        [
          8.98694,
          58.720556
        ],
        [
          8.944389,
          58.689109
        ],
        [
          8.893631,
          58.655604
        ],
        [
          8.839059,
          58.62958
        ],
        [
          8.779036,
          58.609176
        ],
        [
          8.729767,
          58.588813
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kvanndal - Bardufoss|line/0",
      "name": "Kvanndal - Bardufoss",
      "category": "line",
      "fromExternalId": "way/252924745",
      "toExternalId": "way/572898618",
      "nominalKv": 420,
      "lengthKm": 71.62,
      "operator": "Statnett",
      "path": [
        [
          17.612722,
          68.577738
        ],
        [
          17.658259,
          68.608955
        ],
        [
          17.702346,
          68.642044
        ],
        [
          17.785586,
          68.659872
        ],
        [
          17.891646,
          68.670241
        ],
        [
          17.986574,
          68.682973
        ],
        [
          18.080141,
          68.702358
        ],
        [
          18.072416,
          68.730368
        ],
        [
          18.120091,
          68.765395
        ],
        [
          18.124668,
          68.806546
        ],
        [
          18.130588,
          68.847131
        ],
        [
          18.194843,
          68.878357
        ],
        [
          18.230926,
          68.912516
        ],
        [
          18.311602,
          68.93689
        ],
        [
          18.389995,
          68.964942
        ],
        [
          18.462404,
          68.991141
        ],
        [
          18.515549,
          69.02056
        ],
        [
          18.590628,
          69.033693
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Snilldal - Surna|line/0",
      "name": "Snilldal - Surna",
      "category": "line",
      "fromExternalId": "way/633840104",
      "toExternalId": "way/633896066",
      "nominalKv": 420,
      "lengthKm": 63.42,
      "operator": "Statnett",
      "path": [
        [
          9.606221,
          63.400318
        ],
        [
          9.591488,
          63.379198
        ],
        [
          9.529728,
          63.370214
        ],
        [
          9.450157,
          63.357807
        ],
        [
          9.387753,
          63.347635
        ],
        [
          9.321572,
          63.33045
        ],
        [
          9.255812,
          63.312059
        ],
        [
          9.201484,
          63.285792
        ],
        [
          9.140534,
          63.257383
        ],
        [
          9.094266,
          63.231852
        ],
        [
          9.031658,
          63.201292
        ],
        [
          9.03153,
          63.167293
        ],
        [
          9.068522,
          63.148463
        ],
        [
          9.088472,
          63.112808
        ],
        [
          9.063018,
          63.085639
        ],
        [
          9.065606,
          63.054473
        ],
        [
          9.042129,
          63.026535
        ],
        [
          9.011186,
          62.996363
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kristiansand - Arendal|line/0",
      "name": "Kristiansand - Arendal",
      "category": "line",
      "fromExternalId": "relation/7928148",
      "toExternalId": "way/358915801",
      "nominalKv": 420,
      "lengthKm": 63.39,
      "operator": "Statnett",
      "path": [
        [
          7.902599,
          58.259937
        ],
        [
          7.925713,
          58.280745
        ],
        [
          7.97491,
          58.314185
        ],
        [
          8.040359,
          58.328889
        ],
        [
          8.099733,
          58.341313
        ],
        [
          8.134775,
          58.366889
        ],
        [
          8.171385,
          58.394506
        ],
        [
          8.217009,
          58.411636
        ],
        [
          8.266313,
          58.423714
        ],
        [
          8.337486,
          58.432526
        ],
        [
          8.384092,
          58.451108
        ],
        [
          8.416412,
          58.470736
        ],
        [
          8.469166,
          58.494282
        ],
        [
          8.524519,
          58.506202
        ],
        [
          8.59339,
          58.520952
        ],
        [
          8.648378,
          58.539386
        ],
        [
          8.683764,
          58.567276
        ],
        [
          8.730042,
          58.588484
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kvinesdal - Kristiansand|line/0",
      "name": "Kvinesdal - Kristiansand",
      "category": "line",
      "fromExternalId": "relation/8894066",
      "toExternalId": "relation/7928148",
      "nominalKv": 420,
      "lengthKm": 63.25,
      "operator": "Statnett",
      "path": [
        [
          6.851464,
          58.275577
        ],
        [
          6.912353,
          58.266344
        ],
        [
          6.977714,
          58.271856
        ],
        [
          7.036027,
          58.277406
        ],
        [
          7.105087,
          58.275175
        ],
        [
          7.160519,
          58.272311
        ],
        [
          7.2212,
          58.268992
        ],
        [
          7.300866,
          58.265052
        ],
        [
          7.371971,
          58.262359
        ],
        [
          7.434452,
          58.259154
        ],
        [
          7.4997,
          58.25294
        ],
        [
          7.561434,
          58.249298
        ],
        [
          7.620354,
          58.247208
        ],
        [
          7.681825,
          58.239929
        ],
        [
          7.742296,
          58.239294
        ],
        [
          7.801918,
          58.241088
        ],
        [
          7.869786,
          58.245997
        ],
        [
          7.903253,
          58.25984
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Namsos - Tunnsjødal|line/0",
      "name": "Namsos - Tunnsjødal",
      "category": "line",
      "fromExternalId": "way/254428135",
      "toExternalId": "relation/8488332",
      "nominalKv": 420,
      "lengthKm": 60.26,
      "operator": "Statnett",
      "path": [
        [
          11.776199,
          64.477902
        ],
        [
          11.816493,
          64.503629
        ],
        [
          11.874968,
          64.515064
        ],
        [
          11.939322,
          64.529559
        ],
        [
          11.988954,
          64.54743
        ],
        [
          12.028997,
          64.556394
        ],
        [
          12.111032,
          64.562777
        ],
        [
          12.190889,
          64.558929
        ],
        [
          12.259165,
          64.55866
        ],
        [
          12.329439,
          64.567692
        ],
        [
          12.412491,
          64.583929
        ],
        [
          12.483371,
          64.607856
        ],
        [
          12.539842,
          64.629603
        ],
        [
          12.597593,
          64.642017
        ],
        [
          12.672429,
          64.656258
        ],
        [
          12.741099,
          64.670861
        ],
        [
          12.80919,
          64.686517
        ],
        [
          12.838497,
          64.705083
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Sima-Aurland 1|line/0",
      "name": "Sima-Aurland 1",
      "category": "line",
      "fromExternalId": "relation/10220813",
      "toExternalId": "relation/3993780",
      "nominalKv": 420,
      "lengthKm": 55.54,
      "operator": "Statnett",
      "path": [
        [
          7.144758,
          60.498539
        ],
        [
          7.14011,
          60.528078
        ],
        [
          7.113071,
          60.563333
        ],
        [
          7.135366,
          60.594294
        ],
        [
          7.189847,
          60.614636
        ],
        [
          7.242877,
          60.618487
        ],
        [
          7.284724,
          60.617068
        ],
        [
          7.324547,
          60.620067
        ],
        [
          7.314907,
          60.643449
        ],
        [
          7.262446,
          60.655808
        ],
        [
          7.215486,
          60.673871
        ],
        [
          7.203394,
          60.715219
        ],
        [
          7.209818,
          60.750444
        ],
        [
          7.242806,
          60.773575
        ],
        [
          7.26697,
          60.800666
        ],
        [
          7.283751,
          60.818449
        ],
        [
          7.308349,
          60.833948
        ],
        [
          7.300616,
          60.862491
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ådal - Frogner|line/0",
      "name": "Ådal - Frogner",
      "category": "line",
      "fromExternalId": "way/295444089",
      "toExternalId": "way/295444099",
      "nominalKv": 420,
      "lengthKm": 55.51,
      "operator": "Statnett",
      "path": [
        [
          10.148277,
          60.249186
        ],
        [
          10.207435,
          60.244382
        ],
        [
          10.283473,
          60.23984
        ],
        [
          10.352656,
          60.233265
        ],
        [
          10.413655,
          60.225023
        ],
        [
          10.465784,
          60.21667
        ],
        [
          10.520796,
          60.207823
        ],
        [
          10.575344,
          60.193471
        ],
        [
          10.629683,
          60.186753
        ],
        [
          10.670462,
          60.163894
        ],
        [
          10.711552,
          60.145252
        ],
        [
          10.753625,
          60.125696
        ],
        [
          10.800505,
          60.103706
        ],
        [
          10.825921,
          60.083724
        ],
        [
          10.847669,
          60.056909
        ],
        [
          10.864899,
          60.03477
        ],
        [
          10.890683,
          60.01132
        ],
        [
          10.904944,
          59.988579
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Saurdal - Lyse|line/0",
      "name": "Saurdal - Lyse",
      "category": "line",
      "fromExternalId": "relation/11036958",
      "toExternalId": "relation/8886202",
      "nominalKv": 420,
      "lengthKm": 55.48,
      "operator": "Statnett",
      "path": [
        [
          6.67028,
          59.484722
        ],
        [
          6.626574,
          59.478348
        ],
        [
          6.57138,
          59.473295
        ],
        [
          6.554968,
          59.452148
        ],
        [
          6.546553,
          59.42245
        ],
        [
          6.536436,
          59.398371
        ],
        [
          6.555482,
          59.361027
        ],
        [
          6.584212,
          59.343279
        ],
        [
          6.611487,
          59.314778
        ],
        [
          6.632007,
          59.290025
        ],
        [
          6.632041,
          59.260961
        ],
        [
          6.620154,
          59.232155
        ],
        [
          6.605642,
          59.197019
        ],
        [
          6.595587,
          59.164478
        ],
        [
          6.616301,
          59.138374
        ],
        [
          6.622631,
          59.112535
        ],
        [
          6.638701,
          59.083219
        ],
        [
          6.662666,
          59.060065
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Namsos - Ogndal|line/0",
      "name": "Namsos - Ogndal",
      "category": "line",
      "fromExternalId": "way/254428135",
      "toExternalId": "way/229806969",
      "nominalKv": 420,
      "lengthKm": 54.76,
      "operator": "Statnett",
      "path": [
        [
          11.77511,
          64.477637
        ],
        [
          11.796188,
          64.461389
        ],
        [
          11.79057,
          64.436746
        ],
        [
          11.779233,
          64.408451
        ],
        [
          11.760967,
          64.381529
        ],
        [
          11.734262,
          64.357521
        ],
        [
          11.695241,
          64.323691
        ],
        [
          11.674339,
          64.301297
        ],
        [
          11.658887,
          64.273696
        ],
        [
          11.639738,
          64.240613
        ],
        [
          11.635251,
          64.215494
        ],
        [
          11.623106,
          64.181567
        ],
        [
          11.59104,
          64.153551
        ],
        [
          11.565598,
          64.130293
        ],
        [
          11.559094,
          64.097525
        ],
        [
          11.558293,
          64.074823
        ],
        [
          11.613072,
          64.050678
        ],
        [
          11.620404,
          64.028175
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kvilldal - Holen|line/0",
      "name": "Kvilldal - Holen",
      "category": "line",
      "fromExternalId": "relation/8857439",
      "toExternalId": "relation/8182117",
      "nominalKv": 420,
      "lengthKm": 53.19,
      "operator": "Statnett",
      "path": [
        [
          6.654512,
          59.528677
        ],
        [
          6.675416,
          59.5071
        ],
        [
          6.678132,
          59.480834
        ],
        [
          6.677071,
          59.445869
        ],
        [
          6.725996,
          59.423846
        ],
        [
          6.774032,
          59.400975
        ],
        [
          6.813802,
          59.388401
        ],
        [
          6.848042,
          59.372253
        ],
        [
          6.87323,
          59.351436
        ],
        [
          6.891751,
          59.333525
        ],
        [
          6.909759,
          59.314476
        ],
        [
          6.933854,
          59.298692
        ],
        [
          6.988544,
          59.298716
        ],
        [
          7.039484,
          59.298908
        ],
        [
          7.085098,
          59.298757
        ],
        [
          7.146816,
          59.306135
        ],
        [
          7.210116,
          59.320289
        ],
        [
          7.248784,
          59.346227
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Aurland 3 - Hol 1|line/0",
      "name": "Aurland 3 - Hol 1",
      "category": "line",
      "fromExternalId": "way/37907251",
      "toExternalId": "relation/7812776",
      "nominalKv": 420,
      "lengthKm": 46.92,
      "operator": "Statnett",
      "path": [
        [
          7.565917,
          60.788087
        ],
        [
          7.577348,
          60.760596
        ],
        [
          7.578485,
          60.738255
        ],
        [
          7.59526,
          60.712186
        ],
        [
          7.623961,
          60.696589
        ],
        [
          7.676879,
          60.707532
        ],
        [
          7.718573,
          60.719614
        ],
        [
          7.766472,
          60.727471
        ],
        [
          7.814884,
          60.72292
        ],
        [
          7.862134,
          60.7116
        ],
        [
          7.9055,
          60.696712
        ],
        [
          7.95357,
          60.693501
        ],
        [
          8.001952,
          60.684154
        ],
        [
          8.035324,
          60.669789
        ],
        [
          8.075308,
          60.656307
        ],
        [
          8.11563,
          60.638466
        ],
        [
          8.168435,
          60.637667
        ],
        [
          8.182838,
          60.626089
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ertsmyra - Kvinesdal 1|line/0",
      "name": "Ertsmyra - Kvinesdal 1",
      "category": "line",
      "fromExternalId": "relation/8890887",
      "toExternalId": "relation/8894066",
      "nominalKv": 420,
      "lengthKm": 46.86,
      "operator": "Statnett",
      "path": [
        [
          6.755702,
          58.670658
        ],
        [
          6.747486,
          58.655067
        ],
        [
          6.735035,
          58.632469
        ],
        [
          6.755629,
          58.604965
        ],
        [
          6.763812,
          58.578789
        ],
        [
          6.772017,
          58.550138
        ],
        [
          6.782083,
          58.524584
        ],
        [
          6.793566,
          58.504652
        ],
        [
          6.817663,
          58.475491
        ],
        [
          6.837511,
          58.456665
        ],
        [
          6.860659,
          58.424756
        ],
        [
          6.8687,
          58.405849
        ],
        [
          6.876258,
          58.384313
        ],
        [
          6.883519,
          58.355331
        ],
        [
          6.877562,
          58.332374
        ],
        [
          6.87013,
          58.30983
        ],
        [
          6.873263,
          58.28575
        ],
        [
          6.851138,
          58.275628
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ertsmyra - Kvinesdal 2|line/0",
      "name": "Ertsmyra - Kvinesdal 2",
      "category": "line",
      "fromExternalId": "relation/8890888",
      "toExternalId": "relation/8894066",
      "nominalKv": 420,
      "lengthKm": 46.8,
      "operator": "Statnett",
      "path": [
        [
          6.752249,
          58.670599
        ],
        [
          6.745053,
          58.653944
        ],
        [
          6.735345,
          58.630109
        ],
        [
          6.74398,
          58.616506
        ],
        [
          6.760763,
          58.586297
        ],
        [
          6.766237,
          58.563807
        ],
        [
          6.776287,
          58.537498
        ],
        [
          6.783355,
          58.520054
        ],
        [
          6.801001,
          58.492965
        ],
        [
          6.821847,
          58.47077
        ],
        [
          6.850858,
          58.440546
        ],
        [
          6.863164,
          58.418776
        ],
        [
          6.87279,
          58.392763
        ],
        [
          6.880679,
          58.363935
        ],
        [
          6.877844,
          58.3348
        ],
        [
          6.871176,
          58.316557
        ],
        [
          6.872227,
          58.288344
        ],
        [
          6.849833,
          58.275835
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
      "externalId": "merged/line/line|420|Statnett|Rana - Nedre Røssåga|line/0",
      "name": "Rana - Nedre Røssåga",
      "category": "line",
      "fromExternalId": "way/197866182",
      "toExternalId": "relation/8473044",
      "nominalKv": 420,
      "lengthKm": 39.01,
      "operator": "Statnett",
      "path": [
        [
          14.266247,
          66.303089
        ],
        [
          14.262633,
          66.286854
        ],
        [
          14.259441,
          66.271946
        ],
        [
          14.242294,
          66.248545
        ],
        [
          14.221609,
          66.235582
        ],
        [
          14.186072,
          66.216683
        ],
        [
          14.174104,
          66.201101
        ],
        [
          14.14582,
          66.187548
        ],
        [
          14.103479,
          66.175646
        ],
        [
          14.054577,
          66.16574
        ],
        [
          13.988106,
          66.157147
        ],
        [
          13.9401,
          66.141591
        ],
        [
          13.936833,
          66.121082
        ],
        [
          13.926509,
          66.103293
        ],
        [
          13.915657,
          66.089304
        ],
        [
          13.875925,
          66.072188
        ],
        [
          13.83462,
          66.063856
        ],
        [
          13.785532,
          66.049476
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Sylling - Tegneby|line/1",
      "name": "Sylling - Tegneby",
      "category": "line",
      "fromExternalId": "way/128406208",
      "toExternalId": "way/29578389",
      "nominalKv": 420,
      "lengthKm": 38.86,
      "operator": "Statnett",
      "path": [
        [
          10.215381,
          59.867967
        ],
        [
          10.241288,
          59.859349
        ],
        [
          10.274216,
          59.847462
        ],
        [
          10.292972,
          59.83374
        ],
        [
          10.319843,
          59.813701
        ],
        [
          10.344639,
          59.801016
        ],
        [
          10.376213,
          59.781723
        ],
        [
          10.403363,
          59.765212
        ],
        [
          10.432043,
          59.749577
        ],
        [
          10.451386,
          59.728453
        ],
        [
          10.467622,
          59.710025
        ],
        [
          10.490684,
          59.687247
        ],
        [
          10.516293,
          59.671801
        ],
        [
          10.539806,
          59.653159
        ],
        [
          10.562133,
          59.636618
        ],
        [
          10.582801,
          59.617543
        ],
        [
          10.596578,
          59.600263
        ],
        [
          10.616898,
          59.591668
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Hofstad - Åfjord|line/0",
      "name": "Hofstad - Åfjord",
      "category": "line",
      "fromExternalId": "way/613587460",
      "toExternalId": "way/615122824",
      "nominalKv": 420,
      "lengthKm": 37.68,
      "operator": "Statnett",
      "path": [
        [
          10.541014,
          64.163989
        ],
        [
          10.521645,
          64.156964
        ],
        [
          10.493161,
          64.138571
        ],
        [
          10.460696,
          64.127431
        ],
        [
          10.462297,
          64.107105
        ],
        [
          10.450307,
          64.089612
        ],
        [
          10.436129,
          64.072034
        ],
        [
          10.41873,
          64.050439
        ],
        [
          10.398116,
          64.036509
        ],
        [
          10.359968,
          64.021147
        ],
        [
          10.332679,
          64.010145
        ],
        [
          10.289737,
          63.994139
        ],
        [
          10.270125,
          63.979192
        ],
        [
          10.262625,
          63.962773
        ],
        [
          10.280333,
          63.938944
        ],
        [
          10.269258,
          63.919161
        ],
        [
          10.253018,
          63.895504
        ],
        [
          10.223205,
          63.890955
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Aurland 1 - Sogndal|line/1",
      "name": "Aurland 1 - Sogndal",
      "category": "line",
      "fromExternalId": "relation/3993780",
      "toExternalId": "way/469098816",
      "nominalKv": 420,
      "lengthKm": 35.97,
      "operator": "Statnett",
      "path": [
        [
          7.29969,
          60.862807
        ],
        [
          7.290263,
          60.881724
        ],
        [
          7.301364,
          60.899226
        ],
        [
          7.311474,
          60.910432
        ],
        [
          7.335739,
          60.928318
        ],
        [
          7.348744,
          60.942263
        ],
        [
          7.343283,
          60.963042
        ],
        [
          7.32161,
          60.978864
        ],
        [
          7.277978,
          60.990962
        ],
        [
          7.254142,
          60.996487
        ],
        [
          7.220365,
          61.006037
        ],
        [
          7.180155,
          61.011758
        ],
        [
          7.142505,
          61.0192
        ],
        [
          7.115458,
          61.03274
        ],
        [
          7.089623,
          61.049869
        ],
        [
          7.081969,
          61.06344
        ],
        [
          7.07087,
          61.087515
        ],
        [
          7.062757,
          61.103513
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kobbvatnet - Salten|line/3",
      "name": "Kobbvatnet - Salten",
      "category": "line",
      "fromExternalId": "relation/8293948",
      "toExternalId": "way/1140662370",
      "nominalKv": 420,
      "lengthKm": 35.11,
      "operator": "Statnett",
      "path": [
        [
          15.99922,
          67.603498
        ],
        [
          16.006442,
          67.581686
        ],
        [
          15.991727,
          67.562836
        ],
        [
          15.962266,
          67.539798
        ],
        [
          15.936012,
          67.528884
        ],
        [
          15.921797,
          67.516076
        ],
        [
          15.889572,
          67.506134
        ],
        [
          15.863544,
          67.494137
        ],
        [
          15.833541,
          67.480018
        ],
        [
          15.804139,
          67.466949
        ],
        [
          15.783657,
          67.445803
        ],
        [
          15.773213,
          67.431262
        ],
        [
          15.746364,
          67.41289
        ],
        [
          15.724697,
          67.395531
        ],
        [
          15.726046,
          67.37506
        ],
        [
          15.727766,
          67.358446
        ],
        [
          15.719687,
          67.337699
        ],
        [
          15.712706,
          67.326502
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
      "externalId": "merged/line/line|420|Statnett|Ogndal - Verdal|line/0",
      "name": "Ogndal - Verdal",
      "category": "line",
      "fromExternalId": "way/229806969",
      "toExternalId": "way/229806970",
      "nominalKv": 420,
      "lengthKm": 32.11,
      "operator": "Statnett",
      "path": [
        [
          11.620111,
          64.028048
        ],
        [
          11.623369,
          64.014939
        ],
        [
          11.607903,
          63.993828
        ],
        [
          11.597544,
          63.98222
        ],
        [
          11.579875,
          63.962435
        ],
        [
          11.57157,
          63.945453
        ],
        [
          11.561088,
          63.931055
        ],
        [
          11.538928,
          63.913591
        ],
        [
          11.542101,
          63.898883
        ],
        [
          11.553648,
          63.876336
        ],
        [
          11.559253,
          63.861942
        ],
        [
          11.551027,
          63.847014
        ],
        [
          11.540851,
          63.832324
        ],
        [
          11.531519,
          63.817842
        ],
        [
          11.52358,
          63.798135
        ],
        [
          11.517644,
          63.781763
        ],
        [
          11.51098,
          63.761887
        ],
        [
          11.50126,
          63.752763
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Bardufoss - Balsfjord|line/0",
      "name": "Bardufoss - Balsfjord",
      "category": "line",
      "fromExternalId": "way/572898616",
      "toExternalId": "way/572898618",
      "nominalKv": 420,
      "lengthKm": 31.49,
      "operator": "Statnett",
      "path": [
        [
          19.202806,
          69.189325
        ],
        [
          19.171652,
          69.179037
        ],
        [
          19.137615,
          69.166052
        ],
        [
          19.085108,
          69.152169
        ],
        [
          19.046978,
          69.143374
        ],
        [
          19.01429,
          69.136392
        ],
        [
          18.973703,
          69.131449
        ],
        [
          18.933083,
          69.126497
        ],
        [
          18.884616,
          69.121121
        ],
        [
          18.834067,
          69.116078
        ],
        [
          18.800273,
          69.110019
        ],
        [
          18.758777,
          69.102581
        ],
        [
          18.714293,
          69.094534
        ],
        [
          18.69939,
          69.081019
        ],
        [
          18.69305,
          69.06517
        ],
        [
          18.656046,
          69.053658
        ],
        [
          18.619549,
          69.044181
        ],
        [
          18.591497,
          69.033514
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Fjotland - Honna|line/0",
      "name": "Fjotland - Honna",
      "category": "line",
      "fromExternalId": "way/640796702",
      "toExternalId": "way/577998803",
      "nominalKv": 420,
      "lengthKm": 30.76,
      "operator": "Statnett",
      "path": [
        [
          7.019544,
          58.767709
        ],
        [
          7.015893,
          58.756153
        ],
        [
          7.039087,
          58.743849
        ],
        [
          7.065479,
          58.731442
        ],
        [
          7.09657,
          58.725299
        ],
        [
          7.127261,
          58.725438
        ],
        [
          7.15895,
          58.72648
        ],
        [
          7.196844,
          58.727974
        ],
        [
          7.223501,
          58.729267
        ],
        [
          7.245437,
          58.728957
        ],
        [
          7.267562,
          58.726652
        ],
        [
          7.304253,
          58.720235
        ],
        [
          7.328118,
          58.716046
        ],
        [
          7.352244,
          58.712452
        ],
        [
          7.382169,
          58.704214
        ],
        [
          7.419531,
          58.696672
        ],
        [
          7.444306,
          58.690364
        ],
        [
          7.476139,
          58.681169
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Brokke - Holen|line/0",
      "name": "Brokke - Holen",
      "category": "line",
      "fromExternalId": "way/244179408",
      "toExternalId": "relation/8182117",
      "nominalKv": 420,
      "lengthKm": 30.73,
      "operator": "Statnett",
      "path": [
        [
          7.510514,
          59.12289
        ],
        [
          7.502707,
          59.13513
        ],
        [
          7.507052,
          59.153538
        ],
        [
          7.508686,
          59.16367
        ],
        [
          7.493513,
          59.17889
        ],
        [
          7.482457,
          59.194659
        ],
        [
          7.478478,
          59.209393
        ],
        [
          7.463123,
          59.223366
        ],
        [
          7.441655,
          59.23891
        ],
        [
          7.419441,
          59.250637
        ],
        [
          7.392704,
          59.265354
        ],
        [
          7.370268,
          59.277892
        ],
        [
          7.350175,
          59.291266
        ],
        [
          7.327119,
          59.305214
        ],
        [
          7.308668,
          59.320032
        ],
        [
          7.298221,
          59.327774
        ],
        [
          7.272834,
          59.336834
        ],
        [
          7.248198,
          59.345252
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
      "externalId": "merged/line/line|420|Statnett|Moskog - Høyanger|line/0",
      "name": "Moskog - Høyanger",
      "category": "line",
      "fromExternalId": "relation/13447791",
      "toExternalId": "way/547743430",
      "nominalKv": 420,
      "lengthKm": 28.04,
      "operator": "Statnett",
      "path": [
        [
          6.016029,
          61.445823
        ],
        [
          6.019253,
          61.436439
        ],
        [
          6.011303,
          61.423637
        ],
        [
          5.995552,
          61.413577
        ],
        [
          5.979052,
          61.398373
        ],
        [
          5.980269,
          61.38128
        ],
        [
          5.9833,
          61.367094
        ],
        [
          5.985864,
          61.356445
        ],
        [
          5.991293,
          61.339422
        ],
        [
          5.992133,
          61.316595
        ],
        [
          6.006778,
          61.307083
        ],
        [
          6.020411,
          61.303664
        ],
        [
          6.05455,
          61.29679
        ],
        [
          6.087434,
          61.286479
        ],
        [
          6.112795,
          61.280373
        ],
        [
          6.144683,
          61.269413
        ],
        [
          6.1517,
          61.254556
        ],
        [
          6.14955,
          61.244223
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
      "externalId": "merged/line/line|420|Statnett|Tjørhom - Ertsmyra|line/0",
      "name": "Tjørhom - Ertsmyra",
      "category": "line",
      "fromExternalId": "way/240202234",
      "toExternalId": "relation/8890888",
      "nominalKv": 420,
      "lengthKm": 27.4,
      "operator": "Statnett",
      "path": [
        [
          6.81599,
          58.878934
        ],
        [
          6.826455,
          58.870648
        ],
        [
          6.826136,
          58.860355
        ],
        [
          6.822225,
          58.843685
        ],
        [
          6.814522,
          58.826284
        ],
        [
          6.815089,
          58.813675
        ],
        [
          6.819896,
          58.797483
        ],
        [
          6.831109,
          58.780133
        ],
        [
          6.853894,
          58.767986
        ],
        [
          6.845547,
          58.75711
        ],
        [
          6.829095,
          58.748077
        ],
        [
          6.812443,
          58.737225
        ],
        [
          6.789977,
          58.72415
        ],
        [
          6.773951,
          58.717422
        ],
        [
          6.766232,
          58.705064
        ],
        [
          6.780085,
          58.684967
        ],
        [
          6.766961,
          58.681147
        ],
        [
          6.752594,
          58.670605
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Lyse - Tjørhom|line/0",
      "name": "Lyse - Tjørhom",
      "category": "line",
      "fromExternalId": "relation/8886202",
      "toExternalId": "way/240202234",
      "nominalKv": 420,
      "lengthKm": 24.36,
      "operator": "Statnett",
      "path": [
        [
          6.662763,
          59.059919
        ],
        [
          6.66419,
          59.051877
        ],
        [
          6.65524,
          59.046444
        ],
        [
          6.652505,
          59.030081
        ],
        [
          6.652637,
          59.019364
        ],
        [
          6.650519,
          59.007672
        ],
        [
          6.666571,
          58.996571
        ],
        [
          6.681664,
          58.985575
        ],
        [
          6.696301,
          58.98122
        ],
        [
          6.721722,
          58.972418
        ],
        [
          6.736611,
          58.963857
        ],
        [
          6.759553,
          58.950653
        ],
        [
          6.776459,
          58.940789
        ],
        [
          6.790476,
          58.930392
        ],
        [
          6.801833,
          58.912088
        ],
        [
          6.813068,
          58.898758
        ],
        [
          6.815616,
          58.887536
        ],
        [
          6.816005,
          58.879293
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Ertsmyra - Fjotland|line/0",
      "name": "Ertsmyra - Fjotland",
      "category": "line",
      "fromExternalId": "relation/8890888",
      "toExternalId": "way/640796702",
      "nominalKv": 420,
      "lengthKm": 19.68,
      "operator": "Statnett",
      "path": [
        [
          6.75363,
          58.670623
        ],
        [
          6.756538,
          58.678031
        ],
        [
          6.768096,
          58.680709
        ],
        [
          6.793448,
          58.683725
        ],
        [
          6.808525,
          58.685338
        ],
        [
          6.835612,
          58.68857
        ],
        [
          6.850102,
          58.691714
        ],
        [
          6.864076,
          58.701866
        ],
        [
          6.875199,
          58.708406
        ],
        [
          6.890203,
          58.71552
        ],
        [
          6.909236,
          58.719569
        ],
        [
          6.931709,
          58.731665
        ],
        [
          6.949746,
          58.738394
        ],
        [
          6.964147,
          58.74339
        ],
        [
          6.978652,
          58.750613
        ],
        [
          6.997473,
          58.757214
        ],
        [
          7.009857,
          58.763847
        ],
        [
          7.018999,
          58.767696
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
      "externalId": "merged/line/line|420|Statnett|Hylen - Sauda|line/0",
      "name": "Hylen - Sauda",
      "category": "line",
      "fromExternalId": "relation/12274653",
      "toExternalId": "relation/8860331",
      "nominalKv": 420,
      "lengthKm": 19.03,
      "operator": "Statnett",
      "path": [
        [
          6.602498,
          59.560022
        ],
        [
          6.594243,
          59.56664
        ],
        [
          6.579046,
          59.571075
        ],
        [
          6.567707,
          59.578067
        ],
        [
          6.545175,
          59.577919
        ],
        [
          6.51865,
          59.576696
        ],
        [
          6.495479,
          59.576322
        ],
        [
          6.479335,
          59.58421
        ],
        [
          6.468697,
          59.594512
        ],
        [
          6.464194,
          59.599444
        ],
        [
          6.458075,
          59.605103
        ],
        [
          6.449237,
          59.613771
        ],
        [
          6.440735,
          59.623142
        ],
        [
          6.433264,
          59.63721
        ],
        [
          6.435664,
          59.644955
        ],
        [
          6.430957,
          59.655395
        ],
        [
          6.421109,
          59.663555
        ],
        [
          6.409528,
          59.670036
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Saurdal - Hylen|line/0",
      "name": "Saurdal - Hylen",
      "category": "line",
      "fromExternalId": "relation/11036958",
      "toExternalId": "relation/12274653",
      "nominalKv": 420,
      "lengthKm": 16.53,
      "operator": "Statnett",
      "path": [
        [
          6.670026,
          59.485058
        ],
        [
          6.654536,
          59.482054
        ],
        [
          6.640004,
          59.480613
        ],
        [
          6.6186,
          59.477471
        ],
        [
          6.606221,
          59.476446
        ],
        [
          6.592577,
          59.475325
        ],
        [
          6.571324,
          59.473584
        ],
        [
          6.55786,
          59.474237
        ],
        [
          6.560545,
          59.482657
        ],
        [
          6.565914,
          59.497077
        ],
        [
          6.568947,
          59.506997
        ],
        [
          6.570184,
          59.51487
        ],
        [
          6.572809,
          59.522118
        ],
        [
          6.584029,
          59.533033
        ],
        [
          6.589073,
          59.537458
        ],
        [
          6.594275,
          59.547319
        ],
        [
          6.597722,
          59.553807
        ],
        [
          6.602498,
          59.560022
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
      "externalId": "merged/line/line|420|Statnett|Grenland - Rød|line/1",
      "name": "Grenland - Rød",
      "category": "line",
      "fromExternalId": "relation/11568632",
      "toExternalId": "relation/18667239",
      "nominalKv": 420,
      "lengthKm": 12.87,
      "operator": "Statnett",
      "path": [
        [
          9.475864,
          59.128615
        ],
        [
          9.477239,
          59.132487
        ],
        [
          9.483197,
          59.14062
        ],
        [
          9.488051,
          59.147252
        ],
        [
          9.496238,
          59.158425
        ],
        [
          9.490766,
          59.161793
        ],
        [
          9.480879,
          59.165944
        ],
        [
          9.473163,
          59.170163
        ],
        [
          9.465593,
          59.173757
        ],
        [
          9.455327,
          59.178486
        ],
        [
          9.448033,
          59.181412
        ],
        [
          9.438758,
          59.185053
        ],
        [
          9.423558,
          59.193868
        ],
        [
          9.428079,
          59.199393
        ],
        [
          9.43375,
          59.206143
        ],
        [
          9.432864,
          59.2127
        ],
        [
          9.432062,
          59.218639
        ],
        [
          9.437843,
          59.22367
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Aurland 2-Aurland 3|line/0",
      "name": "Aurland 2-Aurland 3",
      "category": "line",
      "fromExternalId": "relation/3993780",
      "toExternalId": "way/37907251",
      "nominalKv": 420,
      "lengthKm": 12.45,
      "operator": "Statnett",
      "path": [
        [
          7.363833,
          60.811218
        ],
        [
          7.370201,
          60.806943
        ],
        [
          7.383558,
          60.800233
        ],
        [
          7.39682,
          60.79546
        ],
        [
          7.404694,
          60.790979
        ],
        [
          7.416718,
          60.790175
        ],
        [
          7.43032,
          60.790856
        ],
        [
          7.443039,
          60.794812
        ],
        [
          7.459513,
          60.797471
        ],
        [
          7.465199,
          60.796827
        ],
        [
          7.478986,
          60.795275
        ],
        [
          7.491407,
          60.793871
        ],
        [
          7.502192,
          60.793785
        ],
        [
          7.513726,
          60.793699
        ],
        [
          7.523081,
          60.792416
        ],
        [
          7.536128,
          60.790851
        ],
        [
          7.550365,
          60.789432
        ],
        [
          7.565544,
          60.788263
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Sykkylven - Ørskog|line/3",
      "name": "Sykkylven - Ørskog",
      "category": "line",
      "fromExternalId": "way/551964031",
      "toExternalId": "way/548709529",
      "nominalKv": 420,
      "lengthKm": 10.02,
      "operator": "Statnett",
      "path": [
        [
          6.636006,
          62.375354
        ],
        [
          6.641804,
          62.378297
        ],
        [
          6.646466,
          62.380709
        ],
        [
          6.65293,
          62.384064
        ],
        [
          6.655955,
          62.38846
        ],
        [
          6.661529,
          62.396512
        ],
        [
          6.666094,
          62.403135
        ],
        [
          6.675718,
          62.407588
        ],
        [
          6.681533,
          62.410883
        ],
        [
          6.683191,
          62.413183
        ],
        [
          6.691006,
          62.422351
        ],
        [
          6.694182,
          62.42607
        ],
        [
          6.698495,
          62.426679
        ],
        [
          6.715844,
          62.429113
        ],
        [
          6.73132,
          62.435468
        ],
        [
          6.734657,
          62.437965
        ],
        [
          6.734034,
          62.440917
        ],
        [
          6.734604,
          62.446137
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
      "externalId": "merged/line/line|420|Statnett|Fræna - Nyhamna|line/0",
      "name": "Fræna - Nyhamna",
      "category": "line",
      "fromExternalId": "relation/7839089",
      "toExternalId": "relation/10104222",
      "nominalKv": 420,
      "lengthKm": 5.96,
      "operator": "Statnett",
      "path": [
        [
          7.110023,
          62.859095
        ],
        [
          7.108094,
          62.858814
        ],
        [
          7.102919,
          62.85762
        ],
        [
          7.095591,
          62.856675
        ],
        [
          7.088204,
          62.855713
        ],
        [
          7.074004,
          62.853863
        ],
        [
          7.066999,
          62.852957
        ],
        [
          7.06076,
          62.853041
        ],
        [
          7.052536,
          62.853151
        ],
        [
          7.04483,
          62.853257
        ],
        [
          7.040463,
          62.853137
        ],
        [
          7.036628,
          62.852633
        ],
        [
          7.029265,
          62.851663
        ],
        [
          7.017123,
          62.848025
        ],
        [
          7.013778,
          62.846407
        ],
        [
          7.009186,
          62.844173
        ],
        [
          7.004794,
          62.842044
        ],
        [
          7.004136,
          62.841719
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Kvilldal - Saurdal|line/0",
      "name": "Kvilldal - Saurdal",
      "category": "line",
      "fromExternalId": "relation/8857439",
      "toExternalId": "relation/11036958",
      "nominalKv": 420,
      "lengthKm": 5.35,
      "operator": "Statnett",
      "path": [
        [
          6.65427,
          59.528565
        ],
        [
          6.654455,
          59.528399
        ],
        [
          6.66086,
          59.525354
        ],
        [
          6.662972,
          59.523146
        ],
        [
          6.66504,
          59.520743
        ],
        [
          6.667068,
          59.518395
        ],
        [
          6.668784,
          59.515967
        ],
        [
          6.671021,
          59.512685
        ],
        [
          6.67215,
          59.511028
        ],
        [
          6.674731,
          59.507227
        ],
        [
          6.677941,
          59.502489
        ],
        [
          6.679358,
          59.500395
        ],
        [
          6.680697,
          59.498345
        ],
        [
          6.681247,
          59.497104
        ],
        [
          6.677147,
          59.490983
        ],
        [
          6.674809,
          59.488882
        ],
        [
          6.671267,
          59.486176
        ],
        [
          6.669899,
          59.485226
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|420|Statnett|Aura - Viklandet|line/0",
      "name": "Aura - Viklandet",
      "category": "line",
      "fromExternalId": "relation/7839720",
      "toExternalId": "way/202200066",
      "nominalKv": 420,
      "lengthKm": 3.37,
      "operator": "Statnett",
      "path": [
        [
          8.52237,
          62.663101
        ],
        [
          8.522277,
          62.663132
        ],
        [
          8.515369,
          62.665459
        ],
        [
          8.513288,
          62.666194
        ],
        [
          8.509987,
          62.668389
        ],
        [
          8.509318,
          62.669384
        ],
        [
          8.508318,
          62.670869
        ],
        [
          8.502608,
          62.675329
        ],
        [
          8.500366,
          62.67708
        ],
        [
          8.497893,
          62.679009
        ],
        [
          8.495275,
          62.681036
        ],
        [
          8.493636,
          62.68509
        ],
        [
          8.495203,
          62.688078
        ],
        [
          8.496683,
          62.688577
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Røykås - Fåberg|line/0",
      "name": "Røykås - Fåberg",
      "category": "line",
      "fromExternalId": "relation/8239198",
      "toExternalId": "way/297388897",
      "nominalKv": 300,
      "lengthKm": 141.73,
      "operator": "Statnett",
      "path": [
        [
          10.932479,
          59.930541
        ],
        [
          10.953868,
          59.978243
        ],
        [
          10.955322,
          60.058696
        ],
        [
          10.900318,
          60.13243
        ],
        [
          10.846589,
          60.201138
        ],
        [
          10.796507,
          60.274584
        ],
        [
          10.720913,
          60.352046
        ],
        [
          10.665496,
          60.419875
        ],
        [
          10.607995,
          60.48621
        ],
        [
          10.558604,
          60.551269
        ],
        [
          10.505722,
          60.616914
        ],
        [
          10.477679,
          60.692859
        ],
        [
          10.453955,
          60.772254
        ],
        [
          10.432425,
          60.84651
        ],
        [
          10.415251,
          60.927609
        ],
        [
          10.394045,
          61.003998
        ],
        [
          10.367446,
          61.076739
        ],
        [
          10.421789,
          61.137925
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Hemsil 2 - Sogn|line/0",
      "name": "Hemsil 2 - Sogn",
      "category": "line",
      "fromExternalId": "relation/12277754",
      "toExternalId": "relation/10308957",
      "nominalKv": 300,
      "lengthKm": 136.68,
      "operator": "Statnett",
      "path": [
        [
          8.980304,
          60.697165
        ],
        [
          9.074975,
          60.646431
        ],
        [
          9.16771,
          60.579919
        ],
        [
          9.192209,
          60.509828
        ],
        [
          9.291253,
          60.449491
        ],
        [
          9.441596,
          60.432249
        ],
        [
          9.572187,
          60.398503
        ],
        [
          9.685237,
          60.356693
        ],
        [
          9.773127,
          60.293384
        ],
        [
          9.908531,
          60.253101
        ],
        [
          10.060011,
          60.228639
        ],
        [
          10.178661,
          60.209487
        ],
        [
          10.303926,
          60.174522
        ],
        [
          10.417348,
          60.139511
        ],
        [
          10.52832,
          60.111304
        ],
        [
          10.646115,
          60.072526
        ],
        [
          10.701138,
          60.012186
        ],
        [
          10.721014,
          59.957859
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Verdal - Tunnsjødal|line/0",
      "name": "Verdal - Tunnsjødal",
      "category": "line",
      "fromExternalId": "way/229806970",
      "toExternalId": "relation/8488332",
      "nominalKv": 300,
      "lengthKm": 130.6,
      "operator": "Statnett",
      "path": [
        [
          11.504394,
          63.753116
        ],
        [
          11.609616,
          63.793657
        ],
        [
          11.729445,
          63.845003
        ],
        [
          11.820975,
          63.910766
        ],
        [
          11.90757,
          63.966066
        ],
        [
          12.043588,
          64.017789
        ],
        [
          12.166296,
          64.056971
        ],
        [
          12.292811,
          64.100668
        ],
        [
          12.376294,
          64.154952
        ],
        [
          12.394059,
          64.218321
        ],
        [
          12.419883,
          64.291063
        ],
        [
          12.424488,
          64.359226
        ],
        [
          12.518154,
          64.421485
        ],
        [
          12.582473,
          64.483981
        ],
        [
          12.676984,
          64.537452
        ],
        [
          12.791645,
          64.58999
        ],
        [
          12.823602,
          64.644654
        ],
        [
          12.83635,
          64.703716
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
      "externalId": "merged/line/line|300|Statnett|Marka - (Trofors) - Namsskogan|line/0",
      "name": "Marka - (Trofors) - Namsskogan",
      "category": "line",
      "fromExternalId": "relation/8476872",
      "toExternalId": "way/400655824",
      "nominalKv": 300,
      "lengthKm": 103.6,
      "operator": "Statnett",
      "path": [
        [
          13.291565,
          65.851941
        ],
        [
          13.372185,
          65.806934
        ],
        [
          13.4467,
          65.767562
        ],
        [
          13.428396,
          65.727531
        ],
        [
          13.427109,
          65.671059
        ],
        [
          13.426942,
          65.611324
        ],
        [
          13.415924,
          65.543811
        ],
        [
          13.439055,
          65.489792
        ],
        [
          13.435578,
          65.437935
        ],
        [
          13.391194,
          65.389138
        ],
        [
          13.390326,
          65.33365
        ],
        [
          13.358625,
          65.280669
        ],
        [
          13.375482,
          65.232941
        ],
        [
          13.385483,
          65.183363
        ],
        [
          13.390982,
          65.120644
        ],
        [
          13.36407,
          65.064301
        ],
        [
          13.324901,
          65.016012
        ],
        [
          13.226489,
          64.986823
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Ulven - (Roa) - Vardal|line/2",
      "name": "Ulven - (Roa) - Vardal",
      "category": "line",
      "fromExternalId": "way/80179519",
      "toExternalId": "way/290373414",
      "nominalKv": 300,
      "lengthKm": 103.26,
      "operator": "Statnett",
      "path": [
        [
          10.855432,
          59.935431
        ],
        [
          10.906699,
          59.97762
        ],
        [
          10.86535,
          60.034901
        ],
        [
          10.820728,
          60.089844
        ],
        [
          10.777545,
          60.145214
        ],
        [
          10.765509,
          60.207542
        ],
        [
          10.714563,
          60.257532
        ],
        [
          10.644788,
          60.300852
        ],
        [
          10.62081,
          60.345094
        ],
        [
          10.608104,
          60.393873
        ],
        [
          10.630463,
          60.44332
        ],
        [
          10.655682,
          60.497429
        ],
        [
          10.670404,
          60.550217
        ],
        [
          10.658699,
          60.603327
        ],
        [
          10.644481,
          60.65577
        ],
        [
          10.617439,
          60.701161
        ],
        [
          10.580169,
          60.749369
        ],
        [
          10.565334,
          60.802165
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Aura - Vågåmo|line/0",
      "name": "Aura - Vågåmo",
      "category": "line",
      "fromExternalId": "way/290360704",
      "toExternalId": "relation/7839720",
      "nominalKv": 300,
      "lengthKm": 97.63,
      "operator": "Statnett",
      "path": [
        [
          9.081236,
          61.881417
        ],
        [
          9.019687,
          61.907507
        ],
        [
          8.994898,
          61.968891
        ],
        [
          8.954732,
          62.023429
        ],
        [
          8.965434,
          62.071968
        ],
        [
          8.964495,
          62.128344
        ],
        [
          8.897515,
          62.162467
        ],
        [
          8.845721,
          62.206424
        ],
        [
          8.804936,
          62.25214
        ],
        [
          8.726116,
          62.29803
        ],
        [
          8.678829,
          62.350712
        ],
        [
          8.627046,
          62.394762
        ],
        [
          8.612943,
          62.443183
        ],
        [
          8.567045,
          62.488854
        ],
        [
          8.512393,
          62.528026
        ],
        [
          8.496884,
          62.569047
        ],
        [
          8.526946,
          62.613528
        ],
        [
          8.523037,
          62.663016
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Tokke - Førre|line/0",
      "name": "Tokke - Førre",
      "category": "line",
      "fromExternalId": "relation/8721337",
      "toExternalId": "relation/7883882",
      "nominalKv": 300,
      "lengthKm": 89.27,
      "operator": "Statnett",
      "path": [
        [
          6.603495,
          59.327484
        ],
        [
          6.677333,
          59.319964
        ],
        [
          6.745544,
          59.315152
        ],
        [
          6.820541,
          59.310196
        ],
        [
          6.894854,
          59.303657
        ],
        [
          6.960356,
          59.297885
        ],
        [
          7.045906,
          59.309057
        ],
        [
          7.136519,
          59.30717
        ],
        [
          7.236198,
          59.296185
        ],
        [
          7.342038,
          59.309331
        ],
        [
          7.433107,
          59.326797
        ],
        [
          7.501618,
          59.343519
        ],
        [
          7.600667,
          59.346052
        ],
        [
          7.706487,
          59.343387
        ],
        [
          7.801173,
          59.357105
        ],
        [
          7.89273,
          59.376269
        ],
        [
          7.97024,
          59.41587
        ],
        [
          8.034228,
          59.448168
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Rendalen - Balbergskaret|line/0",
      "name": "Rendalen - Balbergskaret",
      "category": "line",
      "fromExternalId": "relation/8211981",
      "toExternalId": "way/554551085",
      "nominalKv": 300,
      "lengthKm": 86.21,
      "operator": "Statnett",
      "path": [
        [
          11.121982,
          61.812756
        ],
        [
          11.042748,
          61.791365
        ],
        [
          11.013079,
          61.75555
        ],
        [
          11.002464,
          61.71717
        ],
        [
          10.95897,
          61.669269
        ],
        [
          10.942989,
          61.620449
        ],
        [
          10.934449,
          61.561925
        ],
        [
          10.920888,
          61.513235
        ],
        [
          10.905626,
          61.471848
        ],
        [
          10.886523,
          61.415461
        ],
        [
          10.842444,
          61.382659
        ],
        [
          10.792729,
          61.356307
        ],
        [
          10.741603,
          61.33037
        ],
        [
          10.670291,
          61.311553
        ],
        [
          10.599055,
          61.282861
        ],
        [
          10.525106,
          61.245796
        ],
        [
          10.49329,
          61.206752
        ],
        [
          10.448365,
          61.163884
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
      "externalId": "merged/line/line|300|Statnett|Sauda - Håvik|line/0",
      "name": "Sauda - Håvik",
      "category": "line",
      "fromExternalId": "relation/8860331",
      "toExternalId": "relation/13989591",
      "nominalKv": 300,
      "lengthKm": 76.94,
      "operator": "Statnett",
      "path": [
        [
          6.410492,
          59.66855
        ],
        [
          6.34087,
          59.661464
        ],
        [
          6.267372,
          59.639733
        ],
        [
          6.204495,
          59.617874
        ],
        [
          6.153257,
          59.608456
        ],
        [
          6.105803,
          59.585198
        ],
        [
          6.038704,
          59.571115
        ],
        [
          5.960444,
          59.549081
        ],
        [
          5.887329,
          59.547272
        ],
        [
          5.823648,
          59.535292
        ],
        [
          5.778165,
          59.501487
        ],
        [
          5.715841,
          59.477241
        ],
        [
          5.642312,
          59.44228
        ],
        [
          5.577303,
          59.409925
        ],
        [
          5.514035,
          59.377882
        ],
        [
          5.449782,
          59.353675
        ],
        [
          5.37913,
          59.322665
        ],
        [
          5.315664,
          59.317479
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Sauda - Kårstø|line/0",
      "name": "Sauda - Kårstø",
      "category": "line",
      "fromExternalId": "relation/8860331",
      "toExternalId": "relation/8864887",
      "nominalKv": 300,
      "lengthKm": 75.4,
      "operator": "Statnett",
      "path": [
        [
          6.410489,
          59.66829
        ],
        [
          6.340947,
          59.661194
        ],
        [
          6.265069,
          59.638578
        ],
        [
          6.204594,
          59.617639
        ],
        [
          6.153272,
          59.608104
        ],
        [
          6.106092,
          59.585002
        ],
        [
          6.037998,
          59.570703
        ],
        [
          5.96943,
          59.551579
        ],
        [
          5.893081,
          59.546002
        ],
        [
          5.820475,
          59.532727
        ],
        [
          5.775547,
          59.498683
        ],
        [
          5.708224,
          59.474961
        ],
        [
          5.630126,
          59.435223
        ],
        [
          5.568078,
          59.405199
        ],
        [
          5.502829,
          59.371964
        ],
        [
          5.500827,
          59.34773
        ],
        [
          5.499651,
          59.309858
        ],
        [
          5.505552,
          59.278271
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Øvre Vinstra - Fåberg|line/0",
      "name": "Øvre Vinstra - Fåberg",
      "category": "line",
      "fromExternalId": "way/297388897",
      "toExternalId": "relation/7842286",
      "nominalKv": 300,
      "lengthKm": 73.67,
      "operator": "Statnett",
      "path": [
        [
          10.420777,
          61.138389
        ],
        [
          10.387082,
          61.162674
        ],
        [
          10.354491,
          61.190824
        ],
        [
          10.320953,
          61.220967
        ],
        [
          10.263162,
          61.251502
        ],
        [
          10.188929,
          61.273435
        ],
        [
          10.130938,
          61.305134
        ],
        [
          10.056857,
          61.330794
        ],
        [
          9.994098,
          61.348979
        ],
        [
          9.914335,
          61.366523
        ],
        [
          9.848256,
          61.379644
        ],
        [
          9.770247,
          61.390478
        ],
        [
          9.690113,
          61.409893
        ],
        [
          9.627339,
          61.428897
        ],
        [
          9.565342,
          61.447353
        ],
        [
          9.482735,
          61.461903
        ],
        [
          9.384293,
          61.466821
        ],
        [
          9.312776,
          61.48318
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Fåberg - Nedre Vinstra|line/0",
      "name": "Fåberg - Nedre Vinstra",
      "category": "line",
      "fromExternalId": "way/297388897",
      "toExternalId": "way/265770276",
      "nominalKv": 300,
      "lengthKm": 60.43,
      "operator": "Statnett",
      "path": [
        [
          10.420979,
          61.138296
        ],
        [
          10.377235,
          61.169912
        ],
        [
          10.340063,
          61.204195
        ],
        [
          10.295514,
          61.232225
        ],
        [
          10.236688,
          61.253963
        ],
        [
          10.184557,
          61.278731
        ],
        [
          10.138203,
          61.310582
        ],
        [
          10.084221,
          61.334479
        ],
        [
          10.039884,
          61.354061
        ],
        [
          10.010846,
          61.376015
        ],
        [
          9.974272,
          61.396079
        ],
        [
          9.949021,
          61.420768
        ],
        [
          9.925311,
          61.447868
        ],
        [
          9.902244,
          61.474138
        ],
        [
          9.879971,
          61.498806
        ],
        [
          9.851373,
          61.524895
        ],
        [
          9.823376,
          61.548406
        ],
        [
          9.804712,
          61.577988
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Balbergskaret - Vang|line/0",
      "name": "Balbergskaret - Vang",
      "category": "line",
      "fromExternalId": "way/114336709",
      "toExternalId": "way/554551085",
      "nominalKv": 300,
      "lengthKm": 59.72,
      "operator": "Statnett",
      "path": [
        [
          11.269274,
          60.835138
        ],
        [
          11.265761,
          60.86877
        ],
        [
          11.224743,
          60.893375
        ],
        [
          11.180729,
          60.906113
        ],
        [
          11.141837,
          60.924805
        ],
        [
          11.094775,
          60.947401
        ],
        [
          11.054472,
          60.965987
        ],
        [
          11.002577,
          60.988526
        ],
        [
          10.952693,
          61.010146
        ],
        [
          10.883514,
          61.020622
        ],
        [
          10.829349,
          61.035713
        ],
        [
          10.770952,
          61.054062
        ],
        [
          10.71661,
          61.071122
        ],
        [
          10.657001,
          61.084154
        ],
        [
          10.601077,
          61.10638
        ],
        [
          10.540077,
          61.129028
        ],
        [
          10.487464,
          61.151181
        ],
        [
          10.44793,
          61.163696
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Tonstad - Fagrafjell|line/1",
      "name": "Tonstad - Fagrafjell",
      "category": "line",
      "fromExternalId": "relation/8890360",
      "toExternalId": "way/830770515",
      "nominalKv": 300,
      "lengthKm": 59.56,
      "operator": "Statnett",
      "path": [
        [
          6.689655,
          58.647497
        ],
        [
          6.623333,
          58.634842
        ],
        [
          6.570378,
          58.630863
        ],
        [
          6.521881,
          58.634937
        ],
        [
          6.466754,
          58.647139
        ],
        [
          6.413084,
          58.661439
        ],
        [
          6.35495,
          58.677971
        ],
        [
          6.31031,
          58.681797
        ],
        [
          6.257645,
          58.675558
        ],
        [
          6.222148,
          58.681478
        ],
        [
          6.170824,
          58.696461
        ],
        [
          6.098406,
          58.704281
        ],
        [
          6.024207,
          58.714056
        ],
        [
          5.96552,
          58.723829
        ],
        [
          5.904213,
          58.742215
        ],
        [
          5.855623,
          58.752824
        ],
        [
          5.798216,
          58.777976
        ],
        [
          5.761696,
          58.789867
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Vang - Minne|line/0",
      "name": "Vang - Minne",
      "category": "line",
      "fromExternalId": "way/114336709",
      "toExternalId": "way/120279477",
      "nominalKv": 300,
      "lengthKm": 54.7,
      "operator": "Statnett",
      "path": [
        [
          11.268475,
          60.835148
        ],
        [
          11.284104,
          60.812606
        ],
        [
          11.300983,
          60.791097
        ],
        [
          11.327537,
          60.761979
        ],
        [
          11.359933,
          60.73503
        ],
        [
          11.395676,
          60.71498
        ],
        [
          11.410836,
          60.684884
        ],
        [
          11.414312,
          60.6541
        ],
        [
          11.409066,
          60.633196
        ],
        [
          11.38204,
          60.606462
        ],
        [
          11.358415,
          60.579935
        ],
        [
          11.327564,
          60.555831
        ],
        [
          11.299664,
          60.525449
        ],
        [
          11.290083,
          60.497752
        ],
        [
          11.284831,
          60.465668
        ],
        [
          11.28931,
          60.436331
        ],
        [
          11.26891,
          60.409002
        ],
        [
          11.232152,
          60.387845
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
      "externalId": "merged/line/line|300|Statnett|Øvre Vinstra - Vågåmo|line/0",
      "name": "Øvre Vinstra - Vågåmo",
      "category": "line",
      "fromExternalId": "way/290360704",
      "toExternalId": "relation/7842286",
      "nominalKv": 300,
      "lengthKm": 46.89,
      "operator": "Statnett",
      "path": [
        [
          9.081822,
          61.880846
        ],
        [
          9.098702,
          61.864733
        ],
        [
          9.11243,
          61.848352
        ],
        [
          9.117601,
          61.825377
        ],
        [
          9.149256,
          61.798127
        ],
        [
          9.161428,
          61.779858
        ],
        [
          9.162276,
          61.758817
        ],
        [
          9.16676,
          61.728893
        ],
        [
          9.173031,
          61.701608
        ],
        [
          9.18012,
          61.67198
        ],
        [
          9.197724,
          61.651715
        ],
        [
          9.209123,
          61.626109
        ],
        [
          9.217983,
          61.601385
        ],
        [
          9.230906,
          61.579146
        ],
        [
          9.247334,
          61.55081
        ],
        [
          9.267933,
          61.527201
        ],
        [
          9.297223,
          61.499041
        ],
        [
          9.31233,
          61.483345
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
      "externalId": "merged/line/line|300|Statnett|Flesaker - Tegneby|line/0",
      "name": "Flesaker - Tegneby",
      "category": "line",
      "fromExternalId": "way/287115458",
      "toExternalId": "way/114414014",
      "nominalKv": 300,
      "lengthKm": 46.73,
      "operator": "Statnett",
      "path": [
        [
          9.844843,
          59.720221
        ],
        [
          9.882413,
          59.717995
        ],
        [
          9.930703,
          59.716245
        ],
        [
          9.972135,
          59.714765
        ],
        [
          10.012222,
          59.711788
        ],
        [
          10.049637,
          59.704091
        ],
        [
          10.097331,
          59.694206
        ],
        [
          10.136836,
          59.685963
        ],
        [
          10.184889,
          59.675947
        ],
        [
          10.235357,
          59.659531
        ],
        [
          10.283406,
          59.644379
        ],
        [
          10.338976,
          59.63198
        ],
        [
          10.387656,
          59.621004
        ],
        [
          10.433193,
          59.611876
        ],
        [
          10.478369,
          59.605151
        ],
        [
          10.527176,
          59.596029
        ],
        [
          10.582394,
          59.584178
        ],
        [
          10.617435,
          59.581278
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Åsen - Røldal|line/0",
      "name": "Åsen - Røldal",
      "category": "line",
      "fromExternalId": "way/638183341",
      "toExternalId": "relation/8857031",
      "nominalKv": 300,
      "lengthKm": 46.53,
      "operator": "Statnett",
      "path": [
        [
          6.629563,
          60.128785
        ],
        [
          6.63118,
          60.10543
        ],
        [
          6.65857,
          60.083429
        ],
        [
          6.674567,
          60.063696
        ],
        [
          6.65643,
          60.050382
        ],
        [
          6.608865,
          60.034768
        ],
        [
          6.580589,
          60.015281
        ],
        [
          6.586253,
          59.986629
        ],
        [
          6.585311,
          59.955932
        ],
        [
          6.570351,
          59.93077
        ],
        [
          6.595288,
          59.90979
        ],
        [
          6.628193,
          59.887319
        ],
        [
          6.665592,
          59.873039
        ],
        [
          6.693803,
          59.86077
        ],
        [
          6.721138,
          59.844522
        ],
        [
          6.745895,
          59.82472
        ],
        [
          6.778239,
          59.817827
        ],
        [
          6.816687,
          59.821597
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kvanndal - Songa|line/0",
      "name": "Kvanndal - Songa",
      "category": "line",
      "fromExternalId": "way/430780474",
      "toExternalId": "way/288812256",
      "nominalKv": 300,
      "lengthKm": 44.88,
      "operator": "Statnett",
      "path": [
        [
          6.984496,
          59.658188
        ],
        [
          7.029988,
          59.659181
        ],
        [
          7.072701,
          59.670417
        ],
        [
          7.118648,
          59.673308
        ],
        [
          7.161843,
          59.676971
        ],
        [
          7.208319,
          59.678451
        ],
        [
          7.23947,
          59.691088
        ],
        [
          7.278424,
          59.700959
        ],
        [
          7.320966,
          59.710755
        ],
        [
          7.360727,
          59.719999
        ],
        [
          7.398568,
          59.722212
        ],
        [
          7.449101,
          59.733299
        ],
        [
          7.495479,
          59.738639
        ],
        [
          7.546899,
          59.744935
        ],
        [
          7.590952,
          59.75222
        ],
        [
          7.630831,
          59.761916
        ],
        [
          7.673612,
          59.768558
        ],
        [
          7.724946,
          59.774194
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Eidum - Verdal|line/1",
      "name": "Eidum - Verdal",
      "category": "line",
      "fromExternalId": "relation/19581816",
      "toExternalId": "way/229806970",
      "nominalKv": 300,
      "lengthKm": 42.85,
      "operator": "Statnett",
      "path": [
        [
          11.006209,
          63.447871
        ],
        [
          11.019742,
          63.455866
        ],
        [
          11.055584,
          63.470801
        ],
        [
          11.08585,
          63.485889
        ],
        [
          11.113299,
          63.50154
        ],
        [
          11.150957,
          63.519644
        ],
        [
          11.187877,
          63.542094
        ],
        [
          11.216678,
          63.559624
        ],
        [
          11.254933,
          63.582949
        ],
        [
          11.286595,
          63.603251
        ],
        [
          11.343629,
          63.616153
        ],
        [
          11.377038,
          63.630156
        ],
        [
          11.405134,
          63.650465
        ],
        [
          11.439434,
          63.675141
        ],
        [
          11.465651,
          63.695087
        ],
        [
          11.482632,
          63.715837
        ],
        [
          11.49874,
          63.73778
        ],
        [
          11.501669,
          63.751636
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Blåfalli - Mauranger|line/0",
      "name": "Blåfalli - Mauranger",
      "category": "line",
      "fromExternalId": "relation/7805329",
      "toExternalId": "way/432965765",
      "nominalKv": 300,
      "lengthKm": 42.32,
      "operator": "Statnett",
      "path": [
        [
          6.329488,
          60.132039
        ],
        [
          6.294587,
          60.122085
        ],
        [
          6.262647,
          60.116166
        ],
        [
          6.237187,
          60.11476
        ],
        [
          6.194696,
          60.102366
        ],
        [
          6.158588,
          60.093094
        ],
        [
          6.121987,
          60.083952
        ],
        [
          6.070086,
          60.073855
        ],
        [
          6.034251,
          60.061248
        ],
        [
          6.018518,
          60.031096
        ],
        [
          6.010369,
          60.010207
        ],
        [
          6.017005,
          59.990316
        ],
        [
          6.009908,
          59.973727
        ],
        [
          6.001641,
          59.9493
        ],
        [
          6.00774,
          59.926388
        ],
        [
          6.011935,
          59.900763
        ],
        [
          6.028962,
          59.879172
        ],
        [
          6.009815,
          59.863687
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Øljusjøen - Hemsil 1|line/0",
      "name": "Øljusjøen - Hemsil 1",
      "category": "line",
      "fromExternalId": "way/549449181",
      "toExternalId": "way/549449182",
      "nominalKv": 300,
      "lengthKm": 41.28,
      "operator": "Statnett",
      "path": [
        [
          8.084736,
          61.004038
        ],
        [
          8.100153,
          60.983705
        ],
        [
          8.116155,
          60.96852
        ],
        [
          8.14419,
          60.951183
        ],
        [
          8.175116,
          60.936015
        ],
        [
          8.212806,
          60.914386
        ],
        [
          8.243802,
          60.894618
        ],
        [
          8.270956,
          60.873791
        ],
        [
          8.301866,
          60.863769
        ],
        [
          8.340071,
          60.850035
        ],
        [
          8.37722,
          60.840337
        ],
        [
          8.417751,
          60.824433
        ],
        [
          8.454806,
          60.808799
        ],
        [
          8.4927,
          60.810408
        ],
        [
          8.542085,
          60.817042
        ],
        [
          8.580612,
          60.810314
        ],
        [
          8.610969,
          60.804516
        ],
        [
          8.640792,
          60.807746
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Stord - Spanne|line/0",
      "name": "Stord - Spanne",
      "category": "line",
      "fromExternalId": "way/118231876",
      "toExternalId": "relation/8847096",
      "nominalKv": 300,
      "lengthKm": 39.87,
      "operator": "Statnett",
      "path": [
        [
          5.33384,
          59.379155
        ],
        [
          5.346257,
          59.397155
        ],
        [
          5.356264,
          59.418361
        ],
        [
          5.365549,
          59.435588
        ],
        [
          5.373988,
          59.454366
        ],
        [
          5.39654,
          59.469788
        ],
        [
          5.412073,
          59.48753
        ],
        [
          5.412529,
          59.506058
        ],
        [
          5.42171,
          59.530314
        ],
        [
          5.435277,
          59.547741
        ],
        [
          5.459716,
          59.565975
        ],
        [
          5.488313,
          59.589289
        ],
        [
          5.497529,
          59.607489
        ],
        [
          5.506944,
          59.630649
        ],
        [
          5.513261,
          59.65066
        ],
        [
          5.502874,
          59.677385
        ],
        [
          5.499348,
          59.695845
        ],
        [
          5.485818,
          59.712086
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Vardal - Fåberg|line/0",
      "name": "Vardal - Fåberg",
      "category": "line",
      "fromExternalId": "way/290373414",
      "toExternalId": "way/297388897",
      "nominalKv": 300,
      "lengthKm": 39.37,
      "operator": "Statnett",
      "path": [
        [
          10.565334,
          60.802165
        ],
        [
          10.56314,
          60.819505
        ],
        [
          10.55306,
          60.839605
        ],
        [
          10.542437,
          60.860232
        ],
        [
          10.531534,
          60.881336
        ],
        [
          10.521975,
          60.899862
        ],
        [
          10.511363,
          60.920492
        ],
        [
          10.500742,
          60.938734
        ],
        [
          10.481771,
          60.954691
        ],
        [
          10.459395,
          60.973479
        ],
        [
          10.438342,
          60.991131
        ],
        [
          10.415361,
          61.012686
        ],
        [
          10.408942,
          61.033269
        ],
        [
          10.403822,
          61.05544
        ],
        [
          10.401488,
          61.077301
        ],
        [
          10.399941,
          61.098843
        ],
        [
          10.403886,
          61.116602
        ],
        [
          10.421384,
          61.138111
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Refsdal-Modalen|line/0",
      "name": "Refsdal-Modalen",
      "category": "line",
      "fromExternalId": "relation/7802012",
      "toExternalId": "way/546262597",
      "nominalKv": 300,
      "lengthKm": 38.82,
      "operator": "Statnett",
      "path": [
        [
          6.012461,
          60.888373
        ],
        [
          6.057849,
          60.884897
        ],
        [
          6.09635,
          60.895576
        ],
        [
          6.124341,
          60.901175
        ],
        [
          6.15052,
          60.895127
        ],
        [
          6.193253,
          60.876721
        ],
        [
          6.224688,
          60.878841
        ],
        [
          6.259975,
          60.880558
        ],
        [
          6.289727,
          60.889772
        ],
        [
          6.329938,
          60.905667
        ],
        [
          6.369399,
          60.920031
        ],
        [
          6.399032,
          60.925579
        ],
        [
          6.420844,
          60.940439
        ],
        [
          6.45008,
          60.955934
        ],
        [
          6.475689,
          60.970228
        ],
        [
          6.499271,
          60.98755
        ],
        [
          6.543099,
          61.000535
        ],
        [
          6.568974,
          61.020912
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Namskogan - Tunnsjødal|line/0",
      "name": "Namskogan - Tunnsjødal",
      "category": "line",
      "fromExternalId": "relation/8488332",
      "toExternalId": "way/400655824",
      "nominalKv": 300,
      "lengthKm": 38.49,
      "operator": "Statnett",
      "path": [
        [
          12.837285,
          64.704128
        ],
        [
          12.861541,
          64.712518
        ],
        [
          12.897501,
          64.725943
        ],
        [
          12.941385,
          64.74211
        ],
        [
          12.975586,
          64.752747
        ],
        [
          13.015553,
          64.765093
        ],
        [
          13.049837,
          64.778532
        ],
        [
          13.078419,
          64.800076
        ],
        [
          13.102291,
          64.818557
        ],
        [
          13.123577,
          64.837728
        ],
        [
          13.145426,
          64.857392
        ],
        [
          13.171807,
          64.878067
        ],
        [
          13.196751,
          64.89389
        ],
        [
          13.222407,
          64.910206
        ],
        [
          13.228891,
          64.928967
        ],
        [
          13.231552,
          64.951057
        ],
        [
          13.228867,
          64.969869
        ],
        [
          13.226171,
          64.986812
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Marka - Nedre Røssåga|line/0",
      "name": "Marka - Nedre Røssåga",
      "category": "line",
      "fromExternalId": "relation/8473044",
      "toExternalId": "relation/8476872",
      "nominalKv": 300,
      "lengthKm": 37.16,
      "operator": "Statnett",
      "path": [
        [
          13.782638,
          66.050655
        ],
        [
          13.748435,
          66.049176
        ],
        [
          13.698873,
          66.045387
        ],
        [
          13.660904,
          66.031227
        ],
        [
          13.624927,
          66.017759
        ],
        [
          13.571398,
          66.007627
        ],
        [
          13.545078,
          66.012513
        ],
        [
          13.508624,
          66.004535
        ],
        [
          13.488164,
          65.992534
        ],
        [
          13.455092,
          65.979464
        ],
        [
          13.446437,
          65.963649
        ],
        [
          13.446501,
          65.940448
        ],
        [
          13.446555,
          65.918463
        ],
        [
          13.448355,
          65.900806
        ],
        [
          13.438492,
          65.881896
        ],
        [
          13.393866,
          65.87452
        ],
        [
          13.325968,
          65.863288
        ],
        [
          13.29127,
          65.851894
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Evanger-Samnanger|line/0",
      "name": "Evanger-Samnanger",
      "category": "line",
      "fromExternalId": "way/307323708",
      "toExternalId": "relation/20459254",
      "nominalKv": 300,
      "lengthKm": 37.08,
      "operator": "Statnett",
      "path": [
        [
          6.111125,
          60.656701
        ],
        [
          6.071821,
          60.645669
        ],
        [
          6.039546,
          60.63114
        ],
        [
          6.005784,
          60.618298
        ],
        [
          5.966068,
          60.604605
        ],
        [
          5.922712,
          60.588576
        ],
        [
          5.899319,
          60.564312
        ],
        [
          5.876729,
          60.549053
        ],
        [
          5.859119,
          60.535962
        ],
        [
          5.859649,
          60.524605
        ],
        [
          5.871229,
          60.511531
        ],
        [
          5.884804,
          60.497433
        ],
        [
          5.890715,
          60.485813
        ],
        [
          5.888951,
          60.462878
        ],
        [
          5.886387,
          60.442249
        ],
        [
          5.888433,
          60.423912
        ],
        [
          5.873716,
          60.411924
        ],
        [
          5.841005,
          60.398009
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Usta - Hemsil 2|line/0",
      "name": "Usta - Hemsil 2",
      "category": "line",
      "fromExternalId": "way/296229069",
      "toExternalId": "relation/12277754",
      "nominalKv": 300,
      "lengthKm": 34.89,
      "operator": "Statnett",
      "path": [
        [
          8.413007,
          60.574564
        ],
        [
          8.45354,
          60.574902
        ],
        [
          8.485477,
          60.584202
        ],
        [
          8.505381,
          60.593702
        ],
        [
          8.534334,
          60.606003
        ],
        [
          8.564969,
          60.615186
        ],
        [
          8.59692,
          60.622947
        ],
        [
          8.63181,
          60.622955
        ],
        [
          8.666518,
          60.622745
        ],
        [
          8.694338,
          60.626131
        ],
        [
          8.72441,
          60.633322
        ],
        [
          8.756447,
          60.642375
        ],
        [
          8.78748,
          60.653241
        ],
        [
          8.821185,
          60.665022
        ],
        [
          8.864256,
          60.676576
        ],
        [
          8.905326,
          60.682326
        ],
        [
          8.947474,
          60.69068
        ],
        [
          8.980304,
          60.697165
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kolsvik - Namsskogan|line/0",
      "name": "Kolsvik - Namsskogan",
      "category": "line",
      "fromExternalId": "relation/8482013",
      "toExternalId": "way/400655824",
      "nominalKv": 300,
      "lengthKm": 34.54,
      "operator": "Statnett",
      "path": [
        [
          12.792087,
          65.204589
        ],
        [
          12.802952,
          65.187986
        ],
        [
          12.848373,
          65.174373
        ],
        [
          12.893148,
          65.16922
        ],
        [
          12.943718,
          65.164797
        ],
        [
          12.972645,
          65.15971
        ],
        [
          12.979974,
          65.146241
        ],
        [
          12.977407,
          65.131622
        ],
        [
          12.992079,
          65.113573
        ],
        [
          13.013888,
          65.103489
        ],
        [
          13.048793,
          65.090215
        ],
        [
          13.075478,
          65.080045
        ],
        [
          13.101253,
          65.067789
        ],
        [
          13.130989,
          65.051912
        ],
        [
          13.154693,
          65.037562
        ],
        [
          13.179136,
          65.019663
        ],
        [
          13.208113,
          65.001723
        ],
        [
          13.225853,
          64.986801
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Åna-Sira - Kjelland|line/0",
      "name": "Åna-Sira - Kjelland",
      "category": "line",
      "fromExternalId": "relation/10175479",
      "toExternalId": "relation/8332571",
      "nominalKv": 300,
      "lengthKm": 33.95,
      "operator": "Statnett",
      "path": [
        [
          6.454143,
          58.294984
        ],
        [
          6.438594,
          58.306361
        ],
        [
          6.405161,
          58.317017
        ],
        [
          6.377217,
          58.33536
        ],
        [
          6.359756,
          58.347422
        ],
        [
          6.337245,
          58.363086
        ],
        [
          6.305275,
          58.376511
        ],
        [
          6.2797,
          58.384646
        ],
        [
          6.246163,
          58.397115
        ],
        [
          6.229748,
          58.403681
        ],
        [
          6.197852,
          58.417163
        ],
        [
          6.174561,
          58.429793
        ],
        [
          6.140236,
          58.445437
        ],
        [
          6.120865,
          58.458512
        ],
        [
          6.088349,
          58.469855
        ],
        [
          6.059078,
          58.480039
        ],
        [
          6.043172,
          58.491438
        ],
        [
          6.032357,
          58.495349
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Klæbu - Orkdal|line/0",
      "name": "Klæbu - Orkdal",
      "category": "line",
      "fromExternalId": "way/287685850",
      "toExternalId": "relation/8536441",
      "nominalKv": 300,
      "lengthKm": 32.97,
      "operator": "Statnett",
      "path": [
        [
          10.417607,
          63.326141
        ],
        [
          10.40197,
          63.318367
        ],
        [
          10.355237,
          63.309153
        ],
        [
          10.324065,
          63.304469
        ],
        [
          10.284259,
          63.298474
        ],
        [
          10.24308,
          63.291697
        ],
        [
          10.21095,
          63.286891
        ],
        [
          10.172506,
          63.281556
        ],
        [
          10.124746,
          63.271137
        ],
        [
          10.089845,
          63.263773
        ],
        [
          10.056776,
          63.257636
        ],
        [
          10.020162,
          63.253544
        ],
        [
          9.966415,
          63.251447
        ],
        [
          9.92755,
          63.25163
        ],
        [
          9.884507,
          63.249862
        ],
        [
          9.861603,
          63.247389
        ],
        [
          9.818529,
          63.247084
        ],
        [
          9.80174,
          63.24654
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
      "externalId": "merged/line/line|300|Statnett|Fana - Samnanger|line/0",
      "name": "Fana - Samnanger",
      "category": "line",
      "fromExternalId": "relation/20459254",
      "toExternalId": "relation/8836351",
      "nominalKv": 300,
      "lengthKm": 32.87,
      "operator": "Statnett",
      "path": [
        [
          5.840619,
          60.397428
        ],
        [
          5.83169,
          60.380957
        ],
        [
          5.794709,
          60.364876
        ],
        [
          5.771241,
          60.361632
        ],
        [
          5.741333,
          60.357496
        ],
        [
          5.711463,
          60.354259
        ],
        [
          5.640782,
          60.355015
        ],
        [
          5.613639,
          60.350177
        ],
        [
          5.590491,
          60.345859
        ],
        [
          5.553205,
          60.337902
        ],
        [
          5.518787,
          60.328089
        ],
        [
          5.488808,
          60.326735
        ],
        [
          5.455574,
          60.325221
        ],
        [
          5.415082,
          60.3198
        ],
        [
          5.396606,
          60.304815
        ],
        [
          5.375078,
          60.295912
        ],
        [
          5.361984,
          60.288398
        ],
        [
          5.340426,
          60.28659
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
      "externalId": "merged/line/line|300|Statnett|Lyse - Førre|line/0",
      "name": "Lyse - Førre",
      "category": "line",
      "fromExternalId": "relation/8886202",
      "toExternalId": "relation/8721337",
      "nominalKv": 300,
      "lengthKm": 31.82,
      "operator": "Statnett",
      "path": [
        [
          6.665543,
          59.061096
        ],
        [
          6.645567,
          59.07717
        ],
        [
          6.637806,
          59.090025
        ],
        [
          6.622876,
          59.108669
        ],
        [
          6.625614,
          59.126784
        ],
        [
          6.608059,
          59.143192
        ],
        [
          6.597078,
          59.157399
        ],
        [
          6.597517,
          59.176171
        ],
        [
          6.605474,
          59.191713
        ],
        [
          6.613315,
          59.209837
        ],
        [
          6.61528,
          59.222267
        ],
        [
          6.627119,
          59.241241
        ],
        [
          6.631341,
          59.251925
        ],
        [
          6.638646,
          59.269289
        ],
        [
          6.641365,
          59.279049
        ],
        [
          6.625949,
          59.298555
        ],
        [
          6.615701,
          59.314771
        ],
        [
          6.603015,
          59.327397
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Dale - Arna|line/0",
      "name": "Dale - Arna",
      "category": "line",
      "fromExternalId": "way/114669733",
      "toExternalId": "relation/8834935",
      "nominalKv": 300,
      "lengthKm": 31.52,
      "operator": "Statnett",
      "path": [
        [
          5.809787,
          60.581192
        ],
        [
          5.79425,
          60.577459
        ],
        [
          5.734388,
          60.563407
        ],
        [
          5.684119,
          60.559518
        ],
        [
          5.657935,
          60.547483
        ],
        [
          5.641531,
          60.532682
        ],
        [
          5.63597,
          60.515134
        ],
        [
          5.62292,
          60.499052
        ],
        [
          5.612127,
          60.486359
        ],
        [
          5.599836,
          60.474142
        ],
        [
          5.589217,
          60.466231
        ],
        [
          5.577216,
          60.457288
        ],
        [
          5.566053,
          60.44631
        ],
        [
          5.55103,
          60.439002
        ],
        [
          5.520777,
          60.414721
        ],
        [
          5.503566,
          60.410364
        ],
        [
          5.480839,
          60.399701
        ],
        [
          5.456338,
          60.394093
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Eidum - Strinda|line/0",
      "name": "Eidum - Strinda",
      "category": "line",
      "fromExternalId": "way/222759850",
      "toExternalId": "relation/19581816",
      "nominalKv": 300,
      "lengthKm": 29.85,
      "operator": "Statnett",
      "path": [
        [
          10.448502,
          63.395025
        ],
        [
          10.476195,
          63.394632
        ],
        [
          10.505887,
          63.398384
        ],
        [
          10.548973,
          63.40265
        ],
        [
          10.590185,
          63.40036
        ],
        [
          10.620224,
          63.398966
        ],
        [
          10.654263,
          63.397546
        ],
        [
          10.693042,
          63.393736
        ],
        [
          10.726712,
          63.392331
        ],
        [
          10.770113,
          63.392477
        ],
        [
          10.800537,
          63.392576
        ],
        [
          10.828339,
          63.394552
        ],
        [
          10.853815,
          63.403021
        ],
        [
          10.879565,
          63.411502
        ],
        [
          10.909252,
          63.42027
        ],
        [
          10.954457,
          63.433256
        ],
        [
          10.987857,
          63.442832
        ],
        [
          11.006209,
          63.447871
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Steinsland - Haugsvær|line/0",
      "name": "Steinsland - Haugsvær",
      "category": "line",
      "fromExternalId": "relation/10086891",
      "toExternalId": "way/648848845",
      "nominalKv": 300,
      "lengthKm": 28.53,
      "operator": "Statnett",
      "path": [
        [
          5.976367,
          60.926369
        ],
        [
          5.949676,
          60.924381
        ],
        [
          5.929213,
          60.926798
        ],
        [
          5.918193,
          60.92624
        ],
        [
          5.896853,
          60.924818
        ],
        [
          5.864012,
          60.927184
        ],
        [
          5.839636,
          60.919945
        ],
        [
          5.823567,
          60.90856
        ],
        [
          5.810027,
          60.893451
        ],
        [
          5.799027,
          60.884659
        ],
        [
          5.759955,
          60.880112
        ],
        [
          5.718266,
          60.879137
        ],
        [
          5.681131,
          60.883994
        ],
        [
          5.644862,
          60.882742
        ],
        [
          5.619469,
          60.889206
        ],
        [
          5.595337,
          60.886943
        ],
        [
          5.545073,
          60.885633
        ],
        [
          5.527324,
          60.889965
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
      "externalId": "merged/line/line|300|Statnett|Modalen-Evanger|line/0",
      "name": "Modalen-Evanger",
      "category": "line",
      "fromExternalId": "relation/7802012",
      "toExternalId": "way/307323708",
      "nominalKv": 300,
      "lengthKm": 27.43,
      "operator": "Statnett",
      "path": [
        [
          6.01233,
          60.888117
        ],
        [
          6.00008,
          60.877034
        ],
        [
          6.002784,
          60.860911
        ],
        [
          6.022192,
          60.84207
        ],
        [
          6.027406,
          60.833757
        ],
        [
          6.03084,
          60.828507
        ],
        [
          6.041778,
          60.813717
        ],
        [
          6.055285,
          60.795646
        ],
        [
          6.056911,
          60.771358
        ],
        [
          6.055698,
          60.757692
        ],
        [
          6.05543,
          60.754463
        ],
        [
          6.05484,
          60.743302
        ],
        [
          6.072071,
          60.733149
        ],
        [
          6.081544,
          60.727584
        ],
        [
          6.098716,
          60.704375
        ],
        [
          6.113334,
          60.679909
        ],
        [
          6.113737,
          60.667966
        ],
        [
          6.111941,
          60.656858
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Nesflaten - Sauda|line/0",
      "name": "Nesflaten - Sauda",
      "category": "line",
      "fromExternalId": "relation/8857363",
      "toExternalId": "relation/8860331",
      "nominalKv": 300,
      "lengthKm": 24.9,
      "operator": "Statnett",
      "path": [
        [
          6.815779,
          59.649994
        ],
        [
          6.80239,
          59.654733
        ],
        [
          6.777108,
          59.660031
        ],
        [
          6.758319,
          59.664319
        ],
        [
          6.736896,
          59.670672
        ],
        [
          6.716532,
          59.678635
        ],
        [
          6.69058,
          59.687286
        ],
        [
          6.668745,
          59.690185
        ],
        [
          6.642977,
          59.690969
        ],
        [
          6.612985,
          59.691898
        ],
        [
          6.581103,
          59.692784
        ],
        [
          6.554875,
          59.694055
        ],
        [
          6.531664,
          59.695662
        ],
        [
          6.491553,
          59.694808
        ],
        [
          6.473919,
          59.688224
        ],
        [
          6.453874,
          59.681721
        ],
        [
          6.429731,
          59.674853
        ],
        [
          6.413329,
          59.669271
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Bjerkreim - Fagrafjell|line/0",
      "name": "Bjerkreim - Fagrafjell",
      "category": "line",
      "fromExternalId": "way/799370310",
      "toExternalId": "way/830770515",
      "nominalKv": 300,
      "lengthKm": 24.88,
      "operator": "Statnett",
      "path": [
        [
          5.919156,
          58.589845
        ],
        [
          5.914035,
          58.597413
        ],
        [
          5.898027,
          58.610179
        ],
        [
          5.878372,
          58.623392
        ],
        [
          5.863859,
          58.633141
        ],
        [
          5.845111,
          58.645723
        ],
        [
          5.824707,
          58.659397
        ],
        [
          5.812101,
          58.673856
        ],
        [
          5.798609,
          58.689325
        ],
        [
          5.788684,
          58.705701
        ],
        [
          5.777954,
          58.721661
        ],
        [
          5.782513,
          58.733441
        ],
        [
          5.783076,
          58.741651
        ],
        [
          5.782917,
          58.750482
        ],
        [
          5.780807,
          58.758969
        ],
        [
          5.768636,
          58.772248
        ],
        [
          5.763595,
          58.785378
        ],
        [
          5.76151,
          58.789715
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kvinesdal - Åna-Sira|line/0",
      "name": "Kvinesdal - Åna-Sira",
      "category": "line",
      "fromExternalId": "relation/8894066",
      "toExternalId": "relation/10175479",
      "nominalKv": 300,
      "lengthKm": 24.47,
      "operator": "Statnett",
      "path": [
        [
          6.846572,
          58.27635
        ],
        [
          6.832359,
          58.281315
        ],
        [
          6.799978,
          58.283817
        ],
        [
          6.785462,
          58.282404
        ],
        [
          6.750458,
          58.275519
        ],
        [
          6.719723,
          58.2709
        ],
        [
          6.698771,
          58.268226
        ],
        [
          6.676854,
          58.265704
        ],
        [
          6.643369,
          58.260934
        ],
        [
          6.629555,
          58.264063
        ],
        [
          6.597096,
          58.271475
        ],
        [
          6.572556,
          58.276222
        ],
        [
          6.544658,
          58.278559
        ],
        [
          6.519915,
          58.280582
        ],
        [
          6.495229,
          58.282607
        ],
        [
          6.473579,
          58.290227
        ],
        [
          6.459781,
          58.292962
        ],
        [
          6.453918,
          58.29493
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Leirdøla - Fortun|line/3",
      "name": "Leirdøla - Fortun",
      "category": "line",
      "fromExternalId": "relation/7814748",
      "toExternalId": "relation/8679746",
      "nominalKv": 300,
      "lengthKm": 24.43,
      "operator": "Statnett",
      "path": [
        [
          7.247752,
          61.419335
        ],
        [
          7.273303,
          61.417882
        ],
        [
          7.297904,
          61.418243
        ],
        [
          7.324539,
          61.416593
        ],
        [
          7.353957,
          61.419131
        ],
        [
          7.368114,
          61.428168
        ],
        [
          7.383896,
          61.434274
        ],
        [
          7.40913,
          61.443809
        ],
        [
          7.430996,
          61.454562
        ],
        [
          7.444278,
          61.46586
        ],
        [
          7.457405,
          61.479223
        ],
        [
          7.467254,
          61.492641
        ],
        [
          7.475488,
          61.503874
        ],
        [
          7.482215,
          61.51303
        ],
        [
          7.499607,
          61.521334
        ],
        [
          7.519916,
          61.524332
        ],
        [
          7.552275,
          61.529074
        ],
        [
          7.579236,
          61.533024
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Sauda - Blåfalli|line/0",
      "name": "Sauda - Blåfalli",
      "category": "line",
      "fromExternalId": "relation/8860331",
      "toExternalId": "way/440170580",
      "nominalKv": 300,
      "lengthKm": 23.56,
      "operator": "Statnett",
      "path": [
        [
          6.410495,
          59.668811
        ],
        [
          6.390297,
          59.669875
        ],
        [
          6.366989,
          59.66528
        ],
        [
          6.340703,
          59.661705
        ],
        [
          6.308728,
          59.658535
        ],
        [
          6.293437,
          59.65994
        ],
        [
          6.270805,
          59.666117
        ],
        [
          6.255205,
          59.676427
        ],
        [
          6.241913,
          59.687037
        ],
        [
          6.232227,
          59.700553
        ],
        [
          6.221928,
          59.709894
        ],
        [
          6.189396,
          59.719789
        ],
        [
          6.179733,
          59.730182
        ],
        [
          6.176927,
          59.747083
        ],
        [
          6.175395,
          59.757566
        ],
        [
          6.169918,
          59.766787
        ],
        [
          6.158761,
          59.774826
        ],
        [
          6.147843,
          59.778949
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kvinesdal - Lista 1|line/0",
      "name": "Kvinesdal - Lista 1",
      "category": "line",
      "fromExternalId": "relation/8894066",
      "toExternalId": "relation/8896922",
      "nominalKv": 300,
      "lengthKm": 23.51,
      "operator": "Statnett",
      "path": [
        [
          6.846246,
          58.276402
        ],
        [
          6.846446,
          58.269061
        ],
        [
          6.845182,
          58.256636
        ],
        [
          6.843878,
          58.250629
        ],
        [
          6.839427,
          58.240828
        ],
        [
          6.823022,
          58.223199
        ],
        [
          6.815901,
          58.21663
        ],
        [
          6.799995,
          58.205837
        ],
        [
          6.790603,
          58.19354
        ],
        [
          6.78346,
          58.177999
        ],
        [
          6.774804,
          58.166397
        ],
        [
          6.772293,
          58.150277
        ],
        [
          6.771776,
          58.136705
        ],
        [
          6.774718,
          58.122243
        ],
        [
          6.776637,
          58.106675
        ],
        [
          6.771097,
          58.097439
        ],
        [
          6.765853,
          58.087805
        ],
        [
          6.774918,
          58.07714
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kvinesdal - Lista 2|line/0",
      "name": "Kvinesdal - Lista 2",
      "category": "line",
      "fromExternalId": "relation/8894066",
      "toExternalId": "relation/8896922",
      "nominalKv": 300,
      "lengthKm": 23.47,
      "operator": "Statnett",
      "path": [
        [
          6.846898,
          58.276299
        ],
        [
          6.847084,
          58.26933
        ],
        [
          6.845734,
          58.256693
        ],
        [
          6.844354,
          58.250604
        ],
        [
          6.839826,
          58.240687
        ],
        [
          6.823246,
          58.222852
        ],
        [
          6.816371,
          58.216438
        ],
        [
          6.798201,
          58.204216
        ],
        [
          6.790638,
          58.191678
        ],
        [
          6.783926,
          58.177932
        ],
        [
          6.776834,
          58.168032
        ],
        [
          6.772892,
          58.150263
        ],
        [
          6.772437,
          58.136715
        ],
        [
          6.775224,
          58.121997
        ],
        [
          6.777135,
          58.106488
        ],
        [
          6.771544,
          58.097352
        ],
        [
          6.766312,
          58.087873
        ],
        [
          6.775555,
          58.077387
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Haugsvær - Lindås|line/5",
      "name": "Haugsvær - Lindås",
      "category": "line",
      "fromExternalId": "way/648848845",
      "toExternalId": "relation/20598970",
      "nominalKv": 300,
      "lengthKm": 22.89,
      "operator": "Statnett",
      "path": [
        [
          5.478204,
          60.897727
        ],
        [
          5.463274,
          60.89428
        ],
        [
          5.434178,
          60.89219
        ],
        [
          5.417132,
          60.885967
        ],
        [
          5.394243,
          60.886631
        ],
        [
          5.355517,
          60.881263
        ],
        [
          5.332219,
          60.876199
        ],
        [
          5.314672,
          60.874235
        ],
        [
          5.284024,
          60.873499
        ],
        [
          5.260123,
          60.878283
        ],
        [
          5.2348,
          60.87771
        ],
        [
          5.20518,
          60.877758
        ],
        [
          5.189632,
          60.878405
        ],
        [
          5.17368,
          60.874563
        ],
        [
          5.144503,
          60.866673
        ],
        [
          5.135528,
          60.856465
        ],
        [
          5.138867,
          60.846807
        ],
        [
          5.136868,
          60.840172
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
      "externalId": "merged/line/line|300|Statnett|Håvik - Kårstø|line/0",
      "name": "Håvik - Kårstø",
      "category": "line",
      "fromExternalId": "relation/13989591",
      "toExternalId": "relation/8864887",
      "nominalKv": 300,
      "lengthKm": 22.57,
      "operator": "Statnett",
      "path": [
        [
          5.31605,
          59.317307
        ],
        [
          5.342377,
          59.315175
        ],
        [
          5.356421,
          59.316406
        ],
        [
          5.379186,
          59.322408
        ],
        [
          5.406425,
          59.333008
        ],
        [
          5.428676,
          59.343456
        ],
        [
          5.446188,
          59.351672
        ],
        [
          5.464305,
          59.360171
        ],
        [
          5.490753,
          59.367651
        ],
        [
          5.496092,
          59.36312
        ],
        [
          5.500756,
          59.354375
        ],
        [
          5.506617,
          59.341831
        ],
        [
          5.51441,
          59.331809
        ],
        [
          5.50127,
          59.320186
        ],
        [
          5.499795,
          59.307848
        ],
        [
          5.505483,
          59.294048
        ],
        [
          5.506027,
          59.284754
        ],
        [
          5.505399,
          59.278271
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Hemsil 1 - Hemsil 2|line/0",
      "name": "Hemsil 1 - Hemsil 2",
      "category": "line",
      "fromExternalId": "way/549449182",
      "toExternalId": "relation/12277754",
      "nominalKv": 300,
      "lengthKm": 22.49,
      "operator": "Statnett",
      "path": [
        [
          8.640942,
          60.807672
        ],
        [
          8.654217,
          60.803843
        ],
        [
          8.674473,
          60.79801
        ],
        [
          8.70115,
          60.791045
        ],
        [
          8.720242,
          60.786207
        ],
        [
          8.742263,
          60.780633
        ],
        [
          8.764756,
          60.779477
        ],
        [
          8.796111,
          60.777869
        ],
        [
          8.82458,
          60.7764
        ],
        [
          8.84843,
          60.768948
        ],
        [
          8.864674,
          60.762419
        ],
        [
          8.884807,
          60.754314
        ],
        [
          8.9012,
          60.747701
        ],
        [
          8.921204,
          60.737193
        ],
        [
          8.936332,
          60.728814
        ],
        [
          8.958004,
          60.719598
        ],
        [
          8.97267,
          60.712395
        ],
        [
          8.97155,
          60.705554
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
      "externalId": "merged/line/line|300|Statnett|Evanger-Dale|line/0",
      "name": "Evanger-Dale",
      "category": "line",
      "fromExternalId": "way/307323708",
      "toExternalId": "way/114669733",
      "nominalKv": 300,
      "lengthKm": 21.79,
      "operator": "Statnett",
      "path": [
        [
          6.111397,
          60.656754
        ],
        [
          6.103379,
          60.656864
        ],
        [
          6.08242,
          60.661521
        ],
        [
          6.066171,
          60.664084
        ],
        [
          6.048324,
          60.665113
        ],
        [
          6.017437,
          60.661831
        ],
        [
          5.995805,
          60.658007
        ],
        [
          5.975213,
          60.654353
        ],
        [
          5.946951,
          60.649376
        ],
        [
          5.928578,
          60.645547
        ],
        [
          5.90925,
          60.639575
        ],
        [
          5.899745,
          60.636267
        ],
        [
          5.858317,
          60.619078
        ],
        [
          5.827598,
          60.61446
        ],
        [
          5.815979,
          60.606257
        ],
        [
          5.810287,
          60.598175
        ],
        [
          5.800325,
          60.58614
        ],
        [
          5.80981,
          60.581453
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|300|Statnett|Kollsnes - Lindås|cable/1",
      "name": "Kollsnes - Lindås",
      "category": "cable",
      "fromExternalId": "way/636875282",
      "toExternalId": "relation/20598970",
      "nominalKv": 300,
      "lengthKm": 21.56,
      "operator": "Statnett",
      "path": [
        [
          4.878041,
          60.559821
        ],
        [
          4.878549,
          60.560444
        ],
        [
          4.880312,
          60.563776
        ],
        [
          4.889839,
          60.566043
        ],
        [
          4.903979,
          60.585049
        ],
        [
          4.909301,
          60.601211
        ],
        [
          4.895139,
          60.614523
        ],
        [
          4.903464,
          60.626776
        ],
        [
          4.890632,
          60.646346
        ],
        [
          4.858789,
          60.685599
        ],
        [
          4.885783,
          60.681669
        ],
        [
          4.929449,
          60.676237
        ],
        [
          4.936831,
          60.677676
        ],
        [
          4.943327,
          60.678743
        ],
        [
          4.945151,
          60.680351
        ],
        [
          4.950223,
          60.680552
        ],
        [
          4.951627,
          60.681424
        ],
        [
          4.952263,
          60.681449
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
      "externalId": "merged/line/line|300|Statnett|Kvinen - Fjotland|line/0",
      "name": "Kvinen - Fjotland",
      "category": "line",
      "fromExternalId": "way/285481596",
      "toExternalId": "way/640796702",
      "nominalKv": 300,
      "lengthKm": 20.56,
      "operator": "Statnett",
      "path": [
        [
          7.089116,
          58.930057
        ],
        [
          7.076421,
          58.924552
        ],
        [
          7.070233,
          58.914482
        ],
        [
          7.064592,
          58.902575
        ],
        [
          7.050109,
          58.890059
        ],
        [
          7.048413,
          58.881378
        ],
        [
          7.053794,
          58.871397
        ],
        [
          7.051851,
          58.861445
        ],
        [
          7.047479,
          58.850309
        ],
        [
          7.04003,
          58.841074
        ],
        [
          7.029016,
          58.82928
        ],
        [
          7.019768,
          58.820731
        ],
        [
          6.999423,
          58.813187
        ],
        [
          7.002395,
          58.804186
        ],
        [
          7.009709,
          58.793009
        ],
        [
          7.00731,
          58.781539
        ],
        [
          7.00928,
          58.773503
        ],
        [
          7.019049,
          58.768539
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Nesflaten - Røldal|line/0",
      "name": "Nesflaten - Røldal",
      "category": "line",
      "fromExternalId": "relation/8857363",
      "toExternalId": "relation/8857031",
      "nominalKv": 300,
      "lengthKm": 19.5,
      "operator": "Statnett",
      "path": [
        [
          6.816243,
          59.649879
        ],
        [
          6.81258,
          59.657248
        ],
        [
          6.810337,
          59.663091
        ],
        [
          6.8147,
          59.673132
        ],
        [
          6.816156,
          59.680816
        ],
        [
          6.815822,
          59.691449
        ],
        [
          6.809034,
          59.702605
        ],
        [
          6.801247,
          59.715427
        ],
        [
          6.799382,
          59.724051
        ],
        [
          6.796361,
          59.738349
        ],
        [
          6.798662,
          59.746463
        ],
        [
          6.801134,
          59.763706
        ],
        [
          6.798711,
          59.774953
        ],
        [
          6.801572,
          59.783827
        ],
        [
          6.803728,
          59.793384
        ],
        [
          6.808395,
          59.802812
        ],
        [
          6.813742,
          59.810999
        ],
        [
          6.816904,
          59.821526
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
      "externalId": "merged/line/line|300|Statnett|Duge - Roskrepp|line/0",
      "name": "Duge - Roskrepp",
      "category": "line",
      "fromExternalId": "way/261717967",
      "toExternalId": "way/71356608",
      "nominalKv": 300,
      "lengthKm": 17.49,
      "operator": "Statnett",
      "path": [
        [
          6.895104,
          59.125773
        ],
        [
          6.899288,
          59.119808
        ],
        [
          6.905874,
          59.11022
        ],
        [
          6.907744,
          59.096686
        ],
        [
          6.922946,
          59.088656
        ],
        [
          6.93345,
          59.084353
        ],
        [
          6.937511,
          59.077239
        ],
        [
          6.942533,
          59.06879
        ],
        [
          6.953749,
          59.058971
        ],
        [
          6.974407,
          59.047932
        ],
        [
          6.984333,
          59.042783
        ],
        [
          6.995866,
          59.037707
        ],
        [
          7.009972,
          59.0315
        ],
        [
          7.024133,
          59.026656
        ],
        [
          7.039201,
          59.026941
        ],
        [
          7.057428,
          59.027279
        ],
        [
          7.072926,
          59.027561
        ],
        [
          7.085426,
          59.025689
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Borgund - Øljusjøen|line/0",
      "name": "Borgund - Øljusjøen",
      "category": "line",
      "fromExternalId": "relation/7845549",
      "toExternalId": "way/549449181",
      "nominalKv": 300,
      "lengthKm": 16.38,
      "operator": "Statnett",
      "path": [
        [
          7.818375,
          61.059296
        ],
        [
          7.827343,
          61.053188
        ],
        [
          7.841202,
          61.05039
        ],
        [
          7.859248,
          61.046718
        ],
        [
          7.874054,
          61.045921
        ],
        [
          7.89902,
          61.043901
        ],
        [
          7.909062,
          61.042147
        ],
        [
          7.921679,
          61.039327
        ],
        [
          7.935187,
          61.036311
        ],
        [
          7.945325,
          61.03404
        ],
        [
          7.967271,
          61.034786
        ],
        [
          7.991197,
          61.036612
        ],
        [
          8.001244,
          61.034422
        ],
        [
          8.021526,
          61.025642
        ],
        [
          8.037068,
          61.018906
        ],
        [
          8.051085,
          61.014438
        ],
        [
          8.074758,
          61.007083
        ],
        [
          8.084736,
          61.004038
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
      "externalId": "merged/line/line|300|Statnett|Duge - Lyse|line/0",
      "name": "Duge - Lyse",
      "category": "line",
      "fromExternalId": "way/261717967",
      "toExternalId": "relation/8886202",
      "nominalKv": 300,
      "lengthKm": 16.03,
      "operator": "Statnett",
      "path": [
        [
          6.894869,
          59.125771
        ],
        [
          6.893238,
          59.120813
        ],
        [
          6.88226,
          59.117511
        ],
        [
          6.863191,
          59.117354
        ],
        [
          6.849434,
          59.115057
        ],
        [
          6.824956,
          59.112383
        ],
        [
          6.806368,
          59.11047
        ],
        [
          6.794265,
          59.106829
        ],
        [
          6.778159,
          59.103773
        ],
        [
          6.769753,
          59.102816
        ],
        [
          6.752601,
          59.099163
        ],
        [
          6.740134,
          59.094474
        ],
        [
          6.720838,
          59.086908
        ],
        [
          6.712408,
          59.083518
        ],
        [
          6.702891,
          59.079689
        ],
        [
          6.676339,
          59.072183
        ],
        [
          6.670048,
          59.068509
        ],
        [
          6.6657,
          59.061168
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
      "externalId": "merged/line/line|300|Statnett|Arna - Fana|line/0",
      "name": "Arna - Fana",
      "category": "line",
      "fromExternalId": "relation/8834935",
      "toExternalId": "relation/8836351",
      "nominalKv": 300,
      "lengthKm": 15.66,
      "operator": "Statnett",
      "path": [
        [
          5.456341,
          60.393964
        ],
        [
          5.449999,
          60.391839
        ],
        [
          5.430707,
          60.386034
        ],
        [
          5.435148,
          60.380277
        ],
        [
          5.442171,
          60.371099
        ],
        [
          5.443836,
          60.365155
        ],
        [
          5.445683,
          60.354214
        ],
        [
          5.44256,
          60.344366
        ],
        [
          5.439468,
          60.338853
        ],
        [
          5.425291,
          60.326676
        ],
        [
          5.418848,
          60.322687
        ],
        [
          5.408911,
          60.315361
        ],
        [
          5.396104,
          60.304975
        ],
        [
          5.38848,
          60.300889
        ],
        [
          5.371472,
          60.293281
        ],
        [
          5.367088,
          60.289484
        ],
        [
          5.34641,
          60.285554
        ],
        [
          5.340401,
          60.28672
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|300|Statnett|Litlesotra - Kollsnes|cable/0",
      "name": "Litlesotra - Kollsnes",
      "category": "cable",
      "fromExternalId": "relation/8837899",
      "toExternalId": "way/636875282",
      "nominalKv": 300,
      "lengthKm": 14.96,
      "operator": "Statnett",
      "path": [
        [
          4.96917,
          60.439442
        ],
        [
          4.962661,
          60.44476
        ],
        [
          4.959311,
          60.451889
        ],
        [
          4.954394,
          60.459134
        ],
        [
          4.956427,
          60.464479
        ],
        [
          4.953372,
          60.469623
        ],
        [
          4.949561,
          60.479489
        ],
        [
          4.947423,
          60.487582
        ],
        [
          4.941452,
          60.49648
        ],
        [
          4.934278,
          60.496814
        ],
        [
          4.919,
          60.502575
        ],
        [
          4.903786,
          60.516788
        ],
        [
          4.900243,
          60.524579
        ],
        [
          4.891013,
          60.534635
        ],
        [
          4.87955,
          60.536539
        ],
        [
          4.874848,
          60.537627
        ],
        [
          4.872689,
          60.538719
        ],
        [
          4.869578,
          60.548476
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Fana - Litlesotra|line/0",
      "name": "Fana - Litlesotra",
      "category": "line",
      "fromExternalId": "relation/8836351",
      "toExternalId": "relation/8837899",
      "nominalKv": 300,
      "lengthKm": 14.95,
      "operator": "Statnett",
      "path": [
        [
          5.340451,
          60.286461
        ],
        [
          5.333455,
          60.285574
        ],
        [
          5.321572,
          60.283617
        ],
        [
          5.308611,
          60.281472
        ],
        [
          5.301652,
          60.280407
        ],
        [
          5.283572,
          60.283017
        ],
        [
          5.274678,
          60.287872
        ],
        [
          5.269252,
          60.297838
        ],
        [
          5.262363,
          60.302944
        ],
        [
          5.26008,
          60.311409
        ],
        [
          5.255447,
          60.323541
        ],
        [
          5.260877,
          60.330488
        ],
        [
          5.256576,
          60.334304
        ],
        [
          5.246882,
          60.346265
        ],
        [
          5.239136,
          60.351033
        ],
        [
          5.22473,
          60.358714
        ],
        [
          5.207253,
          60.363387
        ],
        [
          5.194102,
          60.367313
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Husnes - Børtveit - Stord|line/1",
      "name": "Husnes - Børtveit - Stord",
      "category": "line",
      "fromExternalId": "relation/8847096",
      "toExternalId": "relation/8846916",
      "nominalKv": 300,
      "lengthKm": 12.7,
      "operator": "Statnett",
      "path": [
        [
          5.413498,
          59.787205
        ],
        [
          5.413407,
          59.787129
        ],
        [
          5.414221,
          59.797987
        ],
        [
          5.415847,
          59.804174
        ],
        [
          5.422523,
          59.809888
        ],
        [
          5.427222,
          59.813527
        ],
        [
          5.441558,
          59.823074
        ],
        [
          5.45318,
          59.829951
        ],
        [
          5.461788,
          59.83542
        ],
        [
          5.471122,
          59.84109
        ],
        [
          5.484726,
          59.849846
        ],
        [
          5.490761,
          59.854854
        ],
        [
          5.498789,
          59.861802
        ],
        [
          5.507181,
          59.86883
        ],
        [
          5.509853,
          59.871337
        ],
        [
          5.515196,
          59.878555
        ],
        [
          5.510868,
          59.884878
        ],
        [
          5.510829,
          59.884952
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kjelland - Bjerkreim|line/0",
      "name": "Kjelland - Bjerkreim",
      "category": "line",
      "fromExternalId": "relation/8332571",
      "toExternalId": "way/799370310",
      "nominalKv": 300,
      "lengthKm": 12.64,
      "operator": "Statnett",
      "path": [
        [
          6.03188,
          58.495422
        ],
        [
          6.030708,
          58.497785
        ],
        [
          6.02687,
          58.503221
        ],
        [
          6.006285,
          58.50976
        ],
        [
          5.999017,
          58.512067
        ],
        [
          5.991173,
          58.517516
        ],
        [
          5.986956,
          58.520444
        ],
        [
          5.982451,
          58.525663
        ],
        [
          5.977957,
          58.530875
        ],
        [
          5.970701,
          58.539273
        ],
        [
          5.962969,
          58.548227
        ],
        [
          5.956302,
          58.555264
        ],
        [
          5.949638,
          58.561731
        ],
        [
          5.943114,
          58.568059
        ],
        [
          5.937558,
          58.57345
        ],
        [
          5.92924,
          58.58151
        ],
        [
          5.923148,
          58.586822
        ],
        [
          5.920401,
          58.590155
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Hemsil 2 - Nes kraftverk|line/0",
      "name": "Hemsil 2 - Nes kraftverk",
      "category": "line",
      "fromExternalId": "relation/12277754",
      "toExternalId": "relation/7851611",
      "nominalKv": 300,
      "lengthKm": 12.53,
      "operator": "Statnett",
      "path": [
        [
          8.97197,
          60.705361
        ],
        [
          8.978829,
          60.70339
        ],
        [
          8.984778,
          60.696953
        ],
        [
          8.999589,
          60.69281
        ],
        [
          9.007759,
          60.688057
        ],
        [
          9.015623,
          60.681168
        ],
        [
          9.02434,
          60.671894
        ],
        [
          9.028197,
          60.667802
        ],
        [
          9.034474,
          60.66114
        ],
        [
          9.041936,
          60.658472
        ],
        [
          9.05687,
          60.653151
        ],
        [
          9.065593,
          60.650044
        ],
        [
          9.075694,
          60.646452
        ],
        [
          9.085543,
          60.64146
        ],
        [
          9.093971,
          60.637194
        ],
        [
          9.105365,
          60.63142
        ],
        [
          9.112585,
          60.627763
        ],
        [
          9.119484,
          60.624267
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Blåfalli-Husnes|line/8",
      "name": "Blåfalli-Husnes",
      "category": "line",
      "fromExternalId": "way/432965765",
      "toExternalId": "relation/7809753",
      "nominalKv": 300,
      "lengthKm": 12.47,
      "operator": "Statnett",
      "path": [
        [
          5.95787,
          59.83919
        ],
        [
          5.946473,
          59.836471
        ],
        [
          5.927591,
          59.833247
        ],
        [
          5.915569,
          59.831379
        ],
        [
          5.897223,
          59.828774
        ],
        [
          5.870275,
          59.827417
        ],
        [
          5.845901,
          59.829673
        ],
        [
          5.837691,
          59.830614
        ],
        [
          5.823125,
          59.835492
        ],
        [
          5.813453,
          59.840925
        ],
        [
          5.802748,
          59.847516
        ],
        [
          5.797889,
          59.850498
        ],
        [
          5.788605,
          59.855381
        ],
        [
          5.772885,
          59.860537
        ],
        [
          5.76744,
          59.861929
        ],
        [
          5.766373,
          59.862153
        ],
        [
          5.765765,
          59.862212
        ],
        [
          5.764869,
          59.862301
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Blåfalli-Husnes|line/9",
      "name": "Blåfalli-Husnes",
      "category": "line",
      "fromExternalId": "way/432965765",
      "toExternalId": "relation/7809753",
      "nominalKv": 300,
      "lengthKm": 12.44,
      "operator": "Statnett",
      "path": [
        [
          5.957527,
          59.839436
        ],
        [
          5.946162,
          59.836678
        ],
        [
          5.92798,
          59.833577
        ],
        [
          5.915456,
          59.831627
        ],
        [
          5.897126,
          59.829025
        ],
        [
          5.870414,
          59.827663
        ],
        [
          5.845998,
          59.829915
        ],
        [
          5.837823,
          59.830854
        ],
        [
          5.823538,
          59.83569
        ],
        [
          5.813846,
          59.841081
        ],
        [
          5.803135,
          59.847671
        ],
        [
          5.79827,
          59.85066
        ],
        [
          5.788977,
          59.855551
        ],
        [
          5.773059,
          59.860772
        ],
        [
          5.767557,
          59.862071
        ],
        [
          5.766433,
          59.862303
        ],
        [
          5.765825,
          59.862364
        ],
        [
          5.764931,
          59.862453
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Roskrepp - Kvinen|line/0",
      "name": "Roskrepp - Kvinen",
      "category": "line",
      "fromExternalId": "way/71356608",
      "toExternalId": "way/285481596",
      "nominalKv": 300,
      "lengthKm": 11.83,
      "operator": "Statnett",
      "path": [
        [
          7.085426,
          59.025689
        ],
        [
          7.088191,
          59.02238
        ],
        [
          7.082457,
          59.016965
        ],
        [
          7.079739,
          59.010347
        ],
        [
          7.079263,
          59.003724
        ],
        [
          7.085787,
          58.99559
        ],
        [
          7.093425,
          58.990138
        ],
        [
          7.097916,
          58.986128
        ],
        [
          7.101221,
          58.980736
        ],
        [
          7.10467,
          58.975116
        ],
        [
          7.107771,
          58.970057
        ],
        [
          7.110431,
          58.963728
        ],
        [
          7.111704,
          58.958161
        ],
        [
          7.109785,
          58.948922
        ],
        [
          7.107006,
          58.941323
        ],
        [
          7.10297,
          58.933194
        ],
        [
          7.091889,
          58.930561
        ],
        [
          7.089116,
          58.930057
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Sauda - Blåfalli|line/1",
      "name": "Sauda - Blåfalli",
      "category": "line",
      "fromExternalId": "way/432965765",
      "toExternalId": "way/440170580",
      "nominalKv": 300,
      "lengthKm": 11.67,
      "operator": "Statnett",
      "path": [
        [
          6.010267,
          59.86337
        ],
        [
          6.019097,
          59.862652
        ],
        [
          6.034589,
          59.859708
        ],
        [
          6.042362,
          59.858655
        ],
        [
          6.047898,
          59.854606
        ],
        [
          6.051986,
          59.848679
        ],
        [
          6.052313,
          59.844279
        ],
        [
          6.052662,
          59.835349
        ],
        [
          6.053188,
          59.830605
        ],
        [
          6.053392,
          59.827866
        ],
        [
          6.05513,
          59.819075
        ],
        [
          6.057758,
          59.814609
        ],
        [
          6.062393,
          59.80943
        ],
        [
          6.077521,
          59.802944
        ],
        [
          6.085922,
          59.800062
        ],
        [
          6.093679,
          59.797472
        ],
        [
          6.108211,
          59.792484
        ],
        [
          6.119224,
          59.787242
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
      "externalId": "merged/line/line|300|Statnett|Stokkeland - Bærheim 1&2|line/0",
      "name": "Stokkeland - Bærheim 1&2",
      "category": "line",
      "fromExternalId": "way/166227080",
      "toExternalId": "way/830770515",
      "nominalKv": 300,
      "lengthKm": 10.12,
      "operator": "Statnett",
      "path": [
        [
          5.693919,
          58.881324
        ],
        [
          5.69105,
          58.877116
        ],
        [
          5.689568,
          58.873295
        ],
        [
          5.68745,
          58.867143
        ],
        [
          5.686274,
          58.86314
        ],
        [
          5.688835,
          58.854072
        ],
        [
          5.690962,
          58.846554
        ],
        [
          5.691805,
          58.843557
        ],
        [
          5.691998,
          58.836376
        ],
        [
          5.692085,
          58.83318
        ],
        [
          5.689999,
          58.824511
        ],
        [
          5.689388,
          58.821976
        ],
        [
          5.692692,
          58.815578
        ],
        [
          5.699881,
          58.810601
        ],
        [
          5.706952,
          58.810723
        ],
        [
          5.719269,
          58.813146
        ],
        [
          5.722121,
          58.814439
        ],
        [
          5.731386,
          58.815532
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Nesflaten - Kvanndal|line/0",
      "name": "Nesflaten - Kvanndal",
      "category": "line",
      "fromExternalId": "relation/8857363",
      "toExternalId": "way/430780474",
      "nominalKv": 300,
      "lengthKm": 9.6,
      "operator": "Statnett",
      "path": [
        [
          6.816475,
          59.649821
        ],
        [
          6.817521,
          59.651112
        ],
        [
          6.823961,
          59.651593
        ],
        [
          6.82844,
          59.652074
        ],
        [
          6.849364,
          59.654313
        ],
        [
          6.860109,
          59.655455
        ],
        [
          6.875862,
          59.654976
        ],
        [
          6.881095,
          59.654879
        ],
        [
          6.894444,
          59.654621
        ],
        [
          6.898489,
          59.65441
        ],
        [
          6.91554,
          59.654329
        ],
        [
          6.921293,
          59.654866
        ],
        [
          6.9349,
          59.656286
        ],
        [
          6.94267,
          59.65689
        ],
        [
          6.957149,
          59.658016
        ],
        [
          6.964246,
          59.658171
        ],
        [
          6.977399,
          59.658944
        ],
        [
          6.983334,
          59.658059
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Midtfjellet - Børtveit|line/0",
      "name": "Midtfjellet - Børtveit",
      "category": "line",
      "fromExternalId": "relation/8846883",
      "toExternalId": "relation/8846916",
      "nominalKv": 300,
      "lengthKm": 9.56,
      "operator": "Statnett",
      "path": [
        [
          5.396737,
          59.930875
        ],
        [
          5.402752,
          59.932689
        ],
        [
          5.414849,
          59.936314
        ],
        [
          5.421737,
          59.938378
        ],
        [
          5.428877,
          59.937851
        ],
        [
          5.439654,
          59.932976
        ],
        [
          5.451059,
          59.927273
        ],
        [
          5.45528,
          59.924797
        ],
        [
          5.464716,
          59.919293
        ],
        [
          5.471696,
          59.915211
        ],
        [
          5.48494,
          59.907466
        ],
        [
          5.487274,
          59.9061
        ],
        [
          5.494731,
          59.899453
        ],
        [
          5.501587,
          59.890061
        ],
        [
          5.502695,
          59.888544
        ],
        [
          5.509564,
          59.884788
        ],
        [
          5.509595,
          59.88475
        ],
        [
          5.509652,
          59.884678
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Strinda - Klæbu|line/0",
      "name": "Strinda - Klæbu",
      "category": "line",
      "fromExternalId": "way/222759850",
      "toExternalId": "way/287685850",
      "nominalKv": 300,
      "lengthKm": 8.98,
      "operator": "Statnett",
      "path": [
        [
          10.44846,
          63.39476
        ],
        [
          10.456191,
          63.394302
        ],
        [
          10.460687,
          63.392778
        ],
        [
          10.464528,
          63.387878
        ],
        [
          10.46736,
          63.384231
        ],
        [
          10.467547,
          63.381597
        ],
        [
          10.465443,
          63.375297
        ],
        [
          10.463904,
          63.371153
        ],
        [
          10.462879,
          63.368388
        ],
        [
          10.460232,
          63.361784
        ],
        [
          10.453555,
          63.356787
        ],
        [
          10.449105,
          63.3532
        ],
        [
          10.444594,
          63.34811
        ],
        [
          10.43785,
          63.33883
        ],
        [
          10.433131,
          63.332003
        ],
        [
          10.428213,
          63.327308
        ],
        [
          10.421947,
          63.325866
        ],
        [
          10.418604,
          63.326406
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Håvik - Spanne|line/0",
      "name": "Håvik - Spanne",
      "category": "line",
      "fromExternalId": "way/118231876",
      "toExternalId": "relation/13989591",
      "nominalKv": 300,
      "lengthKm": 8.53,
      "operator": "Statnett",
      "path": [
        [
          5.334229,
          59.378816
        ],
        [
          5.333883,
          59.378227
        ],
        [
          5.336276,
          59.37212
        ],
        [
          5.337888,
          59.367566
        ],
        [
          5.337825,
          59.36094
        ],
        [
          5.337788,
          59.356613
        ],
        [
          5.337744,
          59.349679
        ],
        [
          5.337711,
          59.346368
        ],
        [
          5.337648,
          59.339465
        ],
        [
          5.336237,
          59.337251
        ],
        [
          5.33354,
          59.333021
        ],
        [
          5.334358,
          59.331162
        ],
        [
          5.338181,
          59.322469
        ],
        [
          5.3401,
          59.318087
        ],
        [
          5.338394,
          59.318165
        ],
        [
          5.319972,
          59.318775
        ],
        [
          5.316594,
          59.318564
        ],
        [
          5.315279,
          59.31765
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
      "externalId": "merged/line/line|300|Statnett|Husnes - Børtveit - Stord|line/3",
      "name": "Husnes - Børtveit - Stord",
      "category": "line",
      "fromExternalId": "relation/7809753",
      "toExternalId": "relation/8846916",
      "nominalKv": 300,
      "lengthKm": 7.4,
      "operator": "Statnett",
      "path": [
        [
          5.667516,
          59.906547
        ],
        [
          5.663751,
          59.908011
        ],
        [
          5.659128,
          59.911079
        ],
        [
          5.652773,
          59.912247
        ],
        [
          5.64159,
          59.9143
        ],
        [
          5.628084,
          59.914205
        ],
        [
          5.625113,
          59.914185
        ],
        [
          5.613082,
          59.914097
        ],
        [
          5.605912,
          59.914042
        ],
        [
          5.599334,
          59.913995
        ],
        [
          5.5895,
          59.913918
        ],
        [
          5.579967,
          59.913855
        ],
        [
          5.576105,
          59.91205
        ],
        [
          5.566693,
          59.907645
        ],
        [
          5.562297,
          59.905588
        ],
        [
          5.557439,
          59.904105
        ],
        [
          5.551532,
          59.902293
        ],
        [
          5.54876,
          59.901444
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
      "externalId": "merged/line/line|300|Statnett|Refsdal-Hove|line/1",
      "name": "Refsdal-Hove",
      "category": "line",
      "fromExternalId": "way/546262583",
      "toExternalId": "way/546262597",
      "nominalKv": 300,
      "lengthKm": 5.88,
      "operator": "Statnett",
      "path": [
        [
          6.614263,
          61.067536
        ],
        [
          6.614287,
          61.067397
        ],
        [
          6.614719,
          61.064832
        ],
        [
          6.611752,
          61.061421
        ],
        [
          6.609322,
          61.058638
        ],
        [
          6.605873,
          61.054695
        ],
        [
          6.602864,
          61.052431
        ],
        [
          6.599109,
          61.049611
        ],
        [
          6.595625,
          61.046984
        ],
        [
          6.587103,
          61.04057
        ],
        [
          6.581993,
          61.036726
        ],
        [
          6.577208,
          61.033123
        ],
        [
          6.574175,
          61.030846
        ],
        [
          6.568857,
          61.026853
        ],
        [
          6.567984,
          61.02458
        ],
        [
          6.567367,
          61.022969
        ],
        [
          6.568281,
          61.022121
        ],
        [
          6.569401,
          61.02107
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Steinsland - Modalen|line/0",
      "name": "Steinsland - Modalen",
      "category": "line",
      "fromExternalId": "relation/10086891",
      "toExternalId": "relation/7802012",
      "nominalKv": 300,
      "lengthKm": 4.75,
      "operator": "Statnett",
      "path": [
        [
          5.97615,
          60.926224
        ],
        [
          5.976895,
          60.925969
        ],
        [
          5.988096,
          60.920211
        ],
        [
          5.98882,
          60.919259
        ],
        [
          5.991046,
          60.91643
        ],
        [
          5.993369,
          60.913463
        ],
        [
          5.998246,
          60.90724
        ],
        [
          6.00118,
          60.902685
        ],
        [
          6.003079,
          60.899737
        ],
        [
          6.00435,
          60.897778
        ],
        [
          6.006689,
          60.894133
        ],
        [
          6.010492,
          60.888809
        ],
        [
          6.012396,
          60.888246
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
      "externalId": "merged/line/line|300|Aktieselskabet Saudefaldene|Sønnå - Sauda|line/0",
      "name": "Sønnå - Sauda",
      "category": "line",
      "fromExternalId": "way/289304185",
      "toExternalId": "relation/8860331",
      "nominalKv": 300,
      "lengthKm": 4.14,
      "operator": "Aktieselskabet Saudefaldene",
      "path": [
        [
          6.378642,
          59.644404
        ],
        [
          6.3818,
          59.644667
        ],
        [
          6.385497,
          59.64489
        ],
        [
          6.39211,
          59.646096
        ],
        [
          6.395027,
          59.647818
        ],
        [
          6.400385,
          59.650976
        ],
        [
          6.402906,
          59.652462
        ],
        [
          6.40638,
          59.65451
        ],
        [
          6.413877,
          59.658048
        ],
        [
          6.421707,
          59.661746
        ],
        [
          6.416163,
          59.665178
        ],
        [
          6.412224,
          59.667612
        ],
        [
          6.410484,
          59.667899
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Bjørnabøle-Blåfalli|line/0",
      "name": "Bjørnabøle-Blåfalli",
      "category": "line",
      "fromExternalId": "way/440170580",
      "toExternalId": "way/432965765",
      "nominalKv": 300,
      "lengthKm": 4.03,
      "operator": "Statnett",
      "path": [
        [
          6.073467,
          59.871358
        ],
        [
          6.070558,
          59.871676
        ],
        [
          6.067972,
          59.871738
        ],
        [
          6.059963,
          59.87193
        ],
        [
          6.055328,
          59.872123
        ],
        [
          6.050924,
          59.872304
        ],
        [
          6.045259,
          59.872538
        ],
        [
          6.040243,
          59.872751
        ],
        [
          6.033002,
          59.873058
        ],
        [
          6.027959,
          59.873257
        ],
        [
          6.024671,
          59.871359
        ],
        [
          6.019145,
          59.868159
        ],
        [
          6.016458,
          59.866608
        ],
        [
          6.014441,
          59.865507
        ],
        [
          6.011791,
          59.864103
        ],
        [
          6.010116,
          59.863475
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|300||Kårstø - Haugsneset|cable/0",
      "name": "Kårstø - Haugsneset",
      "category": "cable",
      "fromExternalId": "relation/8864887",
      "toExternalId": "relation/12969006",
      "nominalKv": 300,
      "lengthKm": 3.89,
      "operator": null,
      "path": [
        [
          5.505059,
          59.27827
        ],
        [
          5.50491,
          59.278815
        ],
        [
          5.512066,
          59.281801
        ],
        [
          5.513594,
          59.28195
        ],
        [
          5.522593,
          59.28163
        ],
        [
          5.524457,
          59.281883
        ],
        [
          5.531149,
          59.282445
        ],
        [
          5.534003,
          59.282649
        ],
        [
          5.537214,
          59.282361
        ],
        [
          5.539671,
          59.282448
        ],
        [
          5.547688,
          59.282677
        ],
        [
          5.549796,
          59.282193
        ],
        [
          5.554057,
          59.280086
        ],
        [
          5.555061,
          59.277759
        ],
        [
          5.555627,
          59.276515
        ],
        [
          5.554082,
          59.275143
        ],
        [
          5.553707,
          59.274466
        ],
        [
          5.552241,
          59.274035
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
      "externalId": "merged/line/line|300|Statnett|Balbergskaret - Fåberg|line/0",
      "name": "Balbergskaret - Fåberg",
      "category": "line",
      "fromExternalId": "way/554551085",
      "toExternalId": "way/297388897",
      "nominalKv": 300,
      "lengthKm": 3.79,
      "operator": "Statnett",
      "path": [
        [
          10.448365,
          61.163884
        ],
        [
          10.448443,
          61.163722
        ],
        [
          10.450211,
          61.160062
        ],
        [
          10.451759,
          61.156857
        ],
        [
          10.454152,
          61.151858
        ],
        [
          10.451604,
          61.148769
        ],
        [
          10.448705,
          61.145168
        ],
        [
          10.445447,
          61.143724
        ],
        [
          10.44139,
          61.142152
        ],
        [
          10.438653,
          61.141473
        ],
        [
          10.435849,
          61.140777
        ],
        [
          10.433573,
          61.140444
        ],
        [
          10.431164,
          61.140087
        ],
        [
          10.427922,
          61.139612
        ],
        [
          10.424642,
          61.139124
        ],
        [
          10.422996,
          61.138128
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|300|Statnett|Kvinesdal - Øye|line/0",
      "name": "Kvinesdal - Øye",
      "category": "line",
      "fromExternalId": "relation/8894066",
      "toExternalId": "relation/11981383",
      "nominalKv": 300,
      "lengthKm": 2.75,
      "operator": "Statnett",
      "path": [
        [
          6.848203,
          58.276092
        ],
        [
          6.848394,
          58.276807
        ],
        [
          6.854433,
          58.278743
        ],
        [
          6.856819,
          58.279106
        ],
        [
          6.862245,
          58.280172
        ],
        [
          6.866719,
          58.281053
        ],
        [
          6.870517,
          58.281805
        ],
        [
          6.873653,
          58.281653
        ],
        [
          6.880919,
          58.281305
        ],
        [
          6.882711,
          58.280996
        ],
        [
          6.885794,
          58.280465
        ],
        [
          6.888512,
          58.279995
        ],
        [
          6.890753,
          58.279021
        ],
        [
          6.890879,
          58.278967
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
      "externalId": "merged/line/line|300|Statnett|Kollsnes - Lindås|line/0",
      "name": "Kollsnes - Lindås",
      "category": "line",
      "fromExternalId": "relation/8839478",
      "toExternalId": "way/636875282",
      "nominalKv": 300,
      "lengthKm": 2.47,
      "operator": "Statnett",
      "path": [
        [
          4.844803,
          60.550913
        ],
        [
          4.846921,
          60.551154
        ],
        [
          4.851853,
          60.551554
        ],
        [
          4.854857,
          60.551784
        ],
        [
          4.860805,
          60.550699
        ],
        [
          4.865117,
          60.549917
        ],
        [
          4.867733,
          60.552166
        ],
        [
          4.870678,
          60.554686
        ],
        [
          4.874509,
          60.557969
        ],
        [
          4.878041,
          60.559821
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skillemoen - Skaidi|line/0",
      "name": "Skillemoen - Skaidi",
      "category": "line",
      "fromExternalId": "way/883151328",
      "toExternalId": "way/586116281",
      "nominalKv": 132,
      "lengthKm": 88.69,
      "operator": "Statnett",
      "path": [
        [
          23.21421,
          69.904724
        ],
        [
          23.344488,
          69.909853
        ],
        [
          23.47748,
          69.907582
        ],
        [
          23.553379,
          69.946065
        ],
        [
          23.580029,
          70.001197
        ],
        [
          23.580887,
          70.055404
        ],
        [
          23.565947,
          70.097477
        ],
        [
          23.640561,
          70.136081
        ],
        [
          23.732207,
          70.168062
        ],
        [
          23.835933,
          70.190348
        ],
        [
          23.925645,
          70.213759
        ],
        [
          24.056448,
          70.230165
        ],
        [
          24.144001,
          70.261157
        ],
        [
          24.271009,
          70.284902
        ],
        [
          24.37672,
          70.308678
        ],
        [
          24.438368,
          70.350165
        ],
        [
          24.501057,
          70.391108
        ],
        [
          24.542878,
          70.432581
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Adamselv - Lakselv|line/0",
      "name": "Adamselv - Lakselv",
      "category": "line",
      "fromExternalId": "way/128291126",
      "toExternalId": "way/552672002",
      "nominalKv": 132,
      "lengthKm": 83.63,
      "operator": "Statnett",
      "path": [
        [
          24.974402,
          70.002918
        ],
        [
          25.088262,
          70.031518
        ],
        [
          25.186962,
          70.066563
        ],
        [
          25.281064,
          70.093461
        ],
        [
          25.371369,
          70.108941
        ],
        [
          25.474291,
          70.132355
        ],
        [
          25.562321,
          70.154146
        ],
        [
          25.640127,
          70.177908
        ],
        [
          25.751191,
          70.198737
        ],
        [
          25.870442,
          70.220093
        ],
        [
          25.966744,
          70.253055
        ],
        [
          26.125032,
          70.256883
        ],
        [
          26.249063,
          70.26451
        ],
        [
          26.381441,
          70.281257
        ],
        [
          26.47358,
          70.303882
        ],
        [
          26.581614,
          70.330292
        ],
        [
          26.649002,
          70.365579
        ],
        [
          26.696217,
          70.409722
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Adamselv - Varangerbotn|line/0",
      "name": "Adamselv - Varangerbotn",
      "category": "line",
      "fromExternalId": "way/257192868",
      "toExternalId": "way/552672002",
      "nominalKv": 132,
      "lengthKm": 79.27,
      "operator": "Statnett",
      "path": [
        [
          28.540793,
          70.171861
        ],
        [
          28.425665,
          70.182782
        ],
        [
          28.313377,
          70.201837
        ],
        [
          28.193407,
          70.21896
        ],
        [
          28.067713,
          70.238822
        ],
        [
          27.943929,
          70.258251
        ],
        [
          27.819995,
          70.271526
        ],
        [
          27.705406,
          70.274233
        ],
        [
          27.589229,
          70.287267
        ],
        [
          27.469178,
          70.292103
        ],
        [
          27.348018,
          70.296895
        ],
        [
          27.238385,
          70.292605
        ],
        [
          27.120084,
          70.296897
        ],
        [
          27.007801,
          70.302521
        ],
        [
          26.902465,
          70.320173
        ],
        [
          26.819955,
          70.347942
        ],
        [
          26.745631,
          70.379583
        ],
        [
          26.697105,
          70.409776
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skaidi - Alta|line/0",
      "name": "Skaidi - Alta",
      "category": "line",
      "fromExternalId": "way/586116281",
      "toExternalId": "relation/8278085",
      "nominalKv": 132,
      "lengthKm": 76.73,
      "operator": "Statnett",
      "path": [
        [
          24.542639,
          70.432524
        ],
        [
          24.502859,
          70.394478
        ],
        [
          24.463874,
          70.365097
        ],
        [
          24.411353,
          70.332178
        ],
        [
          24.342517,
          70.299291
        ],
        [
          24.223963,
          70.277215
        ],
        [
          24.123563,
          70.252083
        ],
        [
          24.028741,
          70.22924
        ],
        [
          23.917193,
          70.212543
        ],
        [
          23.843055,
          70.19176
        ],
        [
          23.741541,
          70.171547
        ],
        [
          23.655372,
          70.143674
        ],
        [
          23.598906,
          70.109963
        ],
        [
          23.566905,
          70.072566
        ],
        [
          23.576572,
          70.028255
        ],
        [
          23.524204,
          69.996738
        ],
        [
          23.46993,
          69.959096
        ],
        [
          23.373486,
          69.951475
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Neiden - Varangerbotn|line/0",
      "name": "Neiden - Varangerbotn",
      "category": "line",
      "fromExternalId": "way/585733410",
      "toExternalId": "way/257192868",
      "nominalKv": 132,
      "lengthKm": 69.61,
      "operator": "Statnett",
      "path": [
        [
          29.349893,
          69.703526
        ],
        [
          29.345625,
          69.737658
        ],
        [
          29.353484,
          69.770541
        ],
        [
          29.381765,
          69.807409
        ],
        [
          29.384024,
          69.842704
        ],
        [
          29.320691,
          69.8725
        ],
        [
          29.2711,
          69.90513
        ],
        [
          29.252574,
          69.937657
        ],
        [
          29.203004,
          69.970505
        ],
        [
          29.146868,
          69.999189
        ],
        [
          29.073013,
          70.028018
        ],
        [
          28.990452,
          70.049791
        ],
        [
          28.89025,
          70.059387
        ],
        [
          28.792591,
          70.070263
        ],
        [
          28.687041,
          70.079661
        ],
        [
          28.595921,
          70.103303
        ],
        [
          28.546901,
          70.132629
        ],
        [
          28.542226,
          70.171781
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Adamselv - Tana Bru|line/0",
      "name": "Adamselv - Tana Bru",
      "category": "line",
      "fromExternalId": "relation/8274347",
      "toExternalId": "way/552672002",
      "nominalKv": 132,
      "lengthKm": 67.14,
      "operator": "Statnett",
      "path": [
        [
          28.187521,
          70.194413
        ],
        [
          28.110436,
          70.218147
        ],
        [
          28.053074,
          70.240892
        ],
        [
          27.943602,
          70.258071
        ],
        [
          27.843234,
          70.270359
        ],
        [
          27.7377,
          70.271833
        ],
        [
          27.643259,
          70.283989
        ],
        [
          27.546469,
          70.288733
        ],
        [
          27.450419,
          70.292585
        ],
        [
          27.356483,
          70.29628
        ],
        [
          27.265357,
          70.293505
        ],
        [
          27.16544,
          70.294001
        ],
        [
          27.078123,
          70.297863
        ],
        [
          26.99763,
          70.30338
        ],
        [
          26.906338,
          70.318122
        ],
        [
          26.835013,
          70.343024
        ],
        [
          26.746023,
          70.377417
        ],
        [
          26.697028,
          70.40959
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Vadsø - Smelror|line/0",
      "name": "Vadsø - Smelror",
      "category": "line",
      "fromExternalId": "relation/8271838",
      "toExternalId": "way/643494389",
      "nominalKv": 132,
      "lengthKm": 65.05,
      "operator": "Barents Nett",
      "path": [
        [
          29.764443,
          70.07893
        ],
        [
          29.855969,
          70.073791
        ],
        [
          29.969687,
          70.071551
        ],
        [
          30.062268,
          70.085281
        ],
        [
          30.154504,
          70.109119
        ],
        [
          30.240257,
          70.128112
        ],
        [
          30.285804,
          70.15595
        ],
        [
          30.319599,
          70.186913
        ],
        [
          30.394535,
          70.212147
        ],
        [
          30.472062,
          70.234903
        ],
        [
          30.559569,
          70.25111
        ],
        [
          30.662828,
          70.259908
        ],
        [
          30.770881,
          70.267193
        ],
        [
          30.873954,
          70.277351
        ],
        [
          30.932224,
          70.303619
        ],
        [
          30.980055,
          70.325102
        ],
        [
          31.001626,
          70.353808
        ],
        [
          31.015342,
          70.384129
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Båtsfjord - Smelror|line/0",
      "name": "Båtsfjord - Smelror",
      "category": "line",
      "fromExternalId": "way/643494389",
      "toExternalId": "way/657434624",
      "nominalKv": 132,
      "lengthKm": 64.84,
      "operator": "Barents Nett",
      "path": [
        [
          31.014204,
          70.38397
        ],
        [
          30.933796,
          70.400914
        ],
        [
          30.831981,
          70.406853
        ],
        [
          30.733784,
          70.422848
        ],
        [
          30.648291,
          70.439395
        ],
        [
          30.561395,
          70.462903
        ],
        [
          30.464904,
          70.479128
        ],
        [
          30.380896,
          70.488789
        ],
        [
          30.280121,
          70.483936
        ],
        [
          30.17204,
          70.488977
        ],
        [
          30.081357,
          70.492215
        ],
        [
          29.977285,
          70.499494
        ],
        [
          29.897934,
          70.520055
        ],
        [
          29.823407,
          70.541969
        ],
        [
          29.750876,
          70.561149
        ],
        [
          29.669093,
          70.582395
        ],
        [
          29.65919,
          70.611188
        ],
        [
          29.712435,
          70.639539
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Lakselv - Alta kraftverk|line/0",
      "name": "Lakselv - Alta kraftverk",
      "category": "line",
      "fromExternalId": "way/128291126",
      "toExternalId": "relation/8276522",
      "nominalKv": 132,
      "lengthKm": 63.56,
      "operator": "Statnett",
      "path": [
        [
          24.973731,
          70.002996
        ],
        [
          24.930038,
          69.976784
        ],
        [
          24.919272,
          69.946262
        ],
        [
          24.908988,
          69.913845
        ],
        [
          24.899794,
          69.878216
        ],
        [
          24.896227,
          69.842031
        ],
        [
          24.832784,
          69.819519
        ],
        [
          24.744177,
          69.805996
        ],
        [
          24.648246,
          69.798565
        ],
        [
          24.561836,
          69.792598
        ],
        [
          24.463355,
          69.786858
        ],
        [
          24.3497,
          69.780163
        ],
        [
          24.251262,
          69.774301
        ],
        [
          24.164981,
          69.761632
        ],
        [
          24.067923,
          69.74927
        ],
        [
          23.961654,
          69.742829
        ],
        [
          23.87688,
          69.728224
        ],
        [
          23.802145,
          69.719566
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skibotn - Balsfjord|line/0",
      "name": "Skibotn - Balsfjord",
      "category": "line",
      "fromExternalId": "way/572898616",
      "toExternalId": "relation/13009239",
      "nominalKv": 132,
      "lengthKm": 62.47,
      "operator": "Statnett",
      "path": [
        [
          19.206578,
          69.190319
        ],
        [
          19.264827,
          69.211401
        ],
        [
          19.349311,
          69.221158
        ],
        [
          19.420717,
          69.225739
        ],
        [
          19.51049,
          69.213077
        ],
        [
          19.604319,
          69.211748
        ],
        [
          19.666005,
          69.191907
        ],
        [
          19.744277,
          69.194753
        ],
        [
          19.800823,
          69.221715
        ],
        [
          19.867723,
          69.247318
        ],
        [
          19.94794,
          69.248763
        ],
        [
          20.039079,
          69.238631
        ],
        [
          20.126975,
          69.231743
        ],
        [
          20.207245,
          69.239642
        ],
        [
          20.318613,
          69.241822
        ],
        [
          20.395319,
          69.251631
        ],
        [
          20.413209,
          69.288428
        ],
        [
          20.358409,
          69.315137
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Lakselv - Skaidi|line/0",
      "name": "Lakselv - Skaidi",
      "category": "line",
      "fromExternalId": "way/128291126",
      "toExternalId": "way/586116281",
      "nominalKv": 132,
      "lengthKm": 55.18,
      "operator": "Statnett",
      "path": [
        [
          24.973283,
          70.003048
        ],
        [
          24.911381,
          70.008118
        ],
        [
          24.906966,
          70.040644
        ],
        [
          24.905038,
          70.073281
        ],
        [
          24.893668,
          70.099423
        ],
        [
          24.892273,
          70.127776
        ],
        [
          24.862533,
          70.155832
        ],
        [
          24.87685,
          70.186463
        ],
        [
          24.885659,
          70.214958
        ],
        [
          24.874308,
          70.243407
        ],
        [
          24.851101,
          70.26728
        ],
        [
          24.833549,
          70.295052
        ],
        [
          24.785977,
          70.319098
        ],
        [
          24.748448,
          70.340546
        ],
        [
          24.704695,
          70.369036
        ],
        [
          24.661067,
          70.397412
        ],
        [
          24.616021,
          70.424306
        ],
        [
          24.542996,
          70.432671
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvænangen - Skillemoen 2|line/0",
      "name": "Kvænangen - Skillemoen 2",
      "category": "line",
      "fromExternalId": "relation/8280181",
      "toExternalId": "way/883151328",
      "nominalKv": 132,
      "lengthKm": 52.72,
      "operator": "Statnett",
      "path": [
        [
          22.054054,
          69.71983
        ],
        [
          22.111536,
          69.719027
        ],
        [
          22.179082,
          69.722304
        ],
        [
          22.251794,
          69.744033
        ],
        [
          22.332008,
          69.749435
        ],
        [
          22.431909,
          69.754889
        ],
        [
          22.503756,
          69.758072
        ],
        [
          22.591678,
          69.752747
        ],
        [
          22.682476,
          69.75695
        ],
        [
          22.765764,
          69.769523
        ],
        [
          22.84277,
          69.791041
        ],
        [
          22.911826,
          69.810599
        ],
        [
          22.995785,
          69.827453
        ],
        [
          23.08161,
          69.844639
        ],
        [
          23.11193,
          69.858994
        ],
        [
          23.146702,
          69.873192
        ],
        [
          23.191211,
          69.886873
        ],
        [
          23.213778,
          69.905054
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvænangen - Skillemoen 1|line/0",
      "name": "Kvænangen - Skillemoen 1",
      "category": "line",
      "fromExternalId": "relation/8280181",
      "toExternalId": "way/883151328",
      "nominalKv": 132,
      "lengthKm": 52.7,
      "operator": "Statnett",
      "path": [
        [
          22.054125,
          69.719926
        ],
        [
          22.144956,
          69.719291
        ],
        [
          22.209895,
          69.731851
        ],
        [
          22.264845,
          69.745912
        ],
        [
          22.340886,
          69.750206
        ],
        [
          22.417157,
          69.754465
        ],
        [
          22.477292,
          69.757176
        ],
        [
          22.557491,
          69.757048
        ],
        [
          22.644035,
          69.752463
        ],
        [
          22.729978,
          69.76403
        ],
        [
          22.805694,
          69.779455
        ],
        [
          22.865945,
          69.798866
        ],
        [
          22.930795,
          69.814716
        ],
        [
          22.997912,
          69.828195
        ],
        [
          23.072577,
          69.84314
        ],
        [
          23.121393,
          69.863868
        ],
        [
          23.174484,
          69.882071
        ],
        [
          23.213562,
          69.905219
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Varangerbotn - Vadsø|line/0",
      "name": "Varangerbotn - Vadsø",
      "category": "line",
      "fromExternalId": "way/257192868",
      "toExternalId": "relation/8271838",
      "nominalKv": 132,
      "lengthKm": 50.21,
      "operator": "Barents Nett",
      "path": [
        [
          28.540669,
          70.172214
        ],
        [
          28.600089,
          70.180391
        ],
        [
          28.684117,
          70.180749
        ],
        [
          28.766987,
          70.174491
        ],
        [
          28.837148,
          70.163043
        ],
        [
          28.905893,
          70.153368
        ],
        [
          28.977417,
          70.142307
        ],
        [
          29.053066,
          70.132818
        ],
        [
          29.121129,
          70.133181
        ],
        [
          29.199638,
          70.12499
        ],
        [
          29.273334,
          70.124248
        ],
        [
          29.349874,
          70.120653
        ],
        [
          29.420255,
          70.107338
        ],
        [
          29.487168,
          70.102427
        ],
        [
          29.566848,
          70.096535
        ],
        [
          29.644927,
          70.096196
        ],
        [
          29.723779,
          70.091821
        ],
        [
          29.763475,
          70.078881
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvanndal - Kvitnes|line/0",
      "name": "Kvanndal - Kvitnes",
      "category": "line",
      "fromExternalId": "way/252924745",
      "toExternalId": "way/228085650",
      "nominalKv": 132,
      "lengthKm": 49.11,
      "operator": "Statnett",
      "path": [
        [
          17.609134,
          68.577681
        ],
        [
          17.55847,
          68.566588
        ],
        [
          17.495294,
          68.550147
        ],
        [
          17.430649,
          68.544475
        ],
        [
          17.349402,
          68.539913
        ],
        [
          17.278284,
          68.54081
        ],
        [
          17.204919,
          68.538234
        ],
        [
          17.13371,
          68.533746
        ],
        [
          17.066939,
          68.538793
        ],
        [
          17.008982,
          68.535827
        ],
        [
          16.9553,
          68.520079
        ],
        [
          16.893228,
          68.520434
        ],
        [
          16.852129,
          68.544082
        ],
        [
          16.825752,
          68.560033
        ],
        [
          16.78528,
          68.576449
        ],
        [
          16.720735,
          68.599913
        ],
        [
          16.663908,
          68.617275
        ],
        [
          16.598114,
          68.629477
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Fauske - Tjønndal|line/0",
      "name": "Fauske - Tjønndal",
      "category": "line",
      "fromExternalId": "relation/8296010",
      "toExternalId": "way/588074267",
      "nominalKv": 132,
      "lengthKm": 48.04,
      "operator": "Arva",
      "path": [
        [
          15.418532,
          67.271337
        ],
        [
          15.403878,
          67.296431
        ],
        [
          15.351344,
          67.314828
        ],
        [
          15.297003,
          67.326194
        ],
        [
          15.220914,
          67.337738
        ],
        [
          15.153703,
          67.334175
        ],
        [
          15.093761,
          67.327823
        ],
        [
          15.032094,
          67.324255
        ],
        [
          14.974033,
          67.304748
        ],
        [
          14.91994,
          67.296586
        ],
        [
          14.861844,
          67.303907
        ],
        [
          14.8127,
          67.311016
        ],
        [
          14.748769,
          67.323489
        ],
        [
          14.684585,
          67.315639
        ],
        [
          14.625608,
          67.306088
        ],
        [
          14.57102,
          67.297222
        ],
        [
          14.515563,
          67.288307
        ],
        [
          14.461184,
          67.283994
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kanstadbotn - Kvitfossen|line/0",
      "name": "Kanstadbotn - Kvitfossen",
      "category": "line",
      "fromExternalId": "relation/8288539",
      "toExternalId": "relation/8288766",
      "nominalKv": 132,
      "lengthKm": 47.94,
      "operator": "Statnett",
      "path": [
        [
          15.881457,
          68.506792
        ],
        [
          15.844267,
          68.521014
        ],
        [
          15.792251,
          68.529456
        ],
        [
          15.752648,
          68.517945
        ],
        [
          15.711813,
          68.502186
        ],
        [
          15.654555,
          68.485698
        ],
        [
          15.583905,
          68.483498
        ],
        [
          15.53565,
          68.464848
        ],
        [
          15.472811,
          68.463782
        ],
        [
          15.399289,
          68.465055
        ],
        [
          15.337198,
          68.462622
        ],
        [
          15.261732,
          68.460797
        ],
        [
          15.174072,
          68.4632
        ],
        [
          15.09198,
          68.459814
        ],
        [
          15.044534,
          68.444015
        ],
        [
          14.985043,
          68.437476
        ],
        [
          14.941007,
          68.444495
        ],
        [
          14.891721,
          68.437259
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Leirpollen - Kobbkroken|line/0",
      "name": "Leirpollen - Kobbkroken",
      "category": "line",
      "fromExternalId": "way/671990791",
      "toExternalId": "way/671990787",
      "nominalKv": 132,
      "lengthKm": 46.11,
      "operator": "Barents Nett",
      "path": [
        [
          29.281806,
          70.711416
        ],
        [
          29.23001,
          70.690201
        ],
        [
          29.185462,
          70.670444
        ],
        [
          29.132763,
          70.65032
        ],
        [
          29.116917,
          70.624869
        ],
        [
          29.1013,
          70.599755
        ],
        [
          29.075625,
          70.578638
        ],
        [
          29.073033,
          70.554427
        ],
        [
          29.036364,
          70.536834
        ],
        [
          28.98208,
          70.520185
        ],
        [
          28.940974,
          70.505859
        ],
        [
          28.88558,
          70.485944
        ],
        [
          28.826678,
          70.471812
        ],
        [
          28.771396,
          70.460514
        ],
        [
          28.704734,
          70.459027
        ],
        [
          28.640318,
          70.449797
        ],
        [
          28.581401,
          70.440923
        ],
        [
          28.521295,
          70.426658
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvanndal - Boltås|line/0",
      "name": "Kvanndal - Boltås",
      "category": "line",
      "fromExternalId": "way/252924745",
      "toExternalId": "way/1156551462",
      "nominalKv": 132,
      "lengthKm": 41.87,
      "operator": "Statnett",
      "path": [
        [
          17.609353,
          68.57765
        ],
        [
          17.565195,
          68.568577
        ],
        [
          17.499322,
          68.550879
        ],
        [
          17.44602,
          68.544821
        ],
        [
          17.366154,
          68.540644
        ],
        [
          17.296465,
          68.540174
        ],
        [
          17.229849,
          68.539775
        ],
        [
          17.157152,
          68.534558
        ],
        [
          17.100758,
          68.533585
        ],
        [
          17.033949,
          68.538782
        ],
        [
          16.996564,
          68.530997
        ],
        [
          16.929663,
          68.515907
        ],
        [
          16.880283,
          68.512521
        ],
        [
          16.839396,
          68.510267
        ],
        [
          16.783628,
          68.507176
        ],
        [
          16.752244,
          68.515083
        ],
        [
          16.708152,
          68.529602
        ],
        [
          16.663557,
          68.531033
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Hungeren - Ullsfjord|line/0",
      "name": "Hungeren - Ullsfjord",
      "category": "line",
      "fromExternalId": "way/586436581",
      "toExternalId": "relation/8280652",
      "nominalKv": 132,
      "lengthKm": 40.8,
      "operator": "Arva",
      "path": [
        [
          19.820639,
          69.601613
        ],
        [
          19.762511,
          69.603245
        ],
        [
          19.707608,
          69.611842
        ],
        [
          19.710224,
          69.633259
        ],
        [
          19.687082,
          69.649145
        ],
        [
          19.630326,
          69.644465
        ],
        [
          19.572047,
          69.63959
        ],
        [
          19.514422,
          69.634674
        ],
        [
          19.450331,
          69.629179
        ],
        [
          19.391317,
          69.624092
        ],
        [
          19.332108,
          69.616287
        ],
        [
          19.267986,
          69.602835
        ],
        [
          19.218248,
          69.592362
        ],
        [
          19.184977,
          69.608856
        ],
        [
          19.125057,
          69.619276
        ],
        [
          19.052039,
          69.61739
        ],
        [
          19.011468,
          69.628599
        ],
        [
          18.978781,
          69.637963
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Nedre Røssåga - Svabo|line/1",
      "name": "Nedre Røssåga - Svabo",
      "category": "line",
      "fromExternalId": "relation/8473044",
      "toExternalId": "way/589085618",
      "nominalKv": 132,
      "lengthKm": 39.85,
      "operator": "Linea",
      "path": [
        [
          13.778879,
          66.05171
        ],
        [
          13.785487,
          66.075191
        ],
        [
          13.793826,
          66.096852
        ],
        [
          13.823668,
          66.118067
        ],
        [
          13.838793,
          66.137036
        ],
        [
          13.856552,
          66.156314
        ],
        [
          13.836395,
          66.175269
        ],
        [
          13.814243,
          66.193817
        ],
        [
          13.826997,
          66.205873
        ],
        [
          13.869537,
          66.221432
        ],
        [
          13.908026,
          66.22803
        ],
        [
          13.961289,
          66.237439
        ],
        [
          13.990008,
          66.249914
        ],
        [
          13.998594,
          66.267094
        ],
        [
          14.043778,
          66.275898
        ],
        [
          14.095569,
          66.288528
        ],
        [
          14.135537,
          66.296364
        ],
        [
          14.17622,
          66.304822
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvænangen - Nordreisa 2|line/0",
      "name": "Kvænangen - Nordreisa 2",
      "category": "line",
      "fromExternalId": "relation/8280181",
      "toExternalId": "relation/8280502",
      "nominalKv": 132,
      "lengthKm": 39.58,
      "operator": "Statnett",
      "path": [
        [
          22.053417,
          69.719784
        ],
        [
          22.009692,
          69.72425
        ],
        [
          21.966761,
          69.732095
        ],
        [
          21.942728,
          69.743493
        ],
        [
          21.910316,
          69.759244
        ],
        [
          21.854532,
          69.771903
        ],
        [
          21.773668,
          69.773717
        ],
        [
          21.72081,
          69.765351
        ],
        [
          21.671761,
          69.750679
        ],
        [
          21.634727,
          69.727056
        ],
        [
          21.589283,
          69.70597
        ],
        [
          21.542645,
          69.692359
        ],
        [
          21.506263,
          69.681713
        ],
        [
          21.465837,
          69.673455
        ],
        [
          21.405541,
          69.667708
        ],
        [
          21.351253,
          69.658737
        ],
        [
          21.319587,
          69.638456
        ],
        [
          21.314574,
          69.62236
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sundsfjord - Hopen|line/1",
      "name": "Sundsfjord - Hopen",
      "category": "line",
      "fromExternalId": "relation/8300691",
      "toExternalId": "way/588074294",
      "nominalKv": 132,
      "lengthKm": 38.83,
      "operator": "Arva",
      "path": [
        [
          14.150706,
          66.971651
        ],
        [
          14.182143,
          66.978222
        ],
        [
          14.216212,
          66.989954
        ],
        [
          14.24113,
          67.002803
        ],
        [
          14.25261,
          67.021909
        ],
        [
          14.274877,
          67.039609
        ],
        [
          14.298524,
          67.056359
        ],
        [
          14.340119,
          67.070692
        ],
        [
          14.387965,
          67.080476
        ],
        [
          14.41123,
          67.100814
        ],
        [
          14.415076,
          67.118295
        ],
        [
          14.414709,
          67.14063
        ],
        [
          14.435735,
          67.156435
        ],
        [
          14.457005,
          67.176369
        ],
        [
          14.492702,
          67.197187
        ],
        [
          14.544987,
          67.209543
        ],
        [
          14.599092,
          67.213022
        ],
        [
          14.650821,
          67.217205
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvænangen - Nordreisa 1|line/0",
      "name": "Kvænangen - Nordreisa 1",
      "category": "line",
      "fromExternalId": "relation/8280181",
      "toExternalId": "relation/8280502",
      "nominalKv": 132,
      "lengthKm": 38.53,
      "operator": "Statnett",
      "path": [
        [
          22.053632,
          69.720073
        ],
        [
          22.006106,
          69.724833
        ],
        [
          21.959798,
          69.733727
        ],
        [
          21.930878,
          69.750265
        ],
        [
          21.902028,
          69.765865
        ],
        [
          21.84685,
          69.772302
        ],
        [
          21.793123,
          69.773523
        ],
        [
          21.738505,
          69.768039
        ],
        [
          21.695327,
          69.760755
        ],
        [
          21.641119,
          69.730573
        ],
        [
          21.596447,
          69.707704
        ],
        [
          21.546024,
          69.692987
        ],
        [
          21.503396,
          69.680509
        ],
        [
          21.461897,
          69.668336
        ],
        [
          21.431494,
          69.656098
        ],
        [
          21.390813,
          69.64336
        ],
        [
          21.344038,
          69.634928
        ],
        [
          21.317843,
          69.622467
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Bardufoss - Mestervik 2|line/0",
      "name": "Bardufoss - Mestervik 2",
      "category": "line",
      "fromExternalId": "way/572898618",
      "toExternalId": "way/586502774",
      "nominalKv": 132,
      "lengthKm": 38.2,
      "operator": "Arva",
      "path": [
        [
          18.593443,
          69.034406
        ],
        [
          18.616778,
          69.057943
        ],
        [
          18.621445,
          69.075038
        ],
        [
          18.631018,
          69.096344
        ],
        [
          18.630999,
          69.117093
        ],
        [
          18.623553,
          69.138281
        ],
        [
          18.61599,
          69.159668
        ],
        [
          18.601461,
          69.178337
        ],
        [
          18.629758,
          69.19039
        ],
        [
          18.664728,
          69.203529
        ],
        [
          18.671715,
          69.22031
        ],
        [
          18.688125,
          69.236621
        ],
        [
          18.711728,
          69.254439
        ],
        [
          18.734613,
          69.272448
        ],
        [
          18.772706,
          69.288578
        ],
        [
          18.806856,
          69.301749
        ],
        [
          18.846912,
          69.315592
        ],
        [
          18.882885,
          69.337764
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Bardufoss - Mestervik 1|line/0",
      "name": "Bardufoss - Mestervik 1",
      "category": "line",
      "fromExternalId": "way/572898618",
      "toExternalId": "way/586502774",
      "nominalKv": 132,
      "lengthKm": 37.72,
      "operator": "Arva",
      "path": [
        [
          18.593671,
          69.034396
        ],
        [
          18.621649,
          69.048492
        ],
        [
          18.633274,
          69.066037
        ],
        [
          18.639228,
          69.085912
        ],
        [
          18.635216,
          69.103405
        ],
        [
          18.628381,
          69.126186
        ],
        [
          18.620818,
          69.147627
        ],
        [
          18.614107,
          69.166681
        ],
        [
          18.644689,
          69.190149
        ],
        [
          18.667794,
          69.208816
        ],
        [
          18.67767,
          69.227413
        ],
        [
          18.701075,
          69.245634
        ],
        [
          18.720376,
          69.264424
        ],
        [
          18.750631,
          69.278761
        ],
        [
          18.787082,
          69.294187
        ],
        [
          18.827181,
          69.308348
        ],
        [
          18.860983,
          69.320012
        ],
        [
          18.883,
          69.337844
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Hopen - Valljord|line/0",
      "name": "Hopen - Valljord",
      "category": "line",
      "fromExternalId": "relation/8296015",
      "toExternalId": "relation/8297300",
      "nominalKv": 132,
      "lengthKm": 37.47,
      "operator": "Arva",
      "path": [
        [
          15.552993,
          67.340333
        ],
        [
          15.511086,
          67.349405
        ],
        [
          15.464142,
          67.349174
        ],
        [
          15.424681,
          67.342649
        ],
        [
          15.378129,
          67.340909
        ],
        [
          15.326335,
          67.339737
        ],
        [
          15.279579,
          67.339069
        ],
        [
          15.220249,
          67.337852
        ],
        [
          15.169228,
          67.335407
        ],
        [
          15.114629,
          67.330187
        ],
        [
          15.061655,
          67.325257
        ],
        [
          15.010902,
          67.321177
        ],
        [
          14.973625,
          67.304314
        ],
        [
          14.932362,
          67.29606
        ],
        [
          14.881432,
          67.300439
        ],
        [
          14.830757,
          67.307832
        ],
        [
          14.784685,
          67.315578
        ],
        [
          14.738878,
          67.319587
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Straumsmo - Bardufoss|line/1",
      "name": "Straumsmo - Bardufoss",
      "category": "line",
      "fromExternalId": "way/587053918",
      "toExternalId": "way/572898618",
      "nominalKv": 132,
      "lengthKm": 37.38,
      "operator": "Arva",
      "path": [
        [
          18.651831,
          68.740673
        ],
        [
          18.616985,
          68.744682
        ],
        [
          18.592579,
          68.755927
        ],
        [
          18.564046,
          68.778127
        ],
        [
          18.555208,
          68.796702
        ],
        [
          18.523247,
          68.815247
        ],
        [
          18.488848,
          68.830787
        ],
        [
          18.454784,
          68.854296
        ],
        [
          18.433481,
          68.874662
        ],
        [
          18.424008,
          68.886818
        ],
        [
          18.429624,
          68.904416
        ],
        [
          18.465727,
          68.918973
        ],
        [
          18.489298,
          68.934506
        ],
        [
          18.498654,
          68.954981
        ],
        [
          18.516909,
          68.972083
        ],
        [
          18.537347,
          68.990398
        ],
        [
          18.552121,
          69.011237
        ],
        [
          18.586297,
          69.031595
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Straumsmo - Bardufoss|line/0",
      "name": "Straumsmo - Bardufoss",
      "category": "line",
      "fromExternalId": "way/587053918",
      "toExternalId": "way/572898618",
      "nominalKv": 132,
      "lengthKm": 37.31,
      "operator": "Arva",
      "path": [
        [
          18.651742,
          68.740747
        ],
        [
          18.617594,
          68.744759
        ],
        [
          18.593202,
          68.755927
        ],
        [
          18.564604,
          68.778168
        ],
        [
          18.557775,
          68.795106
        ],
        [
          18.530513,
          68.812779
        ],
        [
          18.489357,
          68.830882
        ],
        [
          18.459612,
          68.850557
        ],
        [
          18.436561,
          68.872245
        ],
        [
          18.424603,
          68.886779
        ],
        [
          18.43015,
          68.904308
        ],
        [
          18.459885,
          68.915965
        ],
        [
          18.491278,
          68.937151
        ],
        [
          18.500542,
          68.958218
        ],
        [
          18.517408,
          68.971976
        ],
        [
          18.537916,
          68.990354
        ],
        [
          18.552636,
          69.011137
        ],
        [
          18.586746,
          69.031445
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Alta kraftverk - Alta trafo|line/0",
      "name": "Alta kraftverk - Alta trafo",
      "category": "line",
      "fromExternalId": "relation/8276522",
      "toExternalId": "relation/8278085",
      "nominalKv": 132,
      "lengthKm": 32.47,
      "operator": "Statnett",
      "path": [
        [
          23.802054,
          69.719652
        ],
        [
          23.823992,
          69.72596
        ],
        [
          23.823085,
          69.740053
        ],
        [
          23.789901,
          69.757998
        ],
        [
          23.760381,
          69.773939
        ],
        [
          23.733521,
          69.788415
        ],
        [
          23.707654,
          69.801794
        ],
        [
          23.67381,
          69.81275
        ],
        [
          23.640867,
          69.823379
        ],
        [
          23.598703,
          69.836974
        ],
        [
          23.557472,
          69.85023
        ],
        [
          23.514208,
          69.865149
        ],
        [
          23.480414,
          69.880723
        ],
        [
          23.454695,
          69.892558
        ],
        [
          23.422267,
          69.907468
        ],
        [
          23.402837,
          69.921987
        ],
        [
          23.387653,
          69.936018
        ],
        [
          23.373927,
          69.951284
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Leirpollen - Varangerbotn|line/0",
      "name": "Leirpollen - Varangerbotn",
      "category": "line",
      "fromExternalId": "way/671990787",
      "toExternalId": "way/257192868",
      "nominalKv": 132,
      "lengthKm": 30.35,
      "operator": "Barents Nett",
      "path": [
        [
          28.521295,
          70.426658
        ],
        [
          28.494935,
          70.41649
        ],
        [
          28.472711,
          70.403319
        ],
        [
          28.452978,
          70.393514
        ],
        [
          28.438025,
          70.371982
        ],
        [
          28.434394,
          70.359032
        ],
        [
          28.419871,
          70.34127
        ],
        [
          28.417572,
          70.326078
        ],
        [
          28.415104,
          70.309742
        ],
        [
          28.416855,
          70.294492
        ],
        [
          28.422851,
          70.278051
        ],
        [
          28.428579,
          70.262317
        ],
        [
          28.434495,
          70.246042
        ],
        [
          28.451493,
          70.232101
        ],
        [
          28.477423,
          70.216239
        ],
        [
          28.498575,
          70.203279
        ],
        [
          28.523745,
          70.187833
        ],
        [
          28.540099,
          70.172813
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skjomen - Ballangen|line/0",
      "name": "Skjomen - Ballangen",
      "category": "line",
      "fromExternalId": "way/968741818",
      "toExternalId": "way/587726948",
      "nominalKv": 132,
      "lengthKm": 29.56,
      "operator": "Statnett",
      "path": [
        [
          17.359845,
          68.203678
        ],
        [
          17.324973,
          68.190225
        ],
        [
          17.27117,
          68.183827
        ],
        [
          17.218497,
          68.182834
        ],
        [
          17.191147,
          68.182252
        ],
        [
          17.156758,
          68.181015
        ],
        [
          17.139299,
          68.183458
        ],
        [
          17.10906,
          68.188041
        ],
        [
          17.075291,
          68.195723
        ],
        [
          17.049722,
          68.202683
        ],
        [
          17.023876,
          68.21542
        ],
        [
          16.996247,
          68.223357
        ],
        [
          16.954782,
          68.232841
        ],
        [
          16.907015,
          68.243857
        ],
        [
          16.841993,
          68.248175
        ],
        [
          16.808535,
          68.250371
        ],
        [
          16.763211,
          68.253358
        ],
        [
          16.733087,
          68.261156
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Sjona - Langvatn|line/0",
      "name": "Sjona - Langvatn",
      "category": "line",
      "fromExternalId": "way/588985297",
      "toExternalId": "relation/11636421",
      "nominalKv": 132,
      "lengthKm": 29.45,
      "operator": "Linea",
      "path": [
        [
          13.562202,
          66.311256
        ],
        [
          13.591552,
          66.305022
        ],
        [
          13.625254,
          66.300559
        ],
        [
          13.665259,
          66.301238
        ],
        [
          13.701885,
          66.30391
        ],
        [
          13.743113,
          66.309641
        ],
        [
          13.777966,
          66.314496
        ],
        [
          13.819031,
          66.320183
        ],
        [
          13.855804,
          66.324308
        ],
        [
          13.893987,
          66.326903
        ],
        [
          13.933529,
          66.33008
        ],
        [
          13.968349,
          66.333158
        ],
        [
          14.008116,
          66.337568
        ],
        [
          14.042716,
          66.342377
        ],
        [
          14.079237,
          66.349606
        ],
        [
          14.114556,
          66.353959
        ],
        [
          14.1467,
          66.34963
        ],
        [
          14.166562,
          66.336796
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Ballangen - Lødingen|line/0",
      "name": "Ballangen - Lødingen",
      "category": "line",
      "fromExternalId": "way/587726948",
      "toExternalId": "way/953796939",
      "nominalKv": 132,
      "lengthKm": 29.38,
      "operator": "Statnett",
      "path": [
        [
          16.73266,
          68.261098
        ],
        [
          16.707147,
          68.270128
        ],
        [
          16.673309,
          68.282494
        ],
        [
          16.64168,
          68.294244
        ],
        [
          16.619933,
          68.301952
        ],
        [
          16.591904,
          68.309618
        ],
        [
          16.551764,
          68.317434
        ],
        [
          16.511502,
          68.324024
        ],
        [
          16.483137,
          68.325591
        ],
        [
          16.454727,
          68.328195
        ],
        [
          16.390513,
          68.334168
        ],
        [
          16.344483,
          68.338438
        ],
        [
          16.307302,
          68.340532
        ],
        [
          16.264079,
          68.336984
        ],
        [
          16.216915,
          68.339986
        ],
        [
          16.170467,
          68.346648
        ],
        [
          16.128509,
          68.351889
        ],
        [
          16.095662,
          68.355454
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Nordreisa - Guolášjohka 2|line/0",
      "name": "Nordreisa - Guolášjohka 2",
      "category": "line",
      "fromExternalId": "way/572898605",
      "toExternalId": "relation/8280502",
      "nominalKv": 132,
      "lengthKm": 29.27,
      "operator": "Statnett",
      "path": [
        [
          20.925946,
          69.469931
        ],
        [
          20.966983,
          69.473928
        ],
        [
          20.999186,
          69.475609
        ],
        [
          21.040846,
          69.478885
        ],
        [
          21.080291,
          69.490803
        ],
        [
          21.12054,
          69.49865
        ],
        [
          21.155661,
          69.4984
        ],
        [
          21.199112,
          69.498081
        ],
        [
          21.239629,
          69.494918
        ],
        [
          21.278098,
          69.500732
        ],
        [
          21.305494,
          69.508876
        ],
        [
          21.313294,
          69.522152
        ],
        [
          21.315633,
          69.538218
        ],
        [
          21.317264,
          69.553528
        ],
        [
          21.317261,
          69.570559
        ],
        [
          21.317232,
          69.588557
        ],
        [
          21.317205,
          69.607228
        ],
        [
          21.314987,
          69.622165
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Nordreisa - Guolášjohka 1|line/0",
      "name": "Nordreisa - Guolášjohka 1",
      "category": "line",
      "fromExternalId": "way/572898605",
      "toExternalId": "relation/8280502",
      "nominalKv": 132,
      "lengthKm": 29.19,
      "operator": "Statnett",
      "path": [
        [
          20.925946,
          69.469931
        ],
        [
          20.966125,
          69.474083
        ],
        [
          20.998269,
          69.475853
        ],
        [
          21.036828,
          69.478024
        ],
        [
          21.075119,
          69.489592
        ],
        [
          21.127878,
          69.498872
        ],
        [
          21.178347,
          69.498496
        ],
        [
          21.220431,
          69.494798
        ],
        [
          21.252633,
          69.495448
        ],
        [
          21.284578,
          69.503006
        ],
        [
          21.309273,
          69.510346
        ],
        [
          21.314152,
          69.523779
        ],
        [
          21.316583,
          69.540341
        ],
        [
          21.317902,
          69.558184
        ],
        [
          21.317892,
          69.574016
        ],
        [
          21.317875,
          69.590677
        ],
        [
          21.317854,
          69.607172
        ],
        [
          21.317843,
          69.622467
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Mestervik - Håkøybotn - Kvaløya|line/0",
      "name": "Mestervik - Håkøybotn - Kvaløya",
      "category": "line",
      "fromExternalId": "way/586502774",
      "toExternalId": "relation/8280921",
      "nominalKv": 132,
      "lengthKm": 28.78,
      "operator": "Arva",
      "path": [
        [
          18.883229,
          69.338004
        ],
        [
          18.852786,
          69.345543
        ],
        [
          18.824046,
          69.355613
        ],
        [
          18.801593,
          69.366699
        ],
        [
          18.779272,
          69.377938
        ],
        [
          18.762073,
          69.393356
        ],
        [
          18.751825,
          69.408933
        ],
        [
          18.741856,
          69.42395
        ],
        [
          18.749912,
          69.439493
        ],
        [
          18.780712,
          69.450972
        ],
        [
          18.821431,
          69.459494
        ],
        [
          18.845388,
          69.470231
        ],
        [
          18.834128,
          69.482359
        ],
        [
          18.818003,
          69.496794
        ],
        [
          18.818998,
          69.511082
        ],
        [
          18.820358,
          69.526365
        ],
        [
          18.827026,
          69.541574
        ],
        [
          18.814087,
          69.556938
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Hinnøy - Risøyhamn|line/4",
      "name": "Hinnøy - Risøyhamn",
      "category": "line",
      "fromExternalId": "way/179044834",
      "toExternalId": "way/163116969",
      "nominalKv": 132,
      "lengthKm": 28.69,
      "operator": "Noranett",
      "path": [
        [
          15.673054,
          68.720495
        ],
        [
          15.691628,
          68.730988
        ],
        [
          15.702384,
          68.748087
        ],
        [
          15.714148,
          68.763966
        ],
        [
          15.712557,
          68.780425
        ],
        [
          15.709348,
          68.796969
        ],
        [
          15.705715,
          68.812267
        ],
        [
          15.703399,
          68.826957
        ],
        [
          15.703025,
          68.841572
        ],
        [
          15.691474,
          68.857084
        ],
        [
          15.671107,
          68.870977
        ],
        [
          15.65187,
          68.885992
        ],
        [
          15.667606,
          68.898073
        ],
        [
          15.691298,
          68.910036
        ],
        [
          15.688828,
          68.922096
        ],
        [
          15.683409,
          68.936237
        ],
        [
          15.667303,
          68.948525
        ],
        [
          15.651096,
          68.960547
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Nesna - Sjona|line/0",
      "name": "Nesna - Sjona",
      "category": "line",
      "fromExternalId": "way/588985297",
      "toExternalId": "way/589009876",
      "nominalKv": 132,
      "lengthKm": 28.58,
      "operator": "Linea",
      "path": [
        [
          13.561734,
          66.311112
        ],
        [
          13.541218,
          66.305612
        ],
        [
          13.49771,
          66.301752
        ],
        [
          13.4633,
          66.296297
        ],
        [
          13.423949,
          66.295674
        ],
        [
          13.386691,
          66.296619
        ],
        [
          13.350894,
          66.295148
        ],
        [
          13.317111,
          66.290614
        ],
        [
          13.281875,
          66.284043
        ],
        [
          13.253296,
          66.274209
        ],
        [
          13.220673,
          66.266919
        ],
        [
          13.192342,
          66.257145
        ],
        [
          13.169442,
          66.244917
        ],
        [
          13.141588,
          66.235667
        ],
        [
          13.112569,
          66.223582
        ],
        [
          13.079701,
          66.213867
        ],
        [
          13.054,
          66.2057
        ],
        [
          13.039653,
          66.197075
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elmea|Kleppstad - Fygle|line/1",
      "name": "Kleppstad - Fygle",
      "category": "line",
      "fromExternalId": "way/587348300",
      "toExternalId": "way/587356986",
      "nominalKv": 132,
      "lengthKm": 27.36,
      "operator": "Elmea",
      "path": [
        [
          14.150509,
          68.268493
        ],
        [
          14.118826,
          68.26838
        ],
        [
          14.075455,
          68.265939
        ],
        [
          14.040957,
          68.256958
        ],
        [
          14.002789,
          68.252272
        ],
        [
          13.964945,
          68.249326
        ],
        [
          13.928389,
          68.247559
        ],
        [
          13.891262,
          68.245799
        ],
        [
          13.855798,
          68.242425
        ],
        [
          13.823531,
          68.239273
        ],
        [
          13.7856,
          68.230535
        ],
        [
          13.758649,
          68.22085
        ],
        [
          13.735539,
          68.210422
        ],
        [
          13.706625,
          68.200824
        ],
        [
          13.677791,
          68.191854
        ],
        [
          13.655979,
          68.182404
        ],
        [
          13.646527,
          68.166951
        ],
        [
          13.641946,
          68.153123
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elmea|Kleppstad - Fygle|line/2",
      "name": "Kleppstad - Fygle",
      "category": "line",
      "fromExternalId": "way/587348300",
      "toExternalId": "way/587356986",
      "nominalKv": 132,
      "lengthKm": 27.25,
      "operator": "Elmea",
      "path": [
        [
          14.120024,
          68.227596
        ],
        [
          14.093658,
          68.23001
        ],
        [
          14.050459,
          68.230533
        ],
        [
          14.027127,
          68.237438
        ],
        [
          13.995515,
          68.249966
        ],
        [
          13.963843,
          68.249089
        ],
        [
          13.928406,
          68.247374
        ],
        [
          13.891077,
          68.243629
        ],
        [
          13.852794,
          68.241892
        ],
        [
          13.817427,
          68.238475
        ],
        [
          13.786131,
          68.230261
        ],
        [
          13.7622,
          68.222268
        ],
        [
          13.744849,
          68.207604
        ],
        [
          13.706984,
          68.200669
        ],
        [
          13.678381,
          68.191692
        ],
        [
          13.658597,
          68.182859
        ],
        [
          13.651568,
          68.167097
        ],
        [
          13.643551,
          68.152895
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kirkenes - Neiden|line/3",
      "name": "Kirkenes - Neiden",
      "category": "line",
      "fromExternalId": "relation/8269872",
      "toExternalId": "way/585733410",
      "nominalKv": 132,
      "lengthKm": 26.59,
      "operator": "Statnett",
      "path": [
        [
          29.913852,
          69.675098
        ],
        [
          29.872196,
          69.670696
        ],
        [
          29.83618,
          69.666237
        ],
        [
          29.797373,
          69.662777
        ],
        [
          29.758948,
          69.66087
        ],
        [
          29.726976,
          69.659949
        ],
        [
          29.68479,
          69.65648
        ],
        [
          29.644638,
          69.653774
        ],
        [
          29.606491,
          69.651187
        ],
        [
          29.565826,
          69.647337
        ],
        [
          29.531336,
          69.643392
        ],
        [
          29.491183,
          69.639661
        ],
        [
          29.452597,
          69.641768
        ],
        [
          29.427486,
          69.653452
        ],
        [
          29.406903,
          69.664705
        ],
        [
          29.388503,
          69.67849
        ],
        [
          29.364073,
          69.688812
        ],
        [
          29.349893,
          69.703526
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Håkøybotn - Tverråsen|line/0",
      "name": "Håkøybotn - Tverråsen",
      "category": "line",
      "fromExternalId": "way/586667770",
      "toExternalId": "way/1158040166",
      "nominalKv": 132,
      "lengthKm": 26.57,
      "operator": "Arva",
      "path": [
        [
          18.699824,
          69.623138
        ],
        [
          18.667424,
          69.611099
        ],
        [
          18.650217,
          69.601973
        ],
        [
          18.634328,
          69.589693
        ],
        [
          18.614037,
          69.573983
        ],
        [
          18.590664,
          69.561482
        ],
        [
          18.563917,
          69.5527
        ],
        [
          18.520814,
          69.54898
        ],
        [
          18.482638,
          69.547387
        ],
        [
          18.451291,
          69.544601
        ],
        [
          18.406413,
          69.542625
        ],
        [
          18.365836,
          69.541078
        ],
        [
          18.324139,
          69.541566
        ],
        [
          18.278841,
          69.544709
        ],
        [
          18.243541,
          69.549768
        ],
        [
          18.212301,
          69.554236
        ],
        [
          18.178744,
          69.559859
        ],
        [
          18.15097,
          69.566335
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lucerna|Skaidi - (Kvalsund) - Hyggevatn|line/0",
      "name": "Skaidi - (Kvalsund) - Hyggevatn",
      "category": "line",
      "fromExternalId": "relation/8277461",
      "toExternalId": "way/511117400",
      "nominalKv": 132,
      "lengthKm": 26.4,
      "operator": "Lucerna",
      "path": [
        [
          23.928534,
          70.515037
        ],
        [
          23.887432,
          70.509729
        ],
        [
          23.852316,
          70.514718
        ],
        [
          23.809996,
          70.518021
        ],
        [
          23.776506,
          70.527018
        ],
        [
          23.748182,
          70.538544
        ],
        [
          23.726322,
          70.553135
        ],
        [
          23.709596,
          70.56485
        ],
        [
          23.698341,
          70.576809
        ],
        [
          23.692253,
          70.59038
        ],
        [
          23.704998,
          70.601617
        ],
        [
          23.720325,
          70.615413
        ],
        [
          23.703625,
          70.627531
        ],
        [
          23.687478,
          70.639076
        ],
        [
          23.708298,
          70.648942
        ],
        [
          23.730168,
          70.66258
        ],
        [
          23.74719,
          70.671907
        ],
        [
          23.726986,
          70.680289
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skjomen - Narvik|line/1",
      "name": "Skjomen - Narvik",
      "category": "line",
      "fromExternalId": "way/968741818",
      "toExternalId": "relation/8292614",
      "nominalKv": 132,
      "lengthKm": 24.39,
      "operator": "Statnett",
      "path": [
        [
          17.361805,
          68.204121
        ],
        [
          17.389708,
          68.204531
        ],
        [
          17.413317,
          68.215392
        ],
        [
          17.442655,
          68.229068
        ],
        [
          17.437245,
          68.243378
        ],
        [
          17.432631,
          68.255561
        ],
        [
          17.42738,
          68.263362
        ],
        [
          17.407236,
          68.276099
        ],
        [
          17.385038,
          68.290121
        ],
        [
          17.370195,
          68.306497
        ],
        [
          17.383767,
          68.312096
        ],
        [
          17.406598,
          68.318384
        ],
        [
          17.415664,
          68.328214
        ],
        [
          17.418024,
          68.339045
        ],
        [
          17.420905,
          68.352383
        ],
        [
          17.424483,
          68.368759
        ],
        [
          17.444025,
          68.38189
        ],
        [
          17.455807,
          68.389162
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Bardufoss - Sørreisa|line/0",
      "name": "Bardufoss - Sørreisa",
      "category": "line",
      "fromExternalId": "way/572898618",
      "toExternalId": "relation/8285302",
      "nominalKv": 132,
      "lengthKm": 23.6,
      "operator": "Arva",
      "path": [
        [
          18.592532,
          69.034448
        ],
        [
          18.589854,
          69.046307
        ],
        [
          18.587086,
          69.058183
        ],
        [
          18.551225,
          69.065228
        ],
        [
          18.530111,
          69.068964
        ],
        [
          18.503047,
          69.070711
        ],
        [
          18.469225,
          69.072911
        ],
        [
          18.431145,
          69.076217
        ],
        [
          18.39364,
          69.079496
        ],
        [
          18.367964,
          69.086027
        ],
        [
          18.348146,
          69.094493
        ],
        [
          18.313758,
          69.105301
        ],
        [
          18.286888,
          69.113729
        ],
        [
          18.257392,
          69.122987
        ],
        [
          18.232128,
          69.130962
        ],
        [
          18.212765,
          69.140197
        ],
        [
          18.198042,
          69.150541
        ],
        [
          18.171628,
          69.15919
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lucerna|Skaidi - (Kvalsund) - Hyggevatn|line/3",
      "name": "Skaidi - (Kvalsund) - Hyggevatn",
      "category": "line",
      "fromExternalId": "relation/8277461",
      "toExternalId": "way/586116281",
      "nominalKv": 132,
      "lengthKm": 23.58,
      "operator": "Lucerna",
      "path": [
        [
          23.969993,
          70.48827
        ],
        [
          23.998261,
          70.493143
        ],
        [
          24.038456,
          70.494085
        ],
        [
          24.073094,
          70.494368
        ],
        [
          24.108505,
          70.488881
        ],
        [
          24.139672,
          70.483797
        ],
        [
          24.179744,
          70.477254
        ],
        [
          24.211775,
          70.472015
        ],
        [
          24.23088,
          70.464954
        ],
        [
          24.256885,
          70.456625
        ],
        [
          24.285831,
          70.450405
        ],
        [
          24.322266,
          70.443735
        ],
        [
          24.36546,
          70.440578
        ],
        [
          24.403709,
          70.439256
        ],
        [
          24.443432,
          70.435965
        ],
        [
          24.474283,
          70.430525
        ],
        [
          24.503154,
          70.427887
        ],
        [
          24.541608,
          70.432338
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lucerna|Kvalsund - Skaidi|line/0",
      "name": "Kvalsund - Skaidi",
      "category": "line",
      "fromExternalId": "relation/8277461",
      "toExternalId": "way/586116281",
      "nominalKv": 132,
      "lengthKm": 23.58,
      "operator": "Lucerna",
      "path": [
        [
          23.970144,
          70.488118
        ],
        [
          23.993288,
          70.492826
        ],
        [
          24.038472,
          70.493892
        ],
        [
          24.069677,
          70.494612
        ],
        [
          24.104653,
          70.489287
        ],
        [
          24.135037,
          70.484337
        ],
        [
          24.173948,
          70.477996
        ],
        [
          24.204791,
          70.472942
        ],
        [
          24.228225,
          70.465663
        ],
        [
          24.255594,
          70.456694
        ],
        [
          24.28538,
          70.450286
        ],
        [
          24.324589,
          70.443383
        ],
        [
          24.365358,
          70.440402
        ],
        [
          24.403558,
          70.439083
        ],
        [
          24.44318,
          70.435806
        ],
        [
          24.476541,
          70.429808
        ],
        [
          24.50861,
          70.428263
        ],
        [
          24.541812,
          70.432213
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Smibelg - Sjona|line/0",
      "name": "Smibelg - Sjona",
      "category": "line",
      "fromExternalId": "way/1050275156",
      "toExternalId": "way/588985297",
      "nominalKv": 132,
      "lengthKm": 23.28,
      "operator": "Arva",
      "path": [
        [
          13.339144,
          66.459906
        ],
        [
          13.365056,
          66.46474
        ],
        [
          13.395306,
          66.46939
        ],
        [
          13.422493,
          66.471866
        ],
        [
          13.450382,
          66.476461
        ],
        [
          13.472848,
          66.473208
        ],
        [
          13.48663,
          66.46037
        ],
        [
          13.48903,
          66.448355
        ],
        [
          13.488784,
          66.436906
        ],
        [
          13.470681,
          66.427985
        ],
        [
          13.450787,
          66.419925
        ],
        [
          13.432849,
          66.412293
        ],
        [
          13.423772,
          66.401039
        ],
        [
          13.436412,
          66.390205
        ],
        [
          13.444255,
          66.378123
        ],
        [
          13.430636,
          66.366891
        ],
        [
          13.430975,
          66.354719
        ],
        [
          13.461503,
          66.346597
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lucerna|Hammerfest - Kvalsund|line/0",
      "name": "Hammerfest - Kvalsund",
      "category": "line",
      "fromExternalId": "way/586152359",
      "toExternalId": "relation/8277461",
      "nominalKv": 132,
      "lengthKm": 22.79,
      "operator": "Lucerna",
      "path": [
        [
          23.714496,
          70.656769
        ],
        [
          23.705685,
          70.64837
        ],
        [
          23.686942,
          70.63804
        ],
        [
          23.701528,
          70.628501
        ],
        [
          23.716564,
          70.618737
        ],
        [
          23.718367,
          70.606673
        ],
        [
          23.694913,
          70.5961
        ],
        [
          23.692993,
          70.586545
        ],
        [
          23.700106,
          70.573409
        ],
        [
          23.711135,
          70.563011
        ],
        [
          23.725855,
          70.55305
        ],
        [
          23.744207,
          70.540798
        ],
        [
          23.766496,
          70.530596
        ],
        [
          23.79253,
          70.520572
        ],
        [
          23.828332,
          70.516413
        ],
        [
          23.860567,
          70.513891
        ],
        [
          23.895473,
          70.50989
        ],
        [
          23.925911,
          70.514603
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Bardufoss kraftverk - Sørreisa|line/0",
      "name": "Bardufoss kraftverk - Sørreisa",
      "category": "line",
      "fromExternalId": "relation/8283263",
      "toExternalId": "relation/8285302",
      "nominalKv": 132,
      "lengthKm": 22.59,
      "operator": "Arva",
      "path": [
        [
          18.589845,
          69.043392
        ],
        [
          18.590663,
          69.053503
        ],
        [
          18.56985,
          69.061778
        ],
        [
          18.533002,
          69.068601
        ],
        [
          18.50548,
          69.07096
        ],
        [
          18.472985,
          69.072723
        ],
        [
          18.444672,
          69.075184
        ],
        [
          18.404846,
          69.078655
        ],
        [
          18.379737,
          69.081833
        ],
        [
          18.359812,
          69.090124
        ],
        [
          18.335781,
          69.098557
        ],
        [
          18.305983,
          69.107921
        ],
        [
          18.28074,
          69.115837
        ],
        [
          18.254777,
          69.124008
        ],
        [
          18.229457,
          69.131987
        ],
        [
          18.210786,
          69.142797
        ],
        [
          18.196224,
          69.151894
        ],
        [
          18.17192,
          69.159279
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Balsfjord - Mestervik|line/0",
      "name": "Balsfjord - Mestervik",
      "category": "line",
      "fromExternalId": "way/572898616",
      "toExternalId": "way/586502774",
      "nominalKv": 132,
      "lengthKm": 22.48,
      "operator": "Statnett",
      "path": [
        [
          19.207578,
          69.19149
        ],
        [
          19.192584,
          69.202996
        ],
        [
          19.174082,
          69.2096
        ],
        [
          19.156492,
          69.222388
        ],
        [
          19.14799,
          69.230967
        ],
        [
          19.125314,
          69.239603
        ],
        [
          19.099887,
          69.246326
        ],
        [
          19.078853,
          69.251883
        ],
        [
          19.051773,
          69.265062
        ],
        [
          19.052814,
          69.275362
        ],
        [
          19.054263,
          69.289602
        ],
        [
          19.052605,
          69.299626
        ],
        [
          19.03501,
          69.310147
        ],
        [
          19.01437,
          69.319666
        ],
        [
          18.988806,
          69.32541
        ],
        [
          18.948374,
          69.332351
        ],
        [
          18.920367,
          69.334897
        ],
        [
          18.891209,
          69.337535
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Melbu - (Stokmarknes) - Sortland|line/0",
      "name": "Melbu - (Stokmarknes) - Sortland",
      "category": "line",
      "fromExternalId": "way/1156216252",
      "toExternalId": "relation/8289305",
      "nominalKv": 132,
      "lengthKm": 22.15,
      "operator": "Statnett",
      "path": [
        [
          15.040672,
          68.585421
        ],
        [
          15.04966,
          68.596485
        ],
        [
          15.071348,
          68.607204
        ],
        [
          15.097666,
          68.612861
        ],
        [
          15.12171,
          68.618032
        ],
        [
          15.15219,
          68.624567
        ],
        [
          15.181909,
          68.631015
        ],
        [
          15.215319,
          68.6383
        ],
        [
          15.225897,
          68.645083
        ],
        [
          15.232835,
          68.65884
        ],
        [
          15.233762,
          68.671066
        ],
        [
          15.233692,
          68.681407
        ],
        [
          15.243444,
          68.690388
        ],
        [
          15.264189,
          68.695936
        ],
        [
          15.292314,
          68.701868
        ],
        [
          15.326486,
          68.703999
        ],
        [
          15.359064,
          68.707068
        ],
        [
          15.38503,
          68.711883
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Boltås - Kanstadbotn|line/1",
      "name": "Boltås - Kanstadbotn",
      "category": "line",
      "fromExternalId": "way/1156551462",
      "toExternalId": "relation/8288539",
      "nominalKv": 132,
      "lengthKm": 21.12,
      "operator": "Statnett",
      "path": [
        [
          16.662673,
          68.530879
        ],
        [
          16.641391,
          68.52678
        ],
        [
          16.620341,
          68.522186
        ],
        [
          16.599369,
          68.517604
        ],
        [
          16.572941,
          68.511824
        ],
        [
          16.550849,
          68.509202
        ],
        [
          16.521819,
          68.50575
        ],
        [
          16.50201,
          68.50302
        ],
        [
          16.467533,
          68.505435
        ],
        [
          16.439446,
          68.50623
        ],
        [
          16.403443,
          68.514486
        ],
        [
          16.378174,
          68.519245
        ],
        [
          16.343654,
          68.521647
        ],
        [
          16.319374,
          68.523332
        ],
        [
          16.281753,
          68.522173
        ],
        [
          16.249377,
          68.517879
        ],
        [
          16.208108,
          68.514576
        ],
        [
          16.179857,
          68.512377
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Fauske - Rognan|line/1",
      "name": "Fauske - Rognan",
      "category": "line",
      "fromExternalId": "relation/8296010",
      "toExternalId": "relation/8298078",
      "nominalKv": 132,
      "lengthKm": 20.78,
      "operator": "Arva",
      "path": [
        [
          15.419366,
          67.271224
        ],
        [
          15.436864,
          67.274761
        ],
        [
          15.462026,
          67.268462
        ],
        [
          15.485235,
          67.262888
        ],
        [
          15.488494,
          67.252029
        ],
        [
          15.49065,
          67.23922
        ],
        [
          15.499558,
          67.229208
        ],
        [
          15.49628,
          67.216449
        ],
        [
          15.492678,
          67.206494
        ],
        [
          15.495339,
          67.19377
        ],
        [
          15.498045,
          67.182109
        ],
        [
          15.498126,
          67.173974
        ],
        [
          15.500368,
          67.159837
        ],
        [
          15.491962,
          67.147203
        ],
        [
          15.484339,
          67.13927
        ],
        [
          15.479742,
          67.130403
        ],
        [
          15.465413,
          67.121769
        ],
        [
          15.44947,
          67.113124
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Valljord - Sjønstå|line/8",
      "name": "Valljord - Sjønstå",
      "category": "line",
      "fromExternalId": "relation/8296015",
      "toExternalId": "way/587922055",
      "nominalKv": 132,
      "lengthKm": 20.36,
      "operator": "Arva",
      "path": [
        [
          15.553183,
          67.34039
        ],
        [
          15.545893,
          67.33336
        ],
        [
          15.539147,
          67.324182
        ],
        [
          15.526696,
          67.316715
        ],
        [
          15.510957,
          67.309658
        ],
        [
          15.493045,
          67.301631
        ],
        [
          15.473978,
          67.29306
        ],
        [
          15.456659,
          67.28527
        ],
        [
          15.43955,
          67.277198
        ],
        [
          15.455867,
          67.270361
        ],
        [
          15.483489,
          67.263722
        ],
        [
          15.510319,
          67.257499
        ],
        [
          15.543852,
          67.249188
        ],
        [
          15.568587,
          67.245493
        ],
        [
          15.594755,
          67.243167
        ],
        [
          15.626609,
          67.240328
        ],
        [
          15.653501,
          67.237928
        ],
        [
          15.673483,
          67.233467
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Glomfjord - Sundsfjord|line/0",
      "name": "Glomfjord - Sundsfjord",
      "category": "line",
      "fromExternalId": "relation/8300691",
      "toExternalId": "relation/8301307",
      "nominalKv": 132,
      "lengthKm": 20.19,
      "operator": "Arva",
      "path": [
        [
          14.150259,
          66.971503
        ],
        [
          14.138428,
          66.960807
        ],
        [
          14.128206,
          66.951652
        ],
        [
          14.1166,
          66.93824
        ],
        [
          14.109364,
          66.923542
        ],
        [
          14.096315,
          66.909727
        ],
        [
          14.082339,
          66.899984
        ],
        [
          14.072054,
          66.890356
        ],
        [
          14.062991,
          66.879884
        ],
        [
          14.05573,
          66.871492
        ],
        [
          14.046506,
          66.861706
        ],
        [
          14.024034,
          66.856071
        ],
        [
          14.006113,
          66.852663
        ],
        [
          13.992561,
          66.845985
        ],
        [
          13.977051,
          66.838525
        ],
        [
          13.956924,
          66.830903
        ],
        [
          13.945176,
          66.825337
        ],
        [
          13.934659,
          66.817681
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Reppa - Øresvik|line/1",
      "name": "Reppa - Øresvik",
      "category": "line",
      "fromExternalId": "relation/14018338",
      "toExternalId": "way/1050275156",
      "nominalKv": 132,
      "lengthKm": 19.74,
      "operator": "Arva",
      "path": [
        [
          13.562177,
          66.64483
        ],
        [
          13.538957,
          66.642977
        ],
        [
          13.512178,
          66.641364
        ],
        [
          13.493735,
          66.638077
        ],
        [
          13.47817,
          66.632151
        ],
        [
          13.465644,
          66.624994
        ],
        [
          13.441335,
          66.618662
        ],
        [
          13.433264,
          66.607294
        ],
        [
          13.421418,
          66.596647
        ],
        [
          13.416113,
          66.585131
        ],
        [
          13.421429,
          66.576482
        ],
        [
          13.415809,
          66.567599
        ],
        [
          13.398613,
          66.562967
        ],
        [
          13.36751,
          66.56411
        ],
        [
          13.336807,
          66.563502
        ],
        [
          13.310623,
          66.558378
        ],
        [
          13.289584,
          66.553642
        ],
        [
          13.272214,
          66.55042
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elmea|Kvitfossen - Kleppstad|line/0",
      "name": "Kvitfossen - Kleppstad",
      "category": "line",
      "fromExternalId": "way/587348300",
      "toExternalId": "way/709830245",
      "nominalKv": 132,
      "lengthKm": 19.05,
      "operator": "Elmea",
      "path": [
        [
          14.282912,
          68.261886
        ],
        [
          14.292872,
          68.270476
        ],
        [
          14.309279,
          68.275019
        ],
        [
          14.334862,
          68.274141
        ],
        [
          14.356233,
          68.275669
        ],
        [
          14.36942,
          68.283537
        ],
        [
          14.391044,
          68.293033
        ],
        [
          14.408395,
          68.297575
        ],
        [
          14.443926,
          68.303592
        ],
        [
          14.468506,
          68.308643
        ],
        [
          14.489583,
          68.314626
        ],
        [
          14.513444,
          68.31794
        ],
        [
          14.541001,
          68.314134
        ],
        [
          14.56874,
          68.311044
        ],
        [
          14.595568,
          68.313001
        ],
        [
          14.614126,
          68.313943
        ],
        [
          14.63145,
          68.318695
        ],
        [
          14.650338,
          68.327579
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sulitjelma - Sjønstå 1|line/0",
      "name": "Sulitjelma - Sjønstå 1",
      "category": "line",
      "fromExternalId": "relation/8296003",
      "toExternalId": "way/587922055",
      "nominalKv": 132,
      "lengthKm": 19,
      "operator": "Arva",
      "path": [
        [
          16.077068,
          67.119694
        ],
        [
          16.059334,
          67.122567
        ],
        [
          16.032219,
          67.126192
        ],
        [
          16.016138,
          67.130269
        ],
        [
          15.997086,
          67.137911
        ],
        [
          15.983447,
          67.143466
        ],
        [
          15.970181,
          67.151189
        ],
        [
          15.947722,
          67.155192
        ],
        [
          15.926281,
          67.156541
        ],
        [
          15.901658,
          67.160974
        ],
        [
          15.881923,
          67.167214
        ],
        [
          15.857558,
          67.17048
        ],
        [
          15.833064,
          67.17161
        ],
        [
          15.80141,
          67.174925
        ],
        [
          15.775605,
          67.179678
        ],
        [
          15.749524,
          67.181302
        ],
        [
          15.720505,
          67.188474
        ],
        [
          15.704148,
          67.194261
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sulitjelma - Sjønstå 2|line/0",
      "name": "Sulitjelma - Sjønstå 2",
      "category": "line",
      "fromExternalId": "relation/8296003",
      "toExternalId": "way/587922055",
      "nominalKv": 132,
      "lengthKm": 18.89,
      "operator": "Arva",
      "path": [
        [
          16.077705,
          67.119962
        ],
        [
          16.058037,
          67.123151
        ],
        [
          16.032094,
          67.126388
        ],
        [
          16.013271,
          67.13189
        ],
        [
          15.995402,
          67.138722
        ],
        [
          15.979062,
          67.147151
        ],
        [
          15.960501,
          67.153165
        ],
        [
          15.936753,
          67.156062
        ],
        [
          15.915665,
          67.158271
        ],
        [
          15.893885,
          67.162841
        ],
        [
          15.877948,
          67.168165
        ],
        [
          15.855087,
          67.172314
        ],
        [
          15.830419,
          67.175367
        ],
        [
          15.794928,
          67.178439
        ],
        [
          15.768498,
          67.180299
        ],
        [
          15.743942,
          67.182755
        ],
        [
          15.720261,
          67.188677
        ],
        [
          15.704654,
          67.194275
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kanstadbotn - Hinnøy|line/0",
      "name": "Kanstadbotn - Hinnøy",
      "category": "line",
      "fromExternalId": "relation/8288539",
      "toExternalId": "way/179044834",
      "nominalKv": 132,
      "lengthKm": 18.81,
      "operator": "Statnett",
      "path": [
        [
          15.787662,
          68.564535
        ],
        [
          15.787936,
          68.575564
        ],
        [
          15.782794,
          68.585873
        ],
        [
          15.778363,
          68.592905
        ],
        [
          15.754859,
          68.59757
        ],
        [
          15.729262,
          68.602652
        ],
        [
          15.714381,
          68.606159
        ],
        [
          15.695343,
          68.613088
        ],
        [
          15.67072,
          68.620085
        ],
        [
          15.646599,
          68.630797
        ],
        [
          15.641141,
          68.637728
        ],
        [
          15.625734,
          68.645785
        ],
        [
          15.60587,
          68.65084
        ],
        [
          15.574968,
          68.658727
        ],
        [
          15.555509,
          68.663668
        ],
        [
          15.534571,
          68.668979
        ],
        [
          15.513731,
          68.67733
        ],
        [
          15.499939,
          68.683353
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Kobbkroken - Båtsfjord|line/0",
      "name": "Kobbkroken - Båtsfjord",
      "category": "line",
      "fromExternalId": "way/671990791",
      "toExternalId": "way/657434624",
      "nominalKv": 132,
      "lengthKm": 18.7,
      "operator": "Barents Nett",
      "path": [
        [
          29.282477,
          70.711505
        ],
        [
          29.297899,
          70.704158
        ],
        [
          29.332519,
          70.698494
        ],
        [
          29.361705,
          70.698924
        ],
        [
          29.389748,
          70.695333
        ],
        [
          29.399949,
          70.685304
        ],
        [
          29.428418,
          70.679944
        ],
        [
          29.456838,
          70.674294
        ],
        [
          29.485708,
          70.668552
        ],
        [
          29.510834,
          70.664108
        ],
        [
          29.538868,
          70.661849
        ],
        [
          29.563407,
          70.659873
        ],
        [
          29.596086,
          70.65723
        ],
        [
          29.622623,
          70.65508
        ],
        [
          29.650816,
          70.651983
        ],
        [
          29.67599,
          70.648366
        ],
        [
          29.69621,
          70.644504
        ],
        [
          29.712388,
          70.640172
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Ullsfjord - Lyngen|line/1",
      "name": "Ullsfjord - Lyngen",
      "category": "line",
      "fromExternalId": "way/586436581",
      "toExternalId": "relation/8280563",
      "nominalKv": 132,
      "lengthKm": 18.5,
      "operator": "Arva",
      "path": [
        [
          19.820639,
          69.601613
        ],
        [
          19.840434,
          69.60012
        ],
        [
          19.868898,
          69.596956
        ],
        [
          19.888623,
          69.59477
        ],
        [
          19.914957,
          69.591832
        ],
        [
          19.938968,
          69.588362
        ],
        [
          19.964457,
          69.583906
        ],
        [
          19.999964,
          69.581196
        ],
        [
          20.025501,
          69.580674
        ],
        [
          20.054694,
          69.587644
        ],
        [
          20.077316,
          69.588554
        ],
        [
          20.125596,
          69.588993
        ],
        [
          20.154891,
          69.587465
        ],
        [
          20.179589,
          69.58617
        ],
        [
          20.209217,
          69.584619
        ],
        [
          20.232332,
          69.584782
        ],
        [
          20.250458,
          69.586954
        ],
        [
          20.271645,
          69.58928
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvanndal - Sildvik|line/0",
      "name": "Kvanndal - Sildvik",
      "category": "line",
      "fromExternalId": "way/252924745",
      "toExternalId": "relation/8292228",
      "nominalKv": 132,
      "lengthKm": 17.45,
      "operator": "Statnett",
      "path": [
        [
          17.61001,
          68.577557
        ],
        [
          17.61897,
          68.57035
        ],
        [
          17.622333,
          68.565261
        ],
        [
          17.626619,
          68.558321
        ],
        [
          17.639709,
          68.544855
        ],
        [
          17.654026,
          68.53398
        ],
        [
          17.662459,
          68.527387
        ],
        [
          17.676897,
          68.516718
        ],
        [
          17.681206,
          68.510099
        ],
        [
          17.688513,
          68.499548
        ],
        [
          17.694367,
          68.490035
        ],
        [
          17.698285,
          68.482779
        ],
        [
          17.703609,
          68.47289
        ],
        [
          17.708932,
          68.46295
        ],
        [
          17.714494,
          68.45258
        ],
        [
          17.708754,
          68.448192
        ],
        [
          17.715406,
          68.434096
        ],
        [
          17.71194,
          68.429723
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kanstadbotn - Kvitfossen|line/1",
      "name": "Kanstadbotn - Kvitfossen",
      "category": "line",
      "fromExternalId": "relation/8288766",
      "toExternalId": "way/709830245",
      "nominalKv": 132,
      "lengthKm": 16.89,
      "operator": "Statnett",
      "path": [
        [
          14.871269,
          68.430753
        ],
        [
          14.856573,
          68.423713
        ],
        [
          14.839109,
          68.410685
        ],
        [
          14.827179,
          68.402247
        ],
        [
          14.815911,
          68.393902
        ],
        [
          14.799277,
          68.38677
        ],
        [
          14.785428,
          68.377026
        ],
        [
          14.764136,
          68.369217
        ],
        [
          14.753678,
          68.362368
        ],
        [
          14.737309,
          68.358449
        ],
        [
          14.714526,
          68.361271
        ],
        [
          14.706433,
          68.354178
        ],
        [
          14.714947,
          68.347695
        ],
        [
          14.709958,
          68.3396
        ],
        [
          14.706496,
          68.332544
        ],
        [
          14.689617,
          68.329099
        ],
        [
          14.671027,
          68.326702
        ],
        [
          14.655166,
          68.327201
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvitfossen - Melbu|line/0",
      "name": "Kvitfossen - Melbu",
      "category": "line",
      "fromExternalId": "way/709830245",
      "toExternalId": "relation/8288766",
      "nominalKv": 132,
      "lengthKm": 15.85,
      "operator": "Statnett",
      "path": [
        [
          14.655193,
          68.327381
        ],
        [
          14.671383,
          68.326875
        ],
        [
          14.689359,
          68.329246
        ],
        [
          14.706064,
          68.332639
        ],
        [
          14.709465,
          68.339626
        ],
        [
          14.714465,
          68.347756
        ],
        [
          14.705919,
          68.354156
        ],
        [
          14.708003,
          68.364644
        ],
        [
          14.707212,
          68.373164
        ],
        [
          14.715838,
          68.38154
        ],
        [
          14.723788,
          68.390442
        ],
        [
          14.713874,
          68.39764
        ],
        [
          14.709164,
          68.405208
        ],
        [
          14.708269,
          68.41495
        ],
        [
          14.709915,
          68.424209
        ],
        [
          14.725859,
          68.428785
        ],
        [
          14.749033,
          68.431582
        ],
        [
          14.774066,
          68.431986
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Siso Energi|Lakshola - Siso|line/0",
      "name": "Lakshola - Siso",
      "category": "line",
      "fromExternalId": "relation/8296013",
      "toExternalId": "way/587829506",
      "nominalKv": 132,
      "lengthKm": 15.22,
      "operator": "Siso Energi",
      "path": [
        [
          15.750486,
          67.447851
        ],
        [
          15.763144,
          67.444638
        ],
        [
          15.777006,
          67.441683
        ],
        [
          15.777419,
          67.435851
        ],
        [
          15.769538,
          67.428514
        ],
        [
          15.762489,
          67.423723
        ],
        [
          15.749701,
          67.416236
        ],
        [
          15.736622,
          67.409346
        ],
        [
          15.729854,
          67.403328
        ],
        [
          15.722943,
          67.394174
        ],
        [
          15.723356,
          67.378475
        ],
        [
          15.723898,
          67.369774
        ],
        [
          15.724391,
          67.36118
        ],
        [
          15.72591,
          67.355453
        ],
        [
          15.722181,
          67.345885
        ],
        [
          15.718962,
          67.337775
        ],
        [
          15.716028,
          67.330224
        ],
        [
          15.715428,
          67.324538
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Svartisen - Halsa|line/0",
      "name": "Svartisen - Halsa",
      "category": "line",
      "fromExternalId": "way/475820066",
      "toExternalId": "relation/8301304",
      "nominalKv": 132,
      "lengthKm": 14.9,
      "operator": "Arva",
      "path": [
        [
          13.902407,
          66.732111
        ],
        [
          13.893515,
          66.735361
        ],
        [
          13.871906,
          66.734981
        ],
        [
          13.849732,
          66.734808
        ],
        [
          13.826161,
          66.734729
        ],
        [
          13.805324,
          66.736556
        ],
        [
          13.787748,
          66.738025
        ],
        [
          13.757336,
          66.742367
        ],
        [
          13.740334,
          66.741171
        ],
        [
          13.714897,
          66.739693
        ],
        [
          13.692325,
          66.7374
        ],
        [
          13.673741,
          66.73551
        ],
        [
          13.660345,
          66.735907
        ],
        [
          13.642053,
          66.736841
        ],
        [
          13.621788,
          66.737873
        ],
        [
          13.601502,
          66.738409
        ],
        [
          13.598448,
          66.744569
        ],
        [
          13.599507,
          66.748952
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Varangerbotn - Tana Bru|line/0",
      "name": "Varangerbotn - Tana Bru",
      "category": "line",
      "fromExternalId": "way/257192868",
      "toExternalId": "relation/8274347",
      "nominalKv": 132,
      "lengthKm": 14.62,
      "operator": "Statnett",
      "path": [
        [
          28.541079,
          70.171845
        ],
        [
          28.524652,
          70.170693
        ],
        [
          28.497527,
          70.171678
        ],
        [
          28.47324,
          70.17407
        ],
        [
          28.453968,
          70.177169
        ],
        [
          28.432767,
          70.181487
        ],
        [
          28.415022,
          70.184152
        ],
        [
          28.391783,
          70.187639
        ],
        [
          28.369811,
          70.190941
        ],
        [
          28.35575,
          70.194006
        ],
        [
          28.33616,
          70.198486
        ],
        [
          28.320099,
          70.20103
        ],
        [
          28.295621,
          70.203334
        ],
        [
          28.273444,
          70.200968
        ],
        [
          28.256203,
          70.197155
        ],
        [
          28.235668,
          70.194224
        ],
        [
          28.208431,
          70.19392
        ],
        [
          28.18793,
          70.194527
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elmea|Kvitfossen - Svolvær|line/0",
      "name": "Kvitfossen - Svolvær",
      "category": "line",
      "fromExternalId": "way/709830245",
      "toExternalId": "way/840096758",
      "nominalKv": 132,
      "lengthKm": 14.44,
      "operator": "Elmea",
      "path": [
        [
          14.65107,
          68.326616
        ],
        [
          14.644799,
          68.321647
        ],
        [
          14.642391,
          68.314003
        ],
        [
          14.643145,
          68.308085
        ],
        [
          14.642506,
          68.300862
        ],
        [
          14.637289,
          68.293451
        ],
        [
          14.629335,
          68.28588
        ],
        [
          14.609044,
          68.279253
        ],
        [
          14.589964,
          68.276104
        ],
        [
          14.578655,
          68.271638
        ],
        [
          14.554882,
          68.269649
        ],
        [
          14.549187,
          68.260258
        ],
        [
          14.537447,
          68.254987
        ],
        [
          14.528816,
          68.246285
        ],
        [
          14.519857,
          68.242552
        ],
        [
          14.507926,
          68.2375
        ],
        [
          14.514624,
          68.231924
        ],
        [
          14.528363,
          68.226731
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elmea|Svolvær - Kleppstad|line/0",
      "name": "Svolvær - Kleppstad",
      "category": "line",
      "fromExternalId": "way/587348300",
      "toExternalId": "way/840096758",
      "nominalKv": 132,
      "lengthKm": 14.29,
      "operator": "Elmea",
      "path": [
        [
          14.282593,
          68.261668
        ],
        [
          14.280631,
          68.256334
        ],
        [
          14.293217,
          68.24596
        ],
        [
          14.291889,
          68.240703
        ],
        [
          14.284577,
          68.236437
        ],
        [
          14.293309,
          68.229624
        ],
        [
          14.315384,
          68.218229
        ],
        [
          14.332525,
          68.214713
        ],
        [
          14.351847,
          68.212491
        ],
        [
          14.369362,
          68.213764
        ],
        [
          14.386842,
          68.214137
        ],
        [
          14.404038,
          68.216121
        ],
        [
          14.42552,
          68.21665
        ],
        [
          14.440759,
          68.218222
        ],
        [
          14.455778,
          68.222228
        ],
        [
          14.469053,
          68.225103
        ],
        [
          14.497601,
          68.225022
        ],
        [
          14.510865,
          68.22282
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvanndal - Narvik|line/1",
      "name": "Kvanndal - Narvik",
      "category": "line",
      "fromExternalId": "way/252924745",
      "toExternalId": "relation/8292614",
      "nominalKv": 132,
      "lengthKm": 13.72,
      "operator": "Statnett",
      "path": [
        [
          17.609572,
          68.577619
        ],
        [
          17.609278,
          68.574208
        ],
        [
          17.600591,
          68.563272
        ],
        [
          17.592952,
          68.553628
        ],
        [
          17.587915,
          68.54708
        ],
        [
          17.58387,
          68.539484
        ],
        [
          17.584541,
          68.531345
        ],
        [
          17.585018,
          68.526976
        ],
        [
          17.575561,
          68.521023
        ],
        [
          17.56429,
          68.51246
        ],
        [
          17.549578,
          68.501656
        ],
        [
          17.542806,
          68.496671
        ],
        [
          17.535902,
          68.491645
        ],
        [
          17.522287,
          68.484402
        ],
        [
          17.506226,
          68.480824
        ],
        [
          17.499829,
          68.478705
        ],
        [
          17.489103,
          68.470545
        ],
        [
          17.486407,
          68.467125
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Govddesåga - Sundsfjord|line/0",
      "name": "Govddesåga - Sundsfjord",
      "category": "line",
      "fromExternalId": "way/711130655",
      "toExternalId": "relation/8300691",
      "nominalKv": 132,
      "lengthKm": 13.37,
      "operator": "Arva",
      "path": [
        [
          14.387585,
          66.924843
        ],
        [
          14.375046,
          66.927765
        ],
        [
          14.356207,
          66.93124
        ],
        [
          14.33717,
          66.930563
        ],
        [
          14.319432,
          66.927895
        ],
        [
          14.30579,
          66.924228
        ],
        [
          14.28602,
          66.925103
        ],
        [
          14.26322,
          66.925298
        ],
        [
          14.245681,
          66.925916
        ],
        [
          14.22432,
          66.93149
        ],
        [
          14.207779,
          66.935806
        ],
        [
          14.198063,
          66.941181
        ],
        [
          14.191557,
          66.945374
        ],
        [
          14.185631,
          66.949194
        ],
        [
          14.177253,
          66.953631
        ],
        [
          14.167035,
          66.958389
        ],
        [
          14.155088,
          66.965721
        ],
        [
          14.150639,
          66.971328
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Sildvik - Tornehamn|line/0",
      "name": "Sildvik - Tornehamn",
      "category": "line",
      "fromExternalId": "way/1065776932",
      "toExternalId": "relation/8292143",
      "nominalKv": 132,
      "lengthKm": 13.36,
      "operator": "Statnett",
      "path": [
        [
          17.801432,
          68.408753
        ],
        [
          17.80527,
          68.408345
        ],
        [
          17.828021,
          68.406427
        ],
        [
          17.843932,
          68.410501
        ],
        [
          17.862756,
          68.413142
        ],
        [
          17.875459,
          68.414014
        ],
        [
          17.898037,
          68.413574
        ],
        [
          17.911422,
          68.412796
        ],
        [
          17.947578,
          68.411075
        ],
        [
          17.958323,
          68.414239
        ],
        [
          17.971927,
          68.418259
        ],
        [
          17.983517,
          68.421669
        ],
        [
          18.009723,
          68.42637
        ],
        [
          18.027931,
          68.428253
        ],
        [
          18.057707,
          68.429284
        ],
        [
          18.072401,
          68.429896
        ],
        [
          18.091651,
          68.430608
        ],
        [
          18.105954,
          68.431371
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Glomfjord - Enga|line/4",
      "name": "Glomfjord - Enga",
      "category": "line",
      "fromExternalId": "relation/8301307",
      "toExternalId": "way/588443638",
      "nominalKv": 132,
      "lengthKm": 13.26,
      "operator": "Arva",
      "path": [
        [
          13.79078,
          66.794852
        ],
        [
          13.779388,
          66.796713
        ],
        [
          13.763656,
          66.800792
        ],
        [
          13.749736,
          66.804421
        ],
        [
          13.732191,
          66.804271
        ],
        [
          13.711423,
          66.805888
        ],
        [
          13.695263,
          66.809396
        ],
        [
          13.673102,
          66.810379
        ],
        [
          13.654042,
          66.811916
        ],
        [
          13.639669,
          66.81131
        ],
        [
          13.623862,
          66.808426
        ],
        [
          13.607204,
          66.80268
        ],
        [
          13.586574,
          66.802282
        ],
        [
          13.564298,
          66.801839
        ],
        [
          13.547275,
          66.800626
        ],
        [
          13.538093,
          66.79494
        ],
        [
          13.531227,
          66.790717
        ],
        [
          13.532632,
          66.787261
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sundsfjord - Hopen|line/0",
      "name": "Sundsfjord - Hopen",
      "category": "line",
      "fromExternalId": "way/588074294",
      "toExternalId": "relation/8297300",
      "nominalKv": 132,
      "lengthKm": 12.75,
      "operator": "Arva",
      "path": [
        [
          14.666568,
          67.227899
        ],
        [
          14.681548,
          67.231913
        ],
        [
          14.696547,
          67.234427
        ],
        [
          14.711511,
          67.23743
        ],
        [
          14.724394,
          67.242283
        ],
        [
          14.735418,
          67.246781
        ],
        [
          14.744586,
          67.25236
        ],
        [
          14.755545,
          67.259005
        ],
        [
          14.763506,
          67.263849
        ],
        [
          14.772972,
          67.271506
        ],
        [
          14.772448,
          67.278299
        ],
        [
          14.771724,
          67.287327
        ],
        [
          14.770051,
          67.293074
        ],
        [
          14.766864,
          67.298538
        ],
        [
          14.762835,
          67.305455
        ],
        [
          14.758742,
          67.312427
        ],
        [
          14.75009,
          67.317604
        ],
        [
          14.738569,
          67.319311
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Håkøybotn - Kvaløya|line/0",
      "name": "Håkøybotn - Kvaløya",
      "category": "line",
      "fromExternalId": "way/586667770",
      "toExternalId": "relation/8281954",
      "nominalKv": 132,
      "lengthKm": 12.57,
      "operator": "Arva",
      "path": [
        [
          18.699843,
          69.623294
        ],
        [
          18.699932,
          69.628257
        ],
        [
          18.704213,
          69.635319
        ],
        [
          18.712183,
          69.64194
        ],
        [
          18.715964,
          69.647984
        ],
        [
          18.720018,
          69.654444
        ],
        [
          18.725136,
          69.662616
        ],
        [
          18.728974,
          69.66873
        ],
        [
          18.733965,
          69.676671
        ],
        [
          18.748737,
          69.681125
        ],
        [
          18.761926,
          69.684415
        ],
        [
          18.771949,
          69.691293
        ],
        [
          18.793198,
          69.692382
        ],
        [
          18.809184,
          69.692017
        ],
        [
          18.82723,
          69.692233
        ],
        [
          18.841927,
          69.693531
        ],
        [
          18.856235,
          69.696805
        ],
        [
          18.870486,
          69.700063
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Lødingen - Kanstadbotn|line/0",
      "name": "Lødingen - Kanstadbotn",
      "category": "line",
      "fromExternalId": "way/953796939",
      "toExternalId": "relation/8288539",
      "nominalKv": 132,
      "lengthKm": 12.39,
      "operator": "Statnett",
      "path": [
        [
          15.967466,
          68.401383
        ],
        [
          15.966705,
          68.402502
        ],
        [
          15.961171,
          68.406916
        ],
        [
          15.953195,
          68.413651
        ],
        [
          15.93914,
          68.430351
        ],
        [
          15.931442,
          68.440115
        ],
        [
          15.925638,
          68.447589
        ],
        [
          15.920944,
          68.453622
        ],
        [
          15.916775,
          68.458998
        ],
        [
          15.914487,
          68.46121
        ],
        [
          15.906213,
          68.468125
        ],
        [
          15.899159,
          68.474006
        ],
        [
          15.895731,
          68.478379
        ],
        [
          15.893859,
          68.488
        ],
        [
          15.892839,
          68.493191
        ],
        [
          15.891364,
          68.500358
        ],
        [
          15.882184,
          68.506486
        ],
        [
          15.881607,
          68.506527
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Innset - Straumsmo|line/0",
      "name": "Innset - Straumsmo",
      "category": "line",
      "fromExternalId": "way/587053918",
      "toExternalId": "way/587053818",
      "nominalKv": 132,
      "lengthKm": 12.38,
      "operator": "Statnett",
      "path": [
        [
          18.652098,
          68.74045
        ],
        [
          18.648305,
          68.737625
        ],
        [
          18.650349,
          68.7284
        ],
        [
          18.652693,
          68.721932
        ],
        [
          18.65463,
          68.716619
        ],
        [
          18.660595,
          68.709405
        ],
        [
          18.674542,
          68.700393
        ],
        [
          18.684043,
          68.694186
        ],
        [
          18.695528,
          68.690377
        ],
        [
          18.717002,
          68.685692
        ],
        [
          18.734449,
          68.681897
        ],
        [
          18.749623,
          68.678636
        ],
        [
          18.779149,
          68.672311
        ],
        [
          18.791926,
          68.668046
        ],
        [
          18.802232,
          68.664594
        ],
        [
          18.810498,
          68.66124
        ],
        [
          18.818804,
          68.65776
        ],
        [
          18.818884,
          68.65772
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sjønstå - Fauske|line/9",
      "name": "Sjønstå - Fauske",
      "category": "line",
      "fromExternalId": "way/587922055",
      "toExternalId": "relation/8296010",
      "nominalKv": 132,
      "lengthKm": 12.19,
      "operator": "Arva",
      "path": [
        [
          15.672469,
          67.233252
        ],
        [
          15.661485,
          67.236734
        ],
        [
          15.646157,
          67.238381
        ],
        [
          15.633633,
          67.239495
        ],
        [
          15.611832,
          67.241437
        ],
        [
          15.596214,
          67.24283
        ],
        [
          15.57996,
          67.244274
        ],
        [
          15.566854,
          67.24544
        ],
        [
          15.552362,
          67.246919
        ],
        [
          15.537286,
          67.250563
        ],
        [
          15.519229,
          67.254914
        ],
        [
          15.505199,
          67.258295
        ],
        [
          15.484645,
          67.263233
        ],
        [
          15.472384,
          67.266182
        ],
        [
          15.455564,
          67.270221
        ],
        [
          15.441289,
          67.273802
        ],
        [
          15.428066,
          67.273196
        ],
        [
          15.41931,
          67.271317
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Mo Industripark|Svabo - Storforshei|line/0",
      "name": "Svabo - Storforshei",
      "category": "line",
      "fromExternalId": "way/197866182",
      "toExternalId": "way/848422115",
      "nominalKv": 132,
      "lengthKm": 11.94,
      "operator": "Mo Industripark",
      "path": [
        [
          14.322334,
          66.332384
        ],
        [
          14.334205,
          66.336427
        ],
        [
          14.349294,
          66.341572
        ],
        [
          14.360188,
          66.345294
        ],
        [
          14.375463,
          66.35049
        ],
        [
          14.388968,
          66.355087
        ],
        [
          14.403607,
          66.36122
        ],
        [
          14.412137,
          66.364791
        ],
        [
          14.424032,
          66.369769
        ],
        [
          14.43427,
          66.374043
        ],
        [
          14.444328,
          66.378166
        ],
        [
          14.453679,
          66.381863
        ],
        [
          14.464054,
          66.385963
        ],
        [
          14.471877,
          66.389053
        ],
        [
          14.477666,
          66.395706
        ],
        [
          14.480981,
          66.401104
        ],
        [
          14.493083,
          66.407739
        ],
        [
          14.499585,
          66.409939
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Sørfjord - Kjøpsvik|line/4",
      "name": "Sørfjord - Kjøpsvik",
      "category": "line",
      "fromExternalId": "way/1160239696",
      "toExternalId": "way/587793855",
      "nominalKv": 132,
      "lengthKm": 11.53,
      "operator": "Noranett",
      "path": [
        [
          16.661413,
          68.064198
        ],
        [
          16.649099,
          68.065207
        ],
        [
          16.633521,
          68.071989
        ],
        [
          16.624428,
          68.074719
        ],
        [
          16.606428,
          68.076821
        ],
        [
          16.590679,
          68.078982
        ],
        [
          16.579545,
          68.080504
        ],
        [
          16.564813,
          68.079625
        ],
        [
          16.546802,
          68.081823
        ],
        [
          16.536114,
          68.085002
        ],
        [
          16.521362,
          68.09073
        ],
        [
          16.510279,
          68.096838
        ],
        [
          16.504265,
          68.10174
        ],
        [
          16.501121,
          68.10661
        ],
        [
          16.497517,
          68.111578
        ],
        [
          16.487694,
          68.117039
        ],
        [
          16.480243,
          68.120112
        ],
        [
          16.462798,
          68.120553
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Hungeren - Sandvika|line/0",
      "name": "Hungeren - Sandvika",
      "category": "line",
      "fromExternalId": "relation/8280652",
      "toExternalId": "relation/8280921",
      "nominalKv": 132,
      "lengthKm": 11.3,
      "operator": "Arva",
      "path": [
        [
          18.976357,
          69.637584
        ],
        [
          18.968523,
          69.633835
        ],
        [
          18.959873,
          69.627836
        ],
        [
          18.953023,
          69.623079
        ],
        [
          18.951043,
          69.618444
        ],
        [
          18.949941,
          69.615846
        ],
        [
          18.947165,
          69.609346
        ],
        [
          18.943906,
          69.603626
        ],
        [
          18.943037,
          69.597369
        ],
        [
          18.944673,
          69.591783
        ],
        [
          18.949179,
          69.584731
        ],
        [
          18.9525,
          69.579551
        ],
        [
          18.960538,
          69.572287
        ],
        [
          18.96127,
          69.565666
        ],
        [
          18.967123,
          69.558006
        ],
        [
          18.974877,
          69.551682
        ],
        [
          18.985518,
          69.546538
        ],
        [
          18.99641,
          69.543931
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Hungeren - Sandvika|line/1",
      "name": "Hungeren - Sandvika",
      "category": "line",
      "fromExternalId": "relation/8280652",
      "toExternalId": "relation/8280921",
      "nominalKv": 132,
      "lengthKm": 11.27,
      "operator": "Arva",
      "path": [
        [
          18.976717,
          69.637492
        ],
        [
          18.967611,
          69.632789
        ],
        [
          18.959779,
          69.627431
        ],
        [
          18.954608,
          69.623881
        ],
        [
          18.951276,
          69.617914
        ],
        [
          18.949764,
          69.614375
        ],
        [
          18.947157,
          69.608283
        ],
        [
          18.94404,
          69.603228
        ],
        [
          18.943546,
          69.597239
        ],
        [
          18.945166,
          69.591882
        ],
        [
          18.949667,
          69.584776
        ],
        [
          18.952945,
          69.579588
        ],
        [
          18.960991,
          69.572344
        ],
        [
          18.9617,
          69.56552
        ],
        [
          18.967499,
          69.55807
        ],
        [
          18.975207,
          69.551798
        ],
        [
          18.985606,
          69.5467
        ],
        [
          18.996643,
          69.544048
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Skjomen - Ofoten|line/0",
      "name": "Skjomen - Ofoten",
      "category": "line",
      "fromExternalId": "way/572898626",
      "toExternalId": "way/968741818",
      "nominalKv": 132,
      "lengthKm": 10.7,
      "operator": "Statnett",
      "path": [
        [
          17.557064,
          68.159186
        ],
        [
          17.543584,
          68.158532
        ],
        [
          17.513535,
          68.160354
        ],
        [
          17.507175,
          68.160718
        ],
        [
          17.489129,
          68.161751
        ],
        [
          17.476544,
          68.162474
        ],
        [
          17.463576,
          68.163217
        ],
        [
          17.450881,
          68.169706
        ],
        [
          17.444932,
          68.17362
        ],
        [
          17.441442,
          68.176484
        ],
        [
          17.434815,
          68.181957
        ],
        [
          17.424475,
          68.191386
        ],
        [
          17.418888,
          68.194284
        ],
        [
          17.408727,
          68.197901
        ],
        [
          17.39383,
          68.20289
        ],
        [
          17.389563,
          68.204315
        ],
        [
          17.380889,
          68.204208
        ],
        [
          17.361826,
          68.203954
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvitnes - Kilbotn|line/0",
      "name": "Kvitnes - Kilbotn",
      "category": "line",
      "fromExternalId": "way/228085650",
      "toExternalId": "way/120105564",
      "nominalKv": 132,
      "lengthKm": 10.64,
      "operator": "Statnett",
      "path": [
        [
          16.597998,
          68.62939
        ],
        [
          16.590198,
          68.631351
        ],
        [
          16.56901,
          68.636535
        ],
        [
          16.565071,
          68.639437
        ],
        [
          16.556402,
          68.645789
        ],
        [
          16.551467,
          68.650177
        ],
        [
          16.546778,
          68.655389
        ],
        [
          16.541596,
          68.659101
        ],
        [
          16.533839,
          68.663795
        ],
        [
          16.520348,
          68.67191
        ],
        [
          16.518583,
          68.678749
        ],
        [
          16.518309,
          68.685399
        ],
        [
          16.518068,
          68.690724
        ],
        [
          16.517862,
          68.69504
        ],
        [
          16.514874,
          68.701472
        ],
        [
          16.51206,
          68.707489
        ],
        [
          16.509734,
          68.712437
        ],
        [
          16.509318,
          68.714778
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Raggovidda - Kobbkroken|line/0",
      "name": "Raggovidda - Kobbkroken",
      "category": "line",
      "fromExternalId": "way/671990789",
      "toExternalId": "way/671990791",
      "nominalKv": 132,
      "lengthKm": 10.59,
      "operator": "Barents Nett",
      "path": [
        [
          29.086478,
          70.764016
        ],
        [
          29.10494,
          70.765032
        ],
        [
          29.131376,
          70.76648
        ],
        [
          29.14524,
          70.765307
        ],
        [
          29.14809,
          70.761659
        ],
        [
          29.151795,
          70.755903
        ],
        [
          29.155638,
          70.749947
        ],
        [
          29.158591,
          70.745358
        ],
        [
          29.166618,
          70.741765
        ],
        [
          29.178031,
          70.737228
        ],
        [
          29.188415,
          70.733098
        ],
        [
          29.199115,
          70.728846
        ],
        [
          29.210023,
          70.724503
        ],
        [
          29.222316,
          70.719609
        ],
        [
          29.235671,
          70.717222
        ],
        [
          29.24713,
          70.715894
        ],
        [
          29.267271,
          70.713554
        ],
        [
          29.281286,
          70.711925
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Bjerka kraftverk - Nedre Røssåga|line/0",
      "name": "Bjerka kraftverk - Nedre Røssåga",
      "category": "line",
      "fromExternalId": "way/610484703",
      "toExternalId": "relation/8473044",
      "nominalKv": 132,
      "lengthKm": 10.54,
      "operator": "Linea",
      "path": [
        [
          13.997608,
          66.06248
        ],
        [
          13.987743,
          66.063302
        ],
        [
          13.975403,
          66.065065
        ],
        [
          13.9588,
          66.067471
        ],
        [
          13.946909,
          66.069367
        ],
        [
          13.935774,
          66.071134
        ],
        [
          13.922456,
          66.07324
        ],
        [
          13.905817,
          66.073369
        ],
        [
          13.893109,
          66.073408
        ],
        [
          13.882104,
          66.072975
        ],
        [
          13.869408,
          66.071912
        ],
        [
          13.853781,
          66.069114
        ],
        [
          13.843392,
          66.066532
        ],
        [
          13.826684,
          66.061946
        ],
        [
          13.815392,
          66.059793
        ],
        [
          13.802461,
          66.057185
        ],
        [
          13.790665,
          66.054513
        ],
        [
          13.781882,
          66.052823
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Sildvik - Narvik|line/0",
      "name": "Sildvik - Narvik",
      "category": "line",
      "fromExternalId": "relation/8292228",
      "toExternalId": "relation/8292614",
      "nominalKv": 132,
      "lengthKm": 10.51,
      "operator": "Statnett",
      "path": [
        [
          17.71194,
          68.429723
        ],
        [
          17.710889,
          68.429441
        ],
        [
          17.69545,
          68.430949
        ],
        [
          17.676246,
          68.432215
        ],
        [
          17.662561,
          68.431954
        ],
        [
          17.650974,
          68.434192
        ],
        [
          17.641388,
          68.436872
        ],
        [
          17.628765,
          68.438163
        ],
        [
          17.607974,
          68.440222
        ],
        [
          17.575201,
          68.443556
        ],
        [
          17.559231,
          68.445195
        ],
        [
          17.546346,
          68.445605
        ],
        [
          17.516179,
          68.444393
        ],
        [
          17.502766,
          68.443852
        ],
        [
          17.493287,
          68.443472
        ],
        [
          17.477755,
          68.44389
        ],
        [
          17.467623,
          68.444157
        ],
        [
          17.464018,
          68.444278
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Alut|Alta - Skillemoen 2|line/0",
      "name": "Alta - Skillemoen 2",
      "category": "line",
      "fromExternalId": "way/883151328",
      "toExternalId": "relation/8278085",
      "nominalKv": 132,
      "lengthKm": 9.87,
      "operator": "Alut",
      "path": [
        [
          23.213346,
          69.905384
        ],
        [
          23.218237,
          69.906833
        ],
        [
          23.231087,
          69.90585
        ],
        [
          23.249942,
          69.906271
        ],
        [
          23.265591,
          69.906617
        ],
        [
          23.302259,
          69.910409
        ],
        [
          23.312168,
          69.911432
        ],
        [
          23.327918,
          69.914146
        ],
        [
          23.344155,
          69.916942
        ],
        [
          23.361965,
          69.922703
        ],
        [
          23.371487,
          69.927815
        ],
        [
          23.377865,
          69.931246
        ],
        [
          23.386889,
          69.936093
        ],
        [
          23.383529,
          69.939178
        ],
        [
          23.380339,
          69.942117
        ],
        [
          23.376884,
          69.945929
        ],
        [
          23.373746,
          69.949399
        ],
        [
          23.373339,
          69.951538
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|||line/482",
      "name": "merged/line/line|132|||line/482",
      "category": "line",
      "fromExternalId": "relation/8292143",
      "toExternalId": "way/1065776932",
      "nominalKv": 132,
      "lengthKm": 9.81,
      "operator": null,
      "path": [
        [
          17.872194,
          68.504596
        ],
        [
          17.866202,
          68.504514
        ],
        [
          17.848991,
          68.504917
        ],
        [
          17.837866,
          68.505175
        ],
        [
          17.822878,
          68.504375
        ],
        [
          17.807639,
          68.502228
        ],
        [
          17.801967,
          68.496487
        ],
        [
          17.794687,
          68.492319
        ],
        [
          17.787989,
          68.486903
        ],
        [
          17.78428,
          68.482232
        ],
        [
          17.78002,
          68.476268
        ],
        [
          17.780002,
          68.472534
        ],
        [
          17.77312,
          68.469976
        ],
        [
          17.763805,
          68.467425
        ],
        [
          17.749576,
          68.464492
        ],
        [
          17.730866,
          68.462461
        ],
        [
          17.712533,
          68.463334
        ],
        [
          17.708932,
          68.46295
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Valljord - Salten A|line/0",
      "name": "Valljord - Salten A",
      "category": "line",
      "fromExternalId": "relation/8296015",
      "toExternalId": "way/587829506",
      "nominalKv": 132,
      "lengthKm": 8.83,
      "operator": "Arva",
      "path": [
        [
          15.553374,
          67.340446
        ],
        [
          15.563982,
          67.33955
        ],
        [
          15.572835,
          67.338979
        ],
        [
          15.5839,
          67.338256
        ],
        [
          15.595351,
          67.335387
        ],
        [
          15.601739,
          67.330985
        ],
        [
          15.606449,
          67.327716
        ],
        [
          15.615027,
          67.323123
        ],
        [
          15.625439,
          67.319975
        ],
        [
          15.634301,
          67.317292
        ],
        [
          15.643158,
          67.314594
        ],
        [
          15.655131,
          67.313372
        ],
        [
          15.665066,
          67.31236
        ],
        [
          15.682479,
          67.313051
        ],
        [
          15.694841,
          67.31595
        ],
        [
          15.703454,
          67.319294
        ],
        [
          15.710696,
          67.322091
        ],
        [
          15.713422,
          67.324875
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Valljord - Salten B|line/0",
      "name": "Valljord - Salten B",
      "category": "line",
      "fromExternalId": "relation/8296015",
      "toExternalId": "way/587829506",
      "nominalKv": 132,
      "lengthKm": 8.77,
      "operator": "Arva",
      "path": [
        [
          15.553946,
          67.340616
        ],
        [
          15.56407,
          67.339722
        ],
        [
          15.573387,
          67.339114
        ],
        [
          15.584274,
          67.338418
        ],
        [
          15.594323,
          67.336505
        ],
        [
          15.602855,
          67.330635
        ],
        [
          15.610043,
          67.325685
        ],
        [
          15.617114,
          67.322769
        ],
        [
          15.627859,
          67.319499
        ],
        [
          15.636997,
          67.316721
        ],
        [
          15.644984,
          67.314612
        ],
        [
          15.65535,
          67.313539
        ],
        [
          15.6699,
          67.31201
        ],
        [
          15.685628,
          67.313467
        ],
        [
          15.694533,
          67.316086
        ],
        [
          15.703298,
          67.319483
        ],
        [
          15.71017,
          67.322142
        ],
        [
          15.713191,
          67.324866
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Mo Industripark|Avgr. Ørtfjell|line/0",
      "name": "Avgr. Ørtfjell",
      "category": "line",
      "fromExternalId": "relation/8469203",
      "toExternalId": "way/848422115",
      "nominalKv": 132,
      "lengthKm": 8.71,
      "operator": "Mo Industripark",
      "path": [
        [
          14.650635,
          66.416023
        ],
        [
          14.646926,
          66.415549
        ],
        [
          14.634723,
          66.41396
        ],
        [
          14.625152,
          66.412719
        ],
        [
          14.610164,
          66.410765
        ],
        [
          14.599199,
          66.409336
        ],
        [
          14.59538,
          66.406843
        ],
        [
          14.588454,
          66.402346
        ],
        [
          14.581406,
          66.400161
        ],
        [
          14.567909,
          66.397922
        ],
        [
          14.554718,
          66.395733
        ],
        [
          14.54022,
          66.393325
        ],
        [
          14.530921,
          66.391781
        ],
        [
          14.520686,
          66.392098
        ],
        [
          14.508921,
          66.394772
        ],
        [
          14.49823,
          66.397198
        ],
        [
          14.487056,
          66.399736
        ],
        [
          14.480949,
          66.401052
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Leirosen - Nesna|line/0",
      "name": "Leirosen - Nesna",
      "category": "line",
      "fromExternalId": "way/589009876",
      "toExternalId": "relation/8306711",
      "nominalKv": 132,
      "lengthKm": 8.63,
      "operator": "Linea",
      "path": [
        [
          13.061312,
          66.156126
        ],
        [
          13.06026,
          66.152333
        ],
        [
          13.063259,
          66.14744
        ],
        [
          13.065126,
          66.1401
        ],
        [
          13.06529,
          66.136796
        ],
        [
          13.064268,
          66.129335
        ],
        [
          13.063323,
          66.126002
        ],
        [
          13.062052,
          66.121334
        ],
        [
          13.062192,
          66.118077
        ],
        [
          13.065834,
          66.112345
        ],
        [
          13.066108,
          66.110333
        ],
        [
          13.063302,
          66.1067
        ],
        [
          13.0618,
          66.102967
        ],
        [
          13.063409,
          66.097777
        ],
        [
          13.064879,
          66.09304
        ],
        [
          13.066392,
          66.088153
        ],
        [
          13.06691,
          66.084366
        ],
        [
          13.065212,
          66.07966
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Hopen - Tjønndal|cable/0",
      "name": "Hopen - Tjønndal",
      "category": "cable",
      "fromExternalId": "way/588074294",
      "toExternalId": "way/588074267",
      "nominalKv": 132,
      "lengthKm": 8.46,
      "operator": "Arva",
      "path": [
        [
          14.626154,
          67.303652
        ],
        [
          14.614019,
          67.301246
        ],
        [
          14.60821,
          67.302098
        ],
        [
          14.606745,
          67.30005
        ],
        [
          14.600055,
          67.299797
        ],
        [
          14.578159,
          67.298035
        ],
        [
          14.558648,
          67.295849
        ],
        [
          14.551728,
          67.296359
        ],
        [
          14.538564,
          67.294646
        ],
        [
          14.528857,
          67.293935
        ],
        [
          14.514593,
          67.29056
        ],
        [
          14.507137,
          67.288564
        ],
        [
          14.50167,
          67.287425
        ],
        [
          14.492586,
          67.286423
        ],
        [
          14.483179,
          67.28479
        ],
        [
          14.479241,
          67.284191
        ],
        [
          14.465546,
          67.284146
        ],
        [
          14.460681,
          67.284024
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sørreisa - Finnfjordbotn 2|line/0",
      "name": "Sørreisa - Finnfjordbotn 2",
      "category": "line",
      "fromExternalId": "relation/8285302",
      "toExternalId": "relation/8285305",
      "nominalKv": 132,
      "lengthKm": 8.43,
      "operator": "Arva",
      "path": [
        [
          18.17192,
          69.159279
        ],
        [
          18.162943,
          69.162772
        ],
        [
          18.155149,
          69.165819
        ],
        [
          18.14391,
          69.170214
        ],
        [
          18.134437,
          69.172209
        ],
        [
          18.125837,
          69.174782
        ],
        [
          18.117598,
          69.177816
        ],
        [
          18.106869,
          69.181767
        ],
        [
          18.099058,
          69.184623
        ],
        [
          18.090438,
          69.187747
        ],
        [
          18.086409,
          69.192394
        ],
        [
          18.084971,
          69.198864
        ],
        [
          18.084446,
          69.202599
        ],
        [
          18.083907,
          69.206482
        ],
        [
          18.084733,
          69.209319
        ],
        [
          18.088989,
          69.214316
        ],
        [
          18.082579,
          69.218166
        ],
        [
          18.08392,
          69.221173
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Hopen - Messiosen|line/1",
      "name": "Hopen - Messiosen",
      "category": "line",
      "fromExternalId": "relation/8297300",
      "toExternalId": "way/588074294",
      "nominalKv": 132,
      "lengthKm": 8.43,
      "operator": "Arva",
      "path": [
        [
          14.738465,
          67.31922
        ],
        [
          14.722742,
          67.320422
        ],
        [
          14.71108,
          67.319648
        ],
        [
          14.69843,
          67.317726
        ],
        [
          14.685829,
          67.31568
        ],
        [
          14.679306,
          67.314623
        ],
        [
          14.669334,
          67.313014
        ],
        [
          14.656185,
          67.310886
        ],
        [
          14.645253,
          67.309117
        ],
        [
          14.634325,
          67.30735
        ],
        [
          14.621971,
          67.305334
        ],
        [
          14.611763,
          67.303304
        ],
        [
          14.602104,
          67.300778
        ],
        [
          14.59211,
          67.299673
        ],
        [
          14.579968,
          67.298325
        ],
        [
          14.57132,
          67.297108
        ],
        [
          14.559722,
          67.295236
        ],
        [
          14.556238,
          67.294674
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Sørreisa - Finnfjordbotn 1|line/0",
      "name": "Sørreisa - Finnfjordbotn 1",
      "category": "line",
      "fromExternalId": "relation/8285305",
      "toExternalId": "relation/8285302",
      "nominalKv": 132,
      "lengthKm": 8.41,
      "operator": "Arva",
      "path": [
        [
          18.082839,
          69.220941
        ],
        [
          18.08245,
          69.21778
        ],
        [
          18.088461,
          69.214532
        ],
        [
          18.084432,
          69.209473
        ],
        [
          18.083477,
          69.206529
        ],
        [
          18.08429,
          69.201051
        ],
        [
          18.084861,
          69.197001
        ],
        [
          18.086082,
          69.192334
        ],
        [
          18.089021,
          69.188968
        ],
        [
          18.098771,
          69.184538
        ],
        [
          18.10726,
          69.18143
        ],
        [
          18.117721,
          69.177581
        ],
        [
          18.125454,
          69.174726
        ],
        [
          18.136475,
          69.171706
        ],
        [
          18.143964,
          69.170002
        ],
        [
          18.154891,
          69.165712
        ],
        [
          18.162535,
          69.162726
        ],
        [
          18.171628,
          69.15919
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Ballangen - Bjørkåsen|line/0",
      "name": "Ballangen - Bjørkåsen",
      "category": "line",
      "fromExternalId": "way/587726948",
      "toExternalId": "relation/8293880",
      "nominalKv": 132,
      "lengthKm": 8.13,
      "operator": "Noranett",
      "path": [
        [
          16.732874,
          68.261127
        ],
        [
          16.735085,
          68.264443
        ],
        [
          16.739184,
          68.270684
        ],
        [
          16.740659,
          68.274163
        ],
        [
          16.741308,
          68.277717
        ],
        [
          16.742086,
          68.283849
        ],
        [
          16.741195,
          68.289027
        ],
        [
          16.73972,
          68.292875
        ],
        [
          16.738186,
          68.296886
        ],
        [
          16.736031,
          68.302558
        ],
        [
          16.738521,
          68.305984
        ],
        [
          16.740265,
          68.308399
        ],
        [
          16.743306,
          68.312533
        ],
        [
          16.748199,
          68.3171
        ],
        [
          16.755654,
          68.32188
        ],
        [
          16.764348,
          68.322822
        ],
        [
          16.774235,
          68.323203
        ],
        [
          16.782417,
          68.32183
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Melbu - (Stokmarknes) - Sortland|line/1",
      "name": "Melbu - (Stokmarknes) - Sortland",
      "category": "line",
      "fromExternalId": "relation/8288766",
      "toExternalId": "way/1156216252",
      "nominalKv": 132,
      "lengthKm": 7.79,
      "operator": "Statnett",
      "path": [
        [
          14.851722,
          68.510469
        ],
        [
          14.861525,
          68.511719
        ],
        [
          14.866675,
          68.515625
        ],
        [
          14.873595,
          68.520858
        ],
        [
          14.87801,
          68.524213
        ],
        [
          14.881818,
          68.52709
        ],
        [
          14.887735,
          68.529503
        ],
        [
          14.898974,
          68.53076
        ],
        [
          14.911347,
          68.532132
        ],
        [
          14.921681,
          68.533285
        ],
        [
          14.934325,
          68.534679
        ],
        [
          14.948444,
          68.536251
        ],
        [
          14.955359,
          68.53862
        ],
        [
          14.960541,
          68.540887
        ],
        [
          14.96825,
          68.544266
        ],
        [
          14.976404,
          68.547827
        ],
        [
          14.9812,
          68.549932
        ],
        [
          14.988689,
          68.552744
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Møkkeland - Heggen|line/0",
      "name": "Møkkeland - Heggen",
      "category": "line",
      "fromExternalId": "way/587607521",
      "toExternalId": "way/587607517",
      "nominalKv": 132,
      "lengthKm": 7.22,
      "operator": "Noranett",
      "path": [
        [
          16.43816,
          68.809082
        ],
        [
          16.438273,
          68.807634
        ],
        [
          16.434694,
          68.803296
        ],
        [
          16.430247,
          68.800374
        ],
        [
          16.423284,
          68.795789
        ],
        [
          16.419593,
          68.793355
        ],
        [
          16.421342,
          68.78774
        ],
        [
          16.427854,
          68.785487
        ],
        [
          16.441067,
          68.780906
        ],
        [
          16.452225,
          68.781224
        ],
        [
          16.464067,
          68.781565
        ],
        [
          16.470904,
          68.783099
        ],
        [
          16.480986,
          68.785374
        ],
        [
          16.486834,
          68.786689
        ],
        [
          16.497723,
          68.789138
        ],
        [
          16.506851,
          68.789323
        ],
        [
          16.512347,
          68.790036
        ],
        [
          16.51508,
          68.792118
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Øresvik - Smibelg|line/0",
      "name": "Øresvik - Smibelg",
      "category": "line",
      "fromExternalId": "relation/8306512",
      "toExternalId": "way/1050275156",
      "nominalKv": 132,
      "lengthKm": 7.14,
      "operator": "Arva",
      "path": [
        [
          13.20574,
          66.454421
        ],
        [
          13.209112,
          66.450386
        ],
        [
          13.213484,
          66.447055
        ],
        [
          13.220007,
          66.445561
        ],
        [
          13.228628,
          66.443753
        ],
        [
          13.239593,
          66.442335
        ],
        [
          13.244008,
          66.44212
        ],
        [
          13.253363,
          66.443061
        ],
        [
          13.264586,
          66.444875
        ],
        [
          13.276532,
          66.447834
        ],
        [
          13.283257,
          66.448515
        ],
        [
          13.288581,
          66.448932
        ],
        [
          13.301965,
          66.451293
        ],
        [
          13.312689,
          66.452832
        ],
        [
          13.321577,
          66.454871
        ],
        [
          13.324597,
          66.45568
        ],
        [
          13.331677,
          66.459132
        ],
        [
          13.338648,
          66.459865
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kirkenes - Neiden|line/4",
      "name": "Kirkenes - Neiden",
      "category": "line",
      "fromExternalId": "relation/8269874",
      "toExternalId": "relation/8269872",
      "nominalKv": 132,
      "lengthKm": 6.89,
      "operator": "Statnett",
      "path": [
        [
          30.033521,
          69.722708
        ],
        [
          30.027925,
          69.721414
        ],
        [
          30.023114,
          69.719576
        ],
        [
          30.018935,
          69.717502
        ],
        [
          30.01349,
          69.714797
        ],
        [
          30.004987,
          69.710578
        ],
        [
          29.998668,
          69.707438
        ],
        [
          29.993148,
          69.704694
        ],
        [
          29.984731,
          69.700503
        ],
        [
          29.98067,
          69.69848
        ],
        [
          29.974362,
          69.695347
        ],
        [
          29.967275,
          69.690519
        ],
        [
          29.96609,
          69.687617
        ],
        [
          29.958955,
          69.683681
        ],
        [
          29.953666,
          69.68074
        ],
        [
          29.949498,
          69.678397
        ],
        [
          29.93628,
          69.675777
        ],
        [
          29.928466,
          69.674672
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Møkkeland - Gåsvatn|line/0",
      "name": "Møkkeland - Gåsvatn",
      "category": "line",
      "fromExternalId": "way/587607521",
      "toExternalId": "relation/8292079",
      "nominalKv": 132,
      "lengthKm": 6.85,
      "operator": "Noranett",
      "path": [
        [
          16.437943,
          68.809082
        ],
        [
          16.437878,
          68.808213
        ],
        [
          16.43655,
          68.804844
        ],
        [
          16.431245,
          68.80135
        ],
        [
          16.425904,
          68.797833
        ],
        [
          16.421208,
          68.794742
        ],
        [
          16.412182,
          68.791302
        ],
        [
          16.405168,
          68.78935
        ],
        [
          16.397611,
          68.787241
        ],
        [
          16.387048,
          68.783934
        ],
        [
          16.379777,
          68.781944
        ],
        [
          16.371646,
          68.780097
        ],
        [
          16.360678,
          68.777618
        ],
        [
          16.351916,
          68.775354
        ],
        [
          16.345281,
          68.773251
        ],
        [
          16.337587,
          68.770819
        ],
        [
          16.326466,
          68.767273
        ],
        [
          16.324481,
          68.765904
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Mo Industripark|Svabo - Storforshei|line/1",
      "name": "Svabo - Storforshei",
      "category": "line",
      "fromExternalId": "way/589085618",
      "toExternalId": "way/197866182",
      "nominalKv": 132,
      "lengthKm": 6.47,
      "operator": "Mo Industripark",
      "path": [
        [
          14.179055,
          66.305579
        ],
        [
          14.18188,
          66.306027
        ],
        [
          14.191023,
          66.305534
        ],
        [
          14.199687,
          66.30507
        ],
        [
          14.204528,
          66.304799
        ],
        [
          14.215831,
          66.304191
        ],
        [
          14.221571,
          66.303883
        ],
        [
          14.230245,
          66.303415
        ],
        [
          14.238732,
          66.303941
        ],
        [
          14.245411,
          66.306205
        ],
        [
          14.253243,
          66.308885
        ],
        [
          14.260082,
          66.311212
        ],
        [
          14.265624,
          66.3131
        ],
        [
          14.273783,
          66.315875
        ],
        [
          14.28088,
          66.318286
        ],
        [
          14.284329,
          66.319459
        ],
        [
          14.296617,
          66.323633
        ],
        [
          14.30208,
          66.325491
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Kilbotn - Medkila|line/0",
      "name": "Kilbotn - Medkila",
      "category": "line",
      "fromExternalId": "way/120105564",
      "toExternalId": "relation/8292075",
      "nominalKv": 132,
      "lengthKm": 6.26,
      "operator": "Noranett",
      "path": [
        [
          16.509754,
          68.715061
        ],
        [
          16.506103,
          68.71732
        ],
        [
          16.506899,
          68.720943
        ],
        [
          16.509071,
          68.72221
        ],
        [
          16.514343,
          68.725128
        ],
        [
          16.518812,
          68.72763
        ],
        [
          16.523934,
          68.730851
        ],
        [
          16.528115,
          68.734456
        ],
        [
          16.529435,
          68.737292
        ],
        [
          16.530193,
          68.740485
        ],
        [
          16.530986,
          68.743822
        ],
        [
          16.531996,
          68.748219
        ],
        [
          16.531083,
          68.752157
        ],
        [
          16.528992,
          68.755855
        ],
        [
          16.5266,
          68.760143
        ],
        [
          16.525808,
          68.762049
        ],
        [
          16.526469,
          68.765756
        ],
        [
          16.526923,
          68.768304
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Gråheia - Gåsvatn|line/0",
      "name": "Gråheia - Gåsvatn",
      "category": "line",
      "fromExternalId": "way/120105564",
      "toExternalId": "relation/8292079",
      "nominalKv": 132,
      "lengthKm": 5.96,
      "operator": "Noranett",
      "path": [
        [
          16.371895,
          68.718172
        ],
        [
          16.371708,
          68.718335
        ],
        [
          16.369802,
          68.722951
        ],
        [
          16.36891,
          68.725077
        ],
        [
          16.367593,
          68.728261
        ],
        [
          16.366092,
          68.731888
        ],
        [
          16.364144,
          68.736551
        ],
        [
          16.363121,
          68.738976
        ],
        [
          16.363409,
          68.741862
        ],
        [
          16.363889,
          68.744895
        ],
        [
          16.362352,
          68.747451
        ],
        [
          16.360558,
          68.750454
        ],
        [
          16.350575,
          68.752907
        ],
        [
          16.341501,
          68.755609
        ],
        [
          16.336944,
          68.75884
        ],
        [
          16.332293,
          68.762143
        ],
        [
          16.324781,
          68.765849
        ],
        [
          16.324481,
          68.765904
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Krogstad - Bardu|line/0",
      "name": "Krogstad - Bardu",
      "category": "line",
      "fromExternalId": "way/587053901",
      "toExternalId": "relation/8285905",
      "nominalKv": 132,
      "lengthKm": 5.74,
      "operator": "Arva",
      "path": [
        [
          18.424904,
          68.884192
        ],
        [
          18.423764,
          68.884122
        ],
        [
          18.418174,
          68.88506
        ],
        [
          18.408478,
          68.885817
        ],
        [
          18.40023,
          68.885646
        ],
        [
          18.390555,
          68.88475
        ],
        [
          18.379843,
          68.883755
        ],
        [
          18.372327,
          68.883057
        ],
        [
          18.361743,
          68.882674
        ],
        [
          18.355139,
          68.883188
        ],
        [
          18.345258,
          68.882839
        ],
        [
          18.340881,
          68.879883
        ],
        [
          18.337067,
          68.877309
        ],
        [
          18.332585,
          68.873498
        ],
        [
          18.330013,
          68.870984
        ],
        [
          18.325705,
          68.868126
        ],
        [
          18.321945,
          68.865628
        ],
        [
          18.320243,
          68.863381
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Hopen - Tjønndal|line/0",
      "name": "Hopen - Tjønndal",
      "category": "line",
      "fromExternalId": "relation/8297300",
      "toExternalId": "way/588074294",
      "nominalKv": 132,
      "lengthKm": 5.59,
      "operator": "Arva",
      "path": [
        [
          14.738362,
          67.319128
        ],
        [
          14.733696,
          67.319756
        ],
        [
          14.727378,
          67.319342
        ],
        [
          14.722088,
          67.317204
        ],
        [
          14.720012,
          67.315492
        ],
        [
          14.715535,
          67.312638
        ],
        [
          14.71152,
          67.311178
        ],
        [
          14.705619,
          67.309032
        ],
        [
          14.698769,
          67.306988
        ],
        [
          14.686696,
          67.30461
        ],
        [
          14.68084,
          67.303888
        ],
        [
          14.67192,
          67.302787
        ],
        [
          14.664487,
          67.302832
        ],
        [
          14.655386,
          67.302887
        ],
        [
          14.648748,
          67.302928
        ],
        [
          14.64026,
          67.303059
        ],
        [
          14.632869,
          67.30337
        ],
        [
          14.626154,
          67.303652
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Bjørnevatn - Kirkenes|line/1",
      "name": "Bjørnevatn - Kirkenes",
      "category": "line",
      "fromExternalId": "relation/8269872",
      "toExternalId": "relation/8269874",
      "nominalKv": 132,
      "lengthKm": 5.38,
      "operator": "Barents Nett",
      "path": [
        [
          29.958357,
          69.68257
        ],
        [
          29.959408,
          69.683155
        ],
        [
          29.964368,
          69.685918
        ],
        [
          29.967603,
          69.68819
        ],
        [
          29.968139,
          69.689454
        ],
        [
          29.970928,
          69.692851
        ],
        [
          29.975762,
          69.695254
        ],
        [
          29.981864,
          69.698299
        ],
        [
          29.988481,
          69.701593
        ],
        [
          29.99414,
          69.704407
        ],
        [
          30.003134,
          69.708882
        ],
        [
          30.005953,
          69.710282
        ],
        [
          30.011628,
          69.713106
        ],
        [
          30.017379,
          69.71597
        ],
        [
          30.022341,
          69.718432
        ],
        [
          30.025747,
          69.720158
        ],
        [
          30.031402,
          69.721917
        ],
        [
          30.033612,
          69.722615
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Reppa - Øresvik|cable/0",
      "name": "Reppa - Øresvik",
      "category": "cable",
      "fromExternalId": "way/1050275156",
      "toExternalId": "relation/8306512",
      "nominalKv": 132,
      "lengthKm": 4.62,
      "operator": "Arva",
      "path": [
        [
          13.272214,
          66.55042
        ],
        [
          13.197675,
          66.52133
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Messiosen - Tjønndal|line/1",
      "name": "Messiosen - Tjønndal",
      "category": "line",
      "fromExternalId": "way/588074294",
      "toExternalId": "way/588074267",
      "nominalKv": 132,
      "lengthKm": 4.28,
      "operator": "Arva",
      "path": [
        [
          14.556238,
          67.294674
        ],
        [
          14.55589,
          67.294619
        ],
        [
          14.549321,
          67.293559
        ],
        [
          14.544214,
          67.292743
        ],
        [
          14.539831,
          67.292037
        ],
        [
          14.53098,
          67.290618
        ],
        [
          14.526436,
          67.2899
        ],
        [
          14.523067,
          67.289361
        ],
        [
          14.515922,
          67.288212
        ],
        [
          14.511185,
          67.287433
        ],
        [
          14.502415,
          67.286397
        ],
        [
          14.497141,
          67.286113
        ],
        [
          14.493418,
          67.285917
        ],
        [
          14.484208,
          67.285438
        ],
        [
          14.477057,
          67.285065
        ],
        [
          14.473103,
          67.284852
        ],
        [
          14.465556,
          67.284454
        ],
        [
          14.461436,
          67.283979
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Sildvik - Narvik|line/1",
      "name": "Sildvik - Narvik",
      "category": "line",
      "fromExternalId": "way/1065776932",
      "toExternalId": "relation/8292228",
      "nominalKv": 132,
      "lengthKm": 4.24,
      "operator": "Statnett",
      "path": [
        [
          17.796793,
          68.409017
        ],
        [
          17.796237,
          68.40908
        ],
        [
          17.791425,
          68.410833
        ],
        [
          17.783577,
          68.4137
        ],
        [
          17.777738,
          68.415818
        ],
        [
          17.773403,
          68.417305
        ],
        [
          17.768245,
          68.419021
        ],
        [
          17.761787,
          68.420873
        ],
        [
          17.754105,
          68.422974
        ],
        [
          17.742078,
          68.425401
        ],
        [
          17.73688,
          68.426144
        ],
        [
          17.733186,
          68.426673
        ],
        [
          17.727873,
          68.427434
        ],
        [
          17.717814,
          68.428872
        ],
        [
          17.714341,
          68.429374
        ],
        [
          17.713469,
          68.429403
        ],
        [
          17.712568,
          68.429531
        ],
        [
          17.711692,
          68.429656
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Kvanndal - Sildvik|line/1",
      "name": "Kvanndal - Sildvik",
      "category": "line",
      "fromExternalId": "relation/8292228",
      "toExternalId": "way/1065776932",
      "nominalKv": 132,
      "lengthKm": 4.22,
      "operator": "Statnett",
      "path": [
        [
          17.712003,
          68.429802
        ],
        [
          17.712745,
          68.429695
        ],
        [
          17.713641,
          68.429566
        ],
        [
          17.714534,
          68.429558
        ],
        [
          17.71775,
          68.429115
        ],
        [
          17.727658,
          68.427681
        ],
        [
          17.732961,
          68.426933
        ],
        [
          17.736483,
          68.426438
        ],
        [
          17.741005,
          68.425797
        ],
        [
          17.754743,
          68.423039
        ],
        [
          17.762159,
          68.42106
        ],
        [
          17.767703,
          68.419493
        ],
        [
          17.773942,
          68.417396
        ],
        [
          17.778389,
          68.415873
        ],
        [
          17.783966,
          68.413841
        ],
        [
          17.793278,
          68.41045
        ],
        [
          17.796451,
          68.409287
        ],
        [
          17.796759,
          68.409207
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Finnfjordbotn - Silsand|line/0",
      "name": "Finnfjordbotn - Silsand",
      "category": "line",
      "fromExternalId": "relation/8285305",
      "toExternalId": "relation/9347309",
      "nominalKv": 132,
      "lengthKm": 4.17,
      "operator": "Arva",
      "path": [
        [
          18.091232,
          69.234843
        ],
        [
          18.088563,
          69.235909
        ],
        [
          18.085834,
          69.23702
        ],
        [
          18.080618,
          69.23916
        ],
        [
          18.077963,
          69.240238
        ],
        [
          18.075457,
          69.24127
        ],
        [
          18.067026,
          69.241869
        ],
        [
          18.062677,
          69.242185
        ],
        [
          18.055214,
          69.242717
        ],
        [
          18.042583,
          69.243629
        ],
        [
          18.036693,
          69.24405
        ],
        [
          18.027248,
          69.244725
        ],
        [
          18.023356,
          69.244963
        ],
        [
          18.020197,
          69.245154
        ],
        [
          18.016093,
          69.245406
        ],
        [
          18.003615,
          69.246163
        ],
        [
          17.998022,
          69.247421
        ],
        [
          17.996383,
          69.247782
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Alut|Skillemoen - Skoddevarre|line/0",
      "name": "Skillemoen - Skoddevarre",
      "category": "line",
      "fromExternalId": "way/672093604",
      "toExternalId": "relation/9346333",
      "nominalKv": 132,
      "lengthKm": 4.11,
      "operator": "Alut",
      "path": [
        [
          23.232102,
          69.910455
        ],
        [
          23.230014,
          69.911022
        ],
        [
          23.22409,
          69.91284
        ],
        [
          23.221614,
          69.914701
        ],
        [
          23.218371,
          69.917843
        ],
        [
          23.217148,
          69.919793
        ],
        [
          23.216948,
          69.920588
        ],
        [
          23.216863,
          69.923247
        ],
        [
          23.215953,
          69.924384
        ],
        [
          23.213519,
          69.927437
        ],
        [
          23.211662,
          69.929857
        ],
        [
          23.210009,
          69.932118
        ],
        [
          23.211712,
          69.933366
        ],
        [
          23.214248,
          69.935238
        ],
        [
          23.217334,
          69.937518
        ],
        [
          23.219547,
          69.939867
        ],
        [
          23.225272,
          69.941904
        ],
        [
          23.229564,
          69.941056
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Guolášjohka - Skibotn|line/4",
      "name": "Guolášjohka - Skibotn",
      "category": "line",
      "fromExternalId": "way/572898605",
      "toExternalId": "relation/13009239",
      "nominalKv": 132,
      "lengthKm": 4.08,
      "operator": "Statnett",
      "path": [
        [
          20.583658,
          69.417853
        ],
        [
          20.581671,
          69.417106
        ],
        [
          20.573967,
          69.414197
        ],
        [
          20.570033,
          69.410803
        ],
        [
          20.568952,
          69.409855
        ],
        [
          20.567683,
          69.408767
        ],
        [
          20.563928,
          69.405499
        ],
        [
          20.563939,
          69.404074
        ],
        [
          20.563931,
          69.402304
        ],
        [
          20.563936,
          69.399377
        ],
        [
          20.563941,
          69.397822
        ],
        [
          20.563931,
          69.396494
        ],
        [
          20.563949,
          69.393159
        ],
        [
          20.563963,
          69.39144
        ],
        [
          20.563957,
          69.389708
        ],
        [
          20.563952,
          69.388313
        ],
        [
          20.563957,
          69.384566
        ],
        [
          20.563963,
          69.383225
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Kvaløya - Charlottenlund|cable/1",
      "name": "Kvaløya - Charlottenlund",
      "category": "cable",
      "fromExternalId": "relation/8281954",
      "toExternalId": "relation/9344645",
      "nominalKv": 132,
      "lengthKm": 4.06,
      "operator": "Arva",
      "path": [
        [
          18.907178,
          69.689174
        ],
        [
          18.908812,
          69.687821
        ],
        [
          18.908307,
          69.685464
        ],
        [
          18.904483,
          69.683331
        ],
        [
          18.900948,
          69.680407
        ],
        [
          18.901522,
          69.679006
        ],
        [
          18.9026,
          69.678141
        ],
        [
          18.906591,
          69.675429
        ],
        [
          18.907412,
          69.673539
        ],
        [
          18.909241,
          69.672444
        ],
        [
          18.912961,
          69.671981
        ],
        [
          18.918784,
          69.671236
        ],
        [
          18.921458,
          69.669966
        ],
        [
          18.924288,
          69.668856
        ],
        [
          18.936578,
          69.667553
        ],
        [
          18.942082,
          69.6665
        ],
        [
          18.943949,
          69.665545
        ],
        [
          18.950472,
          69.663991
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Tjønndal - Vestbyen|cable/0",
      "name": "Tjønndal - Vestbyen",
      "category": "cable",
      "fromExternalId": "way/588074267",
      "toExternalId": "way/542630292",
      "nominalKv": 132,
      "lengthKm": 3.99,
      "operator": "Arva",
      "path": [
        [
          14.460835,
          67.283782
        ],
        [
          14.445592,
          67.28098
        ],
        [
          14.438645,
          67.278625
        ],
        [
          14.435524,
          67.278817
        ],
        [
          14.434893,
          67.278145
        ],
        [
          14.433778,
          67.277552
        ],
        [
          14.432568,
          67.277929
        ],
        [
          14.4297,
          67.277169
        ],
        [
          14.427806,
          67.276894
        ],
        [
          14.42326,
          67.275971
        ],
        [
          14.420779,
          67.275497
        ],
        [
          14.41656,
          67.27572
        ],
        [
          14.411761,
          67.276004
        ],
        [
          14.402534,
          67.275203
        ],
        [
          14.394767,
          67.274617
        ],
        [
          14.388253,
          67.274039
        ],
        [
          14.384067,
          67.274121
        ],
        [
          14.380033,
          67.274057
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Alut|Aronnes - Raipas|line/0",
      "name": "Aronnes - Raipas",
      "category": "line",
      "fromExternalId": "relation/8279949",
      "toExternalId": "relation/8278085",
      "nominalKv": 132,
      "lengthKm": 3.98,
      "operator": "Alut",
      "path": [
        [
          23.285734,
          69.966196
        ],
        [
          23.288948,
          69.96495
        ],
        [
          23.291775,
          69.963851
        ],
        [
          23.296158,
          69.962136
        ],
        [
          23.299334,
          69.960906
        ],
        [
          23.305156,
          69.958628
        ],
        [
          23.316733,
          69.956479
        ],
        [
          23.323377,
          69.955685
        ],
        [
          23.331666,
          69.955087
        ],
        [
          23.335882,
          69.954782
        ],
        [
          23.344085,
          69.954539
        ],
        [
          23.347915,
          69.954426
        ],
        [
          23.354158,
          69.954241
        ],
        [
          23.358921,
          69.953097
        ],
        [
          23.362336,
          69.952284
        ],
        [
          23.365614,
          69.951508
        ],
        [
          23.369237,
          69.950641
        ],
        [
          23.372752,
          69.951792
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Lucerna|Hyggevatn - Melkøya|cable/0",
      "name": "Hyggevatn - Melkøya",
      "category": "cable",
      "fromExternalId": "way/511117400",
      "toExternalId": "way/685025511",
      "nominalKv": 132,
      "lengthKm": 3.89,
      "operator": "Lucerna",
      "path": [
        [
          23.690327,
          70.67595
        ],
        [
          23.686995,
          70.67535
        ],
        [
          23.6836,
          70.676019
        ],
        [
          23.680767,
          70.676898
        ],
        [
          23.677409,
          70.676917
        ],
        [
          23.674502,
          70.676058
        ],
        [
          23.672318,
          70.675676
        ],
        [
          23.66587,
          70.676134
        ],
        [
          23.662078,
          70.674459
        ],
        [
          23.6588,
          70.673837
        ],
        [
          23.654149,
          70.674034
        ],
        [
          23.651252,
          70.674546
        ],
        [
          23.646231,
          70.676246
        ],
        [
          23.641613,
          70.677006
        ],
        [
          23.639279,
          70.678463
        ],
        [
          23.633963,
          70.679494
        ],
        [
          23.625605,
          70.68479
        ],
        [
          23.615643,
          70.68906
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Svabo - Rana kraftverk|line/4",
      "name": "Svabo - Rana kraftverk",
      "category": "line",
      "fromExternalId": "way/589085618",
      "toExternalId": "way/197866182",
      "nominalKv": 132,
      "lengthKm": 3.83,
      "operator": "Linea",
      "path": [
        [
          14.177294,
          66.304759
        ],
        [
          14.178052,
          66.304178
        ],
        [
          14.181614,
          66.303646
        ],
        [
          14.185802,
          66.303028
        ],
        [
          14.190897,
          66.302258
        ],
        [
          14.199014,
          66.301696
        ],
        [
          14.205499,
          66.301249
        ],
        [
          14.213444,
          66.30069
        ],
        [
          14.218881,
          66.300817
        ],
        [
          14.228647,
          66.301039
        ],
        [
          14.234438,
          66.301191
        ],
        [
          14.240845,
          66.301377
        ],
        [
          14.244597,
          66.301464
        ],
        [
          14.25218,
          66.301392
        ],
        [
          14.256204,
          66.301356
        ],
        [
          14.260868,
          66.301306
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Svabo - Rana kraftverk|line/5",
      "name": "Svabo - Rana kraftverk",
      "category": "line",
      "fromExternalId": "way/589085618",
      "toExternalId": "way/197866182",
      "nominalKv": 132,
      "lengthKm": 3.75,
      "operator": "Linea",
      "path": [
        [
          14.17786,
          66.304762
        ],
        [
          14.178428,
          66.304353
        ],
        [
          14.181722,
          66.30386
        ],
        [
          14.186004,
          66.30323
        ],
        [
          14.191061,
          66.30248
        ],
        [
          14.199102,
          66.301934
        ],
        [
          14.205588,
          66.301478
        ],
        [
          14.213565,
          66.300915
        ],
        [
          14.218851,
          66.301041
        ],
        [
          14.228601,
          66.30127
        ],
        [
          14.234397,
          66.301422
        ],
        [
          14.240797,
          66.301596
        ],
        [
          14.244625,
          66.301686
        ],
        [
          14.252191,
          66.301615
        ],
        [
          14.25622,
          66.301579
        ],
        [
          14.259939,
          66.301536
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Linea|Langvatn - Svabo|line/0",
      "name": "Langvatn - Svabo",
      "category": "line",
      "fromExternalId": "relation/11636421",
      "toExternalId": "way/589085618",
      "nominalKv": 132,
      "lengthKm": 3.74,
      "operator": "Linea",
      "path": [
        [
          14.166973,
          66.337
        ],
        [
          14.166733,
          66.336491
        ],
        [
          14.165235,
          66.333333
        ],
        [
          14.164516,
          66.331774
        ],
        [
          14.165335,
          66.330313
        ],
        [
          14.167167,
          66.326162
        ],
        [
          14.169105,
          66.322595
        ],
        [
          14.170297,
          66.320613
        ],
        [
          14.17398,
          66.318151
        ],
        [
          14.179782,
          66.314403
        ],
        [
          14.18174,
          66.310893
        ],
        [
          14.183194,
          66.307855
        ],
        [
          14.179196,
          66.306115
        ],
        [
          14.1788,
          66.305612
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Halsa - Enga|line/4",
      "name": "Halsa - Enga",
      "category": "line",
      "fromExternalId": "relation/8301304",
      "toExternalId": "way/588443638",
      "nominalKv": 132,
      "lengthKm": 3.61,
      "operator": "Arva",
      "path": [
        [
          13.60569,
          66.776358
        ],
        [
          13.599575,
          66.776302
        ],
        [
          13.594551,
          66.776256
        ],
        [
          13.590324,
          66.776218
        ],
        [
          13.585072,
          66.776162
        ],
        [
          13.577838,
          66.776096
        ],
        [
          13.574976,
          66.776066
        ],
        [
          13.569231,
          66.776558
        ],
        [
          13.566997,
          66.777226
        ],
        [
          13.563502,
          66.778273
        ],
        [
          13.558753,
          66.779529
        ],
        [
          13.552381,
          66.781225
        ],
        [
          13.549447,
          66.782001
        ],
        [
          13.544211,
          66.783393
        ],
        [
          13.541795,
          66.784037
        ],
        [
          13.537034,
          66.785302
        ],
        [
          13.534939,
          66.786211
        ],
        [
          13.532858,
          66.787148
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Lucerna|Hammerfest - Hyggevatn|line/0",
      "name": "Hammerfest - Hyggevatn",
      "category": "line",
      "fromExternalId": "way/586152359",
      "toExternalId": "way/511117400",
      "nominalKv": 132,
      "lengthKm": 3.57,
      "operator": "Lucerna",
      "path": [
        [
          23.715038,
          70.657107
        ],
        [
          23.719431,
          70.657594
        ],
        [
          23.721623,
          70.658016
        ],
        [
          23.72548,
          70.659987
        ],
        [
          23.729691,
          70.662674
        ],
        [
          23.73167,
          70.663756
        ],
        [
          23.735002,
          70.665575
        ],
        [
          23.738907,
          70.667724
        ],
        [
          23.741139,
          70.66894
        ],
        [
          23.744926,
          70.671013
        ],
        [
          23.746664,
          70.671968
        ],
        [
          23.747753,
          70.674402
        ],
        [
          23.747367,
          70.6765
        ],
        [
          23.744942,
          70.677594
        ],
        [
          23.739669,
          70.679606
        ],
        [
          23.734809,
          70.68092
        ],
        [
          23.73203,
          70.680636
        ],
        [
          23.727148,
          70.680133
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Statnett|Hinnøy - Sortland|line/1",
      "name": "Hinnøy - Sortland",
      "category": "line",
      "fromExternalId": "way/179044834",
      "toExternalId": "relation/8289305",
      "nominalKv": 132,
      "lengthKm": 3.53,
      "operator": "Statnett",
      "path": [
        [
          15.499808,
          68.683508
        ],
        [
          15.497627,
          68.68356
        ],
        [
          15.491036,
          68.684243
        ],
        [
          15.48553,
          68.684807
        ],
        [
          15.480332,
          68.686323
        ],
        [
          15.475043,
          68.687875
        ],
        [
          15.470869,
          68.68971
        ],
        [
          15.467248,
          68.691585
        ],
        [
          15.464528,
          68.694026
        ],
        [
          15.461334,
          68.696931
        ],
        [
          15.4586,
          68.699397
        ],
        [
          15.455462,
          68.702392
        ],
        [
          15.452979,
          68.704798
        ],
        [
          15.448362,
          68.706429
        ],
        [
          15.447547,
          68.706498
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Tverråsen - Brensholmeneidet|line/0",
      "name": "Tverråsen - Brensholmeneidet",
      "category": "line",
      "fromExternalId": "way/1158040166",
      "toExternalId": "relation/8281952",
      "nominalKv": 132,
      "lengthKm": 3.32,
      "operator": "Arva",
      "path": [
        [
          18.15097,
          69.566335
        ],
        [
          18.146678,
          69.566385
        ],
        [
          18.144468,
          69.56641
        ],
        [
          18.140775,
          69.565854
        ],
        [
          18.135901,
          69.565125
        ],
        [
          18.127224,
          69.563819
        ],
        [
          18.123708,
          69.56329
        ],
        [
          18.119926,
          69.562724
        ],
        [
          18.11642,
          69.562195
        ],
        [
          18.114616,
          69.561922
        ],
        [
          18.111056,
          69.56259
        ],
        [
          18.098447,
          69.564952
        ],
        [
          18.09309,
          69.565955
        ],
        [
          18.086063,
          69.56727
        ],
        [
          18.08216,
          69.568001
        ],
        [
          18.078287,
          69.568726
        ],
        [
          18.074799,
          69.568826
        ],
        [
          18.073045,
          69.568868
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Stokmarknes avgr.|line/0",
      "name": "Stokmarknes avgr.",
      "category": "line",
      "fromExternalId": "way/1156216252",
      "toExternalId": "relation/8288762",
      "nominalKv": 132,
      "lengthKm": 3.29,
      "operator": "Noranett",
      "path": [
        [
          14.976412,
          68.54776
        ],
        [
          14.976176,
          68.547822
        ],
        [
          14.974344,
          68.548371
        ],
        [
          14.970382,
          68.54914
        ],
        [
          14.962671,
          68.54985
        ],
        [
          14.958267,
          68.550258
        ],
        [
          14.956172,
          68.55045
        ],
        [
          14.951395,
          68.550888
        ],
        [
          14.947323,
          68.551268
        ],
        [
          14.944367,
          68.551541
        ],
        [
          14.937568,
          68.552169
        ],
        [
          14.930232,
          68.552845
        ],
        [
          14.926772,
          68.553163
        ],
        [
          14.920941,
          68.553702
        ],
        [
          14.915276,
          68.554901
        ],
        [
          14.909692,
          68.556081
        ],
        [
          14.907144,
          68.556619
        ],
        [
          14.901322,
          68.55785
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Heggen - Medkila|line/0",
      "name": "Heggen - Medkila",
      "category": "line",
      "fromExternalId": "way/587607517",
      "toExternalId": "relation/8292075",
      "nominalKv": 132,
      "lengthKm": 3.16,
      "operator": "Noranett",
      "path": [
        [
          16.515452,
          68.792047
        ],
        [
          16.514028,
          68.79096
        ],
        [
          16.511571,
          68.789089
        ],
        [
          16.510477,
          68.78826
        ],
        [
          16.507478,
          68.787304
        ],
        [
          16.502978,
          68.785869
        ],
        [
          16.501077,
          68.783511
        ],
        [
          16.5015,
          68.782786
        ],
        [
          16.502422,
          68.781247
        ],
        [
          16.507079,
          68.778208
        ],
        [
          16.5103,
          68.777072
        ],
        [
          16.511219,
          68.776737
        ],
        [
          16.51401,
          68.775486
        ],
        [
          16.518669,
          68.77316
        ],
        [
          16.520986,
          68.772006
        ],
        [
          16.522006,
          68.771376
        ],
        [
          16.525531,
          68.769169
        ],
        [
          16.526923,
          68.768304
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Charlottenlund - Gimle|cable/0",
      "name": "Charlottenlund - Gimle",
      "category": "cable",
      "fromExternalId": "relation/9344645",
      "toExternalId": "relation/9344646",
      "nominalKv": 132,
      "lengthKm": 3.15,
      "operator": "Arva",
      "path": [
        [
          18.951196,
          69.664101
        ],
        [
          18.952296,
          69.666043
        ],
        [
          18.954313,
          69.668638
        ],
        [
          18.958502,
          69.671732
        ],
        [
          18.958679,
          69.673277
        ],
        [
          18.957885,
          69.673593
        ],
        [
          18.958384,
          69.675792
        ],
        [
          18.958202,
          69.679066
        ],
        [
          18.959377,
          69.680332
        ],
        [
          18.965315,
          69.680505
        ],
        [
          18.966206,
          69.680921
        ],
        [
          18.96737,
          69.681917
        ],
        [
          18.968126,
          69.68308
        ],
        [
          18.969596,
          69.683914
        ],
        [
          18.970031,
          69.684493
        ],
        [
          18.975513,
          69.685926
        ],
        [
          18.976666,
          69.68636
        ],
        [
          18.978734,
          69.687298
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elkem|Valljord - Salten verk|line/0",
      "name": "Valljord - Salten verk",
      "category": "line",
      "fromExternalId": "relation/8296015",
      "toExternalId": "relation/8296013",
      "nominalKv": 132,
      "lengthKm": 3.14,
      "operator": "Elkem",
      "path": [
        [
          15.554137,
          67.340672
        ],
        [
          15.553481,
          67.34093
        ],
        [
          15.552601,
          67.342882
        ],
        [
          15.554323,
          67.344122
        ],
        [
          15.554865,
          67.344804
        ],
        [
          15.557274,
          67.347845
        ],
        [
          15.558057,
          67.348829
        ],
        [
          15.558862,
          67.349833
        ],
        [
          15.560637,
          67.352074
        ],
        [
          15.561206,
          67.352774
        ],
        [
          15.562504,
          67.354409
        ],
        [
          15.564084,
          67.355783
        ],
        [
          15.565449,
          67.356979
        ],
        [
          15.56774,
          67.358989
        ],
        [
          15.568941,
          67.360039
        ],
        [
          15.569977,
          67.360947
        ],
        [
          15.57209,
          67.362807
        ],
        [
          15.583746,
          67.362088
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Elkem|Valljord - Salten verk|line/1",
      "name": "Valljord - Salten verk",
      "category": "line",
      "fromExternalId": "relation/8296015",
      "toExternalId": "relation/8296013",
      "nominalKv": 132,
      "lengthKm": 3.14,
      "operator": "Elkem",
      "path": [
        [
          15.554327,
          67.340729
        ],
        [
          15.553881,
          67.341037
        ],
        [
          15.553122,
          67.342843
        ],
        [
          15.554763,
          67.344035
        ],
        [
          15.556517,
          67.346261
        ],
        [
          15.55751,
          67.347521
        ],
        [
          15.55811,
          67.348279
        ],
        [
          15.560224,
          67.35093
        ],
        [
          15.561082,
          67.352012
        ],
        [
          15.562343,
          67.353578
        ],
        [
          15.562955,
          67.354346
        ],
        [
          15.566171,
          67.357156
        ],
        [
          15.567163,
          67.358022
        ],
        [
          15.568177,
          67.358905
        ],
        [
          15.570819,
          67.361211
        ],
        [
          15.572095,
          67.362354
        ],
        [
          15.575486,
          67.363476
        ],
        [
          15.583831,
          67.362176
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Reppa - Halsa|line/4",
      "name": "Reppa - Halsa",
      "category": "line",
      "fromExternalId": "relation/8301304",
      "toExternalId": "relation/14018338",
      "nominalKv": 132,
      "lengthKm": 3.09,
      "operator": "Arva",
      "path": [
        [
          13.591123,
          66.717438
        ],
        [
          13.58706,
          66.715007
        ],
        [
          13.575073,
          66.691411
        ],
        [
          13.576106,
          66.690764
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|||cable/118",
      "name": "merged/cable/cable|132|||cable/118",
      "category": "cable",
      "fromExternalId": "way/1158040189",
      "toExternalId": "way/1158040166",
      "nominalKv": 132,
      "lengthKm": 3.07,
      "operator": null,
      "path": [
        [
          18.217669,
          69.573602
        ],
        [
          18.212917,
          69.57165
        ],
        [
          18.207426,
          69.570607
        ],
        [
          18.204408,
          69.569256
        ],
        [
          18.204245,
          69.567952
        ],
        [
          18.202739,
          69.567068
        ],
        [
          18.196612,
          69.567071
        ],
        [
          18.190685,
          69.567416
        ],
        [
          18.18466,
          69.568412
        ],
        [
          18.181022,
          69.568727
        ],
        [
          18.17719,
          69.569504
        ],
        [
          18.173743,
          69.569885
        ],
        [
          18.169965,
          69.569572
        ],
        [
          18.165034,
          69.569554
        ],
        [
          18.161057,
          69.570104
        ],
        [
          18.158511,
          69.570006
        ],
        [
          18.156777,
          69.569147
        ],
        [
          18.155837,
          69.568392
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Balsfjord - Storsteinnes|line/0",
      "name": "Balsfjord - Storsteinnes",
      "category": "line",
      "fromExternalId": "way/572898616",
      "toExternalId": "relation/8283080",
      "nominalKv": 132,
      "lengthKm": 3.07,
      "operator": "Arva",
      "path": [
        [
          19.206392,
          69.19038
        ],
        [
          19.207857,
          69.191294
        ],
        [
          19.211837,
          69.192522
        ],
        [
          19.218521,
          69.194488
        ],
        [
          19.222357,
          69.195617
        ],
        [
          19.225887,
          69.196654
        ],
        [
          19.228939,
          69.19754
        ],
        [
          19.235666,
          69.199512
        ],
        [
          19.23904,
          69.200502
        ],
        [
          19.24205,
          69.201382
        ],
        [
          19.244909,
          69.202213
        ],
        [
          19.250252,
          69.20379
        ],
        [
          19.250166,
          69.204329
        ],
        [
          19.248766,
          69.205675
        ],
        [
          19.247274,
          69.207088
        ],
        [
          19.244284,
          69.209906
        ],
        [
          19.24394,
          69.21031
        ],
        [
          19.243927,
          69.210253
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Reppa - Halsa|line/3",
      "name": "Reppa - Halsa",
      "category": "line",
      "fromExternalId": "relation/8301304",
      "toExternalId": "relation/14018338",
      "nominalKv": 132,
      "lengthKm": 3.06,
      "operator": "Arva",
      "path": [
        [
          13.591123,
          66.717438
        ],
        [
          13.587727,
          66.714993
        ],
        [
          13.575936,
          66.691312
        ],
        [
          13.576106,
          66.690764
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Arva|Reppa - Halsa|line/2",
      "name": "Reppa - Halsa",
      "category": "line",
      "fromExternalId": "relation/8301304",
      "toExternalId": "relation/14018338",
      "nominalKv": 132,
      "lengthKm": 3.05,
      "operator": "Arva",
      "path": [
        [
          13.591123,
          66.717438
        ],
        [
          13.588433,
          66.715
        ],
        [
          13.576835,
          66.691176
        ],
        [
          13.576106,
          66.690764
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Gåsvatn - Gåra|line/0",
      "name": "Gåsvatn - Gåra",
      "category": "line",
      "fromExternalId": "relation/8292077",
      "toExternalId": "relation/8292079",
      "nominalKv": 132,
      "lengthKm": 3.02,
      "operator": "Noranett",
      "path": [
        [
          16.254205,
          68.758227
        ],
        [
          16.255805,
          68.758204
        ],
        [
          16.260723,
          68.758134
        ],
        [
          16.2624,
          68.758435
        ],
        [
          16.269886,
          68.759793
        ],
        [
          16.270866,
          68.759966
        ],
        [
          16.27382,
          68.760251
        ],
        [
          16.281323,
          68.760975
        ],
        [
          16.284596,
          68.761285
        ],
        [
          16.291094,
          68.761583
        ],
        [
          16.294347,
          68.761624
        ],
        [
          16.301624,
          68.762009
        ],
        [
          16.305704,
          68.76236
        ],
        [
          16.309824,
          68.762695
        ],
        [
          16.316395,
          68.763826
        ],
        [
          16.319985,
          68.764726
        ],
        [
          16.324348,
          68.765812
        ],
        [
          16.324481,
          68.765904
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Noranett|Sørfjord vindpark - Sørfjord kraftverk|line/0",
      "name": "Sørfjord vindpark - Sørfjord kraftverk",
      "category": "line",
      "fromExternalId": "way/842686943",
      "toExternalId": "way/1160239696",
      "nominalKv": 132,
      "lengthKm": 2.87,
      "operator": "Noranett",
      "path": [
        [
          16.671987,
          68.042345
        ],
        [
          16.672192,
          68.043419
        ],
        [
          16.672369,
          68.044352
        ],
        [
          16.673239,
          68.047342
        ],
        [
          16.674038,
          68.048858
        ],
        [
          16.674322,
          68.049395
        ],
        [
          16.675481,
          68.051577
        ],
        [
          16.675953,
          68.053526
        ],
        [
          16.676358,
          68.055178
        ],
        [
          16.670535,
          68.056493
        ],
        [
          16.668003,
          68.057062
        ],
        [
          16.665981,
          68.057516
        ],
        [
          16.66368,
          68.058037
        ],
        [
          16.661397,
          68.058546
        ],
        [
          16.659297,
          68.059023
        ],
        [
          16.657079,
          68.06151
        ],
        [
          16.659068,
          68.062521
        ],
        [
          16.661451,
          68.063732
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Mestervik - Håkøybotn - Kvaløya|cable/0",
      "name": "Mestervik - Håkøybotn - Kvaløya",
      "category": "cable",
      "fromExternalId": "relation/8280921",
      "toExternalId": "way/586667770",
      "nominalKv": 132,
      "lengthKm": 2.48,
      "operator": "Arva",
      "path": [
        [
          18.814087,
          69.556938
        ],
        [
          18.813972,
          69.556996
        ],
        [
          18.81387,
          69.557012
        ],
        [
          18.813715,
          69.557014
        ],
        [
          18.81334,
          69.556984
        ],
        [
          18.812859,
          69.556938
        ],
        [
          18.812145,
          69.556864
        ],
        [
          18.811259,
          69.556778
        ],
        [
          18.810581,
          69.556711
        ],
        [
          18.80883,
          69.556916
        ],
        [
          18.807006,
          69.557358
        ],
        [
          18.805654,
          69.557935
        ],
        [
          18.782523,
          69.57351
        ],
        [
          18.781954,
          69.573791
        ],
        [
          18.780115,
          69.574518
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/line/line|132|Barents Nett|Hamnefjellet - Båtsfjord|line/0",
      "name": "Hamnefjellet - Båtsfjord",
      "category": "line",
      "fromExternalId": "way/671990796",
      "toExternalId": "way/657434624",
      "nominalKv": 132,
      "lengthKm": 2.23,
      "operator": "Barents Nett",
      "path": [
        [
          29.709554,
          70.660207
        ],
        [
          29.708898,
          70.658792
        ],
        [
          29.708285,
          70.657472
        ],
        [
          29.707822,
          70.656474
        ],
        [
          29.707275,
          70.655289
        ],
        [
          29.706003,
          70.652525
        ],
        [
          29.707144,
          70.650658
        ],
        [
          29.708148,
          70.649016
        ],
        [
          29.70915,
          70.647383
        ],
        [
          29.710082,
          70.64586
        ],
        [
          29.710562,
          70.645076
        ],
        [
          29.711504,
          70.643536
        ],
        [
          29.712303,
          70.642227
        ],
        [
          29.713032,
          70.641037
        ],
        [
          29.713373,
          70.640476
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Elmea|Fygle - Solbjørn|cable/0",
      "name": "Fygle - Solbjørn",
      "category": "cable",
      "fromExternalId": "way/587356986",
      "toExternalId": "way/154904137",
      "nominalKv": 132,
      "lengthKm": 2.22,
      "operator": "Elmea",
      "path": [
        [
          13.343904,
          68.111058
        ],
        [
          13.344113,
          68.111234
        ],
        [
          13.343582,
          68.111312
        ],
        [
          13.341903,
          68.11115
        ],
        [
          13.340463,
          68.110884
        ],
        [
          13.318906,
          68.10727
        ],
        [
          13.317221,
          68.106774
        ],
        [
          13.316181,
          68.105009
        ],
        [
          13.316127,
          68.104501
        ],
        [
          13.315634,
          68.103637
        ],
        [
          13.312865,
          68.102929
        ],
        [
          13.309494,
          68.10197
        ],
        [
          13.308896,
          68.102028
        ],
        [
          13.306238,
          68.10241
        ],
        [
          13.305186,
          68.102563
        ],
        [
          13.303717,
          68.102645
        ],
        [
          13.303548,
          68.102553
        ],
        [
          13.303875,
          68.102497
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Mestervik - Sandvika|cable/1",
      "name": "Mestervik - Sandvika",
      "category": "cable",
      "fromExternalId": "way/586502774",
      "toExternalId": "relation/8280921",
      "nominalKv": 132,
      "lengthKm": 2.14,
      "operator": "Arva",
      "path": [
        [
          18.989498,
          69.423
        ],
        [
          19.007489,
          69.441174
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "merged/cable/cable|132|Arva|Mestervik - Sandvika|cable/0",
      "name": "Mestervik - Sandvika",
      "category": "cable",
      "fromExternalId": "way/586502774",
      "toExternalId": "relation/8280921",
      "nominalKv": 132,
      "lengthKm": 2.12,
      "operator": "Arva",
      "path": [
        [
          18.987209,
          69.423429
        ],
        [
          19.005798,
          69.441372
        ]
      ],
      "sourceId": "osm:pbf-power:NO"
    }
  ],
  "generators": [
    {
      "externalId": "way/638639750",
      "name": "Kvilldal kraftverk",
      "generationKind": "hydro",
      "lon": 6.658934,
      "lat": 59.527002,
      "capacityMw": 1240,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/405308297",
      "name": "Sima kraftverk",
      "generationKind": "hydro",
      "lon": 7.140678,
      "lat": 60.507178,
      "capacityMw": 1120,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/641020745",
      "name": "Tonstad kraftverk",
      "generationKind": "hydro",
      "lon": 6.728753,
      "lat": 58.658427,
      "capacityMw": 960,
      "annualProductionGwh": null,
      "operator": "Sira-Kvina kraftselskap",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549710305",
      "name": "Aurland I kraftverk",
      "generationKind": "hydro",
      "lon": 7.300788,
      "lat": 60.852436,
      "capacityMw": 840,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/640269814",
      "name": "Saurdal pumpekraftverk",
      "generationKind": "hydro",
      "lon": 6.691015,
      "lat": 59.480779,
      "capacityMw": 640,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/588709903",
      "name": "Svartisen kraftverk",
      "generationKind": "hydro",
      "lon": 13.931275,
      "lat": 66.724564,
      "capacityMw": 600,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/589054119",
      "name": "Rana kraftverk",
      "generationKind": "hydro",
      "lon": 14.270286,
      "lat": 66.295044,
      "capacityMw": 500,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
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
      "externalId": "way/550054817",
      "name": "Tyin kraftverk",
      "generationKind": "hydro",
      "lon": 7.849996,
      "lat": 61.297154,
      "capacityMw": 374,
      "annualProductionGwh": null,
      "operator": "Hydro Energi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/640600961",
      "name": "Lysebotn 2 kraftverk",
      "generationKind": "hydro",
      "lon": 6.632287,
      "lat": 59.065353,
      "capacityMw": 370,
      "annualProductionGwh": null,
      "operator": "Hydro Energi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/610542206",
      "name": "Nedre Røssåga kraftverk",
      "generationKind": "hydro",
      "lon": 13.773851,
      "lat": 66.052064,
      "capacityMw": 350,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
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
      "externalId": "way/545991307",
      "name": "Evanger kraftverk",
      "generationKind": "hydro",
      "lon": 6.118614,
      "lat": 60.662237,
      "capacityMw": 330,
      "annualProductionGwh": null,
      "operator": "Eviny Fornybar",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
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
      "externalId": "way/290618085",
      "name": "Holen kraftverk",
      "generationKind": "hydro",
      "lon": 7.247908,
      "lat": 59.353123,
      "capacityMw": 328,
      "annualProductionGwh": null,
      "operator": "Å Energi Vannkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/430780482",
      "name": "Suldal I&II kraftverk",
      "generationKind": "hydro",
      "lon": 6.821643,
      "lat": 59.652301,
      "capacityMw": 323,
      "annualProductionGwh": null,
      "operator": "Norsk Hydro Rjukan",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "node/4075141309",
      "name": "Sy-Sima",
      "generationKind": "hydro",
      "lon": 7.141081,
      "lat": 60.507225,
      "capacityMw": 310,
      "annualProductionGwh": null,
      "operator": null,
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "node/4075141310",
      "name": "Sy-Sima",
      "generationKind": "hydro",
      "lon": 7.141329,
      "lat": 60.507221,
      "capacityMw": 310,
      "annualProductionGwh": null,
      "operator": null,
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/656092209",
      "name": "Nedre Vinstra kraftverk",
      "generationKind": "hydro",
      "lon": 9.792932,
      "lat": 61.564568,
      "capacityMw": 308,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
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
      "externalId": "way/587726951",
      "name": "Skjomen kraftverk",
      "generationKind": "hydro",
      "lon": 17.365824,
      "lat": 68.20103,
      "capacityMw": 300,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/587802935",
      "name": "Kobbelv kraftverk",
      "generationKind": "hydro",
      "lon": 16.007009,
      "lat": 67.621651,
      "capacityMw": 300,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549832656",
      "name": "Aura kraftverk",
      "generationKind": "hydro",
      "lon": 8.514934,
      "lat": 62.66413,
      "capacityMw": 290,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549798912",
      "name": "Jostedal kraftverk",
      "generationKind": "hydro",
      "lon": 7.308567,
      "lat": 61.520882,
      "capacityMw": 288,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/638948945",
      "name": "Sønnå kraftverk",
      "generationKind": "hydro",
      "lon": 6.37885,
      "lat": 59.63989,
      "capacityMw": 272,
      "annualProductionGwh": null,
      "operator": "Aktieselskabet Saudefaldene",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/547416982",
      "name": "Skagen kraftverk",
      "generationKind": "hydro",
      "lon": 7.706754,
      "lat": 61.504524,
      "capacityMw": 270,
      "annualProductionGwh": null,
      "operator": "Norsk Hydro",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549710285",
      "name": "Aurland III pumpekraftverk",
      "generationKind": "hydro",
      "lon": 7.571293,
      "lat": 60.798174,
      "capacityMw": 270,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "node/828924509",
      "name": "Lang-Sima",
      "generationKind": "hydro",
      "lon": 7.140496,
      "lat": 60.507235,
      "capacityMw": 250,
      "annualProductionGwh": null,
      "operator": null,
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "node/4075141308",
      "name": "Lang-Sima",
      "generationKind": "hydro",
      "lon": 7.140755,
      "lat": 60.507228,
      "capacityMw": 250,
      "annualProductionGwh": null,
      "operator": null,
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549672006",
      "name": "Mauranger kraftverk",
      "generationKind": "hydro",
      "lon": 6.337494,
      "lat": 60.127614,
      "capacityMw": 250,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
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
      "externalId": "way/549677067",
      "name": "Blåfalli Vik kraftverk",
      "generationKind": "hydro",
      "lon": 5.994151,
      "lat": 59.844063,
      "capacityMw": 230,
      "annualProductionGwh": null,
      "operator": "Sunnhordland Kraftlag",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
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
      "externalId": "way/685025522",
      "name": "Melkøya gasskraftverk",
      "generationKind": "thermal",
      "lon": 23.592399,
      "lat": 70.683874,
      "capacityMw": 229,
      "annualProductionGwh": null,
      "operator": "Equinor",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/638183296",
      "name": "Tysso II kraftverk",
      "generationKind": "hydro",
      "lon": 6.641947,
      "lat": 60.129922,
      "capacityMw": 220,
      "annualProductionGwh": null,
      "operator": "Statkraft",
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
      "externalId": "way/616457852",
      "name": "Nea & Tya kraftverk",
      "generationKind": "hydro",
      "lon": 11.703252,
      "lat": 63.032057,
      "capacityMw": 219,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/638183294",
      "name": "Oksla kraftverk",
      "generationKind": "hydro",
      "lon": 6.568846,
      "lat": 60.125893,
      "capacityMw": 215,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/995557775",
      "name": "Borgund kraftverk",
      "generationKind": "hydro",
      "lon": 7.832887,
      "lat": 61.058537,
      "capacityMw": 212,
      "annualProductionGwh": null,
      "operator": "Østfold Energi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/577998815",
      "name": "Skjerka kraftverk",
      "generationKind": "hydro",
      "lon": 7.367221,
      "lat": 58.558066,
      "capacityMw": 206.6,
      "annualProductionGwh": null,
      "operator": "Å Energi Vannkraft",
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
      "externalId": "way/640630146",
      "name": "Duge pumpekraftverk",
      "generationKind": "hydro",
      "lon": 6.892149,
      "lat": 59.128908,
      "capacityMw": 200,
      "annualProductionGwh": null,
      "operator": "Sira-Kvina kraftselskap",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/640796689",
      "name": "Solhom kraftverk",
      "generationKind": "hydro",
      "lon": 7.012932,
      "lat": 58.775705,
      "capacityMw": 200,
      "annualProductionGwh": null,
      "operator": "Sira-Kvina kraftselskap",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
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
      "externalId": "way/587829487",
      "name": "Siso kraftverk",
      "generationKind": "hydro",
      "lon": 15.722328,
      "lat": 67.323118,
      "capacityMw": 180,
      "annualProductionGwh": null,
      "operator": "Siso Energi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/728195699",
      "name": "Matre Haugsdal kraftverk",
      "generationKind": "hydro",
      "lon": 5.596933,
      "lat": 60.870116,
      "capacityMw": 180,
      "annualProductionGwh": null,
      "operator": "Eviny Fornybar",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/612346547",
      "name": "Tunnsjødal kraftverk",
      "generationKind": "hydro",
      "lon": 12.837351,
      "lat": 64.702608,
      "capacityMw": 176,
      "annualProductionGwh": null,
      "operator": "NTE Energi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/610609442",
      "name": "Øvre Røssåga kraftverk",
      "generationKind": "hydro",
      "lon": 13.800831,
      "lat": 65.886378,
      "capacityMw": 175,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549832208",
      "name": "Øvre Vinstra kraftverk",
      "generationKind": "hydro",
      "lon": 9.308322,
      "lat": 61.479599,
      "capacityMw": 172,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549836005",
      "name": "Steinsland kraftverk",
      "generationKind": "hydro",
      "lon": 5.985098,
      "lat": 60.923387,
      "capacityMw": 170,
      "annualProductionGwh": null,
      "operator": "Eviny Fornybar",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/638607390",
      "name": "Røldal kraftverk",
      "generationKind": "hydro",
      "lon": 6.818525,
      "lat": 59.818542,
      "capacityMw": 160,
      "annualProductionGwh": null,
      "operator": "Hydro Energi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/640269833",
      "name": "Hylen kraftverk",
      "generationKind": "hydro",
      "lon": 6.602326,
      "lat": 59.557849,
      "capacityMw": 160,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/285960777",
      "name": "Åna-Sira kraftverk",
      "generationKind": "hydro",
      "lon": 6.453114,
      "lat": 58.293735,
      "capacityMw": 150,
      "annualProductionGwh": null,
      "operator": "Sira-Kvina Kraftselskap",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/550059246",
      "name": "Matre kraftverk",
      "generationKind": "hydro",
      "lon": 5.59348,
      "lat": 60.872805,
      "capacityMw": 150,
      "annualProductionGwh": null,
      "operator": "Eviny Fornybar",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/550273474",
      "name": "Torpa kraftverk",
      "generationKind": "hydro",
      "lon": 10.03168,
      "lat": 61.006611,
      "capacityMw": 150,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/586089342",
      "name": "Alta kraftverk",
      "generationKind": "hydro",
      "lon": 23.795596,
      "lat": 69.717912,
      "capacityMw": 150,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/545991409",
      "name": "Dale II kraftverk",
      "generationKind": "hydro",
      "lon": 5.82397,
      "lat": 60.582123,
      "capacityMw": 146,
      "annualProductionGwh": null,
      "operator": "Eviny Fornybar",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549832785",
      "name": "Grytten kraftverk",
      "generationKind": "hydro",
      "lon": 7.776141,
      "lat": 62.500726,
      "capacityMw": 143.5,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549710287",
      "name": "Aurland II kraftverk",
      "generationKind": "hydro",
      "lon": 7.378156,
      "lat": 60.804697,
      "capacityMw": 142,
      "annualProductionGwh": null,
      "operator": "Hafslund Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549832655",
      "name": "Driva kraftverk",
      "generationKind": "hydro",
      "lon": 8.893676,
      "lat": 62.627313,
      "capacityMw": 140,
      "annualProductionGwh": null,
      "operator": "TrønderEnergi",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/587053915",
      "name": "Straumsmo kraftverk",
      "generationKind": "hydro",
      "lon": 18.653434,
      "lat": 68.740937,
      "capacityMw": 137,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/978235824",
      "name": "Åsgard B",
      "generationKind": "thermal",
      "lon": 6.789706,
      "lat": 65.110048,
      "capacityMw": 135,
      "annualProductionGwh": null,
      "operator": null,
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/634044492",
      "name": "Trollheim kraftverk",
      "generationKind": "hydro",
      "lon": 9.020354,
      "lat": 63.001116,
      "capacityMw": 130,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/611698460",
      "name": "Kolsvik kraftverk",
      "generationKind": "hydro",
      "lon": 12.79692,
      "lat": 65.209239,
      "capacityMw": 128,
      "annualProductionGwh": null,
      "operator": "Helgeland Kraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/978235825",
      "name": "Åsgard A",
      "generationKind": "thermal",
      "lon": 6.725806,
      "lat": 65.064116,
      "capacityMw": 126,
      "annualProductionGwh": null,
      "operator": null,
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    },
    {
      "externalId": "way/549798914",
      "name": "Leirdøla kraftverk",
      "generationKind": "hydro",
      "lon": 7.234746,
      "lat": 61.437127,
      "capacityMw": 125,
      "annualProductionGwh": null,
      "operator": "Statkraft",
      "priceArea": null,
      "sourceId": "osm:pbf-power:NO",
      "augmentationSourceId": null
    }
  ],
  "loads": [
    {
      "id": "oslo-west-urban",
      "label": "Oslo west urban load",
      "loadKind": "residential",
      "lon": 10.68,
      "lat": 59.94,
      "demandMw": 280,
      "criticalMw": 105,
      "reactiveDemandMvar": 60,
      "priority": "normal",
      "busExternalId": "node/12765722163"
    },
    {
      "id": "oslo-north-urban",
      "label": "Oslo north urban load",
      "loadKind": "residential",
      "lon": 10.75,
      "lat": 59.96,
      "demandMw": 320,
      "criticalMw": 120,
      "reactiveDemandMvar": 70,
      "priority": "normal",
      "busExternalId": "relation/10308957"
    },
    {
      "id": "oslo-east-urban",
      "label": "Oslo east urban load",
      "loadKind": "residential",
      "lon": 10.84,
      "lat": 59.93,
      "demandMw": 320,
      "criticalMw": 115,
      "reactiveDemandMvar": 70,
      "priority": "normal",
      "busExternalId": "way/113442999"
    },
    {
      "id": "oslo-hospital",
      "label": "Oslo hospital critical load",
      "loadKind": "hospital",
      "lon": 10.7387,
      "lat": 59.9369,
      "demandMw": 85,
      "criticalMw": 70,
      "reactiveDemandMvar": 22,
      "priority": "critical",
      "busExternalId": "way/116250420"
    },
    {
      "id": "gardermoen-airport",
      "label": "Oslo airport load",
      "loadKind": "airport",
      "lon": 11.1004,
      "lat": 60.1939,
      "demandMw": 120,
      "criticalMw": 55,
      "reactiveDemandMvar": 34,
      "priority": "high",
      "busExternalId": "way/295444099"
    },
    {
      "id": "bergen-urban",
      "label": "Bergen urban load",
      "loadKind": "residential",
      "lon": 5.3221,
      "lat": 60.3913,
      "demandMw": 360,
      "criticalMw": 135,
      "reactiveDemandMvar": 82,
      "priority": "normal",
      "busExternalId": "way/923057959"
    },
    {
      "id": "stavanger-urban",
      "label": "Stavanger urban load",
      "loadKind": "residential",
      "lon": 5.7331,
      "lat": 58.9701,
      "demandMw": 310,
      "criticalMw": 118,
      "reactiveDemandMvar": 72,
      "priority": "normal",
      "busExternalId": "way/166227080"
    },
    {
      "id": "trondheim-urban",
      "label": "Trondheim urban load",
      "loadKind": "residential",
      "lon": 10.3951,
      "lat": 63.4305,
      "demandMw": 330,
      "criticalMw": 130,
      "reactiveDemandMvar": 76,
      "priority": "normal",
      "busExternalId": "way/222759850"
    },
    {
      "id": "tromso-urban",
      "label": "Tromsø urban load",
      "loadKind": "residential",
      "lon": 18.9553,
      "lat": 69.6492,
      "demandMw": 150,
      "criticalMw": 65,
      "reactiveDemandMvar": 36,
      "priority": "normal",
      "busExternalId": "relation/8280652"
    },
    {
      "id": "bodo-urban",
      "label": "Bodø urban load",
      "loadKind": "residential",
      "lon": 14.4049,
      "lat": 67.2804,
      "demandMw": 125,
      "criticalMw": 52,
      "reactiveDemandMvar": 30,
      "priority": "normal",
      "busExternalId": "way/542630292"
    },
    {
      "id": "kristiansand-urban",
      "label": "Kristiansand urban load",
      "loadKind": "residential",
      "lon": 7.9956,
      "lat": 58.1467,
      "demandMw": 190,
      "criticalMw": 72,
      "reactiveDemandMvar": 44,
      "priority": "normal",
      "busExternalId": "relation/7928148"
    },
    {
      "id": "alesund-urban",
      "label": "Ålesund urban load",
      "loadKind": "residential",
      "lon": 6.1495,
      "lat": 62.4722,
      "demandMw": 135,
      "criticalMw": 58,
      "reactiveDemandMvar": 32,
      "priority": "normal",
      "busExternalId": "way/551964031"
    },
    {
      "id": "grenland-industry",
      "label": "Grenland process industry",
      "loadKind": "industry",
      "lon": 9.66,
      "lat": 59.12,
      "demandMw": 650,
      "criticalMw": 330,
      "reactiveDemandMvar": 220,
      "priority": "high",
      "busExternalId": "way/100648754"
    },
    {
      "id": "mo-rana-industry",
      "label": "Mo i Rana process industry",
      "loadKind": "industry",
      "lon": 14.1428,
      "lat": 66.3128,
      "demandMw": 420,
      "criticalMw": 230,
      "reactiveDemandMvar": 126,
      "priority": "high",
      "busExternalId": "relation/8307477"
    },
    {
      "id": "narvik-industry",
      "label": "Narvik rail and industry load",
      "loadKind": "industry",
      "lon": 17.4272,
      "lat": 68.4385,
      "demandMw": 260,
      "criticalMw": 132,
      "reactiveDemandMvar": 78,
      "priority": "high",
      "busExternalId": "relation/8292614"
    },
    {
      "id": "hammerfest-lng",
      "label": "Hammerfest LNG and port load",
      "loadKind": "industry",
      "lon": 23.6821,
      "lat": 70.6634,
      "demandMw": 230,
      "criticalMw": 150,
      "reactiveDemandMvar": 70,
      "priority": "high",
      "busExternalId": "way/586152359"
    },
    {
      "id": "oslo-ev",
      "label": "Oslo EV fast-charging cluster",
      "loadKind": "ev_charging",
      "lon": 10.85,
      "lat": 59.94,
      "demandMw": 145,
      "criticalMw": 20,
      "reactiveDemandMvar": 28,
      "priority": "low",
      "controllable": true,
      "busExternalId": "way/80179519"
    },
    {
      "id": "e18-truck-depot",
      "label": "E18 truck charging depot",
      "loadKind": "ev_charging",
      "lon": 10.49,
      "lat": 59.9,
      "demandMw": 95,
      "criticalMw": 10,
      "reactiveDemandMvar": 16,
      "priority": "low",
      "controllable": true,
      "busExternalId": "way/187555858"
    },
    {
      "id": "e39-west-charging",
      "label": "E39 west coast charging corridor",
      "loadKind": "ev_charging",
      "lon": 5.95,
      "lat": 60.55,
      "demandMw": 105,
      "criticalMw": 12,
      "reactiveDemandMvar": 18,
      "priority": "low",
      "controllable": true,
      "busExternalId": "way/114669733"
    },
    {
      "id": "e6-north-charging",
      "label": "E6 northern truck charging corridor",
      "loadKind": "ev_charging",
      "lon": 15.4,
      "lat": 67.15,
      "demandMw": 80,
      "criticalMw": 10,
      "reactiveDemandMvar": 14,
      "priority": "low",
      "controllable": true,
      "busExternalId": "relation/8298078"
    },
    {
      "id": "oslo-data-center",
      "label": "Oslo data-center load",
      "loadKind": "data_center",
      "lon": 10.98,
      "lat": 59.96,
      "demandMw": 230,
      "criticalMw": 165,
      "reactiveDemandMvar": 56,
      "priority": "high",
      "busExternalId": "relation/8239198"
    },
    {
      "id": "trondheim-data-center",
      "label": "Trondheim data-center load",
      "loadKind": "data_center",
      "lon": 10.46,
      "lat": 63.43,
      "demandMw": 135,
      "criticalMw": 95,
      "reactiveDemandMvar": 32,
      "priority": "high",
      "busExternalId": "way/222759850"
    }
  ]
} as const
