import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Thunderstorm scene.
 * Heavy rain + periodic lightning flashes (emissive white burst) + dark sky.
 */
export function buildThunderstormScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isMobile } = config;
  const disposables: { dispose(): void }[] = [];

  // Very dark sky
  scene.fog = new THREE.FogExp2(0x080a12, 0.022);

  // Dark cloud layer
  const CLOUD_COUNT = isMobile ? 20 : 40;
  const cloudPos = new Float32Array(CLOUD_COUNT * 3);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    cloudPos[i * 3] = (Math.random() - 0.5) * 45;
    cloudPos[i * 3 + 1] = 5 + Math.random() * 7;
    cloudPos[i * 3 + 2] = -5 + (Math.random() - 0.5) * 18;
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute("position", new THREE.BufferAttribute(cloudPos, 3));
  const cloudMat = new THREE.PointsMaterial({
    color: 0x333344,
    size: 2.0,
    transparent: true,
    opacity: 0.3,
  });
  const clouds = new THREE.Points(cloudGeo, cloudMat);
  scene.add(clouds);
  disposables.push(cloudGeo, cloudMat);

  // Heavy rain
  const RAIN_COUNT = isMobile ? 150 : 350;
  const rainPos = new Float32Array(RAIN_COUNT * 3);
  const rainVel = new Float32Array(RAIN_COUNT);
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPos[i * 3] = (Math.random() - 0.5) * 45;
    rainPos[i * 3 + 1] = Math.random() * 35 - 5;
    rainPos[i * 3 + 2] = (Math.random() - 0.5) * 35;
    rainVel[i] = 0.15 + Math.random() * 0.25;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.PointsMaterial({
    color: 0x5577aa,
    size: 0.14,
    transparent: true,
    opacity: 0.5,
  });
  const rain = new THREE.Points(rainGeo, rainMat);
  scene.add(rain);
  disposables.push(rainGeo, rainMat);

  // Lightning flash — ambient light that flashes white
  const flashLight = new THREE.AmbientLight(0xffffff, 0);
  scene.add(flashLight);

  // Lightning state
  let nextFlash = 2 + Math.random() * 3; // first flash in 2-5s
  let flashIntensity = 0;

  return {
    update(elapsed) {
      // Rain falls with wind drift
      const pos = rainGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < RAIN_COUNT; i++) {
        pos.array[i * 3 + 1] -= rainVel[i];
        pos.array[i * 3] += 0.008; // wind
        if (pos.array[i * 3 + 1] < -10) {
          pos.array[i * 3 + 1] = 22;
          pos.array[i * 3] = (Math.random() - 0.5) * 45;
        }
      }
      pos.needsUpdate = true;

      // Clouds drift
      const cpos = cloudGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += 0.008;
        if (cpos.array[i * 3] > 24) cpos.array[i * 3] = -24;
      }
      cpos.needsUpdate = true;

      // Lightning flash logic
      if (elapsed >= nextFlash && flashIntensity <= 0) {
        flashIntensity = 1.0;
        nextFlash = elapsed + 3 + Math.random() * 4; // next flash in 3-7s
      }

      if (flashIntensity > 0) {
        flashIntensity -= 0.08; // rapid decay
        if (flashIntensity < 0) flashIntensity = 0;
        flashLight.intensity = flashIntensity * 2;
        // Flash brightens clouds and rain momentarily
        cloudMat.opacity = 0.3 + flashIntensity * 0.4;
        rainMat.opacity = 0.5 + flashIntensity * 0.3;
      } else {
        flashLight.intensity = 0;
        cloudMat.opacity = 0.3 + Math.sin(elapsed * 0.4) * 0.03;
        rainMat.opacity = 0.5;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
