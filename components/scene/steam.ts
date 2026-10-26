/**
 * Coffee steam: a few translucent wisps on world-up billboards over the cup, shaded by value-noise fbm that scrolls
 * upward and sways more the higher it is. Cheap: three small quads, four octaves, no textures. Reduced motion: a still,
 * fainter wisp (the field does not scroll). The wisps are warm-lit by their colour; they cast and receive no shadows.
 */
import * as THREE from "three";

export interface Steam {
  group: THREE.Group;
  /** Each frame: the field's time and the camera, which the wisps turn to face (about the world's up axis only). */
  update(ms: number, cam: THREE.Vector3): void;
  dispose(): void;
}

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */ `
precision highp float;
uniform float uTime, uAlpha, uSeed; uniform vec3 uColor; varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 4; k++) { s += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return s; }
void main() {
  float y = vUv.y;
  // the wisp sways sideways more the higher it is, and rises: the field scrolls down through it
  float sway = (noise(vec2(uSeed * 7.0, y * 1.6 + uTime * 0.25)) - 0.5) * 0.9 * y;
  float x = vUv.x - 0.5 + sway;
  float n = fbm(vec2(x * 2.6, y * 2.0 - uTime * 0.32) + uSeed * 10.0);
  float w = mix(0.14, 0.42, y); // narrow at the rim, wider and thinner as it rises
  float xm = 1.0 - smoothstep(0.0, w, abs(x));
  // clear just above the crema, densest a hand above the rim, gone by the top: seen from the counter's cameras (30-50 degrees up) that is the part that stands above the cup against the stone
  float ym = smoothstep(0.08, 0.3, y) * (1.0 - smoothstep(0.5, 1.0, y));
  float a = smoothstep(0.36, 0.62, n) * xm * ym * uAlpha;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** `at`: the coffee's surface (world); `still`: reduced motion. */
export function createSteam(o: { at: [number, number, number]; still: boolean }): Steam {
  const group = new THREE.Group(); group.position.set(...o.at);
  const color = new THREE.Color(0.42, 0.385, 0.35); // a warm mid grey: well under the pale stone (white and light greys vanished over the counter) and still lighter than the coffee, so the wisps read against both
  const wisps: { m: THREE.Mesh; mat: THREE.ShaderMaterial; rate: number }[] = [];
  const specs: { dx: number; dz: number; w: number; h: number; seed: number; alpha: number; rate: number }[] = [
    // the cup is about 0.25 m across: the wisps stand two to three cup widths above the crema, so that from the counter's cameras
    // (30-50 degrees up) their densest band projects above the far rim, against the stone, not onto the coffee
    { dx: 0, dz: 0, w: 0.4, h: 1.0, seed: 0.13, alpha: 0.7, rate: 1 },
    { dx: -0.06, dz: 0.05, w: 0.36, h: 0.9, seed: 0.57, alpha: 0.6, rate: 0.85 },
    { dx: 0.065, dz: -0.04, w: 0.38, h: 0.95, seed: 0.91, alpha: 0.55, rate: 1.15 },
  ];
  for (const s of specs) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 2.0 }, uAlpha: { value: o.still ? s.alpha * 0.7 : s.alpha }, uSeed: { value: s.seed }, uColor: { value: color } },
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    m.position.set(s.dx, s.h / 2 - 0.02, s.dz); m.renderOrder = 10; m.frustumCulled = true;
    group.add(m); wisps.push({ m, mat, rate: s.rate });
  }
  const t0 = performance.now();
  return {
    group,
    update(ms, cam) {
      group.rotation.y = Math.atan2(cam.x - group.position.x, cam.z - group.position.z);
      if (o.still) return;
      const s = (ms - t0) / 1000;
      for (const w of wisps) w.mat.uniforms.uTime.value = 2.0 + s * w.rate;
    },
    dispose() { for (const w of wisps) { w.m.geometry.dispose(); w.mat.dispose(); } },
  };
}
