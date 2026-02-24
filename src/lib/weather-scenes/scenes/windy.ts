import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Windy scene.
 * Fast directional particles (leaves/debris), all elements lean in wind direction,
 * rapid cloud movement.
 */
export function buildWindyScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const disposables: { dispose(): void }[] = [];
  const windStrength = Math.min((config.windSpeed ?? 45) / 100, 1); // 0-1 normalized

  scene.fog = new THREE.FogExp2(isDay ? 0xb0b8c4 : 0x101420, 0.012);

  // Sun/moon — low visibility
  const bodyGeo = new THREE.SphereGeometry(2.5, isMobile ? 8 : 16, isMobile ? 8 : 16);
  const bodyMat = new THREE.MeshBasicMaterial({
    color: isDay ? 0xddcc88 : 0x8888aa,
    transparent: true,
    opacity: 0.12,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(5, 7, -12);
  scene.add(body);
  disposables.push(bodyGeo, bodyMat);

  // Fast clouds
  const CLOUD_COUNT = isMobile ? 15 : 30;
  const cloudPos = new Float32Array(CLOUD_COUNT * 3);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    cloudPos[i * 3] = (Math.random() - 0.5) * 45;
    cloudPos[i * 3 + 1] = 3 + Math.random() * 8;
    cloudPos[i * 3 + 2] = -5 + (Math.random() - 0.5) * 15;
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute("position", new THREE.BufferAttribute(cloudPos, 3));
  const cloudMat = new THREE.PointsMaterial({
    color: isDay ? 0xcccccc : 0x555566,
    size: 1.5,
    transparent: true,
    opacity: 0.2,
  });
  const clouds = new THREE.Points(cloudGeo, cloudMat);
  scene.add(clouds);
  disposables.push(cloudGeo, cloudMat);

  // Wind debris particles — fast horizontal movement
  const DEBRIS_COUNT = isMobile ? 40 : 100;
  const debrisPos = new Float32Array(DEBRIS_COUNT * 3);
  const debrisSpeed = new Float32Array(DEBRIS_COUNT);
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    debrisPos[i * 3] = (Math.random() - 0.5) * 45;
    debrisPos[i * 3 + 1] = (Math.random() - 0.5) * 20;
    debrisPos[i * 3 + 2] = (Math.random() - 0.5) * 30;
    debrisSpeed[i] = 0.03 + Math.random() * 0.06;
  }
  const debrisGeo = new THREE.BufferGeometry();
  debrisGeo.setAttribute("position", new THREE.BufferAttribute(debrisPos, 3));
  const debrisMat = new THREE.PointsMaterial({
    color: isDay ? 0x8b7355 : 0x665544,
    size: 0.15,
    transparent: true,
    opacity: 0.45,
  });
  const debris = new THREE.Points(debrisGeo, debrisMat);
  scene.add(debris);
  disposables.push(debrisGeo, debrisMat);

  const cloudSpeed = 0.015 + windStrength * 0.02;

  return {
    update(elapsed) {
      // Fast cloud movement
      const cpos = cloudGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += cloudSpeed;
        if (cpos.array[i * 3] > 24) cpos.array[i * 3] = -24;
      }
      cpos.needsUpdate = true;

      // Debris flies fast in wind direction with turbulence
      const dpos = debrisGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < DEBRIS_COUNT; i++) {
        dpos.array[i * 3] += debrisSpeed[i] * (1 + windStrength);
        // Vertical turbulence
        dpos.array[i * 3 + 1] += Math.sin(elapsed * 3 + i) * 0.01;
        if (dpos.array[i * 3] > 24) {
          dpos.array[i * 3] = -24;
          dpos.array[i * 3 + 1] = (Math.random() - 0.5) * 20;
        }
      }
      dpos.needsUpdate = true;

      // Sun flickers behind fast clouds
      bodyMat.opacity = 0.12 + Math.sin(elapsed * 3) * 0.04;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
