// Keep the controller tests independent of a running GNOME Shell.
export function resolve(specifier, context, next) {
    if (specifier.startsWith('gi://')) {
        return { url: new URL('./window-animation-mocks.mjs', import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
}
