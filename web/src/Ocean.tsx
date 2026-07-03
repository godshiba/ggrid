import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { scroll } from './scroll'

/* ============================================================
   Realistic ocean surface - a high-res plane displaced by a sum
   of Gerstner waves in the vertex shader (real 3D crests, not a
   drawn SVG). Fresnel sky reflection, a sharp sun glint and foam
   on the steep crests sell the water. Viewed at a low angle so
   you read the wave geometry receding toward a hazy horizon.
   ============================================================ */

const vertex = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  const float PI = 3.141592653589793;

  // one Gerstner wave: adds horizontal+vertical displacement and accumulates the normal
  void gerstner(vec2 p, vec2 dir, float amp, float wl, float spd, float Q, float t,
                inout vec3 disp, inout vec3 nrm) {
    vec2 d = normalize(dir);
    float k = 2.0 * PI / wl;
    float c = sqrt(9.8 / k);
    float f = k * dot(d, p) - c * spd * t;
    float cf = cos(f);
    float sf = sin(f);
    float wa = k * amp;
    disp.x += Q * amp * d.x * cf;
    disp.y += Q * amp * d.y * cf;
    disp.z += amp * sf;
    nrm.x -= d.x * wa * cf;
    nrm.y -= d.y * wa * cf;
    nrm.z -= Q * wa * sf;
  }

  void main() {
    vec2 p = position.xy;
    vec3 disp = vec3(0.0);
    vec3 nrm = vec3(0.0, 0.0, 1.0);
    // gentle swells rolling toward the viewer, with finer ripple detail on top
    gerstner(p, vec2(0.12, -1.0), 0.150, 9.0, 0.85, 0.50, uTime, disp, nrm);
    gerstner(p, vec2(-0.28, -1.0), 0.100, 5.6, 1.05, 0.46, uTime, disp, nrm);
    gerstner(p, vec2(0.55, -0.9), 0.058, 3.4, 1.30, 0.42, uTime, disp, nrm);
    gerstner(p, vec2(-0.70, -0.75), 0.032, 2.0, 1.60, 0.36, uTime, disp, nrm);
    gerstner(p, vec2(0.90, -0.45), 0.019, 1.15, 1.95, 0.30, uTime, disp, nrm);
    gerstner(p, vec2(-0.45, 0.85), 0.011, 0.62, 2.5, 0.26, uTime, disp, nrm);

    vec3 pos = vec3(position.x + disp.x, position.y + disp.y, disp.z);
    vHeight = disp.z;
    vNormal = normalize(normalMatrix * normalize(nrm));
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const fragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uCam;
  varying vec3 vWorldPos;
  varying vec3 vNormal;
  varying float vHeight;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCam - vWorldPos);
    if (dot(N, V) < 0.0) N = -N;

    // realistic ocean palette
    vec3 deep = vec3(0.012, 0.095, 0.145);
    vec3 mid = vec3(0.03, 0.24, 0.30);
    vec3 sky = vec3(0.40, 0.64, 0.74);

    float up = clamp(N.z * 0.5 + 0.5, 0.0, 1.0);
    vec3 base = mix(deep, mid, up);

    // soft diffuse from the sun shapes the wave faces (real 3D relief)
    float diff = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
    base *= 0.72 + 0.45 * diff;

    // subsurface glow where light passes through the thin lit crests
    float sss = smoothstep(0.06, 0.24, vHeight) * clamp(dot(uSunDir, -V) * 0.5 + 0.5, 0.0, 1.0);
    base += vec3(0.02, 0.12, 0.11) * sss;

    // fresnel sky reflection at grazing angles
    float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 col = mix(base, sky, fres * 0.7);

    // sun glint
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 200.0);
    col += vec3(1.0, 0.96, 0.86) * spec * 1.5;

    // sparse foam, only on the sharpest crests
    float foam = smoothstep(0.16, 0.28, vHeight);
    col = mix(col, vec3(0.82, 0.92, 0.97), foam * 0.5);

    // haze into the horizon, then fade to transparent
    float dist = length(vWorldPos.xz - uCam.xz);
    col = mix(col, sky * 0.85, smoothstep(14.0, 44.0, dist) * 0.8);
    float a = 1.0 - smoothstep(38.0, 50.0, dist);

    gl_FragColor = vec4(col, a);
  }
`

function WaterMesh() {
  const matRef = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.35, 0.62, 0.7).normalize() },
      uCam: { value: new THREE.Vector3() },
    }),
    [],
  )
  useFrame((state, dt) => {
    const m = matRef.current
    if (!m) return
    // slow during the descent so it settles; lively at the surface
    m.uniforms.uTime.value += dt
    ;(m.uniforms.uCam.value as THREE.Vector3).copy(state.camera.position)
  })
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <planeGeometry args={[80, 80, 200, 200]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

export default function Ocean() {
  return (
    <Canvas
      camera={{ fov: 26, position: [0, 0.42, 15], near: 0.1, far: 160 }}
      dpr={[1, 1.75]}
      gl={{ alpha: true, antialias: true }}
      style={{ width: '100%', height: '100%', display: 'block' }}
      onCreated={({ gl, camera }) => {
        gl.setClearColor(0x000000, 0)
        // eye right at the waterline, looking dead level across the waves (telephoto flattens them)
        camera.lookAt(0, 0.42, -24)
      }}
    >
      <WaterMesh />
    </Canvas>
  )
}
