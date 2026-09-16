import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { Maximize2, MousePointer2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { createPlateScene } from '@/components/plate-scene'
import { useT } from '@/i18n'
import type { PlateMesh } from '@/lib/api'
import { cn } from '@/lib/utils'

const OBJECT_COLORS = [0x2ec27e, 0x3584e4, 0xf6a03a, 0xa56de2, 0x2cc2c2, 0xe86a92]

/** Hai khối chỉ chạm mép nhau thì vẫn coi là rời; dưới ngưỡng này mới tính là chồng bóng, giống lúc xếp bàn. */
const TOUCH = 0.05

/** Kéo chưa quá ngần này milimét thì coi như tay run, không ghi lại. */
const NUDGE = 0.05

/** Khung bao của mô hình, dùng để đặt camera cho vừa khung nhìn. */
function meshBounds(mesh: PlateMesh) {
  const box = new THREE.Box3()
  for (const object of mesh.objects) {
    box.expandByPoint(new THREE.Vector3(object.bbox[0], object.bbox[1], object.bbox[2]))
    box.expandByPoint(new THREE.Vector3(object.bbox[3], object.bbox[4], object.bbox[5]))
  }
  if (box.isEmpty()) box.expandByPoint(new THREE.Vector3(100, 100, 100))
  return box
}

/**
 * Chi tiết nhỏ hay ăn phẳng vào mặt của khối lớn (chữ nổi trên tấm biển, nút bấm trên vỏ máy).
 * Hai mặt cùng một độ cao thì bộ đệm chiều sâu tranh nhau và mặt chữ lốm đốm như răng cưa,
 * nên đẩy khối càng to lùi về sau càng nhiều để chi tiết nhỏ luôn thắng.
 */
function depthRank(mesh: PlateMesh) {
  const size = (bbox: number[]) => (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]) * (bbox[5] - bbox[2])
  const order = mesh.objects.map((_object, index) => index).sort((left, right) => size(mesh.objects[right].bbox) - size(mesh.objects[left].bbox))
  const rank = new Array<number>(mesh.objects.length)
  order.forEach((index, at) => {
    rank[index] = order.length - at
  })
  return rank
}

/**
 * Nhóm các khối chồng bóng nhau trên mặt bàn lại với nhau.
 * Biển tên có phần nền và chữ nổi là hai vật thể riêng trong file, kéo lẻ một cái là hỏng mô hình.
 */
function clusterOf(mesh: PlateMesh) {
  const parent = mesh.objects.map((_object, index) => index)
  const find = (item: number): number => {
    let node = item
    while (parent[node] !== node) {
      parent[node] = parent[parent[node]]
      node = parent[node]
    }
    return node
  }
  for (let left = 0; left < mesh.objects.length; left += 1) {
    for (let right = left + 1; right < mesh.objects.length; right += 1) {
      const a = mesh.objects[left].bbox
      const b = mesh.objects[right].bbox
      if (a[3] - b[0] <= TOUCH || b[3] - a[0] <= TOUCH || a[4] - b[1] <= TOUCH || b[4] - a[1] <= TOUCH) continue
      parent[find(right)] = find(left)
    }
  }
  return mesh.objects.map((_object, index) => find(index))
}

function outsideBed(mesh: PlateMesh, bbox: number[]) {
  const bed = mesh.bed
  if (!bed) return false
  return bbox[0] < bed.minX - 0.01 || bbox[1] < bed.minY - 0.01 || bbox[3] > bed.maxX + 0.01 || bbox[4] > bed.maxY + 0.01
}

/**
 * Khung xem mô hình 3D đặt đúng chỗ trên bàn in: toạ độ giữ nguyên hệ của máy (Z hướng lên),
 * mesh đã được máy chủ nhân sẵn ma trận của build item nên chỉ việc dựng lên là đúng vị trí.
 */
