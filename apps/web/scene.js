// Wayne.clips 2050 — scroll-driven 3D world.
// Wordmark of instanced clip cards -> scatter -> 7-lane pipeline ring ->
// studio torus -> hub constellations -> finale. Seeded PRNG (mulberry32,
// seed 2050) so the layout is identical on every load.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const VOID = 0x07040C;
const HUES = [0xEE5FA7, 0x8CE7D7, 0xB39DFF, 0xFFB58A];
const CAPTIONS = ['THIS CHANGES EVERYTHING.', 'CLIP THAT.', 'KEEP THE CHAOS.', 'NOBODY TELLS YOU THIS.', 'RUN IT BACK.', 'READY TO DROP.', 'WATCH THE TURN.', 'THE PART EVERYONE MISSES.', 'HOOK IN TWO SECONDS.', 'SMALL CLIPS. BIG LIBRARY.', 'TEST FIVE HOOKS.', 'CUT THE PAUSE.', 'SHOW. DO NOT TELL.', 'ONE IDEA PER CLIP.', 'SHIP DAILY.', 'OWN YOUR FOOTAGE.'];
const PALETTES = [
  ['#EE5FA7', '#7C3AED'], ['#8CE7D7', '#0E7490'], ['#FFB58A', '#EE5FA7'],
  ['#B39DFF', '#EE5FA7'], ['#FBBF24', '#EE5FA7'], ['#8CE7D7', '#B39DFF'],
  ['#EE5FA7', '#FFB58A'], ['#B39DFF', '#0E7490'],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const clamp01 = v => Math.max(0, Math.min(1, v));
const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const lerp = (a, b, t) => a + (b - a) * t;

function makeAtlas() {
  const c = document.createElement('canvas'); c.width = c.height = 2048;
  const g = c.getContext('2d');
  const rng = mulberry32(2050);
  for (let i = 0; i < 64; i++) {
    const x = (i % 8) * 256, y = Math.floor(i / 8) * 256;
    const [a, b] = PALETTES[i % PALETTES.length];
    const grad = g.createLinearGradient(x, y, x + 256, y + 256);
    grad.addColorStop(0, a); grad.addColorStop(1, b);
    g.fillStyle = grad; g.fillRect(x, y, 256, 256);
    // soft subject silhouette: head circle + shoulder ellipse
    const cx = x + 128 + (rng() - .5) * 60, cy = y + 120 + (rng() - .5) * 30;
    g.fillStyle = 'rgba(7,4,12,.55)';
    g.beginPath(); g.ellipse(cx, cy + 110, 95, 70, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(cx, cy, 46, 0, Math.PI * 2); g.fill();
    // film grain
    for (let k = 0; k < 260; k++) {
      g.fillStyle = `rgba(255,255,255,${rng() * 0.08})`;
      g.fillRect(x + rng() * 256, y + rng() * 256, 2, 2);
    }
    // baked caption pill
    const cap = CAPTIONS[i % CAPTIONS.length];
    g.font = '400 21px Anton, sans-serif';
    const w = Math.min(220, g.measureText(cap).width + 18);
    g.fillStyle = 'rgba(7,4,12,.85)';
    g.fillRect(x + 14, y + 204, w, 30);
    g.fillStyle = '#EE5FA7';
    g.fillText(cap.slice(0, 18), x + 22, y + 226);
    g.font = '400 11px monospace'; g.fillStyle = 'rgba(251,238,255,.85)';
    g.fillText('SAMPLE', x + 10, y + 20);
    g.fillStyle = '#EE5FA7';
    g.beginPath(); g.arc(x + 236, y + 18, 5, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function sampleWordmark(n, portrait) {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 512;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 2048, 512);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const fit = (text, maxW) => {
    let lo = 10, hi = 400;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; g.font = `400 ${mid}px Anton, sans-serif`; if (g.measureText(text).width <= maxW) lo = mid; else hi = mid - 1; }
    return lo;
  };
  if (portrait) {
    const fs = fit('Wayne', 1500);
    g.font = `400 ${fs}px Anton, sans-serif`;
    g.fillStyle = '#FBEEFF'; g.fillText('Wayne', 1024, 150);
    g.fillStyle = '#EE5FA7'; g.fillText('.clips', 1024, 150 + fs * 0.95);
  } else {
    const fs = fit('Wayne.clips', 1800);
    g.font = `400 ${fs}px Anton, sans-serif`;
    const w1 = g.measureText('Wayne').width, w2 = g.measureText('.clips').width;
    const total = w1 + w2, x0 = 1024 - total / 2;
    g.textAlign = 'left';
    g.fillStyle = '#FBEEFF'; g.fillText('Wayne', x0, 256);
    g.fillStyle = '#EE5FA7'; g.fillText('.clips', x0 + w1, 256);
  }
  const img = g.getImageData(0, 0, 2048, 512).data;
  const pts = [];
  for (let y = 0; y < 512; y += 2) for (let x = 0; x < 2048; x += 2) if (img[(y * 2048 + x) * 4 + 3] > 128) pts.push([x, y]);
  const rng = mulberry32(2050);
  const chosen = [];
  if (pts.length) {
    chosen.push(pts[Math.floor(rng() * pts.length)]);
    let guard = 0;
    while (chosen.length < n && guard++ < n * 400) {
      let best = null, bestD = -1;
      for (let k = 0; k < 12; k++) {
        const p = pts[Math.floor(rng() * pts.length)];
        let d = Infinity;
        for (const q of chosen) { const dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (dd < d) d = dd; }
        if (d > bestD) { bestD = d; best = p; }
      }
      if (best) chosen.push(best);
    }
  }
  return chosen;
}

async function init() {
  const canvas = document.getElementById('gl');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(prefers-reduced-data: reduce)').matches;
  const small = matchMedia('(max-width: 819px), (orientation: portrait) and (max-width: 1100px), (orientation: landscape) and (max-height: 500px)').matches;
  if (reduced) { document.getElementById('no-webgl').hidden = false; canvas.style.display = 'none'; window.__sceneReady = 'fallback'; return; }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    document.getElementById('no-webgl').hidden = false; canvas.style.display = 'none'; window.__sceneReady = 'fallback'; return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(VOID);
  scene.fog = new THREE.FogExp2(VOID, 0.018);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const portrait = innerWidth < innerHeight;
  const fov = portrait ? 52 : 38;
  camera.fov = fov; camera.updateProjectionMatrix();
  const wordWidth = portrait ? 8 : 15;
  const aspect = innerWidth / innerHeight;
  const Z0 = wordWidth / (0.74 * 2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)) * aspect);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.6, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Dust
  const dustN = 1800, dustPos = new Float32Array(dustN * 3), dustCol = new Float32Array(dustN * 3);
  const rngD = mulberry32(77);
  for (let i = 0; i < dustN; i++) {
    dustPos[i * 3] = (rngD() - .5) * 90; dustPos[i * 3 + 1] = (rngD() - .5) * 50; dustPos[i * 3 + 2] = -rngD() * 90;
    const mint = rngD() < 0.15;
    const c = new THREE.Color(mint ? 0x8CE7D7 : 0xFBEEFF);
    dustCol[i * 3] = c.r * .5; dustCol[i * 3 + 1] = c.g * .5; dustCol[i * 3 + 2] = c.b * .5;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('color', new THREE.BufferAttribute(dustCol, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 1.4, vertexColors: true, transparent: true, opacity: .8, sizeAttenuation: false }));
  scene.add(dust);

  // Holo grid
  const grid = new THREE.GridHelper(120, 120, 0x8CE7D7, 0x8CE7D7);
  grid.position.y = -6;
  grid.material.transparent = true; grid.material.opacity = 0.06;
  scene.add(grid);

  // Station beacons (pipeline ring)
  const beacons = [];
  const beaconGroup = new THREE.Group(); scene.add(beaconGroup);
  for (let k = 0; k < 7; k++) {
    const th = -Math.PI / 2 + k * 2 * Math.PI / 7;
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), new THREE.MeshBasicMaterial({ color: 0x555566, wireframe: true, transparent: true, opacity: .8 }));
    m.position.set(9 * Math.cos(th), 0, 9 * Math.sin(th));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.02, 8, 48), new THREE.MeshBasicMaterial({ color: 0x555566, transparent: true, opacity: .5 }));
    ring.position.copy(m.position); ring.rotation.x = Math.PI / 2;
    beaconGroup.add(m, ring);
    beacons.push({ mesh: m, ring, theta: th });
  }
  // Job packet
  const packet = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), new THREE.MeshBasicMaterial({ color: 0x8CE7D7 }));
  beaconGroup.add(packet);

  // Wait for Anton so the wordmark mask is real letterforms.
  try { await document.fonts.load('400 100px Anton'); await document.fonts.ready; } catch {}
  const atlas = makeAtlas();
  const N = small ? 180 : 420;
  const homePts = sampleWordmark(N, portrait);
  const rng = mulberry32(2050);

  // Per-card targets
  const home = [], scatter = [], pipeline = [], studio = [], hub = [], finals = [];
  const seeds = [], tiles = [], aspects = [], hues = [], scales = { home: [], scatter: [], pipeline: [], studio: [], hub: [] };
  const quats = { home: [], scatter: [], pipeline: [], studio: [], hub: [] };
  const tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler();
  const pushTarget = (arr, qarr, sarr, x, y, z, rx, ry, rz, s) => {
    arr.push(new THREE.Vector3(x, y, z));
    tmpE.set(rx, ry, rz); tmpQ.setFromEuler(tmpE);
    qarr.push(tmpQ.clone()); sarr.push(s);
  };
  const hubCenters = [[-8, 3.5, -14], [8, 3.5, -14], [-9, -3.5, -16], [9, -3.5, -16], [0, 0, -24]];
  for (let i = 0; i < N; i++) {
    const [px, py] = homePts[i % homePts.length] || [1024, 256];
    const hx = (px - 1024) * (wordWidth / 1800), hy = (256 - py) * (wordWidth / 1800);
    const hz = (rng() - .5) * 0.1;
    pushTarget(home, quats.home, scales.home, hx, hy, hz, 0, 0, 0, 0.19);
    // scatter
    let sx, sy, sz, tries = 0;
    do { sx = (rng() - .5) * 46; sy = (rng() - .5) * 26; sz = -58 + Math.pow(rng(), 1.4) * 66; tries++; }
    while (tries < 20 && sz > -10 && (sx * sx / 36 + sy * sy / 10.2) < 1);
    pushTarget(scatter, quats.scatter, scales.scatter, sx, sy, sz, (rng() - .5) * .87, (rng() - .5) * .87, (rng() - .5) * .87, 0.7 + 0.9 * hash(i));
    // pipeline lane
    const k = i % 7, r = Math.floor(i / 7);
    const th = -Math.PI / 2 + k * 2 * Math.PI / 7 + r * 0.012;
    const px2 = 9 * Math.cos(th), pz2 = 9 * Math.sin(th), py2 = (r - 29.5) * 0.11;
    tmpE.set(0, -th + Math.PI / 2, 0); tmpQ.setFromEuler(tmpE);
    pipeline.push(new THREE.Vector3(px2, py2, pz2)); quats.pipeline.push(tmpQ.clone()); scales.pipeline.push(0.5);
    // studio torus
    const a = rng() * Math.PI * 2, rad = 11 + rng() * 5;
    pushTarget(studio, quats.studio, scales.studio, Math.cos(a) * rad, Math.sin(a) * rad, -10 - rng() * 20, rng() * .6, rng() * .6, 0, 1.1);
    // hub fibonacci sphere
    const c = hubCenters[i % 5];
    const golden = Math.PI * (3 - Math.sqrt(5));
    const yy = 1 - ((i % 84) / 83) * 2, rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const th2 = golden * (i % 84);
    pushTarget(hub, quats.hub, scales.hub, c[0] + 2.6 * Math.cos(th2) * rr, c[1] + 2.6 * yy, c[2] + 2.6 * Math.sin(th2) * rr, rng() * .8, rng() * .8, 0, 0.55);
    finals.push(home[i]);
    seeds.push(rng()); tiles.push(i % 64);
    const ar = rng(); aspects.push(ar < 0.6 ? 0 : ar < 0.85 ? 1 : 2);
    hues.push(Math.floor(rng() * 4));
  }
  const states = { home, scatter, pipeline, studio, hub, final: finals };
  const stateQuats = { home: quats.home, scatter: quats.scatter, pipeline: quats.pipeline, studio: quats.studio, hub: quats.hub, final: quats.home };
  const stateScales = { home: scales.home, scatter: scales.scatter, pipeline: scales.pipeline, studio: scales.studio, hub: scales.hub, final: scales.home };

  // Instanced cards with custom shader
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uTime: { value: 0 } },
    vertexShader: `
      attribute float aTile; attribute float aSeed; attribute float aAspect; attribute float aHue;
      varying vec2 vUv; varying float vTile; varying float vSeed; varying float vAspect; varying float vHue;
      void main(){
        vUv = uv; vTile = aTile; vSeed = aSeed; vAspect = aAspect; vHue = aHue;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D uAtlas; uniform float uTime;
      varying vec2 vUv; varying float vTile; varying float vSeed; varying float vAspect; varying float vHue;
      vec3 hueColor(float h){
        if (h < 0.5) return vec3(0.933, 0.373, 0.655);
        if (h < 1.5) return vec3(0.549, 0.906, 0.843);
        if (h < 2.5) return vec3(0.702, 0.616, 1.0);
        return vec3(1.0, 0.710, 0.541);
      }
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = 0.07;
        vec2 q = abs(p) - vec2(1.0 - r, 1.0 - r);
        float d = length(max(q, 0.0)) - r;
        if (d > 0.0) discard;
        float col = mod(vTile, 8.0), row = floor(vTile / 8.0);
        vec2 uv = vec2((col + vUv.x) / 8.0, 1.0 - (row + 1.0 - vUv.y) / 8.0);
        uv = mix(uv, vec2((col + 0.5) / 8.0, 1.0 - (row + 0.5) / 8.0), 0.0);
        uv = clamp(uv, vec2(col / 8.0 + 0.008, 1.0 - (row + 1.0) / 8.0 + 0.008), vec2((col + 1.0) / 8.0 - 0.008, 1.0 - row / 8.0 - 0.008));
        vec3 tex = texture2D(uAtlas, uv).rgb;
        tex *= 0.85 + 0.15 * sin(uTime * 0.6 + vSeed * 6.28);
        float scan = 0.94 + 0.06 * step(0.5, fract(vUv.y * 86.0));
        vec3 col3 = tex * scan;
        float edge = smoothstep(0.0, 0.012, -d);
        vec3 hc = hueColor(vHue);
        float border = smoothstep(0.985, 1.0, max(abs(p.x), abs(p.y)));
        col3 = mix(col3, hc * 1.6, border * edge);
        if (fract(vSeed * 7.31) < 0.2) {
          float blink = step(0.5, fract(uTime * 0.5 + vSeed));
          vec2 dp = vUv - vec2(0.86, 0.88);
          if (length(dp) < 0.03) col3 = mix(col3, vec3(0.98, 0.37, 0.65) * 1.8, blink);
        }
        gl_FragColor = vec4(col3, 1.0);
      }`,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const aTile = new Float32Array(N), aSeed = new Float32Array(N), aAspect = new Float32Array(N), aHue = new Float32Array(N);
  for (let i = 0; i < N; i++) { aTile[i] = tiles[i]; aSeed[i] = seeds[i]; aAspect[i] = aspects[i]; aHue[i] = hues[i]; }
  geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(aTile, 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
  geo.setAttribute('aAspect', new THREE.InstancedBufferAttribute(aAspect, 1));
  geo.setAttribute('aHue', new THREE.InstancedBufferAttribute(aHue, 1));
  mesh.frustumCulled = false;
  scene.add(mesh);

  // Crisp wordmark overlay (canvas texture plane, dissolves p 0.07–0.16)
  const crispCanvas = document.createElement('canvas'); crispCanvas.width = 2048; crispCanvas.height = 512;
  {
    const g = crispCanvas.getContext('2d');
    g.clearRect(0, 0, 2048, 512);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (portrait) {
      g.font = '400 220px Anton, sans-serif';
      g.fillStyle = '#FBEEFF'; g.fillText('Wayne', 1024, 150);
      g.fillStyle = '#EE5FA7'; g.fillText('.clips', 1024, 370);
    } else {
      g.font = '400 300px Anton, sans-serif';
      const w1 = g.measureText('Wayne').width, w2 = g.measureText('.clips').width;
      const x0 = 1024 - (w1 + w2) / 2;
      g.textAlign = 'left';
      g.fillStyle = '#FBEEFF'; g.fillText('Wayne', x0, 256);
      g.fillStyle = '#EE5FA7'; g.fillText('.clips', x0 + w1, 256);
    }
  }
  const crispTex = new THREE.CanvasTexture(crispCanvas); crispTex.colorSpace = THREE.SRGBColorSpace;
  const crisp = new THREE.Mesh(new THREE.PlaneGeometry(wordWidth, wordWidth * 0.25), new THREE.MeshBasicMaterial({ map: crispTex, transparent: true, depthWrite: false }));
  crisp.position.z = 0.3;
  scene.add(crisp);

  // Camera keyframes
  const camKeys = [
    [0.00, [0, 0, Z0], [0, 0, 0]], [0.07, [0, 0, Z0], [0, 0, 0]],
    [0.22, [0.8, 0.4, Z0 - 5], [0, 0, -10]], [0.32, [-1.2, -0.3, 2], [0, 0, -16]],
    [0.44, [0, 0, 0], [9, 0, 0]], [0.56, [0, 0, 0], [-9, 0, 0]],
    [0.64, [0, 0, 8], [0, 0, -10]], [0.78, [0, 0, 6], [0, 0, -20]],
    [0.86, [0, 2, 10], [0, 0, -14]], [0.93, [0, 2, 10], [0, 0, -14]],
    [1.00, [0, 0, Z0], [0, 0, 0]],
  ];
  const camPosCurve = new THREE.CatmullRomCurve3(camKeys.map(k => new THREE.Vector3(...k[1])), false, 'centripetal');
  const camLookCurve = new THREE.CatmullRomCurve3(camKeys.map(k => new THREE.Vector3(...k[2])), false, 'centripetal');
  // Parameterise curves by p via keyframe interpolation (approx: map p through key times)
  function camAt(p) {
    let i = 0;
    while (i < camKeys.length - 2 && p > camKeys[i + 1][0]) i++;
    const t0 = camKeys[i][0], t1 = camKeys[i + 1][0];
    const q = clamp01((p - t0) / Math.max(0.0001, t1 - t0));
    const pos = new THREE.Vector3().lerpVectors(new THREE.Vector3(...camKeys[i][1]), new THREE.Vector3(...camKeys[i + 1][1]), easeInOut(q));
    // Yaw sweep inside the pipeline chapter: face stations in turn.
    if (p >= 0.44 && p <= 0.56) {
      const k = Math.min(6, Math.floor((p - 0.44) / 0.12 * 6));
      const th = -Math.PI / 2 + k * 2 * Math.PI / 7;
      pos.set(0, 0, 0);
      return { pos, look: new THREE.Vector3(9 * Math.cos(th), 0, 9 * Math.sin(th)) };
    }
    const look = new THREE.Vector3().lerpVectors(new THREE.Vector3(...camKeys[i][2]), new THREE.Vector3(...camKeys[i + 1][2]), easeInOut(q));
    return { pos, look };
  }

  // Chapter state machine
  function stateAt(p) {
    if (p < 0.07) return { a: 'home', b: 'home', q: 0 };
    if (p < 0.22) return { a: 'home', b: 'scatter', q: (p - 0.07) / 0.15 };
    if (p < 0.32) return { a: 'scatter', b: 'scatter', q: 0 };
    if (p < 0.44) return { a: 'scatter', b: 'pipeline', q: (p - 0.32) / 0.12 };
    if (p < 0.56) return { a: 'pipeline', b: 'pipeline', q: 0 };
    if (p < 0.64) return { a: 'pipeline', b: 'studio', q: (p - 0.56) / 0.08 };
    if (p < 0.78) return { a: 'studio', b: 'studio', q: 0 };
    if (p < 0.86) return { a: 'studio', b: 'hub', q: (p - 0.78) / 0.08 };
    if (p < 0.93) return { a: 'hub', b: 'hub', q: 0 };
    return { a: 'hub', b: 'final', q: (p - 0.93) / 0.07 };
  }

  const dummy = new THREE.Object3D();
  const pointer = new THREE.Vector2(0, 0);
  let pointerTarget = new THREE.Vector2(0, 0);
  addEventListener('pointermove', e => { pointerTarget.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)); });
  let p = 0, pTarget = 0, pVel = 0, lastT = performance.now();
  const track = document.getElementById('track');
  addEventListener('scroll', () => {
    const max = track.offsetHeight - innerHeight;
    const np = clamp01(window.scrollY / Math.max(1, max));
    pVel = Math.abs(np - pTarget) * 60;
    pTarget = np;
  }, { passive: true });

  const perps = [], bulges = [], spinAxes = [];
  for (let i = 0; i < N; i++) {
    perps.push(new THREE.Vector3(rng() - .5, rng() - .5, rng() - .5).normalize());
    bulges.push((hash(i + 9) - .5) * 6);
    spinAxes.push(new THREE.Vector3(rng() - .5, rng() - .5, rng() - .5).normalize());
  }
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vPos = new THREE.Vector3();
  const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qSpin = new THREE.Quaternion();
  const sizeFor = (aspect, s) => aspect === 0 ? [0.9 * s, 1.6 * s] : aspect === 1 ? [1.6 * s, 0.9 * s] : [1.1 * s, 1.1 * s];

  let fpsSamples = [], lastFpsT = performance.now(), frames = 0, degraded = 0;
  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h); composer.setSize(w, h);
  }
  addEventListener('resize', resize); resize();

  let running = true;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; });

  function frame(now) {
    requestAnimationFrame(frame);
    if (!running) return;
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    const t = now / 1000;
    // Critically damped-ish spring on p (omega 6)
    const k = 6, damp = 2 * Math.sqrt(k);
    const acc = k * (pTarget - p) - damp * pVel * 0 + 0; // simple lerp spring below
    p += (pTarget - p) * Math.min(1, dt * 6);
    pVel = Math.max(0, pVel - dt * 2.5);
    const st = stateAt(p);
    const A = states[st.a], B = states[st.b];
    const QA = stateQuats[st.a], QB = stateQuats[st.b];
    const SA = stateScales[st.a], SB = stateScales[st.b];
    mat.uniforms.uTime.value = t;
    // Crisp dissolve p 0.07–0.16
    crisp.material.opacity = p < 0.07 ? 1 : p > 0.16 ? 0 : 1 - (p - 0.07) / 0.09;
    crisp.visible = crisp.material.opacity > 0.01;
    // Gloss sweep every 6s while assembled
    const gloss = (p < 0.07 || p > 0.93) ? ((t % 6) / 0.9) : -1;
    for (let i = 0; i < N; i++) {
      const d = 0.35 * hash(i);
      const ti = clamp01((st.q - d) / 0.65);
      const e = easeInOut(ti);
      vA.copy(A[i]); vB.copy(B[i]);
      vPos.lerpVectors(vA, vB, e);
      const bulge = Math.sin(Math.PI * ti) * bulges[i];
      vPos.x += perps[i].x * bulge; vPos.y += perps[i].y * bulge; vPos.z += perps[i].z * bulge;
      // idle drift while holding
      if (st.q === 0) {
        vPos.x += Math.sin(t * .37 + seeds[i] * 6.1) * 0.2;
        vPos.y += Math.cos(t * .29 + seeds[i] * 4.3) * 0.2;
        vPos.z += Math.sin(t * .23 + seeds[i] * 9.7) * 0.2;
      }
      // studio torus slow spin
      if (st.a === 'studio' || st.b === 'studio') {
        const ang = t * 0.05;
        const x = vPos.x, z = vPos.z;
        vPos.x = x * Math.cos(ang) - z * Math.sin(ang) * 0.2;
      }
      qA.copy(QA[i]); qB.copy(QB[i]);
      qA.slerp(qB, e);
      qSpin.setFromAxisAngle(spinAxes[i], Math.sin(Math.PI * ti) * (hash(i + 3) - .5) * Math.PI * 2);
      qA.multiply(qSpin);
      let s = lerp(SA[i], SB[i], e);
      if (gloss >= 0) {
        const gx = (A[i].x / wordWidth + 0.5);
        const w = clamp01(1 - Math.abs(gloss - gx) * 3);
        s *= 1 + 0.25 * w;
      }
      const [sx, sy] = sizeFor(aspects[i], s);
      dummy.position.copy(vPos);
      dummy.quaternion.copy(qA);
      dummy.scale.set(sx, sy, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Dust drift toward camera, faster with p
    const dp = dustGeo.attributes.position.array;
    const speed = 0.4 * (1 + 6 * p) * dt;
    for (let i = 0; i < dustN; i++) {
      dp[i * 3 + 2] += speed;
      if (dp[i * 3 + 2] > 5) dp[i * 3 + 2] = -90;
    }
    dustGeo.attributes.position.needsUpdate = true;
    grid.material.opacity = 0.06 * clamp01((p - 0.30) / 0.10) * (1 - clamp01((p - 0.86) / 0.07));
    // Beacons: colour by latest agent state (set via window event from app.js)
    const agentStates = window.__agentStates || {};
    const names = ['scout', 'ingest', 'viral', 'subtitle', 'effects', 'render', 'publish'];
    beacons.forEach((b, k) => {
      const s = agentStates[names[k]] || 'standby';
      const col = s === 'done' ? 0xB9F6A6 : (s === 'running' || s === 'working') ? 0x8CE7D7 : s === 'failed' ? 0xFB7185 : s === 'degraded' ? 0xFFB58A : 0x555566;
      b.mesh.material.color.setHex(col);
      b.ring.material.color.setHex(col);
      const pulse = (s === 'running' || s === 'working') ? 0.7 + 0.3 * Math.sin(t * Math.PI * 3) : 1;
      b.mesh.scale.setScalar(pulse);
    });
    // Job packet travels the ring
    const pktT = (t * 0.5 / 7) % 1;
    const pktK = pktT * 7, pktI = Math.floor(pktK), pktF = pktK - pktI;
    const a0 = beacons[pktI % 7].mesh.position, a1 = beacons[(pktI + 1) % 7].mesh.position;
    packet.position.lerpVectors(a0, a1, pktF);
    packet.visible = p > 0.32 && p < 0.64;
    beaconGroup.visible = p > 0.32 && p < 0.64;
    // Camera
    const { pos, look } = camAt(p);
    pointer.lerp(pointerTarget, 0.06);
    camera.position.set(pos.x + pointer.x * 0.6, pos.y + pointer.y * 0.35, pos.z);
    camera.lookAt(look);
    bloom.strength = 0.9;
    composer.render();
    // FPS auto-degrade
    frames++;
    if (now - lastFpsT > 2000) {
      const fps = frames / ((now - lastFpsT) / 1000);
      frames = 0; lastFpsT = now;
      if (fps < 45 && degraded === 0) { bloom.enabled = false; degraded = 1; }
      else if (fps < 30 && degraded === 1) { renderer.setPixelRatio(1); degraded = 2; }
    }
  }
  window.__setScrollP = v => { pTarget = clamp01(v); };
  window.__sceneReady = 'ready';
  requestAnimationFrame(frame);
}

init().catch(err => {
  console.error('scene failed', err);
  document.getElementById('no-webgl').hidden = false;
  document.getElementById('gl').style.display = 'none';
  window.__sceneReady = 'fallback';
});
