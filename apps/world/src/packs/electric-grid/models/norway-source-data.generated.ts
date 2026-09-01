import type { SourceGridModelData } from "./source-data.ts"

export const norwayGridSourceData: SourceGridModelData = {
  "sourceBuild": {
    "id": "norway-transmission-model-source-v1",
    "generatedAt": "2026-05-30T21:14:23.792Z",
    "sourceIds": [
      "osm:pbf-power:NO",
      "nve:vannkraftdatabase",
      "nve:vindkraftdatabase"
    ],
    "notes": [
      "Operational Model generated from the grid-norway OSM PBF reference sidecar at national Norway scope.",
      "The operational graph is transmission-focused: dense OSM reference segments remain reference map geometry, while the runtime Model keeps national 300 kV+ backbone assets, northern 132 kV+ regional assets, eastern 220 kV+ regional assets, major generation, and aggregate consumer zones.",
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
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/552672002",
      "name": "Adamselv trafostasjon",
      "lon": 26.695875,
      "lat": 70.409645,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/615122824",
      "name": "Åfjord trafostasjon",
      "lon": 10.221688,
      "lat": 63.89062,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/548201553",
      "name": "Ålfoten trafostasjon",
      "lon": 5.548602,
      "lat": 61.828883,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8278085",
      "name": "Alta(Raipas) trafostasjon",
      "lon": 23.373256,
      "lat": 69.952156,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10175479",
      "name": "Åna-Sira trafostasjon",
      "lon": 6.453799,
      "lat": 58.294949,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/358915801",
      "name": "Arendal trafostasjon",
      "lon": 8.729507,
      "lat": 58.588311,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8834935",
      "name": "Arna trafostasjon",
      "lon": 5.457013,
      "lat": 60.394554,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8279949",
      "name": "Aronnes trafostasjon",
      "lon": 23.28492,
      "lat": 69.966321,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/638183341",
      "name": "Åsen trafostasjon",
      "lon": 6.628987,
      "lat": 60.129008,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7839720",
      "name": "Aura trafostasjon",
      "lon": 8.522888,
      "lat": 62.66409,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/3993780",
      "name": "Aurland 1 trafostasjon",
      "lon": 7.301308,
      "lat": 60.862925,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/37907251",
      "name": "Aurland III kraftverk trafo",
      "lon": 7.565874,
      "lat": 60.78884,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/166227080",
      "name": "Bærheim trafostasjon",
      "lon": 5.693315,
      "lat": 58.883163,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/749676336",
      "name": "Bærum trafostasjon",
      "lon": 10.558365,
      "lat": 59.926838,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/554551085",
      "name": "Balbergskaret koblingsstasjon",
      "lon": 10.448102,
      "lat": 61.163729,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587726948",
      "name": "Ballangen koblingsstasjon",
      "lon": 16.733247,
      "lat": 68.261144,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898616",
      "name": "Balsfjord trafostasjon",
      "lon": 19.203097,
      "lat": 69.189707,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/206628449",
      "name": "Bamble trafostasjon",
      "lon": 9.595875,
      "lat": 59.040987,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8285905",
      "name": "Bardu trafostasjon",
      "lon": 18.31986,
      "lat": 68.863381,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8283263",
      "name": "Bardufoss kraftverk",
      "lon": 18.589494,
      "lat": 69.043772,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898618",
      "name": "Bardufoss trafostasjon",
      "lon": 18.592552,
      "lat": 69.033987,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/657434624",
      "name": "Båtsfjord trafostasjon",
      "lon": 29.713204,
      "lat": 70.639777,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/610484703",
      "name": "Bjerka kraftverk",
      "lon": 13.997639,
      "lat": 66.062512,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/799370310",
      "name": "Bjerkreim trafostasjon",
      "lon": 5.920248,
      "lat": 58.590198,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8293880",
      "name": "Bjørkåsen trafostasjon",
      "lon": 16.782841,
      "lat": 68.321894,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8269872",
      "name": "Bjørnevatn trafostasjon",
      "lon": 30.005446,
      "lat": 69.665695,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/440170580",
      "name": "Blåfalli III kraftverk",
      "lon": 6.07339,
      "lat": 59.871389,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/432965765",
      "name": "Blåfalli koblingsstasjon",
      "lon": 6.009814,
      "lat": 59.863367,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1156551462",
      "name": "Boltås trafostasjon",
      "lon": 16.664133,
      "lat": 68.530592,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7845549",
      "name": "Borgund trafostasjon",
      "lon": 7.818716,
      "lat": 61.059392,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8846916",
      "name": "Børtveit koblingsstasjon",
      "lon": 5.510349,
      "lat": 59.884905,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8281952",
      "name": "Brensholmeneidet trafostasjon",
      "lon": 18.072413,
      "lat": 69.568733,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/244179408",
      "name": "Brokke kraftverk",
      "lon": 7.509847,
      "lat": 59.123629,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/923057959",
      "name": "Bybanen Transformator Stasjon",
      "lon": 5.347549,
      "lat": 60.334936,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9344645",
      "name": "Charlottenlund Transformatorstasjon",
      "lon": 18.95063,
      "lat": 69.664041,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7847764",
      "name": "Dagali trafostasjon",
      "lon": 8.577467,
      "lat": 60.437711,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/114669733",
      "name": "Dale koblingsstasjon",
      "lon": 5.809595,
      "lat": 60.581459,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/261717967",
      "name": "Duge kraftverk",
      "lon": 6.894942,
      "lat": 59.125702,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/19581816",
      "name": "Eidum trafostasjon",
      "lon": 11.003994,
      "lat": 63.448134,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588443638",
      "name": "Enga trafostasjon",
      "lon": 13.532234,
      "lat": 66.78709,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8890887",
      "name": "Ertsmyra like- og vekselretter stasjon",
      "lon": 6.754876,
      "lat": 58.669306,
      "maxVoltageKv": 525,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8890888",
      "name": "Ertsmyra trafostasjon",
      "lon": 6.752945,
      "lat": 58.670654,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/307323708",
      "name": "Evanger transformatorstasjon",
      "lon": 6.11174,
      "lat": 60.656261,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/297388897",
      "name": "Fåberg trafostasjon",
      "lon": 10.42168,
      "lat": 61.13848,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/830770515",
      "name": "Fagrafjell trafostasjon",
      "lon": 5.761878,
      "lat": 58.790268,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8836351",
      "name": "Fana transformatorstasjon",
      "lon": 5.341813,
      "lat": 60.287366,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296010",
      "name": "Fauske trafostasjon",
      "lon": 15.419068,
      "lat": 67.271269,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11981383",
      "name": "Feda like- og vekselretter stasjon",
      "lon": 6.866706,
      "lat": 58.282544,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12627235",
      "name": "Finneidfjord trafostasjon",
      "lon": 13.796482,
      "lat": 66.188699,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8285305",
      "name": "Finnfjordbotn trafostasjon",
      "lon": 18.083238,
      "lat": 69.221255,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/640796702",
      "name": "Fjotland trafostasjon",
      "lon": 7.019131,
      "lat": 58.768294,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/287115458",
      "name": "Flesaker koblingsstasjon",
      "lon": 9.843725,
      "lat": 59.720307,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100151486",
      "name": "Follo trafostasjon",
      "lon": 10.782977,
      "lat": 59.728775,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8721337",
      "name": "Førre trafostasjon",
      "lon": 6.603666,
      "lat": 59.327473,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8679746",
      "name": "Fortun trafostasjon",
      "lon": 7.69985,
      "lat": 61.505699,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7839089",
      "name": "Fræna trafostasjon",
      "lon": 7.111346,
      "lat": 62.859537,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/295444099",
      "name": "Frogner transformatorstasjon",
      "lon": 11.133591,
      "lat": 60.005617,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/80179519",
      "name": "Furuset trafostasjon",
      "lon": 10.884336,
      "lat": 59.94447,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587356986",
      "name": "Fygle trafostasjon",
      "lon": 13.637827,
      "lat": 68.149152,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8271257",
      "name": "Gandvik trafostasjon",
      "lon": 29.121194,
      "lat": 70.008615,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292077",
      "name": "Gåra trafostasjon",
      "lon": 16.253904,
      "lat": 68.758249,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292079",
      "name": "Gåsvatn koblingsstasjon",
      "lon": 16.324422,
      "lat": 68.765933,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9344646",
      "name": "Gimle trafostasjon",
      "lon": 18.978689,
      "lat": 69.687402,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/690859516",
      "name": "Gjerelvmo trafostasjon",
      "lon": 15.979756,
      "lat": 67.638266,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8301307",
      "name": "Glomfjord trafostasjon",
      "lon": 13.934691,
      "lat": 66.817434,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/711130655",
      "name": "Govddesåga kraftverk",
      "lon": 14.387577,
      "lat": 66.924855,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/106934339",
      "name": "Grefsen likeretterstasjon",
      "lon": 10.785634,
      "lat": 59.951278,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11568632",
      "name": "Grenland trafostasjon",
      "lon": 9.47685,
      "lat": 59.128401,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8307477",
      "name": "Gullsmedvik trafostasjon",
      "lon": 14.152988,
      "lat": 66.326412,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898605",
      "name": "Guolášjohka trafostasjon",
      "lon": 20.918226,
      "lat": 69.460558,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8206955",
      "name": "Hadeland trafostasjon",
      "lon": 10.577322,
      "lat": 60.2888,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586667770",
      "name": "Håkøybotn koblingsstasjon",
      "lon": 18.699972,
      "lat": 69.623219,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/232893576",
      "name": "Halden trafostasjon",
      "lon": 11.415557,
      "lat": 59.12384,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8301304",
      "name": "Halsa trafostasjon",
      "lon": 13.598652,
      "lat": 66.748943,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/187555858",
      "name": "Hamang transformatorstasjon",
      "lon": 10.498982,
      "lat": 59.896882,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586152359",
      "name": "Hammerfest trafostasjon",
      "lon": 23.713873,
      "lat": 70.657574,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990796",
      "name": "Hamnefjellet trafostasjon",
      "lon": 29.708871,
      "lat": 70.660486,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/60495669",
      "name": "Hasle trafostasjon",
      "lon": 11.155404,
      "lat": 59.314144,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12969006",
      "name": "Haugsneset likeretter",
      "lon": 5.552513,
      "lat": 59.273789,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/648848845",
      "name": "Haugsvær trafostasjon",
      "lon": 5.527141,
      "lat": 60.889704,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13989591",
      "name": "Håvik trafostasjon",
      "lon": 5.315615,
      "lat": 59.31725,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587607517",
      "name": "Heggen trafostasjon",
      "lon": 16.521912,
      "lat": 68.795647,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/549449182",
      "name": "Hemsil 1 koblingsstasjon",
      "lon": 8.641281,
      "lat": 60.807675,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12277754",
      "name": "Hemsil 2 koblingsstasjon",
      "lon": 8.971704,
      "lat": 60.705327,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/8396776075",
      "name": "Hemsil 2 trafostasjon",
      "lon": 8.969394,
      "lat": 60.704905,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13284562",
      "name": "Herøya 3 trafostasjon",
      "lon": 9.634219,
      "lat": 59.117065,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/179044834",
      "name": "Hinnøy koblingsstasjon",
      "lon": 15.499916,
      "lat": 68.683248,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/355844786",
      "name": "Hof trafostasjon",
      "lon": 10.104273,
      "lat": 59.576632,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/613587460",
      "name": "Hofstad trafostasjon",
      "lon": 10.540355,
      "lat": 64.1642,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7812776",
      "name": "Hol I kraftverk koblingsstasjon",
      "lon": 8.1836,
      "lat": 60.626135,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8182117",
      "name": "Holen trafo",
      "lon": 7.249484,
      "lat": 59.346154,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/577998803",
      "name": "Honna trafostasjon",
      "lon": 7.476093,
      "lat": 58.680608,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8297300",
      "name": "Hopen trafostasjon",
      "lon": 14.739019,
      "lat": 67.319301,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/546262583",
      "name": "Hove koblingsstasjon",
      "lon": 6.595907,
      "lat": 61.069885,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/9519270911",
      "name": "Hove kraftverk",
      "lon": 6.589203,
      "lat": 61.066619,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/547743430",
      "name": "Høyanger trafostasjon",
      "lon": 6.149269,
      "lat": 61.243975,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280652",
      "name": "Hungeren trafostasjon",
      "lon": 18.973974,
      "lat": 69.639512,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7809753",
      "name": "Husnes",
      "lon": 5.766283,
      "lat": 59.862529,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/511117400",
      "name": "Hyggevatn trafostasjon",
      "lon": 23.725382,
      "lat": 70.680616,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12274653",
      "name": "Hylen koblingsstasjon",
      "lon": 6.602133,
      "lat": 59.560348,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587053818",
      "name": "Innset kraftverk",
      "lon": 18.820048,
      "lat": 68.657717,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/865236489",
      "name": "Jar likeretterstasjon",
      "lon": 10.618756,
      "lat": 59.926276,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/646643191",
      "name": "Jomfrubråten likeretterstasjon",
      "lon": 10.771221,
      "lat": 59.887738,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8288539",
      "name": "Kanstadbotn trafostasjon",
      "lon": 15.881989,
      "lat": 68.506872,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8864887",
      "name": "Kårstø trafostasjon",
      "lon": 5.505199,
      "lat": 59.278246,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1021851013",
      "name": "Kastellet likeretterstasjon",
      "lon": 10.79016,
      "lat": 59.871448,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/120105564",
      "name": "Kilbotn trafostasjon",
      "lon": 16.510541,
      "lat": 68.714677,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/962052314",
      "name": "Kiosk 134",
      "lon": 5.357257,
      "lat": 60.328857,
      "maxVoltageKv": 320,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8269874",
      "name": "Kirkenes trafostasjon",
      "lon": 30.033642,
      "lat": 69.722853,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1156161502",
      "name": "Kjela kraftverk",
      "lon": 7.444101,
      "lat": 59.736308,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8332571",
      "name": "Kjelland transformatorstasjon",
      "lon": 6.032434,
      "lat": 58.494858,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1203811851",
      "name": "Kjelling trafostasjon",
      "lon": 14.346683,
      "lat": 67.074342,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/867043428",
      "name": "Kjelsås likeretterstasjon",
      "lon": 10.784529,
      "lat": 59.964261,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587793855",
      "name": "Kjøpsvik trafostasjon",
      "lon": 16.371057,
      "lat": 68.098623,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/287685850",
      "name": "Klæbu transformatorstasjon",
      "lon": 10.419003,
      "lat": 63.326743,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587348300",
      "name": "Kleppstad trafostasjon",
      "lon": 14.282186,
      "lat": 68.262271,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8293948",
      "name": "Kobbelv kraftverk",
      "lon": 15.990332,
      "lat": 67.622688,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990791",
      "name": "Kobbkroken trafostasjon",
      "lon": 29.28578,
      "lat": 70.712113,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/842385259",
      "name": "Kobbvatnet trafostasjon",
      "lon": 15.988455,
      "lat": 67.63753,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/636875282",
      "name": "Kollsnes Martin Linge trafostasjon",
      "lon": 4.846431,
      "lat": 60.552502,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8839478",
      "name": "Kollsnes trafostasjon",
      "lon": 4.844507,
      "lat": 60.550682,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8482013",
      "name": "Kolsvik trafostasjon",
      "lon": 12.792462,
      "lat": 65.20452,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7928148",
      "name": "Kristiansand trafostasjon",
      "lon": 7.900937,
      "lat": 58.259273,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587053901",
      "name": "Krogstad koblingspunkt",
      "lon": 18.424259,
      "lat": 68.884168,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280181",
      "name": "Kvænangen trafostasjon",
      "lon": 22.054563,
      "lat": 69.719919,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8281954",
      "name": "Kvaløya trafostasjon",
      "lon": 18.881218,
      "lat": 69.698447,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8277461",
      "name": "Kvalsund trafostasjon",
      "lon": 23.969922,
      "lat": 70.488067,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/430780474",
      "name": "Kvanndal kraftverk",
      "lon": 6.984078,
      "lat": 59.658134,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/252924745",
      "name": "Kvanndal trafostasjon",
      "lon": 17.61092,
      "lat": 68.577497,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8857439",
      "name": "Kvilldal koblingsstasjon",
      "lon": 6.654463,
      "lat": 59.528666,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/285481596",
      "name": "Kvinen kraftverk",
      "lon": 7.087828,
      "lat": 58.93136,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8894066",
      "name": "Kvinesdal trafostasjon",
      "lon": 6.847959,
      "lat": 58.276129,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1158040163",
      "name": "Kvitfjell trafostasjon",
      "lon": 18.156133,
      "lat": 69.56866,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/709830245",
      "name": "Kvitfossen trafostasjon",
      "lon": 14.653932,
      "lat": 68.327089,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/228085650",
      "name": "Kvitnes trafostasjon",
      "lon": 16.598149,
      "lat": 68.629118,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/128291126",
      "name": "Lakselv trafostasjon",
      "lon": 24.972881,
      "lat": 70.003185,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11636421",
      "name": "Langvatn trafostasjon",
      "lon": 14.166329,
      "lat": 66.336674,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7814748",
      "name": "Leirdøla trafostasjon",
      "lon": 7.246237,
      "lat": 61.437056,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8306711",
      "name": "Leirosen trafostasjon",
      "lon": 13.064744,
      "lat": 66.079608,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990787",
      "name": "Leirpollen trafostasjon",
      "lon": 28.522662,
      "lat": 70.426798,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/20598970",
      "name": "Lindås trafostasjon",
      "lon": 5.041276,
      "lat": 60.79452,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10547156",
      "name": "Lio kraftverk",
      "lon": 7.939084,
      "lat": 59.463268,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8896922",
      "name": "Lista trafostasjon",
      "lon": 6.775357,
      "lat": 58.077101,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8837899",
      "name": "Litlesotra trafostasjon",
      "lon": 5.132171,
      "lat": 60.36555,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/953796939",
      "name": "Lødingen trafostasjon",
      "lon": 15.969191,
      "lat": 68.401447,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280563",
      "name": "Lyngen trafostasjon",
      "lon": 20.27116,
      "lat": 69.589315,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8886202",
      "name": "Lyse trafostasjon",
      "lon": 6.663454,
      "lat": 59.059991,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/116250420",
      "name": "Majorstuen likeretterstasjon",
      "lon": 10.708166,
      "lat": 59.932964,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8476872",
      "name": "Marka trafostasjon",
      "lon": 13.289685,
      "lat": 65.851807,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7805329",
      "name": "Mauranger trafostasjon",
      "lon": 6.3312,
      "lat": 60.132044,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292075",
      "name": "Medkila trafostasjon",
      "lon": 16.545247,
      "lat": 68.770977,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8288766",
      "name": "Melbu trafostasjon",
      "lon": 14.851928,
      "lat": 68.510547,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/685025511",
      "name": "Melkøya trafostasjon",
      "lon": 23.594344,
      "lat": 70.690504,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588074294",
      "name": "Messiosen trafostasjon",
      "lon": 14.556801,
      "lat": 67.294282,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586502774",
      "name": "Mestervik koblingsstasjon",
      "lon": 18.88399,
      "lat": 69.337948,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8846883",
      "name": "Midtfjellet trafostasjon",
      "lon": 5.395603,
      "lat": 59.930925,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/120279477",
      "name": "Minne transformatorstasjon",
      "lon": 11.232237,
      "lat": 60.388696,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7802012",
      "name": "Modalen koblingsstasjon",
      "lon": 6.012658,
      "lat": 60.888193,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587607521",
      "name": "Møkkeland trafostasjon",
      "lon": 16.438134,
      "lat": 68.808946,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13447791",
      "name": "Moskog trafostasjon",
      "lon": 6.016208,
      "lat": 61.44603,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/254428135",
      "name": "Namsos (Statnett) trafostasjon",
      "lon": 11.775509,
      "lat": 64.478159,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/400655824",
      "name": "Namsskogan koblingsstasjon",
      "lon": 13.225751,
      "lat": 64.986593,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292614",
      "name": "Narvik/Furumoen trafostasjon",
      "lon": 17.463282,
      "lat": 68.443359,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8527323",
      "name": "Nea trafostasjon",
      "lon": 11.687625,
      "lat": 63.029452,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8473044",
      "name": "Nedre Røssåga trafostasjon",
      "lon": 13.78186,
      "lat": 66.051575,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/265770276",
      "name": "Nedre Vinstra",
      "lon": 9.804179,
      "lat": 61.577739,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/585733410",
      "name": "Neiden trafostasjon",
      "lon": 29.349381,
      "lat": 69.70328,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7851611",
      "name": "Nes koblingsstasjon",
      "lon": 9.069989,
      "lat": 60.605756,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8857363",
      "name": "Nesflaten koblingsstasjon",
      "lon": 6.816601,
      "lat": 59.649633,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/589009876",
      "name": "Nesna trafostasjon",
      "lon": 13.039305,
      "lat": 66.197154,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280502",
      "name": "Nordreisa trafostasjon",
      "lon": 21.313686,
      "lat": 69.622359,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7854485",
      "name": "Nore I trafostasjon",
      "lon": 8.961755,
      "lat": 60.266916,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/12832053",
      "name": "North Sea Link like- og vekselretterstasjon",
      "lon": 6.654636,
      "lat": 59.530133,
      "maxVoltageKv": 515,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1467919656",
      "name": "NS13310",
      "lon": 6.431974,
      "lat": 60.622659,
      "maxVoltageKv": 400,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292143",
      "name": "Nygårdsfjellet vindpark",
      "lon": 17.872035,
      "lat": 68.504651,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10104222",
      "name": "Nyhamna trafostasjon",
      "lon": 6.945476,
      "lat": 62.842325,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1467919662",
      "name": "Nyre 2",
      "lon": 6.436019,
      "lat": 60.623447,
      "maxVoltageKv": 400,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/572898626",
      "name": "Ofoten trafostasjon",
      "lon": 17.558674,
      "lat": 68.158808,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/229806969",
      "name": "Ogndal trafostasjon",
      "lon": 11.621265,
      "lat": 64.027856,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/549449181",
      "name": "Øljusjøen koblingsstasjon",
      "lon": 8.084443,
      "lat": 61.003898,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1026999469",
      "name": "Olsborg koblingspunkt",
      "lon": 18.60155,
      "lat": 69.178342,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8283740",
      "name": "Olsborg trafostasjon",
      "lon": 18.579216,
      "lat": 69.174778,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8306512",
      "name": "Øresvik trafostasjon",
      "lon": 13.20547,
      "lat": 66.454542,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8536441",
      "name": "Orkdal transformatorstasjon",
      "lon": 9.802928,
      "lat": 63.245946,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/548709529",
      "name": "Ørskog trafostasjon",
      "lon": 6.866362,
      "lat": 62.473153,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/548473094",
      "name": "Ørsta trafostasjon",
      "lon": 6.259386,
      "lat": 62.157009,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8469203",
      "name": "Ørtfjell trafostasjon",
      "lon": 14.650567,
      "lat": 66.416011,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7842286",
      "name": "Øvre Vinstra",
      "lon": 9.312625,
      "lat": 61.482837,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/100648754",
      "name": "Porsgrunn trafostasjon",
      "lon": 9.672798,
      "lat": 59.115637,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671990789",
      "name": "Raggovidda trafostasjon",
      "lon": 29.0852,
      "lat": 70.763033,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/197866182",
      "name": "Rana trafostasjon",
      "lon": 14.264279,
      "lat": 66.302608,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1158040189",
      "name": "Raudfjell trafostasjon",
      "lon": 18.217563,
      "lat": 69.573762,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/546262597",
      "name": "Refsdal koblingsstasjon",
      "lon": 6.568484,
      "lat": 61.020533,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8211981",
      "name": "Rendalen kraftverk",
      "lon": 11.121985,
      "lat": 61.813093,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/14018338",
      "name": "Reppa trafostasjon",
      "lon": 13.562427,
      "lat": 66.644867,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/205115991",
      "name": "Ringerike trafostasjon",
      "lon": 10.204062,
      "lat": 60.168616,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/163116969",
      "name": "Risøyhamn trafostasjon",
      "lon": 15.634272,
      "lat": 68.966543,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7879879",
      "name": "Rjukan trafostasjon",
      "lon": 8.677965,
      "lat": 59.882471,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/290390502",
      "name": "Roa koblingsstasjon",
      "lon": 10.639101,
      "lat": 60.311543,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/18667239",
      "name": "Rød transformatorstasjon",
      "lon": 9.543747,
      "lat": 59.272381,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8298078",
      "name": "Rognan trafostasjon",
      "lon": 15.387523,
      "lat": 67.089596,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8857031",
      "name": "Røldal trafostasjon",
      "lon": 6.816998,
      "lat": 59.821268,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8292228",
      "name": "Rombak omformer",
      "lon": 17.781301,
      "lat": 68.404287,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/71356608",
      "name": "Roskrepp kraftverk",
      "lon": 7.085481,
      "lat": 59.025665,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8239198",
      "name": "Røykås trafostasjon",
      "lon": 10.933454,
      "lat": 59.929978,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1140662370",
      "name": "Salten trafostasjon",
      "lon": 15.713974,
      "lat": 67.325839,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296013",
      "name": "Salten verk",
      "lon": 15.583693,
      "lat": 67.362182,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/20459254",
      "name": "Samnanger trafostasjon",
      "lon": 5.841681,
      "lat": 60.398106,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8280921",
      "name": "Sandvika trafostasjon",
      "lon": 18.993895,
      "lat": 69.544126,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8860331",
      "name": "Sauda trafostasjon",
      "lon": 6.410691,
      "lat": 59.669038,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/11036958",
      "name": "Saurdal transformatorstasjon",
      "lon": 6.670763,
      "lat": 59.484629,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8276522",
      "name": "Sautso (Alta kraftverk)",
      "lon": 23.802264,
      "lat": 69.719693,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1065776932",
      "name": "Sildvik koblingsstasjon",
      "lon": 17.797475,
      "lat": 68.409445,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9347309",
      "name": "Silsand trafostasjon",
      "lon": 17.94996,
      "lat": 69.249579,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10220813",
      "name": "Sima kraftverk",
      "lon": 7.143533,
      "lat": 60.499289,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587829506",
      "name": "Siso koblingsstasjon",
      "lon": 15.714889,
      "lat": 67.324238,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588985297",
      "name": "Sjona koblingsstasjon",
      "lon": 13.562041,
      "lat": 66.311216,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587922055",
      "name": "Sjønstå koblingsstasjon",
      "lon": 15.704584,
      "lat": 67.19426,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586116281",
      "name": "Skaidi trafostasjon",
      "lon": 24.542482,
      "lat": 70.433011,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/13009239",
      "name": "Skibotn trafostasjon",
      "lon": 20.358682,
      "lat": 69.315218,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/672093604",
      "name": "Skillemoen koblingspunkt",
      "lon": 23.232252,
      "lat": 69.910414,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/883151328",
      "name": "Skillemoen trafostasjon",
      "lon": 23.216576,
      "lat": 69.904699,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/968741818",
      "name": "Skjomen koblingsstasjon",
      "lon": 17.360997,
      "lat": 68.203968,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9346333",
      "name": "Skoddevarre trafostasjon",
      "lon": 23.229494,
      "lat": 69.941276,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1263740209",
      "name": "Skoglund trafostasjon",
      "lon": 17.584851,
      "lat": 68.576671,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/643494389",
      "name": "Smelror trafostasjon",
      "lon": 31.01364,
      "lat": 70.385129,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/12765722163",
      "name": "Smestad trafostasjon",
      "lon": 10.66864,
      "lat": 59.934778,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1050275156",
      "name": "Smibelg kraftverk",
      "lon": 13.338841,
      "lat": 66.459875,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/633840104",
      "name": "Snilldal trafostasjon",
      "lon": 9.60673,
      "lat": 63.400719,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10308957",
      "name": "Sogn trafostasjon",
      "lon": 10.721021,
      "lat": 59.95828,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/469098816",
      "name": "Sogndal trafostasjon",
      "lon": 7.021204,
      "lat": 61.217861,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/154904137",
      "name": "Solbjørn trafostasjon",
      "lon": 13.161886,
      "lat": 68.005927,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/864968263",
      "name": "Sollerud likeretterstasjon",
      "lon": 10.639633,
      "lat": 59.921374,
      "maxVoltageKv": 750,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/288812256",
      "name": "Songa koblingsstasjon",
      "lon": 7.725059,
      "lat": 59.774079,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/289304185",
      "name": "Sønnå kraftverk",
      "lon": 6.378187,
      "lat": 59.644571,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1160239696",
      "name": "Sørfjord 1 trafostasjon",
      "lon": 16.663103,
      "lat": 68.06437,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/842686943",
      "name": "Sørfjord vindpark",
      "lon": 16.670935,
      "lat": 68.041953,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8285302",
      "name": "Sørreisa trafostasjon",
      "lon": 18.170462,
      "lat": 69.158647,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8289305",
      "name": "Sortland trafostasjon",
      "lon": 15.384507,
      "lat": 68.712299,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/118231876",
      "name": "Spanne trafostasjon",
      "lon": 5.334701,
      "lat": 59.379652,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/10086891",
      "name": "Steinsland koblingsstasjon",
      "lon": 5.976383,
      "lat": 60.926527,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1156216252",
      "name": "Stokmarknes trafostasjon",
      "lon": 14.990329,
      "lat": 68.552604,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8288762",
      "name": "Stokmarknes trafostasjon",
      "lon": 14.900716,
      "lat": 68.558041,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8847096",
      "name": "Stord trafostasjon",
      "lon": 5.412825,
      "lat": 59.78718,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/848422115",
      "name": "Storforshei trafostasjon",
      "lon": 14.499535,
      "lat": 66.409925,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8283080",
      "name": "Storsteinnes trafostasjon",
      "lon": 19.24352,
      "lat": 69.210232,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/587053918",
      "name": "Straumsmo kraftverk",
      "lon": 18.651629,
      "lat": 68.740703,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/222759850",
      "name": "Strinda koblingsstasjon",
      "lon": 10.449022,
      "lat": 63.394712,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8520950",
      "name": "Strinda trafostasjon",
      "lon": 10.440169,
      "lat": 63.392118,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296003",
      "name": "Sulitjelma trafostasjon",
      "lon": 16.077322,
      "lat": 67.119715,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8300691",
      "name": "Sundsfjord trafostasjon",
      "lon": 14.150979,
      "lat": 66.971348,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/633896066",
      "name": "Surna koblingsstasjon",
      "lon": 9.010866,
      "lat": 62.996512,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/589085618",
      "name": "Svabo trafostasjon",
      "lon": 14.177963,
      "lat": 66.305794,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/475820066",
      "name": "Svartisen trafostasjon",
      "lon": 13.91399,
      "lat": 66.729183,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/840096758",
      "name": "Svolvær trafostasjon",
      "lon": 14.531739,
      "lat": 68.225094,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/551964031",
      "name": "Sykkylven trafostasjon",
      "lon": 6.636135,
      "lat": 62.375399,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/128406208",
      "name": "Sylling trafostasjon",
      "lon": 10.215375,
      "lat": 59.867244,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8274347",
      "name": "Tana Bru trafostasjon",
      "lon": 28.187718,
      "lat": 70.194326,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/29578389",
      "name": "Tegneby koblingsstasjon",
      "lon": 10.747226,
      "lat": 59.51735,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/114414014",
      "name": "Tegneby trafostasjon",
      "lon": 10.737979,
      "lat": 59.516432,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/588074267",
      "name": "Tjønndal trafostasjon",
      "lon": 14.461369,
      "lat": 67.283959,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/240202234",
      "name": "Tjørhom koblingsstasjon",
      "lon": 6.815215,
      "lat": 58.879139,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7883882",
      "name": "Tokke koblingsstasjon",
      "lon": 8.03656,
      "lat": 59.447937,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8890360",
      "name": "Tonstad koblingsstasjon",
      "lon": 6.724921,
      "lat": 58.657757,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8481866",
      "name": "Trofors trafostasjon",
      "lon": 13.427305,
      "lat": 65.534587,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8488332",
      "name": "Tunnsjødal trafostasjon",
      "lon": 12.836053,
      "lat": 64.704069,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/51854396",
      "name": "Tveiten trafostasjon",
      "lon": 10.381549,
      "lat": 59.329143,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/1158040166",
      "name": "Tverråsan koblingsstasjon",
      "lon": 18.155684,
      "lat": 69.568398,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/586436581",
      "name": "Ullsfjord trafostasjon",
      "lon": 19.821434,
      "lat": 69.602986,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/113442999",
      "name": "Ulven trafostasjon",
      "lon": 10.812042,
      "lat": 59.922141,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/675049925",
      "name": "Usta kraftverk",
      "lon": 8.412105,
      "lat": 60.570283,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/296229069",
      "name": "Usta trafostasjon",
      "lon": 8.412005,
      "lat": 60.574498,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/9552168",
      "name": "Uvdal II",
      "lon": 8.923846,
      "lat": 60.258582,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8271838",
      "name": "Vadsø trafostasjon",
      "lon": 29.763969,
      "lat": 70.07863,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/290360704",
      "name": "Vågåmo trafo stasjon",
      "lon": 9.080689,
      "lat": 61.881171,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/8296015",
      "name": "Valljord trafostasjon",
      "lon": 15.554244,
      "lat": 67.34045,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/114336709",
      "name": "Vang trafostasjon",
      "lon": 11.267219,
      "lat": 60.83565,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/257192868",
      "name": "Varangerbotn trafostasjon",
      "lon": 28.541497,
      "lat": 70.171822,
      "maxVoltageKv": 220,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/290373414",
      "name": "Vardal trafostasjon",
      "lon": 10.565369,
      "lat": 60.802002,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/671956023",
      "name": "Varden trafostasjon",
      "lon": 19.002544,
      "lat": 69.699735,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7879876",
      "name": "Vemorktoppen",
      "lon": 8.492923,
      "lat": 59.865425,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/229806970",
      "name": "Verdal trafostasjon",
      "lon": 11.50391,
      "lat": 63.752875,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/542630292",
      "name": "Vestbyen trafostasjon",
      "lon": 14.379671,
      "lat": 67.274093,
      "maxVoltageKv": 132,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/202200066",
      "name": "Viklandet trafostasjon",
      "lon": 8.495627,
      "lat": 62.689376,
      "maxVoltageKv": 420,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "relation/7883264",
      "name": "Vinje kraftverk",
      "lon": 7.851073,
      "lat": 59.624719,
      "maxVoltageKv": 300,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "way/842077312",
      "name": "Vollesfjord muffestasjon",
      "lon": 6.679918,
      "lat": 58.266496,
      "maxVoltageKv": 525,
      "sourceId": "osm:pbf-power:NO"
    },
    {
      "externalId": "node/6421181679",
      "name": "Vorset",
      "lon": 9.078342,
      "lat": 59.973802,
      "maxVoltageKv": 400,
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
