// Trusted, disposable subprocess entrypoint. Guest code runs only in QuickJS/WASM.
// This file must never be imported by the long-lived Agents runtime.
import ts from 'typescript'
import { getQuickJS } from 'quickjs-emscripten'
import { ENGINEERING_SCRIPT_LIMITS as limits, ENGINEERING_SCRIPT_PROFILE as profile } from './script-protocol'
import type { ScriptWorkerResponse } from './script-protocol'

const failure = (code: string, message: string): ScriptWorkerResponse => ({ status: 'failed', error: { code, message: message.slice(0, 2000) } })

// Captured before user code runs and held only by a private host handle. Building a
// plain JSON copy rejects accessors, cycles, holes, exotic values and nonfinite numbers.
// Proxy traps still execute inside the bounded guest, never in the host process.
const encoderSource = `(() => {
  const ownKeys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor;
  const isArray = Array.isArray, finite = Number.isFinite, stringify = JSON.stringify;
  const create = Object.create, define = Object.defineProperty, getPrototype = Object.getPrototypeOf, setPrototype = Object.setPrototypeOf;
  const plainPrototype = Object.prototype, arrayPrototype = Array.prototype;
  const setHas = Function.prototype.call.bind(Set.prototype.has);
  const setAdd = Function.prototype.call.bind(Set.prototype.add);
  const setDelete = Function.prototype.call.bind(Set.prototype.delete);
  const ancestors = new Set();
  return value => {
    let nodes = 0;
    const copy = (item, depth) => {
      if (++nodes > ${limits.jsonNodes} || depth > ${limits.jsonDepth}) throw 'JSON structure limit';
      if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
      if (typeof item === 'number') { if (!finite(item)) throw 'Nonfinite number'; return item; }
      if (typeof item !== 'object') throw 'Unsupported JSON value';
      if (setHas(ancestors, item)) throw 'Cyclic output';
      setAdd(ancestors, item);
      const array = isArray(item), prototype = getPrototype(item);
      if (prototype !== (array ? arrayPrototype : plainPrototype) && !(prototype === null && !array)) throw 'Non-plain JSON value';
      const result = array ? [] : create(null);
      if (array) setPrototype(result, null);
      const keys = ownKeys(item);
      let count = 0;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw 'Symbol output key';
        const entry = descriptor(item, key);
        if (!entry || !('value' in entry) || !entry.enumerable) throw 'Accessor or hidden output';
        if (array && key !== '' + count) throw 'Sparse or extended output array';
        define(result, key, { value: copy(entry.value, depth + 1), enumerable: true, writable: true, configurable: true });
        count++;
      }
      if (array && count !== descriptor(item, 'length').value) throw 'Sparse output array';
      setDelete(ancestors, item);
      return result;
    };
    return stringify(copy(value, 0));
  };
})()`

const execute = async (source: string, inputJson: string): Promise<ScriptWorkerResponse> => {
  if (ts.version !== profile.typescript) return failure('compiler_version', 'The pinned TypeScript compiler is unavailable')
  const tree = ts.createSourceFile('engineering.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  let forbidden = false
  const inspect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)
      || ts.isExportAssignment(node) || ts.isImportTypeNode(node)
      || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))) forbidden = true
    ts.forEachChild(node, inspect)
  }
  inspect(tree)
  if (forbidden) return failure('imports_exports_unavailable', 'Use a self-contained script without imports or exports')
  const last = tree.statements.at(-1)
  if (!last || !ts.isExpressionStatement(last)) return failure('missing_result_expression', 'The final statement must be an expression yielding a finite JSON value')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleDetection: ts.ModuleDetectionKind.Legacy, strict: true, sourceMap: false, inlineSourceMap: false },
    fileName: 'engineering.ts', reportDiagnostics: true,
  })
  const diagnostic = compiled.diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error)
  if (diagnostic) return failure('syntax_error', ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(limits.guestMemoryBytes)
  runtime.setMaxStackSize(limits.guestStackBytes)
  const deadline = performance.now() + limits.guestTimeMs
  let interrupted = false
  runtime.setInterruptHandler(() => { interrupted = performance.now() >= deadline; return interrupted })
  runtime.setModuleLoader(() => { throw new Error('Modules are unavailable') })
  const vm = runtime.newContext()
  try {
    const setup = vm.evalCode(`delete globalThis.Date; delete Math.random; Object.defineProperty(globalThis, 'input', { value: JSON.parse(${JSON.stringify(inputJson)}), writable: false, configurable: false });`, 'setup.js')
    if (setup.error) { setup.error.dispose(); return failure('guest_setup_failed', 'Could not initialize the isolated guest') }
    setup.value.dispose()
    const encoderResult = vm.evalCode(encoderSource, 'json-encoder.js')
    if (encoderResult.error) { encoderResult.error.dispose(); return failure('guest_setup_failed', 'Could not initialize the output boundary') }
    const encoder = encoderResult.value
    try {
      const evaluated = vm.evalCode(compiled.outputText, 'engineering.js', { type: 'global' })
      if (evaluated.error) {
        evaluated.error.dispose()
        return failure(interrupted ? 'guest_deadline' : 'guest_execution_failed', interrupted ? 'Guest execution exceeded its time limit' : 'Script failed in the isolated guest (including memory, stack, or runtime errors)')
      }
      try {
        const encoded = vm.callFunction(encoder, vm.undefined, evaluated.value)
        if (encoded.error) {
          encoded.error.dispose()
          return failure(interrupted ? 'guest_deadline' : 'invalid_output', interrupted ? 'Guest execution exceeded its time limit' : 'Output must be finite plain JSON without functions, accessors, holes, cycles, exotic objects or oversized structures')
        }
        try {
          const outputJson = vm.getString(encoded.value)
          if (Buffer.byteLength(outputJson) > limits.outputBytes) return failure('output_limit', 'Serialized output exceeds the byte limit')
          return { status: 'completed', outputJson }
        } finally { encoded.value.dispose() }
      } finally { evaluated.value.dispose() }
    } finally { encoder.dispose() }
  } finally { vm.dispose(); runtime.dispose() }
}

try {
  const payloadText = await Bun.stdin.text()
  if (Buffer.byteLength(payloadText) > (limits.sourceBytes + limits.inputBytes) * 6 + 1024) throw new Error('Worker payload limit')
  const payload: unknown = JSON.parse(payloadText)
  if (!payload || typeof payload !== 'object' || !('source' in payload) || !('inputJson' in payload)
    || typeof payload.source !== 'string' || typeof payload.inputJson !== 'string'
    || Buffer.byteLength(payload.source) > limits.sourceBytes || Buffer.byteLength(payload.inputJson) > limits.inputBytes) throw new Error('Invalid supervisor payload')
  const result = await execute(payload.source, payload.inputJson)
  process.stdout.write(JSON.stringify(result))
} catch {
  // Do not disclose host paths, environment or compiler internals to the guest.
  process.stdout.write(JSON.stringify(failure('worker_failure', 'The disposable calculation worker failed')))
}
