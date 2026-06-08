import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { DroneMapWorldSnapshot, DroneSceneryTileAsset } from './drone-map-world.ts'
import { terrainHeightAt, type DroneTerrainModel } from './drone-terrain.ts'

const maxCachedTileTemplates = 256
const tileLoadConcurrency = 10

const cachedTileTemplates = new Map<string, Promise<THREE.Group>>()

let gltfLoader: GLTFLoader | null = null

const loader = (): GLTFLoader => {
  gltfLoader ??= new GLTFLoader()
  return gltfLoader
}

const terrainY = (
  terrain: DroneTerrainModel | undefined,
  x: number,
  z: number,
  baseY: number,
): number =>
  baseY + (terrain ? terrainHeightAt(terrain, x, z) : 0)

const createGroundTexture = (): THREE.Texture | null => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 1024
  const context = canvas.getContext('2d')
  if (!context) return null
  const image = context.createImageData(canvas.width, canvas.height)
  for (let index = 0; index < image.data.length; index += 4) {
    const pixel = index / 4
    const x = pixel % canvas.width
    const y = Math.floor(pixel / canvas.width)
    const broad = Math.sin(x * 0.021 + y * 0.017) * 0.5 + Math.sin(x * 0.007 - y * 0.014) * 0.5
    const fineNoise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    const grain = (fineNoise - Math.floor(fineNoise)) * 18
    image.data[index] = Math.round(58 + broad * 8 + grain * 0.32)
    image.data[index + 1] = Math.round(82 + broad * 14 + grain * 0.55)
    image.data[index + 2] = Math.round(62 + broad * 7 + grain * 0.28)
    image.data[index + 3] = 255
  }
  context.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(20, 20)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

const createBaseGround = (
  radiusM: number,
  terrain?: DroneTerrainModel,
): THREE.Mesh => {
  const texture = createGroundTexture()
  const material = new THREE.MeshStandardMaterial({
    color: '#4f6945',
    roughness: 0.96,
    metalness: 0.01,
    ...(texture === null ? {} : { map: texture }),
  })
  if (terrain?.kind === 'dem') {
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let row = 0; row < terrain.gridSize; row += 1) {
      const z = -terrain.radiusM + row * terrain.sampleSpacingM
      for (let column = 0; column < terrain.gridSize; column += 1) {
        const x = -terrain.radiusM + column * terrain.sampleSpacingM
        positions.push(x, terrainHeightAt(terrain, x, z) - 0.55, z)
        uvs.push(column / (terrain.gridSize - 1) * 20, row / (terrain.gridSize - 1) * 20)
      }
    }
    for (let row = 0; row < terrain.gridSize - 1; row += 1) {
      for (let column = 0; column < terrain.gridSize - 1; column += 1) {
        const base = row * terrain.gridSize + column
        indices.push(base, base + terrain.gridSize, base + 1, base + 1, base + terrain.gridSize, base + terrain.gridSize + 1)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const ground = new THREE.Mesh(geometry, material)
    ground.receiveShadow = true
    return ground
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radiusM * 2.8, radiusM * 2.8, 1, 1), material)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.55
  ground.receiveShadow = true
  return ground
}

