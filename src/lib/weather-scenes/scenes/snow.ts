import type { WeatherSceneConfig, SceneElements } from "../types";

/**
 * Snow scene.
 * Large slow-falling snowflake particles, soft white ground glow, cold blue ambient.
 */
export function buildSnowScene(
  THREE: typeof import("three"),
  scene: import("three").Scene,
  config: WeatherSceneConfig,
): SceneElements {
  const { isDay, isMobile } = config;
  const geoDetail = isMobile ? 8 : 16;
  const disposables: { dispose(): void }[] = [];

  // Cold blue-white fog
  scene.fog = new THREE.FogExp2(isDay ? 0xd0d8e8 : 0x101828, 0.015);

  // Snowflakes — larger and slower than rain
  const SNOW_COUNT = isMobile ? 60 : 150;
  const snowPos = new Float32Array(SNOW_COUNT * 3);
  const snowVel = new Float32Array(SNOW_COUNT);
  const snowSway = new Float32Array(SNOW_COUNT);
  for (let i = 0; i < SNOW_COUNT; i++) {
    snowPos[i * 3] = (Math.random() - 0.5) * 40;
    snowPos[i * 3 + 1] = Math.random() * 30 - 5;
    snowPos[i * 3 + 2] = (Math.random() - 0.5) * 30;
    snowVel[i] = 0.02 + Math.random() * 0.04; // much slower than rain
    snowSway[i] = 0.5 + Math.random() * 1.5; // horizontal sway frequency
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute("position", new THREE.BufferAttribute(snowPos, 3));
  const snowMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.25, // bigger than rain
    transparent: true,
    opacity: 0.7,
  });
  const snow = new THREE.Points(snowGeo, snowMat);
  scene.add(snow);
  disposables.push(snowGeo, snowMat);

  // Ground glow — soft white plane
  const groundGeo = new THREE.PlaneGeometry(50, 50);
  const groundMat = new THREE.MeshBasicMaterial({
    color: isDay ? 0xeeeef4 : 0x2a2a3a,
    transparent: true,
    opacity: 0.08,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -8;
  scene.add(ground);
  disposables.push(groundGeo, groundMat);

  // Dim sun/moon behind clouds
  const bodyGeo = new THREE.SphereGeometry(2, geoDetail, geoDetail);
  const bodyMat = new THREE.MeshBasicMaterial({
    color: isDay ? 0xaabbcc : 0x8888aa,
    transparent: true,
    opacity: 0.1,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(5, 8, -15);
  scene.add(body);
  disposables.push(bodyGeo, bodyMat);

  return {
    update(elapsed) {
      const pos = snowGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
      for (let i = 0; i < SNOW_COUNT; i++) {
        pos.array[i * 3 + 1] -= snowVel[i];
        // Horizontal sway
        pos.array[i * 3] += Math.sin(elapsed * snowSway[i] + i) * 0.003;
        if (pos.array[i * 3 + 1] < -8) {
          pos.array[i * 3 + 1] = 22;
          pos.array[i * 3] = (Math.random() - 0.5) * 40;
        }
      }
      pos.needsUpdate = true;

      // Gentle opacity pulse on ground
      groundMat.opacity = 0.08 + Math.sin(elapsed * 0.4) * 0.02;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
