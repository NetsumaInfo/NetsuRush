import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const artifactDir = path.resolve(process.argv[2] || path.join(root, "src-tauri", "target", "release", "bundle", "nsis"));
const output = path.resolve(process.argv[3] || path.join(artifactDir, "latest.json"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releases = JSON.parse(await readFile(path.join(root, "src", "data", "releases.json"), "utf8"));
const release = releases.find((entry) => entry.version === pkg.version);
const files = await readdir(artifactDir);
const installer = files.find((name) => name.endsWith("-setup.exe") && name.includes(`_${pkg.version}_`));
if (!installer) throw new Error(`Installateur updater NSIS ${pkg.version} introuvable dans ${artifactDir}`);
const signaturePath = path.join(artifactDir, `${installer}.sig`);
const signature = (await readFile(signaturePath, "utf8")).trim();
if (!signature) throw new Error(`Signature vide : ${signaturePath}`);

const repository = process.env.GITHUB_REPOSITORY || "NetsumaInfo/NetsuRush";
const tag = process.env.GITHUB_REF_NAME || `v${pkg.version}`;
const notes = release?.highlights?.fr?.join("\n") || `NetsuRush ${pkg.version}`;
const manifest = {
  version: pkg.version,
  notes,
  pub_date: release?.date ? new Date(`${release.date}T00:00:00Z`).toISOString() : new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(installer)}`,
    },
  },
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Manifest updater prêt : ${output}`);