export default function PlateView3D({
  mesh,
  selected,
  onSelect,
  onMove,
  className,
}: {
  mesh: PlateMesh
  selected: number | null
  onSelect?: (index: number | null) => void
  onMove?: (moves: { item: number; dx: number; dy: number }[]) => void
  className?: string
}) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ frame: (top: boolean) => void; select: (index: number | null) => void } | null>(null)
  const pick = useRef<((index: number | null) => void) | null>(null)
  const drop = useRef<typeof onMove>(undefined)

  useEffect(() => {
    pick.current = onSelect ?? null
  }, [onSelect])

  useEffect(() => {
    drop.current = onMove
  }, [onMove])

  useEffect(() => {
    const container = host.current
    if (!container) return

    const view = createPlateScene(container, mesh.bed, meshBounds(mesh))
    const { scene, camera, controls, renderer, palette, invalidate } = view

    const solids: THREE.Mesh[] = []
    const rank = depthRank(mesh)
    mesh.objects.forEach((object, index) => {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(object.positions, 3))
      geometry.setIndex(new THREE.BufferAttribute(object.indices, 1))
      geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({
        color: outsideBed(mesh, object.bbox) ? palette.outside : OBJECT_COLORS[index % OBJECT_COLORS.length],
        // Mô hình in ấn nhiều cạnh sắc, tô phẳng cho thấy rõ từng mặt như phần mềm CAD.
        flatShading: true,
        roughness: 0.62,
        metalness: 0.04,
        polygonOffset: true,
        // Chỉ lệch theo `units` (vài nấc nhỏ nhất của bộ đệm chiều sâu). `factor` nhân theo độ dốc bề mặt
        // nên ở góc nhìn nghiêng nó đẩy mặt nền lùi hẳn ra sau, hở cả thành bên của chữ vốn nằm chìm trong nền.
        polygonOffsetFactor: 0,
        polygonOffsetUnits: rank[index],
      })
      const solid = new THREE.Mesh(geometry, material)
      solid.userData.index = index
      scene.add(solid)
      solids.push(solid)
    })

    const select = (index: number | null) => {
      for (const item of solids) {
        const material = item.material as THREE.MeshStandardMaterial
        const isSelected = index !== null && item.userData.index === index
        const solid = index === null || isSelected
        material.emissive.setHex(isSelected ? 0xffffff : 0x000000)
        material.emissiveIntensity = isSelected ? 0.28 : 0
        material.opacity = solid ? 1 : 0.22
        // Bật/tắt trong suốt sau khi vật liệu đã dịch thì phải báo three dịch lại shader.
        if (material.transparent !== !solid) {
          material.transparent = !solid
          material.needsUpdate = true
        }
      }
      invalidate()
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const surface = new THREE.Plane()
    const spot = new THREE.Vector3()
    const cluster = clusterOf(mesh)
    let downAt = { x: 0, y: 0 }
    let drag: { group: THREE.Mesh[]; from: THREE.Vector3; limit: { minX: number; maxX: number; minY: number; maxY: number } | null } | null = null

    const aim = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
    }

    /** Khoảng dời tối đa của cả cụm để không có khối nào lòi ra khỏi lòng bàn. */
    const bounds = (group: THREE.Mesh[]) => {
      const bed = mesh.bed
      if (!bed) return null
      let minX = -Infinity
      let maxX = Infinity
      let minY = -Infinity
      let maxY = Infinity
      for (const item of group) {
        const bbox = mesh.objects[item.userData.index as number].bbox
        minX = Math.max(minX, bed.minX - bbox[0])
        maxX = Math.min(maxX, bed.maxX - bbox[3])
        minY = Math.max(minY, bed.minY - bbox[1])
        maxY = Math.min(maxY, bed.maxY - bbox[4])
      }
      return { minX, maxX, minY, maxY }
    }

    const onPointerDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY }
      if (!drop.current || event.button !== 0) return
      aim(event)
      const hit = raycaster.intersectObjects(solids, false)[0]
      if (!hit) return
      const root = cluster[hit.object.userData.index as number]
      const group = solids.filter((item) => cluster[item.userData.index as number] === root)
      // Kéo trên mặt phẳng ngang đi qua đúng điểm vừa bấm, nên vật bám theo con trỏ chứ không trượt đi.
      surface.set(new THREE.Vector3(0, 0, 1), -hit.point.z)
      drag = { group, from: hit.point.clone(), limit: bounds(group) }
      controls.enabled = false
      renderer.domElement.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return
      aim(event)
      if (!raycaster.ray.intersectPlane(surface, spot)) return
      let dx = spot.x - drag.from.x
      let dy = spot.y - drag.from.y
      if (drag.limit) {
        dx = Math.min(drag.limit.maxX, Math.max(drag.limit.minX, dx))
        dy = Math.min(drag.limit.maxY, Math.max(drag.limit.minY, dy))
      }
      for (const item of drag.group) item.position.set(dx, dy, 0)
      invalidate()
    }

    const onPointerUp = (event: PointerEvent) => {
      if (drag) {
        const moving = drag
        drag = null
        controls.enabled = true
        if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
        const { x, y } = moving.group[0].position
        if (Math.hypot(x, y) > NUDGE) {
          for (const item of moving.group) {
            const bbox = mesh.objects[item.userData.index as number].bbox
            bbox[0] += x
            bbox[3] += x
            bbox[1] += y
            bbox[4] += y
          }
          // Mesh đã đứng đúng chỗ mới rồi, gộp phần dời vào toạ độ gốc để lần kéo sau lại tính từ số không.
          for (const item of moving.group) {
            item.geometry.translate(x, y, 0)
            item.position.set(0, 0, 0)
            const index = item.userData.index as number
            const material = item.material as THREE.MeshStandardMaterial
            material.color.setHex(outsideBed(mesh, mesh.objects[index].bbox) ? palette.outside : OBJECT_COLORS[index % OBJECT_COLORS.length])
          }
          invalidate()
          drop.current?.(moving.group.map((item) => ({ item: mesh.objects[item.userData.index as number].item, dx: x, dy: y })))
          return
        }
      }
      if (!pick.current) return
      if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) return
      aim(event)
      const hit = raycaster.intersectObjects(solids, false)[0]
      pick.current(hit ? (hit.object.userData.index as number) : null)
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)

    view.frame(false)
    api.current = { frame: view.frame, select }

    return () => {
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      view.dispose()
      api.current = null
    }
  }, [mesh])

  useEffect(() => {
    api.current?.select(selected)
  }, [mesh, selected])

  return (
    <div className="relative">
      <div ref={host} className={cn('bg-card relative h-[52vh] min-h-60 w-full overflow-hidden rounded-lg border', className)} />
      <div className="absolute top-2 right-2 flex gap-1">
        <Button size="xs" variant="outline" onClick={() => api.current?.frame(false)}>
          <Maximize2 /> {t('plate.view_fit')}
        </Button>
        <Button size="xs" variant="outline" onClick={() => api.current?.frame(true)}>
          {t('plate.view_top')}
        </Button>
      </div>
      <div className="text-muted-foreground pointer-events-none absolute bottom-2 left-3 flex items-center gap-1.5 text-[11px]">
        <MousePointer2 className="size-3" /> {onMove ? t('plate.drag_hint') : t('plate.view_hint')}
      </div>
    </div>
  )
}
