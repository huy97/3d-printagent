import { getLocale } from '@/i18n/locale'

export type PrinterState =
  | 'offline'
  | 'connecting'
  | 'idle'
  | 'busy'
  | 'printing'
  | 'paused'
  | 'finished'
  | 'cancelled'
  | 'error'

export type Capability =
  | 'files'
  | 'upload'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'gcode'
  | 'temperature'
  | 'home'
  | 'jog'
  | 'fan'
  | 'speed'
  | 'light'
  | 'filament'
  | 'camera'
  | 'cameraStream'
  | 'emergencyStop'
  | 'connect'
  | 'calibrate'

export const CALIBRATION_OPTIONS = [
  'bedLeveling',
  'highTempBed',
  'bedScrews',
  'vibration',
  'motorNoise',
  'nozzleOffset',
  'lidar',
  'nozzleClump',
] as const

export type CalibrationOption = (typeof CALIBRATION_OPTIONS)[number]

export type FileFormat = 'gcode' | 'bgcode' | '3mf' | 'model'

export interface Temperature {
  actual: number
  target: number | null
}

export interface AmsTray {
  id: string
  type: string | null
  color: string | null
  remain: number | null
}

export interface PrinterStatus {
  online: boolean
  state: PrinterState
  message: string | null
  temps: { nozzle: Temperature | null; bed: Temperature | null; chamber: Temperature | null }
  job: {
    file: string | null
    progress: number | null
    elapsed: number | null
    remaining: number | null
    layer: number | null
    totalLayers: number | null
    stage?: string | null
  } | null
  fanSpeed: number | null
  speedFactor: number | null
  position: { x: number | null; y: number | null; z: number | null } | null
  light: boolean | null
  firmware: string | null
  extra: {
    ams?: { id: number; humidity: string | null; temp: string | null; trays: AmsTray[] }[]
    amsActiveTray?: string | null
    externalSpool?: { type: string | null; color: string | null } | null
    hms?: HmsAlert[]
    wifi?: string | null
    calibration?: { stage: string | null; step: number | null; steps: number | null; remaining: number | null } | null
    [key: string]: unknown
  }
  updatedAt: string | null
}

export interface HmsAlert {
  code: string
  severity: 'fatal' | 'serious' | 'common' | 'info' | null
  text: string | null
}

export interface PrinterDiagnosis {
  printerId: string
  summary: string
  causes: string[]
  steps: string[]
  severity: 'info' | 'warning' | 'critical'
  model: string
}

export const INSPECT_VERDICTS = ['ok', 'suspect', 'failed', 'unclear'] as const
export type InspectVerdict = (typeof INSPECT_VERDICTS)[number]

export interface PrintInspection {
  printerId: string
  verdict: InspectVerdict
  issue: string
  confidence: number
  summary: string
  advice: string[]
  job: string | null
  layer: number | null
  model: string
  at: string
}

export interface WatchStatus {
  enabled: boolean
  running: boolean
  ready: boolean
  intervalMin: number
  onDetect: 'notify' | 'pause'
  autoDiagnose: boolean
}

export interface PrintReviewFinding {
  title: string
  detail: string | null
  severity: 'info' | 'warning' | 'critical'
  advice: string | null
  source: 'rule' | 'ai'
}

export interface PrintReview {
  fileId: string
  printerId: string | null
  plate: number
  verdict: 'ok' | 'warning' | 'risky'
  summary: string
  findings: PrintReviewFinding[]
  footprint: { areaMm2: number; width: number; depth: number; height: number | null } | null
  model: string
  at: string
}

export type PrintChoice = 'auto' | 'on' | 'off'

export interface Printer {
  id: string
  name: string
  driver: string
  driverLabel: string
  enabled: boolean
  connection: Record<string, string | number | boolean | null>
  notes: string
  autoStartQueue: boolean
  bedClear: boolean
  powerW: number | null
  hourlyCost: number | null
  slicer: SlicerDefaults | null
  formats: FileFormat[]
  capabilities: Record<Capability, boolean>
  calibrations: CalibrationOption[]
  printChoices: Partial<Record<'bedLeveling' | 'flowCalibration', PrintChoice[]>> | null
  status: PrinterStatus
  createdAt: string
  updatedAt: string
}

export interface SlicerDefaults {
  machine: string | null
  process: string | null
  filament: string | null
}

export interface SlicerStatus {
  available: boolean
  bin: string | null
  kind: 'orca' | 'bambu' | null
  profilesDir: string | null
  userProfilesDir: string | null
  vendors: string[]
  machines: number
  advisor: { available: boolean; model: string }
}

export interface SliceChatMessage {
  id: string
  createdAt: string
  role: 'user' | 'assistant'
  text: string
  suggestion: {
    options: SliceOptions
    before: SliceOptions
    reason: string
    extra?: Record<string, string | null>
    profiles?: { process?: string; filament?: string }
  } | null
  actions?: SliceChatAction[]
  appliedVersion: { id: string; number: number } | null
  sliceId: string | null
  model: string | null
}

