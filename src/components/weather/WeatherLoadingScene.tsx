"use client";

import { useRef, useState, useEffect } from "react";

/**
 * Branded weather loading animation.
 *
 * Shows a full-screen loading overlay with the mukoko weather logo and
 * animated dots on ALL devices. On desktop (non-touch devices without
 * reduced-motion preference), a Three.js particle scene is rendered
 * behind the text for a richer experience. On mobile, the text-only
 * version is shown to conserve GPU memory.
 */
export function WeatherLoadingScene() {
  const containerRef = useRef<HTMLDivElement>(null);
  // Track whether this device should attempt the 3D scene
  const [use3D, setUse3D] = useState(false);

  // Decide once on mount whether to load Three.js.
  // Skip on mobile / touch / reduced-motion to conserve GPU memory.
  // The branded text overlay always renders regardless.
  useEffect(() => {
    try {
      const isMobile = window.matchMedia("(hover: none), (pointer: coarse)").matches;
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!isMobile && !prefersReduced) {
        setUse3D(true);
      }
    } catch {
      // matchMedia not available — skip 3D
    }
  }, []);

  useEffect(() => {
    if (!use3D) return;

    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let threeCleanup: (() => void) | null = null;

    import("three").then((THREE) => {
      if (disposed) return;

      const width = el.clientWidth;
      const height = el.clientHeight;
      if (width === 0 || height === 0) {
          return;
      }

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x0a0f1a, 0.02);

      const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
      camera.position.set(0, 0, 20);

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      } catch {
          return;
      }
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);

      // Sun glow
      const sunGeo = new THREE.SphereGeometry(3, 16, 16);
      const sunMat = new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.25 });
      const sun = new THREE.Mesh(sunGeo, sunMat);
      sun.position.set(6, 5, -10);
      scene.add(sun);

      const glowGeo = new THREE.RingGeometry(3, 6, 32);
      const glowMat = new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.08, side: THREE.DoubleSide });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.position.copy(sun.position);
      scene.add(glow);

      // Rain particles
      const RAIN_COUNT = 300;
      const rainPositions = new Float32Array(RAIN_COUNT * 3);
      const rainVelocities = new Float32Array(RAIN_COUNT);
      for (let i = 0; i < RAIN_COUNT; i++) {
        rainPositions[i * 3] = (Math.random() - 0.5) * 40;
        rainPositions[i * 3 + 1] = Math.random() * 30 - 5;
        rainPositions[i * 3 + 2] = (Math.random() - 0.5) * 30;
        rainVelocities[i] = 0.1 + Math.random() * 0.2;
      }
      const rainGeo = new THREE.BufferGeometry();
      rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3));
      const rainMat = new THREE.PointsMaterial({ color: 0x6699cc, size: 0.12, transparent: true, opacity: 0.6 });
      const rain = new THREE.Points(rainGeo, rainMat);
      scene.add(rain);

      // Cloud particles
      const CLOUD_COUNT = 40;
      const cloudPositions = new Float32Array(CLOUD_COUNT * 3);
      for (let i = 0; i < CLOUD_COUNT; i++) {
        cloudPositions[i * 3] = (Math.random() - 0.5) * 35;
        cloudPositions[i * 3 + 1] = 5 + Math.random() * 8;
        cloudPositions[i * 3 + 2] = -5 + (Math.random() - 0.5) * 15;
      }
      const cloudGeo = new THREE.BufferGeometry();
      cloudGeo.setAttribute("position", new THREE.BufferAttribute(cloudPositions, 3));
      const cloudMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, transparent: true, opacity: 0.15 });
      const clouds = new THREE.Points(cloudGeo, cloudMat);
      scene.add(clouds);

      // Zimbabwe outline
      const zwPoints = [
        new THREE.Vector3(-4, -3, 0), new THREE.Vector3(-3, 0, 0),
        new THREE.Vector3(-2, 2, 0), new THREE.Vector3(-0.5, 3, 0),
        new THREE.Vector3(1, 2.5, 0), new THREE.Vector3(3, 1, 0),
        new THREE.Vector3(4, -1, 0), new THREE.Vector3(3, -3, 0),
        new THREE.Vector3(1, -4, 0), new THREE.Vector3(-1, -3.5, 0),
        new THREE.Vector3(-4, -3, 0),
      ];
      const zwCurve = new THREE.CatmullRomCurve3(zwPoints, true, "centripetal", 0.5);
      const zwLineGeo = new THREE.BufferGeometry().setFromPoints(zwCurve.getPoints(80));
      const zwLineMat = new THREE.LineBasicMaterial({ color: 0x0047ab, transparent: true, opacity: 0.35 });
      const zwLine = new THREE.Line(zwLineGeo, zwLineMat);
      zwLine.position.set(0, -1, -2);
      scene.add(zwLine);


      // Animation loop
      let frameId: number;
      const clock = new THREE.Clock();

      function animate() {
        if (disposed) return;
        frameId = requestAnimationFrame(animate);
        const elapsed = clock.getElapsedTime();

        const pos = rainGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
        for (let i = 0; i < RAIN_COUNT; i++) {
          pos.array[i * 3 + 1] -= rainVelocities[i];
          if (pos.array[i * 3 + 1] < -10) pos.array[i * 3 + 1] = 20;
        }
        pos.needsUpdate = true;

        const cpos = cloudGeo.attributes.position as InstanceType<typeof THREE.BufferAttribute>;
        for (let i = 0; i < CLOUD_COUNT; i++) {
          cpos.array[i * 3] += 0.005;
          if (cpos.array[i * 3] > 20) cpos.array[i * 3] = -20;
        }
        cpos.needsUpdate = true;

        sunMat.opacity = 0.25 + Math.sin(elapsed * 1.5) * 0.08;
        camera.position.x = Math.sin(elapsed * 0.3) * 0.5;
        camera.position.y = Math.cos(elapsed * 0.2) * 0.3;
        camera.lookAt(0, 0, 0);
        zwLine.rotation.z = Math.sin(elapsed * 0.5) * 0.05;

        renderer.render(scene, camera);
      }
      animate();

      function handleResize() {
        if (disposed || !el) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
      window.addEventListener("resize", handleResize, { passive: true });

      const dispose = () => {
        disposed = true;
        cancelAnimationFrame(frameId);
        window.removeEventListener("resize", handleResize);
        renderer.dispose();
        rainGeo.dispose(); rainMat.dispose();
        cloudGeo.dispose(); cloudMat.dispose();
        sunGeo.dispose(); sunMat.dispose();
        glowGeo.dispose(); glowMat.dispose();
        zwLineGeo.dispose(); zwLineMat.dispose();
        if (el.contains(renderer.domElement)) {
          el.removeChild(renderer.domElement);
        }
      };

      if (disposed) {
        dispose();
      } else {
        threeCleanup = dispose;
      }
    }).catch(() => {
      // Three.js failed to load — text-only fallback is already showing
    });

    return () => {
      disposed = true;
      threeCleanup?.();
    };
  }, [use3D]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background">
      {use3D && (
        <div ref={containerRef} className="absolute inset-0" aria-hidden="true" />
      )}

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
      </div>
    </div>
  );
}
