import { z } from 'zod';
const identifier = z.string().min(1).max(200);
const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const dimensions = z.object({ length: z.number().finite().positive().max(10000), width: z.number().finite().positive().max(10000), height: z.number().finite().positive().max(10000) }).strict();
export const turbineIslandFamilies = ['hp', 'lp', 'generator', 'exciter', 'msr', 'stop-valve', 'condenser', 'feed-pump', 'condensate-pump'] as const;
const family = z.enum([...turbineIslandFamilies, 'reactor-vessel', 'steam-generator', 'pressurizer', 'pump', 'reactor-coolant-pump', 'tank', 'heat-exchanger', 'valve', 'diesel-generator', 'cabinet', 'battery', 'transformer', 'breaker', 'disconnector', 'bus-support', 'pylon']);
const material = z.enum(['wall', 'floor', 'metal', 'equipment', 'pipe', 'door', 'glass', 'context', 'line']);
const elementSchema = z.object({
    id: identifier, label: z.string().min(1).max(300),
    kind: z.enum(['equipment', 'wall', 'opening', 'door', 'assembly', 'slab', 'stair', 'roof', 'riser', 'support', 'space', 'context', 'pipe', 'building', 'road', 'fence', 'conductor']),
    levelId: identifier,
    pose: z.object({ position: vector, yaw: z.number().finite() }).strict(),
    dimensions: dimensions.optional(), typeId: identifier.optional(), override: dimensions.partial().optional(),
    equipmentKind: family.optional(),
    buildingId: identifier.optional(),
    footprint: z.enum(['rectangle', 'ellipse']).optional(),
    material: material.optional(),
    shape: z.discriminatedUnion('kind', [
        z.object({ kind: z.enum(['cylindrical-shell', 'dome-shell']), thickness: z.number().finite().positive() }).strict(),
        z.object({ kind: z.literal('elliptical-plate') }).strict(),
    ]).optional(),
    hostId: identifier.optional(), fillsId: identifier.optional(), assemblyId: identifier.optional(),
    spaceIds: z.array(identifier).max(64).optional(),
    disposition: z.enum(['installed', 'proposed', 'removed', 'temporary']),
    door: z.object({ swing: z.number().finite() }).strict().optional(),
    dependsOn: z.array(identifier).max(64).optional(),
    holes: z.array(z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().positive(), length: z.number().finite().positive() }).strict()).max(256).optional(),
    path: z.array(vector).min(2).max(1000).optional(),
    supportIds: z.array(identifier).min(1).max(64).optional(),
    terminatesBeyond: z.boolean().optional(),
    installation: z.enum(['overhead', 'busbar', 'cable-corridor']).optional(),
}).strict();
export const physicalSourceSchema = z.object({
    id: identifier, title: z.string().min(1).max(300), units: z.literal('m'), axes: z.literal('Z-up'),
    origin: vector,
    levels: z.array(z.object({ id: identifier, label: z.string().min(1).max(200), elevation: z.number().finite(), cutHeight: z.number().finite().positive() }).strict()).min(1).max(128),
    types: z.array(z.object({ id: identifier, kind: family, parameters: dimensions }).strict()).max(1000),
    elements: z.array(elementSchema).max(10000),
    evidence: z.object({ accuracy: z.literal('illustrative'), origin: z.string().min(1).max(1000) }).strict(),
    siteAnchor: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-85).max(85)]).optional(),
}).strict().superRefine((source, context) => {
    const issue = (message: string): void => context.addIssue({ code: 'custom', message });
    const all = [...source.levels, ...source.types, ...source.elements];
    if (new Set(all.map(item => item.id)).size !== all.length)
        issue('Physical identities must be unique');
    const elements = new Map(source.elements.map(element => [element.id, element]));
    for (const element of source.elements) {
        if (element.levelId !== 'site' && !source.levels.some(level => level.id === element.levelId))
            issue(`Unknown level: ${element.id}`);
        const type = source.types.find(type => type.id === element.typeId);
        if (element.typeId && !type)
            issue(`Unknown physical type: ${element.id}`);
        if (element.dimensions && element.typeId)
            issue(`Two dimension authorities: ${element.id}`);
        if (element.override && !type)
            issue(`Unowned occurrence override: ${element.id}`);
        const resolved = { ...(type?.parameters ?? element.dimensions), ...element.override };
        if (!dimensions.safeParse(resolved).success)
            issue(`Incomplete physical dimensions: ${element.id}`);
        if (element.kind === 'equipment' && (!type || element.equipmentKind !== type.kind))
            issue(`Unsupported equipment family: ${element.id}`);
        if (element.path && !['pipe', 'road', 'fence', 'conductor'].includes(element.kind))
            issue(`A path must belong to an authored route: ${element.id}`);
        if (['pipe', 'road', 'fence', 'conductor'].includes(element.kind) && !element.path)
            issue(`A route needs an authored path: ${element.id}`);
        if (element.path?.some((point, index, path) => index > 0 && point.every((value, axis) => value === path[index - 1]![axis])))
            issue(`A route has a zero-length segment: ${element.id}`);
        if (element.buildingId && elements.get(element.buildingId)?.kind !== 'building')
            issue(`Unknown building: ${element.id}`);
        if (element.kind === 'building' && element.buildingId)
            issue(`A building cannot be nested in another building: ${element.id}`);
        if (element.footprint && element.kind !== 'building')
            issue(`Only a building owns a footprint: ${element.id}`);
        if ((element.supportIds || element.terminatesBeyond !== undefined || element.installation) && element.kind !== 'conductor')
            issue(`Only an electrical conductor names supports or continuation: ${element.id}`);
        if (element.supportIds && (new Set(element.supportIds).size !== element.supportIds.length || element.supportIds.some(id => elements.get(id)?.equipmentKind !== 'pylon')))
            issue(`A conductor needs unique authored pylon supports: ${element.id}`);
        if (element.shape && ((element.shape.kind === 'cylindrical-shell' && element.kind !== 'wall') || (element.shape.kind === 'dome-shell' && element.kind !== 'roof') || (element.shape.kind === 'elliptical-plate' && !['slab', 'roof'].includes(element.kind))))
            issue(`Unsupported architectural shape: ${element.id}`);
        if (element.shape && element.shape.kind !== 'elliptical-plate' && element.shape.thickness * 2 >= Math.min(resolved.length ?? 0, resolved.width ?? 0, element.shape.kind === 'dome-shell' ? (resolved.height ?? 0) * 2 : Infinity))
            issue(`Shell thickness consumes its interior: ${element.id}`);
        if (element.shape && element.holes?.length)
            issue(`Shaped plates and shells do not support rectangular holes: ${element.id}`);
        for (const id of element.spaceIds ?? [])
            if (elements.get(id)?.kind !== 'space')
                issue(`Unknown space: ${id}`);
        for (const id of element.dependsOn ?? [])
            if (!elements.has(id))
                issue(`Unknown dependency: ${id}`);
        if (element.assemblyId && elements.get(element.assemblyId)?.kind !== 'assembly')
            issue(`Unknown assembly: ${element.id}`);
        if (element.hostId && elements.get(element.hostId)?.kind !== 'wall')
            issue(`An opening needs a wall host: ${element.id}`);
        if (element.hostId && elements.get(element.hostId)?.shape)
            issue(`Curved hosts need explicit segmented wall openings: ${element.id}`);
        if (element.kind === 'opening' && !element.hostId)
            issue(`Unhosted opening: ${element.id}`);
        if (element.fillsId && elements.get(element.fillsId)?.kind !== 'opening')
            issue(`Unknown filled opening: ${element.id}`);
        if (element.fillsId && source.elements.filter(candidate => candidate.fillsId === element.fillsId).length !== 1)
            issue(`Multiple filling authorities: ${element.fillsId}`);
        for (const hole of element.holes ?? [])
            if (hole.x + hole.length > (resolved.length ?? 0) || hole.y + hole.width > (resolved.width ?? 0))
                issue(`Hole outside plate: ${element.id}`);
        if (element.kind === 'opening' && element.hostId) {
            const host = elements.get(element.hostId);
            const hostType = source.types.find(type => type.id === host?.typeId);
            const hostDimensions = { ...(hostType?.parameters ?? host?.dimensions), ...host?.override };
            if (element.pose.position[0] < 0 || element.pose.position[0] + (resolved.length ?? 0) > (hostDimensions.length ?? 0) || element.pose.position[2] < 0 || element.pose.position[2] + (resolved.height ?? 0) > (hostDimensions.height ?? 0))
                issue(`Opening outside host: ${element.id}`);
        }
    }
});
export type Source = z.infer<typeof physicalSourceSchema>;
export type Element = Source['elements'][number];
export type Parameters = z.infer<typeof dimensions>;
export type V3 = [
    number,
    number,
    number
];
/** Family-tool input; millimetres are converted at this one retained adapter. */
export interface Equipment {
    id: string;
    kind: z.infer<typeof family>;
    x: number;
    y: number;
    w: number;
    h: number;
    zBase: number;
    zTop: number;
}
export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}
export const parameters = (source: Source, element: Element): Parameters => dimensions.parse({
    ...(source.types.find(type => type.id === element.typeId)?.parameters ?? element.dimensions), ...element.override,
});
export const elementWorld = (source: Source, element: Element): Element['pose'] => {
    if (!element.hostId)
        return element.pose;
    const host = source.elements.find(candidate => candidate.id === element.hostId);
    if (!host || host.kind !== 'wall')
        throw new Error(`Unknown wall host: ${element.id}`);
    const [x, y, z] = element.pose.position, c = Math.cos(host.pose.yaw), s = Math.sin(host.pose.yaw);
    return { position: [host.pose.position[0] + c * x - s * y, host.pose.position[1] + s * x + c * y, host.pose.position[2] + z], yaw: host.pose.yaw + element.pose.yaw };
};