export interface SliceChatAction {
  tool: string
  params: Record<string, string | number | null>
  error?: boolean
}

export interface SliceVersion {
  id: string
  createdAt: string
  number: number
  source: 'ai' | 'slice' | 'manual'
  machine: string | null
  process: string | null
  filament: string | null
  options: SliceOptions
  extra: Record<string, string>
  sliceId: string | null
  messageId: string | null
}

export interface SlicePreset {
  id: string
  createdAt: string
  updatedAt: string
  name: string
  description: string | null
  machine: string | null
  process: string | null
  filament: string | null
  options: SliceOptions
  extra: Record<string, string>
}

export interface SliceChat {
  fileId: string
  messages: SliceChatMessage[]
  versions: SliceVersion[]
  presets: SlicePreset[]
}

export interface SliceSnapshot {
  machine: string
  process?: string
  filament?: string
  options: SliceOptions
  extra: Record<string, string | number | boolean>
}

export interface SliceChatContext {
  printerId: string
  machine: string
  process?: string
  filament?: string
  options: SliceOptions
  sliceId?: string
}

export interface SlicerMachine {
  name: string
  vendor: string
  printerModel: string | null
  nozzle: number | null
  defaultProcess: string | null
  defaultFilament: string | null
}

export interface SlicerProfiles {
  vendors: string[]
  machines: SlicerMachine[]
  suggestedMachines: string[]
  processes: { name: string; vendor: string }[]
  filaments: { name: string; vendor: string; filamentType: string | null }[]
  defaults: { process: string | null; filament: string | null } | null
}

export interface SliceOptions {
  layerHeight?: number
  firstLayerHeight?: number
  seam?: string
  ironing?: string
  wallLoops?: number
  topLayers?: number
  bottomLayers?: number
  infill?: number
  infillPattern?: string
  outerWallSpeed?: number
  innerWallSpeed?: number
  infillSpeed?: number
  support?: boolean
  supportType?: string
  supportThreshold?: number
  nozzleTemp?: number
  bedTemp?: number
  brim?: string
  brimWidth?: number
  spiralMode?: boolean
  scale?: number
  rotate?: number
  copies?: number
  arrange?: boolean
  allowRotations?: boolean
  alternateExtraWall?: boolean
  embedWallIntoInfill?: boolean
  detectThinWall?: boolean
  ensureVerticalShell?: string
  detectFloatingShell?: boolean
  topSurfacePattern?: string
  topSurfaceDensity?: number
  topShellThickness?: number
  topPaintLayers?: number
  subTopSurfacePattern?: string
  bottomSurfacePattern?: string
  bottomSurfaceDensity?: number
  bottomShellThickness?: number
  bottomPaintLayers?: number
  solidInfillPattern?: string
  fillMultiline?: number
  infillAnchor?: string
  infillAnchorMax?: string
  infillWallOverlap?: number
  infillDirection?: number
  bridgeAngle?: number
  minSparseInfillArea?: number
  infillCombination?: boolean
  detectNarrowSolidInfill?: boolean
  extra?: Record<string, string | number | boolean>
}

export interface PlateBed {
  minX: number
  minY: number
  maxX: number
  maxY: number
  maxZ: number | null
  model: string | null
  exclude: [number, number][]
}

export interface PlateObject {
  name: string | null
  bbox: [number, number, number, number]
  area: number | null
}

export interface PlateLayout {
  fileId: string
  name: string
  plate: number
  plates: number[]
  bed: PlateBed | null
  bounds: [number, number, number, number] | null
  objects: PlateObject[]
  hasImage: boolean
}

export interface MeshObject {
  /** Số thứ tự của build item trong 3MF, dùng để báo cho máy chủ biết vật nào vừa được kéo đi. */
  item: number
  name: string | null
  triangles: number
  bbox: [number, number, number, number, number, number]
  positions: Float32Array
  indices: Uint32Array
}

export interface PlateMesh {
  plate: number
  plates: number[]
  bed: PlateBed | null
  dropped: number
  objects: MeshObject[]
}

export interface ToolpathLayer {
  z: number
  point: number
}

export interface PlateToolpath {
  plate: number
  plates: number[]
  bed: PlateBed | null
  features: string[]
  layers: ToolpathLayer[]
  points: number
  truncated: boolean
  bbox: [number, number, number, number, number, number] | null
  positions: Float32Array
  feature: Uint8Array
  layer: Uint16Array
}

export interface SplitPart {
  name: string
  triangles: number
  size: { x: number; y: number; z: number }
  volumeCm3: number
}

export interface SplitResult {
  file: LibraryFile
  sourceId: string
  parts: SplitPart[]
}

export interface ArrangeResult extends SplitResult {
  clusters: number
  overflow: number
}

export interface SliceSettings {
  fileId: string
  machine: string | null
  process: string | null
  filament: string | null
  options: SliceOptions
  extra: Record<string, string>
}

export interface SliceResult {
  file: LibraryFile
  sourceId: string
  printerId: string
  machine: string
  process: string
  filament: string
  durationMs: number
  stats: {
    estimatedTime: number | null
    filamentWeightG: number | null
    layerHeight: number | null
    infill: number | null
    warning: string | null
  } | null
}

