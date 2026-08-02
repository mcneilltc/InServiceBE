// Bundles app.ts (and its entire non-native require graph) into a single
// self-contained api/index.js file using esbuild, run as Vercel's buildCommand
// before its own function detection/packaging kicks in.
//
// Why: Vercel's automatic dependency bundler (@vercel/nft) repeatedly failed
// to trace/include specific transitive files needed by otherwise-ordinary
// packages (iconv-lite's encoding tables, zod's locale files, https-proxy-
// agent's ./agent module) — each fix just uncovered the next one. Pre-
// bundling everything into one file removes the loose require() graph that
// NFT has to guess about; only genuinely native/binary modules (which can't
// be bundled into plain JS at all) are left as real files on disk, via
// `external` below and vercel.json's includeFiles.
const esbuild = require('esbuild');
const path = require('path');

// Native/binary modules — these ship compiled .node bindings or platform-
// specific binaries and cannot be inlined into a JS bundle. They stay as
// real node_modules files; vercel.json's includeFiles covers them.
// Everything else (firebase-admin, @google-cloud/storage, axios, zod, etc.)
// is pure JS and gets bundled directly, which is the whole point — no more
// relying on Vercel's own file-tracing for those.
const EXTERNAL = ['sharp', 'bcrypt'];

esbuild
  .build({
    entryPoints: [path.join(__dirname, '..', 'app.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(__dirname, '..', 'api', 'index.js'),
    external: EXTERNAL,
    logLevel: 'info',
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
