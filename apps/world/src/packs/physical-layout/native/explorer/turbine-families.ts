// Shaped machinery tooling extracted/refactored from accepted MIT-licensed 3D trial.
// Positions/dimensions arrive only through admitted source type parameters.
import { createMesh, palette as p, type Mesh } from './mesh.ts';
import type { V3 } from '../math.ts';
import type { Equipment, Box } from './source.ts';
const m = (n: number) => n / 1000;
const assemblyBounds = (e: Equipment): Box => ({ x: e.x - 180, y: e.y - 150, w: e.w + 360, h: e.h + 300 });
function pumpNozzles(e: Equipment) { return e.kind === 'feed-pump' ? { inlet: [e.x + 1200, e.y + 100], outlet: [e.x + 4075, e.y + e.h] } : { inlet: [e.x, e.y + e.h / 2], outlet: [e.x + 825, e.y] }; }
function bolt(mesh: Mesh, x: number, y: number, z: number) { mesh.cylinder([x, y, z], [x, y + .12, z], .095, p.dark, 6); }
function plinth(mesh: Mesh, e: Equipment) { const b = assemblyBounds(e); mesh.box(m(b.x), m(e.zBase), m(b.y), m(b.w), .3, m(b.h), p.plinth); }
function motor(mesh: Mesh, x: number, y: number, z: number, w: number, h: number, d: number) {
    mesh.loftX(x, y, z, [[0, h * .7, d * .7], [.35, h, d], [w - .45, h, d], [w, h * .78, d * .78]], p.motor);
    for (let xx = .5; xx < w - .4; xx += .35)
        mesh.loftX(x, y, z, [[xx, h + .07, d + .07], [xx + .065, h + .07, d + .07]], p.light, 24);
    mesh.box(x + w - .9, y + h * .72, z - .4, .7, .5, .8, p.dark);
    mesh.box(x + .4, y - h - .2, z - d * .65, w - .8, .3, d * 1.3, p.dark);
}
export function equipmentMesh(e: Equipment): Mesh {
    const mesh = createMesh(), x = m(e.x), z = m(e.y), w = m(e.w), d = m(e.h), base = m(e.zBase), top = m(e.zTop), cy = m(e.zBase) + 2.2, cz = z + d / 2;
    switch (e.kind) {
        case 'hp': {
            plinth(mesh, e);
            mesh.box(x + .8, base + .3, z + .6, w - 1.6, 1.2, d - 1.2, p.dark);
            mesh.loftX(x, cy, cz, [[.1, 1.05, 1.35], [1.1, 1.55, 2.05], [w / 2, 1.65, 2.25], [w - 1.1, 1.55, 2.05], [w - .1, 1.05, 1.35]], p.machine);
            mesh.box(x + .5, cy - .14, z + .05, w - 1, .25, d - .1, p.hood);
            for (let xx = 1; xx < w - .5; xx += .7) {
                mesh.loftX(x, cy, cz, [[xx, 1.69, 2.28], [xx + .09, 1.69, 2.28]], p.light, 24);
                bolt(mesh, x + xx, cy + .14, z + .22);
                bolt(mesh, x + xx, cy + .14, z + d - .22);
            }
            break;
        }
        case 'lp': {
            const bounds = assemblyBounds(e);
            // Four nonoverlapping strips preserve the original exhaust-neck void.
            // A single plinth box would close the physical route to the condenser.
            const hole = { x: e.x + 1300, y: e.y + 3600, w: e.w - 2600, h: e.h - 7200 };
            for (const cell of [
                { x: bounds.x, y: bounds.y, w: hole.x - bounds.x, h: bounds.h },
                { x: hole.x + hole.w, y: bounds.y, w: bounds.x + bounds.w - hole.x - hole.w, h: bounds.h },
                { x: hole.x, y: bounds.y, w: hole.w, h: hole.y - bounds.y },
                { x: hole.x, y: hole.y + hole.h, w: hole.w, h: bounds.y + bounds.h - hole.y - hole.h },
            ]) mesh.box(m(cell.x), base, m(cell.y), m(cell.w), .3, m(cell.h), p.plinth, false);
            mesh.frustum(x + .1, base + .3, z + .1, w - .2, d - .2, 2.8, w - 1.4, d - 1.4, p.hood);
            mesh.loftX(x, cy, cz, [[.1, 1.5, 3.4], [.9, 1.9, 4.7], [w / 2, 2.0, 5.05], [w - .9, 1.9, 4.7], [w - .1, 1.5, 3.4]], p.machine, 40);
            mesh.box(x + .15, cy - .18, z + .1, w - .3, .32, d - .2, p.light);
            for (let xx = .65; xx < w - .4; xx += .85)
                for (const zz of [z + .25, z + d - .25])
                    bolt(mesh, x + xx, cy + .15, zz);
            for (let zz = 1; zz < d - .5; zz += 1)
                for (const xx of [x + .25, x + w - .25])
                    bolt(mesh, xx, cy + .15, z + zz);
            mesh.loftX(x, cy, cz, [[w / 2 - .12, 2.06, 5.12], [w / 2 + .12, 2.06, 5.12]], p.light, 40);
            break;
        }
        case 'generator': {
            plinth(mesh, e);
            mesh.box(x + .7, base + .3, z + .4, w - 1.4, .5, d - .8, p.dark);
            mesh.loftX(x, cy, cz, [[.1, 1.6, 2.1], [1.0, 2.05, 2.8], [w - 1, 2.05, 2.8], [w - .1, 1.6, 2.1]], p.motor, 40);
            for (let xx = 1.5; xx < w - 1.1; xx += .65)
                mesh.loftX(x, cy, cz, [[xx, 2.1, 2.9], [xx + .07, 2.1, 2.9]], p.light, 32);
            mesh.box(x + w * .42, base + .4, z + d - .5, 3, 1.8, 1.3, p.light);
            for (let i = 0; i < 3; i++)
                mesh.cylinder([x + w * .45 + .35 + i * .75, base + .8, z + d + .8], [x + w * .45 + .35 + i * .75, base + .8, z + d + 1.6], .22, p.crane, 12);
            break;
        }
        case 'exciter':
            plinth(mesh, e);
            motor(mesh, x, cy, cz, w, 1.35, 1.35);
            break;
        case 'msr': {
            mesh.box(x + 1, base, z + .2, w - 2, .4, d - .4, p.plinth);
            for (const xx of [x + 1.4, x + w - 1.6])
                mesh.box(xx, base + .4, z + .5, .3, 1.2, d - 1, p.dark);
            mesh.loftX(x, base + 2.6, cz, [[0, .05, .05], [.35, 1.1, 1.1], [1, 1.4, 1.4], [w - 1, 1.4, 1.4], [w - .35, 1.1, 1.1], [w, .05, .05]], p.hood, 32);
            for (const xx of [1.1, w - 1.1])
                mesh.loftX(x, base + 2.6, cz, [[xx, 1.44, 1.44], [xx + .08, 1.44, 1.44]], p.light);
            mesh.cylinder([x + w - 1.9, base + 2.6, z], [x + w - 1.9, base + 2.6, z - .5], .3, p.dark);
            mesh.cylinder([x + 1.8, base + 2.6, z + d], [x + 1.8, base + 2.6, z + d + .5], .25, p.dark);
            break;
        }
        case 'stop-valve': {
            mesh.box(x + .25, base, z + .35, w - .5, .4, d - .7, p.plinth);
            mesh.cylinder([x, base + 1.3, cz], [x + w, base + 1.3, cz], .4, p.machine);
            mesh.frustum(x + .35, base + .6, cz - .65, 1.1, 1.3, 1.1, .6, .7, p.machine);
            mesh.cylinder([x + w / 2, base + 1.4, cz], [x + w / 2, base + 2.7, cz], .09, p.dark);
            mesh.cylinder([x + w / 2, base + 2.7, cz], [x + w / 2, base + 2.85, cz], .42, p.crane, 20);
            break;
        }
        case 'condenser': {
            mesh.box(x, base, z, w, .4, d, p.plinth);
            mesh.box(x + .25, base + .4, z + 1.8, w - .5, 11.3, d - 3.6, p.machine);
            mesh.frustum(x + .5, base + 11.7, z + 2.0, w - 1, d - 4, 2.9, w - 2.6, d - 7.2, p.hood);
            for (const zz of [z + .15, z + d - 1.55]) {
                mesh.box(x + .4, base + .7, zz, w - .8, 10.4, 1.4, p.waterbox);
                for (const xx of [x + w * .3, x + w * .7]) {
                    mesh.cylinder([xx, base + 5.9, zz - .05], [xx, base + 5.9, zz + 1.45], .85, p.light, 24);
                    mesh.cylinder([xx, base + 5.9, zz - .1], [xx, base + 5.9, zz - .05], .62, p.dark);
                }
            }
            for (let yy = 2; yy < 11; yy += 2.2)
                for (const xx of [x + .18, x + w - .28])
                    mesh.box(xx, base + yy, z + 1.8, .1, .16, d - 3.6, p.light);
            mesh.box(x + w - 1.7, base + .5, z + d * .45, 2.4, 4, 2.4, p.waterbox);
            break;
        }
        case 'feed-pump':
        case 'condensate-pump': {
            plinth(mesh, e);
            const big = e.kind === 'feed-pump', py = base + (big ? 1.65 : 1.4), core = big ? 4.6 : 2.15, r = big ? .95 : .85;
            mesh.loftX(x + .15, py, cz, [[0, r * .7, r * .7], [.3, r, r], [core - .3, r, r], [core, r * .7, r * .7]], p.machine, 28);
            if (big)
                for (let xx = .8; xx < 4.4; xx += .46)
                    mesh.loftX(x, py, cz, [[xx, 1.02, 1.02], [xx + .08, 1.02, 1.02]], p.light, 24);
            const mx = big ? 6.5 : 2.95, mw = big ? 5.2 : 2.15;
            motor(mesh, x + mx, py, cz, mw, big ? 1.1 : .75, big ? 1.1 : .75);
            mesh.cylinder([x + core, py, cz], [x + mx, py, cz], .18, p.dark, 16);
            mesh.box(x + core + .1, py - .36, cz - .37, mx - core - .2, .72, .74, p.crane);
            const nozzles = pumpNozzles(e);
            for (const [key, point] of Object.entries(nozzles)) {
                const px = m(point[0]!), pz = m(point[1]!), bodyZ = key === 'inlet' ? cz - .65 : cz + .65;
                if (!big && key === 'inlet') {
                    mesh.cylinder([px, py, pz], [px + .5, py, pz], .26, p.machine, 16);
                    mesh.cylinder([px, py, pz], [px + .12, py, pz], .36, p.light, 20);
                }
                else {
                    mesh.cylinder([px, py, bodyZ], [px, py, pz], .26, p.machine, 16);
                    mesh.cylinder([px, py, pz - .06], [px, py, pz + .06], .36, p.light, 20);
                }
            }
            break;
        }
    }
    // The source elevations bound every equipment solid; extra routing is a separate overlay.
    if (top <= base)
        throw Error(`Invalid source height ${e.id}`);
    return mesh;
}