export interface PrinterSummary {
  total: number
  online: number
  states: Record<string, number>
}

export interface DriverField {
  key: string
  type: 'text' | 'number' | 'password' | 'boolean' | 'select'
  required?: boolean
  secret?: boolean
  advanced?: boolean
  placeholder?: string
  default?: string | number | boolean
  min?: number
  max?: number
  options?: { value: string; label: string }[]
}

export interface DriverInfo {
  id: string
  label: string
  formats: FileFormat[]
  fields: DriverField[]
  defaults: Record<string, unknown>
  capabilities: Record<Capability, boolean>
}

export interface PrinterInput {
  name: string
  driver: string
  enabled?: boolean
  connection: Record<string, unknown>
  notes?: string
  autoStartQueue?: boolean
  powerW?: number | null
  hourlyCost?: number | null
  slicer?: SlicerDefaults | null
}

export interface DiscoveredPrinter {
  driver: string
  host: string
  port: number | null
  name: string
  connection: Record<string, unknown>
  source: string
  details: Record<string, unknown>
}

export interface DetectResult {
  host: string
  candidates: { driver: string; confidence: 'high' | 'medium' | 'low'; connection: Record<string, unknown>; details: Record<string, unknown> }[]
}

export interface PrinterFile {
  name: string
  path: string
  size: number | null
  modifiedAt: string | null
  estimatedTime: number | null
}

export interface HistorySample {
  t: number
  n: number | null
  nt: number | null
  b: number | null
  bt: number | null
  c: number | null
  f?: number | null
  s?: number | null
  p?: number | null
  l?: number | null
}

export interface HistoryResult {
  from: number
  to: number
  bucketMs: number
  samples: HistorySample[]
}

export interface Plate {
  index: number
  estimatedTime: number | null
  weightG: number | null
  filaments: { id: number; type: string | null; color: string | null; usedG: number | null }[]
  gcode: string
}

export interface FileMeta {
  format: FileFormat
  slicer?: string | null
  estimatedTime?: number | null
  filamentLengthMm?: number | null
  filamentWeightG?: number | null
  filamentType?: string | null
  layerHeight?: number | null
  nozzleDiameter?: number | null
  layerCount?: number | null
  printerModel?: string | null
  nozzleTemp?: number | null
  bedTemp?: number | null
  maxZ?: number | null
  sliced?: boolean
  triangles?: number | null
  size?: { x: number; y: number; z: number } | null
  volumeCm3?: number | null
  overhangRatio?: number | null
  plates?: Plate[]
  parseError?: string
}

export interface LibraryFile {
  id: string
  name: string
  size: number
  format: FileFormat
  meta: FileMeta
  hasThumbnail: boolean
  origin: string
  /** File gốc đã sinh ra file này khi cắt lát hoặc tách vật thể; null nghĩa là người dùng tự đưa vào. */
  sourceId: string | null
  uploadedAt: string
  updatedAt?: string
  lastPrintedAt: string | null
  printCount: number
  sha256?: string | null
  slice?: { machine: string | null; process: string | null; filament: string | null } | null
  sources?: { fileId: string; name: string; copies: number }[] | null
  /** Upload trùng nội dung với file đã có thì server trả lại file cũ kèm cờ này. */
  duplicate?: boolean
}

export type JobStatus = 'queued' | 'uploading' | 'starting' | 'printing' | 'paused' | 'completed' | 'failed' | 'canceled'

export interface PrintOptions {
  plate?: number
  useAms?: boolean
  amsMapping?: number[]
  timelapse?: boolean
  bedLeveling?: boolean | 'auto'
  flowCalibration?: boolean | 'auto'
}

export interface BatchResult {
  batch: string
  started: number
  jobs: Job[]
  skipped: { printerId: string; printerName: string; reason: string | null; message: string }[]
}

