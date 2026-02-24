import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Fog scene.
 * Dense white/grey particles at all depths, high fog density, muted palette.
 */
export function buildFogScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const disposables: { dispose(): void }[] = [];

  // Very dense fog
  scene.fog = new THREE.FogExp2(isDay ? 0xc8c8c0 : 0x1a1a20, 0.04);

  // Dense fog particles at multiple depths
  const FOG_COUNT = isMobile ? 60 : 120;
  const fogPos = new Float32Array(FOG_COUNT * 3);
  const fogDrift = new Float32Array(FOG_COUNT);
  for (let i = 0; i < FOG_COUNT; i++) {
    fogPos[i * 3] = (Math.random() - 0.5) * 35;
    fogPos[i * 3 + 1] = (Math.random() - 0.5) * 20;
    fogPos[i * 3 + 2] = (Math.random() - 0.5) * 25;
    fogDrift[i] = 0.002 + Math.random() * 0.004;
  }
  const fogGeo = new THREE.BufferGeometry();
  fogGeo.setAttribute("position", new THREE.BufferAttribute(fogPos, 3));
  const fogMat = new THREE.PointsMaterial({
    color: isDay ? 0xdddddd : 0x666677,
    size: 2.0,
    transparent: true,
    opacity: 0.12,
  });
  const fogParticles = new THREE.Points(fogGeo, fogMat);
  scene.add(fogParticles);
  disposables.push(fogGeo, fogMat);

  // Secondary — finer mist particles
  const MIST_COUNT = isMobile ? 30 : 60;
  const mistPos = new Float32Array(MIST_COUNT * 3);
  for (let i = 0; i < MIST_COUNT; i++) {
    mistPos[i * 3] = (Math.random() - 0.5) * 30;
    mistPos[i * 3 + 1] = (Math.random() - 0.5) * 15;
    mistPos[i * 3 + 2] = (Math.random() - 0.5) * 20;
  }
  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute("position", new THREE.BufferAttribute(mistPos, 3));
  const mistMat = new THREE.PointsMaterial({
    color: isDay ? 0xeeeeee : 0x555566,
    size: 0.8,
    transparent: true,
    opacity: 0.15,
  });
  const mist = new THREE.Points(mistGeo, mistMat);
  scene.add(mist);
  disposables.push(mistGeo, mistMat);

  return {
    update(elapsed) {
      // Fog drifts slowly in random directions
      const pos = fogGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < FOG_COUNT; i++) {
        pos.array[i * 3] += fogDrift[i];
        pos.array[i * 3 + 1] += Math.sin(elapsed * 0.3 + i) * 0.001;
        if (pos.array[i * 3] > 18) pos.array[i * 3] = -18;
      }
      pos.needsUpdate = true;

      // Mist has gentle vertical float
      const mpos = mistGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < MIST_COUNT; i++) {
        mpos.array[i * 3] += 0.003;
        mpos.array[i * 3 + 1] += Math.sin(elapsed * 0.5 + i * 0.3) * 0.002;
        if (mpos.array[i * 3] > 16) mpos.array[i * 3] = -16;
      }
      mpos.needsUpdate = true;

      // Opacity undulates slowly
      fogMat.opacity = 0.12 + Math.sin(elapsed * 0.3) * 0.02;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
