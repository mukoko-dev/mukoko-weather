import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { scatter, softPointsMaterial, softSprite } from "./shared";

/**
 * Snow scene. Colours: palette.ts (`snow`) — pale grey-white sky, soft cloud
 * deck, slow swaying white flakes and a faint snow-glow at ground level.
 */
export function buildSnowScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("snow", isDay, config.phase);
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, 0.015);

  // Snow cloud deck
  const CLOUD_COUNT = isMobile ? 16 : 30;
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(CLOUD_COUNT, [-20, 20], [7, 13], [-12, 2]),
      3,
    ),
  );
  const cloudMat = softPointsMaterial(THREE, sprite, {
    color: p.cloudShade,
    size: 6,
    opacity: 0.5,
  });
  scene.add(new THREE.Points(cloudGeo, cloudMat));
  disposables.push(cloudGeo, cloudMat);

  // Flakes — larger and slower than rain, with sway
  const SNOW_COUNT = isMobile ? 95 : 210;
  const snowVel = new Float32Array(SNOW_COUNT);
  const snowSway = new Float32Array(SNOW_COUNT);
  for (let i = 0; i < SNOW_COUNT; i++) {
    snowVel[i] = 0.02 + Math.random() * 0.04;
    snowSway[i] = 0.5 + Math.random() * 1.5;
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(SNOW_COUNT, [-20, 20], [-5, 25], [-15, 15]),
      3,
    ),
  );
  const snowMat = softPointsMaterial(THREE, sprite, {
    color: p.particle,
    size: 0.55,
    opacity: 0.95,
  });
  scene.add(new THREE.Points(snowGeo, snowMat));
  disposables.push(snowGeo, snowMat);

  // Ground snow-glow
  const groundGeo = new THREE.PlaneGeometry(50, 50);
  const groundMat = new THREE.MeshBasicMaterial({
    color: p.cloud,
    transparent: true,
    opacity: 0.12,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -8;
  scene.add(ground);
  disposables.push(groundGeo, groundMat);

  return {
    update(elapsed) {
      const pos = snowGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < SNOW_COUNT; i++) {
        pos.array[i * 3 + 1] -= snowVel[i];
        pos.array[i * 3] += Math.sin(elapsed * snowSway[i] + i) * 0.003;
        if (pos.array[i * 3 + 1] < -8) {
          pos.array[i * 3 + 1] = 22;
          pos.array[i * 3] = (Math.random() - 0.5) * 40;
        }
      }
      pos.needsUpdate = true;

      const cpos = cloudGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cpos.array[i * 3] += 0.003;
        if (cpos.array[i * 3] > 22) cpos.array[i * 3] = -22;
      }
      cpos.needsUpdate = true;

      groundMat.opacity = 0.12 + Math.sin(elapsed * 0.4) * 0.03;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