export interface Job {
  id: string
  /** null khi job nằm ở hàng đợi chung và chưa được giao máy. */
  printerId: string | null
  printerName: string | null
  target?: { any: boolean; printerIds: string[] | null } | null
  batch?: { id: string; index: number; total: number } | null
  priority?: number
  position?: number
  adjustedTime?: number | null
  forecast?: { startAt: string | null; finishAt: string; printerId: string }
  material?: JobMaterial | null
  cost?: CostBreakdown | null
  fileId: string | null
  fileName: string
  format: FileFormat | null
  remoteName: string | null
  status: JobStatus
  progress: number | null
  layer: number | null
  totalLayers: number | null
  remaining: number | null
  elapsed?: number | null
  stage?: string | null
  estimatedTime: number | null
  upload: { sent: number; total: number } | null
  options: PrintOptions
  origin: string
  note: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface QueueStats {
  total: number
  queued: number
  queuedAny?: number
  active: number
  counts: Record<string, number>
}

export interface CostBreakdown {
  filament: number
  electricity: number
  wear: number
  total: number
  currency: string
  powerW?: number
}

export interface MaterialGroups {
  model: number
  support: number
  adhesion: number
  purge: number
}

export interface JobMaterial {
  usedG: number
  productG: number
  wasteG: number
  failedG: number
  grams: MaterialGroups
  material: string | null
  estimated: boolean
  spools: { spoolId: string; name: string; grams: number; remainingG: number }[]
}

export interface MaterialAnalysis {
  plate: number
  totalMm?: number
  totalG: number
  grams: MaterialGroups
  productG: number
  wasteG: number
  tools: { tool: number; type: string | null; color: string | null; mm?: number; grams: number }[]
  layerCount: number | null
  material: string | null
  estimated?: boolean
}

export interface Spool {
  id: string
  name: string
  material: string
  color: string | null
  brand: string | null
  diameter: number
  density: number
  pricePerKg: number | null
  totalG: number
  remainingG: number
  lowG: number
  printerId: string | null
  printerName: string | null
  slot: number | null
  notes: string | null
  remainingPercent: number | null
  low: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export type SpoolInput = Partial<Omit<Spool, 'id' | 'density' | 'printerName' | 'remainingPercent' | 'low' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>> & {
  density?: number | null
}

export interface PreflightWarning {
  code: 'spool_low' | 'material_mismatch' | 'spool_unassigned'
  tool: number
  spool?: string
  needG?: number
  remainingG?: number
  file?: string
  loaded?: string
  slot?: number
}

export interface Preflight {
  fileId: string
  printerId: string | null
  plate: number | null
  material: MaterialAnalysis | null
  estimate: { estimatedTime: number | null; adjustedTime: number | null; factor: number; samples: number; basis: string; finishAt: string | null }
  spools: {
    tool: number
    slot: number
    type: string | null
    color: string | null
    needG: number
    spoolId: string | null
    spoolName: string | null
    spoolColor: string | null
    material: string | null
    remainingG: number | null
    enough: boolean | null
    materialMatch: boolean | null
  }[]
  cost: CostBreakdown
  warnings: PreflightWarning[]
  matchingPrinters: string[] | null
}

export interface StatsBucket {
  key: string
  label: string
  jobs: number
  completed: number
  failed: number
  canceled: number
  printSeconds: number
  usedG: number
  productG: number
  wasteG: number
  waste: { support: number; adhesion: number; purge: number; failed: number }
  cost: { filament: number; electricity: number; wear: number; total: number }
  successRate: number | null
  wasteRate: number | null
}

export interface MaintenanceTask {
  id: string
  printerId: string
  key: string | null
  name: string
  custom: boolean
  intervalHours: number
  usedHours: number
  remainingHours: number
  percent: number
  due: boolean
  doneAt: string | null
  createdAt: string
  printerName?: string
}

export interface PrintStats {
  from: string | null
  to: string
  days: number
  currency: string
  totals: Omit<StatsBucket, 'key' | 'label'>
  printers: (StatsBucket & { estimate: { factor: number; samples: number; basis: string } })[]
  files: StatsBucket[]
  materials: StatsBucket[]
  processes: StatsBucket[]
  origins: StatsBucket[]
  daily: { date: string; completed: number; failed: number; canceled: number; usedG: number; wasteG: number }[]
  recentFailures: { jobId: string; printerName: string; fileName: string; error: string | null; finishedAt: string }[]
  maintenanceDue: MaintenanceTask[]
}

export interface MaintenanceInfo {
  printerId: string
  usage: { printSeconds: number; printHours: number; jobs: number; usedG: number }
  tasks: MaintenanceTask[]
}

export interface OrientMetrics {
  supportCm3: number
  contactCm2: number
  heightMm: number
}

export interface OrientResult {
  file: LibraryFile
  sourceId: string
  changed: boolean
  before: OrientMetrics
  after: OrientMetrics
}

export interface CombineResult {
  file: LibraryFile
  parts: { name: string }[]
  placed: number
  overflow: number
  overflowNames: string[]
}

export type CostSettings = { currency: string; electricityPerKwh: number; defaultPowerW: number; defaultPricePerKg: number }

export interface Health {
  ok: boolean
  agent?: { name: string; id: string; locale: string }
  version?: string
  uptimeSeconds?: number
  platform?: string
  node?: string
  printers?: PrinterSummary
  queue?: QueueStats
  library?: { total: number; bytes: number }
  tunnel?: { status: string; url: string | null }
}

export interface PromptDoc {
  name: string
  text: string
  default: string
  custom: boolean
}

export interface ApiKey {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  preview?: string
  key?: string
}

export const NOTIFY_EVENTS = ['completed', 'failed', 'canceled'] as const

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]

export const AI_AUTH_TYPES = ['api_key', 'auth_token'] as const

export type AiAuthType = (typeof AI_AUTH_TYPES)[number]

export interface AgentConfig {
  local: boolean
  agent: { name: string; id: string; locale: string }
  server: { host: string; port: number; corsOrigins: string[] }
  auth: { enabled: boolean; allowLocalhostWithoutKey: boolean; apiKeys: ApiKey[] }
  files: {
    maxUploadMb: number
    allowRemoteUrl: boolean
    allowPrivateNetworkUrl: boolean
    allowLocalFilePath: boolean
    allowedFileRoots: string[]
  }
  queue: { keepJobs: number }
  costs: CostSettings
  safety: {
    allowGcode: boolean
    blockedGcodes: string[]
    maxNozzleTemp: number
    maxBedTemp: number
    maxChamberTemp: number
    maxJogMm: number
  }
  monitoring: { pollIntervalMs: number; historyDays: number }
  slicer: { binPath: string | null; profilesDir: string | null; userProfilesDir: string | null; timeoutSec: number }
  ai: { authType: AiAuthType; apiKey: string | null; model: string; baseUrl: string }
  watch: {
    enabled: boolean
    intervalMin: number
    firstLayer: boolean
    minConfidence: number
    onDetect: 'notify' | 'pause'
    autoDiagnose: boolean
  }
  notify: {
    telegram: { enabled: boolean; botToken: string | null; chatId: string | null; events: NotifyEvent[]; includeSnapshot: boolean }
  }
  tunnel: {
    provider: 'none' | 'cloudflare' | 'ngrok'
    autoStart: boolean
    cloudflare: { binPath: string; token: string | null; hostname: string | null }
    ngrok: { binPath: string; authtoken: string | null; domain: string | null; region: string | null }
  }
}

export interface TunnelStatus {
  provider: string | null
  status: string
  url: string | null
  pid: number | null
  error: string | null
  warning?: string | null
  logs: string[]
}

export interface TunnelInfo {
  status: TunnelStatus
  config: AgentConfig['tunnel']
  binaries: Record<string, { installed: boolean; path: string | null; version: string | null; install: string }>
  exposureIssue: string | null
}

export interface ServiceStatus {
  installed: boolean
  running: boolean
  supported: boolean
  manager?: string | null
  unit?: string | null
}

export interface LogEntry {
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
}

export type CommandAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'gcode'
  | 'temperature'
  | 'home'
  | 'jog'
  | 'fan'
  | 'speed'
  | 'light'
  | 'loadFilament'
  | 'unloadFilament'
  | 'emergencyStop'
  | 'connect'
  | 'calibrate'

export class ApiError extends Error {
  status: number
  code?: string
  key?: string
  constructor(message: string, status: number, code?: string, key?: string) {
    super(message)
    this.status = status
    this.code = code
    this.key = key
  }
}

const KEY_STORAGE = 'printagent3d.apiKey'

export const apiKeyStore = {
  get: () => {
    try {
      return localStorage.getItem(KEY_STORAGE) ?? ''
    } catch {
      return ''
    }
  },
  set: (value: string) => localStorage.setItem(KEY_STORAGE, value),
  clear: () => localStorage.removeItem(KEY_STORAGE),
}

interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = new URL(path, location.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }
  return url
}

