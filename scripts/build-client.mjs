import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))

// 1. Build DSH Client bundle
const source = readFileSync(resolve(root, "src/dsh-client.ts"), "utf8")
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    strict: true,
  },
})

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${transpiled.outputText}
    return module.exports;
  }
});
`
writeFileSync(resolve(root, "dist/client.js"), wrapped, "utf8")

// 2. Build OpenCode GUI bundle (CommonJS ./gui-experimental)
const guiSource = readFileSync(resolve(root, "src/gui.ts"), "utf8")
const guiTranspiled = ts.transpileModule(guiSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    strict: true,
  },
})
const guiOutput = `${guiTranspiled.outputText}\nif (exports.default && !module.exports.default) { module.exports = exports.default; module.exports.default = exports.default; }\n`
writeFileSync(resolve(root, "dist/gui-experimental.cjs"), guiOutput, "utf8")
