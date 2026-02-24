import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Overcast scene.
 * Dense layered cloud particles, no visible sun, grey tones, muted palette.
 */
export function buildCloudyScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const disposables: { dispose(): void }[] = [];

  scene.fog = new THREE.FogExp2(isDay ? 0x9aa8b8 : 0x181c24, 0.018);

  // Dense upper cloud layer
  const UPPER_COUNT = isMobile ? 20 : 40;
  const upperPos = new Float32Array(UPPER_COUNT * 3);
  for (let i = 0; i < UPPER_COUNT; i++) {
    upperPos[i * 3] = (Math.random() - 0.5) * 45;
    upperPos[i * 3 + 1] = 6 + Math.random() * 6;
    upperPos[i * 3 + 2] = -5 + (Math.random() - 0.5) * 20;
  }
  const upperGeo = new THREE.BufferGeometry();
  upperGeo.setAttribute("position", new THREE.BufferAttribute(upperPos, 3));
  const upperMat = new THREE.PointsMaterial({
    color: isDay ? 0xcccccc : 0x555566,
    size: 1.8,
    transparent: true,
    opacity: 0.25,
  });
  const upper = new THREE.Points(upperGeo, upperMat);
  scene.add(upper);
  disposables.push(upperGeo, upperMat);

  // Mid cloud layer
  const MID_COUNT = isMobile ? 15 : 30;
  const midPos = new Float32Array(MID_COUNT * 3);
  for (let i = 0; i < MID_COUNT; i++) {
    midPos[i * 3] = (Math.random() - 0.5) * 40;
    midPos[i * 3 + 1] = 2 + Math.random() * 5;
    midPos[i * 3 + 2] = -3 + (Math.random() - 0.5) * 15;
  }
  const midGeo = new THREE.BufferGeometry();
  midGeo.setAttribute("position", new THREE.BufferAttribute(midPos, 3));
  const midMat = new THREE.PointsMaterial({
    color: isDay ? 0xbbbbbb : 0x444455,
    size: 1.4,
    transparent: true,
    opacity: 0.2,
  });
  const mid = new THREE.Points(midGeo, midMat);
  scene.add(mid);
  disposables.push(midGeo, midMat);

  return {
    update(elapsed) {
      // Upper layer drifts slowly right
      const upos = upperGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < UPPER_COUNT; i++) {
        upos.array[i * 3] += 0.004;
        if (upos.array[i * 3] > 24) upos.array[i * 3] = -24;
      }
      upos.needsUpdate = true;

      // Mid layer drifts slightly faster
      const mpos = midGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < MID_COUNT; i++) {
        mpos.array[i * 3] += 0.006;
        if (mpos.array[i * 3] > 22) mpos.array[i * 3] = -22;
      }
      mpos.needsUpdate = true;

      // Subtle opacity pulse
      upperMat.opacity = 0.25 + Math.sin(elapsed * 0.5) * 0.03;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