const createDistantHills = (
  radiusM: number,
): THREE.Mesh => {
  const inner = radiusM * 1.08
  const outer = radiusM * 1.9
  const segments = 96
  const positions: number[] = []
  const indices: number[] = []
  for (let index = 0; index <= segments; index += 1) {
    const angle = index / segments * Math.PI * 2
    const height = 80 + Math.sin(index * 0.47) * 24 + Math.sin(index * 0.13 + 2.1) * 38
    positions.push(Math.cos(angle) * inner, -10, Math.sin(angle) * inner)
    positions.push(Math.cos(angle) * outer, height, Math.sin(angle) * outer)
  }
  for (let index = 0; index < segments; index += 1) {
    const base = index * 2
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#687789', roughness: 0.98, metalness: 0.01 }))
  mesh.receiveShadow = false
  return mesh
}

const createAtmosphereDome = (
  radiusM: number,
): THREE.Mesh => {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color('#70b7f2') },
      bottomColor: { value: new THREE.Color('#dbeafe') },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition).y * 0.5 + 0.5;
        gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(0.08, 0.96, h)), 1.0);
      }
    `,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radiusM * 3.5, 32, 16), material)
  dome.frustumCulled = false
  return dome
}

export const createAtmosphericBaseWorldGroup = (
  radiusM = 1_600,
  terrain?: DroneTerrainModel,
): THREE.Group => {
  const group = new THREE.Group()
  group.add(createAtmosphereDome(radiusM), createBaseGround(radiusM, terrain), createDistantHills(radiusM))
  return group
}

const disposeTileTemplate = (
  group: THREE.Object3D,
): void => {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh)) return
    geometries.add(child.geometry)
    if (Array.isArray(child.material)) {
      for (const material of child.material) materials.add(material)
    } else {
      materials.add(child.material)
    }
  })
  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
}

const rememberTileTemplate = (
  key: string,
  promise: Promise<THREE.Group>,
): void => {
  cachedTileTemplates.set(key, promise)
  while (cachedTileTemplates.size > maxCachedTileTemplates) {
    const oldestKey = cachedTileTemplates.keys().next().value
    if (typeof oldestKey !== 'string') break
    const evicted = cachedTileTemplates.get(oldestKey)
    cachedTileTemplates.delete(oldestKey)
    void evicted?.then(disposeTileTemplate, () => undefined)
  }
}

const markSharedAssetResources = (
  group: THREE.Object3D,
): void => {
  group.traverse(child => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh)) return
    child.geometry.userData.droneSharedWorldGeometry = true
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      material.userData.droneSharedWorldMaterial = true
      material.userData.droneSceneryKind = material.name
    }
    child.userData.droneSceneryKind = materials[0]?.name ?? 'scenery-asset'
    child.castShadow = false
    child.receiveShadow = false
  })
}

const loadTileTemplate = async (
  tile: DroneSceneryTileAsset,
): Promise<THREE.Group> => {
  const gltf = await loader().loadAsync(tile.url)
  const group = gltf.scene
  markSharedAssetResources(group)
  group.userData.droneSceneryKind = 'scenery-asset-tile'
  group.userData.droneSceneryTile = tile.id
  return group
}

const tileTemplateFor = (
  tile: DroneSceneryTileAsset,
): Promise<THREE.Group> => {
  const key = `${tile.recipeId}:${tile.z}/${tile.x}/${tile.y}:${tile.byteLength}`
  const cached = cachedTileTemplates.get(key)
  if (cached) {
    cachedTileTemplates.delete(key)
    cachedTileTemplates.set(key, cached)
    return cached
  }
  const promise = loadTileTemplate(tile)
  rememberTileTemplate(key, promise)
  return promise
}

const cloneTileForWorld = (
  template: THREE.Group,
  tile: DroneSceneryTileAsset,
  terrain: DroneTerrainModel | undefined,
): THREE.Group => {
  const clone = template.clone(true)
  clone.position.set(
    tile.localOrigin.x,
    terrainY(terrain, tile.localOrigin.x, tile.localOrigin.z, 0),
    tile.localOrigin.z,
  )
  clone.userData.droneSceneryKind = 'scenery-asset-tile'
  clone.userData.droneSceneryTile = tile.id
  clone.traverse(child => {
    child.matrixAutoUpdate = false
    child.updateMatrix()
  })
  clone.updateMatrix()
  return clone
}

const mapWithConcurrency = async <Input, Output>(
  items: ReadonlyArray<Input>,
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
): Promise<ReadonlyArray<Output>> => {
  const results: Output[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index]!, index)
    }
  }
  const workers: Promise<void>[] = []
  for (let index = 0; index < workerCount; index += 1) workers.push(runWorker())
  await Promise.all(workers)
  return results
}

export const createDroneMapWorldGroup = async (
  snapshot: DroneMapWorldSnapshot,
  terrain?: DroneTerrainModel,
): Promise<THREE.Group> => {
  const group = createAtmosphericBaseWorldGroup(snapshot.radiusM, terrain)
  const loadedTiles = await mapWithConcurrency(snapshot.tiles, tileLoadConcurrency, async tile => {
    const template = await tileTemplateFor(tile)
    return cloneTileForWorld(template, tile, terrain)
  })
  for (const tile of loadedTiles) group.add(tile)
  group.traverse(child => {
    child.matrixAutoUpdate = false
    child.updateMatrix()
  })
  group.userData.worldSummary = {
    key: snapshot.key,
    tileCount: snapshot.tileCount,
    coverage: snapshot.coverage,
    terrain: terrain?.kind ?? 'flat',
    scenerySource: snapshot.scenerySource,
  }
  return group
}

export const tickDroneMapWorldGroup = (
  _group: THREE.Object3D,
  _nowMs: number,
  _viewMode: '2d' | '3d' | 'fpv',
): void => {
  // The scenery asset path is static per tile. Animation remains owned by
  // weather and operational objects so tile materials can stay shared/cached.
}
