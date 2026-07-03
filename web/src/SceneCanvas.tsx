import { useMemo, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { scroll } from './scroll'

/* ============================================================
   Glass hexagonal "G" - assembled at the surface, disassembles
   (each brick lerps out + slerps to a random tumble) as you
   scroll the first viewport, then the canvas fades into the mine.
   Ported verbatim from the design handoff (_buildG3 / _render3D).
   ============================================================ */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smoother = (x: number) => x * x * x * (x * (x * 6 - 15) + 10)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const r3 = (i: number, s: number) => {
  const x = Math.sin(i * 97.13 + s * 39.7) * 43758.5453
  return x - Math.floor(x)
}
const hex3 = (R: number, idx: number) => {
  const a = (Math.PI / 180) * (90 + idx * 60)
  return new THREE.Vector2(R * Math.cos(a), R * Math.sin(a))
}

interface Piece {
  mesh: THREE.Mesh
  homePos: THREE.Vector3
  homeQuat: THREE.Quaternion
  offset: THREE.Vector3
  explodeQuat: THREE.Quaternion
}

function buildG(glass: THREE.Material, edgeMat: THREE.Material, out: Piece[]): THREE.Group {
  const Ro = 2.62
  const Ri = 1.5
  const depth = 1.05
  const O: THREE.Vector2[] = []
  const I: THREE.Vector2[] = []
  for (let k = 0; k < 6; k++) {
    O.push(hex3(Ro, k))
    I.push(hex3(Ri, k))
  }
  const bricks: THREE.Vector2[][] = []
  const ringEdges = [0, 1, 2, 3, 5] // right edge (4) left open → the G's mouth
  for (const k of ringEdges) {
    const k2 = (k + 1) % 6
    bricks.push([O[k], O[k2], I[k2], I[k]])
  }
  const bh = (Ro - Ri) * 0.5
  bricks.push([
    new THREE.Vector2(-0.12, -bh),
    new THREE.Vector2(2.02, -bh),
    new THREE.Vector2(2.02, bh),
    new THREE.Vector2(-0.12, bh),
  ]) // the crossbar "tongue"

  const group = new THREE.Group()
  const extrude = { depth, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.07, bevelSegments: 1, curveSegments: 1 }
  bricks.forEach((poly, i) => {
    const shape = new THREE.Shape()
    shape.moveTo(poly[0].x, poly[0].y)
    for (let j = 1; j < poly.length; j++) shape.lineTo(poly[j].x, poly[j].y)
    shape.closePath()
    const geom = new THREE.ExtrudeGeometry(shape, extrude)
    geom.computeBoundingBox()
    const c = new THREE.Vector3()
    geom.boundingBox!.getCenter(c)
    geom.translate(-c.x, -c.y, -c.z)
    const mesh = new THREE.Mesh(geom, glass)
    mesh.position.copy(c)
    group.add(mesh)
    const eg = new THREE.EdgesGeometry(geom, 28)
    mesh.add(new THREE.LineSegments(eg, edgeMat))

    const homePos = mesh.position.clone()
    const homeQuat = mesh.quaternion.clone()
    const dir = new THREE.Vector3(c.x, c.y, 0)
    if (dir.length() < 0.001) dir.set(r3(i, 1) - 0.5, r3(i, 2) - 0.5, 0)
    dir.normalize()
    dir.z = (r3(i, 3) - 0.5) * 1.6
    dir.normalize()
    const dist = 2.6 + r3(i, 4) * 2.6
    const offset = dir.multiplyScalar(dist)
    const axis = new THREE.Vector3(r3(i, 5) - 0.5, r3(i, 6) - 0.5, r3(i, 7) - 0.5).normalize()
    const angle = (0.6 + r3(i, 8) * 1.6) * Math.PI
    const explodeQuat = homeQuat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle))
    out.push({ mesh, homePos, homeQuat, offset, explodeQuat })
  })
  return group
}

/* shared: paint the environment, make the smoked-glass material, build the G */
function createGlassGroup(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  pieces: Piece[],
  scale: number,
): THREE.Group {
  // hand-painted environment (bright sky + sun + a cyan reflection)
  const pmrem = new THREE.PMREMGenerator(gl)
  const ec = document.createElement('canvas')
  ec.width = 1024
  ec.height = 512
  const ex = ec.getContext('2d')!
  const lg = ex.createLinearGradient(0, 0, 0, 512)
  lg.addColorStop(0.0, '#eef4fb')
  lg.addColorStop(0.42, '#9fb1c6')
  lg.addColorStop(0.66, '#3d4855')
  lg.addColorStop(1.0, '#0b0f14')
  ex.fillStyle = lg
  ex.fillRect(0, 0, 1024, 512)
  const sun = ex.createRadialGradient(512, 96, 0, 512, 96, 300)
  sun.addColorStop(0, 'rgba(255,255,255,1)')
  sun.addColorStop(0.28, 'rgba(255,255,255,.75)')
  sun.addColorStop(1, 'rgba(255,255,255,0)')
  ex.fillStyle = sun
  ex.fillRect(0, 0, 1024, 512)
  const h1 = ex.createRadialGradient(190, 300, 0, 190, 300, 180)
  h1.addColorStop(0, 'rgba(95,212,226,.5)')
  h1.addColorStop(1, 'rgba(95,212,226,0)')
  ex.fillStyle = h1
  ex.fillRect(0, 0, 1024, 512)
  const envTex = new THREE.CanvasTexture(ec)
  envTex.mapping = THREE.EquirectangularReflectionMapping
  scene.environment = pmrem.fromEquirectangular(envTex).texture
  envTex.dispose()
  pmrem.dispose()

  // smoked black glass - translucent obsidian with bright reflective edges
  const glass = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#05070b'),
    metalness: 0,
    roughness: 0.06,
    transmission: 0.55,
    thickness: 1.4,
    ior: 1.5,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    attenuationColor: new THREE.Color('#0a0e16'),
    attenuationDistance: 1.2,
    envMapIntensity: 2.2,
    reflectivity: 0.6,
    transparent: true,
    side: THREE.DoubleSide,
  })
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xeaf2fb, transparent: true, opacity: 0.5 })

  const g = buildG(glass, edgeMat, pieces)
  g.rotation.set(0, 0, 0)
  g.scale.setScalar(scale)
  return g
}

