import type { PhysicalPlanPrimitive } from '../../../../core/packs/plan-drawing.ts'

export type V2 = [number, number]
export type Command = ['M' | 'L', number, number] | ['Q', number, number, number, number] | ['C', number, number, number, number, number, number] | ['Z']
export type Paint = { fill?: string; fillRule?:'nonzero'|'evenodd'; stroke?: string; width?: number; dash?: number[]; opacity?: number; hatch?: { material: string; spacing: number; width: number; angle: number } }
export type Membership = { id: string; scopeIds: string[]; occurrenceId?: string; layerId?: string; depiction: PhysicalPlanPrimitive['depiction'] }
export const drawingBounds = (points: ReadonlyArray<readonly[number,number]>, padding = 0) => {const min:V2=[Infinity,Infinity],max:V2=[-Infinity,-Infinity];for(const point of points)for(const axis of[0,1]as const){min[axis]=Math.min(min[axis],point[axis]-padding);max[axis]=Math.max(max[axis],point[axis]+padding)}return{min,max}}
export const unionBounds = (bounds: ReadonlyArray<{readonly min:readonly[number,number];readonly max:readonly[number,number]}>) => drawingBounds(bounds.flatMap(value => [value.min, value.max]))

/** Ordered, source-local drafting. Curves remain vector curves; no SVG parser or mesh outline. */
export const createPlanWriter = (output: PhysicalPlanPrimitive[], member: Membership, point: (p: V2) => V2 = p => p, rotation = 0) => {
  let serial = 0
  const common = () => ({ ...member, id: `${member.id}/${serial++}` })
  const path = (commands: Command[], paint: Paint): void => {
    const coordinates: V2[] = []
    const transformed = commands.map(command => {
      if (command[0] === 'Z') return command
      const result: Array<string | number> = [command[0]]
      for (let i = 1; i < command.length; i += 2) { const p = point([command[i] as number, command[i + 1] as number]); result.push(...p); coordinates.push(p) }
      return result as Command
    })
    output.push({ ...common(), kind: 'path', commands: transformed, ...paint, bounds: drawingBounds(coordinates, (paint.width ?? 0) / 2) })
  }
  const line = (x: number, y: number, xx: number, yy: number, paint: Paint = { stroke: 'equipment-line', width: .04 }): void => path([['M', x, y], ['L', xx, yy]], paint)
  const rect = (x: number, y: number, width: number, height: number, paint: Paint, radius = 0): void => {
    const r = Math.min(radius, width / 2, height / 2), k = .5522847498307936
    if (!r) { path([['M', x, y], ['L', x + width, y], ['L', x + width, y + height], ['L', x, y + height], ['Z']], paint); return }
    path([['M', x+r,y],['L',x+width-r,y],['C',x+width-r+k*r,y,x+width,y+r-k*r,x+width,y+r],['L',x+width,y+height-r],['C',x+width,y+height-r+k*r,x+width-r+k*r,y+height,x+width-r,y+height],['L',x+r,y+height],['C',x+r-k*r,y+height,x,y+height-r+k*r,x,y+height-r],['L',x,y+r],['C',x,y+r-k*r,x+r-k*r,y,x+r,y],['Z']],paint)
  }
  const ellipse = (x: number, y: number, rx: number, ry: number, paint: Paint): void => {
    const center = point([x,y]), xp=point([x+rx,y]),yp=point([x,y+ry])
    const radii:V2=[Math.hypot(xp[0]-center[0],xp[1]-center[1]),Math.hypot(yp[0]-center[0],yp[1]-center[1])], turn=Math.atan2(xp[1]-center[1],xp[0]-center[0]),c=Math.cos(turn),s=Math.sin(turn)
    const ex = Math.hypot(radii[0]*c,radii[1]*s), ey = Math.hypot(radii[0]*s,radii[1]*c)
    output.push({ ...common(), kind: 'ellipse', center, radii, rotation:turn*180/Math.PI, ...paint, bounds: drawingBounds([[center[0]-ex,center[1]-ey],[center[0]+ex,center[1]+ey]],(paint.width??0)/2) })
  }
  const text = (x: number, y: number, value: string, height: number, material = 'muted', angle = 0, align: 'start'|'middle'|'end' = 'middle', halo?: string): void => {
    const anchor=point([x,y]), turn=(rotation+angle)*Math.PI/180, c=Math.cos(turn),s=Math.sin(turn)
    // Conservative source envelope covers the declared sans-serif text, its
    // halo and every UTF-16 code unit. UI culling never guesses a text box.
    const width=value.length*height*1.2, start=align==='start'?0:align==='end'?-width:-width/2, pad=halo?height*.12:0
    const corners:V2[]=[[start,-height*.75],[start+width,-height*.75],[start+width,height*.75],[start,height*.75]]
    const bounds=drawingBounds(corners.map(([x,y])=>[anchor[0]+c*x-s*y,anchor[1]+s*x+c*y]),pad)
    output.push({ ...common(),kind:'text',anchor,text:value,height,rotation:rotation+angle,align,material,...(halo?{halo,haloWidth:pad}:{}),bounds })
  }
  return { path,line,rect,ellipse,text }
}

export const planStyles = {
  wall:{fill:'cut',stroke:'cut',width:.02}, column:{fill:'steel',stroke:'cut',width:.065},
  equipment:{fill:'light',stroke:'equipment-line',width:.065}, casing:{fill:'machine',stroke:'equipment-line',width:.08},
  hood:{fill:'hood',stroke:'rib',width:.045}, plinth:{fill:'plinth',stroke:'rib',width:.045},
  bearing:{fill:'light',stroke:'equipment-line',width:.065}, bolt:{fill:'paper',stroke:'rib',width:.027},
  motor:{fill:'motor',stroke:'equipment-line',width:.075}, terminal:{fill:'light',stroke:'equipment-line',width:.055},
  fine:{stroke:'equipment-line',width:.04}, rib:{stroke:'rib',width:.045},
  split:{stroke:'equipment-line',width:.035,dash:[.18,.13]}, center:{stroke:'muted',width:.035,dash:[.7,.2,.08,.2]},
  context:{stroke:'context-line',width:.04,dash:[.28,.19]},
} satisfies Record<string,Paint>
