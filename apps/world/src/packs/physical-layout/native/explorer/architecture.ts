import { createMesh, palette, materialRoles } from './mesh.ts';
import { equipmentMesh } from './turbine-families.ts';
import { parameters, elementWorld, type Source, type Element, type V3, type Equipment } from './source.ts';
export type RenderObject = {
    id: string;
    levelId: string;
    kind: string;
    positions: number[];
    normals: number[];
    materialIndices: number[];
    bounds: {
        min: V3;
        max: V3;
    };
    sourceElementId: string;
    label: string;
    materials: string[];
    linePositions: number[];
};
const baseline = { hp: [7, 4.8, 5.1], lp: [9, 11.2, 6.7], generator: [12.5, 6, 6.5], exciter: [4, 3.2, 3.8], msr: [7.4, 3, 4.5], 'stop-valve': [1.8, 2.1, 3.1], condenser: [9, 15.8, 14.6], 'feed-pump': [12, 2.7, 3.4], 'condensate-pump': [5.2, 2.6, 3.2] } as const;
function template(e: Element): Equipment { const k = e.equipmentKind as keyof typeof baseline; const b = baseline[k]; return { id: e.id, kind: k, x: 0, y: 0, w: b[0] * 1000, h: b[1] * 1000, zBase: 0, zTop: b[2] * 1000, }; }
export const bounds = (p: number[]) => { const a: V3 = [Infinity, Infinity, Infinity], b: V3 = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < p.length; i += 3)
    for (let k = 0; k < 3; k++) {
        a[k] = Math.min(a[k]!, p[i + k]!);
        b[k] = Math.max(b[k]!, p[i + k]!);
    } return { min: a, max: b }; };
const localToWorld = (v: V3, pose: {
    position: V3;
    yaw: number;
}): V3 => { const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw); return [pose.position[0] + c * v[0] - s * v[1], pose.position[1] + s * v[0] + c * v[1], pose.position[2] + v[2]]; };
// Partition a wall in its own XY/Z frame; hosted voids are real omitted cells.
export function wallCells(s: Source, e: Element) {
    const p = parameters(s, e), open = s.elements.filter(o => o.kind === 'opening' && o.hostId === e.id), xs = [0, p.length, ...open.flatMap(o => [o.pose.position[0], o.pose.position[0] + parameters(s, o).length])].sort((a, b) => a - b), zs = [0, p.height, ...open.flatMap(o => [o.pose.position[2], o.pose.position[2] + parameters(s, o).height])].sort((a, b) => a - b), cells: {
        x: number;
        z: number;
        length: number;
        height: number;
    }[] = [];
    for (let i = 0; i < xs.length - 1; i++)
        for (let j = 0; j < zs.length - 1; j++) {
            const x = xs[i]!, z = zs[j]!, length = xs[i + 1]! - x, height = zs[j + 1]! - z;
            if (length <= 0 || height <= 0)
                continue;
            const midx = x + length / 2, midz = z + height / 2;
            if (!open.some(o => { const d = parameters(s, o); return midx > o.pose.position[0] && midx < o.pose.position[0] + d.length && midz > o.pose.position[2] && midz < o.pose.position[2] + d.height; }))
                cells.push({ x, z, length, height });
        }
    return cells;
}
/** Face-cell partition edges are construction detail, not architectural features. */
const wallFeatures = (mesh: ReturnType<typeof createMesh>, cells: ReturnType<typeof wallCells>, thickness: number): void => {
    const edges = new Map<string, { a: [number, number]; b: [number, number]; count: number }>();
    for (const cell of cells) {
        const points: Array<[number, number]> = [[cell.x, cell.z], [cell.x + cell.length, cell.z], [cell.x + cell.length, cell.z + cell.height], [cell.x, cell.z + cell.height]];
        for (let i = 0; i < points.length; i++) {
            const a = points[i]!, b = points[(i + 1) % points.length]!, key = [a.join(','), b.join(',')].sort().join('/');
            const edge = edges.get(key);
            if (edge) edge.count++; else edges.set(key, { a, b, count: 1 });
        }
    }
    const ends = new Map<string, { point: [number, number]; neighbours: Array<[number, number]> }>();
    for (const edge of edges.values()) if (edge.count === 1) {
        for (const z of [0, thickness]) mesh.line([edge.a[0], edge.a[1], z], [edge.b[0], edge.b[1], z]);
        for (const [point, neighbour] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
            const key = point.join(','), value = ends.get(key) ?? { point, neighbours: [] };
            value.neighbours.push(neighbour); ends.set(key, value);
        }
    }
    for (const { point: [x,y], neighbours } of ends.values()) if (neighbours.length !== 2 || Math.abs((neighbours[0]![0]-x)*(neighbours[1]![1]-y)-(neighbours[0]![1]-y)*(neighbours[1]![0]-x)) > 1e-8) mesh.line([x, y, 0], [x, y, thickness]);
};
function plateCells(e: Element, p: ReturnType<typeof parameters>) { const holes = e.holes ?? [], xs = [0, p.length, ...holes.flatMap(h => [h.x, h.x + h.length])].filter(x => x >= 0 && x <= p.length).sort((a, b) => a - b), ys = [0, p.width, ...holes.flatMap(h => [h.y, h.y + h.width])].filter(x => x >= 0 && x <= p.width).sort((a, b) => a - b), out: {
    x: number;
    y: number;
    length: number;
    width: number;
}[] = []; for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < ys.length - 1; j++) {
        const x = xs[i]!, y = ys[j]!, length = xs[i + 1]! - x, width = ys[j + 1]! - y;
        if (length <= 0 || width <= 0)
            continue;
        if (!holes.some(h => x + length / 2 > h.x && x + length / 2 < h.x + h.length && y + width / 2 > h.y && y + width / 2 < h.y + h.width))
            out.push({ x, y, length, width });
    } return out; }
