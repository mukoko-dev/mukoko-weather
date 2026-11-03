import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { maplibreWorkerUrl } from "@/lib/map-layers";
import {
  WORKER_FILE,
  copyWorker,
  defaultOutRoot,
  defaultPackageDir,
  relativeImports,
} from "../../scripts/lib/maplibre-worker.mjs";

// scripts/copy-maplibre-worker.mjs puts maplibre-gl's web worker under
// public/vendor/maplibre-gl/<version>/. The package has shipped two layouts
// (a thin worker importing ./maplibre-gl-shared.mjs, and one self-contained
// worker), so the script follows what the worker imports instead of a fixed
// file list. These tests run it on small synthetic packages, one per layout.

const script = resolve(__dirname, "../../scripts/copy-maplibre-worker.mjs");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "copy-maplibre-worker-"));
  temps.push(dir);
  return dir;
}

/** Writes a fake maplibre-gl package: package.json plus dist/<files>. */
function fakePackage(version: string, dist: Record<string, string>): string {
  const packageDir = join(temp(), "maplibre-gl");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version }));
  for (const [name, text] of Object.entries(dist)) {
    mkdirSync(dirname(join(packageDir, "dist", name)), { recursive: true });
    writeFileSync(join(packageDir, "dist", name), text);
  }
  return packageDir;
}

function runScript(
  packageDir: string,
  outRoot: string,
  scriptPath: string = script,
) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--from", packageDir, "--out-root", outRoot],
    { encoding: "utf8" },
  );
}

