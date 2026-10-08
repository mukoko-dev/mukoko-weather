import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { scatter, softPointsMaterial, softSprite } from "./shared";

/**
 * Fog / mist scene, also used for haze, smoke and dust.
 * Colours: palette.ts — `fog` is desaturated pale grey; `haze` is warm tan /
 * ochre with a dimmed sun showing through. Dense soft wisps at every depth.
 */
export function buildFogScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const isHaze = config.type === "haze";
  const p = getScenePalette(isHaze ? "haze" : "fog", isDay, config.phase);
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, isHaze ? 0.03 : 0.04);

  // Haze: a dimmed, diffuse sun disc behind the dust
  let sunMat: InstanceType<typeof THREE.MeshBasicMaterial> | null = null;
  if (isHaze && isDay) {
    const sunGeo = new THREE.SphereGeometry(2.6, 16, 16);
    sunMat = new THREE.MeshBasicMaterial({
      color: p.body,
      transparent: true,
      opacity: 0.45,
    });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(5, 6, -12);
    scene.add(sun);
    disposables.push(sunGeo, sunMat);
  }

  // Dense wisps
  const FOG_COUNT = isMobile ? 50 : 100;
  const fogDrift = new Float32Array(FOG_COUNT);
  for (let i = 0; i < FOG_COUNT; i++)
    fogDrift[i] = 0.002 + Math.random() * 0.004;
  const fogGeo = new THREE.BufferGeometry();
  fogGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(FOG_COUNT, [-17.5, 17.5], [-10, 10], [-12.5, 12.5]),
      3,
    ),
  );
  const fogMat = softPointsMaterial(THREE, sprite, {
    color: p.cloud,
    size: 9,
    opacity: 0.22,
  });
  scene.add(new THREE.Points(fogGeo, fogMat));
  disposables.push(fogGeo, fogMat);

  // Finer mist (fog) / suspended dust (haze)
  const MIST_COUNT = isMobile ? 30 : 60;
  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(MIST_COUNT, [-15, 15], [-7.5, 7.5], [-10, 10]),
      3,
    ),
  );
  const mistMat = softPointsMaterial(THREE, sprite, {
    color: p.particle,
    size: isHaze ? 0.5 : 2.4,
    opacity: isHaze ? 0.6 : 0.35,
  });
  scene.add(new THREE.Points(mistGeo, mistMat));
  disposables.push(mistGeo, mistMat);

  return {
    update(elapsed) {
      const pos = fogGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < FOG_COUNT; i++) {
        pos.array[i * 3] += fogDrift[i];
        pos.array[i * 3 + 1] += Math.sin(elapsed * 0.3 + i) * 0.001;
        if (pos.array[i * 3] > 18) pos.array[i * 3] = -18;
      }
      pos.needsUpdate = true;

      const mpos = mistGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < MIST_COUNT; i++) {
        mpos.array[i * 3] += 0.003;
        mpos.array[i * 3 + 1] += Math.sin(elapsed * 0.5 + i * 0.3) * 0.002;
        if (mpos.array[i * 3] > 16) mpos.array[i * 3] = -16;
      }
      mpos.needsUpdate = true;

      fogMat.opacity = 0.22 + Math.sin(elapsed * 0.3) * 0.03;
      if (sunMat) sunMat.opacity = 0.45 + Math.sin(elapsed * 0.4) * 0.05;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
