/* Shared scroll/descent state, written by App's eased rAF loop and read inside
   the SceneCanvas useFrame loop without triggering React re-renders. */
export const scroll = {
  progress: 0, // eased 0..1 over the whole page
  scrollY: 0, // raw scroll px (target)
  vh: typeof window !== 'undefined' ? window.innerHeight : 800,
  heroE: 0, // 3D glass-G explode amount, 0..1 (raw; smootherstep applied in scene)
  gAlpha: 1, // 3D canvas opacity as the G fades into the mine
  pointer: { x: 0, y: 0 },
}
