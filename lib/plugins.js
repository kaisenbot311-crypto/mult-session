// lib/plugins.js (ESM, optimized)
import fs from "fs-extra";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- INTERNAL REGISTRIES ---
const commandMap = new Map(); // O(1) lookup
const textPlugins = [];
const allPlugins = [];

export function Module(meta) {
  return (exec) => {
    const plugin = Object.freeze({
      ...meta,
      exec,
    });

    allPlugins.push(plugin);

    if (plugin.command) {
      commandMap.set(plugin.command, plugin);
    }

    if (plugin.on === "text") {
      textPlugins.push(plugin);
    }
  };
}

export async function loadPlugins(dir = path.join(__dirname, "..", "plugins")) {
  if (allPlugins.length > 0) {
    return getSnapshot();
  }

  const files = await fs.readdir(dir);

  for (const file of files) {
    if (!file.endsWith(".js")) continue;

    try {
      const filePath = path.join(dir, file);
      await import(pathToFileURL(filePath));
      console.log(`✅ plugin loaded: ${file}`);
    } catch (err) {
      console.error(`❌ plugin error (${file}):`, err.message);
    }
  }

  console.log(`📦 Commands: ${commandMap.size}`);
  console.log(`📦 Text plugins: ${textPlugins.length}`);
  return getSnapshot();
}

function getSnapshot() {
  return {
    commands: new Map(commandMap),
    text: [...textPlugins],
    all: [...allPlugins],
  };
}