function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'x-locale': getLocale(), 'x-client': 'web-ui' }
  const apiKey = apiKeyStore.get()
  if (apiKey) headers['x-api-key'] = apiKey
  return headers
}

function parseError(status: number, text: string) {
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; code?: string; key?: string } }
    return new ApiError(payload?.error?.message ?? `HTTP ${status}`, status, payload?.error?.code, payload?.error?.key)
  } catch {
    return new ApiError(`HTTP ${status}`, status)
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = baseHeaders()
  let body: BodyInit | undefined
  if (options.body instanceof FormData) {
    body = options.body
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(buildUrl(path, options.query), { method: options.method ?? 'GET', headers, body })
  const text = await response.text()
  if (!response.ok) throw parseError(response.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

/** Upload qua XHR vì fetch chưa báo được tiến độ gửi. */
export function uploadWithProgress<T>(path: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', buildUrl(path))
    for (const [key, value] of Object.entries(baseHeaders())) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText || '{}') as T)
      else reject(parseError(xhr.status, xhr.responseText))
    }
    xhr.onerror = () => reject(new ApiError('Network error', 0))
    xhr.send(form)
  })
}

const enc = encodeURIComponent

/** Ảnh (thumbnail, camera) cần gắn API key vào query vì thẻ img không gửi được header. */
export function mediaUrl(path: string, query: Record<string, string | number | undefined> = {}) {
  const url = buildUrl(path, query)
  const apiKey = apiKeyStore.get()
  if (apiKey) url.searchParams.set('apiKey', apiKey)
  return url.toString()
}

/**
 * Mesh về dạng nhị phân: 4 byte độ dài phần mô tả JSON, phần mô tả (đệm tròn 4 byte),
 * rồi toạ độ và chỉ số của từng vật thể nối tiếp nhau.
 */
