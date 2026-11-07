# Pyodide notes for worker.js (verified against 314.0.7 / Python 3.14.2)

- **Files** in `vendor/pyodide/`: `pyodide.mjs`, `pyodide.asm.mjs` (not `.asm.js`), `pyodide.asm.wasm`,
  `pyodide-lock.json`, `python_stdlib.zip`. ESM only: use a `{type: "module"}` worker and import `loadPyodide`
  from `pyodide.mjs` with `indexURL` ending in `/`. A Node `fetch` spy saw no fetch at startup or on `import numpy`.
  Never call `loadPackage*`, because their default base URL is jsdelivr.
- **Console:** `const { Console } = pyodide.pyimport("pyodide.console");` then
  `const con = Console.callKwargs({ filename: "<console>" })` (an optional `globals` dict defaults to
  `{"__name__": "__console__"}`). Pre-import with `con.push("import math, random, statistics")`.
- **stdout/stderr:** assign the attributes `con.stdout_callback = s => ...` and `con.stderr_callback = s => ...`
  (kwargs also work). Redirected only while a push runs. `print("hi")` arrives as `"hi"`, then `"\n"`.
- **`push(line)`** returns a ConsoleFuture PyProxy. Read `fut.syntax_check` synchronously:
  `"incomplete"` (show `...`; Console keeps its own buffer), `"syntax-error"` (the message is in
  `fut.formatted_error`), or `"complete"` (it is running, so await it with the helper below and on rejection
  read `fut.formatted_error`, a CPython traceback trimmed to `<console>` frames). `fut.destroy()` in `finally`.
- **Helper** (console.html pattern): awaiting the PyProxy in JS loses `formatted_error`, and Console sets no `_`:
  ```py
  import builtins
  from pyodide.ffi import to_js
  async def await_fut(fut):
      res = await fut
      if res is not None: builtins._ = res
      return to_js([None if res is None else repr(res)], depth=1)
  ```
  `const [r] = await awaitFut(fut)`. Here `r` is a repr string or **`undefined`** (not `null`) for None.
- **`con.complete(src)`** returns `[candidates, start]` (`.toJs()`, then destroy). `start` is where the word begins
  (`"x = sta"` gives 4). The candidates come from rlcompleter, and callables end in `"("`.
- **Interrupt** (verified with Node worker_threads): call `pyodide.setInterruptBuffer(new Uint8Array(sab))` once.
  The supervisor writes `2` (SIGINT) to index 0. The pending future rejects with a `formatted_error` of
  `Traceback...\n  File "<console>", line 1, in <module>\nKeyboardInterrupt\n`. Globals survive, and Pyodide
  resets the buffer to 0 itself. **But** asyncio also re-raises KeyboardInterrupt out of the webloop, so the
  worker gets two `unhandledrejection` events of type `KeyboardInterrupt`. Swallow those
  (`e.preventDefault()`) instead of treating them as worker failure. Long C calls (`math.factorial(10**8)`)
  only see the interrupt after they return, so keep the terminate fallback.
- **Gotchas:**
  - In 3.14, `1+` and `def f(:` report `_IncompleteInputError: incomplete input`, not `SyntaxError`. Rewrite it?
  - A leading indent on a single line (`"  x = 1"`) runs fine instead of raising IndentationError.
  - A push compiles in `"single"` mode, so `"a = 1\nb = 2"` in one push is a SyntaxError. Push pastes line by line.
  - `help(obj)` works and goes to stdout. A bare `help()` reads stdin, so shadow it or block it.
  - `os`/`json`/`asyncio` import fine (Pyodide needs them). Other stdlib (`datetime`) is a ModuleNotFoundError.
