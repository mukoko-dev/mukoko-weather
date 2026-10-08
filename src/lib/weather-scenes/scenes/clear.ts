import type { WeatherSceneConfig, SceneElements } from "../types";
import { getScenePalette } from "../palette";
import { scatter, softGlow, softPointsMaterial, softSprite } from "./shared";

/**
 * Clear sky scene. Colours: palette.ts (`clear`).
 * Day: warm yellow-white sun + soft halo + faint sunlit motes.
 * Night: cool white moon + twinkling cool white stars over deep navy.
 * Dawn/dusk (phase): the sun and halo warm to orange/pink.
 */
export function buildClearScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const p = getScenePalette("clear", isDay, config.phase);
  const geoDetail = isMobile ? 8 : 16;
  const sprite = softSprite(THREE);
  const disposables: { dispose(): void }[] = [];
  if (sprite) disposables.push(sprite);

  scene.fog = new THREE.FogExp2(p.fog, 0.008);

  if (isDay) {
    // Sun — low at dawn/dusk, high otherwise
    const twilight = config.phase === "dawn" || config.phase === "dusk";
    const sunGeo = new THREE.SphereGeometry(3.4, geoDetail, geoDetail);
    const sunMat = new THREE.MeshBasicMaterial({
      color: p.body,
      transparent: true,
      opacity: 0.85,
    });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(6, twilight ? -2 : 6, -12);
    scene.add(sun);
    disposables.push(sunGeo, sunMat);

    // Halo
    const glow = softGlow(THREE, sprite, {
      color: p.glow,
      size: 22,
      opacity: 0.5,
      position: sun.position,
    });
    const glowMat = glow.material;
    scene.add(glow.object);
    disposables.push(glow.geometry, glowMat);

    // Sunlit motes
    const DUST_COUNT = isMobile ? 40 : 100;
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        scatter(DUST_COUNT, [-20, 20], [-12.5, 12.5], [-15, 15]),
        3,
      ),
    );
    const dustMat = softPointsMaterial(THREE, sprite, {
      color: p.particle,
      size: 0.35,
      opacity: 0.55,
    });
    scene.add(new THREE.Points(dustGeo, dustMat));
    disposables.push(dustGeo, dustMat);

    return {
      update(elapsed) {
        sunMat.opacity = 0.85 + Math.sin(elapsed * 1.2) * 0.06;
        glowMat.opacity = 0.5 + Math.sin(elapsed * 0.8) * 0.08;
        const pos = dustGeo.attributes.position as InstanceType<
          typeof THREE.BufferAttribute
        >;
        for (let i = 0; i < DUST_COUNT; i++) {
          pos.array[i * 3 + 1] += Math.sin(elapsed + i) * 0.002;
          pos.array[i * 3] += 0.003;
          if (pos.array[i * 3] > 20) pos.array[i * 3] = -20;
        }
        pos.needsUpdate = true;
      },
      dispose() {
        for (const d of disposables) d.dispose();
      },
    };
  }

  // Night — moon
  const moonGeo = new THREE.SphereGeometry(2.4, geoDetail, geoDetail);
  const moonMat = new THREE.MeshBasicMaterial({
    color: p.body,
    transparent: true,
    opacity: 0.9,
  });
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.set(-5, 7, -12);
  scene.add(moon);
  disposables.push(moonGeo, moonMat);

  const moonGlow = softGlow(THREE, sprite, {
    color: p.glow,
    size: 12,
    opacity: 0.3,
    position: moon.position,
  });
  const moonGlowMat = moonGlow.material;
  scene.add(moonGlow.object);
  disposables.push(moonGlow.geometry, moonGlowMat);

  // Stars — two twinkle groups out of phase
  const STAR_COUNT = isMobile ? 70 : 150;
  const half = Math.floor(STAR_COUNT / 2);
  const starMats = [0, 1].map(() =>
    softPointsMaterial(THREE, sprite, {
      color: p.particle,
      size: 0.32,
      opacity: 0.9,
    }),
  );
  [half, STAR_COUNT - half].forEach((n, k) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(scatter(n, [-25, 25], [0, 20], [-30, -10]), 3),
    );
    scene.add(new THREE.Points(geo, starMats[k]));
    disposables.push(geo, starMats[k]);
  });

  return {
    update(elapsed) {
      moonMat.opacity = 0.9 + Math.sin(elapsed * 0.8) * 0.05;
      starMats[0].opacity = 0.7 + Math.sin(elapsed * 2) * 0.25;
      starMats[1].opacity = 0.7 + Math.cos(elapsed * 1.6) * 0.25;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