export async function fetchPlateMesh(id: string, plate?: number, machine?: string, version?: string): Promise<PlateMesh> {
  // Mô hình chưa cắt lát không ghi kích thước bàn, gửi kèm máy đang chọn để máy chủ lấy bàn chuẩn của máy đó.
  // `v` chỉ để phá bộ nhớ đệm của trình duyệt sau khi người dùng kéo thả và file được ghi đè.
  const response = await fetch(mediaUrl(`/api/files/${enc(id)}/mesh`, { plate, machine, v: version }), { headers: baseHeaders() })
  if (!response.ok) throw parseError(response.status, await response.text())
  const buffer = await response.arrayBuffer()
  const headerLength = new DataView(buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as Omit<PlateMesh, 'objects'> & {
    objects: (Omit<MeshObject, 'positions' | 'indices'> & { vertexCount: number; indexCount: number })[]
  }
  let at = 4 + Math.ceil(headerLength / 4) * 4
  const objects = header.objects.map((object) => {
    const positions = new Float32Array(buffer, at, object.vertexCount * 3)
    at += positions.byteLength
    const indices = new Uint32Array(buffer, at, object.indexCount)
    at += indices.byteLength
    return { item: object.item, name: object.name, triangles: object.triangles, bbox: object.bbox, positions, indices }
  })
  return { plate: header.plate, plates: header.plates, bed: header.bed, dropped: header.dropped, objects }
}

/**
 * Đường đi vòi phun: cùng khuôn nhị phân với mesh, sau phần mô tả JSON là toạ độ từng điểm,
 * loại đường và số lớp của điểm đó. Mỗi đoạn in là một cặp điểm liên tiếp.
 */
export async function fetchToolpath(id: string, plate?: number): Promise<PlateToolpath> {
  const response = await fetch(mediaUrl(`/api/files/${enc(id)}/toolpath`, { plate }), { headers: baseHeaders() })
  if (!response.ok) throw parseError(response.status, await response.text())
  const buffer = await response.arrayBuffer()
  const headerLength = new DataView(buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLength))) as Omit<
    PlateToolpath,
    'positions' | 'feature' | 'layer'
  >
  let at = 4 + Math.ceil(headerLength / 4) * 4
  const positions = new Float32Array(buffer, at, header.points * 3)
  at += positions.byteLength
  const feature = new Uint8Array(buffer, at, header.points)
  at += feature.byteLength
  // Uint16 đòi địa chỉ chẵn, mà số điểm lẻ thì mảng loại đường đứng trước lại đẩy lệch một byte.
  const layer = at % 2 === 0 ? new Uint16Array(buffer, at, header.points) : new Uint16Array(buffer.slice(at, at + header.points * 2))
  return { ...header, positions, feature, layer }
}