/** Every file under `dir`, relative to it, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), path);
      else out.push(path);
    }
  };
  walk(dir, "");
  return out.sort();
}

describe("relativeImports", () => {
  it("reads the minified static import of the two-file layout", () => {
    const source = `/** license */\nimport{a as e,b as t}from"./maplibre-gl-shared.mjs";let n=1;`;
    expect(relativeImports(source)).toEqual(["./maplibre-gl-shared.mjs"]);
  });

  it("reads spaced and single-quoted static imports", () => {
    expect(
      relativeImports(
        `import { x } from './a.mjs';\nimport y from "../b.mjs";`,
      ),
    ).toEqual(["./a.mjs", "../b.mjs"]);
  });

  it("reads re-exports, bare imports and dynamic imports", () => {
    expect(
      relativeImports(
        `export*from"./re.mjs";import"./side.mjs";const m=await import("./lazy.mjs");`,
      ),
    ).toEqual(["./re.mjs", "./side.mjs", "./lazy.mjs"]);
  });

  it("lists specifiers in the order they appear in the source", () => {
    // Each pattern is matched separately, so the order must come from where
    // the match sits in the file, not from which pattern found it.
    expect(
      relativeImports(
        `import"./side.mjs";import{a}from"./x.mjs";import("./lazy.mjs");export*from"./re.mjs";`,
      ),
    ).toEqual(["./side.mjs", "./x.mjs", "./lazy.mjs", "./re.mjs"]);
  });

  it("lists each module once", () => {
    expect(
      relativeImports(`import{a}from"./x.mjs";import{b}from"./x.mjs";`),
    ).toEqual(["./x.mjs"]);
  });

  it("reads nothing from a self-contained worker", () => {
    const source =
      "var e=Object.create;te(self)&&(self.worker=new dC(self));export{dC as default};\n" +
      "//# sourceMappingURL=maplibre-gl-worker.mjs.map";
    expect(relativeImports(source)).toEqual([]);
  });

  it("leaves out package names, URLs and root-relative paths", () => {
    expect(
      relativeImports(
        `import{a}from"some-package";import{b}from"https://cdn.example/x.mjs";import{c}from"/abs/x.mjs";`,
      ),
    ).toEqual([]);
  });
});

describe("copyWorker, two-file layout (worker imports ./maplibre-gl-shared.mjs)", () => {
  const dist = {
    [WORKER_FILE]: `import{a as e}from"./maplibre-gl-shared.mjs";e();`,
    "maplibre-gl-worker.mjs.map": "{}",
    "maplibre-gl-shared.mjs": "export const a=()=>{};",
    "maplibre-gl-shared.mjs.map": "{}",
    "maplibre-gl.mjs": "// the main bundle is not copied",
    "maplibre-gl.css": "/* nor the stylesheet */",
  };

  it("copies the worker, the shared module it imports, and both source maps", () => {
    const packageDir = fakePackage("6.12.0", dist);
    const outRoot = temp();
    const result = copyWorker({ packageDir, outRoot });
    expect(result.version).toBe("6.12.0");
    expect(result.files).toEqual([WORKER_FILE, "maplibre-gl-shared.mjs"]);
    expect(listFiles(join(outRoot, "6.12.0"))).toEqual([
      "maplibre-gl-shared.mjs",
      "maplibre-gl-shared.mjs.map",
      "maplibre-gl-worker.mjs",
      "maplibre-gl-worker.mjs.map",
    ]);
    expect(
      readFileSync(join(outRoot, "6.12.0", "maplibre-gl-shared.mjs"), "utf8"),
    ).toBe(dist["maplibre-gl-shared.mjs"]);
  });

  it("runs from the command line and names what it copied", () => {
    const packageDir = fakePackage("6.12.0", dist);
    const outRoot = temp();
    const run = runScript(packageDir, outRoot);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("maplibre-gl 6.12.0");
    expect(run.stdout).toContain(
      "maplibre-gl-worker.mjs, maplibre-gl-shared.mjs",
    );
    expect(existsSync(join(outRoot, "6.12.0", "maplibre-gl-shared.mjs"))).toBe(
      true,
    );
  });
});

describe("copyWorker, single-file layout (self-contained worker)", () => {
  const dist = {
    [WORKER_FILE]:
      "/** license */var e=1;te(self)&&(self.worker=new dC(self));export{dC as default};",
    "maplibre-gl-worker.mjs.map": "{}",
    // 6.13 and later still list an empty placeholder that nothing refers to.
    "maplibre-gl-shared.mjs": "",
    "maplibre-gl-shared-dev.mjs": "",
    "maplibre-gl.mjs": "// main bundle",
  };

  it("copies the worker alone and leaves the unreferenced placeholder", () => {
    const packageDir = fakePackage("6.16.0", dist);
    const outRoot = temp();
    const result = copyWorker({ packageDir, outRoot });
    expect(result.files).toEqual([WORKER_FILE]);
    expect(listFiles(join(outRoot, "6.16.0"))).toEqual([
      "maplibre-gl-worker.mjs",
      "maplibre-gl-worker.mjs.map",
    ]);
  });

  it("runs from the command line without needing a shared module", () => {
    const packageDir = fakePackage("6.16.0", dist);
    const outRoot = temp();
    const run = runScript(packageDir, outRoot);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("maplibre-gl 6.16.0");
    expect(run.stdout).toContain("(maplibre-gl-worker.mjs)");
  });

  it("copies a worker without a source map", () => {
    const packageDir = fakePackage("6.16.0", {
      [WORKER_FILE]: "export default 1;",
    });
    const outRoot = temp();
    copyWorker({ packageDir, outRoot });
    expect(listFiles(join(outRoot, "6.16.0"))).toEqual([WORKER_FILE]);
  });
});

describe("copyWorker, modules reached through other modules", () => {
  it("follows imports transitively and keeps sub-folders", () => {
    const packageDir = fakePackage("7.0.0", {
      [WORKER_FILE]: `import{a}from"./chunks/core.mjs";`,
      "chunks/core.mjs": `import{b}from"../shared.mjs";import"./core.mjs";export const a=b;`,
      "chunks/core.mjs.map": "{}",
      "shared.mjs": "export const b=1;",
    });
    const outRoot = temp();
    const result = copyWorker({ packageDir, outRoot });
    expect(result.files).toEqual([
      WORKER_FILE,
      "chunks/core.mjs",
      "shared.mjs",
    ]);
    expect(listFiles(join(outRoot, "7.0.0"))).toEqual([
      "chunks/core.mjs",
      "chunks/core.mjs.map",
      "maplibre-gl-worker.mjs",
      "shared.mjs",
    ]);
  });

  it("resolves a specifier that carries a query string", () => {
    const packageDir = fakePackage("7.0.0", {
      [WORKER_FILE]: `import{a}from"./shared.mjs?v=1";`,
      "shared.mjs": "export const a=1;",
    });
    const outRoot = temp();
    expect(copyWorker({ packageDir, outRoot }).files).toEqual([
      WORKER_FILE,
      "shared.mjs",
    ]);
  });
});

describe("copyWorker fails loudly instead of shipping a worker that cannot start", () => {
  it("refuses a worker that imports a module dist/ does not contain", () => {
    const packageDir = fakePackage("6.12.0", {
      [WORKER_FILE]: `import{a}from"./maplibre-gl-shared.mjs";`,
    });
    const outRoot = temp();
    expect(() => copyWorker({ packageDir, outRoot })).toThrow(
      /maplibre-gl-shared\.mjs is missing/,
    );
    // Nothing half-copied is left for the build to serve.
    expect(existsSync(join(outRoot, "6.12.0"))).toBe(false);
  });

  it("exits non-zero and says which module is missing", () => {
    const packageDir = fakePackage("6.12.0", {
      [WORKER_FILE]: `import{a}from"./gone.mjs";`,
    });
    const outRoot = temp();
    const run = runScript(packageDir, outRoot);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("gone.mjs is missing");
    expect(run.stderr).toContain("maplibre-gl-worker.mjs");
    expect(listFiles(outRoot)).toEqual([]);
  });

  it("finds a missing module two levels down", () => {
    const packageDir = fakePackage("6.12.0", {
      [WORKER_FILE]: `import"./a.mjs";`,
      "a.mjs": `import"./b.mjs";`,
    });
    expect(() => copyWorker({ packageDir, outRoot: temp() })).toThrow(
      /b\.mjs is missing/,
    );
  });

  it("refuses a package without a worker", () => {
    const packageDir = fakePackage("6.12.0", { "maplibre-gl.mjs": "" });
    expect(() => copyWorker({ packageDir, outRoot: temp() })).toThrow(
      /maplibre-gl-worker\.mjs is missing/,
    );
  });

  it("refuses an import that leaves dist/", () => {
    const packageDir = fakePackage("6.12.0", {
      [WORKER_FILE]: `import"../package.json";`,
    });
    expect(() => copyWorker({ packageDir, outRoot: temp() })).toThrow(
      /outside dist/,
    );
  });

  it("rejects unknown command-line options", () => {
    const run = spawnSync(process.execPath, [script, "--nope", "x"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("usage:");
  });
});

describe("copyWorker replaces the version folder instead of adding to it", () => {
  it("removes files left by an earlier run and keeps everything outside the folder", () => {
    const outRoot = temp();
    const stale = join(outRoot, "6.16.0");
    mkdirSync(join(stale, "old-chunks"), { recursive: true });
    writeFileSync(join(stale, "maplibre-gl-shared.mjs"), "stale shared");
    writeFileSync(join(stale, "maplibre-gl-worker.mjs"), "stale worker");
    writeFileSync(join(stale, "old-chunks", "gone.mjs"), "stale chunk");
    // Neighbours: another version's folder and a file beside the folders.
    mkdirSync(join(outRoot, "6.12.0"), { recursive: true });
    writeFileSync(join(outRoot, "6.12.0", "maplibre-gl-shared.mjs"), "keep");
    writeFileSync(join(outRoot, "notes.txt"), "keep");

    const packageDir = fakePackage("6.16.0", {
      [WORKER_FILE]: "export default 1;",
    });
    copyWorker({ packageDir, outRoot });

    expect(listFiles(stale)).toEqual([WORKER_FILE]);
    expect(readFileSync(join(stale, WORKER_FILE), "utf8")).toBe(
      "export default 1;",
    );
    expect(listFiles(outRoot)).toEqual([
      "6.12.0/maplibre-gl-shared.mjs",
      "6.16.0/maplibre-gl-worker.mjs",
      "notes.txt",
    ]);
    expect(
      readFileSync(join(outRoot, "6.12.0", "maplibre-gl-shared.mjs"), "utf8"),
    ).toBe("keep");
  });

  it("leaves the previous copy alone when the new package is broken", () => {
    const outRoot = temp();
    mkdirSync(join(outRoot, "6.16.0"), { recursive: true });
    writeFileSync(join(outRoot, "6.16.0", WORKER_FILE), "previous");
    const packageDir = fakePackage("6.16.0", {
      [WORKER_FILE]: `import"./gone.mjs";`,
    });
    expect(() => copyWorker({ packageDir, outRoot })).toThrow(/gone\.mjs/);
    expect(readFileSync(join(outRoot, "6.16.0", WORKER_FILE), "utf8")).toBe(
      "previous",
    );
  });

  it.each(["", ".", "..", "../escape", "a/b", "a\\b", "/abs"])(
    "refuses a package version that could name a folder elsewhere (%j)",
    (version) => {
      const outRoot = temp();
      const marker = join(outRoot, "marker.txt");
      writeFileSync(marker, "keep");
      const packageDir = fakePackage(version, {
        [WORKER_FILE]: "export default 1;",
      });
      expect(() => copyWorker({ packageDir, outRoot })).toThrow(/version/);
      expect(readFileSync(marker, "utf8")).toBe("keep");
    },
  );
});

describe("where the npm scripts read from and write to", () => {
  const repoRoot = resolve(__dirname, "../..");

  it("reads the maplibre-gl package the repo has installed", () => {
    expect(realpathSync(defaultPackageDir(repoRoot))).toBe(
      realpathSync(join(repoRoot, "node_modules", "maplibre-gl")),
    );
  });

  it("writes where the served worker URL points, under public/", () => {
    // /vendor/maplibre-gl/<version>/<worker> is served from public/, so the
    // folder the script fills must be exactly that path.
    const outRoot = defaultOutRoot(repoRoot);
    expect(join(outRoot, "6.12.0", WORKER_FILE)).toBe(
      join(repoRoot, "public", maplibreWorkerUrl("6.12.0")),
    );
  });
});

describe("the command line works through a symlinked path", () => {
  // Node sets import.meta.url from the real path but argv[1] keeps the
  // symlink, so an entry guard comparing the two (the first version of this
  // script had one) never ran main(): the script exited 0 having copied
  // nothing and the build shipped without the worker. The entry now always
  // runs, and these keep it that way.
  const scriptsDir = resolve(__dirname, "../../scripts");

  function linkedScript(kind: "directory" | "file"): string {
    const links = temp();
    if (kind === "directory") {
      symlinkSync(scriptsDir, join(links, "linked-scripts"), "dir");
      return join(links, "linked-scripts", "copy-maplibre-worker.mjs");
    }
    symlinkSync(script, join(links, "linked-copy.mjs"));
    return join(links, "linked-copy.mjs");
  }

  it.each(["directory", "file"] as const)(
    "copies the worker when the script is reached through a symlinked %s",
    (kind) => {
      const packageDir = fakePackage("6.16.0", {
        [WORKER_FILE]: "export default 1;",
        "maplibre-gl-worker.mjs.map": "{}",
      });
      const outRoot = temp();
      const run = runScript(packageDir, outRoot, linkedScript(kind));
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("maplibre-gl 6.16.0");
      expect(listFiles(join(outRoot, "6.16.0"))).toEqual([
        "maplibre-gl-worker.mjs",
        "maplibre-gl-worker.mjs.map",
      ]);
    },
  );

  it.each(["directory", "file"] as const)(
    "exits 1 for a missing worker when reached through a symlinked %s",
    (kind) => {
      const packageDir = fakePackage("6.16.0", { "maplibre-gl.mjs": "" });
      const outRoot = temp();
      const run = runScript(packageDir, outRoot, linkedScript(kind));
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("maplibre-gl-worker.mjs is missing");
      expect(listFiles(outRoot)).toEqual([]);
    },
  );

  it("fails the same way when no path is symlinked", () => {
    const packageDir = fakePackage("6.16.0", { "maplibre-gl.mjs": "" });
    const run = runScript(packageDir, temp());
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("maplibre-gl-worker.mjs is missing");
  });
});
