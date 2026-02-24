import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Clear sky scene.
 * Day: bright sun sphere + golden glow ring + warm dust motes floating slowly.
 * Night: moon sphere + tiny star points + cool blue palette.
 */
export function buildClearScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const geoDetail = isMobile ? 8 : 16;
  const disposables: { dispose(): void }[] = [];

  // Sky color via fog
  scene.fog = new THREE.FogExp2(isDay ? 0x87ceeb : 0x0a0f2a, 0.008);

  if (isDay) {
    // Sun
    const sunGeo = new THREE.SphereGeometry(4, geoDetail, geoDetail);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xffcc33,
      transparent: true,
      opacity: 0.35,
    });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    sun.position.set(6, 6, -12);
    scene.add(sun);
    disposables.push(sunGeo, sunMat);

    // Glow ring
    const glowGeo = new THREE.RingGeometry(4, 8, isMobile ? 16 : 32);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xffdd66,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.copy(sun.position);
    scene.add(glow);
    disposables.push(glowGeo, glowMat);

    // Dust motes
    const DUST_COUNT = isMobile ? 30 : 80;
    const dustPos = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      dustPos[i * 3] = (Math.random() - 0.5) * 40;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 25;
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * 30;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0xffd700,
      size: 0.15,
      transparent: true,
      opacity: 0.4,
    });
    const dust = new THREE.Points(dustGeo, dustMat);
    scene.add(dust);
    disposables.push(dustGeo, dustMat);

    return {
      update(elapsed) {
        sunMat.opacity = 0.35 + Math.sin(elapsed * 1.2) * 0.08;
        glowMat.opacity = 0.1 + Math.sin(elapsed * 0.8) * 0.03;
        // Gentle float
        const pos = dustGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
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

  // Night scene
  const moonGeo = new THREE.SphereGeometry(3, geoDetail, geoDetail);
  const moonMat = new THREE.MeshBasicMaterial({
    color: 0xc0c0d0,
    transparent: true,
    opacity: 0.3,
  });
  const moon = new THREE.Mesh(moonGeo, moonMat);
  moon.position.set(-5, 7, -12);
  scene.add(moon);
  disposables.push(moonGeo, moonMat);

  // Stars
  const STAR_COUNT = isMobile ? 40 : 100;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    starPos[i * 3] = (Math.random() - 0.5) * 50;
    starPos[i * 3 + 1] = Math.random() * 20;
    starPos[i * 3 + 2] = -10 - Math.random() * 20;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.1,
    transparent: true,
    opacity: 0.7,
  });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);
  disposables.push(starGeo, starMat);

  return {
    update(elapsed) {
      moonMat.opacity = 0.3 + Math.sin(elapsed * 0.8) * 0.05;
      starMat.opacity = 0.5 + Math.sin(elapsed * 2) * 0.2;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
