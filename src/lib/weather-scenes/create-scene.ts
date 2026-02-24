import type { WeatherSceneConfig, SceneElements } from "./types";

/**
 * Dynamically import the matching scene builder for a WeatherSceneType.
 * Each scene module is code-split so only the active scene's code is loaded.
 */
async function loadSceneBuilder(
  type: WeatherSceneConfig["type"],
): Promise<
  (
    THREE: typeof import("three"),
    scene: import("three").Scene,
    config: WeatherSceneConfig,
  ) => SceneElements
> {
  switch (type) {
    case "clear": {
      const m = await import("./scenes/clear");
      return m.buildClearScene;
    }
    case "partly-cloudy": {
      const m = await import("./scenes/partly-cloudy");
      return m.buildPartlyCloudyScene;
    }
    case "cloudy": {
      const m = await import("./scenes/cloudy");
      return m.buildCloudyScene;
    }
    case "rain": {
      const m = await import("./scenes/rain");
      return m.buildRainScene;
    }
    case "thunderstorm": {
      const m = await import("./scenes/thunderstorm");
      return m.buildThunderstormScene;
    }
    case "fog": {
      const m = await import("./scenes/fog");
      return m.buildFogScene;
    }
    case "snow": {
      const m = await import("./scenes/snow");
      return m.buildSnowScene;
    }
    case "windy": {
      const m = await import("./scenes/windy");
      return m.buildWindyScene;
    }
    default: {
      // Fallback to partly-cloudy
      const m = await import("./scenes/partly-cloudy");
      return m.buildPartlyCloudyScene;
    }
  }
}

/**
 * Create a weather-condition-aware Three.js scene in the given container.
 *
 * Dynamically imports Three.js and the matching scene module,
 * sets up the renderer/camera/animation loop, and returns a dispose function.
 *
 * Gracefully handles WebGL failures — returns a no-op dispose if setup fails.
 */
export async function createWeatherScene(
  container: HTMLElement,
  config: WeatherSceneConfig,
): Promise<{ dispose: () => void }> {
  const noop = { dispose() {} };

  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width === 0 || height === 0) return noop;

  let THREE: typeof import("three");
  try {
    THREE = await import("three");
  } catch {
    return noop; // Three.js failed to load
  }

  let renderer: InstanceType<typeof THREE.WebGLRenderer>;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  } catch {
    return noop; // WebGL unavailable
  }

  renderer.setSize(width, height);
  renderer.setPixelRatio(config.isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
  camera.position.set(0, 0, 20);

  // Load and build the scene-specific elements
  let elements: SceneElements;
  try {
    const buildScene = await loadSceneBuilder(config.type);
    elements = buildScene(THREE, scene, config);
  } catch {
    // Scene module failed — clean up renderer and bail
    renderer.dispose();
    if (container.contains(renderer.domElement)) {
      container.removeChild(renderer.domElement);
    }
    return noop;
  }

  // Animation loop
  let disposed = false;
  let frameId: number;
  const clock = new THREE.Clock();

  function animate() {
    if (disposed) return;
    frameId = requestAnimationFrame(animate);
    const elapsed = clock.getElapsedTime();

    elements.update(elapsed);

    // Subtle camera drift (shared across all scenes)
    camera.position.x = Math.sin(elapsed * 0.3) * 0.5;
    camera.position.y = Math.cos(elapsed * 0.2) * 0.3;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  animate();

  // Resize handler
  function handleResize() {
    if (disposed) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", handleResize, { passive: true });

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      elements.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    },
  };
}
