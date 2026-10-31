import {test,expect} from 'bun:test';
import {read} from './ifc.ts';
import {parameters,hash} from './model.ts';
import {changedElements,admit} from './edit.ts';

const source=()=>Bun.file(import.meta.dir+'/output/source.ifc').bytes();
test('saved IFC contains native hosted door/fill/space relationships at 30 degrees',async()=>{
 const before=await read(await source()),after=await read(await Bun.file(import.meta.dir+'/output/door/source.ifc').bytes());
 expect(changedElements(before.model,after.model)).toEqual(['access-door','access-opening','edit-wall']);
 expect(after.nativeEntityCounts.IfcRelVoidsElement).toBe(before.nativeEntityCounts.IfcRelVoidsElement!+1);
 expect(after.nativeEntityCounts.IfcRelFillsElement).toBe(before.nativeEntityCounts.IfcRelFillsElement!+1);
 expect(after.model.elements.find(e=>e.id==='edit-wall')!.yaw).toBeCloseTo(Math.PI/6,10);
 expect(after.model.elements.find(e=>e.id==='access-door')!.spaceIds).toEqual(['edit-space-a','edit-space-b']);
},20000);
test('type-wide regeneration changes two pumps; occurrence override changes A only',async()=>{
 const base=await read(await source()),type=await read(await Bun.file(import.meta.dir+'/output/pump-type/source.ifc').bytes()),variant=await read(await Bun.file(import.meta.dir+'/output/pump-variant/source.ifc').bytes());
 expect(changedElements(base.model,type.model)).toEqual(['mfw-a','mfw-b']);expect(changedElements(base.model,variant.model)).toEqual(['mfw-a']);
 expect(parameters(type.model,type.model.elements.find(e=>e.id==='mfw-b')!).length).toBeCloseTo(13.2,7);
 expect(hash(base.nativeBodies.get('mfw-a'))).not.toBe(hash(type.nativeBodies.get('mfw-a')));
 expect(hash(base.nativeBodies.get('mfw-b'))).toBe(hash(variant.nativeBodies.get('mfw-b')));
},20000);
test('roof-only and enumerated deck changes have separate dependency sets',async()=>{
 const base=await read(await source()),roof=await read(await Bun.file(import.meta.dir+'/output/roof/source.ifc').bytes()),deck=await read(await Bun.file(import.meta.dir+'/output/deck/source.ifc').bytes());
 expect(changedElements(base.model,roof.model)).toEqual(['edit-roof','edit-space-a','edit-space-b','edit-wall']);
 expect(changedElements(base.model,deck.model)).toEqual(['edit-deck','edit-landing','edit-riser','edit-stair','edit-support']);
 expect(deck.model.elements.find(e=>e.id==='edit-stair')!.parameters.height).toBe(3.5);
},20000);
test('native parameter/body corruption is refused rather than silently regenerated',async()=>{
 await expect(read(await Bun.file(import.meta.dir+'/output/inconsistent-parameter-body.ifc').bytes())).rejects.toThrow(/PARAMETER_MISMATCH|PARAMETER_BODY_MISMATCH/);
},20000);
test('expected-base and model-binding conflicts are refused before publication',async()=>{
 const b=await source();await expect(admit(b,'wrong',{kind:'move-pump',east:2})).rejects.toThrow('EXPECTED_BASE_CONFLICT');
 await expect(admit(b,hash(b),{kind:'move-pump',east:2},{modelDigest:'unrelated'})).rejects.toThrow('STALE_MODEL_BINDING');
},20000);
test('reproducible full-trial receipt reports every executed positive and negative check',async()=>{
 const r=await Bun.file(import.meta.dir+'/output/receipt.json').json();expect(r.failed).toBe(0);expect(r.passed).toBe(26);
 expect(r.sourceSha256).toBe(hash(await source()));expect(r.checks.find((x:any)=>x.id==='source-only-fresh-process').evidence.fixtureAbsent).toBe(true);
 const old=await Bun.file(import.meta.dir+'/output/initial-receipt.json').json();expect(old.failed).toBe(3);
},20000);
