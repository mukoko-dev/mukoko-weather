import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { scatter, softGlow, softPointsMaterial, softSprite } from "./shared";

/**
 * Partly cloudy scene. Colours: palette.ts (`partly-cloudy`).
 * Day: blue sky, yellow-white sun, white and light-grey clouds drifting.
 * Night: moon with grey moonlit clouds over navy.
 */
export function buildPartlyCloudyScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("partly-cloudy", isDay, config.phase);
  const geoDetail = isMobile ? 8 : 16;
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, 0.012);

  // Sun or moon
  const bodyGeo = new THREE.SphereGeometry(
    isDay ? 3 : 2.3,
    geoDetail,
    geoDetail,
  );
  const bodyMat = new THREE.MeshBasicMaterial({
    color: p.body,
    transparent: true,
    opacity: 0.85,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(isDay ? 6 : -5, 6, -10);
  scene.add(body);
  disposables.push(bodyGeo, bodyMat);

  const glow = softGlow(THREE, sprite, {
    color: p.glow,
    size: 16,
    opacity: 0.4,
    position: body.position,
  });
  const glowMat = glow.material;
  scene.add(glow.object);
  disposables.push(glow.geometry, glowMat);

  // Clouds: shaded underside layer + lit tops, in front of the sun
  const SHADE_COUNT = isMobile ? 12 : 22;
  const TOP_COUNT = isMobile ? 18 : 34;
  const shadeGeo = new THREE.BufferGeometry();
  shadeGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(SHADE_COUNT, [-20, 20], [3, 9], [-8, 4]),
      3,
    ),
  );
  const shadeMat = softPointsMaterial(THREE, sprite, {
    color: p.cloudShade,
    size: 5,
    opacity: 0.55,
  });
  scene.add(new THREE.Points(shadeGeo, shadeMat));
  disposables.push(shadeGeo, shadeMat);

  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(TOP_COUNT, [-20, 20], [4, 11], [-6, 6]),
      3,
    ),
  );
  const cloudMat = softPointsMaterial(THREE, sprite, {
    color: p.cloud,
    size: 4.2,
    opacity: 0.7,
  });
  scene.add(new THREE.Points(cloudGeo, cloudMat));
  disposables.push(cloudGeo, cloudMat);

  // Light breeze
  const BREEZE_COUNT = isMobile ? 20 : 50;
  const breezeGeo = new THREE.BufferGeometry();
  breezeGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(BREEZE_COUNT, [-20, 20], [-10, 10], [-15, 15]),
      3,
    ),
  );
  const breezeMat = softPointsMaterial(THREE, sprite, {
    color: p.particle,
    size: 0.25,
    opacity: 0.45,
  });
  scene.add(new THREE.Points(breezeGeo, breezeMat));
  disposables.push(breezeGeo, breezeMat);

  const drift = (
    geo: InstanceType<typeof THREE.BufferGeometry>,
    n: number,
    dx: number,
  ) => {
    const pos = geo.attributes.position as InstanceType<
      typeof THREE.BufferAttribute
    >;
    for (let i = 0; i < n; i++) {
      pos.array[i * 3] += dx;
      if (pos.array[i * 3] > 22) pos.array[i * 3] = -22;
    }
    pos.needsUpdate = true;
  };

  return {
    update(elapsed) {
      bodyMat.opacity = 0.85 + Math.sin(elapsed * 1.0) * 0.06;
      drift(shadeGeo, SHADE_COUNT, 0.005);
      drift(cloudGeo, TOP_COUNT, 0.006);
      const bpos = breezeGeo.attributes.position as InstanceType<
        typeof THREE.BufferAttribute
      >;
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
