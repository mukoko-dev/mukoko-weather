import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Partly cloudy scene.
 * Day: dimmed sun + scattered cloud clusters drifting + light breeze particles.
 * Night: moonlit clouds with cool blue palette.
 */
export function buildPartlyCloudyScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const geoDetail = isMobile ? 8 : 16;
  const disposables: { dispose(): void }[] = [];

  scene.fog = new THREE.FogExp2(isDay ? 0xa8c8e8 : 0x0a0f2a, 0.012);

  // Sun or moon
  const bodyGeo = new THREE.SphereGeometry(3, geoDetail, geoDetail);
  const bodyMat = new THREE.MeshBasicMaterial({
    color: isDay ? 0xffaa33 : 0xc0c0d0,
    transparent: true,
    opacity: 0.2,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(isDay ? 6 : -5, 6, -10);
  scene.add(body);
  disposables.push(bodyGeo, bodyMat);

  // Glow
  const glowGeo = new THREE.RingGeometry(3, 5.5, isMobile ? 16 : 32);
  const glowMat = new THREE.MeshBasicMaterial({
    color: isDay ? 0xffcc66 : 0x8888bb,
    transparent: true,
    opacity: 0.06,
    side: THREE.DoubleSide,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.copy(body.position);
  scene.add(glow);
  disposables.push(glowGeo, glowMat);

  // Cloud clusters
  const CLOUD_COUNT = isMobile ? 15 : 30;
  const cloudPos = new Float32Array(CLOUD_COUNT * 3);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    cloudPos[i * 3] = (Math.random() - 0.5) * 40;
    cloudPos[i * 3 + 1] = 4 + Math.random() * 8;
    cloudPos[i * 3 + 2] = -5 + (Math.random() - 0.5) * 15;
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute("position", new THREE.BufferAttribute(cloudPos, 3));
  const cloudMat = new THREE.PointsMaterial({
    color: isDay ? 0xffffff : 0x8888aa,
    size: 1.4,
    transparent: true,
    opacity: 0.2,
  });
  const clouds = new THREE.Points(cloudGeo, cloudMat);
  scene.add(clouds);
  disposables.push(cloudGeo, cloudMat);

  // Breeze particles
  const BREEZE_COUNT = isMobile ? 20 : 50;
  const breezePos = new Float32Array(BREEZE_COUNT * 3);
  for (let i = 0; i < BREEZE_COUNT; i++) {
    breezePos[i * 3] = (Math.random() - 0.5) * 40;
    breezePos[i * 3 + 1] = (Math.random() - 0.5) * 20;
    breezePos[i * 3 + 2] = (Math.random() - 0.5) * 30;
  }
  const breezeGeo = new THREE.BufferGeometry();
  breezeGeo.setAttribute("position", new THREE.BufferAttribute(breezePos, 3));
  const breezeMat = new THREE.PointsMaterial({
    color: isDay ? 0xdddddd : 0x6666aa,
    size: 0.08,
    transparent: true,
    opacity: 0.3,
  });
  const breeze = new THREE.Points(breezeGeo, breezeMat);
  scene.add(breeze);
  disposables.push(breezeGeo, breezeMat);

  return {
    update(elapsed) {
      bodyMat.opacity = 0.2 + Math.sin(elapsed * 1.0) * 0.05;

      // Clouds drift right
      const cpos = cloudGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += 0.006;
        if (cpos.array[i * 3] > 22) cpos.array[i * 3] = -22;
      }
      cpos.needsUpdate = true;

      // Breeze particles drift
      const bpos = breezeGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < BREEZE_COUNT; i++) {
        bpos.array[i * 3] += 0.01;
        bpos.array[i * 3 + 1] += Math.sin(elapsed + i * 0.5) * 0.002;
        if (bpos.array[i * 3] > 22) bpos.array[i * 3] = -22;
      }
      bpos.needsUpdate = true;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
