import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Rain scene.
 * Rain streak particles falling at an angle, cloud layer above, blue-grey fog.
 */
export function buildRainScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const disposables: { dispose(): void }[] = [];

  scene.fog = new THREE.FogExp2(isDay ? 0x6688aa : 0x0c1018, 0.02);

  // Cloud layer
  const CLOUD_COUNT = isMobile ? 15 : 30;
  const cloudPos = new Float32Array(CLOUD_COUNT * 3);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    cloudPos[i * 3] = (Math.random() - 0.5) * 40;
    cloudPos[i * 3 + 1] = 6 + Math.random() * 6;
    cloudPos[i * 3 + 2] = -5 + (Math.random() - 0.5) * 15;
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute("position", new THREE.BufferAttribute(cloudPos, 3));
  const cloudMat = new THREE.PointsMaterial({
    color: isDay ? 0xaaaaaa : 0x444455,
    size: 1.5,
    transparent: true,
    opacity: 0.2,
  });
  const clouds = new THREE.Points(cloudGeo, cloudMat);
  scene.add(clouds);
  disposables.push(cloudGeo, cloudMat);

  // Rain particles
  const RAIN_COUNT = isMobile ? 120 : 300;
  const rainPos = new Float32Array(RAIN_COUNT * 3);
  const rainVel = new Float32Array(RAIN_COUNT);
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPos[i * 3] = (Math.random() - 0.5) * 40;
    rainPos[i * 3 + 1] = Math.random() * 30 - 5;
    rainPos[i * 3 + 2] = (Math.random() - 0.5) * 30;
    rainVel[i] = 0.12 + Math.random() * 0.18;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.PointsMaterial({
    color: isDay ? 0x6699cc : 0x4477aa,
    size: 0.12,
    transparent: true,
    opacity: 0.55,
  });
  const rain = new THREE.Points(rainGeo, rainMat);
  scene.add(rain);
  disposables.push(rainGeo, rainMat);

  // Wind angle for rain drift
  const windDrift = (config.windSpeed ?? 10) * 0.0005;

  return {
    update(elapsed) {
      // Rain falls and drifts
      const pos = rainGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < RAIN_COUNT; i++) {
        pos.array[i * 3 + 1] -= rainVel[i];
        pos.array[i * 3] += windDrift; // slight wind drift
        if (pos.array[i * 3 + 1] < -10) {
          pos.array[i * 3 + 1] = 20;
          pos.array[i * 3] = (Math.random() - 0.5) * 40;
        }
      }
      pos.needsUpdate = true;

      // Clouds drift
      const cpos = cloudGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += 0.005;
        if (cpos.array[i * 3] > 22) cpos.array[i * 3] = -22;
      }
      cpos.needsUpdate = true;

      // Pulsing cloud opacity
      cloudMat.opacity = 0.2 + Math.sin(elapsed * 0.6) * 0.04;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
