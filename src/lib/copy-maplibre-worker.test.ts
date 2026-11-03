import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import {
  WORKER_FILE,
  copyWorker,
  relativeImports,
} from "../../scripts/copy-maplibre-worker.mjs";

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

function runScript(packageDir: string, outRoot: string) {
  return spawnSync(
    process.execPath,
    [script, "--from", packageDir, "--out-root", outRoot],
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
