// Custom Monaco TypeScript worker — adds getAnyRanges(), used by the editor's
// "Error on any" linter. Monaco's default worker exposes only the language-service
// query methods (no TypeChecker), so detecting `any`-typed expressions needs this
// extension. Monaco importScripts() this file into the TS worker when
// typescriptDefaults.setWorkerOptions({ customWorkerPath }) points here; the factory
// receives the base TypeScriptWorker class and the `ts` module.
self.customTSWorkerFactory = function (TypeScriptWorker, tsArg) {
  function typeIsAny(ts, checker, node) {
    try {
      var t = checker.getTypeAtLocation(node);
      return !!t && (t.flags & ts.TypeFlags.Any) !== 0;
    } catch (e) { return false; }
  }
  return class AnyTypeWorker extends TypeScriptWorker {
    // Return the spans of `any`-typed expressions in a file: explicit `any`
    // annotations, plus calls / member accesses that resolve to `any` (the points
    // where type safety is lost — e.g. an unregistered Java.type(...)). For an
    // any-typed chain we report only the OUTERMOST node so a.b.c() is one marker.
    async getAnyRanges(fileName) {
      try {
        // The worker exposes the real `typescript` module as a global; the factory
        // arg isn't reliably it across builds, so prefer the global.
        var ts = self.ts || tsArg;
        if (!ts || !ts.TypeFlags) return [];
        var ls = this._languageService;
        var program = ls && ls.getProgram && ls.getProgram();
        if (!program) return [];
        var sf = program.getSourceFile(fileName);
        if (!sf) return [];
        var checker = program.getTypeChecker();
        var K = ts.SyntaxKind;
        var isChain = function (n) {
          return !!n && (n.kind === K.PropertyAccessExpression || n.kind === K.ElementAccessExpression ||
            n.kind === K.CallExpression || n.kind === K.NonNullExpression || n.kind === K.ParenthesizedExpression);
        };
        var out = [];
        var add = function (node, message) {
          var start = node.getStart(sf);
          out.push({ start: start, length: node.getEnd() - start, message: message });
        };
        var visit = function (node) {
          if (node.kind === K.AnyKeyword) {
            add(node, "Explicit 'any' type.");
          } else if (node.kind === K.CallExpression || node.kind === K.PropertyAccessExpression || node.kind === K.ElementAccessExpression) {
            if (typeIsAny(ts, checker, node) && !(isChain(node.parent) && typeIsAny(ts, checker, node.parent))) {
              add(node, "Expression is typed 'any' — no type safety here.");
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
        return out;
      } catch (e) { return []; }
    }
  };
};