export function solid(s: Source, e: Element): RenderObject | null {
    if (e.kind === 'opening' || e.kind === 'space' || e.kind === 'assembly' || e.disposition === 'removed')
        return null;
    const p = parameters(s, e), pose = elementWorld(s, e), m = createMesh();
    let scale: V3 = [1, 1, 1];
    if (e.kind === 'equipment') {
        const t = template(e), base = baseline[e.equipmentKind as keyof typeof baseline];
        const g = equipmentMesh(t);
        m.vertices = g.vertices;
        m.lines = g.lines;
        scale = [p.length / base[0], p.height / base[2], p.width / base[1]];
    }
    else if (e.kind === 'wall') {
        const cells = wallCells(s, e);
        for (const c of cells) m.box(c.x, c.z, 0, c.length, c.height, p.width, palette.wall, false);
        wallFeatures(m, cells, p.width);
    }
    else if (e.kind === 'slab' || e.kind === 'roof') {
        for (const c of plateCells(e, p))
            m.box(c.x, 0, c.y, c.length, p.height, c.width, palette.floor, false);
    }
    else if (e.kind === 'stair') {
        const flights = Math.max(2, Math.ceil(p.height / 2.5)), rise = p.height / flights, steps = Math.max(1, Math.ceil(rise / .17)), run = (p.width - 2 * .8) / steps, fw = (p.length - .7) / 2;
        for (let f = 0; f < flights; f++) {
            const a = f % 2 === 0, x = a ? .1 : p.length - fw - .1;
            for (let k = 0; k < steps; k++)
                m.box(x, f * rise + k * rise / steps, .8 + (a ? k : steps - k - 1) * run, fw, rise / steps, run, palette.light, false);
            m.box(.1, (f + 1) * rise - .12, a ? p.width - .8 : 0, p.length - .2, .12, .8, palette.light);
            for (const dx of [x + .05, x + fw - .05])
                m.cylinder([dx, f * rise + 1.05, a ? .8 : p.width - .8], [dx, (f + 1) * rise + 1.05, a ? p.width - .8 : .8], .03, palette.steel, 8);
        }
    }
    else if (e.kind === 'riser')
        m.cylinder([p.length / 2, 0, p.width / 2], [p.length / 2, p.height, p.width / 2], Math.min(p.length, p.width) / 2, palette.pipe, 20);
    else if (e.kind === 'pipe') {
        if (!e.path)
            throw Error('pipe-path-required');
        for (let i = 0; i < e.path.length - 1; i++) {
            const a = e.path[i]!, b = e.path[i + 1]!;
            m.cylinder([a[0], a[2], a[1]], [b[0], b[2], b[1]], p.width / 2, palette.pipe, 16);
        }
    }
    else
        m.box(0, 0, 0, p.length, p.height, p.width, e.kind === 'door' ? palette.crane : e.kind === 'support' ? palette.steel : palette.plinth);
    const positions: number[] = [], materialIndices: number[] = [], normals: number[] = [];
    for (let i = 0; i < m.vertices.length; i += 7) {
        const v: V3 = [m.vertices[i]! * scale[0], m.vertices[i + 2]! * scale[2], m.vertices[i + 1]! * scale[1]], w = localToWorld(v, pose);
        positions.push(...w);
        const n0: V3 = [m.vertices[i + 3]! / scale[0], m.vertices[i + 5]! / scale[2], m.vertices[i + 4]! / scale[1]], nn = Math.hypot(...n0) || 1, c = Math.cos(pose.yaw), d = Math.sin(pose.yaw);
        normals.push((c * n0[0] - d * n0[1]) / nn, (d * n0[0] + c * n0[1]) / nn, n0[2] / nn);
        materialIndices.push(m.vertices[i + 6]!);
    }
    const linePositions: number[] = [];
    for (let i = 0; i < m.lines.length; i += 3) {
        const v: V3 = [m.lines[i]! * scale[0], m.lines[i + 2]! * scale[2], m.lines[i + 1]! * scale[1]];
        linePositions.push(...localToWorld(v, pose));
    }
    return { id: e.id, sourceElementId: e.id, linePositions, kind: e.kind, levelId: e.levelId, label: e.label, positions, normals, materialIndices, materials: [...materialRoles], bounds: bounds(positions) };
}
