// Builds the Vercel Build Output API (v3) directly, as Vercel's buildCommand.
//
// Why: Vercel's zero-config packaging has repeatedly fought us in two
// different ways over time:
//   1. Its automatic dependency bundler (@vercel/nft) failed to trace/include
//      specific transitive files needed by otherwise-ordinary packages
//      (iconv-lite's encoding tables, zod's locale files, https-proxy-agent's
//      ./agent module) — each fix just uncovered the next one.
//   2. Its newer "services"/zero-config Express detection ignores a custom
//      buildCommand's actual output entirely and re-derives its own handler
//      from package.json's `main`/tsconfig conventions (dist/app.js), which
//      this repo doesn't build that way for Vercel.
// Producing `.vercel/output` ourselves sidesteps both: once a buildCommand
// populates `.vercel/output` directly, Vercel deploys it as-is with no
// zero-config interpretation of vercel.json, package.json, or framework
// detection at all — for both `vercel deploy` and git-triggered builds.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNC_DIR = path.join(ROOT, '.vercel', 'output', 'functions', 'index.func');

// Native/binary modules — these ship compiled .node bindings or platform-
// specific binaries and cannot be inlined into a JS bundle. They're copied
// into the function directory as real files below, at the same relative
// path (node_modules/<pkg>) the bundled code expects to require() them from.
const EXTERNAL = ['sharp', 'bcrypt'];

// Sharp >=0.32 delegates its actual compiled binding to a separate
// platform-specific scoped package (e.g. @img/sharp-linux-x64), not
// node_modules/sharp itself — both must be copied. detect-libc and semver
// are sharp's own (hoisted, top-level) dependencies, required at import
// time by sharp.cjs to pick the right libvips binary — not bundled by
// esbuild since sharp itself is external, so they need copying too.
const NATIVE_MODULE_DIRS = ['sharp', 'bcrypt', '@img', 'detect-libc', 'semver'];

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  resetDir(path.join(ROOT, '.vercel', 'output'));
  fs.mkdirSync(path.join(FUNC_DIR, 'api'), { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'app.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(FUNC_DIR, 'api', 'index.js'),
    external: EXTERNAL,
    logLevel: 'info',
  });

  const funcNodeModules = path.join(FUNC_DIR, 'node_modules');
  fs.mkdirSync(funcNodeModules, { recursive: true });
  for (const name of NATIVE_MODULE_DIRS) {
    const src = path.join(ROOT, 'node_modules', name);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(funcNodeModules, name), { recursive: true });
    }
  }

  // Logo/seal assets read via path.join(__dirname, '..', 'templates', ...)
  // from services/*.ts — __dirname inside the deployed function is
  // .../index.func/api, so templates/ needs to sit one level up from that,
  // i.e. directly inside index.func, mirroring the original project layout.
  const templatesSrc = path.join(ROOT, 'templates');
  if (fs.existsSync(templatesSrc)) {
    fs.cpSync(templatesSrc, path.join(FUNC_DIR, 'templates'), { recursive: true });
  }

  fs.writeFileSync(
    path.join(FUNC_DIR, '.vc-config.json'),
    JSON.stringify({
      runtime: 'nodejs20.x',
      handler: 'api/index.js',
      launcherType: 'Nodejs',
      shouldAddHelpers: true,
    }, null, 2)
  );

  fs.writeFileSync(
    path.join(ROOT, '.vercel', 'output', 'config.json'),
    JSON.stringify({
      version: 3,
      routes: [
        { src: '/(.*)', dest: '/index' },
      ],
    }, null, 2)
  );

  console.log('Build Output API written to .vercel/output');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
