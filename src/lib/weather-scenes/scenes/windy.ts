import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { scatter, softPointsMaterial, softSprite } from "./shared";

/**
 * Windy scene. Colours: palette.ts (`windy`) — neutral streaks racing over
 * the base (clear / partly-cloudy) sky, fast-moving clouds, sun or moon.
 */
export function buildWindyScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("windy", isDay, config.phase);
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);
  const windStrength = Math.min((config.windSpeed ?? 45) / 100, 1); // 0–1

  scene.fog = new THREE.FogExp2(p.fog, 0.012);

  // Sun / moon
  const bodyGeo = new THREE.SphereGeometry(
    2.5,
    isMobile ? 8 : 16,
    isMobile ? 8 : 16,
  );
  const bodyMat = new THREE.MeshBasicMaterial({
    color: p.body,
    transparent: true,
    opacity: 0.8,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(5, 7, -12);
  scene.add(body);
  disposables.push(bodyGeo, bodyMat);

  // Fast clouds
  const CLOUD_COUNT = isMobile ? 14 : 28;
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(CLOUD_COUNT, [-22.5, 22.5], [3, 11], [-12.5, 2.5]),
      3,
    ),
  );
  const cloudMat = softPointsMaterial(THREE, sprite, {
    color: p.cloud,
    size: 4.5,
    opacity: 0.6,
  });
  scene.add(new THREE.Points(cloudGeo, cloudMat));
  disposables.push(cloudGeo, cloudMat);

  // Wind streaks — short horizontal lines
  const STREAK_COUNT = isMobile ? 40 : 90;
  const streakLen = 1.2 + windStrength * 1.2;
  const streakPos = new Float32Array(STREAK_COUNT * 6);
  const streakSpeed = new Float32Array(STREAK_COUNT);
  const placeStreak = (i: number, x: number) => {
    const y = (Math.random() - 0.5) * 20;
    const z = (Math.random() - 0.5) * 30;
    streakPos[i * 6] = x;
    streakPos[i * 6 + 1] = y;
    streakPos[i * 6 + 2] = z;
    streakPos[i * 6 + 3] = x + streakLen;
    streakPos[i * 6 + 4] = y;
    streakPos[i * 6 + 5] = z;
  };
  for (let i = 0; i < STREAK_COUNT; i++) {
    placeStreak(i, (Math.random() - 0.5) * 45);
    streakSpeed[i] = 0.06 + Math.random() * 0.1;
  }
  const streakGeo = new THREE.BufferGeometry();
  streakGeo.setAttribute("position", new THREE.BufferAttribute(streakPos, 3));
  const streakMat = new THREE.LineBasicMaterial({
    color: p.particle,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  scene.add(new THREE.LineSegments(streakGeo, streakMat));
  disposables.push(streakGeo, streakMat);

  const cloudSpeed = 0.015 + windStrength * 0.02;

  return {
    update(elapsed) {
      const cpos = cloudGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += cloudSpeed;
        if (cpos.array[i * 3] > 24) cpos.array[i * 3] = -24;
      }
      cpos.needsUpdate = true;

      const spos = streakGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      const a = spos.array as Float32Array;
      for (let i = 0; i < STREAK_COUNT; i++) {
        const dx = streakSpeed[i] * (1 + windStrength);
        const dy = Math.sin(elapsed * 2 + i) * 0.006;
        a[i * 6] += dx;
        a[i * 6 + 3] += dx;
        a[i * 6 + 1] += dy;
        a[i * 6 + 4] += dy;
        if (a[i * 6] > 24) placeStreak(i, -24 - streakLen);
      }
      spos.needsUpdate = true;

      bodyMat.opacity = 0.8 + Math.sin(elapsed * 3) * 0.06;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
