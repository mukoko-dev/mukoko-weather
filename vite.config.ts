// Vite+ configuration: the org's standard check, lint and format settings.
// See nyuchi/.github/.github/workflows/reusable-vite-plus.yml.
//
// A plain object rather than defineConfig() from "vite-plus": this repo
// does not install vite-plus as a dependency, so `vp` comes from CI
// (voidzero-dev/setup-vp) or a global install (`npm i -g vite-plus`).
const config = {
  // `vp check` reads ONLY this block, not .oxfmtrc.json. These values mirror
  // nyuchi/.github/.oxfmtrc.json, which the org-required `vite-plus / fmt`
  // job uses on Markdown and JSON. Keep the two identical: two formatters
  // with different settings on one file can never both pass.
  fmt: {
    printWidth: 80,
    proseWrap: "preserve",
    tabWidth: 2,
    useTabs: false,
    endOfLine: "lf",
    trailingComma: "all",
    sortPackageJson: false,
    overrides: [
      {
        files: ["*.md", "*.mdx"],
        options: { embeddedLanguageFormatting: "off" },
      },
    ],
  },
  lint: {
    // Without typeCheck, `vp check` is oxlint only and passes type errors.
    options: { typeAware: true, typeCheck: true },
    // worker/ and station-console/ are separate packages with their own
    // package.json and dependencies, which the root install does not
    // provide (the root tsconfig.json excludes them for the same reason).
    // They are still format-checked.
    ignorePatterns: ["worker/**", "station-console/**"],
  },
};

export default config;
