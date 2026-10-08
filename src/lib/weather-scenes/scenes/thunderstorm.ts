import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { rainStreaks, scatter, softPointsMaterial, softSprite } from "./shared";

/**
 * Thunderstorm scene. Colours: palette.ts (`thunderstorm`) — dark slate /
 * charcoal clouds, heavy grey-blue rain, and a brief white-violet lightning
 * flash that lights the sky (a full-frame plane) and the cloud deck.
 */
export function buildThunderstormScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("thunderstorm", isDay, config.phase);
  const flashColour = p.flash ?? p.particle;
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, 0.022);

  // Lightning sheet — behind everything, invisible until a strike
  const flashGeo = new THREE.PlaneGeometry(120, 80);
  const flashMat = new THREE.MeshBasicMaterial({
    color: flashColour,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false, // a strike lights the whole sky, not a fogged far plane
  });
  const flashPlane = new THREE.Mesh(flashGeo, flashMat);
  flashPlane.position.set(0, 0, -25);
  scene.add(flashPlane);
  disposables.push(flashGeo, flashMat);

  // Storm cloud deck: charcoal underside + slate tops
  const SHADE_COUNT = isMobile ? 18 : 34;
  const TOP_COUNT = isMobile ? 16 : 30;
  const shadeGeo = new THREE.BufferGeometry();
  shadeGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(SHADE_COUNT, [-22.5, 22.5], [4, 10], [-12, 4]),
      3,
    ),
  );
  const shadeMat = softPointsMaterial(THREE, sprite, {
    color: p.cloudShade,
    size: 6.5,
    opacity: 0.75,
  });
  scene.add(new THREE.Points(shadeGeo, shadeMat));
  disposables.push(shadeGeo, shadeMat);

  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(TOP_COUNT, [-22.5, 22.5], [7, 13], [-14, 2]),
      3,
    ),
  );
  const cloudColour = new THREE.Color(p.cloud);
  const cloudFlash = new THREE.Color(flashColour);
  const cloudMat = softPointsMaterial(THREE, sprite, {
    color: p.cloud,
    size: 6,
    opacity: 0.7,
  });
  scene.add(new THREE.Points(cloudGeo, cloudMat));
  disposables.push(cloudGeo, cloudMat);

  // Heavy rain
  const rain = rainStreaks(THREE, {
    count: isMobile ? 190 : 440,
    spreadX: 45,
    spreadZ: 35,
    length: 1.1,
    slant: 0.14,
    minSpeed: 0.22,
    maxSpeed: 0.42,
    color: p.particle,
    opacity: 0.6,
  });
  scene.add(rain.object);
  disposables.push(rain.geometry, rain.material);

  // Lightning state: a strike is a sharp double flicker then a fast decay.
  let nextFlash = 2 + Math.random() * 3; // first strike in 2–5 s
  let strikeAt = -1;

  return {
    update(elapsed) {
      rain.step(0.008);

      const cpos = cloudGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < TOP_COUNT; i++) {
        cpos.array[i * 3] += 0.008;
        if (cpos.array[i * 3] > 24) cpos.array[i * 3] = -24;
      }
      cpos.needsUpdate = true;
      const spos = shadeGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
      for (let i = 0; i < SHADE_COUNT; i++) {
        spos.array[i * 3] += 0.006;
        if (spos.array[i * 3] > 24) spos.array[i * 3] = -24;
      }
      spos.needsUpdate = true;

      if (elapsed >= nextFlash) {
        strikeAt = elapsed;
        nextFlash = elapsed + 3 + Math.random() * 4; // next in 3–7 s
      }

      // 0 → 1 → 0.35 → 0.9 → decay, over ~0.45 s
      let flash = 0;
      if (strikeAt >= 0) {
        const t = elapsed - strikeAt;
        if (t < 0.06) flash = 1;
        else if (t < 0.12) flash = 0.35;
        else if (t < 0.18) flash = 0.9;
        else if (t < 0.45) flash = 0.9 * (1 - (t - 0.18) / 0.27);
        else strikeAt = -1;
      }

      flashMat.opacity = flash * 0.55;
      cloudMat.color.copy(cloudColour).lerp(cloudFlash, flash * 0.6);
      cloudMat.opacity = 0.7 + flash * 0.25;
      rain.material.opacity = 0.6 + flash * 0.3;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