function Lights() {
  return (
    <>
      <directionalLight position={[5, 8, 6]} intensity={3.2} color={0xffffff} />
      <directionalLight position={[-2, 6, -8]} intensity={4.0} color={0xd6e6f6} />
      <directionalLight position={[-6, -3, 4]} intensity={1.4} color={0x9fb4cc} />
      <ambientLight intensity={0.6} color={0x4a5666} />
    </>
  )
}

function GlassG() {
  const { gl, scene } = useThree()
  const pieces = useRef<Piece[]>([])
  const groupRef = useRef<THREE.Group>(null)
  const tmpQ = useMemo(() => new THREE.Quaternion(), [])

  const group = useMemo(() => {
    pieces.current = []
    return createGlassGroup(gl, scene, pieces.current, 0.85)
  }, [gl, scene])

  useFrame(() => {
    const e = smoother(clamp01(scroll.heroE))
    for (const p of pieces.current) {
      p.mesh.position.copy(p.homePos).addScaledVector(p.offset, e)
      tmpQ.copy(p.homeQuat).slerp(p.explodeQuat, e)
      p.mesh.quaternion.copy(tmpQ)
    }
    const g = groupRef.current
    if (g) {
      // no spin - stays straight and centered; gentle parallax toward the cursor
      const px = scroll.pointer.x
      const py = scroll.pointer.y
      g.rotation.y = lerp(g.rotation.y, px * 0.22, 0.06)
      g.rotation.x = lerp(g.rotation.x, -py * 0.16, 0.06)
      g.position.x = lerp(g.position.x, px * 0.5, 0.06)
      g.position.y = lerp(g.position.y, -py * 0.34, 0.06)
    }
    gl.domElement.style.opacity = String(clamp01(scroll.gAlpha))
  })

  return <primitive ref={groupRef} object={group} />
}

export default function SceneCanvas() {
  return (
    <Canvas
      camera={{ fov: 32, position: [0, 0, 11.4], near: 0.1, far: 100 }}
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true, premultipliedAlpha: false }}
      style={{ width: '100%', height: '100%' }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.45
        gl.outputColorSpace = THREE.SRGBColorSpace
      }}
    >
      <Lights />
      <GlassG />
    </Canvas>
  )
}

/* ---------- preloader G: starts as scattered shards, assembles as it loads ---------- */
const SCATTER = 1.25 // spread the shards wider so they read as scattered parts
function PreloaderInner({ progressRef, onReady }: { progressRef: { current: number }; onReady?: () => void }) {
  const { gl, scene } = useThree()
  const pieces = useRef<Piece[]>([])
  const groupRef = useRef<THREE.Group>(null)
  const tmpQ = useMemo(() => new THREE.Quaternion(), [])
  const announced = useRef(false)
  const group = useMemo(() => {
    pieces.current = []
    return createGlassGroup(gl, scene, pieces.current, 0.75)
  }, [gl, scene])
  useFrame((_, dt) => {
    // first frame: the scene is actually visible now → let the host start the clock
    if (!announced.current) {
      announced.current = true
      onReady?.()
    }
    // progress 0 → scattered shards, 1 → assembled G
    const e = smoother(clamp01(1 - progressRef.current))
    for (const p of pieces.current) {
      p.mesh.position.copy(p.homePos).addScaledVector(p.offset, e * SCATTER)
      tmpQ.copy(p.homeQuat).slerp(p.explodeQuat, e)
      p.mesh.quaternion.copy(tmpQ)
    }
    if (groupRef.current) groupRef.current.rotation.y += dt * 0.3
  })
  return <primitive ref={groupRef} object={group} />
}

export function PreloaderG({ progressRef, onReady }: { progressRef: { current: number }; onReady?: () => void }) {
  return (
    <Canvas
      camera={{ fov: 32, position: [0, 0, 18], near: 0.1, far: 100 }}
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true, premultipliedAlpha: false }}
      style={{ width: '100%', height: '100%' }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.45
        gl.outputColorSpace = THREE.SRGBColorSpace
      }}
    >
      <Lights />
      <PreloaderInner progressRef={progressRef} onReady={onReady} />
    </Canvas>
  )
}
