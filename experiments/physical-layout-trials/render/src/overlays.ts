import {MercatorCoordinate,type Map} from 'maplibre-gl';
// Declared synthetic operational overlays exercise native composition only.
// They are never represented as process data or production map objects.
export function installOverlays(map:Map){
 const a=MercatorCoordinate.fromLngLat([11.47,59.087],0),s=a.meterInMercatorCoordinateUnits();
 const ll=(x:number,z:number)=>new MercatorCoordinate(a.x+(x-44.4)*s,a.y+(z-26.8)*s,0).toLngLat().toArray();
 const polygon=(x:number,z:number,w:number,d:number)=>({type:'Polygon' as const,coordinates:[[ll(x,z),ll(x+w,z),ll(x+w,z+d),ll(x,z+d),ll(x,z)]]});
 const data={type:'FeatureCollection' as const,features:[{type:'Feature' as const,properties:{kind:'reference'},geometry:polygon(-8,-7,106,68)},{type:'Feature' as const,properties:{kind:'zone'},geometry:polygon(31,39,8,8)},{type:'Feature' as const,properties:{kind:'route'},geometry:{type:'LineString' as const,coordinates:[ll(-2,35),ll(95,35)]}},{type:'Feature' as const,properties:{kind:'icon'},geometry:{type:'Point' as const,coordinates:ll(72,35)}}]};
 map.addSource('trial-operational-overlay',{type:'geojson',data});
 map.addLayer({id:'reference-context',source:'trial-operational-overlay',type:'fill',filter:['==','kind','reference'],paint:{'fill-color':'#bfcdbb','fill-opacity':.18}});
 map.addLayer({id:'operational-zone',source:'trial-operational-overlay',type:'fill',filter:['==','kind','zone'],paint:{'fill-color':'#d4aa48','fill-opacity':.2}});
 map.addLayer({id:'operational-route',source:'trial-operational-overlay',type:'line',filter:['==','kind','route'],paint:{'line-color':'#3d718c','line-width':3}});
 map.addLayer({id:'operational-icon',source:'trial-operational-overlay',type:'circle',filter:['==','kind','icon'],paint:{'circle-color':'#fffdf4','circle-radius':6,'circle-stroke-color':'#31647c','circle-stroke-width':3}});
}
