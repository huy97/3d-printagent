import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** Bed, grid, camera and render loop shared by the model view and the toolpath view. */

const MINOR = 10
const MAJOR = 50

/** Below 40 fps the drag already feels sticky; only after this many consecutive frames do we call the device too slow. */
const SLOW_FRAME_MS = 25
const SLOW_FRAMES = 5

export type Palette = { bed: number; grid: number; major: number; edge: number; outside: number; sky: number; ground: number }

export const DARK: Palette = { bed: 0x1a1a1d, grid: 0x2c2c31, major: 0x44444c, edge: 0x5a5a64, outside: 0xe05252, sky: 0xdfe4ef, ground: 0x2a2a30 }
export const LIGHT: Palette = { bed: 0xececed, grid: 0xdadade, major: 0xbcbcc4, edge: 0x9a9aa4, outside: 0xd23b3b, sky: 0xffffff, ground: 0xc8c8d0 }

export type Bed = { minX: number; minY: number; maxX: number; maxY: number; maxZ: number | null; model: string | null; exclude?: [number, number][] }

/** The bed is not square, so the grid has to be built by hand instead of using GridHelper. */
function gridSegments(minX: number, minY: number, maxX: number, maxY: number, step: number, skipMultiple: number | null) {
  const points: number[] = []
  const push = (value: number, horizontal: boolean) => {
    if (skipMultiple && Math.abs(value % skipMultiple) < 1e-6) return
    if (horizontal) points.push(minX, value, 0, maxX, value, 0)
    else points.push(value, minY, 0, value, maxY, 0)
  }
  for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) push(x, false)
  for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) push(y, true)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  return geometry
}

/**
 * Build the scene in the machine coordinate frame (Z up) and return the control handles.
 * Rendering is on demand rather than a continuous loop, so the drawing buffer must be preserved or the image vanishes on browser recomposite.
 */
