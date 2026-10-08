import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { scatter, softPointsMaterial, softSprite } from "./shared";

/**
 * Overcast scene. Colours: palette.ts (`cloudy`) — flat greys, no sun.
 * Two layered cloud decks drifting at slightly different speeds.
 */
export function buildCloudyScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("cloudy", isDay, config.phase);
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, 0.018);

  // Upper deck (lit)
  const UPPER_COUNT = isMobile ? 22 : 44;
  const upperGeo = new THREE.BufferGeometry();
  upperGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(UPPER_COUNT, [-22.5, 22.5], [6, 12], [-15, 5]),
      3,
    ),
  );
  const upperMat = softPointsMaterial(THREE, sprite, {
    color: p.cloud,
    size: 6,
    opacity: 0.6,
  });
  scene.add(new THREE.Points(upperGeo, upperMat));
  disposables.push(upperGeo, upperMat);

  // Lower deck (shaded)
  const MID_COUNT = isMobile ? 16 : 32;
  const midGeo = new THREE.BufferGeometry();
  midGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(
      scatter(MID_COUNT, [-20, 20], [1, 7], [-10, 4]),
      3,
    ),
  );
  const midMat = softPointsMaterial(THREE, sprite, {
    color: p.cloudShade,
    size: 5,
    opacity: 0.55,
  });
  scene.add(new THREE.Points(midGeo, midMat));
  disposables.push(midGeo, midMat);

  const drift = (
    geo: InstanceType<typeof THREE.BufferGeometry>,
    n: number,
    dx: number,
    wrap: number,
  ) => {
    const pos = geo.attributes.position as InstanceType<
      typeof THREE.BufferAttribute
    >;
    for (let i = 0; i < n; i++) {
      pos.array[i * 3] += dx;
      if (pos.array[i * 3] > wrap) pos.array[i * 3] = -wrap;
    }
    pos.needsUpdate = true;
  };

  return {
    update(elapsed) {
      drift(upperGeo, UPPER_COUNT, 0.004, 24);
      drift(midGeo, MID_COUNT, 0.006, 22);
      upperMat.opacity = 0.6 + Math.sin(elapsed * 0.5) * 0.05;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
