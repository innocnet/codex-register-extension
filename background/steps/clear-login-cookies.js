(function attachBackgroundStep6(root, factory) {
  root.MultiPageBackgroundStep6 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep6Module() {
  function createStep6Executor(deps = {}) {
    const {
      completeStepFromBackground,
    } = deps;

    async function executeStep6() {
      await completeStepFromBackground(6);
    }

    return { executeStep6 };
  }

  return { createStep6Executor };
});