export function createPlateScene(container: HTMLElement, bedInput: Bed | null, bounds: THREE.Box3, { lights = true, fitBed = true } = {}) {
  const dark = document.documentElement.classList.contains('dark')
  const palette = dark ? DARK : LIGHT
  const scene = new THREE.Scene()
  const full = Math.min(window.devicePixelRatio, 2)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
  renderer.setPixelRatio(full)
  // CSS makes the canvas fill the container; letting three write pixel widths would grow the container with the canvas in a feedback loop.
  Object.assign(renderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })
  renderer.setSize(container.clientWidth, container.clientHeight || 1, false)
  container.appendChild(renderer.domElement)

  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / (container.clientHeight || 1), 1, 20000)
  camera.up.set(0, 0, 1)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false
  controls.maxPolarAngle = Math.PI / 2
  controls.rotateSpeed = 0.8

  if (lights) {
    scene.add(new THREE.HemisphereLight(palette.sky, palette.ground, dark ? 2.1 : 2.4))
    const key = new THREE.DirectionalLight(0xffffff, dark ? 1.5 : 1.8)
    key.position.set(0.6, -1, 1.4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.55)
    fill.position.set(-1, 0.8, 0.5)
    scene.add(fill)
  }

  const bed: Bed = bedInput ?? {
    minX: bounds.min.x - 20,
    minY: bounds.min.y - 20,
    maxX: bounds.max.x + 20,
    maxY: bounds.max.y + 20,
    maxZ: null,
    model: null,
    exclude: [],
  }
  const width = bed.maxX - bed.minX
  const height = bed.maxY - bed.minY
  // Framing the whole bed shows where the object sits; framing the object alone shows its detail.
  if (fitBed) {
    bounds.expandByPoint(new THREE.Vector3(bed.minX, bed.minY, 0))
    bounds.expandByPoint(new THREE.Vector3(bed.maxX, bed.maxY, 0))
  }

  const plate = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: palette.bed }))
  plate.position.set(bed.minX + width / 2, bed.minY + height / 2, -0.25)
  scene.add(plate)

  const minor = new THREE.LineSegments(gridSegments(bed.minX, bed.minY, bed.maxX, bed.maxY, MINOR, MAJOR), new THREE.LineBasicMaterial({ color: palette.grid }))
  minor.position.z = -0.15
  scene.add(minor)
  const major = new THREE.LineSegments(gridSegments(bed.minX, bed.minY, bed.maxX, bed.maxY, MAJOR, null), new THREE.LineBasicMaterial({ color: palette.major }))
  major.position.z = -0.12
  scene.add(major)

  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(bed.minX, bed.minY, 0),
      new THREE.Vector3(bed.maxX, bed.minY, 0),
      new THREE.Vector3(bed.maxX, bed.maxY, 0),
      new THREE.Vector3(bed.minX, bed.maxY, 0),
    ]),
    new THREE.LineBasicMaterial({ color: palette.edge }),
  )
  outline.position.z = -0.1
  scene.add(outline)

  // Machine origin, drawn like the slicer does so X and Y are obvious.
  const axisLength = Math.max(15, Math.min(width, height) / 8)
  for (const [color, end] of [
    [0xd94b4b, new THREE.Vector3(bed.minX + axisLength, bed.minY, 0)],
    [0x4bab5a, new THREE.Vector3(bed.minX, bed.minY + axisLength, 0)],
  ] as const) {
    const axis = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(bed.minX, bed.minY, 0), end]),
      new THREE.LineBasicMaterial({ color }),
    )
    axis.position.z = -0.05
    scene.add(axis)
  }

  if (bedInput?.exclude && bedInput.exclude.length > 2) {
    const shape = new THREE.Shape(bedInput.exclude.map(([x, y]) => new THREE.Vector2(x, y)))
    const zone = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: palette.outside, transparent: true, opacity: 0.18 }))
    zone.position.z = -0.08
    scene.add(zone)
  }

  let frameHandle = 0
  let ratio = full
  // Only devices that cannot keep up get a resolution drop while dragging, and only after measuring that they are genuinely slow.
  let eased = full
  let dragging = false
  let previous = 0
  let slow = 0

  const resize = (next: number) => {
    if (next === ratio) return
    ratio = next
    const box = container.getBoundingClientRect()
    renderer.setPixelRatio(next)
    renderer.setSize(Math.max(1, box.width), Math.max(1, box.height), false)
  }

  const draw = (time: number) => {
    frameHandle = 0
    if (dragging && previous > 0) {
      slow = Math.max(0, slow + (time - previous > SLOW_FRAME_MS ? 1 : -1))
      if (slow >= SLOW_FRAMES && eased > 1) {
        eased = Math.max(1, eased - 0.5)
        slow = 0
        resize(eased)
      }
    }
    previous = time
    renderer.render(scene, camera)
  }
  const invalidate = () => {
    if (!frameHandle) frameHandle = requestAnimationFrame(draw)
  }
  controls.addEventListener('change', invalidate)

  const startDrag = () => {
    dragging = true
    previous = 0
    resize(eased)
  }
  // On release, redraw at full display resolution so the still image is always sharp.
  const endDrag = () => {
    dragging = false
    previous = 0
    resize(full)
    invalidate()
  }
  controls.addEventListener('start', startDrag)
  controls.addEventListener('end', endDrag)

  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((bit) =>
    new THREE.Vector3(bit & 1 ? bounds.max.x : bounds.min.x, bit & 2 ? bounds.max.y : bounds.min.y, bit & 4 ? bounds.max.z : bounds.min.z),
  )

  const frame = (top: boolean) => {
    const sphere = bounds.getBoundingSphere(new THREE.Sphere())
    const direction = (top ? new THREE.Vector3(0, -0.001, 1) : new THREE.Vector3(0.35, -0.85, 0.52)).normalize()
    controls.target.copy(sphere.center)
    camera.near = Math.max(0.5, sphere.radius / 100)
    camera.far = sphere.radius * 40
    // The bounding sphere is always wider than the actual body, so shrink the distance iteratively using the projection of the eight corners for a tight fit.
    let distance = sphere.radius / Math.sin(Math.min((camera.fov * Math.PI) / 360, Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect)))
    for (let step = 0; step < 4; step += 1) {
      camera.position.copy(sphere.center).addScaledVector(direction, distance)
      camera.lookAt(sphere.center)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld()
      let extent = 0
      for (const corner of corners) {
        const ndc = corner.clone().project(camera)
        extent = Math.max(extent, Math.abs(ndc.x), Math.abs(ndc.y))
      }
      if (!Number.isFinite(extent) || extent <= 0) break
      distance *= extent / 0.92
    }
    camera.position.copy(sphere.center).addScaledVector(direction, distance)
    camera.updateProjectionMatrix()
    controls.update()
    invalidate()
  }

  const observer = new ResizeObserver(() => {
    const box = container.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return
    renderer.setSize(box.width, box.height, false)
    camera.aspect = box.width / box.height
    camera.updateProjectionMatrix()
    invalidate()
  })
  observer.observe(container)

  const dispose = () => {
    observer.disconnect()
    if (frameHandle) cancelAnimationFrame(frameHandle)
    controls.removeEventListener('change', invalidate)
    controls.removeEventListener('start', startDrag)
    controls.removeEventListener('end', endDrag)
    controls.dispose()
    scene.traverse((item) => {
      const target = item as THREE.Mesh
      target.geometry?.dispose()
      const material = target.material
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material?.dispose()
    })
    renderer.dispose()
    // Browsers allow only a few dozen live WebGL contexts; browsing through many files without releasing them kills the older scenes.
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }

  return { scene, camera, controls, renderer, palette, bed, invalidate, frame, dispose }
}
