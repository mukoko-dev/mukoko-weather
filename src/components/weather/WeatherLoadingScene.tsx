"use client";

import { useRef, useEffect, useState } from "react";

/**
 * Three.js weather loading animation.
 *
 * Renders a particle-based weather scene with floating raindrops, clouds,
 * and a warm sun glow over a stylised Zimbabwe silhouette. The scene is
 * dynamically imported so it doesn't block initial HTML delivery.
 */
export function WeatherLoadingScene() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;

    // Dynamic import keeps three.js out of the initial bundle
    import("three").then((THREE) => {
      if (disposed) return;

      // ---- Setup ----
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width === 0 || height === 0) return;

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x0a0f1a, 0.02);

      const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
      camera.position.set(0, 0, 20);

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      } catch {
        // WebGL unavailable (headless browser, low memory, etc.)
        setReady(true);
        return;
      }
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);

      // ---- Sun glow (warm sphere at back) ----
      const sunGeo = new THREE.SphereGeometry(3, 16, 16);
      const sunMat = new THREE.MeshBasicMaterial({
        color: 0xffaa33,
        transparent: true,
        opacity: 0.25,
      });
      const sun = new THREE.Mesh(sunGeo, sunMat);
      sun.position.set(6, 5, -10);
      scene.add(sun);

      // Outer glow ring
      const glowGeo = new THREE.RingGeometry(3, 6, 32);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffcc66,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.copy(sun.position);
      scene.add(glow);

      // ---- Rain particles ----
      const RAIN_COUNT = 300;
      const rainPositions = new Float32Array(RAIN_COUNT * 3);
      const rainVelocities = new Float32Array(RAIN_COUNT);
      for (let i = 0; i < RAIN_COUNT; i++) {
        rainPositions[i * 3] = (Math.random() - 0.5) * 40;     // x
        rainPositions[i * 3 + 1] = Math.random() * 30 - 5;     // y
        rainPositions[i * 3 + 2] = (Math.random() - 0.5) * 30; // z
        rainVelocities[i] = 0.1 + Math.random() * 0.2;
      }

      const rainGeo = new THREE.BufferGeometry();
      rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
      const rainMat = new THREE.PointsMaterial({
        color: 0x6699cc,
        size: 0.12,
        transparent: true,
        opacity: 0.6,
      });
      const rain = new THREE.Points(rainGeo, rainMat);
      scene.add(rain);

      // ---- Cloud particles (larger, slower) ----
      const CLOUD_COUNT = 40;
      const cloudPositions = new Float32Array(CLOUD_COUNT * 3);
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cloudPositions[i * 3] = (Math.random() - 0.5) * 35;
        cloudPositions[i * 3 + 1] = 5 + Math.random() * 8;
        cloudPositions[i * 3 + 2] = -5 + (Math.random() - 0.5) * 15;
      }

      const cloudGeo = new THREE.BufferGeometry();
      cloudGeo.setAttribute("position", new THREE.BufferAttribute(cloudPositions, 3));
      const cloudMat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 1.2,
        transparent: true,
        opacity: 0.15,
      });
      const clouds = new THREE.Points(cloudGeo, cloudMat);
      scene.add(clouds);

      // ---- Zimbabwe outline (simplified Great Dyke ridge line) ----
      const zwPoints = [
        new THREE.Vector3(-4, -3, 0),
        new THREE.Vector3(-3, 0, 0),
        new THREE.Vector3(-2, 2, 0),
        new THREE.Vector3(-0.5, 3, 0),
        new THREE.Vector3(1, 2.5, 0),
        new THREE.Vector3(3, 1, 0),
        new THREE.Vector3(4, -1, 0),
        new THREE.Vector3(3, -3, 0),
        new THREE.Vector3(1, -4, 0),
        new THREE.Vector3(-1, -3.5, 0),
        new THREE.Vector3(-4, -3, 0),
      ];
      const zwCurve = new THREE.CatmullRomCurve3(zwPoints, true, "centripetal", 0.5);
      const zwLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(zwCurve.getPoints(80)),
        new THREE.LineBasicMaterial({ color: 0x0047ab, transparent: true, opacity: 0.35 }),
      );
      zwLine.position.set(0, -1, -2);
      scene.add(zwLine);

      setReady(true);

      // ---- Animation loop ----
      let frameId: number;
      const clock = new THREE.Clock();

      function animate() {
        if (disposed) return;
        frameId = requestAnimationFrame(animate);
        const elapsed = clock.getElapsedTime();

        // Rain falling
        const pos = rainGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
        for (let i = 0; i < RAIN_COUNT; i++) {
          pos.array[i * 3 + 1] -= rainVelocities[i];
          if (pos.array[i * 3 + 1] < -10) {
            pos.array[i * 3 + 1] = 20;
          }
        }
        pos.needsUpdate = true;

        // Clouds drifting
        const cpos = cloudGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
        for (let i = 0; i < CLOUD_COUNT; i++) {
          cpos.array[i * 3] += 0.005;
          if (cpos.array[i * 3] > 20) cpos.array[i * 3] = -20;
        }
        cpos.needsUpdate = true;

        // Sun pulse
        const pulse = 0.25 + Math.sin(elapsed * 1.5) * 0.08;
        sunMat.opacity = pulse;

        // Gentle camera sway
        camera.position.x = Math.sin(elapsed * 0.3) * 0.5;
        camera.position.y = Math.cos(elapsed * 0.2) * 0.3;
        camera.lookAt(0, 0, 0);

        // Zimbabwe outline gentle rotation
        zwLine.rotation.z = Math.sin(elapsed * 0.5) * 0.05;

        renderer.render(scene, camera);
      }

      animate();

      // ---- Resize handler ----
      function handleResize() {
        if (disposed || !el) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
      window.addEventListener("resize", handleResize);

      // ---- Cleanup ----
      return () => {
        disposed = true;
        cancelAnimationFrame(frameId);
        window.removeEventListener("resize", handleResize);
        renderer.dispose();
        rainGeo.dispose();
        rainMat.dispose();
        cloudGeo.dispose();
        cloudMat.dispose();
        sunGeo.dispose();
        sunMat.dispose();
        glowGeo.dispose();
        glowMat.dispose();
        if (el.contains(renderer.domElement)) {
          el.removeChild(renderer.domElement);
        }
      };
    }).catch(() => {
      // Three.js failed to load (network error, chunk failure, etc.)
      // Show the text-only loading state instead of crashing
      if (!disposed) setReady(true);
    });

    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      {/* Three.js canvas fills the background */}
      <div
        ref={containerRef}
        className="absolute inset-0"
        aria-hidden="true"
      />

      {/* Bold text overlay */}
      <div className="relative z-10 flex flex-col items-center gap-6 px-4 text-center" role="status">
        <h2 className="font-heading text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl md:text-6xl">
          <span className="text-primary">mukoko</span>{" "}
          <span className="text-text-secondary">weather</span>
        </h2>
        <p className="text-lg font-medium text-text-tertiary sm:text-xl">
          Preparing your forecast
        </p>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
        </div>
        <span className="sr-only">Loading weather data for your location</span>
        {/* Show a subtle hint while three.js loads */}
        {!ready && (
          <p className="text-xs text-text-tertiary animate-pulse">Loading scene...</p>
        )}
      </div>
    </div>
  );
}
