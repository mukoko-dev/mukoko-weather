import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { rainStreaks, scatter, softPointsMaterial, softSprite } from "./shared";

/**
 * Rain scene. Colours: palette.ts (`rain`) — blue-grey sky, darker clouds,
 * grey-blue streaks for the drops, falling on a slight wind slant.
 */
export function buildRainScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("rain", isDay, config.phase);
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, 0.02);

  // Rain cloud deck
  const CLOUD_COUNT = isMobile ? 24 : 44;
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(CLOUD_COUNT, [-20, 20], [6, 12], [-12.5, 2.5]),
      3,
    ),
  );
  const cloudMat = softPointsMaterial(THREE, sprite, {
    color: p.cloud,
    size: 6,
    opacity: 0.65,
  });
  scene.add(new THREE.Points(cloudGeo, cloudMat));
  disposables.push(cloudGeo, cloudMat);

  // Rain streaks
  const windDrift = (config.windSpeed ?? 10) * 0.0005;
  const rain = rainStreaks(THREE, {
    count: isMobile ? 160 : 380,
    spreadX: 40,
    spreadZ: 30,
    length: 0.9,
    slant: 0.08,
    minSpeed: 0.18,
    maxSpeed: 0.34,
    color: p.particle,
    opacity: 0.6,
  });
  scene.add(rain.object);
  disposables.push(rain.geometry, rain.material);

  return {
    update(elapsed) {
      rain.step(windDrift);
      const cpos = cloudGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += 0.005;
        if (cpos.array[i * 3] > 22) cpos.array[i * 3] = -22;
      }
      cpos.needsUpdate = true;
      cloudMat.opacity = 0.65 + Math.sin(elapsed * 0.6) * 0.05;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