export const api = {
  health: () => request<Health>('/api/health'),
  logs: (limit = 200) => request<{ logs: LogEntry[] }>('/api/logs', { query: { limit } }),

  settings: () => request<AgentConfig>('/api/settings'),
  saveSettings: (patch: unknown) =>
    request<AgentConfig & { rejectedFields?: string[] }>('/api/settings', { method: 'PUT', body: patch }),

  drivers: () => request<{ drivers: DriverInfo[] }>('/api/drivers'),
  printers: () => request<{ printers: Printer[]; summary: PrinterSummary }>('/api/printers'),
  addPrinter: (body: PrinterInput) => request<Printer>('/api/printers', { method: 'POST', body }),
  updatePrinter: (id: string, body: Partial<PrinterInput>) =>
    request<Printer>(`/api/printers/${enc(id)}`, { method: 'PUT', body }),
  removePrinter: (id: string) => request<{ deleted: boolean }>(`/api/printers/${enc(id)}`, { method: 'DELETE' }),
  testPrinter: (body: { id?: string; driver: string; connection: Record<string, unknown> }) =>
    request<{ ok: boolean; state?: string | null; firmware?: string | null }>('/api/printers/test', { method: 'POST', body }),
  detectPrinter: (host: string) => request<DetectResult>('/api/printers/detect', { method: 'POST', body: { host } }),
  discoverPrinters: () => request<{ found: DiscoveredPrinter[] }>('/api/printers/discover'),
  history: (id: string, minutes = 30) => request<HistoryResult>(`/api/printers/${enc(id)}/history`, { query: { minutes } }),
  reconnect: (id: string) => request<Printer>(`/api/printers/${enc(id)}/reconnect`, { method: 'POST' }),
  bedCleared: (id: string) => request<Printer>(`/api/printers/${enc(id)}/bed-cleared`, { method: 'POST', body: { clear: true } }),
  diagnosePrinter: (id: string, note?: string) =>
    request<PrinterDiagnosis>(`/api/printers/${enc(id)}/diagnose`, { method: 'POST', body: { note } }),
  lastDiagnosis: (id: string) =>
    request<{ printerId: string; diagnosis: (PrinterDiagnosis & { pending?: boolean; error?: string }) | null }>(
      `/api/printers/${enc(id)}/diagnose`,
    ),
  inspectPrint: (id: string, note?: string) =>
    request<PrintInspection>(`/api/printers/${enc(id)}/inspect`, { method: 'POST', body: { note } }),
  lastInspection: (id: string) =>
    request<{ printerId: string; inspection: PrintInspection | null; watch: WatchStatus }>(`/api/printers/${enc(id)}/inspect`),
  analyzeFile: (id: string, body: { printerId?: string | null; plate?: number; note?: string } = {}) =>
    request<PrintReview>(`/api/files/${enc(id)}/analyze`, { method: 'POST', body }),
  command: (id: string, action: CommandAction, params: Record<string, unknown> = {}) =>
    request<{ ok: boolean; responses?: string[]; percent?: number }>(`/api/printers/${enc(id)}/command`, {
      method: 'POST',
      body: { action, params },
    }),
  calibrate: (id: string, options: CalibrationOption[], confirmBedClear = false) =>
    request<{ ok: boolean; options: CalibrationOption[] }>(`/api/printers/${enc(id)}/calibrate`, {
      method: 'POST',
      body: { options, confirmBedClear },
    }),
  printerFiles: (id: string) => request<{ files: PrinterFile[] }>(`/api/printers/${enc(id)}/files`),
  deletePrinterFile: (id: string, name: string) =>
    request<{ deleted: boolean }>(`/api/printers/${enc(id)}/files`, { method: 'DELETE', query: { name } }),
  startPrinterFile: (id: string, name: string) =>
    request<{ started: boolean }>(`/api/printers/${enc(id)}/files/start`, { method: 'POST', body: { name } }),

  files: (query: { search?: string } = {}) =>
    request<{ files: LibraryFile[]; summary: { total: number; bytes: number } }>('/api/files', { query }),
  addFileFromUrl: (url: string) => request<LibraryFile>('/api/files', { method: 'POST', body: { url } }),
  renameFile: (id: string, name: string) => request<LibraryFile>(`/api/files/${enc(id)}`, { method: 'PUT', body: { name } }),
  deleteFile: (id: string) => request<{ deleted: boolean }>(`/api/files/${enc(id)}`, { method: 'DELETE' }),
  splitFile: (id: string) => request<SplitResult>(`/api/files/${enc(id)}/split`, { method: 'POST' }),
  arrangeFile: (id: string, body: { machine?: string; printerId?: string; gap?: number; margin?: number; separate?: boolean; autoRotate?: boolean }) =>
    request<ArrangeResult>(`/api/files/${enc(id)}/arrange`, { method: 'POST', body }),
  moveObjects: (id: string, moves: { item: number; dx: number; dy: number }[]) =>
    request<{ file: LibraryFile; moved: number }>(`/api/files/${enc(id)}/layout`, { method: 'POST', body: { moves } }),
  orientFile: (id: string) => request<OrientResult>(`/api/files/${enc(id)}/orient`, { method: 'POST' }),
  combineFiles: (body: { items: { fileId: string; copies: number }[]; printerId?: string; machine?: string; gap?: number; margin?: number; autoRotate?: boolean }) =>
    request<CombineResult>('/api/files/combine', { method: 'POST', body }),
  platePreview: (id: string, plate?: number) => request<PlateLayout>(`/api/files/${enc(id)}/plate`, { query: { plate } }),

  jobs: (query: { limit?: number; status?: string; printerId?: string } = {}) =>
    request<{ jobs: Job[]; stats: QueueStats }>('/api/jobs', { query }),
  createJob: (
    body: { printerId: string; printerIds?: string[]; priority?: number; fileId: string; mode: 'now' | 'queue'; confirmBedClear?: boolean; note?: string } & PrintOptions,
  ) => request<Job>('/api/jobs', { method: 'POST', body }),
  createBatch: (
    body: { fileId: string; printerIds: string[]; confirmBedClear?: boolean } & PrintOptions,
  ) => request<BatchResult>('/api/jobs/batch', { method: 'POST', body }),
  cancelBatch: (batchId: string, force = false) =>
    request<{ batch: string; canceled: number; failed: { jobId: string; printerName: string | null; message: string }[] }>(
      `/api/jobs/batch/${enc(batchId)}/cancel`,
      { method: 'POST', body: { force } },
    ),
  startJob: (id: string, confirmBedClear = false, printerId?: string) =>
    request<Job>(`/api/jobs/${enc(id)}/start`, { method: 'POST', body: { confirmBedClear, printerId } }),
  moveJob: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') =>
    request<Job>(`/api/jobs/${enc(id)}/move`, { method: 'POST', body: { direction } }),
  updateJob: (id: string, body: { priority?: number; note?: string | null; printerIds?: string[] }) =>
    request<Job>(`/api/jobs/${enc(id)}`, { method: 'PUT', body }),

  stats: (query: { days?: number; printerId?: string } = {}) => request<PrintStats>('/api/stats', { query }),
  spools: (query: { printerId?: string } = {}) => request<{ spools: Spool[]; costs: CostSettings }>('/api/spools', { query }),
  saveSpool: (body: SpoolInput, id?: string) =>
    id ? request<Spool>(`/api/spools/${enc(id)}`, { method: 'PUT', body }) : request<Spool>('/api/spools', { method: 'POST', body }),
  adjustSpool: (id: string, body: { remainingG?: number; deltaG?: number }) =>
    request<Spool>(`/api/spools/${enc(id)}/adjust`, { method: 'POST', body }),
  deleteSpool: (id: string) => request<{ deleted: boolean }>(`/api/spools/${enc(id)}`, { method: 'DELETE' }),
  preflight: (body: { fileId: string; printerId?: string; printerIds?: string[]; plate?: number; amsMapping?: number[] }) =>
    request<Preflight>('/api/preflight', { method: 'POST', body }),
  maintenance: (printerId: string) => request<MaintenanceInfo>(`/api/printers/${enc(printerId)}/maintenance`),
  addMaintenance: (printerId: string, body: { name: string; intervalHours: number }) =>
    request<MaintenanceTask>(`/api/printers/${enc(printerId)}/maintenance`, { method: 'POST', body }),
  completeMaintenance: (printerId: string, taskId: string) =>
    request<MaintenanceTask>(`/api/printers/${enc(printerId)}/maintenance/${enc(taskId)}/done`, { method: 'POST' }),
  deleteMaintenance: (printerId: string, taskId: string) =>
    request<{ deleted: boolean }>(`/api/printers/${enc(printerId)}/maintenance/${enc(taskId)}`, { method: 'DELETE' }),
  cancelJob: (id: string, force = false) => request<Job>(`/api/jobs/${enc(id)}/cancel`, { method: 'POST', body: { force } }),
  reprintJob: (id: string, body: { mode?: 'now' | 'queue'; confirmBedClear?: boolean } = {}) =>
    request<Job>(`/api/jobs/${enc(id)}/reprint`, { method: 'POST', body }),
  jobHistory: (id: string) => request<HistoryResult & { jobId: string }>(`/api/jobs/${enc(id)}/history`),
  deleteJob: (id: string) => request<{ deleted: boolean }>(`/api/jobs/${enc(id)}`, { method: 'DELETE' }),
  clearJobs: () => request<{ removed: number }>('/api/jobs/clear', { method: 'POST' }),

  apiKeys: () => request<{ apiKeys: ApiKey[] }>('/api/apikeys'),
  createApiKey: (name: string) => request<ApiKey>('/api/apikeys', { method: 'POST', body: { name } }),
  revealApiKey: (id: string) => request<ApiKey>(`/api/apikeys/${enc(id)}/reveal`),
  deleteApiKey: (id: string) => request<{ deleted: boolean }>(`/api/apikeys/${enc(id)}`, { method: 'DELETE' }),

  prompts: () => request<{ prompts: PromptDoc[]; dir: string }>('/api/prompts'),
  savePrompt: (name: string, text: string) => request<PromptDoc>(`/api/prompts/${enc(name)}`, { method: 'PUT', body: { text } }),
  resetPrompt: (name: string) => request<PromptDoc>(`/api/prompts/${enc(name)}`, { method: 'DELETE' }),

  service: () => request<ServiceStatus>('/api/service'),
  setService: (action: 'install' | 'uninstall') =>
    request<ServiceStatus>('/api/service', { method: 'POST', body: { action } }),

  slicer: () => request<SlicerStatus>('/api/slicer'),
  slicerProfiles: (query: { printerId?: string; vendor?: string; machine?: string }) =>
    request<SlicerProfiles>('/api/slicer/profiles', { query }),
  sliceSettings: (fileId: string) => request<SliceSettings | null>(`/api/slicer/settings/${encodeURIComponent(fileId)}`),
  sliceChat: (fileId: string) => request<SliceChat>(`/api/slicer/chat/${enc(fileId)}`),
  sendSliceChat: (fileId: string, body: { message: string } & SliceChatContext) =>
    request<{ fileId: string; messages: SliceChatMessage[]; version: SliceVersion | null }>(`/api/slicer/chat/${enc(fileId)}/messages`, { method: 'POST', body }),
  saveSlicePreset: (body: SliceSnapshot & { name: string; description?: string }) =>
    request<SlicePreset>('/api/slicer/presets', { method: 'POST', body }),
  deleteSlicePreset: (id: string) => request<{ id: string }>(`/api/slicer/presets/${enc(id)}`, { method: 'DELETE' }),
  clearSliceChat: (fileId: string) => request<{ removed: number }>(`/api/slicer/chat/${enc(fileId)}`, { method: 'DELETE' }),
  saveSliceVersion: (fileId: string, body: SliceSnapshot & { source: SliceVersion['source']; messageId?: string; sliceId?: string }) =>
    request<SliceVersion>(`/api/slicer/chat/${enc(fileId)}/versions`, { method: 'POST', body }),
  slice: (body: { fileId: string; printerId: string; machine: string; process?: string; filament?: string } & SliceOptions) =>
    request<SliceResult>('/api/slicer', { method: 'POST', body }),

  testNotify: (body: { botToken?: string | null; chatId?: string | null }) =>
    request<{ sent: boolean; chatId: string | number | null }>('/api/notify/test', { method: 'POST', body }),

  tunnel: () => request<TunnelInfo>('/api/tunnel'),
  startTunnel: (provider: string) => request<TunnelStatus>('/api/tunnel/start', { method: 'POST', body: { provider } }),
  stopTunnel: () => request<TunnelStatus>('/api/tunnel/stop', { method: 'POST' }),
}
